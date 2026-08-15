import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

const KEY_PREFIX = "eve:photon:v1:alert-reply:";
const RETENTION_SECONDS = 15 * 60;
const MAX_CAS_ATTEMPTS = 5;
const CREATE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
return ARGV[1]
`;
const CAS_SCRIPT = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`;

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const candidateSchema = z.object({
  alertId: idSchema,
  deliveredAt: z.string().datetime({ offset: true }),
  deliveryMessageId: idSchema.optional(),
  title: z.string().min(1).max(240),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1).max(80),
}).strict();
const heldSchema = z.object({
  assignedWorkspaceId: z.string().uuid().optional(),
  candidateAlertId: idSchema,
  candidateWorkspaceId: z.string().uuid(),
  candidateWorkspaceName: z.string().min(1).max(80),
  conversationId: idSchema,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  ingressId: idSchema,
  messageText: z.string().min(1).max(4_000),
  ownerId: idSchema,
  recordType: z.literal("routing_decision"),
  revision: z.literal(1),
  routingRevision: z.number().int().nonnegative(),
  selectedWorkspaceId: z.string().uuid(),
  selectedWorkspaceName: z.string().min(1).max(80),
  state: z.enum(["assigned", "expired", "held"]),
}).strict();

export type PhotonRecentAlertCandidate = z.infer<typeof candidateSchema>;
export type PhotonHeldAlertReply = z.infer<typeof heldSchema>;

export interface PhotonAlertReplyStoreClient {
  compareAndSet(key: string, expected: string, next: string, ttlSeconds: number): Promise<boolean>;
  createOrRead(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
}

let redisClient: Redis | undefined;
let defaultClient: PhotonAlertReplyStoreClient | undefined;
function store(): PhotonAlertReplyStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Photon alert-reply storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let createSha = redisClient.scriptLoad(CREATE_SCRIPT);
  let casSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next, ttlSeconds) {
      try {
        return (await redisClient!.evalsha<[string, string, number], number>(await casSha, [key], [expected, next, ttlSeconds])) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        casSha = redisClient!.scriptLoad(CAS_SCRIPT);
        return (await redisClient!.evalsha<[string, string, number], number>(await casSha, [key], [expected, next, ttlSeconds])) === 1;
      }
    },
    async createOrRead(key, value, ttlSeconds) {
      try {
        return await redisClient!.evalsha<[string, number], string>(await createSha, [key], [value, ttlSeconds]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        createSha = redisClient!.scriptLoad(CREATE_SCRIPT);
        return redisClient!.evalsha<[string, number], string>(await createSha, [key], [value, ttlSeconds]);
      }
    },
    get: (key) => redisClient!.get(key),
    set: (key, value, ttlSeconds) => redisClient!.set(key, value, { ex: ttlSeconds }),
  };
  return defaultClient;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function key(kind: string, id: string): string {
  return `${KEY_PREFIX}${kind}:${digest(id)}`;
}
function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}
function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function titleTerms(title: string): string[] {
  return normalize(title).split(" ").filter((term) => term.length >= 5).slice(0, 8);
}

export function classifyPhotonAlertReply(input: {
  candidates: readonly PhotonRecentAlertCandidate[];
  messageText: string;
  quotedMessageId?: string;
  selectedWorkspaceId: string;
}): PhotonRecentAlertCandidate | null {
  const normalizedMessage = normalize(input.messageText);
  const matches = input.candidates.filter((candidate) => {
    if (candidate.workspaceId === input.selectedWorkspaceId) return false;
    if (input.quotedMessageId && candidate.deliveryMessageId === input.quotedMessageId) return true;
    const workspace = normalize(candidate.workspaceName);
    return workspace.length >= 4 && normalizedMessage.includes(workspace) &&
      titleTerms(candidate.title).some((term) => normalizedMessage.includes(term));
  });
  return matches.length === 1 ? matches[0]! : null;
}

