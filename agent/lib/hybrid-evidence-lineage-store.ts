import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";

import {
  digestHybridEvidenceValue,
  hybridInvalidationRecordSchema,
  hybridPromotionRecordSchema,
  type HybridInvalidationRecord,
  type HybridPromotionRecord,
} from "./hybrid-evidence-schema";

const KEY_PREFIX = "eve:hybrid-evidence:v1:lineage:";
const MAX_RECORD_BYTES = 128 * 1_024;
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

export interface HybridEvidenceLineageStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class HybridEvidenceLineageStoreError extends Error {
  constructor(readonly code: "lineage_conflict" | "lineage_corrupt" | "lineage_not_found") {
    super(code);
    this.name = "HybridEvidenceLineageStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: HybridEvidenceLineageStoreClient | undefined;

function store(): HybridEvidenceLineageStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new HybridEvidenceLineageStoreError("lineage_corrupt");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<[string, string], number>(
        candidate,
        [key],
        [expected ?? "", next],
      );
      try {
        return (await execute(sha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        scriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await scriptSha;
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function key(kind: "invalidation" | "promotion", id: string): string {
  return `${KEY_PREFIX}${kind}:${createHash("sha256").update(id).digest("hex")}`;
}

function headKey(lineageKey: string): string {
  return `${KEY_PREFIX}result-head:${createHash("sha256").update(lineageKey).digest("hex")}`;
}

interface HybridSourceResultHead {
  readonly pendingInvalidation: HybridInvalidationRecord | null;
  readonly resultId: string;
  readonly sourceDigest: string;
  readonly sourceRevision: string;
}

function raw(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output, "utf8") > MAX_RECORD_BYTES) {
    throw new HybridEvidenceLineageStoreError("lineage_corrupt");
  }
  return output;
}

function parseHead(value: string): HybridSourceResultHead {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.resultId !== "string" ||
      typeof parsed.sourceDigest !== "string" ||
      typeof parsed.sourceRevision !== "string"
    ) throw new Error("invalid");
    const pendingInvalidation = parsed.pendingInvalidation === undefined ||
        parsed.pendingInvalidation === null
      ? null
      : hybridInvalidationRecordSchema.parse(parsed.pendingInvalidation);
    if (
      pendingInvalidation &&
      (pendingInvalidation.cause.digest !== parsed.sourceDigest ||
        pendingInvalidation.cause.kind !== "source_revision" ||
        pendingInvalidation.cause.revision !== parsed.sourceRevision ||
        pendingInvalidation.supersedingResultId !== parsed.resultId)
    ) throw new Error("invalid");
    return {
      pendingInvalidation,
      resultId: parsed.resultId,
      sourceDigest: parsed.sourceDigest,
      sourceRevision: parsed.sourceRevision,
    };
  } catch {
    throw new HybridEvidenceLineageStoreError("lineage_corrupt");
  }
}

function serializeHead(
  head: Omit<HybridSourceResultHead, "pendingInvalidation"> & {
    readonly pendingInvalidation?: HybridInvalidationRecord;
  },
): string {
  return serialize({
    ...(head.pendingInvalidation ? { pendingInvalidation: head.pendingInvalidation } : {}),
    resultId: head.resultId,
    schemaVersion: 1,
    sourceDigest: head.sourceDigest,
    sourceRevision: head.sourceRevision,
  });
}

async function putImmutable<T>(input: {
  readonly id: string;
  readonly kind: "invalidation" | "promotion";
  readonly parse: (value: unknown) => T;
  readonly value: unknown;
}, client: HybridEvidenceLineageStoreClient): Promise<T> {
  const parsed = input.parse(input.value);
  const serialized = serialize(parsed);
  const recordKey = key(input.kind, input.id);
  if (await client.compareAndSet(recordKey, null, serialized)) return parsed;
  const existing = raw(await client.get(recordKey));
  if (existing !== serialized) throw new HybridEvidenceLineageStoreError("lineage_conflict");
  return parsed;
}

export function writeHybridPromotion(
  value: HybridPromotionRecord,
  client: HybridEvidenceLineageStoreClient = store(),
): Promise<HybridPromotionRecord> {
  return putImmutable({
    id: value.promotionId,
    kind: "promotion",
    parse: (candidate) => hybridPromotionRecordSchema.parse(candidate),
    value,
  }, client);
}

export function writeHybridInvalidation(
  value: HybridInvalidationRecord,
  client: HybridEvidenceLineageStoreClient = store(),
): Promise<HybridInvalidationRecord> {
  return putImmutable({
    id: value.invalidationId,
    kind: "invalidation",
    parse: (candidate) => hybridInvalidationRecordSchema.parse(candidate),
    value,
  }, client);
}

export async function readHybridPromotion(
  promotionId: string,
  client: HybridEvidenceLineageStoreClient = store(),
): Promise<HybridPromotionRecord | null> {
  const value = raw(await client.get(key("promotion", promotionId)));
  if (value === null) return null;
  try {
    return hybridPromotionRecordSchema.parse(JSON.parse(value));
  } catch {
    throw new HybridEvidenceLineageStoreError("lineage_corrupt");
  }
}

export async function readHybridInvalidation(
  invalidationId: string,
  client: HybridEvidenceLineageStoreClient = store(),
): Promise<HybridInvalidationRecord | null> {
  const value = raw(await client.get(key("invalidation", invalidationId)));
  if (value === null) return null;
  try {
    return hybridInvalidationRecordSchema.parse(JSON.parse(value));
  } catch {
    throw new HybridEvidenceLineageStoreError("lineage_corrupt");
  }
}

export async function advanceHybridSourceResultLineage(input: {
  readonly lineageKey: string;
  readonly now: Date;
  readonly resultId: string;
  readonly sourceDigest: string;
  readonly sourceRevision: string;
}, client: HybridEvidenceLineageStoreClient = store()): Promise<HybridInvalidationRecord | null> {
  const recordKey = headKey(input.lineageKey);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentRaw = raw(await client.get(recordKey));
    const current = currentRaw === null ? null : parseHead(currentRaw);
    if (current?.pendingInvalidation) {
      await writeHybridInvalidation(current.pendingInvalidation, client);
      const finalized = serializeHead({
        resultId: current.resultId,
        sourceDigest: current.sourceDigest,
        sourceRevision: current.sourceRevision,
      });
      if (!(await client.compareAndSet(recordKey, currentRaw, finalized))) continue;
      if (current.resultId === input.resultId) return current.pendingInvalidation;
      continue;
    }
    if (current?.resultId === input.resultId) return null;
    const invalidation = current
      ? hybridInvalidationRecordSchema.parse({
          cause: {
            digest: input.sourceDigest,
            kind: "source_revision",
            revision: input.sourceRevision,
          },
          createdAt: input.now.toISOString(),
          invalidationId: `hybrid-invalidation.${digestHybridEvidenceValue([
            current.resultId,
            input.resultId,
            input.sourceDigest,
            input.sourceRevision,
          ])}`,
          recordType: "hybrid_evidence_invalidation",
          resultId: current.resultId,
          schemaVersion: 1,
          supersedingResultId: input.resultId,
        })
      : null;
    const next = serializeHead({
      ...(invalidation ? { pendingInvalidation: invalidation } : {}),
      resultId: input.resultId,
      sourceDigest: input.sourceDigest,
      sourceRevision: input.sourceRevision,
    });
    if (!(await client.compareAndSet(recordKey, currentRaw, next))) continue;
    if (!current) return null;
    await writeHybridInvalidation(invalidation!, client);
    await client.compareAndSet(recordKey, next, serializeHead({
      resultId: input.resultId,
      sourceDigest: input.sourceDigest,
      sourceRevision: input.sourceRevision,
    }));
    return invalidation;
  }
  throw new HybridEvidenceLineageStoreError("lineage_conflict");
}
