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
const MULTI_CAS_SCRIPT = `
for index = 1, #KEYS do
  local expected = ARGV[(index - 1) * 2 + 1]
  local current = redis.call("GET", KEYS[index])
  if expected == "" then
    if current then return 0 end
  elseif current ~= expected then
    return 0
  end
end
for index = 1, #KEYS do
  redis.call("SET", KEYS[index], ARGV[(index - 1) * 2 + 2])
end
return 1
`;
const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const publicCommentarySourceSchema = z.object({
  accessClassification: z.literal("public"),
  adapterId: identifierSchema,
  canonicalUrl: z.string().url().max(2_048),
  origin: z.string().url().max(500),
  sourceId: identifierSchema,
  sourceInstanceId: identifierSchema,
}).strict().superRefine((source, context) => {
  const canonical = new URL(source.canonicalUrl);
  if (canonical.origin !== source.origin || new URL(source.origin).origin !== source.origin) {
    context.addIssue({ code: "custom", message: "public_commentary_source_invalid" });
  }
});

const supersessionHeadSchema = z.object({
  correctionId: identifierSchema,
  currentFindingId: identifierSchema,
  currentStatementRevisionId: identifierSchema,
  lifecycle: z.enum(["deleted", "edited", "protected", "withheld"]),
  recordType: z.literal("public_commentary_supersession_head"),
  rootFindingId: identifierSchema,
  rootStatementRevisionId: identifierSchema,
  schemaVersion: z.literal(1),
  sourceRevision: z.number().int().positive().max(1_000),
}).strict();

