import { createHash, randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import { getPublicFeed } from "./public-feeds";
import {
  validateWorkspaceMonitorValue,
  type WorkspaceMonitor,
} from "./workspace-monitor-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const LEGACY_PREFIX = "eve:event-trigger:v1";
const MONITOR_PREFIX = "eve:workspace-runtime:v1:monitor:";
const ASSIGNMENT_PREFIX = "eve:workspace-runtime:v1:legacy-assignment:";
const ASSIGN_SCRIPT = `
local existing = redis.call("GET", KEYS[8])
if existing then return existing end
local legacy = redis.call("GET", KEYS[1])
if legacy ~= ARGV[1] then return "__conflict__" end
if redis.call("EXISTS", KEYS[2]) == 1 or redis.call("EXISTS", KEYS[3]) == 1 then
  return "__busy__"
end
if redis.call("EXISTS", KEYS[4]) == 1 then return "__conflict__" end
redis.call("SET", KEYS[1], ARGV[2])
redis.call("ZREM", KEYS[7], ARGV[3])
redis.call("SET", KEYS[4], ARGV[4])
redis.call("SADD", KEYS[5], KEYS[4])
if ARGV[5] ~= "" then redis.call("ZADD", KEYS[6], ARGV[5], KEYS[4]) end
redis.call("SET", KEYS[8], ARGV[6])
return ARGV[6]
`;

export const WORKSPACE_LEGACY_ASSIGNMENT_REDIS_SCRIPT = ASSIGN_SCRIPT;

const legacySchema = z.object({
  consecutiveFailures: z.number().int().nonnegative(),
  createdAtMs: z.number().int().nonnegative(),
  destination: z.discriminatedUnion("kind", [
    z.object({ adapterName: z.literal("imessage"), kind: z.literal("photon"), threadId: z.string().min(1) }),
    z.object({ chatId: z.string().min(1), kind: z.literal("telegram"), messageThreadId: z.number().int().positive().optional() }),
  ]),
  enabled: z.boolean(),
  everyMinutes: z.number().int().min(15).max(525_600).nullable(),
  expiresAtMs: z.number().int().nonnegative(),
  id: z.string().uuid(),
  instruction: z.string().min(1).max(8_000),
  lastCompletedAtMs: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.string().max(80).nullable(),
  lastRunAtMs: z.number().int().nonnegative().nullable(),
  name: z.string().min(1).max(160),
  nextRunAtMs: z.number().int().nonnegative().nullable(),
  ownerKey: z.string().regex(/^[a-f0-9]{64}$/u),
  revision: z.number().int().positive(),
  runCount: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  sourceIds: z.array(z.string().min(1)).max(8),
  sourceUrls: z.array(z.string().url()).max(8),
  timezone: z.string().min(1).max(80),
  updatedAtMs: z.number().int().nonnegative(),
  userId: z.string().min(1),
}).strict().refine(
  (record) => record.sourceIds.length + record.sourceUrls.length <= 8,
  "monitor_source_limit_exceeded",
);

const assignmentSchema = z.object({
  assignedAt: z.string().datetime({ offset: true }),
  legacyOwnerKey: z.string().regex(/^[a-f0-9]{64}$/u),
  legacyRevision: z.number().int().positive(),
  legacyTriggerId: z.string().uuid(),
  monitorId: z.string().uuid(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  workspaceMonitorRevision: z.literal(1),
}).strict();

export type WorkspaceLegacyMonitorAssignment = z.infer<typeof assignmentSchema>;

export interface WorkspaceLegacyMonitorAssignmentClient {
  assign(input: {
    activeRunKey: string;
    assignmentKey: string;
    assignmentRaw: string;
    legacyDueKey: string;
    legacyId: string;
    legacyLeaseKey: string;
    legacyNextRaw: string;
    legacyRaw: string;
    legacyRecordKey: string;
    monitorDueAtMs: number | null;
    monitorDueKey: string;
    monitorIndexKey: string;
    monitorRaw: string;
    monitorRecordKey: string;
  }): Promise<string>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceLegacyMonitorAssignmentError extends Error {
  readonly code:
    | "legacy_assignment_busy"
    | "legacy_assignment_conflict"
    | "legacy_assignment_incompatible"
    | "legacy_assignment_not_found";

  constructor(code: WorkspaceLegacyMonitorAssignmentError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceLegacyMonitorAssignmentError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceLegacyMonitorAssignmentClient | undefined;

function store(): WorkspaceLegacyMonitorAssignmentClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Legacy monitor assignment storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  defaultClient = {
    async assign(input) {
      return redisClient!.eval<string[], string>(
        ASSIGN_SCRIPT,
        [
          input.legacyRecordKey,
          input.legacyLeaseKey,
          input.activeRunKey,
          input.monitorRecordKey,
          input.monitorIndexKey,
          input.monitorDueKey,
          input.legacyDueKey,
          input.assignmentKey,
        ],
        [
          input.legacyRaw,
          input.legacyNextRaw,
          input.legacyId,
          input.monitorRaw,
          input.monitorDueAtMs === null ? "" : String(input.monitorDueAtMs),
          input.assignmentRaw,
        ],
      );
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient!;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function scopeDigest(scope: AuthorizedWorkspaceStoreScope): string {
  return createHash("sha256")
    .update(`workspace-monitor\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
}

function sourceUrl(value: string): { canonicalUrl: string; origin: string } {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.toString() !== value
  ) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_incompatible");
  }
  return { canonicalUrl: value, origin: url.origin };
}

function monitorSources(record: z.infer<typeof legacySchema>) {
  const catalog = record.sourceIds.map((sourceId) => {
    const source = getPublicFeed(sourceId);
    if (!source?.url) {
      throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_incompatible");
    }
    return { accessClassification: "public" as const, sourceId, ...sourceUrl(source.url) };
  });
  const urls = record.sourceUrls.map((url) => ({
    accessClassification: "public" as const,
    sourceId: `legacy_url_${createHash("sha256").update(url).digest("hex").slice(0, 24)}`,
    ...sourceUrl(url),
  }));
  return [...catalog, ...urls];
}

function parseAssignment(raw: string): WorkspaceLegacyMonitorAssignment {
  try {
    return assignmentSchema.parse(JSON.parse(raw));
  } catch {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
}

export async function readWorkspaceLegacyMonitorAssignment(
  scope: AuthorizedWorkspaceStoreScope,
  legacyTriggerId: string,
  client: WorkspaceLegacyMonitorAssignmentClient = store(),
): Promise<WorkspaceLegacyMonitorAssignment | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(`${ASSIGNMENT_PREFIX}${legacyTriggerId}`));
  if (raw === null) return null;
  const assignment = parseAssignment(raw);
  if (assignment.ownerId !== scope.ownerId || assignment.workspaceId !== scope.workspaceId) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  return assignment;
}

export async function assignLegacyMonitorToWorkspace(
  input: {
    deliverySubscriptionId: string;
    expectedLegacyRevision: number;
    legacyOwnerKey: string;
    legacyTriggerId: string;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceLegacyMonitorAssignmentClient = store(),
): Promise<{ assignment: WorkspaceLegacyMonitorAssignment; monitor: WorkspaceMonitor }> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const existingAssignment = await readWorkspaceLegacyMonitorAssignment(
    input.scope,
    input.legacyTriggerId,
    client,
  );
  if (existingAssignment) {
    if (
      existingAssignment.ownerId !== input.scope.ownerId ||
      existingAssignment.workspaceId !== input.scope.workspaceId ||
      existingAssignment.legacyOwnerKey !== input.legacyOwnerKey ||
      existingAssignment.legacyRevision !== input.expectedLegacyRevision
    ) {
      throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
    }
    const digest = scopeDigest(input.scope);
    const rawMonitor = await client.get(
      `${MONITOR_PREFIX}record:${digest}:${existingAssignment.monitorId}`,
    );
    if (rawMonitor === null || rawMonitor === undefined) {
      throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
    }
    return {
      assignment: existingAssignment,
      monitor: validateWorkspaceMonitorValue(rawMonitor, input.scope),
    };
  }
  const legacyRecordKey = `${LEGACY_PREFIX}:record:${input.legacyTriggerId}`;
  const legacyRaw = rawValue(await client.get(legacyRecordKey));
  if (legacyRaw === null) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_not_found");
  }
  let legacyValue: unknown;
  try {
    legacyValue = JSON.parse(legacyRaw);
  } catch {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  const parsed = legacySchema.safeParse(legacyValue);
  if (
    !parsed.success ||
    parsed.data.id !== input.legacyTriggerId ||
    parsed.data.ownerKey !== input.legacyOwnerKey ||
    parsed.data.revision !== input.expectedLegacyRevision
  ) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  const legacy = parsed.data;
  if (legacy.destination.kind !== "photon") {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_incompatible");
  }
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const nextAt = legacy.nextRunAtMs === null ? null : new Date(legacy.nextRunAtMs).toISOString();
  const schedule = legacy.everyMinutes === null
    ? { at: nextAt ?? new Date(legacy.createdAtMs).toISOString(), kind: "one_time" as const }
    : {
        anchor: nextAt ?? new Date(legacy.updatedAtMs).toISOString(),
        everyMinutes: legacy.everyMinutes,
        kind: "interval" as const,
      };
  const enabled = legacy.enabled && legacy.nextRunAtMs !== null && legacy.expiresAtMs > now.getTime();
  const monitorId = randomUUID();
  const monitor: WorkspaceMonitor = {
    configurationRevision: 1,
    consecutiveFailures: legacy.consecutiveFailures,
    createdAt: timestamp,
    deliverySubscriptionId: input.deliverySubscriptionId,
    endAt:
      legacy.expiresAtMs > now.getTime()
        ? new Date(legacy.expiresAtMs).toISOString()
        : null,
    instruction: legacy.instruction,
    lastCompletedAt: legacy.lastCompletedAtMs === null ? null : new Date(legacy.lastCompletedAtMs).toISOString(),
    lastErrorCode: legacy.lastErrorCode,
    lastRunAt: legacy.lastRunAtMs === null ? null : new Date(legacy.lastRunAtMs).toISOString(),
    lifecycleState: enabled ? "enabled" : "paused",
    managedBy: null,
    monitorId,
    name: legacy.name,
    nextOccurrenceAt: enabled ? nextAt : null,
    ownerId: input.scope.ownerId,
    pauseReason: enabled ? null : "legacy_assignment_requires_resume",
    pausedAt: enabled ? null : timestamp,
    requiredCapabilityIds: [],
    schedule,
    schemaVersion: 1,
    sourceCheckpoint: {
      contentDigest: null,
      watermark: legacy.lastCompletedAtMs === null ? null : new Date(legacy.lastCompletedAtMs).toISOString(),
    },
    sources: monitorSources(legacy),
    tighteningLimits: { inputTokensPerRun: null, outputTokensPerRun: null, paidPerRun: null },
    updatedAt: timestamp,
    workspaceBindingImmutable: true,
    workspaceId: input.scope.workspaceId,
  };
  const validatedMonitor = validateWorkspaceMonitorValue(monitor, input.scope);
  const assignment = assignmentSchema.parse({
    assignedAt: timestamp,
    legacyOwnerKey: input.legacyOwnerKey,
    legacyRevision: legacy.revision,
    legacyTriggerId: legacy.id,
    monitorId,
    ownerId: input.scope.ownerId,
    schemaVersion: 1,
    workspaceId: input.scope.workspaceId,
    workspaceMonitorRevision: 1,
  });
  const legacyNext = {
    ...legacy,
    enabled: false,
    lastErrorCode: "assigned_to_workspace",
    nextRunAtMs: null,
    revision: legacy.revision + 1,
    updatedAtMs: now.getTime(),
  };
  const digest = scopeDigest(input.scope);
  const result = await client.assign({
    activeRunKey: `${LEGACY_PREFIX}:active-run:${legacy.id}`,
    assignmentKey: `${ASSIGNMENT_PREFIX}${legacy.id}`,
    assignmentRaw: JSON.stringify(assignment),
    legacyDueKey: `${LEGACY_PREFIX}:due`,
    legacyId: legacy.id,
    legacyLeaseKey: `${LEGACY_PREFIX}:lease:${legacy.id}`,
    legacyNextRaw: JSON.stringify(legacyNext),
    legacyRaw,
    legacyRecordKey,
    monitorDueAtMs: enabled ? legacy.nextRunAtMs : null,
    monitorDueKey: `${MONITOR_PREFIX}due`,
    monitorIndexKey: `${MONITOR_PREFIX}workspace:${digest}`,
    monitorRaw: JSON.stringify(validatedMonitor),
    monitorRecordKey: `${MONITOR_PREFIX}record:${digest}:${monitorId}`,
  });
  if (result === "__busy__") {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_busy");
  }
  if (result === "__conflict__") {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  const committed = parseAssignment(result);
  if (
    committed.ownerId !== input.scope.ownerId ||
    committed.workspaceId !== input.scope.workspaceId ||
    committed.legacyOwnerKey !== input.legacyOwnerKey ||
    committed.legacyRevision !== input.expectedLegacyRevision
  ) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  if (committed.monitorId === monitorId) {
    return { assignment: committed, monitor: validatedMonitor };
  }
  const committedMonitor = await client.get(
    `${MONITOR_PREFIX}record:${digest}:${committed.monitorId}`,
  );
  if (committedMonitor === null || committedMonitor === undefined) {
    throw new WorkspaceLegacyMonitorAssignmentError("legacy_assignment_conflict");
  }
  return {
    assignment: committed,
    monitor: validateWorkspaceMonitorValue(committedMonitor, input.scope),
  };
}
