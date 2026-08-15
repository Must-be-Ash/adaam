import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  authorizeDeploymentWorkspaceStore,
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import {
  nextWorkspaceMonitorOccurrence,
  selectWorkspaceMonitorDueOccurrence,
} from "./workspace-monitor-schedule";
import {
  WORKSPACE_MONITOR_SOURCE_LIMIT,
  WORKSPACE_MONITOR_SOURCE_LIMIT_CODE,
  workspaceMonitorSourcesSchema,
} from "./workspace-monitor-input";
import type { WorkspaceStrategyBindingValue } from "./workspace-state-store";

const KEY_PREFIX = "eve:workspace-runtime:v1:monitor:";
const DUE_KEY = `${KEY_PREFIX}due`;
const INFLIGHT_KEY = `${KEY_PREFIX}inflight`;
const RECORD_PREFIX = `${KEY_PREFIX}record:`;
const WORKSPACE_INDEX_PREFIX = `${KEY_PREFIX}workspace:`;
const LEASE_PREFIX = `${KEY_PREFIX}lease:`;
const OCCURRENCE_PREFIX = `${KEY_PREFIX}occurrence:`;
const MAX_RECORD_BYTES = 32_768;
const OCCURRENCE_TTL_SECONDS = 90 * 24 * 60 * 60;

const CREATE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SADD", KEYS[2], KEYS[1])
if ARGV[2] ~= "" then redis.call("ZADD", KEYS[3], ARGV[2], KEYS[1]) end
return 1
`;
const UPDATE_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2])
if ARGV[3] == "" then
  redis.call("ZREM", KEYS[2], KEYS[1])
else
  redis.call("ZADD", KEYS[2], ARGV[3], KEYS[1])
end
return 1
`;
const CLAIM_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return {"missing"} end
local ok, record = pcall(cjson.decode, raw)
if not ok or tonumber(record.configurationRevision) ~= tonumber(ARGV[1]) then return {"stale"} end
if record.lifecycleState ~= "enabled" or not record.nextOccurrenceAt then
  redis.call("ZREM", KEYS[4], KEYS[1])
  return {"not_due"}
end
local due = tonumber(ARGV[2])
local next_due = tonumber(ARGV[3])
if next_due > due then return {"not_due"} end
local active_lease = redis.call("GET", KEYS[2])
if active_lease then return {"leased"} end
local occurrence_raw = redis.call("GET", KEYS[3])
local attempt = 1
if occurrence_raw then
  local occurrence_ok, occurrence = pcall(cjson.decode, occurrence_raw)
  if not occurrence_ok or occurrence.status ~= "leased" then return {"duplicate"} end
  attempt = tonumber(occurrence.attempt) + 1
end
local acquired = redis.call("SET", KEYS[2], ARGV[4], "NX", "PX", ARGV[5])
if not acquired then return {"leased"} end
local occurrence = {
  schemaVersion = 1,
  occurrenceKey = ARGV[6],
  monitorId = ARGV[7],
  configurationRevision = tonumber(ARGV[1]),
  occurrenceIdentity = ARGV[8],
  status = "leased",
  attempt = attempt,
  leaseTokenDigest = ARGV[9],
  scheduledFor = ARGV[10],
  updatedAt = ARGV[11]
}
redis.call("SET", KEYS[3], cjson.encode(occurrence), "EX", ARGV[12])
redis.call("ZREM", KEYS[4], KEYS[1])
redis.call("ZADD", KEYS[5], ARGV[13], KEYS[1])
return {"claimed", tostring(attempt)}
`;
const RELEASE_LEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[4], KEYS[2])
local raw = redis.call("GET", KEYS[2])
if raw then
  local ok, record = pcall(cjson.decode, raw)
  if ok and record.lifecycleState == "enabled" and record.nextOccurrenceAt and ARGV[2] ~= "" then
    redis.call("ZADD", KEYS[3], ARGV[2], KEYS[2])
  end
end
return 1
`;
const COMPLETE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then return "missing" end
local occurrence_raw = redis.call("GET", KEYS[5])
if not occurrence_raw then return "lease_mismatch" end
local occurrence_ok, occurrence = pcall(cjson.decode, occurrence_raw)
if not occurrence_ok then return "stale" end
if tonumber(occurrence.configurationRevision) ~= tonumber(ARGV[1]) or
   occurrence.leaseTokenDigest ~= ARGV[2] then
  return "stale"
end
if occurrence.status == "completed" then return "already_completed" end
if occurrence.status ~= "leased" or redis.call("EXISTS", KEYS[2]) ~= 1 then
  return "lease_mismatch"
end
if raw ~= ARGV[3] then return "stale" end
occurrence.status = "completed"
occurrence.updatedAt = ARGV[5]
redis.call("SET", KEYS[1], ARGV[4])
redis.call("SET", KEYS[5], cjson.encode(occurrence), "EX", ARGV[6])
redis.call("DEL", KEYS[2])
redis.call("ZREM", KEYS[4], KEYS[1])
if ARGV[7] == "" then
  redis.call("ZREM", KEYS[3], KEYS[1])
else
  redis.call("ZADD", KEYS[3], ARGV[7], KEYS[1])
end
return "completed"
`;
const LIST_DUE_SCRIPT = `
local expired = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
for _, record_key in ipairs(expired) do
  redis.call("ZREM", KEYS[2], record_key)
  redis.call("ZADD", KEYS[1], ARGV[1], record_key)
end
local due = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])
local result = {}
for _, record_key in ipairs(due) do
  table.insert(result, {recordKey = record_key, raw = redis.call("GET", record_key)})