export const publicCommentaryFindingRecordSchema = z.object({
  correction: commentaryCorrectionSchema.nullable(),
  corroboration: webCorroborationSearchSchema,
  createdAt: timestampSchema,
  directionDisclosure: z.string().trim().min(1).max(500).nullable(),
  extraction: commentaryExtractionSchema.nullable(),
  finding: commentaryFindingSchema,
  impactClassification: z.enum(["de_escalation", "escalation", "mixed", "unclear"]).nullable().default(null),
  interpretation: commentaryInterpretationSchema.nullable(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  policyDisplayName: z.string().trim().min(1).max(160),
  rawContentIncluded: z.literal(false),
  recordType: z.literal("public_commentary_finding_record"),
  schemaVersion: z.literal(1),
  source: publicCommentarySourceSchema,
  statement: publicStatementSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  if (record.correction === null) {
    if (
      record.directionDisclosure === null ||
      record.extraction === null ||
      record.interpretation === null ||
      record.finding.interpretationId !== record.interpretation.interpretationId ||
      record.statement.contentReference === null
    ) context.addIssue({ code: "custom", message: "public_commentary_record_invalid" });
    return;
  }
  const expectedLifecycle = record.correction.reason.slice("source_".length);
  if (
    !record.correction.rootFindingId ||
    !record.correction.rootStatementRevisionId ||
    !record.correction.supersedesStatementRevisionId ||
    record.directionDisclosure !== null ||
    record.extraction !== null ||
    record.interpretation !== null ||
    record.statement.lifecycle !== expectedLifecycle ||
    record.statement.revision !== record.correction.sourceRevision ||
    record.finding.analysisIdentity.statementRevisionId !== record.finding.statementRevisionId ||
    record.finding.citations.some(({ contentRevision }) => contentRevision !== record.correction!.sourceRevision) ||
    record.statement.contentReference !== null ||
    record.statement.textLocators.length !== 0 ||
    record.statement.entities.cashtags.length !== 0 ||
    record.statement.entities.mentions.length !== 0 ||
    record.statement.entities.urls.length !== 0 ||
    record.finding.policyDecision.researchDirection !== null ||
    record.finding.policyDecision.decision !== "no_view" ||
    record.finding.materiality.alertEligible ||
    !["corrected", "retracted"].includes(record.finding.outcome)
  ) context.addIssue({ code: "custom", message: "public_commentary_correction_record_invalid" });
});

export type PublicCommentaryFindingRecord = z.infer<typeof publicCommentaryFindingRecordSchema>;

export interface PublicCommentaryFindingStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  compareAndSetMany(operations: readonly Readonly<{
    expected: string | null;
    key: string;
    next: string;
  }>[]): Promise<boolean>;
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
  let multiSha = redis.scriptLoad(MULTI_CAS_SCRIPT);
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
    async compareAndSetMany(operations) {
      const keys = operations.map(({ key }) => key);
      const args = operations.flatMap(({ expected, next }) => [expected ?? "", next]);
      try {
        return (await redis!.evalsha<string[], number>(
          await multiSha,
          keys,
          args,
        )) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        multiSha = redis!.scriptLoad(MULTI_CAS_SCRIPT);
        return (await redis!.evalsha<string[], number>(
          await multiSha,
          keys,
          args,
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

function parseSupersessionHead(value: unknown) {
  const serialized = raw(value);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 16 * 1_024) {
    throw new Error("public_commentary_supersession_corrupt");
  }
  return supersessionHeadSchema.parse(JSON.parse(serialized));
}

function lifecycleForCorrection(reason: z.infer<typeof commentaryCorrectionSchema>["reason"]) {
  return reason.slice("source_".length) as "deleted" | "edited" | "protected" | "withheld";
}

async function persistPublicCommentaryCorrection(
  scope: AuthorizedWorkspaceStoreScope,
  record: PublicCommentaryFindingRecord & { correction: NonNullable<PublicCommentaryFindingRecord["correction"]> },
  client: PublicCommentaryFindingStoreClient,
): Promise<PublicCommentaryFindingRecord> {
  const correction = record.correction;
  const serialized = JSON.stringify(record);
  const recordKey = key(scope, "finding", record.finding.findingId);
  const statementRecordKey = key(scope, "statement-record", record.finding.statementRevisionId);
  const existingRaw = raw(await client.get(recordKey));
  if (existingRaw !== null) {
    const existing = parse(existingRaw, scope);
    if (JSON.stringify(existing) !== serialized) throw new Error("public_commentary_finding_conflict");
    return existing;
  }
  const superseded = await readHistoricalPublicCommentaryFinding(scope, correction.findingId, client);
  if (
    !superseded ||
    superseded.finding.statementRevisionId !== correction.supersedesStatementRevisionId
  ) throw new Error("public_commentary_supersession_conflict");

  const rootFindingHeadKey = key(scope, "finding-head", correction.rootFindingId!);
  const rootStatementHeadKey = key(scope, "statement-head", correction.rootStatementRevisionId!);
  const supersededFindingHeadKey = key(scope, "finding-head", correction.findingId);
  const supersededStatementHeadKey = key(scope, "statement-head", correction.supersedesStatementRevisionId!);
  const head = supersessionHeadSchema.parse({
    correctionId: correction.correctionId,
    currentFindingId: record.finding.findingId,
    currentStatementRevisionId: record.finding.statementRevisionId,
    lifecycle: lifecycleForCorrection(correction.reason),
    recordType: "public_commentary_supersession_head",
    rootFindingId: correction.rootFindingId,
    rootStatementRevisionId: correction.rootStatementRevisionId,
    schemaVersion: 1,
    sourceRevision: correction.sourceRevision,
  });
  const headRaw = JSON.stringify(head);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latestKey = key(scope, "latest", "current");
    const [latestRaw, rootFindingRaw, rootStatementRaw, supersededFindingRaw, supersededStatementRaw] = await Promise.all([
      client.get(latestKey).then(raw),
      client.get(rootFindingHeadKey).then(raw),
      client.get(rootStatementHeadKey).then(raw),
      client.get(supersededFindingHeadKey).then(raw),
      client.get(supersededStatementHeadKey).then(raw),
    ]);
    const existingRootFinding = rootFindingRaw === null ? null : parseSupersessionHead(rootFindingRaw);
    const existingRootStatement = rootStatementRaw === null ? null : parseSupersessionHead(rootStatementRaw);
    if (
      existingRootFinding && existingRootFinding.currentFindingId !== correction.findingId ||
      existingRootStatement && existingRootStatement.currentStatementRevisionId !== correction.supersedesStatementRevisionId
    ) throw new Error("public_commentary_supersession_conflict");
    if (
      supersededFindingRaw !== null && supersededFindingHeadKey !== rootFindingHeadKey ||
      supersededStatementRaw !== null && supersededStatementHeadKey !== rootStatementHeadKey
    ) throw new Error("public_commentary_supersession_conflict");
    const operations = new Map<string, { expected: string | null; key: string; next: string }>();
    for (const operation of [
      { expected: null, key: recordKey, next: serialized },
      { expected: null, key: statementRecordKey, next: serialized },
      { expected: latestRaw, key: latestKey, next: serialized },
      { expected: rootFindingRaw, key: rootFindingHeadKey, next: headRaw },
      { expected: rootStatementRaw, key: rootStatementHeadKey, next: headRaw },
      { expected: supersededFindingRaw, key: supersededFindingHeadKey, next: headRaw },
      { expected: supersededStatementRaw, key: supersededStatementHeadKey, next: headRaw },
    ]) operations.set(operation.key, operation);
    if (await client.compareAndSetMany([...operations.values()])) return record;
  }
  throw new Error("public_commentary_supersession_conflict");
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
  if (record.correction) {
    return persistPublicCommentaryCorrection(
      scope,
      record as PublicCommentaryFindingRecord & { correction: NonNullable<PublicCommentaryFindingRecord["correction"]> },
      client,
    );
  }
  const serialized = JSON.stringify(record);
  const recordKey = key(scope, "finding", record.finding.findingId);
  const statementRecordKey = key(scope, "statement-record", record.finding.statementRevisionId);
  if (!(await client.compareAndSetMany([
    { expected: null, key: recordKey, next: serialized },
    { expected: null, key: statementRecordKey, next: serialized },
  ]))) {
    const existing = parse(await client.get(recordKey), scope);
    if (JSON.stringify(existing) !== serialized) throw new Error("public_commentary_finding_conflict");
    const existingStatement = parse(await client.get(statementRecordKey), scope);
    if (JSON.stringify(existingStatement) !== serialized) {
      throw new Error("public_commentary_finding_conflict");
    }
  }
  const latestKey = key(scope, "latest", "current");
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = raw(await client.get(latestKey));
    if (await client.compareAndSet(latestKey, current, serialized)) return record;
  }
  throw new Error("public_commentary_latest_conflict");
}

async function readHistoricalPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  findingId: string,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "finding", findingId));
  return value === null || value === undefined ? null : parse(value, scope);
}

