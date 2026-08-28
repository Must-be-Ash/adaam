import { createHash } from "node:crypto";

import { del, get, put } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  HYBRID_EVIDENCE_LIMITS,
  digestHybridEvidenceValue,
  evidenceArtifactManifestSchema,
  evidenceLocatorSchema,
  type EvidenceArtifactManifest,
  type EvidenceLocator,
} from "./hybrid-evidence-schema";
import {
  HybridEvidencePdfError,
  HYBRID_EVIDENCE_MAX_RENDER_EDGE,
  projectHybridEvidencePdf,
  readHybridEvidencePdfPage,
} from "./hybrid-evidence-pdf";
import {
  projectHybridEvidenceWorkbook,
  readHybridEvidenceCellRange,
} from "./hybrid-evidence-spreadsheet";

const INDEX_KEY = "eve:hybrid-evidence:v1:artifact-index";
const EPHEMERAL_INDEX_KEY = "eve:hybrid-evidence:v1:ephemeral-artifact-index";
const MAX_CAS_ATTEMPTS = 8;
const MAX_INDEX_BYTES = 512 * 1_024;
const MAX_ARTIFACTS = 1_024;
const QUARANTINE_RETENTION_MS = 90 * 24 * 60 * 60_000;
const ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60_000;
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

const referenceSchema = z.object({
  active: z.boolean(),
  kind: z.enum(["accepted_result", "current_lineage", "promotion"]),
  referenceId: z.string().min(3).max(200),
}).strict();
const artifactEntrySchema = z.object({
  deletionToken: z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null),
  manifest: evidenceArtifactManifestSchema,
  references: z.array(referenceSchema).max(128),
}).strict();
const usageSchema = z.object({
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  byteCount: z.number().int().nonnegative(),
  calendarDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  count: z.number().int().nonnegative(),
  sourceInstanceId: z.string().min(3).max(200).nullable(),
}).strict();
const indexSchema = z.object({
  artifacts: z.array(artifactEntrySchema).max(MAX_ARTIFACTS),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  usage: z.array(usageSchema).max(4096),
}).strict();

type ArtifactIndex = z.infer<typeof indexSchema>;

export interface HybridEvidenceArtifactIndexClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface HybridEvidenceBlobClient {
  delete(storageKey: string): Promise<void>;
  get(storageKey: string): Promise<Uint8Array | null>;
  put(storageKey: string, bytes: Uint8Array, mediaType: string): Promise<void>;
}

export interface HybridEvidenceArtifactQuota {
  readonly deploymentBytesPerDay: number;
  readonly deploymentCountPerDay: number;
  readonly sourceBytesPerDay: number;
  readonly sourceCountPerDay: number;
}

export interface HybridEvidenceArtifactStore {
  collectExpired(input?: { now?: Date }): Promise<readonly string[]>;
  deleteUnreferenced(artifactDigest: string): Promise<boolean>;
  persist(input: PersistHybridEvidenceArtifactInput): Promise<EvidenceArtifactManifest>;
  readManifest(artifactDigest: string): Promise<EvidenceArtifactManifest | null>;
  readSlice(input: {
    locator: EvidenceLocator;
    maximumBytes: number;
  }): Promise<HybridEvidenceSlice>;
  setReference(input: {
    active: boolean;
    artifactDigest: string;
    kind: "accepted_result" | "current_lineage" | "promotion";
    referenceId: string;
  }): Promise<void>;
  setRetention(input: {
    artifactDigest: string;
    now?: Date;
    state: "active" | "orphaned" | "quarantined";
  }): Promise<EvidenceArtifactManifest>;
}

export interface HybridEvidenceWorkerArtifactReader {
  readManifest(artifactDigest: string): Promise<EvidenceArtifactManifest | null>;
  readSlice(input: {
    locator: EvidenceLocator;
    maximumBytes: number;
  }): Promise<HybridEvidenceSlice>;
}

