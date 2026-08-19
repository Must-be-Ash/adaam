import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import type { WorkspaceFinding } from "./workspace-finding-store";
import type { WorkspaceMonitor } from "./workspace-monitor-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:workspace-runtime:v1:alert:";
const CREATE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;
const CAS_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const alertSourceSchema = z.object({
  canonicalUrl: z.string().url().max(2_048),
  sourceId: idSchema,
}).strict();
const alertSchema = z.object({
  alertId: idSchema,
  artifactRefs: z.array(idSchema).max(8).optional(),
  createdAt: timestampSchema,
  eventTime: timestampSchema.optional(),
  findingId: idSchema,
  ownerId: idSchema,
  recordType: z.literal("workspace_alert"),
  schemaVersion: z.literal(1),
  sourceLinks: z.array(alertSourceSchema).min(1).max(8).optional(),
  sourceRefs: z.array(idSchema).min(1).max(8),
  state: z.literal("ready"),
  title: z.string().min(1).max(240),
  whyMatched: z.string().min(1).max(1_000),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1).max(80),
}).strict();
const deliverySchema = z.object({
  alertId: idSchema,
  attempt: z.number().int().min(0).max(8),
  createdAt: timestampSchema,
  deliveryId: idSchema,
  destinationDigest: digestSchema,
  failureCode: z.string().max(64).nullable(),
  ownerId: idSchema,
  recordType: z.literal("workspace_alert_delivery"),
  schemaVersion: z.literal(1),
  resolutionCode: z.enum(["abandoned", "confirmed_delivered", "confirmed_not_delivered"]).nullable(),
  resolvedAt: timestampSchema.nullable(),
  state: z.enum(["delivered", "delivering", "delivery_uncertain", "resolved", "retryable_failure", "staged"]),
  subscriptionId: idSchema,
  updatedAt: timestampSchema,
  workspaceId: z.string().uuid(),
}).strict();

export type WorkspaceAlert = z.infer<typeof alertSchema>;
export type WorkspaceAlertDelivery = z.infer<typeof deliverySchema>;