export async function readPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  findingId: string,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const headValue = await client.get(key(scope, "finding-head", findingId));
  if (headValue === null || headValue === undefined) {
    return readHistoricalPublicCommentaryFinding(scope, findingId, client);
  }
  const head = parseSupersessionHead(headValue);
  return readHistoricalPublicCommentaryFinding(scope, head.currentFindingId, client);
}

export async function readPublicCommentaryFindingByStatementRevision(
  scope: AuthorizedWorkspaceStoreScope,
  statementRevisionId: string,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const headValue = await client.get(key(scope, "statement-head", statementRevisionId));
  if (headValue === null || headValue === undefined) {
    const statementValue = await client.get(key(scope, "statement-record", statementRevisionId));
    return statementValue === null || statementValue === undefined
      ? null
      : parse(statementValue, scope);
  }
  const head = parseSupersessionHead(headValue);
  return readHistoricalPublicCommentaryFinding(scope, head.currentFindingId, client);
}

export async function readLatestPublicCommentaryFinding(
  scope: AuthorizedWorkspaceStoreScope,
  client: PublicCommentaryFindingStoreClient = store(),
): Promise<PublicCommentaryFindingRecord | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const value = await client.get(key(scope, "latest", "current"));
  if (value === null || value === undefined) return null;
  const latest = parse(value, scope);
  return readPublicCommentaryFinding(scope, latest.finding.findingId, client);
}