export interface PersistHybridEvidenceArtifactInput {
  readonly acquisitionId: string;
  readonly authority: string;
  readonly bytes: Uint8Array;
  readonly canonicalPublicUrl: string;
  readonly mediaType: EvidenceArtifactManifest["mediaType"];
  readonly now?: Date;
  readonly observedAt: string;
  readonly parserEligibility: EvidenceArtifactManifest["parserEligibility"];
  readonly sourceInstanceId: string;
  readonly structure: EvidenceArtifactManifest["structure"];
}

export interface HybridEvidenceSlice {
  readonly artifactDigest: string;
  readonly byteCount: number;
  readonly content: string;
  readonly contentKind: "image" | "text";
  readonly locatorDigest: string;
  readonly mediaType: EvidenceArtifactManifest["mediaType"] | "image/png";
}

export class HybridEvidenceArtifactStoreError extends Error {
  constructor(readonly code:
    | "artifact_bounds_exceeded"
    | "artifact_digest_mismatch"
    | "artifact_not_found"
    | "artifact_quota_exceeded"
    | "artifact_store_conflict"
    | "artifact_store_corrupt"
    | "locator_out_of_bounds"
    | "storage_unavailable"
    | "unsupported_layout") {
    super(code);
    this.name = "HybridEvidenceArtifactStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultIndexClient: HybridEvidenceArtifactIndexClient | undefined;

function redisStore(): HybridEvidenceArtifactIndexClient {
  if (defaultIndexClient) return defaultIndexClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new HybridEvidenceArtifactStoreError("storage_unavailable");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultIndexClient = {
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
  return defaultIndexClient;
}

const blobStore: HybridEvidenceBlobClient = {
  async delete(storageKey) {
    await del(storageKey);
  },
  async get(storageKey) {
    const result = await get(storageKey, { access: "public", useCache: true });
    if (!result || result.statusCode !== 200) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },
  async put(storageKey, bytes, mediaType) {
    await put(storageKey, Buffer.from(bytes), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 31_536_000,
      contentType: mediaType,
      maximumSizeInBytes: HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes,
    });
  },
};

const privateBlobStore: HybridEvidenceBlobClient = {
  async delete(storageKey) {
    await del(storageKey, { token: privateBlobToken() });
  },
  async get(storageKey) {
    const result = await get(storageKey, {
      access: "private",
      token: privateBlobToken(),
      useCache: false,
    });
    if (!result || result.statusCode !== 200) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  },
  async put(storageKey, bytes, mediaType) {
    await put(storageKey, Buffer.from(bytes), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: mediaType,
      maximumSizeInBytes: HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes,
      token: privateBlobToken(),
    });
  },
};

function privateBlobToken(): string {
  const token = process.env.EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN
    ?? process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new HybridEvidenceArtifactStoreError("storage_unavailable");
  return token;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseIndex(raw: string | null): ArtifactIndex {
  if (raw === null) return { artifacts: [], revision: 0, schemaVersion: 1, usage: [] };
  if (Buffer.byteLength(raw, "utf8") > MAX_INDEX_BYTES) {
    throw new HybridEvidenceArtifactStoreError("artifact_store_corrupt");
  }
  try {
    return indexSchema.parse(JSON.parse(raw));
  } catch {
    throw new HybridEvidenceArtifactStoreError("artifact_store_corrupt");
  }
}

async function updateIndex<T>(
  client: HybridEvidenceArtifactIndexClient,
  indexKey: string,
  mutate: (index: ArtifactIndex) => { index: ArtifactIndex; result: T },
): Promise<T> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await client.get(indexKey));
    const current = parseIndex(currentRaw);
    const mutation = mutate(current);
    if (mutation.index === current) return mutation.result;
    const parsed = indexSchema.safeParse(mutation.index);
    if (!parsed.success) throw new HybridEvidenceArtifactStoreError("artifact_store_corrupt");
    const nextRaw = JSON.stringify(parsed.data);
    if (Buffer.byteLength(nextRaw, "utf8") > MAX_INDEX_BYTES) {
      throw new HybridEvidenceArtifactStoreError("artifact_quota_exceeded");
    }
    if (await client.compareAndSet(indexKey, currentRaw, nextRaw)) return mutation.result;
  }
  throw new HybridEvidenceArtifactStoreError("artifact_store_conflict");
}

