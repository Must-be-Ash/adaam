import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import { webCorroborationSearchSchema } from "./public-commentary-schema";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:workspace-runtime:v1:public-commentary-attempt:";
const MAX_RECORD_BYTES = 32 * 1_024;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

export const publicCommentaryCorroborationAttemptSchema = z.object({
  attemptId: z.string().min(3).max(160),
  configurationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  corroboration: webCorroborationSearchSchema,
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  recordType: z.literal("public_commentary_corroboration_attempt"),
  schemaVersion: z.literal(1),
  statementRevisionId: z.string().min(1).max(200),
  workspaceId: z.string().uuid(),
}).strict();

export type PublicCommentaryCorroborationAttempt = z.infer<
  typeof publicCommentaryCorroborationAttemptSchema
>;

export const publicCommentaryOccurrenceQuarantineSchema = z.object({
  configurationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  observedStatements: z.number().int().nonnegative().max(10_000),
  occurrenceId: z.string().min(3).max(160),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  reason: z.enum(["facts_overflow", "statements_overflow", "summary_overflow"]),
  recordType: z.literal("public_commentary_occurrence_quarantine"),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

export type PublicCommentaryOccurrenceQuarantine = z.infer<
  typeof publicCommentaryOccurrenceQuarantineSchema
>;

/*
 * When an occurrence throws, the runtime only records an opaque terminal code
 * (`worker_recovery_not_applicable`, `worker_outcome_missing`) with no root
 * cause, and the real error rolls off the ~50-row Vercel log buffer within
 * minutes - so a failing monitor is undiagnosable without buying another
 * occurrence. This record makes the failure name itself: the exact error and
 * the stage it reached, durable and queryable read-only alongside the other
 * attempt records.
 */
export const publicCommentaryOccurrenceFailureSchema = z.object({
  configurationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.string().datetime({ offset: true }),
  errorMessage: z.string().min(1).max(4_000),
  errorName: z.string().min(1).max(200),
  failureId: z.string().min(3).max(160),
  monitorId: z.string().min(1).max(200),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("public_commentary_occurrence_failure"),
  schemaVersion: z.literal(1),
  stack: z.string().max(8_000).optional(),
  stage: z.enum(["pipeline", "research", "commit", "unknown"]),
  workspaceId: z.string().uuid(),
}).strict();

export type PublicCommentaryOccurrenceFailure = z.infer<
  typeof publicCommentaryOccurrenceFailureSchema
>;

export interface PublicCommentaryAttemptStoreClient {
  createOrRead(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

let redis: Redis | undefined;
let defaultClient: PublicCommentaryAttemptStoreClient | undefined;

function store(): PublicCommentaryAttemptStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Public commentary attempt storage is not configured.");
  redis ??= new Redis({ automaticDeserialization: false, token, url });
  let sha = redis.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async createOrRead(key, value) {
      try {
        return await redis!.evalsha<[string], string>(await sha, [key], [value]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        sha = redis!.scriptLoad(CAS_SCRIPT);
        return redis!.evalsha<[string], string>(await sha, [key], [value]);
      }
    },
    get: (key) => redis!.get(key),
  };
  return defaultClient;
}

function key(scope: AuthorizedWorkspaceStoreScope, attemptId: string): string {
  return `${KEY_PREFIX}${createHash("sha256")
    .update(`${scope.ownerId}\0${scope.workspaceId}\0${attemptId}`)
    .digest("hex")}`;
}

function parse(value: unknown, scope: AuthorizedWorkspaceStoreScope) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("public_commentary_attempt_corrupt");
  }
  const record = publicCommentaryCorroborationAttemptSchema.parse(JSON.parse(serialized));
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  return record;
}

export async function readPublicCommentaryCorroborationAttempt(
  scope: AuthorizedWorkspaceStoreScope,
  attemptId: string,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryCorroborationAttempt | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, attemptId));
  return value === null || value === undefined ? null : parse(value, scope);
}

export async function persistPublicCommentaryCorroborationAttempt(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: PublicCommentaryCorroborationAttempt,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryCorroborationAttempt> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const record = publicCommentaryCorroborationAttemptSchema.parse(candidate);
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("public_commentary_attempt_corrupt");
  }
  const persisted = parse(await client.createOrRead(key(scope, record.attemptId), serialized), scope);
  if (JSON.stringify(persisted) !== serialized) throw new Error("public_commentary_attempt_conflict");
  return persisted;
}

export async function persistPublicCommentaryOccurrenceQuarantine(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: PublicCommentaryOccurrenceQuarantine,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryOccurrenceQuarantine> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const record = publicCommentaryOccurrenceQuarantineSchema.parse(candidate);
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  const serialized = JSON.stringify(record);
  const value = await client.createOrRead(key(scope, record.occurrenceId), serialized);
  const persisted = publicCommentaryOccurrenceQuarantineSchema.parse(
    JSON.parse(typeof value === "string" ? value : JSON.stringify(value)),
  );
  if (JSON.stringify(persisted) !== serialized) throw new Error("public_commentary_attempt_conflict");
  return persisted;
}

export async function persistPublicCommentaryOccurrenceFailure(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: PublicCommentaryOccurrenceFailure,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryOccurrenceFailure> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const record = publicCommentaryOccurrenceFailureSchema.parse(candidate);
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("public_commentary_attempt_corrupt");
  }
  // First-failure-wins: a retry of the same occurrence keeps the original root
  // cause rather than overwriting it with a downstream recovery error. The
  // write is idempotent, so a returned prior record is a success, not a
  // conflict.
  const value = await client.createOrRead(key(scope, record.failureId), serialized);
  const persisted = publicCommentaryOccurrenceFailureSchema.parse(
    JSON.parse(typeof value === "string" ? value : JSON.stringify(value)),
  );
  if (persisted.ownerId !== scope.ownerId || persisted.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  return persisted;
}

export async function readPublicCommentaryOccurrenceFailure(
  scope: AuthorizedWorkspaceStoreScope,
  failureId: string,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryOccurrenceFailure | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, failureId));
  if (value === null || value === undefined) return null;
  const record = publicCommentaryOccurrenceFailureSchema.parse(
    JSON.parse(typeof value === "string" ? value : JSON.stringify(value)),
  );
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  return record;
}

export async function readPublicCommentaryOccurrenceQuarantine(
  scope: AuthorizedWorkspaceStoreScope,
  occurrenceId: string,
  client: PublicCommentaryAttemptStoreClient = store(),
): Promise<PublicCommentaryOccurrenceQuarantine | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, occurrenceId));
  if (value === null || value === undefined) return null;
  const record = publicCommentaryOccurrenceQuarantineSchema.parse(
    JSON.parse(typeof value === "string" ? value : JSON.stringify(value)),
  );
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_attempt_scope_mismatch");
  }
  return record;
}
