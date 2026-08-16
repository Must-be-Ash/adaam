import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";

import {
  canonicalPublicFactRevisionSchema,
  publicSourceAcquisitionJournalSchema,
  publicSourceAcquisitionResultSchema,
  publicSourceCorrectionSchema,
  publicSourceInstanceSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceAcquisitionJournal,
  type PublicSourceAcquisitionResult,
  type PublicSourceCorrection,
  type PublicSourceInstance,
} from "./public-source-adapter-schema";
import {
  publicSourceHealthRecordSchema,
  type PublicSourceHealthRecord,
} from "./public-source-observability";

const KEY_PREFIX = "eve:public-source:v1:";
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

export interface PublicSourceAcquisitionStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface PublicSourcePreparedAcquisition {
  readonly corrections: readonly PublicSourceCorrection[];
  readonly facts: readonly CanonicalPublicFactRevision[];
  readonly result: PublicSourceAcquisitionResult;
  readonly window: { readonly endAt: string; readonly startAt: string };
}

export interface PublicSourceAcquisitionCommit {
  readonly correctionsCreated: number;
  readonly correctionsReused: number;
  readonly factsCreated: number;
  readonly factsReused: number;
  readonly journal: PublicSourceAcquisitionJournal;
  readonly sourceInstance: PublicSourceInstance;
}

export class PublicSourceAcquisitionStoreError extends Error {
  readonly code:
    | "fact_conflict"
    | "journal_conflict"
    | "public_source_record_corrupt"
    | "source_cursor_conflict"
    | "source_instance_conflict"
    | "source_instance_inactive";

  constructor(code: PublicSourceAcquisitionStoreError["code"]) {
    super(code);
    this.code = code;
    this.name = "PublicSourceAcquisitionStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: PublicSourceAcquisitionStoreClient | undefined;

function store(): PublicSourceAcquisitionStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Public-source acquisition storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<
        [string, string],
        number
      >(candidate, [key], [expected ?? "", next]);
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

function recordKey(
  kind:
    | "acquisition"
    | "acquisition-eligibility"
    | "correction"
    | "fact"
    | "fact-head"
    | "source-health"
    | "journal"
    | "source-instance",
  id: string,
): string {
  const digest = createHash("sha256").update(id).digest("hex");
  return `${KEY_PREFIX}${kind}:${digest}`;
}

export interface PublicSourceAcquisitionEligibility {
  readonly accessClassification: "public";
  readonly adapterDefinitionDigest: string;
  readonly expectedCursorRevision: number;
  readonly sourceInstanceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}

export interface ReusablePublicSourceAcquisition {
  readonly journal: PublicSourceAcquisitionJournal;
  readonly result: PublicSourceAcquisitionResult;
}

export type PublicSourceAcquisitionWindow = Omit<
  PublicSourceAcquisitionEligibility,
  "expectedCursorRevision"
>;

export function derivePublicSourceAcquisitionEligibilityId(
  eligibility: PublicSourceAcquisitionEligibility,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      eligibility.sourceInstanceId,
      eligibility.adapterDefinitionDigest,
      eligibility.window.startAt,
      eligibility.window.endAt,
      eligibility.accessClassification,
      eligibility.expectedCursorRevision,
    ]))
    .digest("hex");
}

function derivePublicSourceAcquisitionWindowId(
  window: PublicSourceAcquisitionWindow,
): string {
  return createHash("sha256")
    .update(JSON.stringify([
      window.sourceInstanceId,
      window.adapterDefinitionDigest,
      window.window.startAt,
      window.window.endAt,
      window.accessClassification,
    ]))
    .digest("hex");
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  return raw;
}

function parseRaw<T>(raw: string, parse: (value: unknown) => T): T {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof PublicSourceAcquisitionStoreError) throw error;
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
}

async function readRaw(key: string, client: PublicSourceAcquisitionStoreClient) {
  return rawValue(await client.get(key));
}

