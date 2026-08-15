import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
  type WorkspaceBudgetReservation,
} from "./workspace-budget-ledger";
import type { ClaimedWorkspaceMonitor } from "./workspace-monitor-store";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";

const GLOBAL_LEDGER_KEY = "eve:workspace-runtime:v1:global-dispatch-budget";
const MAX_CAS_ATTEMPTS = 8;
const MAX_LEDGER_BYTES = 128 * 1_024;
const MAX_RESERVATIONS = 1_024;
const LEGACY_GLOBAL_RUNS_PER_DAY = 500;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

const reservationSchema = z.object({
  calendarDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  createdAt: z.string().datetime({ offset: true }),
  runId: z.string().min(1).max(160),
  state: z.enum(["reserved", "released", "settled"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
const ledgerSchema = z.object({
  reservations: z.array(reservationSchema).max(MAX_RESERVATIONS),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
}).strict();

export type GlobalDispatchReservation = z.infer<typeof reservationSchema>;
export type GlobalDispatchLedger = z.infer<typeof ledgerSchema>;

export interface WorkspaceGlobalBudgetClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface WorkspaceDispatchBudgetClients {
  global: WorkspaceGlobalBudgetClient;
  state: WorkspaceStateStoreClient;
  workspace: WorkspaceBudgetLedgerClient;
}

export interface WorkspaceDispatchReservation {
  readonly global: GlobalDispatchReservation;
  readonly runId: string;
  readonly workspace: WorkspaceBudgetReservation;
}

export class WorkspaceDispatchBudgetError extends Error {
  readonly code:
    | "global_budget_exhausted"
    | "global_budget_invalid"
    | "global_budget_conflict"
    | "workspace_budget_missing";

  constructor(code: WorkspaceDispatchBudgetError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceDispatchBudgetError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceGlobalBudgetClient | undefined;

function store(): WorkspaceGlobalBudgetClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace dispatch budget storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) =>
        redisClient!.evalsha<[string, string], number>(
          candidate,
          [key],
          [expected ?? "", next],
        );
      try {
        return (await execute(sha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        scriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await scriptSha;
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseLedger(raw: string | null): GlobalDispatchLedger {
  if (raw === null) return { reservations: [], revision: 0, schemaVersion: 1 };
  if (Buffer.byteLength(raw, "utf8") > MAX_LEDGER_BYTES) {
    throw new WorkspaceDispatchBudgetError("global_budget_invalid");
  }
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new WorkspaceDispatchBudgetError("global_budget_invalid");
    return parsed.data;
  } catch (error) {
    if (error instanceof WorkspaceDispatchBudgetError) throw error;
    throw new WorkspaceDispatchBudgetError("global_budget_invalid");
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new WorkspaceDispatchBudgetError("global_budget_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new WorkspaceDispatchBudgetError("global_budget_invalid");
  }
  return parsed;
}

export function resolveWorkspaceGlobalBudgetLimits(
  environment: NodeJS.ProcessEnv = process.env,
): { maximumConcurrentWorkers: number; maximumRunsPerDay: number } {
  return {
    maximumConcurrentWorkers: positiveInteger(
      environment.EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS,
      8,
      32,
    ),
    maximumRunsPerDay: positiveInteger(
      environment.EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY,
      LEGACY_GLOBAL_RUNS_PER_DAY,
      LEGACY_GLOBAL_RUNS_PER_DAY,
    ),
  };
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function updateGlobalLedger<T>(
  client: WorkspaceGlobalBudgetClient,
  mutate: (ledger: GlobalDispatchLedger) => { ledger: GlobalDispatchLedger; result: T },
): Promise<T> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await client.get(GLOBAL_LEDGER_KEY));
    const mutation = mutate(parseLedger(currentRaw));
    const parsed = ledgerSchema.safeParse(mutation.ledger);
    if (!parsed.success) throw new WorkspaceDispatchBudgetError("global_budget_invalid");
    const nextRaw = JSON.stringify(parsed.data);
    if (Buffer.byteLength(nextRaw, "utf8") > MAX_LEDGER_BYTES) {
      throw new WorkspaceDispatchBudgetError("global_budget_exhausted");
    }
    if (await client.compareAndSet(GLOBAL_LEDGER_KEY, currentRaw, nextRaw)) {
      return mutation.result;
    }
  }
  throw new WorkspaceDispatchBudgetError("global_budget_conflict");
}

async function reserveGlobal(
  runId: string,
  now: Date,
  limits: ReturnType<typeof resolveWorkspaceGlobalBudgetLimits>,
  client: WorkspaceGlobalBudgetClient,
): Promise<GlobalDispatchReservation> {
  return updateGlobalLedger(client, (current) => {
    const existing = current.reservations.find((entry) => entry.runId === runId);
    if (existing) return { ledger: current, result: existing };
    const day = utcDay(now);
    const reservations = current.reservations.filter(
      (entry) => entry.calendarDay === day || entry.state === "reserved",
    );
    const active = reservations.filter((entry) => entry.state === "reserved").length;
    const daily = reservations.filter(
      (entry) => entry.calendarDay === day && entry.state !== "released",
    ).length;
    if (
      active >= limits.maximumConcurrentWorkers ||
      daily >= limits.maximumRunsPerDay ||
      reservations.length >= MAX_RESERVATIONS
    ) {
      throw new WorkspaceDispatchBudgetError("global_budget_exhausted");
    }
    const timestamp = now.toISOString();
    const reservation: GlobalDispatchReservation = {
      calendarDay: day,
      createdAt: timestamp,
      runId,
      state: "reserved",
      updatedAt: timestamp,
    };
    return {
      ledger: {
        reservations: [...reservations, reservation],
        revision: current.revision + 1,
        schemaVersion: 1,
      },
      result: reservation,
    };
  });
}

async function finishGlobal(
  runId: string,
  state: "released" | "settled",
  now: Date,
  client: WorkspaceGlobalBudgetClient,
): Promise<GlobalDispatchReservation> {
  return updateGlobalLedger(client, (current) => {
    const index = current.reservations.findIndex((entry) => entry.runId === runId);
    if (index < 0) throw new WorkspaceDispatchBudgetError("global_budget_conflict");
    const existing = current.reservations[index]!;
    if (existing.state === state) return { ledger: current, result: existing };
    if (existing.state !== "reserved") {
      throw new WorkspaceDispatchBudgetError("global_budget_conflict");
    }
    const reservations = [...current.reservations];
    const finished = { ...existing, state, updatedAt: now.toISOString() } as const;
    reservations[index] = finished;
    return {
      ledger: { ...current, reservations, revision: current.revision + 1 },
      result: finished,
    };
  });
}

function runId(job: ClaimedWorkspaceMonitor): string {
  return `${job.occurrence.occurrenceKey}:attempt:${job.occurrence.attempt}`;
}

export async function reserveWorkspaceMonitorDispatchBudget(
  job: ClaimedWorkspaceMonitor,
  options: {
    clients?: Partial<WorkspaceDispatchBudgetClients>;
    environment?: NodeJS.ProcessEnv;
    now?: Date;
  },
): Promise<WorkspaceDispatchReservation> {
  const now = options.now ?? new Date();
  const id = runId(job);
  const globalClient = options.clients?.global ?? store();
  const global = await reserveGlobal(
    id,
    now,
    resolveWorkspaceGlobalBudgetLimits(options.environment),
    globalClient,
  );
  try {
    const budget = await readWorkspaceDocument("budget", job.scope, options.clients?.state);
    if (!budget) throw new WorkspaceDispatchBudgetError("workspace_budget_missing");
    const inputTokens = Math.min(
      budget.value.maximumInputTokensPerRun,
      job.monitor.tighteningLimits.inputTokensPerRun ?? Number.MAX_SAFE_INTEGER,
    );
    const outputTokens = Math.min(
      budget.value.maximumOutputTokensPerRun,
      job.monitor.tighteningLimits.outputTokensPerRun ?? Number.MAX_SAFE_INTEGER,
    );
    const workspace = await reserveWorkspaceRunBudget(
      {
        inputTokens,
        now,
        outputTokens,
        policy: budget.value,
        policyRevision: budget.revision,
        runId: id,
        scope: job.scope,
      },
      options.clients?.workspace,
    );
    return { global, runId: id, workspace };
  } catch (error) {
    await finishGlobal(id, "released", now, globalClient);
    throw error;
  }
}

export async function finishWorkspaceMonitorDispatchBudget(
  job: ClaimedWorkspaceMonitor,
  reservation: WorkspaceDispatchReservation,
  input: {
    actualInputTokens?: number;
    actualOutputTokens?: number;
    now?: Date;
    outcome: "reconciled" | "released" | "uncertain";
  },
  clients: Partial<Pick<WorkspaceDispatchBudgetClients, "global" | "workspace">> = {},
): Promise<void> {
  const expectedRunId = runId(job);
  if (reservation.runId !== expectedRunId) {
    throw new WorkspaceDispatchBudgetError("global_budget_conflict");
  }
  const now = input.now ?? new Date();
  await reconcileWorkspaceRunBudget(
    {
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      now,
      outcome: input.outcome,
      runId: reservation.runId,
      scope: job.scope,
    },
    clients.workspace,
  );
  await finishGlobal(
    reservation.runId,
    input.outcome === "released" ? "released" : "settled",
    now,
    clients.global ?? store(),
  );
}

export async function readGlobalDispatchBudgetLedger(
  client: WorkspaceGlobalBudgetClient = store(),
): Promise<GlobalDispatchLedger> {
  return parseLedger(rawValue(await client.get(GLOBAL_LEDGER_KEY)));
}