export interface WorkspaceAlertStoreClient {
  compareAndSet(key: string, expected: string, next: string): Promise<boolean>;
  createOrRead(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceAlertStoreError extends Error {
  readonly code: "alert_conflict" | "alert_corrupt";
  constructor(code: WorkspaceAlertStoreError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceAlertStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceAlertStoreClient | undefined;
function store(): WorkspaceAlertStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace alert storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let sha = redisClient.scriptLoad(CREATE_SCRIPT);
  let casSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      try {
        return (await redisClient!.evalsha<[string, string], number>(await casSha, [key], [expected, next])) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        casSha = redisClient!.scriptLoad(CAS_SCRIPT);
        return (await redisClient!.evalsha<[string, string], number>(await casSha, [key], [expected, next])) === 1;
      }
    },
    async createOrRead(key, value) {
      try {
        return await redisClient!.evalsha<[string], string>(await sha, [key], [value]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        sha = redisClient!.scriptLoad(CREATE_SCRIPT);
        return redisClient!.evalsha<[string], string>(await sha, [key], [value]);
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function key(scope: AuthorizedWorkspaceStoreScope, kind: string, id: string): string {
  return `${KEY_PREFIX}${digest(`${scope.ownerId}\0${scope.workspaceId}\0${kind}\0${id}`)}`;
}
function serialized(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, scope: AuthorizedWorkspaceStoreScope): T {
  const raw = serialized(value);
  if (!raw || Buffer.byteLength(raw, "utf8") > 32 * 1_024) {
    throw new WorkspaceAlertStoreError("alert_corrupt");
  }
  const result = schema.safeParse(JSON.parse(raw));
  if (!result.success) throw new WorkspaceAlertStoreError("alert_corrupt");
  const record = result.data as T & { ownerId: string; workspaceId: string };
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new WorkspaceAlertStoreError("alert_corrupt");
  }
  return result.data;
}

export async function stageWorkspaceAlert(input: {
  finding: WorkspaceFinding;
  monitor: WorkspaceMonitor;
  now?: Date;
  presentation?: { title: string; whyMatched: string };
  presentationKey?: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: WorkspaceAlertStoreClient = store()): Promise<WorkspaceAlert> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (
    input.finding.ownerId !== input.scope.ownerId ||
    input.finding.workspaceId !== input.scope.workspaceId ||
    input.finding.monitorId !== input.monitor.monitorId
  ) throw new WorkspaceAlertStoreError("alert_conflict");
  const alertId = `alert_${digest(input.presentationKey
    ? `${input.finding.findingId}\0${input.presentationKey}`
    : input.finding.findingId)}`;
  const candidate = alertSchema.parse({
    alertId,
    artifactRefs: input.finding.artifactRefs,
    createdAt: (input.now ?? new Date()).toISOString(),
    eventTime: input.finding.asOf,
    findingId: input.finding.findingId,
    ownerId: input.scope.ownerId,
    recordType: "workspace_alert",
    schemaVersion: 1,
    sourceLinks: input.finding.provenance.map((source) => ({
      canonicalUrl: source.canonicalUrl,
      sourceId: source.sourceId,
    })),
    sourceRefs: input.finding.provenance.map((source) => source.sourceId),
    state: "ready",
    title: input.presentation?.title ?? input.monitor.name,
    whyMatched: input.presentation?.whyMatched ?? input.finding.summary,
    workspaceId: input.scope.workspaceId,
    workspaceName: input.monitor.name,
  });
  const value = await client.createOrRead(
    key(input.scope, "alert", alertId),
    JSON.stringify(candidate),
  );
  const result = parse(alertSchema, value, input.scope);
  if (result.findingId !== input.finding.findingId) {
    throw new WorkspaceAlertStoreError("alert_conflict");
  }
  return result;
}

export async function stageWorkspaceAlertDelivery(input: {
  alert: WorkspaceAlert;
  destination: string;
  now?: Date;
  scope: AuthorizedWorkspaceStoreScope;
  subscriptionId: string;
}, client: WorkspaceAlertStoreClient = store()): Promise<WorkspaceAlertDelivery> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (input.alert.ownerId !== input.scope.ownerId || input.alert.workspaceId !== input.scope.workspaceId) {
    throw new WorkspaceAlertStoreError("alert_conflict");
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  const candidate = deliverySchema.parse({
    alertId: input.alert.alertId,
    attempt: 0,
    createdAt: timestamp,
    deliveryId: `delivery_${digest(`${input.alert.alertId}\0${input.subscriptionId}`)}`,
    destinationDigest: digest(input.destination),
    failureCode: null,
    ownerId: input.scope.ownerId,
    recordType: "workspace_alert_delivery",
    resolutionCode: null,
    resolvedAt: null,
    schemaVersion: 1,
    state: "staged",
    subscriptionId: input.subscriptionId,
    updatedAt: timestamp,
    workspaceId: input.scope.workspaceId,
  });
  const value = await client.createOrRead(
    key(input.scope, "delivery", candidate.deliveryId),
    JSON.stringify(candidate),
  );
  const result = parse(deliverySchema, value, input.scope);
  if (
    result.alertId !== input.alert.alertId ||
    result.subscriptionId !== input.subscriptionId ||
    result.destinationDigest !== candidate.destinationDigest
  ) throw new WorkspaceAlertStoreError("alert_conflict");
  return result;
}

async function transitionWorkspaceAlertDelivery(
  input: {
    deliveryId: string;
    mutate: (current: WorkspaceAlertDelivery) => WorkspaceAlertDelivery;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceAlertStoreClient,
): Promise<WorkspaceAlertDelivery> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const recordKey = key(input.scope, "delivery", input.deliveryId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentRaw = serialized(await client.get(recordKey));
    if (!currentRaw) throw new WorkspaceAlertStoreError("alert_corrupt");
    const current = parse(deliverySchema, currentRaw, input.scope);
    const next = deliverySchema.parse(input.mutate(current));
    if (next.deliveryId !== current.deliveryId || next.alertId !== current.alertId) {
      throw new WorkspaceAlertStoreError("alert_conflict");
    }
    const nextRaw = JSON.stringify(next);
    if (nextRaw === currentRaw) return next;
    try {
      if (await client.compareAndSet(recordKey, currentRaw, nextRaw)) return next;
    } catch (error) {
      if (serialized(await client.get(recordKey)) === nextRaw) return next;
      throw error;
    }
  }
  throw new WorkspaceAlertStoreError("alert_conflict");
}

export async function beginWorkspaceAlertDelivery(
  input: { deliveryId: string; now?: Date; scope: AuthorizedWorkspaceStoreScope },
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlertDelivery> {
  return (await claimWorkspaceAlertDelivery(input, client)).delivery;
}

export async function claimWorkspaceAlertDelivery(
  input: { deliveryId: string; now?: Date; scope: AuthorizedWorkspaceStoreScope },
  client: WorkspaceAlertStoreClient = store(),
): Promise<{ claimed: boolean; delivery: WorkspaceAlertDelivery }> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const recordKey = key(input.scope, "delivery", input.deliveryId);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentRaw = serialized(await client.get(recordKey));
    if (!currentRaw) throw new WorkspaceAlertStoreError("alert_corrupt");
    const current = parse(deliverySchema, currentRaw, input.scope);
    if (current.state !== "staged" && current.state !== "retryable_failure") {
      return { claimed: false, delivery: current };
    }
    const next = deliverySchema.parse({
      ...current,
      attempt: current.attempt + 1,
      failureCode: null,
      state: "delivering",
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    const nextRaw = JSON.stringify(next);
    try {
      if (await client.compareAndSet(recordKey, currentRaw, nextRaw)) {
        return { claimed: true, delivery: next };
      }
    } catch (error) {
      if (serialized(await client.get(recordKey)) === nextRaw) {
        return { claimed: true, delivery: next };
      }
      throw error;
    }
  }
  throw new WorkspaceAlertStoreError("alert_conflict");
}

export async function finishWorkspaceAlertDelivery(
  input: {
    deliveryId: string;
    failureCode?: string;
    now?: Date;
    outcome: "delivered" | "delivery_uncertain" | "retryable_failure";
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlertDelivery> {
  return transitionWorkspaceAlertDelivery({
    deliveryId: input.deliveryId,
    scope: input.scope,
    mutate(current) {
      if (current.state !== "delivering") return current;
      return {
        ...current,
        failureCode: input.outcome === "delivered" ? null : (input.failureCode ?? "alert_delivery_failed"),
        state: input.outcome,
        updatedAt: (input.now ?? new Date()).toISOString(),
      };
    },
  }, client);
}

export async function resolveWorkspaceAlertDelivery(
  input: {
    deliveryId: string;
    now?: Date;
    resolutionCode: "abandoned" | "confirmed_delivered" | "confirmed_not_delivered";
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlertDelivery> {
  return transitionWorkspaceAlertDelivery({
    deliveryId: input.deliveryId,
    scope: input.scope,
    mutate(current) {
      if (current.state !== "delivery_uncertain") return current;
      const now = (input.now ?? new Date()).toISOString();
      return {
        ...current,
        resolutionCode: input.resolutionCode,
        resolvedAt: now,
        state: "resolved",
        updatedAt: now,
      };
    },
  }, client);
}

export async function readWorkspaceAlertDelivery(
  scope: AuthorizedWorkspaceStoreScope,
  deliveryId: string,
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlertDelivery | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "delivery", deliveryId));
  return value === null || value === undefined ? null : parse(deliverySchema, value, scope);
}

export async function readWorkspaceAlert(
  scope: AuthorizedWorkspaceStoreScope,
  findingId: string,
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlert | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const alertId = `alert_${digest(findingId)}`;
  const value = await client.get(key(scope, "alert", alertId));
  return value === null || value === undefined ? null : parse(alertSchema, value, scope);
}

export async function readWorkspaceAlertById(
  scope: AuthorizedWorkspaceStoreScope,
  alertId: string,
  client: WorkspaceAlertStoreClient = store(),
): Promise<WorkspaceAlert | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "alert", alertId));
  const alert = value === null || value === undefined
    ? null
    : parse(alertSchema, value, scope);
  if (alert && alert.alertId !== alertId) {
    throw new WorkspaceAlertStoreError("alert_conflict");
  }
  return alert;
}
