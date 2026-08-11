import { createHash, randomBytes } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

export const PHOTON_SESSION_GENERATION = 1;

const KEY_PREFIX = "eve:photon:v1:session:";
const LOCK_PREFIX = "eve:photon:v1:session-migration:";
const TTL_SECONDS = 30 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 120;

const bindingSchema = z.object({
  generation: z.number().int().positive(),
  sessionId: z.string().min(1).max(200).optional(),
  updatedAtMs: z.number().int().nonnegative(),
});

export interface PhotonSessionBinding {
  generation: number;
  sessionId?: string;
  updatedAtMs: number;
}

export interface PhotonSessionStoreClient {
  del(key: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(
    key: string,
    value: string,
    options: { ex: number; nx?: true },
  ): Promise<unknown>;
}

export type PhotonSessionMigrationReservation =
  | { migrationToken: string; status: "acquired" }
  | { status: "busy" }
  | { binding: PhotonSessionBinding; status: "current" };

let redisClient: Redis | undefined;
let redisStoreClient: PhotonSessionStoreClient | undefined;

function redis(): Redis {
  if (redisClient) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Photon session routing storage is not configured.");
  }
  redisClient = new Redis({
    automaticDeserialization: false,
    token,
    url,
  });
  return redisClient;
}

function store(): PhotonSessionStoreClient {
  if (redisStoreClient) return redisStoreClient;
  const client = redis();
  redisStoreClient = {
    del: (key) => client.del(key),
    get: (key) => client.get(key),
    set: (key, value, options) =>
      options.nx
        ? client.set(key, value, { ex: options.ex, nx: true })
        : client.set(key, value, { ex: options.ex }),
  };
  return redisStoreClient;
}

function routeHash(threadId: string, principalId: string): string {
  return createHash("sha256")
    .update(`photon-session\u0000${threadId}\u0000${principalId}`)
    .digest("hex");
}

function bindingKey(threadId: string, principalId: string): string {
  return `${KEY_PREFIX}${routeHash(threadId, principalId)}`;
}

function lockKey(threadId: string, principalId: string): string {
  return `${LOCK_PREFIX}${routeHash(threadId, principalId)}`;
}

function parseBinding(value: unknown): PhotonSessionBinding | null {
  if (typeof value !== "string") return null;
  try {
    return bindingSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function reservePhotonSessionMigration(
  input: {
    generation: number;
    principalId: string;
    threadId: string;
  },
  client: PhotonSessionStoreClient = store(),
): Promise<PhotonSessionMigrationReservation> {
  const current = parseBinding(
    await client.get(bindingKey(input.threadId, input.principalId)),
  );
  if (current?.generation === input.generation) {
    return { binding: current, status: "current" };
  }

  const migrationToken = randomBytes(16).toString("base64url");
  const reserved = await client.set(
    lockKey(input.threadId, input.principalId),
    migrationToken,
    {
      ex: LOCK_TTL_SECONDS,
      nx: true,
    },
  );
  return reserved === "OK"
    ? { migrationToken, status: "acquired" }
    : { status: "busy" };
}

export async function savePhotonSessionBinding(
  input: {
    generation: number;
    principalId: string;
    sessionId?: string;
    threadId: string;
  },
  client: PhotonSessionStoreClient = store(),
): Promise<void> {
  const key = bindingKey(input.threadId, input.principalId);
  const record = bindingSchema.parse({
    generation: input.generation,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    updatedAtMs: Date.now(),
  });
  await client.set(key, JSON.stringify(record), { ex: TTL_SECONDS });
}

export async function completePhotonSessionMigration(
  input: {
    generation: number;
    migrationToken: string;
    principalId: string;
    sessionId?: string;
    threadId: string;
  },
  client: PhotonSessionStoreClient = store(),
): Promise<boolean> {
  const currentToken = await client.get(
    lockKey(input.threadId, input.principalId),
  );
  if (currentToken !== input.migrationToken) return false;
  await savePhotonSessionBinding(input, client);
  return true;
}

export async function releasePhotonSessionMigration(
  input: {
    migrationToken: string;
    principalId: string;
    threadId: string;
  },
  client: PhotonSessionStoreClient = store(),
): Promise<void> {
  const key = lockKey(input.threadId, input.principalId);
  if ((await client.get(key)) === input.migrationToken) {
    await client.del(key);
  }
}
