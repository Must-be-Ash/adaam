import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  earningsFindingSchema,
  type EarningsFinding,
} from "./earnings-call-schema";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:earnings-call-changes:v1:";
const MAX_RECORD_BYTES = 96 * 1_024;
const CREATE_OR_READ_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return {0, current} end
redis.call("SET", KEYS[1], ARGV[1])
return {1, ARGV[1]}
`;
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
const sourceSchema = z.object({
  canonicalUrl: z.string().url().max(2_048),
  eventRevisionId: z.string().min(3).max(200),
  fiscalPeriod: z.string().regex(/^FY\d{4}-Q[1-4]$/u),
  role: z.enum(["current", "prior", "year_ago"]),
}).strict();

export const earningsCallFindingRecordSchema = z.object({
  cik: z.string().regex(/^\d{10}$/u),
  companyName: z.string().trim().min(1).max(200),
  createdAt: timestampSchema,
  finding: earningsFindingSchema,
  recordType: z.literal("earnings_call_finding_record"),
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema).min(2).max(3),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u),
}).strict().superRefine((record, context) => {
  if (
    record.finding.workspaceId.length === 0 ||
    record.sources.filter(({ role }) => role === "current").length !== 1 ||
    record.sources.filter(({ role }) => role === "prior").length !== 1
  ) context.addIssue({ code: "custom", message: "earnings_finding_record_invalid" });
});

export type EarningsCallFindingRecord = z.infer<typeof earningsCallFindingRecordSchema>;

export interface EarningsCallFindingStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  createOrRead(key: string, value: string): Promise<{ readonly created: boolean; readonly value: unknown }>;
  get(key: string): Promise<unknown>;
}

export class EarningsCallFindingStoreError extends Error {
  constructor(readonly code: "earnings_finding_conflict" | "earnings_finding_corrupt") {
    super(code);
    this.name = "EarningsCallFindingStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: EarningsCallFindingStoreClient | undefined;

function store(): EarningsCallFindingStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Earnings-call finding storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let createSha = redisClient.scriptLoad(CREATE_OR_READ_SCRIPT);
  let casSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      const run = (sha: string) => redisClient!.evalsha<[string, string], number>(
        sha,
        [key],
        [expected ?? "", next],
      );
      try {
        return (await run(await casSha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        casSha = redisClient!.scriptLoad(CAS_SCRIPT);
        return (await run(await casSha)) === 1;
      }
    },
    async createOrRead(key, value) {
      const run = (sha: string) => redisClient!.evalsha<[string], [number, unknown]>(sha, [key], [value]);
      let result: [number, unknown];
      try {
        result = await run(await createSha);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        createSha = redisClient!.scriptLoad(CREATE_OR_READ_SCRIPT);
        result = await run(await createSha);
      }
      return { created: result[0] === 1, value: result[1] };
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const valueRaw = JSON.stringify(value);
  if (Buffer.byteLength(valueRaw, "utf8") > MAX_RECORD_BYTES) {
    throw new EarningsCallFindingStoreError("earnings_finding_corrupt");
  }
  return valueRaw;
}

function parse(value: unknown): EarningsCallFindingRecord {
  const valueRaw = raw(value);
  if (!valueRaw || Buffer.byteLength(valueRaw, "utf8") > MAX_RECORD_BYTES) {
    throw new EarningsCallFindingStoreError("earnings_finding_corrupt");
  }
  const result = earningsCallFindingRecordSchema.safeParse(JSON.parse(valueRaw));
  if (!result.success) throw new EarningsCallFindingStoreError("earnings_finding_corrupt");
  return result.data;
}

function key(scope: AuthorizedWorkspaceStoreScope, kind: string, id: string): string {
  const digest = createHash("sha256")
    .update(`${scope.ownerId}\0${scope.workspaceId}\0${kind}\0${id}`)
    .digest("hex");
  return `${KEY_PREFIX}${kind}:${digest}`;
}

function assertScope(scope: AuthorizedWorkspaceStoreScope, finding: EarningsFinding): void {
  if (finding.ownerId !== scope.ownerId || finding.workspaceId !== scope.workspaceId) {
    throw new EarningsCallFindingStoreError("earnings_finding_conflict");
  }
}

export async function persistEarningsCallFinding(
  input: { readonly record: EarningsCallFindingRecord; readonly scope: AuthorizedWorkspaceStoreScope },
  client: EarningsCallFindingStoreClient = store(),
): Promise<"created" | "reused"> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const record = earningsCallFindingRecordSchema.parse(input.record);
  assertScope(input.scope, record.finding);
  const recordRaw = serialize(record);
  const stored = await client.createOrRead(
    key(input.scope, "finding", record.finding.findingId),
    recordRaw,
  );
  const existing = parse(stored.value);
  if (serialize(existing) !== recordRaw) {
    throw new EarningsCallFindingStoreError("earnings_finding_conflict");
  }
  const headKey = key(input.scope, "head", "latest");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentRaw = raw(await client.get(headKey));
    if (currentRaw) {
      const current = parse(currentRaw);
      if (current.createdAt > record.createdAt) break;
      if (
        current.createdAt === record.createdAt &&
        current.finding.findingId >= record.finding.findingId
      ) break;
    }
    if (await client.compareAndSet(headKey, currentRaw, recordRaw)) break;
    if (attempt === 7) throw new EarningsCallFindingStoreError("earnings_finding_conflict");
  }
  return stored.created ? "created" : "reused";
}

export async function readEarningsCallFinding(
  scope: AuthorizedWorkspaceStoreScope,
  findingId: string,
  client: EarningsCallFindingStoreClient = store(),
): Promise<EarningsCallFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "finding", findingId));
  if (value === null || value === undefined) return null;
  const record = parse(value);
  assertScope(scope, record.finding);
  return record;
}

export async function readLatestEarningsCallFinding(
  scope: AuthorizedWorkspaceStoreScope,
  client: EarningsCallFindingStoreClient = store(),
): Promise<EarningsCallFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "head", "latest"));
  if (value === null || value === undefined) return null;
  const record = parse(value);
  assertScope(scope, record.finding);
  return record;
}
