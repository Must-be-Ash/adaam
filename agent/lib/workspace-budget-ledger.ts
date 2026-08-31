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
  kind: z.enum(["hybrid_model_attempt", "paid_source_attempt", "scheduled_monitor"]).default("scheduled_monitor"),
  outputTokens: z.number().int().nonnegative(),
  paidMicros: microsSchema,
  parentRunId: z.string().min(1).max(160).nullable().optional(),
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
export interface WorkspaceBudgetUsageSummary {
  activeWorkers: number;
  calendarDay: string;
  calendarMonth: string;
  inputTokensToday: number;
  outputTokensToday: number;
  paidMicrosThisMonth: string;
  paidMicrosToday: string;
  runsToday: number;
}

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

function isTopLevelReservation(
  reservation: WorkspaceBudgetReservation,
): boolean {
  return reservation.parentRunId == null;
}

/** Count each family once, without hiding children behind a soft envelope.
 * Filter by the reservation's own period before grouping: a retained child
 * remains charged even when its parent belongs to another period or is gone.
 */
function effectivePeriodUsage(
  reservations: readonly WorkspaceBudgetReservation[],
  periodField: "calendarDay" | "calendarMonth",
  period: string,
) {
  const families = new Map<string, {
    parentInput: number; parentOutput: number; parentPaid: bigint;
    childInput: number; childOutput: number; childPaid: bigint;
  }>();
  for (const reservation of reservations) {
    if (reservation[periodField] !== period || reservation.state === "released") continue;
    const familyId = reservation.parentRunId ?? reservation.runId;
    const family = families.get(familyId) ?? {
      parentInput: 0, parentOutput: 0, parentPaid: 0n,
      childInput: 0, childOutput: 0, childPaid: 0n,
    };
    if (isTopLevelReservation(reservation)) {
      family.parentInput = usageTokens(reservation, "input");
      family.parentOutput = usageTokens(reservation, "output");
      family.parentPaid = usagePaid(reservation);
    } else {
      family.childInput += usageTokens(reservation, "input");
      family.childOutput += usageTokens(reservation, "output");
      family.childPaid += usagePaid(reservation);
    }
    families.set(familyId, family);
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let paidMicros = 0n;
  for (const family of families.values()) {
    inputTokens += Math.max(family.parentInput, family.childInput);
    outputTokens += Math.max(family.parentOutput, family.childOutput);
    paidMicros += family.parentPaid > family.childPaid ? family.parentPaid : family.childPaid;
  }
  return { inputTokens, outputTokens, paidMicros };
}

export interface WorkspaceChildBudgetUsage {
  hasUnsettledReservation: boolean;
  inputTokens: number;
  outputTokens: number;
  paidMicros: string;
}

export function summarizeWorkspaceChildBudgetUsage(
  ledger: WorkspaceBudgetLedger,
  parentRunId: string,
): WorkspaceChildBudgetUsage {
  const children = ledger.reservations.filter(
    (reservation) =>
      reservation.parentRunId === parentRunId &&
      reservation.state !== "released",
  );
  return Object.freeze({
    hasUnsettledReservation: children.some(
      ({ state }) => state === "reserved" || state === "uncertain",
    ),
    inputTokens: children.reduce(
      (total, reservation) => total + usageTokens(reservation, "input"),
      0,
    ),
    outputTokens: children.reduce(
      (total, reservation) => total + usageTokens(reservation, "output"),
      0,
    ),
    paidMicros: children.reduce(
      (total, reservation) => total + usagePaid(reservation),
      0n,
    ).toString(),
  });
}

export function formatWorkspacePaidMicros(micros: string): string {
  const amount = BigInt(micros);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}

export function summarizeWorkspaceBudgetUsage(
  ledger: WorkspaceBudgetLedger,
  now: Date,
  timeZone: string,
): WorkspaceBudgetUsageSummary {
  const calendar = calendarParts(now, timeZone);
  const today = ledger.reservations.filter(
    (reservation) =>
      isTopLevelReservation(reservation) &&
      reservation.calendarDay === calendar.day &&
      reservation.state !== "released",
  );
  const dailyUsage = effectivePeriodUsage(ledger.reservations, "calendarDay", calendar.day);
  const monthlyUsage = effectivePeriodUsage(ledger.reservations, "calendarMonth", calendar.month);
  return Object.freeze({
    activeWorkers: ledger.reservations.filter(
      (reservation) =>
        isTopLevelReservation(reservation) && reservation.state === "reserved",
    ).length,
    calendarDay: calendar.day,
    calendarMonth: calendar.month,
    inputTokensToday: dailyUsage.inputTokens,
    outputTokensToday: dailyUsage.outputTokens,
    paidMicrosThisMonth: monthlyUsage.paidMicros.toString(),
    paidMicrosToday: dailyUsage.paidMicros.toString(),
    runsToday: today.filter((reservation) => reservation.kind === "scheduled_monitor").length,
  });
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
    kind?: "hybrid_model_attempt" | "paid_source_attempt" | "scheduled_monitor";
    now?: Date;
    outputTokens: number;
    paidCostCeiling?: { amount: string; kind: "known" } | { kind: "unknown" };
    parentRunId?: string;
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
  const kind = input.kind ?? "scheduled_monitor";
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
  // A scheduled-monitor reservation is the occurrence's aggregate spend
  // envelope, not a provider call. Per-call limits apply to each nested model
  // or paid-source reservation while the parent remains bounded by day/month.
  if (caps && kind !== "scheduled_monitor" && paid > caps.call) {
    throw new WorkspaceBudgetError("budget_exhausted");
  }

  return updateLedger(input.scope, client, (current) => {
    const existing = current.reservations.find(
      (reservation) => reservation.runId === input.runId,
    );
    if (existing) {
      if (
        existing.policyRevision !== input.policyRevision ||
        existing.kind !== (input.kind ?? "scheduled_monitor") ||
        (existing.parentRunId ?? null) !== (input.parentRunId ?? null) ||
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
    const parent = input.parentRunId === undefined
      ? null
      : reservations.find(({ runId }) => runId === input.parentRunId) ?? null;
    if (
      input.parentRunId !== undefined &&
      (
        input.runId === input.parentRunId ||
        kind === "scheduled_monitor" ||
        parent === null ||
        parent.kind !== "scheduled_monitor" ||
        parent.parentRunId != null ||
        parent.state !== "reserved" ||
        parent.policyRevision !== input.policyRevision ||
        parent.calendarDay !== calendar.day ||
        parent.calendarMonth !== calendar.month
      )
    ) {
      throw new WorkspaceBudgetError("budget_reservation_conflict");
    }
    const reservation: WorkspaceBudgetReservation = {
      calendarDay: calendar.day,
      calendarMonth: calendar.month,
      createdAt: timestamp,
      inputTokens: input.inputTokens,
      kind,
      outputTokens: input.outputTokens,
      paidMicros: paid.toString(),
      parentRunId: input.parentRunId ?? null,
      policyRevision: input.policyRevision,
      reconciledInputTokens: null,
      reconciledOutputTokens: null,
      reconciledPaidMicros: null,
      runId: input.runId,
      state: "reserved",
      updatedAt: timestamp,
    };
    const nextReservations = [...reservations, reservation];
    // The parent is a soft accounting envelope. Evaluate the proposed ledger
    // inside this CAS using the same effective family totals operators see.
    const usage = summarizeWorkspaceBudgetUsage({ ...current, reservations: nextReservations }, now, policy.ownerTimezone);
    if (
      usage.inputTokensToday > policy.maximumInputTokensPerDay ||
      usage.outputTokensToday > policy.maximumOutputTokensPerDay ||
      (caps !== undefined && BigInt(usage.paidMicrosToday) > caps.day) ||
      (caps !== undefined && BigInt(usage.paidMicrosThisMonth) > caps.month) ||
      (parent === null && (
        usage.runsToday > policy.maximumScheduledRunsPerDay ||
        usage.activeWorkers > policy.maximumConcurrentWorkers
      )) ||
      nextReservations.length > MAX_RESERVATIONS
    ) {
      throw new WorkspaceBudgetError("budget_exhausted");
    }
    return {
      ledger: {
        ...current,
        reservations: nextReservations,
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
    // Positive reservations are estimates and may be exceeded by actual
    // metering. Explicit zero is a real no-spend/no-token contract.
    if (
      paid !== null && paid > 0n && BigInt(existing.paidMicros) === 0n &&
      existing.kind !== "scheduled_monitor"
    ) {
      throw new WorkspaceBudgetError("budget_reservation_conflict");
    }
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
    if (
      (normalized.inputTokens !== null && normalized.inputTokens > 0 && existing.inputTokens === 0) ||
      (normalized.outputTokens !== null && normalized.outputTokens > 0 && existing.outputTokens === 0)
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
