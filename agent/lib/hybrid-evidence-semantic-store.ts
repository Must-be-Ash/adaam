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
export const workspaceSemanticEvidenceRoleSchema = z.enum([
  "current",
  "prior",
  "year_ago",
  "section",
  "subject_statement",
  "context_reference",
]);
const memberSchema = z.object({
  memberId: idSchema,
  role: workspaceSemanticEvidenceRoleSchema,
  source: sourceSchema,
}).strict();
const evidenceV1Schema = z.object({
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
const evidenceV2Schema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  lineageKey: idSchema,
  members: z.array(memberSchema).min(1).max(16),
  ownerId: idSchema,
  recordType: z.literal("workspace_semantic_evidence"),
  result: hybridAcceptedResultSchema,
  schemaVersion: z.literal(2),
  source: sourceSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  const singletonRoles = record.members
    .filter(({ role }) => role !== "section" && role !== "context_reference")
    .map(({ role }) => role);
  if (
    record.result.purpose !== "semantic_interpretation" ||
    record.result.scope.kind !== "workspace" ||
    record.result.scope.ownerId !== record.ownerId ||
    record.result.scope.workspaceId !== record.workspaceId ||
    new Set(record.members.map(({ memberId }) => memberId)).size !== record.members.length ||
    new Set(singletonRoles).size !== singletonRoles.length ||
    record.members.filter(({ role }) => role === "subject_statement").length > 1 ||
    record.members.filter(({ role }) => role === "context_reference").length > 5 ||
    !record.members.some(({ source }) => JSON.stringify(source) === JSON.stringify(record.source))
  ) {
    context.addIssue({ code: "custom", message: "workspace_semantic_scope_invalid" });
  }
});
const evidenceSchema = z.union([evidenceV1Schema, evidenceV2Schema]);
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
const headSchema = z.object({
  advancedAt: z.string().datetime({ offset: true }).optional(),
  cause: hybridInvalidationRecordSchema.shape.cause.optional(),
  lineageKey: idSchema,
  previousResultId: idSchema.nullable().optional(),
  resultId: idSchema,
}).strict();
const healthConditionSchema = z.object({
  blockingNotified: z.boolean(),
  blockingPending: z.boolean().optional(),
  count: z.number().int().nonnegative().max(1_000_000),
  conditionKey: digestSchema,
  lastJobId: idSchema,
  persistentNotified: z.boolean(),
  persistentPending: z.boolean().optional(),
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
export type WorkspaceSemanticEvidenceMember = Readonly<z.infer<typeof memberSchema>>;
export type WorkspaceSemanticEvidenceRole = z.infer<typeof workspaceSemanticEvidenceRoleSchema>;
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

export function createWorkspaceSemanticEvidenceMember(input: {
  memberId: string;
  role: WorkspaceSemanticEvidenceRole;
  source: WorkspaceSemanticSource;
}): WorkspaceSemanticEvidenceMember {
  return Object.freeze(memberSchema.parse(input));
}

async function persistWorkspaceSemanticEvidence(
  record: WorkspaceSemanticEvidence,
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceSemanticEvidenceStoreClient,
): Promise<WorkspaceSemanticEvidence> {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  }
  const key = resultKey(scope, record.result.resultId);
  if (!(await client.compareAndSet(key, null, serialized))) {
    const existing = raw(await client.get(key));
    if (existing !== serialized) throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_conflict");
  }
  await updateIndex(scope, client, (current) => ({
    next: current.resultIds.includes(record.result.resultId)
      ? current
      : {
          ...current,
          resultIds: [...current.resultIds, record.result.resultId],
          revision: current.revision + 1,
        },
    result: undefined,
  }));
  return Object.freeze(record);
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
  const record = evidenceV1Schema.parse({
    createdAt: input.now.toISOString(),
    lineageKey: input.lineageKey,
    ownerId: input.scope.ownerId,
    recordType: "workspace_semantic_evidence",
    result,
    schemaVersion: 1,
    source: input.source,
    workspaceId: input.scope.workspaceId,
  });
  return persistWorkspaceSemanticEvidence(record, input.scope, client);
}

export async function writeWorkspaceSemanticEvidenceBundle(input: {
  lineageKey: string;
  members: readonly WorkspaceSemanticEvidenceMember[];
  now: Date;
  result: HybridAcceptedResult;
  scope: AuthorizedWorkspaceStoreScope;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<WorkspaceSemanticEvidence> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const result = hybridAcceptedResultSchema.parse(input.result);
  const members = input.members.map((member) => memberSchema.parse(member));
  const primary = members.find(({ role }) => role === "current") ?? members[0];
  if (!primary) throw new WorkspaceSemanticEvidenceStoreError("semantic_evidence_corrupt");
  const record = evidenceV2Schema.parse({
    createdAt: input.now.toISOString(),
    lineageKey: input.lineageKey,
    members,
    ownerId: input.scope.ownerId,
    recordType: "workspace_semantic_evidence",
    result,
    schemaVersion: 2,
    source: primary.source,
    workspaceId: input.scope.workspaceId,
  });
  return persistWorkspaceSemanticEvidence(record, input.scope, client);
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
  usage?: Readonly<{ inputTokens: number; outputTokens: number; paidCostUsd: string }>;
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
    usage: result?.usage ?? input.usage ?? { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" },
  });
  return updateIndex(input.scope, client, (current) => {
    const index = current.jobs.findIndex(({ jobId }) => jobId === job.jobId);
    const jobs = [...current.jobs];
    const durableSummary = index >= 0 && !input.result && !input.usage
      ? jobSummarySchema.parse({ ...summary, usage: jobs[index]!.usage })
      : summary;
    if (index >= 0) jobs[index] = durableSummary;
    else jobs.push(summary);
    return {
      next: { ...current, jobs: jobs.slice(-256), revision: current.revision + 1 },
      result: Object.freeze(durableSummary),
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
  let cause = input.cause;
  let advancedAt = input.now.toISOString();
  await updateIndex(input.scope, clients.semantic ?? store(), (current) => {
    const currentHead = current.heads.find(({ lineageKey }) => lineageKey === input.lineageKey);
    if (currentHead?.resultId === input.resultId) {
      previousResultId = currentHead.previousResultId ?? null;
      cause = currentHead.cause ?? cause;
      advancedAt = currentHead.advancedAt ?? advancedAt;
      return { next: current, result: undefined };
    }
    previousResultId = currentHead?.resultId ?? null;
    return {
      next: {
        ...current,
        heads: [
          ...current.heads.filter(({ lineageKey }) => lineageKey !== input.lineageKey),
          {
            advancedAt,
            cause,
            lineageKey: input.lineageKey,
            previousResultId,
            resultId: input.resultId,
          },
        ],
        revision: current.revision + 1,
      },
      result: undefined,
    };
  });
  if (!previousResultId) return null;
  const invalidation = hybridInvalidationRecordSchema.parse({
    cause,
    createdAt: advancedAt,
    invalidationId: `hybrid-invalidation.${digest(JSON.stringify([
      input.scope.ownerId,
      input.scope.workspaceId,
      previousResultId,
      input.resultId,
      cause,
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
    const sameJob = previous?.lastJobId === input.jobId;
    const count = (previous?.count ?? 0) + (sameJob ? 0 : 1);
    const blockingPending = previous?.blockingPending ?? false;
    const persistentPending = previous?.persistentPending ?? false;
    const kind = blockingPending || !(previous?.blockingNotified ?? false)
      ? "blocking" as const
      : persistentPending || (count >= 3 && !(previous?.persistentNotified ?? false))
        ? "persistent" as const
        : null;
    const condition = healthConditionSchema.parse({
      blockingNotified: previous?.blockingNotified ?? false,
      blockingPending: kind === "blocking",
      count,
      conditionKey,
      lastJobId: input.jobId,
      persistentNotified: previous?.persistentNotified ?? false,
      persistentPending: kind === "persistent",
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

export async function acknowledgeWorkspaceSemanticHealthNotification(input: {
  notificationId: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: WorkspaceSemanticEvidenceStoreClient = store()): Promise<void> {
  await updateIndex(input.scope, client, (current) => {
    const index = current.healthConditions.findIndex((condition) =>
      (condition.blockingPending === true &&
        `hybrid-health.${digest(JSON.stringify([condition.conditionKey, "blocking"]))}` === input.notificationId) ||
      (condition.persistentPending === true &&
        `hybrid-health.${digest(JSON.stringify([condition.conditionKey, "persistent"]))}` === input.notificationId));
    if (index < 0) return { next: current, result: undefined };
    const conditions = [...current.healthConditions];
    const condition = conditions[index]!;
    const blocking = condition.blockingPending === true;
    conditions[index] = healthConditionSchema.parse({
      ...condition,
      blockingNotified: condition.blockingNotified || blocking,
      blockingPending: false,
      persistentNotified: condition.persistentNotified || !blocking,
      persistentPending: false,
    });
    return {
      next: { ...current, healthConditions: conditions, revision: current.revision + 1 },
      result: undefined,
    };
  });
}