function defaultQuota(): HybridEvidenceArtifactQuota {
  return {
    deploymentBytesPerDay: 500 * 1_024 * 1_024,
    deploymentCountPerDay: 500,
    sourceBytesPerDay: 50 * 1_024 * 1_024,
    sourceCountPerDay: 50,
  };
}

function assertQuota(quota: HybridEvidenceArtifactQuota): void {
  for (const value of Object.values(quota)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new HybridEvidenceArtifactStoreError("artifact_quota_exceeded");
    }
  }
}

function artifactId(digest: string): string {
  return `hybrid-evidence.artifact.${digest}`;
}

function storageKey(digest: string, prefix: string): string {
  return `${prefix}/${digest}`;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertArtifactShape(input: PersistHybridEvidenceArtifactInput): void {
  if (
    input.mediaType === "application/pdf" &&
    Buffer.from(input.bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  ) throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
  if (
    input.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
    !(input.bytes[0] === 0x50 && input.bytes[1] === 0x4b && input.bytes[2] === 0x03 && input.bytes[3] === 0x04)
  ) throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
  if (["application/xml", "text/html", "text/plain"].includes(input.mediaType)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
    }
    if (
      input.structure.characterCount === null ||
      input.structure.characterCount !== text.length
    ) throw new HybridEvidenceArtifactStoreError("artifact_bounds_exceeded");
  }
}

function validateLocatorBounds(
  manifest: EvidenceArtifactManifest,
  locator: EvidenceLocator,
): void {
  if (
    !("artifactDigest" in locator) ||
    locator.artifactDigest !== manifest.contentDigest
  ) {
    throw new HybridEvidenceArtifactStoreError("locator_out_of_bounds");
  }
  if (
    locator.kind === "pdf_page" &&
    (manifest.mediaType !== "application/pdf" ||
      manifest.structure.pageCount === null ||
      locator.page > manifest.structure.pageCount)
  ) {
    throw new HybridEvidenceArtifactStoreError("locator_out_of_bounds");
  }
  if (locator.kind === "text_span") {
    if (
      !manifest.mediaType.startsWith("text/") ||
      manifest.structure.characterCount === null ||
      locator.end > manifest.structure.characterCount
    ) {
      throw new HybridEvidenceArtifactStoreError("locator_out_of_bounds");
    }
  }
  if (locator.kind === "spreadsheet_range") {
    const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/u.exec(locator.range);
    const column = (letters: string) => [...letters].reduce(
      (total, letter) => total * 26 + letter.charCodeAt(0) - 64,
      0,
    );
    if (
      manifest.mediaType !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      manifest.structure.rowCount === null ||
      manifest.structure.columnCount === null ||
      !match ||
      Number(match[4]) > manifest.structure.rowCount ||
      column(match[3]!) > manifest.structure.columnCount
    ) {
      throw new HybridEvidenceArtifactStoreError("locator_out_of_bounds");
    }
  }
}

export function createHybridEvidenceArtifactStore(options: {
  blob?: HybridEvidenceBlobClient;
  indexKey?: string;
  index?: HybridEvidenceArtifactIndexClient;
  quota?: HybridEvidenceArtifactQuota;
  retainAcceptedResultReferences?: boolean;
  storageKeyPrefix?: string;
} = {}): HybridEvidenceArtifactStore {
  const indexClient = options.index ?? redisStore();
  const blobs = options.blob ?? blobStore;
  const indexKey = options.indexKey ?? INDEX_KEY;
  const quota = options.quota ?? defaultQuota();
  const retainAcceptedResultReferences = options.retainAcceptedResultReferences ?? true;
  const storageKeyPrefix = options.storageKeyPrefix ?? "hybrid-evidence/sha256";
  assertQuota(quota);

  const readEntry = async (digest: string) => {
    const index = parseIndex(rawValue(await indexClient.get(indexKey)));
    return index.artifacts.find(({ deletionToken, manifest }) =>
      !deletionToken && manifest.contentDigest === digest) ?? null;
  };

  const artifactStore: HybridEvidenceArtifactStore = {
    async collectExpired(input: { now?: Date } = {}) {
      const now = input.now ?? new Date();
      const claimed = await updateIndex(indexClient, indexKey, (current) => {
        const removable = current.artifacts.filter(({ deletionToken, manifest, references }) =>
          !deletionToken &&
          references.every(({ active }) => !active) &&
          manifest.retention.expiresAt !== null &&
          Date.parse(manifest.retention.expiresAt) <= now.getTime()
        );
        const claims = removable.map(({ manifest }) => ({
          digest: manifest.contentDigest,
          storageKey: manifest.storageKey,
          token: digestHybridEvidenceValue([
            "artifact-deletion",
            manifest.contentDigest,
            current.revision + 1,
            now.toISOString(),
          ]),
        }));
        if (claims.length === 0) return { index: current, result: claims };
        const tokens = new Map(claims.map(({ digest, token }) => [digest, token]));
        return {
          index: {
            ...current,
            artifacts: current.artifacts.map((entry) => ({
              ...entry,
              deletionToken: tokens.get(entry.manifest.contentDigest) ?? entry.deletionToken,
            })),
            revision: current.revision + 1,
          },
          result: claims,
        };
      });
      if (claimed.length === 0) return Object.freeze([]);
      const deletions = await Promise.allSettled(
        claimed.map(({ storageKey: key }) => blobs.delete(key)),
      );
      if (deletions.some(({ status }) => status === "rejected")) {
        await updateIndex(indexClient, indexKey, (current) => {
          const tokens = new Map(claimed.map(({ digest, token }) => [digest, token]));
          let changed = false;
          const artifacts = current.artifacts.map((entry) => {
            const token = tokens.get(entry.manifest.contentDigest);
            if (token === undefined || entry.deletionToken !== token) return entry;
            changed = true;
            return { ...entry, deletionToken: null };
          });
          if (!changed) return { index: current, result: undefined };
          return {
            index: {
              ...current,
              artifacts,
              revision: current.revision + 1,
            },
            result: undefined,
          };
        });
        throw new HybridEvidenceArtifactStoreError("storage_unavailable");
      }
      return updateIndex(indexClient, indexKey, (current) => {
        const tokens = new Map(claimed.map(({ digest, token }) => [digest, token]));
        const matchesClaim = (entry: ArtifactIndex["artifacts"][number]) => {
          const token = tokens.get(entry.manifest.contentDigest);
          return token !== undefined && entry.deletionToken === token;
        };
        const deleted = current.artifacts.filter(matchesClaim);
        if (deleted.length === 0) return { index: current, result: [] };
        return {
          index: {
            ...current,
            artifacts: current.artifacts.filter((entry) => !matchesClaim(entry)),
            revision: current.revision + 1,
          },
          result: deleted.map(({ manifest }) => manifest.contentDigest),
        };
      });
    },

    async deleteUnreferenced(artifactDigest: string) {
      const token = digestHybridEvidenceValue(["artifact-delete-now", artifactDigest, Date.now()]);
      const claimed = await updateIndex(indexClient, indexKey, (current) => {
        const index = current.artifacts.findIndex(({ manifest }) =>
          manifest.contentDigest === artifactDigest);
        if (index < 0) return { index: current, result: null };
        const entry = current.artifacts[index]!;
        if (entry.deletionToken || entry.references.some(({ active }) => active)) {
          return { index: current, result: null };
        }
        const artifacts = [...current.artifacts];
        artifacts[index] = { ...entry, deletionToken: token };
        return {
          index: { ...current, artifacts, revision: current.revision + 1 },
          result: entry.manifest.storageKey,
        };
      });
      if (claimed === null) return false;
      try {
        await blobs.delete(claimed);
      } catch {
        await updateIndex(indexClient, indexKey, (current) => {
          const index = current.artifacts.findIndex((entry) =>
            entry.manifest.contentDigest === artifactDigest && entry.deletionToken === token);
          if (index < 0) return { index: current, result: undefined };
          const artifacts = [...current.artifacts];
          artifacts[index] = { ...artifacts[index]!, deletionToken: null };
          return {
            index: { ...current, artifacts, revision: current.revision + 1 },
            result: undefined,
          };
        });
        throw new HybridEvidenceArtifactStoreError("storage_unavailable");
      }
      await updateIndex(indexClient, indexKey, (current) => {
        const index = current.artifacts.findIndex((entry) =>
          entry.manifest.contentDigest === artifactDigest && entry.deletionToken === token);
        if (index < 0) return { index: current, result: undefined };
        return {
          index: {
            ...current,
            artifacts: current.artifacts.filter((_, artifactIndex) => artifactIndex !== index),
            revision: current.revision + 1,
            usage: current.usage.filter(({ artifactDigest: digest }) => digest !== artifactDigest),
          },
          result: undefined,
        };
      });
      return true;
    },

    async persist(input: PersistHybridEvidenceArtifactInput) {
      if (
        input.bytes.byteLength < 1 ||
        input.bytes.byteLength > HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes
      ) {
        throw new HybridEvidenceArtifactStoreError("artifact_bounds_exceeded");
      }
      assertArtifactShape(input);
      const digest = digestBytes(input.bytes);
      const observedAt = new Date(input.observedAt);
      const now = input.now ?? new Date();
      if (!Number.isFinite(observedAt.getTime())) {
        throw new HybridEvidenceArtifactStoreError("artifact_store_corrupt");
      }
      const manifest = evidenceArtifactManifestSchema.parse({
        accessClassification: "public",
        acquisitionId: input.acquisitionId,
        artifactId: artifactId(digest),
        authority: input.authority,
        byteCount: input.bytes.byteLength,
        canonicalPublicUrl: input.canonicalPublicUrl,
        contentDigest: digest,
        mediaType: input.mediaType,
        observedAt: observedAt.toISOString(),
        parserEligibility: input.parserEligibility,
        recordType: "hybrid_evidence_artifact",
        retention: { expiresAt: null, state: "active" },
        schemaVersion: 1,
        sourceInstanceId: input.sourceInstanceId,
        storageKey: storageKey(digest, storageKeyPrefix),
        structure: input.structure,
      });
      const day = now.toISOString().slice(0, 10);
      const reserved = await updateIndex(indexClient, indexKey, (current) => {
        const existing = current.artifacts.find(
          ({ manifest: candidate }) => candidate.contentDigest === digest,
        );
        if (existing) {
          if (existing.deletionToken) {
            throw new HybridEvidenceArtifactStoreError("artifact_store_conflict");
          }
          if (
            existing.manifest.byteCount !== manifest.byteCount ||
            existing.manifest.mediaType !== manifest.mediaType
          ) {
            throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
          }
          return { index: current, result: { created: false, manifest: existing.manifest } };
        }
        const daily = current.usage.filter(
          (entry) => entry.calendarDay === day && entry.sourceInstanceId === null,
        );
        const source = current.usage.filter(
          (entry) => entry.calendarDay === day &&
            entry.sourceInstanceId === input.sourceInstanceId,
        );
        const total = (entries: typeof daily, field: "byteCount" | "count") =>
          entries.reduce((sum, entry) => sum + entry[field], 0);
        if (
          total(daily, "count") + 1 > quota.deploymentCountPerDay ||
          total(daily, "byteCount") + input.bytes.byteLength > quota.deploymentBytesPerDay ||
          total(source, "count") + 1 > quota.sourceCountPerDay ||
          total(source, "byteCount") + input.bytes.byteLength > quota.sourceBytesPerDay ||
          current.artifacts.length >= MAX_ARTIFACTS
        ) {
          throw new HybridEvidenceArtifactStoreError("artifact_quota_exceeded");
        }
        return {
          index: {
            ...current,
            artifacts: [...current.artifacts, { deletionToken: null, manifest, references: [] }],
            revision: current.revision + 1,
            usage: [
              ...current.usage.filter((entry) => entry.calendarDay >= day),
              { artifactDigest: digest, byteCount: input.bytes.byteLength, calendarDay: day, count: 1, sourceInstanceId: null },
              { artifactDigest: digest, byteCount: input.bytes.byteLength, calendarDay: day, count: 1, sourceInstanceId: input.sourceInstanceId },
            ],
          },
          result: { created: true, manifest },
        };
      });
      const stored = reserved.created ? null : await blobs.get(manifest.storageKey);
      if (
        reserved.created ||
        stored === null ||
        stored.byteLength !== input.bytes.byteLength ||
        digestBytes(stored) !== digest
      ) {
        try {
          await blobs.put(manifest.storageKey, input.bytes, input.mediaType);
        } catch {
          if (reserved.created) {
            await updateIndex(indexClient, indexKey, (current) => ({
              index: {
                ...current,
                artifacts: current.artifacts.filter(
                  ({ manifest: candidate }) => candidate.contentDigest !== digest,
                ),
                revision: current.revision + 1,
                usage: current.usage.filter((entry) => entry.artifactDigest !== digest),
              },
              result: undefined,
            }));
          }
          throw new HybridEvidenceArtifactStoreError("storage_unavailable");
        }
      }
      return reserved.manifest;
    },

    async readManifest(artifactDigest: string) {
      return (await readEntry(artifactDigest))?.manifest ?? null;
    },

    async readSlice(input: { locator: EvidenceLocator; maximumBytes: number }) {
      const locator = evidenceLocatorSchema.parse(input.locator);
      if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
        throw new HybridEvidenceArtifactStoreError("artifact_bounds_exceeded");
      }
      if (!("artifactDigest" in locator)) {
        throw new HybridEvidenceArtifactStoreError("locator_out_of_bounds");
      }
      const entry = await readEntry(locator.artifactDigest);
      if (!entry) throw new HybridEvidenceArtifactStoreError("artifact_not_found");
      validateLocatorBounds(entry.manifest, locator);
      const bytes = await blobs.get(entry.manifest.storageKey);
      if (!bytes) throw new HybridEvidenceArtifactStoreError("storage_unavailable");
      if (
        bytes.byteLength !== entry.manifest.byteCount ||
        digestBytes(bytes) !== entry.manifest.contentDigest
      ) {
        throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
      }
      let content: string;
      let contentKind: HybridEvidenceSlice["contentKind"] = "text";
      let mediaType: HybridEvidenceSlice["mediaType"] = entry.manifest.mediaType;
      if (locator.kind === "text_span") {
        const full = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        content = full.slice(locator.start, locator.end);
        if (digestBytes(Buffer.from(content, "utf8")) !== locator.spanDigest) {
          throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
        }
      } else if (locator.kind === "pdf_page") {
        let page: Awaited<ReturnType<typeof readHybridEvidencePdfPage>> | null = null;
        let lastError: unknown;
        for (const maximumRenderEdge of [undefined, HYBRID_EVIDENCE_MAX_RENDER_EDGE] as const) {
          try {
            const projection = await projectHybridEvidencePdf(bytes, maximumRenderEdge === undefined
              ? {}
              : { maximumRenderEdge });
            page = await readHybridEvidencePdfPage({
              evidenceDigest: locator.evidenceDigest,
              page: locator.page,
              projection,
              region: locator.region,
            });
            break;
          } catch (error) {
            lastError = error;
            if (
              !(error instanceof HybridEvidencePdfError) ||
              error.code !== "artifact_digest_mismatch"
            ) throw error;
          }
        }
        if (!page) throw lastError;
        content = page.imageBase64;
        contentKind = "image";
        mediaType = page.mediaType;
      } else {
        const projection = await projectHybridEvidenceWorkbook(bytes);
        const range = readHybridEvidenceCellRange({
          projection,
          range: locator.range,
          sheetId: locator.sheetId,
        });
        if (range.digest !== locator.normalizedRangeDigest) {
          throw new HybridEvidenceArtifactStoreError("artifact_digest_mismatch");
        }
        content = JSON.stringify({ range: locator.range, rows: range.rows, sheetId: locator.sheetId });
      }
      const byteCount = contentKind === "image"
        ? Buffer.from(content, "base64").byteLength
        : Buffer.byteLength(content, "utf8");
      if (byteCount > input.maximumBytes) {
        throw new HybridEvidenceArtifactStoreError("artifact_bounds_exceeded");
      }
      return Object.freeze({
        artifactDigest: entry.manifest.contentDigest,
        byteCount,
        content,
        contentKind,
        locatorDigest: digestHybridEvidenceValue(locator),
        mediaType,
      });
    },

    async setReference(input: {
      active: boolean;
      artifactDigest: string;
      kind: "accepted_result" | "current_lineage" | "promotion";
      referenceId: string;
    }) {
      await updateIndex(indexClient, indexKey, (current) => {
        const index = current.artifacts.findIndex(
          ({ manifest }) => manifest.contentDigest === input.artifactDigest,
        );
        if (index < 0) throw new HybridEvidenceArtifactStoreError("artifact_not_found");
        const entry = current.artifacts[index]!;
        if (entry.deletionToken) {
          throw new HybridEvidenceArtifactStoreError("artifact_store_conflict");
        }
        const references = entry.references.filter(
          ({ referenceId }) => referenceId !== input.referenceId,
        );
        references.push({
          active: input.kind === "accepted_result" && !retainAcceptedResultReferences
            ? false
            : input.active,
          kind: input.kind,
          referenceId: input.referenceId,
        });
        const artifacts = [...current.artifacts];
        artifacts[index] = { ...entry, references };
        return { index: { ...current, artifacts, revision: current.revision + 1 }, result: undefined };
      });
    },

    async setRetention(input: {
      artifactDigest: string;
      now?: Date;
      state: "active" | "orphaned" | "quarantined";
    }) {
      const now = input.now ?? new Date();
      return updateIndex(indexClient, indexKey, (current) => {
        const index = current.artifacts.findIndex(
          ({ manifest }) => manifest.contentDigest === input.artifactDigest,
        );
        if (index < 0) throw new HybridEvidenceArtifactStoreError("artifact_not_found");
        const entry = current.artifacts[index]!;
        if (entry.deletionToken) {
          throw new HybridEvidenceArtifactStoreError("artifact_store_conflict");
        }
        if (input.state !== "active" && entry.references.some(({ active }) => active)) {
          throw new HybridEvidenceArtifactStoreError("artifact_store_conflict");
        }
        const expiresAt = input.state === "active"
          ? null
          : new Date(now.getTime() + (
              input.state === "quarantined" ? QUARANTINE_RETENTION_MS : ORPHAN_RETENTION_MS
            )).toISOString();
        const manifest = evidenceArtifactManifestSchema.parse({
          ...entry.manifest,
          retention: { expiresAt, state: input.state },
        });
        const artifacts = [...current.artifacts];
        artifacts[index] = { ...entry, manifest };
        return {
          index: { ...current, artifacts, revision: current.revision + 1 },
          result: manifest,
        };
      });
    },
  };
  return Object.freeze(artifactStore);
}

