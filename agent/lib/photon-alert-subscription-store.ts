import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  resolvePhotonOwnerConversationIdentity,
  resolvePhotonPrincipalByAlias,
} from "./owner-identity";
import type { PhotonAlertDeliverySubscription } from "./photon-alert-delivery";

const KEY_PREFIX = "eve:workspace-runtime:v1:photon-alert-subscription:";
const conversationIdSchema = z.string().regex(/^conversation_[a-f0-9]{64}$/u);
const ownerIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u);
const recordSchema = z.object({
  conversationId: conversationIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  ownerId: ownerIdSchema,
  principalAlias: z.string().regex(/^[a-f0-9]{64}$/u),
  recordType: z.literal("photon_alert_delivery_subscription"),
  schemaVersion: z.literal(1),
  subscriptionId: conversationIdSchema,
  threadId: z.string().min(1).max(500),
}).strict();

type PhotonAlertDeliverySubscriptionRecord = z.infer<typeof recordSchema>;

export interface PhotonAlertDeliverySubscriptionStoreClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export class PhotonAlertDeliverySubscriptionError extends Error {
  readonly code = "photon_alert_subscription_unavailable";

  constructor() {
    super("photon_alert_subscription_unavailable");
    this.name = "PhotonAlertDeliverySubscriptionError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: PhotonAlertDeliverySubscriptionStoreClient | undefined;

function store(): PhotonAlertDeliverySubscriptionStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  defaultClient = {
    get: (key) => redisClient!.get(key),
    set: (key, value) => redisClient!.set(key, value),
  };
  return defaultClient;
}

function key(ownerId: string, subscriptionId: string): string {
  return `${KEY_PREFIX}${createHash("sha256")
    .update(`${ownerId}\0${subscriptionId}`)
    .digest("hex")}`;
}

function serialized(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse(value: unknown): PhotonAlertDeliverySubscriptionRecord {
  const raw = serialized(value);
  if (!raw || Buffer.byteLength(raw, "utf8") > 4_096) {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  try {
    return recordSchema.parse(JSON.parse(raw));
  } catch {
    throw new PhotonAlertDeliverySubscriptionError();
  }
}

export async function savePhotonAlertDeliverySubscription(
  input: {
    conversationId: string;
    now?: Date;
    ownerId: string;
    principalId: string;
    subscriptionId: string;
    threadId: string;
  },
  client: PhotonAlertDeliverySubscriptionStoreClient = store(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const identity = resolvePhotonOwnerConversationIdentity(
    { principalId: input.principalId, threadId: input.threadId },
    environment,
  );
  if (
    identity.ownerId !== input.ownerId ||
    identity.conversationId !== input.conversationId ||
    input.subscriptionId !== input.conversationId
  ) {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  const record = recordSchema.parse({
    conversationId: input.conversationId,
    createdAt: (input.now ?? new Date()).toISOString(),
    ownerId: input.ownerId,
    principalAlias: identity.principalAlias,
    recordType: "photon_alert_delivery_subscription",
    schemaVersion: 1,
    subscriptionId: input.subscriptionId,
    threadId: input.threadId,
  });
  const recordKey = key(input.ownerId, input.subscriptionId);
  const currentRaw = await client.get(recordKey);
  if (currentRaw !== null && currentRaw !== undefined) {
    const current = parse(currentRaw);
    if (
      current.ownerId !== record.ownerId ||
      current.conversationId !== record.conversationId ||
      current.subscriptionId !== record.subscriptionId ||
      current.principalAlias !== record.principalAlias ||
      current.threadId !== record.threadId
    ) {
      throw new PhotonAlertDeliverySubscriptionError();
    }
    return;
  }
  await client.set(recordKey, JSON.stringify(record));
}

export async function readPhotonAlertDeliverySubscription(
  input: { ownerId: string; subscriptionId: string },
  client: PhotonAlertDeliverySubscriptionStoreClient = store(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PhotonAlertDeliverySubscription> {
  const parsedInput = z.object({
    ownerId: ownerIdSchema,
    subscriptionId: conversationIdSchema,
  }).safeParse(input);
  if (!parsedInput.success) throw new PhotonAlertDeliverySubscriptionError();
  const record = parse(await client.get(key(input.ownerId, input.subscriptionId)));
  if (
    record.ownerId !== input.ownerId ||
    record.subscriptionId !== input.subscriptionId
  ) {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  let principalId: string;
  try {
    principalId = resolvePhotonPrincipalByAlias(
      { ownerId: record.ownerId, principalAlias: record.principalAlias },
      environment,
    );
  } catch {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  const identity = resolvePhotonOwnerConversationIdentity(
    { principalId, threadId: record.threadId },
    environment,
  );
  if (identity.conversationId !== record.conversationId) {
    throw new PhotonAlertDeliverySubscriptionError();
  }
  return Object.freeze({
    conversationId: record.conversationId,
    destination: record.threadId,
    ownerId: record.ownerId,
    principalId,
    subscriptionId: record.subscriptionId,
    threadId: record.threadId,
  });
}
