import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import { earningsIssuerCoverageSchema } from "./earnings-call-schema";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:earnings-call-changes:v1:issuer-status:";
const MAX_RECORD_BYTES = 4 * 1_024;
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

export const earningsCallIssuerStatusRecordSchema = z.object({
  cik: z.string().regex(/^\d{10}$/u),
  coverage: earningsIssuerCoverageSchema,
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("earnings_call_issuer_status"),
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime({ offset: true }),
  workspaceId: z.string().uuid(),
}).strict();

export type EarningsCallIssuerStatusRecord = z.infer<
  typeof earningsCallIssuerStatusRecordSchema
>;

export interface EarningsCallIssuerStatusStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class EarningsCallIssuerStatusStoreError extends Error {
  constructor(readonly code: "earnings_status_conflict" | "earnings_status_corrupt") {
    super(code);
    this.name = "EarningsCallIssuerStatusStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: EarningsCallIssuerStatusStoreClient | undefined;

function store(): EarningsCallIssuerStatusStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Earnings-call status storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
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
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse(value: unknown): EarningsCallIssuerStatusRecord {
  const valueRaw = raw(value);
  if (!valueRaw || Buffer.byteLength(valueRaw, "utf8") > MAX_RECORD_BYTES) {
    throw new EarningsCallIssuerStatusStoreError("earnings_status_corrupt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueRaw);
  } catch {
    throw new EarningsCallIssuerStatusStoreError("earnings_status_corrupt");
  }
  const result = earningsCallIssuerStatusRecordSchema.safeParse(parsed);
  if (!result.success) throw new EarningsCallIssuerStatusStoreError("earnings_status_corrupt");
  return result.data;
}

function statusKey(scope: AuthorizedWorkspaceStoreScope, cik: string): string {
  const digest = createHash("sha256")
    .update(`${scope.ownerId}\0${scope.workspaceId}\0${cik}`)
    .digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function assertRecordScope(
  scope: AuthorizedWorkspaceStoreScope,
  record: EarningsCallIssuerStatusRecord,
): void {
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new EarningsCallIssuerStatusStoreError("earnings_status_conflict");
  }
}

export async function readEarningsCallIssuerStatus(
  scope: AuthorizedWorkspaceStoreScope,
  cik: string,
  client: EarningsCallIssuerStatusStoreClient = store(),
): Promise<EarningsCallIssuerStatusRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const normalizedCik = z.string().regex(/^\d{10}$/u).parse(cik);
  const value = await client.get(statusKey(scope, normalizedCik));
  if (value === null || value === undefined) return null;
  const record = parse(value);
  assertRecordScope(scope, record);
  if (record.cik !== normalizedCik) {
    throw new EarningsCallIssuerStatusStoreError("earnings_status_conflict");
  }
  return record;
}

export async function persistEarningsCallIssuerStatus(input: {
  readonly cik: string;
  readonly coverage: z.input<typeof earningsIssuerCoverageSchema>;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly updatedAt: string;
}, client: EarningsCallIssuerStatusStoreClient = store()): Promise<"reused" | "stale" | "updated"> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const record = earningsCallIssuerStatusRecordSchema.parse({
    cik: input.cik,
    coverage: input.coverage,
    ownerId: input.scope.ownerId,
    recordType: "earnings_call_issuer_status",
    schemaVersion: 1,
    updatedAt: input.updatedAt,
    workspaceId: input.scope.workspaceId,
  });
  const nextRaw = JSON.stringify(record);
  if (Buffer.byteLength(nextRaw, "utf8") > MAX_RECORD_BYTES) {
    throw new EarningsCallIssuerStatusStoreError("earnings_status_corrupt");
  }
  const key = statusKey(input.scope, record.cik);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentRaw = raw(await client.get(key));
    if (currentRaw !== null) {
      const current = parse(currentRaw);
      assertRecordScope(input.scope, current);
      if (current.updatedAt > record.updatedAt) return "stale";
      if (current.updatedAt === record.updatedAt) {
        if (currentRaw === nextRaw) return "reused";
        throw new EarningsCallIssuerStatusStoreError("earnings_status_conflict");
      }
    }
    if (await client.compareAndSet(key, currentRaw, nextRaw)) return "updated";
  }
  throw new EarningsCallIssuerStatusStoreError("earnings_status_conflict");
}