export function createHybridEvidenceEphemeralArtifactStore(options: {
  blob?: HybridEvidenceBlobClient;
  index?: HybridEvidenceArtifactIndexClient;
  quota?: HybridEvidenceArtifactQuota;
} = {}): HybridEvidenceArtifactStore {
  return createHybridEvidenceArtifactStore({
    blob: options.blob ?? privateBlobStore,
    index: options.index,
    indexKey: EPHEMERAL_INDEX_KEY,
    quota: options.quota,
    retainAcceptedResultReferences: false,
    storageKeyPrefix: "hybrid-evidence-private/sha256",
  });
}

export function createHybridEvidenceWorkerArtifactStore(): HybridEvidenceWorkerArtifactReader {
  const ephemeral = createHybridEvidenceEphemeralArtifactStore();
  const durable = createHybridEvidenceArtifactStore();
  const fallback = async <T>(
    primary: () => Promise<T>,
    secondary: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await primary();
    } catch (error) {
      if (!(error instanceof HybridEvidenceArtifactStoreError) || error.code !== "artifact_not_found") {
        throw error;
      }
      return secondary();
    }
  };
  const workerStore: HybridEvidenceWorkerArtifactReader = {
    readManifest: (digest) => fallback(
      async () => {
        const manifest = await ephemeral.readManifest(digest);
        if (!manifest) throw new HybridEvidenceArtifactStoreError("artifact_not_found");
        return manifest;
      },
      () => durable.readManifest(digest),
    ),
    readSlice: (input) => fallback(
      () => ephemeral.readSlice(input),
      () => durable.readSlice(input),
    ),
  };
  return Object.freeze(workerStore);
}