end
if #result == 0 then return "[]" end
return cjson.encode(result)
`;

export const WORKSPACE_MONITOR_REDIS_SCRIPTS = Object.freeze({
  claim: CLAIM_SCRIPT,
  complete: COMPLETE_SCRIPT,
  create: CREATE_SCRIPT,
  listDue: LIST_DUE_SCRIPT,
  releaseLease: RELEASE_LEASE_SCRIPT,
  update: UPDATE_SCRIPT,
});

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const timestampSchema = z.string().datetime({ offset: true });
export const workspaceMonitorScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ at: timestampSchema, kind: z.literal("one_time") }).strict(),
  z
    .object({
      anchor: timestampSchema,
      everyMinutes: z.number().int().min(15).max(525_600),
      kind: z.literal("interval"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("daily_local"),
      times: z
        .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
        .min(1)
        .max(16)
        .superRefine((times, context) => {
          if (new Set(times).size !== times.length) {
            context.addIssue({ code: "custom", message: "Duplicate daily time." });
          }
          if (times.some((time, index) => index > 0 && times[index - 1]! > time)) {
            context.addIssue({ code: "custom", message: "Daily times must be sorted." });
          }
        }),
      timezone: z
        .string()
        .min(1)
        .max(80)
        .refine((value) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value });
            return true;
          } catch {
            return false;
          }
        }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("source_event"),
      subscriptionIds: z.array(idSchema).min(1).max(16),
    })
    .strict(),
]);
export const workspaceMonitorManagedBySchema = z
  .object({
    bindingRevision: z.number().int().positive(),
    kind: z.literal("strategy_pack"),
    packContentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    packId: idSchema,
    packVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
    resourceId: idSchema,
  })
  .strict();
const monitorSchema = z
  .object({
    configurationRevision: z.number().int().positive(),
    consecutiveFailures: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    deliverySubscriptionId: idSchema,
    endAt: timestampSchema.nullable(),
    instruction: z.string().trim().min(1).max(8_000),
    lastCompletedAt: timestampSchema.nullable(),
    lastErrorCode: z.string().max(64).nullable(),
    lastRunAt: timestampSchema.nullable(),
    lifecycleState: z.enum([
      "enabled",
      "paused",
      "suspended_archived",
      "paused_failure",
      "retired",
    ]),
    managedBy: workspaceMonitorManagedBySchema.nullable().default(null),
    monitorId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    nextOccurrenceAt: timestampSchema.nullable(),
    ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
    pauseReason: z.string().max(64).nullable(),
    pausedAt: timestampSchema.nullable(),
    requiredCapabilityIds: z.array(idSchema).max(32),
    schedule: workspaceMonitorScheduleSchema,
    schemaVersion: z.literal(1),
    sourceCheckpoint: z
      .object({
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
        watermark: timestampSchema.nullable(),
      })
      .strict(),
    sources: workspaceMonitorSourcesSchema,
    tighteningLimits: z
      .object({
        inputTokensPerRun: z.number().int().positive().nullable(),
        outputTokensPerRun: z.number().int().positive().nullable(),
        paidPerRun: z
          .string()
          .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u)
          .nullable(),
      })
      .strict(),
    updatedAt: timestampSchema,
    workspaceBindingImmutable: z.literal(true),
    workspaceId: z.string().uuid(),
  })
  .strict()
  .superRefine((monitor, context) => {
    if (new Set(monitor.requiredCapabilityIds).size !== monitor.requiredCapabilityIds.length) {
      context.addIssue({ code: "custom", message: "Duplicate capability." });
    }
    if (monitor.lifecycleState === "enabled") {
      if (monitor.pauseReason !== null || monitor.pausedAt !== null) {
        context.addIssue({ code: "custom", message: "Enabled monitor cannot be paused." });
      }
    } else if (monitor.pauseReason === null || monitor.pausedAt === null) {
      context.addIssue({ code: "custom", message: "Paused monitor needs a reason and time." });
    }
    if (monitor.endAt && monitor.endAt <= monitor.createdAt) {
      context.addIssue({ code: "custom", message: "Monitor end must follow creation." });
    }
  });

const occurrenceSchema = z
  .object({
    attempt: z.number().int().positive(),
    configurationRevision: z.number().int().positive(),
    leaseTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    monitorId: z.string().uuid(),
    occurrenceIdentity: z.string().min(1).max(160),
    occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/u),
    scheduledFor: timestampSchema,
    schemaVersion: z.literal(1),
    status: z.literal("leased"),
    updatedAt: timestampSchema,
  })
  .strict();

export type WorkspaceMonitor = z.infer<typeof monitorSchema>;
export type WorkspaceMonitorSchedule = z.infer<typeof workspaceMonitorScheduleSchema>;
export type WorkspaceMonitorManagedBy = z.infer<typeof workspaceMonitorManagedBySchema>;
export type WorkspaceMonitorOccurrence = z.infer<typeof occurrenceSchema>;

export interface ClaimedWorkspaceMonitor {
  readonly leaseExpiresAt: string;
  readonly leaseToken: string;
  readonly monitor: WorkspaceMonitor;
  readonly occurrence: WorkspaceMonitorOccurrence;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly skippedOccurrenceIdentities: readonly string[];
}

export interface WorkspaceMonitorStoreClient {
  complete(input: {
    completedAt: string;
    configurationRevision: number;
    dueKey: string;
    expectedRaw: string;
    inflightKey: string;
    leaseKey: string;
    leaseTokenDigest: string;
    nextDueAtMs: number | null;
    nextRaw: string;
    occurrenceRecordKey: string;
    recordKey: string;
  }): Promise<"already_completed" | "completed" | "lease_mismatch" | "missing" | "stale">;
  claim(input: {
    configurationRevision: number;
    dueAtMs: number;
    dueKey: string;
    leaseForMs: number;
    leaseExpiresAtMs: number;
    leaseKey: string;
    leaseToken: string;
    leaseTokenDigest: string;
    monitorId: string;
    nowMs: number;
    occurrenceIdentity: string;
    occurrenceKey: string;
    occurrenceRecordKey: string;
    inflightKey: string;
    recordKey: string;
    scheduledFor: string;
    updatedAt: string;
  }): Promise<{ attempt?: number; status: "claimed" | "duplicate" | "leased" | "missing" | "not_due" | "stale" }>;
  create(input: {
    dueAtMs: number | null;
    dueKey: string;
    recordKey: string;
    raw: string;
    workspaceIndexKey: string;
  }): Promise<boolean>;
  get(key: string): Promise<unknown>;
  list(indexKey: string): Promise<unknown[]>;
  listDue(input: {
    dueKey: string;
    inflightKey: string;
    limit: number;
    nowMs: number;
  }): Promise<{ raw: unknown; recordKey: string }[]>;
  releaseLease(input: {
    dueAtMs: number | null;
    dueKey: string;
    inflightKey: string;
    leaseKey: string;
    leaseToken: string;
    recordKey: string;
  }): Promise<boolean>;
  update(input: {
    dueAtMs: number | null;
    dueKey: string;
    expected: string;
    next: string;
    recordKey: string;
  }): Promise<boolean>;
}

export class WorkspaceMonitorError extends Error {
  readonly code:
    | "monitor_conflict"
    | "monitor_invalid"
    | "monitor_not_found"
    | "monitor_occurrence_duplicate"
    | "monitor_occurrence_leased"
    | "monitor_occurrence_not_due"
    | "monitor_occurrence_stale"
    | typeof WORKSPACE_MONITOR_SOURCE_LIMIT_CODE;

  constructor(code: WorkspaceMonitorError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceMonitorError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceMonitorStoreClient | undefined;

function store(): WorkspaceMonitorStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace monitor storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  defaultClient = {
    async complete(input) {
      return redisClient!.eval<
        [string, string, string, string, string, string, string],
        "already_completed" | "completed" | "lease_mismatch" | "missing" | "stale"
      >(
        COMPLETE_SCRIPT,
        [
          input.recordKey,
          input.leaseKey,
          input.dueKey,
          input.inflightKey,
          input.occurrenceRecordKey,
        ],
        [
          String(input.configurationRevision),
          input.leaseTokenDigest,
          input.expectedRaw,
          input.nextRaw,
          input.completedAt,
          String(OCCURRENCE_TTL_SECONDS),
          input.nextDueAtMs === null ? "" : String(input.nextDueAtMs),
        ],
      );
    },
    async claim(input) {
      const result = await redisClient!.eval<string[], string[]>(
        CLAIM_SCRIPT,
        [
          input.recordKey,
          input.leaseKey,
          input.occurrenceRecordKey,
          input.dueKey,
          input.inflightKey,
        ],
        [
          String(input.configurationRevision),
          String(input.nowMs),
          String(input.dueAtMs),
          input.leaseToken,
          String(input.leaseForMs),
          input.occurrenceKey,
          input.monitorId,
          input.occurrenceIdentity,
          input.leaseTokenDigest,
          input.scheduledFor,
          input.updatedAt,
          String(OCCURRENCE_TTL_SECONDS),
          String(input.leaseExpiresAtMs),
        ],
      );
      return result[0] === "claimed"
        ? { attempt: Number(result[1]), status: "claimed" as const }
        : { status: result[0] as Exclude<Awaited<ReturnType<WorkspaceMonitorStoreClient["claim"]>>["status"], "claimed"> };
    },
    async create(input) {
      return (
        (await redisClient!.eval<
          [string, string],
          number
        >(
          CREATE_SCRIPT,
          [input.recordKey, input.workspaceIndexKey, input.dueKey],
          [input.raw, input.dueAtMs === null ? "" : String(input.dueAtMs)],
        )) === 1
      );
    },
    get: (key) => redisClient!.get(key),
    async list(indexKey) {
      const keys = await redisClient!.smembers<string[]>(indexKey);
      return keys.length === 0 ? [] : redisClient!.mget(...keys);
    },
    async listDue(input) {
      const raw = await redisClient!.eval<[string, string], string>(
        LIST_DUE_SCRIPT,
        [input.dueKey, input.inflightKey],
        [String(input.nowMs), String(input.limit)],
      );
      const parsed = z
        .array(z.object({ raw: z.unknown(), recordKey: z.string() }).strict())
        .safeParse(JSON.parse(raw));
      if (!parsed.success) throw new WorkspaceMonitorError("monitor_invalid");
      return parsed.data;
    },
    async releaseLease(input) {
      return (
        (await redisClient!.eval<[string, string], number>(
          RELEASE_LEASE_SCRIPT,
          [input.leaseKey, input.recordKey, input.dueKey, input.inflightKey],
          [
            input.leaseToken,
            input.dueAtMs === null ? "" : String(input.dueAtMs),
          ],
        )) === 1
      );
    },
    async update(input) {
      return (
        (await redisClient!.eval<[string, string, string], number>(
          UPDATE_SCRIPT,
          [input.recordKey, input.dueKey],
          [
            input.expected,
            input.next,
            input.dueAtMs === null ? "" : String(input.dueAtMs),
          ],
        )) === 1
      );
    },
  };
  return defaultClient;
}

function scopeDigest(scope: AuthorizedWorkspaceStoreScope): string {
  return createHash("sha256")
    .update(`workspace-monitor\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
}