export function parsePhotonHeldReplyChoice(
  messageText: string,
  held: PhotonHeldAlertReply,
): "candidate" | "selected" | null {
  const value = normalize(messageText);
  const candidate = normalize(held.candidateWorkspaceName);
  const selected = normalize(held.selectedWorkspaceName);
  if (value === `use ${candidate}` || value === `switch to ${candidate}`) return "candidate";
  if (value === `stay in ${selected}` || value === `keep ${selected}`) return "selected";
  return null;
}

export async function recordRecentPhotonAlert(
  input: { candidate: PhotonRecentAlertCandidate; conversationId: string },
  client: PhotonAlertReplyStoreClient = store(),
): Promise<void> {
  const recordKey = key("recent", input.conversationId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = raw(await client.get(recordKey));
    const current = currentRaw
      ? z.array(candidateSchema).max(8).parse(JSON.parse(currentRaw))
      : [];
    const next = [
      input.candidate,
      ...current.filter((candidate) => candidate.alertId !== input.candidate.alertId),
    ].slice(0, 8);
    const nextRaw = JSON.stringify(z.array(candidateSchema).max(8).parse(next));
    if (currentRaw === null) {
      const observed = raw(await client.createOrRead(recordKey, nextRaw, RETENTION_SECONDS));
      if (observed === nextRaw) return;
    } else if (await client.compareAndSet(recordKey, currentRaw, nextRaw, RETENTION_SECONDS)) {
      return;
    }
  }
  throw new Error("photon_alert_candidate_conflict");
}

export async function readRecentPhotonAlerts(
  conversationId: string,
  client: PhotonAlertReplyStoreClient = store(),
): Promise<PhotonRecentAlertCandidate[]> {
  const value = raw(await client.get(key("recent", conversationId)));
  return value ? z.array(candidateSchema).max(8).parse(JSON.parse(value)) : [];
}

export async function holdPhotonAlertReply(
  input: Omit<PhotonHeldAlertReply, "createdAt" | "expiresAt" | "recordType" | "revision" | "state"> & { now?: Date },
  client: PhotonAlertReplyStoreClient = store(),
): Promise<PhotonHeldAlertReply> {
  const now = input.now ?? new Date();
  const candidate = heldSchema.parse({
    ...input,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_SECONDS * 1_000).toISOString(),
    recordType: "routing_decision",
    revision: 1,
    state: "held",
  });
  const value = await client.createOrRead(key("held", input.ingressId), JSON.stringify(candidate), RETENTION_SECONDS);
  const result = heldSchema.parse(JSON.parse(raw(value) ?? "null"));
  if (result.ingressId !== input.ingressId || result.candidateAlertId !== input.candidateAlertId) {
    throw new Error("photon_held_reply_conflict");
  }
  await client.set(key("active", input.conversationId), input.ingressId, RETENTION_SECONDS);
  return result;
}

export async function readActivePhotonHeldReply(
  conversationId: string,
  client: PhotonAlertReplyStoreClient = store(),
): Promise<PhotonHeldAlertReply | null> {
  const ingressId = raw(await client.get(key("active", conversationId)));
  if (!ingressId) return null;
  const value = raw(await client.get(key("held", ingressId)));
  if (!value) return null;
  const held = heldSchema.parse(JSON.parse(value));
  return held.state === "held" && Date.parse(held.expiresAt) > Date.now() ? held : null;
}

export async function claimPhotonHeldAlertReply(
  input: { choice: "candidate" | "selected"; ingressId: string },
  client: PhotonAlertReplyStoreClient = store(),
): Promise<PhotonHeldAlertReply | null> {
  const recordKey = key("held", input.ingressId);
  const currentRaw = raw(await client.get(recordKey));
  if (!currentRaw) return null;
  const current = heldSchema.parse(JSON.parse(currentRaw));
  if (current.state !== "held" || Date.parse(current.expiresAt) <= Date.now()) return null;
  const next = heldSchema.parse({
    ...current,
    assignedWorkspaceId: input.choice === "candidate"
      ? current.candidateWorkspaceId
      : current.selectedWorkspaceId,
    state: "assigned",
  });
  return await client.compareAndSet(recordKey, currentRaw, JSON.stringify(next), RETENTION_SECONDS)
    ? next
    : null;
}
