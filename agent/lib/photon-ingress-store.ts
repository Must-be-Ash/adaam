import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

const KEY_PREFIX = "eve:photon:v1:ingress-control:";
const RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_RECORD_BYTES = 32 * 1_024;
const CREATE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return {0, current} end
redis.call("SET", KEYS[1], ARGV[1])
return {1, ARGV[1]}
`;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().regex(/^[a-z][a-z0-9_:-]{2,159}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const ingressSchema = z.object({
  classification: z.enum(["approval_reply", "held_alert_reply", "ordinary", "session_management"]),
  conversationId: idSchema,
  eventDedupeDigest: digestSchema,
  ingressId: idSchema,
  ownerId: idSchema,
  receivedAt: timestampSchema,
  recordType: z.literal("photon_ingress"),
  retentionExpiresAt: timestampSchema,
  schemaVersion: z.literal(1),
}).strict();
const assignmentSchema = z.object({
  assignedAt: timestampSchema,
  assignmentId: idSchema,
  generation: z.number().int().positive(),
  immutable: z.literal(true),
  ingressId: idSchema,
  ownerId: idSchema,
  reason: z.enum(["confirmed_held_reply", "discuss_action", "selected_workspace"]),
  recordType: z.literal("workspace_assignment"),
  routingRevision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();
const dispatchSchema = z.object({
  assignmentId: idSchema,
  attempt: z.literal(1),
  continuationTargetDigest: digestSchema,
  createdAt: timestampSchema,
  dispatchRequestId: idSchema,
  failureCode: z.string().max(64).nullable(),
  ingressId: idSchema,
  quarantineReason: z.string().max(64).nullable(),
  recordType: z.literal("photon_dispatch"),
  schemaVersion: z.literal(1),
  sessionIdDigest: digestSchema.nullable(),
  state: z.enum(["completed", "dispatched", "dispatching", "quarantined", "uncertain"]),
  updatedAt: timestampSchema,
}).strict();
const completionSchema = z.object({
  completedAt: timestampSchema,
  completionId: idSchema,
  dispatchRequestId: idSchema,
  ingressId: idSchema,
  outcome: z.enum(["cancelled", "completed", "failed"]),
  recordType: z.literal("photon_completion"),
  schemaVersion: z.literal(1),
}).strict();
const responseDeliverySchema = z.object({
  attempt: z.literal(1),
  contentDigest: digestSchema,
  createdAt: timestampSchema,
  deliveryId: idSchema,
  destinationDigest: digestSchema,
  failureCode: z.string().max(64).nullable(),
  ingressId: idSchema,
  recordType: z.literal("photon_response_delivery"),
  schemaVersion: z.literal(1),
  state: z.enum(["delivered", "delivering", "delivery_uncertain", "staged"]),
  updatedAt: timestampSchema,
}).strict();

export type PhotonIngressReceipt = z.infer<typeof ingressSchema>;
export type PhotonWorkspaceAssignmentReceipt = z.infer<typeof assignmentSchema>;
export type PhotonDispatchReceipt = z.infer<typeof dispatchSchema>;
export type PhotonCompletionReceipt = z.infer<typeof completionSchema>;
export type PhotonResponseDeliveryReceipt = z.infer<typeof responseDeliverySchema>;

export interface PhotonIngressStoreClient {
  compareAndSet(key: string, expected: string, next: string): Promise<boolean>;
  createOrRead(key: string, value: string): Promise<{
    created: boolean;
    value: unknown;
  }>;
  get(key: string): Promise<unknown>;
}

export class PhotonIngressStoreError extends Error {
  readonly code:
    | "photon_assignment_immutable"
    | "photon_receipt_conflict"
    | "photon_receipt_corrupt";

  constructor(code: PhotonIngressStoreError["code"]) {
    super(code);
    this.code = code;
    this.name = "PhotonIngressStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: PhotonIngressStoreClient | undefined;

function store(): PhotonIngressStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Photon ingress storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let createSha = redisClient.scriptLoad(CREATE_SCRIPT);
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
        const result = await redisClient!.evalsha<[string], [number, string]>(await createSha, [key], [value]);
        return { created: result[0] === 1, value: result[1] };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        createSha = redisClient!.scriptLoad(CREATE_SCRIPT);
        const result = await redisClient!.evalsha<[string], [number, string]>(await createSha, [key], [value]);
        return { created: result[0] === 1, value: result[1] };
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(kind: string, ingressId: string): string {
  return `${KEY_PREFIX}${kind}:${digest(ingressId)}`;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const serialized = raw(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new PhotonIngressStoreError("photon_receipt_corrupt");
  }
  const result = schema.safeParse(JSON.parse(serialized));
  if (!result.success) throw new PhotonIngressStoreError("photon_receipt_corrupt");
  return result.data;
}

async function create<T>(
  recordKey: string,
  schema: z.ZodType<T>,
  candidate: T,
  client: PhotonIngressStoreClient,
): Promise<{ created: boolean; record: T }> {
  const next = JSON.stringify(schema.parse(candidate));
  const created = await client.createOrRead(recordKey, next);
  const stored = raw(created.value);
  const record = parse(schema, stored);
  return { created: created.created, record };
}

export async function createPhotonIngressReceipt(input: {
  classification: PhotonIngressReceipt["classification"];
  conversationId: string;
  eventId: string;
  now?: Date;
  ownerId: string;
}, client: PhotonIngressStoreClient = store()): Promise<{
  created: boolean;
  record: PhotonIngressReceipt;
}> {
  const now = input.now ?? new Date();
  const eventDedupeDigest = digest(`photon-event\0${input.eventId}`);
  const ingressId = `ingress_${eventDedupeDigest}`;
  const result = await create(key("ingress", ingressId), ingressSchema, {
    classification: input.classification,
    conversationId: input.conversationId,
    eventDedupeDigest,
    ingressId,
    ownerId: input.ownerId,
    receivedAt: now.toISOString(),
    recordType: "photon_ingress",
    retentionExpiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
    schemaVersion: 1,
  } as const, client);
  if (
    result.record.ownerId !== input.ownerId ||
    result.record.conversationId !== input.conversationId ||
    result.record.classification !== input.classification
  ) throw new PhotonIngressStoreError("photon_receipt_conflict");
  return result;
}

export async function assignPhotonIngress(input: {
  generation: number;
  ingress: PhotonIngressReceipt;
  now?: Date;
  reason: PhotonWorkspaceAssignmentReceipt["reason"];
  routingRevision: number;
  workspaceId: string;
}, client: PhotonIngressStoreClient = store()): Promise<PhotonWorkspaceAssignmentReceipt> {
  const assignmentId = `assignment_${digest(input.ingress.ingressId)}`;
  const result = await create(key("assignment", input.ingress.ingressId), assignmentSchema, {
    assignedAt: (input.now ?? new Date()).toISOString(),
    assignmentId,
    generation: input.generation,
    immutable: true,
    ingressId: input.ingress.ingressId,
    ownerId: input.ingress.ownerId,
    reason: input.reason,
    recordType: "workspace_assignment",
    routingRevision: input.routingRevision,
    schemaVersion: 1,
    workspaceId: input.workspaceId,
  } as const, client);
  if (
    result.record.workspaceId !== input.workspaceId ||
    result.record.generation !== input.generation ||
    result.record.routingRevision !== input.routingRevision
  ) throw new PhotonIngressStoreError("photon_assignment_immutable");
  return result.record;
}

export async function createPhotonDispatchReceipt(input: {
  assignment: PhotonWorkspaceAssignmentReceipt;
  continuationTarget: string;
  now?: Date;
}, client: PhotonIngressStoreClient = store()) {
  const dispatchRequestId = `dispatch_${digest(input.assignment.ingressId)}`;
  return create(key("dispatch", input.assignment.ingressId), dispatchSchema, {
    assignmentId: input.assignment.assignmentId,
    attempt: 1,
    continuationTargetDigest: digest(input.continuationTarget),
    createdAt: (input.now ?? new Date()).toISOString(),
    dispatchRequestId,
    failureCode: null,
    ingressId: input.assignment.ingressId,
    quarantineReason: null,
    recordType: "photon_dispatch",
    schemaVersion: 1,
    sessionIdDigest: null,
    state: "dispatching",
    updatedAt: (input.now ?? new Date()).toISOString(),
  }, client);
}

async function transitionDispatch(
  ingressId: string,
  mutate: (record: PhotonDispatchReceipt) => PhotonDispatchReceipt,
  client: PhotonIngressStoreClient,
): Promise<PhotonDispatchReceipt> {
  const recordKey = key("dispatch", ingressId);
  const currentRaw = raw(await client.get(recordKey));
  if (!currentRaw) throw new PhotonIngressStoreError("photon_receipt_conflict");
  const current = parse(dispatchSchema, currentRaw);
  const next = dispatchSchema.parse(mutate(current));
  if (!(await client.compareAndSet(recordKey, currentRaw, JSON.stringify(next)))) {
    throw new PhotonIngressStoreError("photon_receipt_conflict");
  }
  return next;
}

export function markPhotonDispatchAccepted(input: {
  ingressId: string;
  now?: Date;
  sessionId: string;
}, client: PhotonIngressStoreClient = store()) {
  return transitionDispatch(input.ingressId, (record) => ({
    ...record,
    sessionIdDigest: digest(input.sessionId),
    state: "dispatched",
    updatedAt: (input.now ?? new Date()).toISOString(),
  }), client);
}

export async function createPhotonCompletionReceipt(input: {
  dispatch: PhotonDispatchReceipt;
  now?: Date;
  outcome: PhotonCompletionReceipt["outcome"];
}, client: PhotonIngressStoreClient = store()): Promise<PhotonCompletionReceipt> {
  const completion = (await create(key("completion", input.dispatch.ingressId), completionSchema, {
    completedAt: (input.now ?? new Date()).toISOString(),
    completionId: `completion_${digest(input.dispatch.ingressId)}`,
    dispatchRequestId: input.dispatch.dispatchRequestId,
    ingressId: input.dispatch.ingressId,
    outcome: input.outcome,
    recordType: "photon_completion",
    schemaVersion: 1,
  } as const, client)).record;
  if (completion.outcome !== input.outcome) {
    throw new PhotonIngressStoreError("photon_receipt_conflict");
  }
  if (input.dispatch.state === "dispatched") {
    await transitionDispatch(input.dispatch.ingressId, (record) => ({
      ...record,
      state: "completed",
      updatedAt: (input.now ?? new Date()).toISOString(),
    }), client);
  }
  return completion;
}

export async function createPhotonResponseDeliveryReceipt(input: {
  content: string;
  destination: string;
  ingressId: string;
  now?: Date;
}, client: PhotonIngressStoreClient = store()) {
  const contentDigest = digest(input.content);
  const result = await create(key("response", input.ingressId), responseDeliverySchema, {
    attempt: 1,
    contentDigest,
    createdAt: (input.now ?? new Date()).toISOString(),
    deliveryId: `response_${digest(input.ingressId)}`,
    destinationDigest: digest(input.destination),
    failureCode: null,
    ingressId: input.ingressId,
    recordType: "photon_response_delivery",
    schemaVersion: 1,
    state: "staged",
    updatedAt: (input.now ?? new Date()).toISOString(),
  }, client);
  if (
    result.record.contentDigest !== contentDigest ||
    result.record.destinationDigest !== digest(input.destination)
  ) throw new PhotonIngressStoreError("photon_receipt_conflict");
  return result;
}

export async function markPhotonResponseDelivery(input: {
  failureCode?: string;
  ingressId: string;
  now?: Date;
  state: "delivered" | "delivering" | "delivery_uncertain";
}, client: PhotonIngressStoreClient = store()): Promise<PhotonResponseDeliveryReceipt> {
  const recordKey = key("response", input.ingressId);
  const currentRaw = raw(await client.get(recordKey));
  if (!currentRaw) throw new PhotonIngressStoreError("photon_receipt_conflict");
  const current = parse(responseDeliverySchema, currentRaw);
  const next = responseDeliverySchema.parse({
    ...current,
    failureCode: input.failureCode ?? null,
    state: input.state,
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
  if (!(await client.compareAndSet(recordKey, currentRaw, JSON.stringify(next)))) {
    throw new PhotonIngressStoreError("photon_receipt_conflict");
  }
  return next;
}

export async function readPhotonDispatchReceipt(
  ingressId: string,
  client: PhotonIngressStoreClient = store(),
): Promise<PhotonDispatchReceipt | null> {
  const value = await client.get(key("dispatch", ingressId));
  return value === null || value === undefined ? null : parse(dispatchSchema, value);
}

export function photonIngressAuthAttributes(receipt: PhotonIngressReceipt) {
  return Object.freeze({ photon_ingress_id: receipt.ingressId });
}

export function photonIngressIdFromAuth(
  auth: { readonly attributes: Readonly<Record<string, string | readonly string[]>> } | null | undefined,
): string | null {
  const value = auth?.attributes.photon_ingress_id;
  return typeof value === "string" && /^ingress_[a-f0-9]{64}$/u.test(value)
    ? value
    : null;
}