export async function readPublicSourceInstance(
  sourceInstanceId: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceInstance | null> {
  const raw = await readRaw(recordKey("source-instance", sourceInstanceId), client);
  return raw === null
    ? null
    : parseRaw(raw, (value) => publicSourceInstanceSchema.parse(value));
}

export async function readPublicSourceHealthRecord(
  sourceInstanceId: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceHealthRecord | null> {
  const raw = await readRaw(recordKey("source-health", sourceInstanceId), client);
  return raw === null
    ? null
    : parseRaw(raw, (value) => publicSourceHealthRecordSchema.parse(value));
}

function extractionSummary(input: {
  readonly facts: readonly CanonicalPublicFactRevision[];
  readonly result: PublicSourceAcquisitionResult;
}, previous: PublicSourceHealthRecord | null): PublicSourceHealthRecord["extraction"] {
  const counts = {
    complete: input.facts.filter((fact) => fact.extraction.state === "complete").length,
    partial: input.facts.filter((fact) => fact.extraction.state === "partial").length,
    unsupported: input.facts.filter((fact) => fact.extraction.state === "unsupported").length,
  };
  const degradedReceipt = input.result.stageReceipts.find(
    (receipt) => receipt.status === "partial" || receipt.status === "unsupported",
  );
  if (input.facts.length === 0 && !degradedReceipt && previous) return previous.extraction;
  return Object.freeze({
    ...counts,
    state: counts.unsupported > 0 || degradedReceipt?.status === "unsupported"
      ? "unsupported" as const
      : counts.partial > 0 || degradedReceipt?.status === "partial" ||
          input.result.coverage !== "complete"
        ? "partial" as const
        : "complete" as const,
  });
}

async function publishPublicSourceHealth(input: {
  readonly facts: readonly CanonicalPublicFactRevision[];
  readonly result: PublicSourceAcquisitionResult;
  readonly source: PublicSourceInstance;
}, client: PublicSourceAcquisitionStoreClient): Promise<void> {
  const key = recordKey("source-health", input.source.sourceInstanceId);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previousRaw = await readRaw(key, client);
    const previous = previousRaw === null
      ? null
      : parseRaw(previousRaw, (value) => publicSourceHealthRecordSchema.parse(value));
    if (
      previous &&
      previous.lastOutcome.observedAt > input.result.observedAt
    ) return;
    const degraded = input.result.stageReceipts.find(
      (receipt) => receipt.status !== "complete" && receipt.errorCode !== null,
    );
    const successful = input.result.status === "complete" || input.result.status === "no_change";
    const next = publicSourceHealthRecordSchema.parse({
      adapterId: input.result.adapterId,
      adapterVersion: input.result.adapterVersion,
      cursor: input.source.cursor,
      extraction: extractionSummary(input, previous),
      lastCompleteAcquisition: successful
        ? {
            acquisitionId: input.result.acquisitionId,
            observedAt: input.result.observedAt,
            status: input.result.status,
          }
        : previous?.lastCompleteAcquisition ?? null,
      lastOutcome: {
        acquisitionId: input.result.acquisitionId,
        coverage: input.result.coverage,
        errorCode: degraded?.errorCode ?? input.result.errorCode,
        failureStage: degraded?.stage ?? null,
        observedAt: input.result.observedAt,
        status: input.result.status,
      },
      lifecycleState: input.source.lifecycleState,
      recordType: "public_source_health",
      schemaVersion: 1,
      sourceInstanceId: input.source.sourceInstanceId,
    });
    if (await client.compareAndSet(key, previousRaw, serialize(next))) return;
  }
}

export async function ensurePublicSourceInstance(
  seed: PublicSourceInstance,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceInstance> {
  const parsed = publicSourceInstanceSchema.parse(seed);
  const key = recordKey("source-instance", parsed.sourceInstanceId);
  const raw = serialize(parsed);
  if (await client.compareAndSet(key, null, raw)) return parsed;
  const existingRaw = await readRaw(key, client);
  if (existingRaw === null) {
    throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  }
  const existing = parseRaw(existingRaw, (value) => publicSourceInstanceSchema.parse(value));
  const {
    cursor: _existingCursor,
    lifecycleState: _existingLifecycleState,
    ...existingDefinition
  } = existing;
  const {
    cursor: _seedCursor,
    lifecycleState: _seedLifecycleState,
    ...seedDefinition
  } = parsed;
  if (JSON.stringify(existingDefinition) !== JSON.stringify(seedDefinition)) {
    throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  }
  return existing;
}

export async function readPublicSourceAcquisitionJournal(
  acquisitionId: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceAcquisitionJournal | null> {
  const raw = await readRaw(recordKey("journal", acquisitionId), client);
  return raw === null
    ? null
    : parseRaw(raw, (value) => publicSourceAcquisitionJournalSchema.parse(value));
}

export async function readPublicSourceFactRevision(
  revisionId: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<CanonicalPublicFactRevision | null> {
  const raw = await readRaw(recordKey("fact", revisionId), client);
  return raw === null
    ? null
    : parseRaw(raw, (value) => canonicalPublicFactRevisionSchema.parse(value));
}

interface PublicSourceFactHead {
  readonly logicalKey: string;
  readonly revisionId: string;
  readonly schemaVersion: 1;
}

function parseFactHead(raw: string): PublicSourceFactHead {
  return parseRaw(raw, (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Reflect.get(value, "schemaVersion") !== 1 ||
      typeof Reflect.get(value, "logicalKey") !== "string" ||
      typeof Reflect.get(value, "revisionId") !== "string"
    ) {
      throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
    }
    return Object.freeze({
      logicalKey: Reflect.get(value, "logicalKey") as string,
      revisionId: Reflect.get(value, "revisionId") as string,
      schemaVersion: 1 as const,
    });
  });
}

async function readFactHead(
  logicalKey: string,
  client: PublicSourceAcquisitionStoreClient,
): Promise<{ readonly head: PublicSourceFactHead; readonly raw: string } | null> {
  const raw = await readRaw(recordKey("fact-head", logicalKey), client);
  if (raw === null) return null;
  const head = parseFactHead(raw);
  if (head.logicalKey !== logicalKey) {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  return Object.freeze({ head, raw });
}

export async function readLatestPublicSourceFactRevision(
  logicalKey: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<CanonicalPublicFactRevision | null> {
  const current = await readFactHead(logicalKey, client);
  if (current === null) return null;
  const fact = await readPublicSourceFactRevision(current.head.revisionId, client);
  if (!fact || fact.logicalKey !== logicalKey) {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  return fact;
}

export async function readPublicSourceAcquisitionResult(
  acquisitionId: string,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceAcquisitionResult | null> {
  const raw = await readRaw(recordKey("acquisition", acquisitionId), client);
  return raw === null
    ? null
    : parseRaw(raw, (value) => publicSourceAcquisitionResultSchema.parse(value));
}

async function readIndexedPublicSourceAcquisition(input: {
  readonly identityField: "eligibilityId" | "windowId";
  readonly identityValue: string;
  readonly recordId: string;
  readonly validateJournal: (journal: PublicSourceAcquisitionJournal) => boolean;
}, client: PublicSourceAcquisitionStoreClient): Promise<ReusablePublicSourceAcquisition | null> {
  const raw = await readRaw(
    recordKey("acquisition-eligibility", input.recordId),
    client,
  );
  if (raw === null) return null;
  let acquisitionId: string;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Reflect.get(parsed, input.identityField) !== input.identityValue ||
      typeof Reflect.get(parsed, "acquisitionId") !== "string"
    ) {
      throw new Error("invalid acquisition index");
    }
    acquisitionId = Reflect.get(parsed, "acquisitionId") as string;
  } catch {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  const [journal, result] = await Promise.all([
    readPublicSourceAcquisitionJournal(acquisitionId, client),
    readPublicSourceAcquisitionResult(acquisitionId, client),
  ]);
  if (!journal || journal.status !== "committed" || !result || !input.validateJournal(journal)) {
    throw new PublicSourceAcquisitionStoreError("public_source_record_corrupt");
  }
  return Object.freeze({ journal, result });
}

export async function readReusablePublicSourceAcquisition(
  eligibility: PublicSourceAcquisitionEligibility,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<ReusablePublicSourceAcquisition | null> {
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  return readIndexedPublicSourceAcquisition({
    identityField: "eligibilityId",
    identityValue: eligibilityId,
    recordId: eligibilityId,
    validateJournal: (journal) =>
      journal.sourceInstanceId === eligibility.sourceInstanceId &&
      journal.adapterDefinitionDigest === eligibility.adapterDefinitionDigest &&
      journal.expectedCursorRevision === eligibility.expectedCursorRevision &&
      JSON.stringify(journal.window) === JSON.stringify(eligibility.window),
  }, client);
}

export async function readCommittedPublicSourceAcquisitionForWindow(
  window: PublicSourceAcquisitionWindow,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<ReusablePublicSourceAcquisition | null> {
  const windowId = derivePublicSourceAcquisitionWindowId(window);
  return readIndexedPublicSourceAcquisition({
    identityField: "windowId",
    identityValue: windowId,
    recordId: `window.${windowId}`,
    validateJournal: (journal) =>
      journal.sourceInstanceId === window.sourceInstanceId &&
      journal.adapterDefinitionDigest === window.adapterDefinitionDigest &&
      JSON.stringify(journal.window) === JSON.stringify(window.window),
  }, client);
}

async function publishPublicSourceAcquisition(
  eligibility: PublicSourceAcquisitionEligibility,
  acquisitionId: string,
  client: PublicSourceAcquisitionStoreClient,
): Promise<void> {
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  const key = recordKey("acquisition-eligibility", eligibilityId);
  const raw = serialize({ acquisitionId, eligibilityId, schemaVersion: 1 });
  if (!(await client.compareAndSet(key, null, raw))) {
    const current = await readRaw(key, client);
    if (current !== raw) {
      throw new PublicSourceAcquisitionStoreError("journal_conflict");
    }
  }
  const window = {
    accessClassification: eligibility.accessClassification,
    adapterDefinitionDigest: eligibility.adapterDefinitionDigest,
    sourceInstanceId: eligibility.sourceInstanceId,
    window: eligibility.window,
  };
  const windowId = derivePublicSourceAcquisitionWindowId(window);
  const windowKey = recordKey("acquisition-eligibility", `window.${windowId}`);
  const windowRaw = serialize({ acquisitionId, schemaVersion: 1, windowId });
  if (await client.compareAndSet(windowKey, null, windowRaw)) return;
  const currentWindow = await readRaw(windowKey, client);
  if (currentWindow !== windowRaw) {
    throw new PublicSourceAcquisitionStoreError("journal_conflict");
  }
}

async function writeFact(
  candidate: CanonicalPublicFactRevision,
  client: PublicSourceAcquisitionStoreClient,
): Promise<"created" | "reused"> {
  const fact = canonicalPublicFactRevisionSchema.parse(candidate);
  const key = recordKey("fact", fact.revisionId);
  const raw = serialize(fact);
  if (await client.compareAndSet(key, null, raw)) return "created";
  const existingRaw = await readRaw(key, client);
  if (existingRaw === null) throw new PublicSourceAcquisitionStoreError("fact_conflict");
  const existing = parseRaw(existingRaw, (value) => canonicalPublicFactRevisionSchema.parse(value));
  const { createdObservedAt: _existingObservedAt, ...existingIdentity } = existing;
  const { createdObservedAt: _candidateObservedAt, ...candidateIdentity } = fact;
  if (JSON.stringify(existingIdentity) !== JSON.stringify(candidateIdentity)) {
    throw new PublicSourceAcquisitionStoreError("fact_conflict");
  }
  return "reused";
}

async function writeCorrection(
  candidate: PublicSourceCorrection,
  client: PublicSourceAcquisitionStoreClient,
): Promise<"created" | "reused"> {
  const correction = publicSourceCorrectionSchema.parse(candidate);
  const key = recordKey("correction", correction.correctionId);
  const raw = serialize(correction);
  if (await client.compareAndSet(key, null, raw)) return "created";
  const existingRaw = await readRaw(key, client);
  if (existingRaw === null) throw new PublicSourceAcquisitionStoreError("fact_conflict");
  const existing = parseRaw(existingRaw, (value) => publicSourceCorrectionSchema.parse(value));
  const { createdObservedAt: _existingObservedAt, ...existingIdentity } = existing;
  const { createdObservedAt: _candidateObservedAt, ...candidateIdentity } = correction;
  if (JSON.stringify(existingIdentity) !== JSON.stringify(candidateIdentity)) {
    throw new PublicSourceAcquisitionStoreError("fact_conflict");
  }
  return "reused";
}

async function advanceFactHead(input: {
  readonly correction: PublicSourceCorrection | null;
  readonly fact: CanonicalPublicFactRevision;
}, client: PublicSourceAcquisitionStoreClient): Promise<void> {
  const key = recordKey("fact-head", input.fact.logicalKey);
  const next = serialize({
    logicalKey: input.fact.logicalKey,
    revisionId: input.fact.revisionId,
    schemaVersion: 1,
  });
  const current = await readFactHead(input.fact.logicalKey, client);

  if (input.correction === null) {
    if (current?.head.revisionId === input.fact.revisionId) return;
    if (current !== null) throw new PublicSourceAcquisitionStoreError("fact_conflict");
    if (await client.compareAndSet(key, null, next)) return;
    const raced = await readFactHead(input.fact.logicalKey, client);
    if (raced?.head.revisionId === input.fact.revisionId) return;
    throw new PublicSourceAcquisitionStoreError("fact_conflict");
  }

  if (current?.head.revisionId === input.fact.revisionId) return;
  if (current?.head.revisionId !== input.correction.fromRevisionId) {
    throw new PublicSourceAcquisitionStoreError("fact_conflict");
  }
  if (await client.compareAndSet(key, current.raw, next)) return;
  const raced = await readFactHead(input.fact.logicalKey, client);
  if (raced?.head.revisionId === input.fact.revisionId) return;
  throw new PublicSourceAcquisitionStoreError("fact_conflict");
}

function journalIdentity(journal: PublicSourceAcquisitionJournal) {
  const { committedAt: _committedAt, preparedAt: _preparedAt, status: _status, ...identity } = journal;
  return identity;
}

async function prepareJournal(
  candidate: PublicSourceAcquisitionJournal,
  client: PublicSourceAcquisitionStoreClient,
): Promise<{ journal: PublicSourceAcquisitionJournal; raw: string }> {
  const journal = publicSourceAcquisitionJournalSchema.parse(candidate);
  const key = recordKey("journal", journal.acquisitionId);
  const raw = serialize(journal);
  if (await client.compareAndSet(key, null, raw)) return { journal, raw };
  const existingRaw = await readRaw(key, client);
  if (existingRaw === null) throw new PublicSourceAcquisitionStoreError("journal_conflict");
  const existing = parseRaw(existingRaw, (value) => publicSourceAcquisitionJournalSchema.parse(value));
  if (JSON.stringify(journalIdentity(existing)) !== JSON.stringify(journalIdentity(journal))) {
    throw new PublicSourceAcquisitionStoreError("journal_conflict");
  }
  return { journal: existing, raw: existingRaw };
}

async function commitJournal(
  prepared: { journal: PublicSourceAcquisitionJournal; raw: string },
  committedAt: string,
  client: PublicSourceAcquisitionStoreClient,
): Promise<PublicSourceAcquisitionJournal> {
  if (prepared.journal.status === "committed") return prepared.journal;
  const committed = publicSourceAcquisitionJournalSchema.parse({
    ...prepared.journal,
    committedAt,
    status: "committed",
  });
  const key = recordKey("journal", committed.acquisitionId);
  if (await client.compareAndSet(key, prepared.raw, serialize(committed))) return committed;
  const current = await readPublicSourceAcquisitionJournal(committed.acquisitionId, client);
  if (
    current?.status === "committed" &&
    JSON.stringify(journalIdentity(current)) === JSON.stringify(journalIdentity(committed))
  ) {
    return current;
  }
  throw new PublicSourceAcquisitionStoreError("journal_conflict");
}

async function advanceCursor(
  source: PublicSourceInstance,
  result: PublicSourceAcquisitionResult,
  client: PublicSourceAcquisitionStoreClient,
): Promise<PublicSourceInstance> {
  const proposed = result.proposedNextCursor!;
  const matchesAdvanced = (candidate: PublicSourceInstance) =>
    candidate.cursor.revision === proposed.expectedRevision + 1 &&
    candidate.cursor.contentDigest === proposed.contentDigest &&
    candidate.cursor.watermark === proposed.watermark;
  if (matchesAdvanced(source)) return source;
  if (source.cursor.revision !== proposed.expectedRevision) {
    throw new PublicSourceAcquisitionStoreError("source_cursor_conflict");
  }
  const next = publicSourceInstanceSchema.parse({
    ...source,
    cursor: {
      contentDigest: proposed.contentDigest,
      revision: proposed.expectedRevision + 1,
      watermark: proposed.watermark,
    },
  });
  const key = recordKey("source-instance", source.sourceInstanceId);
  if (await client.compareAndSet(key, serialize(source), serialize(next))) return next;
  const current = await readPublicSourceInstance(source.sourceInstanceId, client);
  if (current && matchesAdvanced(current)) return current;
  throw new PublicSourceAcquisitionStoreError("source_cursor_conflict");
}

async function writeAcquisitionResult(
  result: PublicSourceAcquisitionResult,
  client: PublicSourceAcquisitionStoreClient,
): Promise<PublicSourceAcquisitionResult> {
  const parsed = publicSourceAcquisitionResultSchema.parse(result);
  const key = recordKey("acquisition", parsed.acquisitionId);
  const raw = serialize(parsed);
  if (await client.compareAndSet(key, null, raw)) return parsed;
  const existing = await readPublicSourceAcquisitionResult(parsed.acquisitionId, client);
  if (!existing) throw new PublicSourceAcquisitionStoreError("journal_conflict");
  const { observedAt: _existingObservedAt, ...existingIdentity } = existing;
  const { observedAt: _candidateObservedAt, ...candidateIdentity } = parsed;
  if (JSON.stringify(existingIdentity) !== JSON.stringify(candidateIdentity)) {
    throw new PublicSourceAcquisitionStoreError("journal_conflict");
  }
  return existing;
}

export async function recordPublicSourceAcquisitionOutcome(
  result: PublicSourceAcquisitionResult,
  client: PublicSourceAcquisitionStoreClient = store(),
): Promise<PublicSourceAcquisitionResult> {
  const written = await writeAcquisitionResult(result, client);
  const source = await readPublicSourceInstance(written.sourceInstanceId, client);
  if (!source) throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  await publishPublicSourceHealth({ facts: [], result: written, source }, client);
  return written;
}

export async function commitPublicSourceAcquisition(input: {
  readonly acquisition: PublicSourcePreparedAcquisition;
  readonly client?: PublicSourceAcquisitionStoreClient;
}): Promise<PublicSourceAcquisitionCommit> {
  const client = input.client ?? store();
  const result = publicSourceAcquisitionResultSchema.parse(input.acquisition.result);
  if (
    (result.status !== "complete" && result.status !== "no_change") ||
    result.proposedNextCursor === null
  ) {
    throw new PublicSourceAcquisitionStoreError("journal_conflict");
  }
  const facts = input.acquisition.facts.map((fact) => canonicalPublicFactRevisionSchema.parse(fact));
  const corrections = input.acquisition.corrections.map((correction) =>
    publicSourceCorrectionSchema.parse(correction));
  if (
    JSON.stringify(result.candidateFactRevisionIds) !==
      JSON.stringify(facts.map((fact) => fact.revisionId)) ||
    JSON.stringify(result.correctionIds) !==
      JSON.stringify(corrections.map((correction) => correction.correctionId)) ||
    facts.some((fact) =>
      fact.sourceInstanceId !== result.sourceInstanceId ||
      fact.adapterId !== result.adapterId)
  ) {
    throw new PublicSourceAcquisitionStoreError("journal_conflict");
  }
  const source = await readPublicSourceInstance(result.sourceInstanceId, client);
  if (!source || source.adapterDefinitionDigest !== result.adapterDefinitionDigest) {
    throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  }
  if (
    source.adapterId !== result.adapterId ||
    source.adapterVersion !== result.adapterVersion
  ) {
    throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  }
  if (source.lifecycleState !== "active") {
    throw new PublicSourceAcquisitionStoreError("source_instance_inactive");
  }
  const prepared = await prepareJournal(publicSourceAcquisitionJournalSchema.parse({
    acquisitionId: result.acquisitionId,
    adapterDefinitionDigest: result.adapterDefinitionDigest,
    committedAt: null,
    correctionIds: result.correctionIds,
    expectedCursorRevision: result.proposedNextCursor.expectedRevision,
    factRevisionIds: result.candidateFactRevisionIds,
    preparedAt: result.observedAt,
    proposedCursor: result.proposedNextCursor,
    recordType: "public_source_acquisition_journal",
    schemaVersion: 1,
    sourceInstanceId: result.sourceInstanceId,
    status: "prepared",
    window: input.acquisition.window,
  }), client);

  const factOutcomes = await Promise.all(facts.map((fact) => writeFact(fact, client)));
  const factsCreated = factOutcomes.filter((outcome) => outcome === "created").length;
  const factsReused = factOutcomes.length - factsCreated;

  const linkedRevisionIds = [...new Set(corrections.flatMap((correction) => [
    correction.fromRevisionId,
    correction.toRevisionId,
  ]))];
  const linkedRevisions = new Map(await Promise.all(linkedRevisionIds.map(async (revisionId) => [
    revisionId,
    await readPublicSourceFactRevision(revisionId, client),
  ] as const)));
  for (const correction of corrections) {
    const fromRevision = linkedRevisions.get(correction.fromRevisionId);
    const toRevision = linkedRevisions.get(correction.toRevisionId);
    if (
      fromRevision?.logicalKey !== correction.logicalKey ||
      toRevision?.logicalKey !== correction.logicalKey
    ) {
      throw new PublicSourceAcquisitionStoreError("fact_conflict");
    }
  }
  const correctionOutcomes = await Promise.all(
    corrections.map((correction) => writeCorrection(correction, client)),
  );
  const correctionsCreated = correctionOutcomes.filter(
    (outcome) => outcome === "created",
  ).length;
  const correctionsReused = correctionOutcomes.length - correctionsCreated;

  const journal = await commitJournal(prepared, result.observedAt, client);
  const currentSource = await readPublicSourceInstance(result.sourceInstanceId, client);
  if (!currentSource) throw new PublicSourceAcquisitionStoreError("source_instance_conflict");
  const sourceInstance = await advanceCursor(currentSource, result, client);
  const correctionsByRevision = new Map(
    corrections.map((correction) => [correction.toRevisionId, correction] as const),
  );
  for (const fact of facts) {
    await advanceFactHead({
      correction: correctionsByRevision.get(fact.revisionId) ?? null,
      fact,
    }, client);
  }
  await writeAcquisitionResult(result, client);
  await publishPublicSourceAcquisition({
    accessClassification: "public",
    adapterDefinitionDigest: result.adapterDefinitionDigest,
    expectedCursorRevision: result.proposedNextCursor.expectedRevision,
    sourceInstanceId: result.sourceInstanceId,
    window: input.acquisition.window,
  }, result.acquisitionId, client);
  await publishPublicSourceHealth({ facts, result, source: sourceInstance }, client);
  return Object.freeze({
    correctionsCreated,
    correctionsReused,
    factsCreated,
    factsReused,
    journal,
    sourceInstance,
  });
}
