import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  evidenceLocatorSchema,
  hybridAcceptedResultSchema,
  hybridEvidenceErrorCodeSchema,
  hybridEvidenceJobSchema,
  hybridInvalidationRecordSchema,
  type EvidenceArtifactManifest,
  type HybridAcceptedResult,
  type HybridEvidenceJob,
  type HybridInvalidationRecord,
} from "./hybrid-evidence-schema";
import {
  writeHybridInvalidation,
  type HybridEvidenceLineageStoreClient,
} from "./hybrid-evidence-lineage-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:hybrid-evidence:v1:workspace-semantic:";
const MAX_CAS_ATTEMPTS = 8;
const MAX_INDEX_BYTES = 512 * 1_024;
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

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().min(3).max(200);
const sourceSchema = z.object({
  artifactDigest: digestSchema,
  authority: z.string().min(2).max(160),
  factLogicalKey: idSchema,
  factPayloadDigest: digestSchema,
  factRevisionId: idSchema,
  projectionId: idSchema,
  sourceId: idSchema,
  sourceInstanceId: idSchema,
  subscriptionId: idSchema,
}).strict();
const evidenceSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  lineageKey: idSchema,
  ownerId: idSchema,
  recordType: z.literal("workspace_semantic_evidence"),
  result: hybridAcceptedResultSchema,
  schemaVersion: z.literal(1),
  source: sourceSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  if (
    record.result.purpose !== "semantic_interpretation" ||
    record.result.scope.kind !== "workspace" ||
    record.result.scope.ownerId !== record.ownerId ||
    record.result.scope.workspaceId !== record.workspaceId
  ) {
    context.addIssue({ code: "custom", message: "workspace_semantic_scope_invalid" });
  }
});
const jobSummarySchema = z.object({
  citations: z.array(evidenceLocatorSchema).max(64),
  definitionId: idSchema,
  definitionVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  disposition: z.enum(["accepted", "abstained"]).nullable(),
  jobId: idSchema,
  label: z.string().min(1).max(120).nullable(),
  quarantineCodes: z.array(hybridEvidenceErrorCodeSchema).max(16),
  source: sourceSchema,
  state: z.enum(["accepted", "completed", "failed", "prepared", "quarantined", "running", "uncertain"]),
  unknowns: z.array(z.string().min(1).max(200)).max(64),
  updatedAt: z.string().datetime({ offset: true }),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    paidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/u),
  }).strict(),
}).strict();
const headSchema = z.object({ lineageKey: idSchema, resultId: idSchema }).strict();
const healthConditionSchema = z.object({
  blockingNotified: z.boolean(),
  count: z.number().int().nonnegative().max(1_000_000),
  conditionKey: digestSchema,
  lastJobId: idSchema,
  persistentNotified: z.boolean(),
}).strict();
const indexSchema = z.object({
  healthConditions: z.array(healthConditionSchema).max(128),
  heads: z.array(headSchema).max(256),
  jobs: z.array(jobSummarySchema).max(256),
  ownerId: idSchema,
  resultIds: z.array(idSchema).max(256),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

export type WorkspaceSemanticEvidence = Readonly<z.infer<typeof evidenceSchema>>;
export type WorkspaceSemanticJobSummary = Readonly<z.infer<typeof jobSummarySchema>>;
export type WorkspaceSemanticSource = Readonly<z.infer<typeof sourceSchema>>;
export type WorkspaceSemanticHealthNotification = Readonly<{
  definitionVersion: string;
  kind: "blocking" | "persistent";
  monitorId: string;
  notificationId: string;
  reasonCodes: readonly z.infer<typeof hybridEvidenceErrorCodeSchema>[];
}>;

export interface WorkspaceSemanticEvidenceStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceSemanticEvidenceStoreError extends Error {
  constructor(readonly code:
    | "semantic_evidence_conflict"
    | "semantic_evidence_corrupt"
    | "workspace_scope_mismatch") {
    super(code);
    this.name = "WorkspaceSemanticEvidenceStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceSemanticEvidenceStoreClient | undefined;

function store(): WorkspaceSemanticEvidenceStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeDigest(scope: AuthorizedWorkspaceStoreScope): string {
  return digest(`workspace-semantic\0${scope.ownerId}\0${scope.workspaceId}`);
}

function indexKey(scope: AuthorizedWorkspaceStoreScope): string {
  return `${KEY_PREFIX}${scopeDigest(scope)}:index`;
}

function resultKey(scope: AuthorizedWorkspaceStoreScope, resultId: string): string {
  return `${KEY_PREFIX}${scopeDigest(scope)}:result:${digest(resultId)}`;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function emptyIndex(scope: AuthorizedWorkspaceStoreScope): z.infer<typeof indexSchema> {
  return {
    healthConditions: [],
    heads: [],
    jobs: [],
    ownerId: scope.ownerId,
    resultIds: [],
    revision: 0,
    schemaVersion: 1,
    workspaceId: scope.workspaceId,
  };
}

function parseIndex(value: string | null, scope: AuthorizedWorkspaceStoreScope) {
  if (value === null) return emptyIndex(scope);
  if (Buffer.byteLength(value, "utf8") > MAX_INDEX_BYTES) {
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
  try {
    const parsed = indexSchema.parse(JSON.parse(value));
    if (parsed.ownerId !== scope.ownerId || parsed.workspaceId !== scope.workspaceId) {
      throw new WorkspaceSemanticEvidenceStoreError("workspace_scope_mismatch");
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkspaceSemanticEvidenceStoreError) throw error;
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
}

async function updateIndex<T>(
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceSemanticEvidenceStoreClient,
  mutate: (current: z.infer<typeof indexSchema>) => { next: z.infer<typeof indexSchema>; result: T },
): Promise<T> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const key = indexKey(scope);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = raw(await client.get(key));
    const mutation = mutate(parseIndex(currentRaw, scope));
    const next = indexSchema.safeParse(mutation.next);
    if (!next.success) throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
    const nextRaw = JSON.stringify(next.data);
    if (Buffer.byteLength(nextRaw, "utf8") > MAX_INDEX_BYTES) {
      throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
    }
    if (nextRaw === currentRaw || await client.compareAndSet(key, currentRaw, nextRaw)) {
      return mutation.result;
    }
  }
  throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_conflict");
}

export function createWorkspaceSemanticSource(input: {
  artifact: EvidenceArtifactManifest;
  authority: string;
  factLogicalKey: string;
  factPayloadDigest: string;
  factRevisionId: string;
  projectionId: string;
  sourceId: string;
  sourceInstanceId: string;
  subscriptionId: string;
}): WorkspaceSemanticSource {
  return Object.freeze(sourceSchema.parse({
    artifactDigest: input.artifact.contentDigest,
    authority: input.authority,
    factLogicalKey: input.factLogicalKey,
    factPayloadDigest: input.factPayloadDigest,
    factRevisionId: input.factRevisionId,
    projectionId: input.projectionId,
    sourceId: input.sourceId,
    sourceInstanceId: input.sourceInstanceId,
    subscriptionId: input.subscriptionId,
  }));
}

export async function writeWorkspaceSemanticEvidence(input: {
  lineageKey: string;
  now: Date;
  result: HybridAcceptedResult;
  scope: AuthorizedWorkspaceStoreScope;
  source: WorkspaceSemanticSource;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticEvidence> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const result = hybridAcceptedResultSchema.parse(input.result);
  const record = evidenceSchema.parse({
    createdAt: input.now.toISOString(),
    lineageKey: input.lineageKey,
    ownerId: input.scope.ownerId,
    recordType: "workspace_semantic_evidence",
    result,
    schemaVersion: 1,
    source: input.source,
    workspaceId: input.scope.workspaceId,
  });
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
  const key = resultKey(input.scope, result.resultId);
  if (!(await client.compareAndSet(key, null, serialized))) {
    const existing = raw(await client.get(key));
    if (existing !== serialized) throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_conflict");
  }
  await updateIndex(input.scope, client, (current) => ({
    next: current.resultIds.includes(result.resultId)
      ? current
      : { ...current, resultIds: [...current.resultIds, result.resultId], revision: current.revision + 1 },
    result: undefined,
  }));
  return Object.freeze(record);
}

export async function readWorkspaceSemanticEvidence(input: {
  resultId: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticEvidence | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const value = raw(await client.get(resultKey(input.scope, input.resultId)));
  if (value === null) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
  try {
    const record = evidenceSchema.parse(JSON.parse(value));
    if (record.ownerId !== input.scope.ownerId || record.workspaceId !== input.scope.workspaceId) {
      throw new WorkspaceSemanticEvidenceStoreError("workspace_scope_mismatch");
    }
    return Object.freeze(record);
  } catch (error) {
    if (error instanceof WorkspaceSemanticEvidenceStoreError) throw error;
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
}

function semanticLabel(result: HybridAcceptedResult | null): string | null {
  const label = result?.payload.label;
  return typeof label === "string" && label.length <= 120 ? label : null;
}

export async function recordWorkspaceSemanticJob(input: {
  job: HybridEvidenceJob;
  quarantineCodes?: readonly z.infer<typeof hybridEvidenceErrorCodeSchema>[];
  result?: HybridAcceptedResult | null;
  scope: AuthorizedWorkspaceStoreScope;
  source: WorkspaceSemanticSource;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticJobSummary> {
  const job = hybridEvidenceJobSchema.parse(input.job);
  if (job.scope.kind !== "workspace") {
    throw new WorkspaceSemanticEvidenceStoreError("workspace_scope_mismatch");
  }
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (
    job.scope.ownerId !== input.scope.ownerId ||
    job.scope.workspaceId !== input.scope.workspaceId
  ) throw new WorkspaceSemanticEvidenceStoreError("workspace_scope_mismatch");
  const result = input.result ? hybridAcceptedResultSchema.parse(input.result) : null;
  const summary = jobSummarySchema.parse({
    citations: result?.citations ?? [],
    definitionId: job.definitionId,
    definitionVersion: job.definitionVersion,
    disposition: result?.disposition ?? null,
    jobId: job.jobId,
    label: semanticLabel(result),
    quarantineCodes: [...new Set(input.quarantineCodes ?? [])].sort(),
    source: input.source,
    state: job.state,
    unknowns: result?.uncertainty.unknowns ?? [],
    updatedAt: job.updatedAt,
    usage: result?.usage ?? { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" },
  });
  return updateIndex(input.scope, client, (current) => {
    const index = current.jobs.findIndex(({ jobId }) => jobId === job.jobId);
    const jobs = [...current.jobs];
    if (index >= 0) jobs[index] = summary;
    else jobs.push(summary);
    return {
      next: { ...current, jobs: jobs.slice(-256), revision: current.revision + 1 },
      result: Object.freeze(summary),
    };
  });
}

export async function advanceWorkspaceSemanticHead(input: {
  cause: HybridInvalidationRecord["cause"];
  lineageKey: string;
  now: Date;
  resultId: string;
  scope: AuthorizedWorkspaceStoreScope;
}, clients: {
  lineage?: HybridEvidenceLineageStoreClient;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
} = {}): Promise<HybridInvalidationRecord | null> {
  let previousResultId: string | null = null;
  await updateIndex(input.scope, clients.semantic ?? store(), (current) => {
    const currentHead = current.heads.find(({ lineageKey }) => lineageKey === input.lineageKey);
    if (currentHead?.resultId === input.resultId) return { next: current, result: undefined };
    previousResultId = currentHead?.resultId ?? null;
    return {
      next: {
        ...current,
        heads: [
          ...current.heads.filter(({ lineageKey }) => lineageKey !== input.lineageKey),
          { lineageKey: input.lineageKey, resultId: input.resultId },
        ],
        revision: current.revision + 1,
      },
      result: undefined,
    };
  });
  if (!previousResultId) return null;
  const invalidation = hybridInvalidationRecordSchema.parse({
    cause: input.cause,
    createdAt: input.now.toISOString(),
    invalidationId: `hybrid-invalidation.${digest(JSON.stringify([
      input.scope.ownerId,
      input.scope.workspaceId,
      previousResultId,
      input.resultId,
      input.cause,
    ]))}`,
    recordType: "hybrid_evidence_invalidation",
    resultId: previousResultId,
    schemaVersion: 1,
    supersedingResultId: input.resultId,
  });
  return writeHybridInvalidation(invalidation, clients.lineage);
}

export async function invalidateWorkspaceSemanticHead(input: {
  cause: HybridInvalidationRecord["cause"];
  lineageKey: string;
  now: Date;
  scope: AuthorizedWorkspaceStoreScope;
}, clients: {
  lineage?: HybridEvidenceLineageStoreClient;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
} = {}): Promise<HybridInvalidationRecord | null> {
  let previousResultId: string | null = null;
  await updateIndex(input.scope, clients.semantic ?? store(), (current) => {
    const currentHead = current.heads.find(({ lineageKey }) => lineageKey === input.lineageKey);
    if (!currentHead) return { next: current, result: undefined };
    previousResultId = currentHead.resultId;
    return {
      next: {
        ...current,
        heads: current.heads.filter(({ lineageKey }) => lineageKey !== input.lineageKey),
        revision: current.revision + 1,
      },
      result: undefined,
    };
  });
  if (!previousResultId) return null;
  const invalidation = hybridInvalidationRecordSchema.parse({
    cause: input.cause,
    createdAt: input.now.toISOString(),
    invalidationId: `hybrid-invalidation.${digest(JSON.stringify([
      input.scope.ownerId,
      input.scope.workspaceId,
      previousResultId,
      null,
      input.cause,
    ]))}`,
    recordType: "hybrid_evidence_invalidation",
    resultId: previousResultId,
    schemaVersion: 1,
    supersedingResultId: null,
  });
  return writeHybridInvalidation(invalidation, clients.lineage);
}

export async function readCurrentWorkspaceSemanticEvidence(input: {
  lineageKey: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticEvidence | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const index = parseIndex(raw(await client.get(indexKey(input.scope))), input.scope);
  const resultId = index.heads.find(({ lineageKey }) => lineageKey === input.lineageKey)?.resultId;
  return resultId ? readWorkspaceSemanticEvidence({ resultId, scope: input.scope }, client) : null;
}

export async function listWorkspaceSemanticJobSummaries(
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceSemanticEvidenceStoreClient = store(),
): Promise<readonly WorkspaceSemanticJobSummary[]> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const index = parseIndex(raw(await client.get(indexKey(scope))), scope);
  return Object.freeze([...index.jobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
}

export async function stageWorkspaceSemanticQuarantineHealth(input: {
  definitionVersion: string;
  jobId: string;
  monitorId: string;
  reasonCodes: readonly z.infer<typeof hybridEvidenceErrorCodeSchema>[];
  scope: AuthorizedWorkspaceStoreScope;
  sourceInstanceId: string;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticHealthNotification | null> {
  const reasonCodes = [...new Set(input.reasonCodes)].sort();
  const conditionKey = digest(JSON.stringify([
    input.definitionVersion,
    input.monitorId,
    input.sourceInstanceId,
    reasonCodes,
  ]));
  return updateIndex(input.scope, client, (current) => {
    const previous = current.healthConditions.find((item) => item.conditionKey === conditionKey);
    if (previous?.lastJobId === input.jobId) return { next: current, result: null };
    const count = (previous?.count ?? 0) + 1;
    const kind = !(previous?.blockingNotified ?? false)
      ? "blocking" as const
      : count >= 3 && !(previous?.persistentNotified ?? false)
        ? "persistent" as const
        : null;
    const condition = healthConditionSchema.parse({
      blockingNotified: (previous?.blockingNotified ?? false) || kind === "blocking",
      count,
      conditionKey,
      lastJobId: input.jobId,
      persistentNotified: (previous?.persistentNotified ?? false) || kind === "persistent",
    });
    const notification = kind === null ? null : Object.freeze({
      definitionVersion: input.definitionVersion,
      kind,
      monitorId: input.monitorId,
      notificationId: `hybrid-health.${digest(JSON.stringify([conditionKey, kind]))}`,
      reasonCodes,
    });
    return {
      next: {
        ...current,
        healthConditions: [
          ...current.healthConditions.filter((item) => item.conditionKey !== conditionKey),
          condition,
        ],
        revision: current.revision + 1,
      },
      result: notification,
    };
  });
}