function recordKey(scope: AuthorizedWorkspaceStoreScope, monitorId: string): string {
  return `${RECORD_PREFIX}${scopeDigest(scope)}:${monitorId}`;
}

function workspaceIndexKey(scope: AuthorizedWorkspaceStoreScope): string {
  return `${WORKSPACE_INDEX_PREFIX}${scopeDigest(scope)}`;
}

function leaseKey(scope: AuthorizedWorkspaceStoreScope, monitorId: string): string {
  return `${LEASE_PREFIX}${scopeDigest(scope)}:${monitorId}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseMonitor(raw: string, scope: AuthorizedWorkspaceStoreScope): WorkspaceMonitor {
  const parsed = parseUnscopedMonitor(raw);
  if (parsed.ownerId !== scope.ownerId || parsed.workspaceId !== scope.workspaceId) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  return parsed;
}

export function validateWorkspaceMonitorValue(
  value: unknown,
  scope: AuthorizedWorkspaceStoreScope,
): WorkspaceMonitor {
  assertAuthorizedWorkspaceStoreScope(scope);
  return parseMonitor(
    typeof value === "string" ? value : JSON.stringify(value),
    scope,
  );
}

function parseUnscopedMonitor(raw: string): WorkspaceMonitor {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const parsed = monitorSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  return parsed.data;
}

function dueAt(record: WorkspaceMonitor): number | null {
  return record.lifecycleState === "enabled" && record.nextOccurrenceAt
    ? new Date(record.nextOccurrenceAt).getTime()
    : null;
}

export function workspaceMonitorOccurrenceKey(input: {
  configurationRevision: number;
  monitorId: string;
  occurrenceIdentity: string;
  scope: AuthorizedWorkspaceStoreScope;
}): string {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (!z.string().uuid().safeParse(input.monitorId).success || !Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1 || input.occurrenceIdentity.length < 1 || input.occurrenceIdentity.length > 160) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  return occurrenceDigest(input);
}

function occurrenceDigest(input: {
  configurationRevision: number;
  monitorId: string;
  occurrenceIdentity: string;
  scope: { ownerId: string; workspaceId: string };
}): string {
  return createHash("sha256")
    .update(
      `monitor-occurrence\0${input.scope.ownerId}\0${input.scope.workspaceId}\0${input.monitorId}\0${input.configurationRevision}\0${input.occurrenceIdentity}`,
    )
    .digest("hex");
}

export async function claimDueWorkspaceMonitors(
  input: {
    environment?: NodeJS.ProcessEnv;
    leaseForMs: number;
    limit: number;
    now: Date;
    recoveryWindowMs: number;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<ClaimedWorkspaceMonitor[]> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 32 ||
    !Number.isSafeInteger(input.leaseForMs) ||
    input.leaseForMs < 1_000 ||
    input.leaseForMs > 60 * 60_000
  ) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const entries = await client.listDue({
    dueKey: DUE_KEY,
    inflightKey: INFLIGHT_KEY,
    limit: input.limit,
    nowMs: input.now.getTime(),
  });
  const claims: ClaimedWorkspaceMonitor[] = [];
  for (const entry of entries) {
    const raw = rawValue(entry.raw);
    if (raw === null) continue;
    const monitor = parseUnscopedMonitor(raw);
    const scope = { ownerId: monitor.ownerId, workspaceId: monitor.workspaceId };
    if (recordKey(scope, monitor.monitorId) !== entry.recordKey || !monitor.nextOccurrenceAt) {
      continue;
    }
    if (monitor.endAt && new Date(monitor.endAt).getTime() <= input.now.getTime()) {
      const expired = monitorSchema.parse({
        ...monitor,
        configurationRevision: monitor.configurationRevision + 1,
        lifecycleState: "paused",
        nextOccurrenceAt: null,
        pauseReason: "end_time_reached",
        pausedAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
      });
      await client.update({
        dueAtMs: null,
        dueKey: DUE_KEY,
        expected: raw,
        next: JSON.stringify(expired),
        recordKey: entry.recordKey,
      });
      continue;
    }
    const selection = selectWorkspaceMonitorDueOccurrence({
      nextOccurrenceAt: monitor.nextOccurrenceAt,
      now: input.now,
      recoveryWindowMs: input.recoveryWindowMs,
      schedule: monitor.schedule,
    });
    if (!selection.due) {
      const nextOccurrence = nextWorkspaceMonitorOccurrence(
        monitor.schedule,
        input.now,
      );
      const exhaustedOneTime =
        monitor.schedule.kind === "one_time" && nextOccurrence === null;
      const advanced = monitorSchema.parse({
        ...monitor,
        ...(exhaustedOneTime
          ? {
              configurationRevision: monitor.configurationRevision + 1,
              lifecycleState: "paused",
              pauseReason: "missed_recovery_window",
              pausedAt: input.now.toISOString(),
            }
          : {}),
        lastErrorCode: "missed_occurrences_skipped",
        nextOccurrenceAt: nextOccurrence?.scheduledAt ?? null,
        updatedAt: input.now.toISOString(),
      });
      await client.update({
        dueAtMs: dueAt(advanced),
        dueKey: DUE_KEY,
        expected: raw,
        next: JSON.stringify(advanced),
        recordKey: entry.recordKey,
      });
      continue;
    }
    const occurrenceKey = occurrenceDigest({
      configurationRevision: monitor.configurationRevision,
      monitorId: monitor.monitorId,
      occurrenceIdentity: selection.due.occurrenceIdentity,
      scope,
    });
    const leaseToken = randomBytes(32).toString("base64url");
    const result = await client.claim({
      configurationRevision: monitor.configurationRevision,
      dueAtMs: new Date(selection.due.scheduledAt).getTime(),
      dueKey: DUE_KEY,
      inflightKey: INFLIGHT_KEY,
      leaseExpiresAtMs: input.now.getTime() + input.leaseForMs,
      leaseForMs: input.leaseForMs,
      leaseKey: leaseKey(scope, monitor.monitorId),
      leaseToken,
      leaseTokenDigest: createHash("sha256").update(leaseToken).digest("hex"),
      monitorId: monitor.monitorId,
      nowMs: input.now.getTime(),
      occurrenceIdentity: selection.due.occurrenceIdentity,
      occurrenceKey,
      occurrenceRecordKey: `${OCCURRENCE_PREFIX}${occurrenceKey}`,
      recordKey: entry.recordKey,
      scheduledFor: selection.due.scheduledAt,
      updatedAt: input.now.toISOString(),
    });
    if (result.status !== "claimed" || !result.attempt) continue;
    claims.push(
      Object.freeze({
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseForMs).toISOString(),
        leaseToken,
        monitor,
        occurrence: occurrenceSchema.parse({
          attempt: result.attempt,
          configurationRevision: monitor.configurationRevision,
          leaseTokenDigest: createHash("sha256").update(leaseToken).digest("hex"),
          monitorId: monitor.monitorId,
          occurrenceIdentity: selection.due.occurrenceIdentity,
          occurrenceKey,
          scheduledFor: selection.due.scheduledAt,
          schemaVersion: 1,
          status: "leased",
          updatedAt: input.now.toISOString(),
        }),
        scope: authorizeDeploymentWorkspaceStore(scope, input.environment),
        skippedOccurrenceIdentities: Object.freeze(
          selection.skipped.map((occurrence) => occurrence.occurrenceIdentity),
        ),
      }),
    );
  }
  return claims;
}

export async function createWorkspaceMonitor(
  input: {
    deliverySubscriptionId: string;
    endAt?: string | null;
    idempotencyKey?: string;
    instruction: string;
    managedBy?: z.input<typeof workspaceMonitorManagedBySchema> | null;
    name: string;
    nextOccurrenceAt: string | null;
    now?: Date;
    requiredCapabilityIds?: string[];
    schedule: WorkspaceMonitorSchedule;
    scope: AuthorizedWorkspaceStoreScope;
    sources: z.input<typeof workspaceMonitorSourcesSchema>;
    tighteningLimits?: z.input<typeof monitorSchema>["tighteningLimits"];
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (input.sources.length > WORKSPACE_MONITOR_SOURCE_LIMIT) {
    throw new WorkspaceMonitorError(WORKSPACE_MONITOR_SOURCE_LIMIT_CODE);
  }
  const now = (input.now ?? new Date()).toISOString();
  const monitorId = input.idempotencyKey
    ? (() => {
        const bytes = createHash("sha256")
          .update(`workspace-monitor\0${input.scope.ownerId}\0${input.scope.workspaceId}\0${input.idempotencyKey}`)
          .digest()
          .subarray(0, 16);
        bytes[6] = (bytes[6]! & 0x0f) | 0x50;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = bytes.toString("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      })()
    : randomUUID();
  const candidate = monitorSchema.safeParse({
    configurationRevision: 1,
    consecutiveFailures: 0,
    createdAt: now,
    deliverySubscriptionId: input.deliverySubscriptionId,
    endAt: input.endAt ?? null,
    instruction: input.instruction,
    lastCompletedAt: null,
    lastErrorCode: null,
    lastRunAt: null,
    lifecycleState: input.managedBy ? "paused" : "enabled",
    managedBy: input.managedBy ?? null,
    monitorId,
    name: input.name,
    nextOccurrenceAt: input.nextOccurrenceAt,
    ownerId: input.scope.ownerId,
    pauseReason: input.managedBy ? "strategy_pack_install_only" : null,
    pausedAt: input.managedBy ? now : null,
    requiredCapabilityIds: input.requiredCapabilityIds ?? [],
    schedule: input.schedule,
    schemaVersion: 1,
    sourceCheckpoint: { contentDigest: null, watermark: null },
    sources: input.sources,
    tighteningLimits: input.tighteningLimits ?? {
      inputTokensPerRun: null,
      outputTokensPerRun: null,
      paidPerRun: null,
    },
    updatedAt: now,
    workspaceBindingImmutable: true,
    workspaceId: input.scope.workspaceId,
  });
  if (!candidate.success) throw new WorkspaceMonitorError("monitor_invalid");
  const raw = JSON.stringify(candidate.data);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw new WorkspaceMonitorError("monitor_invalid");
  const created = await client.create({
    dueAtMs: dueAt(candidate.data),
    dueKey: DUE_KEY,
    raw,
    recordKey: recordKey(input.scope, candidate.data.monitorId),
    workspaceIndexKey: workspaceIndexKey(input.scope),
  });
  if (!created) {
    if (!input.idempotencyKey) throw new WorkspaceMonitorError("monitor_conflict");
    const existing = await getWorkspaceMonitor(input.scope, monitorId, client);
    if (
      existing &&
      existing.deliverySubscriptionId === candidate.data.deliverySubscriptionId &&
      existing.endAt === candidate.data.endAt &&
      existing.instruction === candidate.data.instruction &&
      JSON.stringify(existing.managedBy) === JSON.stringify(candidate.data.managedBy) &&
      existing.name === candidate.data.name &&
      JSON.stringify(existing.requiredCapabilityIds) === JSON.stringify(candidate.data.requiredCapabilityIds) &&
      JSON.stringify(existing.schedule) === JSON.stringify(candidate.data.schedule) &&
      JSON.stringify(existing.sources) === JSON.stringify(candidate.data.sources) &&
      JSON.stringify(existing.tighteningLimits) === JSON.stringify(candidate.data.tighteningLimits)
    ) {
      return existing;
    }
    throw new WorkspaceMonitorError("monitor_conflict");
  }
  return candidate.data;
}

export function resolveWorkspaceStrategyManagedMonitors(
  binding: WorkspaceStrategyBindingValue,
  monitors: readonly WorkspaceMonitor[],
): WorkspaceMonitor[] {
  if (!binding.pack?.contentDigest) {
    if (Object.keys(binding.managedResources).length === 0) return [];
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const byId = new Map(monitors.map((monitor) => [monitor.monitorId, monitor]));
  const resolved: WorkspaceMonitor[] = [];
  for (const [resourceId, resource] of Object.entries(binding.managedResources)) {
    const monitor = byId.get(resource.monitorId);
    if (
      !monitor ||
      !monitor.managedBy ||
      monitor.managedBy.kind !== "strategy_pack" ||
      monitor.managedBy.bindingRevision !== binding.bindingRevision ||
      monitor.managedBy.packContentDigest !== binding.pack.contentDigest ||
      monitor.managedBy.packId !== binding.pack.id ||
      monitor.managedBy.packVersion !== binding.pack.version ||
      monitor.managedBy.resourceId !== resourceId ||
      JSON.stringify(monitor.sources.map(({ sourceId }) => sourceId).sort()) !==
        JSON.stringify(resource.sourceIds)
    ) {
      throw new WorkspaceMonitorError("monitor_invalid");
    }
    resolved.push(monitor);
  }
  for (const monitor of monitors) {
    const provenance = monitor.managedBy;
    if (
      provenance?.kind === "strategy_pack" &&
      provenance.bindingRevision === binding.bindingRevision &&
      provenance.packContentDigest === binding.pack.contentDigest &&
      provenance.packId === binding.pack.id &&
      provenance.packVersion === binding.pack.version &&
      binding.managedResources[provenance.resourceId]?.monitorId !== monitor.monitorId
    ) {
      throw new WorkspaceMonitorError("monitor_invalid");
    }
  }
  return resolved.sort((left, right) => left.monitorId.localeCompare(right.monitorId));
}

export async function getWorkspaceMonitor(
  scope: AuthorizedWorkspaceStoreScope,
  monitorId: string,
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(recordKey(scope, monitorId)));
  return raw === null ? null : parseMonitor(raw, scope);
}

export async function listWorkspaceMonitors(
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor[]> {
  assertAuthorizedWorkspaceStoreScope(scope);
  return (await client.list(workspaceIndexKey(scope)))
    .flatMap((value) => {
      const raw = rawValue(value);
      return raw === null ? [] : [parseMonitor(raw, scope)];
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function updateWorkspaceMonitor(
  input: {
    expectedRevision: number;
    monitorId: string;
    now?: Date;
    patch: Partial<Pick<WorkspaceMonitor, "consecutiveFailures" | "endAt" | "instruction" | "lastErrorCode" | "lastRunAt" | "lifecycleState" | "name" | "nextOccurrenceAt" | "pauseReason" | "pausedAt" | "requiredCapabilityIds" | "schedule" | "sources" | "tighteningLimits">>;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (
    input.patch.sources &&
    input.patch.sources.length > WORKSPACE_MONITOR_SOURCE_LIMIT
  ) {
    throw new WorkspaceMonitorError(WORKSPACE_MONITOR_SOURCE_LIMIT_CODE);
  }
  const key = recordKey(input.scope, input.monitorId);
  const currentRaw = rawValue(await client.get(key));
  if (currentRaw === null) throw new WorkspaceMonitorError("monitor_not_found");
  const current = parseMonitor(currentRaw, input.scope);
  if (current.configurationRevision !== input.expectedRevision) throw new WorkspaceMonitorError("monitor_conflict");
  const targetLifecycle = input.patch.lifecycleState ?? current.lifecycleState;
  const allowedTransitions: Readonly<Record<WorkspaceMonitor["lifecycleState"], readonly WorkspaceMonitor["lifecycleState"][]>> = {
    enabled: ["enabled", "paused", "paused_failure", "suspended_archived", "retired"],
    paused: ["paused", "enabled", "suspended_archived", "retired"],
    paused_failure: ["paused_failure", "enabled", "suspended_archived", "retired"],
    suspended_archived: ["suspended_archived", "paused", "retired"],
    retired: ["retired"],
  };
  if (!allowedTransitions[current.lifecycleState].includes(targetLifecycle)) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const next = monitorSchema.safeParse({
    ...current,
    ...input.patch,
    configurationRevision: current.configurationRevision + 1,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  if (
    !next.success ||
    next.data.workspaceId !== current.workspaceId ||
    next.data.ownerId !== current.ownerId ||
    JSON.stringify(next.data.managedBy) !== JSON.stringify(current.managedBy)
  ) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const nextRaw = JSON.stringify(next.data);
  if (Buffer.byteLength(nextRaw, "utf8") > MAX_RECORD_BYTES) throw new WorkspaceMonitorError("monitor_invalid");
  if (!(await client.update({ dueAtMs: dueAt(next.data), dueKey: DUE_KEY, expected: currentRaw, next: nextRaw, recordKey: key }))) {
    throw new WorkspaceMonitorError("monitor_conflict");
  }
  return next.data;
}

export async function suspendWorkspaceMonitorsForArchive(
  input: { now?: Date; scope: AuthorizedWorkspaceStoreScope },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor[]> {
  const now = input.now ?? new Date();
  const monitors = await listWorkspaceMonitors(input.scope, client);
  const updated: WorkspaceMonitor[] = [];
  for (const monitor of monitors) {
    if (monitor.lifecycleState === "retired" || monitor.lifecycleState === "suspended_archived") {
      updated.push(monitor);
      continue;
    }
    updated.push(await updateWorkspaceMonitor({
      expectedRevision: monitor.configurationRevision,
      monitorId: monitor.monitorId,
      now,
      patch: {
        lifecycleState: "suspended_archived",
        nextOccurrenceAt: null,
        pauseReason: "workspace_archived",
        pausedAt: now.toISOString(),
      },
      scope: input.scope,
    }, client));
  }
  return updated;
}

export async function pauseWorkspaceMonitorsAfterRestore(
  input: { now?: Date; scope: AuthorizedWorkspaceStoreScope },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor[]> {
  const now = input.now ?? new Date();
  const monitors = await listWorkspaceMonitors(input.scope, client);
  const updated: WorkspaceMonitor[] = [];
  for (const monitor of monitors) {
    if (monitor.lifecycleState !== "suspended_archived") {
      updated.push(monitor);
      continue;
    }
    updated.push(await updateWorkspaceMonitor({
      expectedRevision: monitor.configurationRevision,
      monitorId: monitor.monitorId,
      now,
      patch: {
        lifecycleState: "paused",
        nextOccurrenceAt: null,
        pauseReason: "workspace_restored_manual_resume_required",
        pausedAt: now.toISOString(),
      },
      scope: input.scope,
    }, client));
  }
  return updated;
}

export async function claimWorkspaceMonitorOccurrence(
  input: {
    configurationRevision: number;
    leaseForMs: number;
    monitorId: string;
    now?: Date;
    occurrenceIdentity: string;
    scheduledFor: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<{ leaseToken: string; occurrence: WorkspaceMonitorOccurrence }> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (!Number.isSafeInteger(input.leaseForMs) || input.leaseForMs < 1_000 || input.leaseForMs > 60 * 60_000) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const scheduledForMs = new Date(input.scheduledFor).getTime();
  if (!Number.isFinite(scheduledForMs)) throw new WorkspaceMonitorError("monitor_invalid");
  const current = await getWorkspaceMonitor(input.scope, input.monitorId, client);
  if (
    !current ||
    (current.endAt !== null && new Date(current.endAt).getTime() <= (input.now ?? new Date()).getTime())
  ) {
    throw new WorkspaceMonitorError("monitor_occurrence_not_due");
  }
  const occurrenceKey = workspaceMonitorOccurrenceKey(input);
  const leaseToken = randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  const updatedAt = now.toISOString();
  const result = await client.claim({
    configurationRevision: input.configurationRevision,
    dueAtMs: scheduledForMs,
    dueKey: DUE_KEY,
    leaseForMs: input.leaseForMs,
    leaseExpiresAtMs: now.getTime() + input.leaseForMs,
    leaseKey: leaseKey(input.scope, input.monitorId),
    leaseToken,
    leaseTokenDigest: createHash("sha256").update(leaseToken).digest("hex"),
    monitorId: input.monitorId,
    nowMs: now.getTime(),
    occurrenceIdentity: input.occurrenceIdentity,
    occurrenceKey,
    occurrenceRecordKey: `${OCCURRENCE_PREFIX}${occurrenceKey}`,
    inflightKey: INFLIGHT_KEY,
    recordKey: recordKey(input.scope, input.monitorId),
    scheduledFor: input.scheduledFor,
    updatedAt,
  });
  if (result.status !== "claimed") {
    const codes = {
      duplicate: "monitor_occurrence_duplicate",
      leased: "monitor_occurrence_leased",
      missing: "monitor_not_found",
      not_due: "monitor_occurrence_not_due",
      stale: "monitor_occurrence_stale",
    } as const;
    throw new WorkspaceMonitorError(codes[result.status]);
  }
  if (!result.attempt) throw new WorkspaceMonitorError("monitor_invalid");
  return {
    leaseToken,
    occurrence: occurrenceSchema.parse({
      attempt: result.attempt,
      configurationRevision: input.configurationRevision,
      leaseTokenDigest: createHash("sha256").update(leaseToken).digest("hex"),
      monitorId: input.monitorId,
      occurrenceIdentity: input.occurrenceIdentity,
      occurrenceKey,
      scheduledFor: input.scheduledFor,
      schemaVersion: 1,
      status: "leased",
      updatedAt,
    }),
  };
}

function boundedMonitorErrorCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "workspace_run_failed";
}

export async function recordWorkspaceMonitorFailure(
  input: {
    errorCode: string;
    expectedRevision: number;
    failureThreshold?: number;
    monitorId: string;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor> {
  const current = await getWorkspaceMonitor(input.scope, input.monitorId, client);
  if (!current) throw new WorkspaceMonitorError("monitor_not_found");
  const threshold = input.failureThreshold ?? 5;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 20) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const now = input.now ?? new Date();
  const failures = current.consecutiveFailures + 1;
  const paused = failures >= threshold;
  const boundedErrorCode = boundedMonitorErrorCode(input.errorCode);
  const pauseCode = paused && boundedErrorCode.startsWith("worker_recovery_")
    ? boundedErrorCode
    : "auto_paused_after_repeated_failures";
  return updateWorkspaceMonitor(
    {
      expectedRevision: input.expectedRevision,
      monitorId: input.monitorId,
      now,
      patch: {
        consecutiveFailures: failures,
        lastErrorCode: paused
          ? pauseCode
          : boundedErrorCode,
        lastRunAt: now.toISOString(),
        ...(paused
          ? {
              lifecycleState: "paused_failure" as const,
              nextOccurrenceAt: null,
              pauseReason: pauseCode,
              pausedAt: now.toISOString(),
            }
          : {}),
      },
      scope: input.scope,
    },
    client,
  );
}

export async function pauseWorkspaceMonitorAfterUncertainAlert(
  input: {
    expectedRevision: number;
    monitorId: string;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor> {
  const now = input.now ?? new Date();
  return updateWorkspaceMonitor(
    {
      expectedRevision: input.expectedRevision,
      monitorId: input.monitorId,
      now,
      patch: {
        lastErrorCode: "alert_delivery_checkpoint_uncertain",
        lastRunAt: now.toISOString(),
        lifecycleState: "paused_failure",
        nextOccurrenceAt: null,
        pauseReason: "alert_delivery_checkpoint_uncertain",
        pausedAt: now.toISOString(),
      },
      scope: input.scope,
    },
    client,
  );
}

export async function releaseWorkspaceMonitorLease(
  input: { leaseToken: string; monitorId: string; scope: AuthorizedWorkspaceStoreScope },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<boolean> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const monitor = await getWorkspaceMonitor(input.scope, input.monitorId, client);
  if (!monitor) return false;
  return client.releaseLease({
    dueAtMs: dueAt(monitor),
    dueKey: DUE_KEY,
    inflightKey: INFLIGHT_KEY,
    leaseKey: leaseKey(input.scope, input.monitorId),
    leaseToken: input.leaseToken,
    recordKey: recordKey(input.scope, input.monitorId),
  });
}

export type WorkspaceMonitorLeaseInspection =
  | "completed"
  | "current"
  | "stale";

export async function inspectWorkspaceMonitorOccurrenceLease(
  input: {
    configurationRevision: number;
    leaseToken: string;
    leaseTokenDigest: string;
    monitorId: string;
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitorLeaseInspection> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (
    !z.string().uuid().safeParse(input.monitorId).success ||
    !/^[a-f0-9]{64}$/u.test(input.leaseTokenDigest) ||
    !/^[a-f0-9]{64}$/u.test(input.occurrenceKey)
  ) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const [leaseRaw, occurrenceRaw] = await Promise.all([
    client.get(leaseKey(input.scope, input.monitorId)),
    client.get(`${OCCURRENCE_PREFIX}${input.occurrenceKey}`),
  ]);
  const occurrenceValue = rawValue(occurrenceRaw);
  if (occurrenceValue === null) return "stale";
  let occurrence: Record<string, unknown>;
  try {
    const parsed = JSON.parse(occurrenceValue) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid occurrence");
    }
    occurrence = parsed as Record<string, unknown>;
  } catch {
    throw new WorkspaceMonitorError("monitor_occurrence_stale");
  }
  if (
    occurrence.monitorId !== input.monitorId ||
    occurrence.occurrenceKey !== input.occurrenceKey ||
    occurrence.configurationRevision !== input.configurationRevision ||
    occurrence.leaseTokenDigest !== input.leaseTokenDigest
  ) {
    return "stale";
  }
  if (occurrence.status === "completed") return "completed";
  if (occurrence.status !== "leased") return "stale";
  return rawValue(leaseRaw) === input.leaseToken ? "current" : "stale";
}

export async function completeWorkspaceMonitorCheckpoint(
  input: {
    completedAt?: Date;
    configurationRevision: number;
    contentDigest: string;
    leaseTokenDigest: string;
    monitorId: string;
    occurrenceKey: string;
    scheduledFor: string;
    scope: AuthorizedWorkspaceStoreScope;
    watermark: string;
  },
  client: WorkspaceMonitorStoreClient = store(),
): Promise<WorkspaceMonitor> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const monitor = await getWorkspaceMonitor(input.scope, input.monitorId, client);
  if (
    !monitor ||
    monitor.configurationRevision !== input.configurationRevision ||
    !/^[a-f0-9]{64}$/u.test(input.contentDigest) ||
    !/^[a-f0-9]{64}$/u.test(input.leaseTokenDigest) ||
    !/^[a-f0-9]{64}$/u.test(input.occurrenceKey)
  ) {
    throw new WorkspaceMonitorError("monitor_occurrence_stale");
  }
  if (
    monitor.sourceCheckpoint.watermark &&
    monitor.sourceCheckpoint.watermark > input.watermark
  ) {
    throw new WorkspaceMonitorError("monitor_occurrence_stale");
  }
  const afterOccurrence = new Date(Date.parse(input.scheduledFor) + 1);
  if (!Number.isFinite(afterOccurrence.getTime())) {
    throw new WorkspaceMonitorError("monitor_invalid");
  }
  const next = nextWorkspaceMonitorOccurrence(monitor.schedule, afterOccurrence);
  const completedAt = (input.completedAt ?? new Date()).toISOString();
  const expectedRaw = rawValue(await client.get(recordKey(input.scope, input.monitorId)));
  if (expectedRaw === null) throw new WorkspaceMonitorError("monitor_not_found");
  const expectedMonitor = parseMonitor(expectedRaw, input.scope);
  if (expectedMonitor.configurationRevision !== monitor.configurationRevision) {
    throw new WorkspaceMonitorError("monitor_occurrence_stale");
  }
  const nextMonitor = monitorSchema.parse({
    ...expectedMonitor,
    consecutiveFailures: 0,
    lastCompletedAt: completedAt,
    lastErrorCode: null,
    lastRunAt: completedAt,
    nextOccurrenceAt: next?.scheduledAt ?? null,
    sourceCheckpoint: {
      contentDigest: input.contentDigest,
      watermark: input.watermark,
    },
    updatedAt: completedAt,
  });
  const status = await client.complete({
    completedAt,
    configurationRevision: input.configurationRevision,
    dueKey: DUE_KEY,
    expectedRaw,
    inflightKey: INFLIGHT_KEY,
    leaseKey: leaseKey(input.scope, input.monitorId),
    leaseTokenDigest: input.leaseTokenDigest,
    nextDueAtMs: next ? Date.parse(next.scheduledAt) : null,
    nextRaw: JSON.stringify(nextMonitor),
    occurrenceRecordKey: `${OCCURRENCE_PREFIX}${input.occurrenceKey}`,
    recordKey: recordKey(input.scope, input.monitorId),
  });
  if (status !== "completed" && status !== "already_completed") {
    throw new WorkspaceMonitorError(
      status === "missing" ? "monitor_not_found" : "monitor_occurrence_stale",
    );
  }
  const completed = await getWorkspaceMonitor(input.scope, input.monitorId, client);
  if (!completed) throw new WorkspaceMonitorError("monitor_not_found");
  return completed;
}
