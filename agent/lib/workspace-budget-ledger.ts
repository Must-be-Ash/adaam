import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import {
  validateWorkspaceBudgetPolicyValue,
  type WorkspaceBudgetPolicyValue,
} from "./workspace-state-store";

const KEY_PREFIX = "eve:workspace-runtime:v1:budget-ledger:";
const MAX_RESERVATIONS = 1_024;
const MAX_LEDGER_BYTES = 256 * 1_024;
const MAX_CAS_ATTEMPTS = 8;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
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

const microsSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const reservationSchema = z.object({
  calendarDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  calendarMonth: z.string().regex(/^\d{4}-\d{2}$/u),
  createdAt: z.string().datetime({ offset: true }),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  paidMicros: microsSchema,
  policyRevision: z.number().int().positive(),
  reconciledInputTokens: z.number().int().nonnegative().nullable(),
  reconciledOutputTokens: z.number().int().nonnegative().nullable(),
  reconciledPaidMicros: microsSchema.nullable(),
  runId: z.string().min(1).max(160),
  state: z.enum(["reserved", "reconciled", "released", "uncertain"]),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

const ledgerSchema = z.object({
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  reservations: z.array(reservationSchema).max(MAX_RESERVATIONS),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

export type WorkspaceBudgetReservation = z.infer<typeof reservationSchema>;
export type WorkspaceBudgetLedger = z.infer<typeof ledgerSchema>;

export interface WorkspaceBudgetLedgerClient {
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
  ): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface DeploymentPaidBudgetCaps {
  maximumPaidPerCall: string;
  maximumPaidPerDay: string;
  maximumPaidPerMonth: string;
}

export class WorkspaceBudgetError extends Error {
  readonly code:
    | "budget_exhausted"
    | "budget_ledger_corrupt"
    | "budget_policy_stale"
    | "budget_policy_unresolved"
    | "budget_reservation_conflict";

  constructor(code: WorkspaceBudgetError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceBudgetError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceBudgetLedgerClient | undefined;

function store(): WorkspaceBudgetLedgerClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace budget storage is not configured.");
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
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
          throw error;
        }
        scriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await scriptSha;
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function key(scope: AuthorizedWorkspaceStoreScope): string {
  const digest = createHash("sha256")
    .update(`workspace-budget\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseLedger(
  raw: string | null,
  scope: AuthorizedWorkspaceStoreScope,
): WorkspaceBudgetLedger {
  if (raw === null) {
    return {
      ownerId: scope.ownerId,
      reservations: [],
      revision: 0,
      schemaVersion: 1,
      workspaceId: scope.workspaceId,
    };
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_LEDGER_BYTES) {
    throw new WorkspaceBudgetError("budget_ledger_corrupt");
  }
  try {
    const parsed = ledgerSchema.parse(JSON.parse(raw));
    if (parsed.ownerId !== scope.ownerId || parsed.workspaceId !== scope.workspaceId) {
      throw new WorkspaceBudgetError("budget_ledger_corrupt");
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkspaceBudgetError) throw error;
    throw new WorkspaceBudgetError("budget_ledger_corrupt");
  }
}

function toMicros(value: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new WorkspaceBudgetError("budget_policy_unresolved");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function calendarParts(now: Date, timeZone: string): {
  day: string;
  month: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) {
    throw new WorkspaceBudgetError("budget_policy_unresolved");
  }
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

function effectivePaidCaps(
  policy: WorkspaceBudgetPolicyValue,
  deployment: DeploymentPaidBudgetCaps | undefined,
) {
  const resolve = (value: string | null, fallback: string | undefined) => {
    if (value !== null) return toMicros(value);
    if (fallback === undefined) {
      throw new WorkspaceBudgetError("budget_policy_unresolved");
    }
    return toMicros(fallback);
  };
  return {
    call: resolve(policy.maximumPaidPerCall, deployment?.maximumPaidPerCall),
    day: resolve(policy.maximumPaidPerDay, deployment?.maximumPaidPerDay),
    month: resolve(policy.maximumPaidPerMonth, deployment?.maximumPaidPerMonth),
  };
}

function usageTokens(
  reservation: WorkspaceBudgetReservation,
  field: "input" | "output",
): number {
  const reconciled =
    field === "input"
      ? reservation.reconciledInputTokens
      : reservation.reconciledOutputTokens;
  return reservation.state === "released"
    ? 0
    : (reconciled ??
        (field === "input" ? reservation.inputTokens : reservation.outputTokens));
}

function usagePaid(reservation: WorkspaceBudgetReservation): bigint {
  if (reservation.state === "released") return 0n;
  return BigInt(reservation.reconciledPaidMicros ?? reservation.paidMicros);
}

function prune(
  reservations: WorkspaceBudgetReservation[],
  currentMonth: string,
): WorkspaceBudgetReservation[] {
  return reservations.filter(
    (reservation) =>
      reservation.calendarMonth === currentMonth ||
      reservation.state === "reserved" ||
      reservation.state === "uncertain",
  );
}

async function updateLedger<T>(
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceBudgetLedgerClient,
  mutate: (ledger: WorkspaceBudgetLedger) => { ledger: WorkspaceBudgetLedger; result: T },
): Promise<T> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const ledgerKey = key(scope);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await client.get(ledgerKey));
    const current = parseLedger(currentRaw, scope);
    const mutation = mutate(current);
    const parsed = ledgerSchema.safeParse(mutation.ledger);
    if (!parsed.success) throw new WorkspaceBudgetError("budget_exhausted");
    const nextRaw = JSON.stringify(parsed.data);
    if (Buffer.byteLength(nextRaw, "utf8") > MAX_LEDGER_BYTES) {
      throw new WorkspaceBudgetError("budget_exhausted");
    }
    if (await client.compareAndSet(ledgerKey, currentRaw, nextRaw)) {
      return mutation.result;
    }
  }
  throw new WorkspaceBudgetError("budget_reservation_conflict");
}

export async function reserveWorkspaceRunBudget(
  input: {
    deploymentPaidCaps?: DeploymentPaidBudgetCaps;
    inputTokens: number;
    now?: Date;
    outputTokens: number;
    paidCostCeiling?: { amount: string; kind: "known" } | { kind: "unknown" };
    policy: WorkspaceBudgetPolicyValue;
    policyRevision: number;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceBudgetLedgerClient = store(),
): Promise<WorkspaceBudgetReservation> {
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) {
    throw new WorkspaceBudgetError("budget_policy_stale");
  }
  let policy: WorkspaceBudgetPolicyValue;
  try {
    policy = validateWorkspaceBudgetPolicyValue(input.policy);
  } catch {
    throw new WorkspaceBudgetError("budget_policy_unresolved");
  }
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const calendar = calendarParts(now, policy.ownerTimezone);
  if (
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens < 0 ||
    input.inputTokens > policy.maximumInputTokensPerRun ||
    input.outputTokens > policy.maximumOutputTokensPerRun
  ) {
    throw new WorkspaceBudgetError("budget_exhausted");
  }
  const paid = input.paidCostCeiling
    ? input.paidCostCeiling.kind === "known"
      ? toMicros(input.paidCostCeiling.amount)
      : toMicros(policy.unknownPriceFallbackCeiling)
    : 0n;
  const caps =
    paid > 0n
      ? effectivePaidCaps(policy, input.deploymentPaidCaps)
      : undefined;
  if (caps && paid > caps.call) {
    throw new WorkspaceBudgetError("budget_exhausted");
  }

  return updateLedger(input.scope, client, (current) => {
    const existing = current.reservations.find(
      (reservation) => reservation.runId === input.runId,
    );
    if (existing) {
      if (
        existing.policyRevision !== input.policyRevision ||
        existing.inputTokens !== input.inputTokens ||
        existing.outputTokens !== input.outputTokens ||
        BigInt(existing.paidMicros) !== paid
      ) {
        throw new WorkspaceBudgetError("budget_reservation_conflict");
      }
      return { ledger: current, result: existing };
    }
    if (current.reservations.some((reservation) => reservation.policyRevision > input.policyRevision)) {
      throw new WorkspaceBudgetError("budget_policy_stale");
    }
    const reservations = prune(current.reservations, calendar.month);
    const today = reservations.filter(
      (reservation) => reservation.calendarDay === calendar.day,
    );
    const active = reservations.filter(
      (reservation) => reservation.state === "reserved",
    );
    const dailyRuns = today.filter(
      (reservation) => reservation.state !== "released",
    ).length;
    const dailyInput = today.reduce(
      (total, reservation) => total + usageTokens(reservation, "input"),
      0,
    );
    const dailyOutput = today.reduce(
      (total, reservation) => total + usageTokens(reservation, "output"),
      0,
    );
    const dailyPaid = today.reduce(
      (total, reservation) => total + usagePaid(reservation),
      0n,
    );
    const monthlyPaid = reservations
      .filter((reservation) => reservation.calendarMonth === calendar.month)
      .reduce((total, reservation) => total + usagePaid(reservation), 0n);
    if (
      dailyRuns + 1 > policy.maximumScheduledRunsPerDay ||
      active.length + 1 > policy.maximumConcurrentWorkers ||
      dailyInput + input.inputTokens > policy.maximumInputTokensPerDay ||
      dailyOutput + input.outputTokens > policy.maximumOutputTokensPerDay ||
      (caps !== undefined && dailyPaid + paid > caps.day) ||
      (caps !== undefined && monthlyPaid + paid > caps.month) ||
      reservations.length >= MAX_RESERVATIONS
    ) {
      throw new WorkspaceBudgetError("budget_exhausted");
    }
    const reservation: WorkspaceBudgetReservation = {
      calendarDay: calendar.day,
      calendarMonth: calendar.month,
      createdAt: timestamp,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      paidMicros: paid.toString(),
      policyRevision: input.policyRevision,
      reconciledInputTokens: null,
      reconciledOutputTokens: null,
      reconciledPaidMicros: null,
      runId: input.runId,
      state: "reserved",
      updatedAt: timestamp,
    };
    return {
      ledger: {
        ...current,
        reservations: [...reservations, reservation],
        revision: current.revision + 1,
      },
      result: reservation,
    };
  });
}

export async function reconcileWorkspaceRunBudget(
  input: {
    actualInputTokens?: number;
    actualOutputTokens?: number;
    actualPaidCost?: string;
    now?: Date;
    outcome: "reconciled" | "released" | "uncertain";
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceBudgetLedgerClient = store(),
): Promise<WorkspaceBudgetReservation> {
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateLedger(input.scope, client, (current) => {
    const index = current.reservations.findIndex(
      (reservation) => reservation.runId === input.runId,
    );
    if (index < 0) throw new WorkspaceBudgetError("budget_reservation_conflict");
    const existing = current.reservations[index]!;
    const paid =
      input.actualPaidCost === undefined ? null : toMicros(input.actualPaidCost);
    const normalized = {
      inputTokens: input.actualInputTokens ?? null,
      outputTokens: input.actualOutputTokens ?? null,
      paidMicros: paid?.toString() ?? null,
    };
    if (
      normalized.inputTokens !== null &&
      (!Number.isSafeInteger(normalized.inputTokens) || normalized.inputTokens < 0)
    ) {
      throw new WorkspaceBudgetError("budget_reservation_conflict");
    }
    if (
      normalized.outputTokens !== null &&
      (!Number.isSafeInteger(normalized.outputTokens) || normalized.outputTokens < 0)
    ) {
      throw new WorkspaceBudgetError("budget_reservation_conflict");
    }
    const target =
      input.outcome === "uncertain"
        ? { inputTokens: null, outputTokens: null, paidMicros: null }
        : normalized;
    if (existing.state === input.outcome) {
      const same =
        existing.reconciledInputTokens === target.inputTokens &&
        existing.reconciledOutputTokens === target.outputTokens &&
        existing.reconciledPaidMicros === target.paidMicros;
      if (!same) throw new WorkspaceBudgetError("budget_reservation_conflict");
      return { ledger: current, result: existing };
    }
    if (
      existing.state !== "reserved" &&
      !(
        existing.state === "uncertain" &&
        (input.outcome === "reconciled" || input.outcome === "released")
      )
    ) {
      throw new WorkspaceBudgetError("budget_reservation_conflict");
    }
    const reconciled: WorkspaceBudgetReservation = {
      ...existing,
      reconciledInputTokens: target.inputTokens,
      reconciledOutputTokens: target.outputTokens,
      reconciledPaidMicros: target.paidMicros,
      state: input.outcome,
      updatedAt: timestamp,
    };
    const reservations = [...current.reservations];
    reservations[index] = reconciled;
    return {
      ledger: { ...current, reservations, revision: current.revision + 1 },
      result: reconciled,
    };
  });
}

export async function readWorkspaceBudgetLedger(
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceBudgetLedgerClient = store(),
): Promise<WorkspaceBudgetLedger> {
  assertAuthorizedWorkspaceStoreScope(scope);
  return parseLedger(rawValue(await client.get(key(scope))), scope);
}
