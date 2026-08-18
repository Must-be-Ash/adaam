import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  commentaryCorrectionSchema,
  commentaryExtractionSchema,
  commentaryFindingSchema,
  commentaryInterpretationSchema,
  publicStatementSchema,
  webCorroborationSearchSchema,
} from "./public-commentary-schema";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:workspace-runtime:v1:public-commentary:";
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
const timestampSchema = z.string().datetime({ offset: true });

export const publicCommentaryFindingRecordSchema = z.object({
  correction: commentaryCorrectionSchema.nullable(),
  corroboration: webCorroborationSearchSchema,
  createdAt: timestampSchema,
  directionDisclosure: z.string().trim().min(1).max(500),
  extraction: commentaryExtractionSchema,
  finding: commentaryFindingSchema,
  interpretation: commentaryInterpretationSchema,
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  rawContentIncluded: z.literal(false),
  recordType: z.literal("public_commentary_finding_record"),
  schemaVersion: z.literal(1),
  statement: publicStatementSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  if (
    record.finding.interpretationId !== record.interpretation.interpretationId ||
    record.statement.contentReference === null
  ) context.addIssue({ code: "custom", message: "public_commentary_record_invalid" });
});

export type PublicCommentaryFindingRecord = z.infer<typeof publicCommentaryFindingRecordSchema>;

export interface PublicCommentaryFindingStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

let redis: Redis | undefined;
let defaultClient: PublicCommentaryFindingStoreClient | undefined;

function store(): PublicCommentaryFindingStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Public commentary storage is not configured.");
  redis ??= new Redis({ automaticDeserialization: false, token, url });
  let sha = redis.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      try {
        return (await redis!.evalsha<[string, string], number>(
          await sha,
          [key],
          [expected ?? "", next],
        )) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        sha = redis!.scriptLoad(CAS_SCRIPT);
        return (await redis!.evalsha<[string, string], number>(
          await sha,
          [key],
          [expected ?? "", next],
        )) === 1;
      }
    },
    get: (key) => redis!.get(key),
  };
  return defaultClient;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function key(scope: AuthorizedWorkspaceStoreScope, kind: string, id: string): string {
  return `${KEY_PREFIX}${digest(`${scope.ownerId}\0${scope.workspaceId}\0${kind}\0${id}`)}`;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse(value: unknown, scope: AuthorizedWorkspaceStoreScope): PublicCommentaryFindingRecord {
  const serialized = raw(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 128 * 1_024) {
    throw new Error("public_commentary_finding_corrupt");
  }
  const record = publicCommentaryFindingRecordSchema.parse(JSON.parse(serialized));
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_finding_scope_mismatch");
  }
  return record;
}

export async function persistPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: PublicCommentaryFindingRecord,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const record = publicCommentaryFindingRecordSchema.parse(candidate);
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("public_commentary_finding_scope_mismatch");
  }
  const serialized = JSON.stringify(record);
  const recordKey = key(scope, "finding", record.finding.findingId);
  if (!(await client.compareAndSet(recordKey, null, serialized))) {
    const existing = parse(await client.get(recordKey), scope);
    if (JSON.stringify(existing) !== serialized) throw new Error("public_commentary_finding_conflict");
    return existing;
  }
  const latestKey = key(scope, "latest", "current");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = raw(await client.get(latestKey));
    if (await client.compareAndSet(latestKey, current, serialized)) return record;
  }
  throw new Error("public_commentary_latest_conflict");
}

export async function readPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  findingId: string,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "finding", findingId));
  return value === null || value === undefined ? null : parse(value, scope);
}

export async function readLatestPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "latest", "current"));
  return value === null || value === undefined ? null : parse(value, scope);
}
