import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";
import { assertAuthorizedWorkspaceStoreScope, type AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

import {
  HYBRID_EVIDENCE_LIMITS,
  digestHybridEvidenceValue,
  evidenceArtifactManifestSchema,
  evidenceLocatorSchema,
  hybridAcceptedResultSchema,
  hybridEvidenceErrorCodeSchema,
  hybridEvidenceJobDefinitionSchema,
  hybridEvidenceJobSchema,
  hybridEvidenceScopeSchema,
  type EvidenceArtifactManifest,
  type EvidenceLocator,
  type HybridAcceptedResult,
  type HybridEvidenceJob,
  type HybridEvidenceJobDefinition,
} from "./hybrid-evidence-schema";
import {
  hybridEvidenceResearchDecisionSchema,
  normalizeHybridEvidenceResearchUrl,
} from "./hybrid-evidence-research";

const KEY_PREFIX = "eve:hybrid-evidence:v1:job:";
const MAX_CAS_ATTEMPTS = 8;
const MAX_RECORD_BYTES = 512 * 1_024;
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
const observationField = z.string().regex(/^[A-Za-z0-9_./:@-]{1,160}$/u);
const recoveryObservationSchema = z.object({
  acquisitionId: observationField, definitionId: observationField, definitionVersion: observationField,
  docId: observationField, jobId: observationField.nullable(), modelId: observationField,
  sourceInstanceId: observationField, outcome: z.enum(["failed", "accepted", "reused"]),
  code: observationField.optional(), detail: observationField.optional(), stage: observationField.optional(),
  resultId: observationField.optional(), rowCount: z.number().int().nonnegative().max(2000).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    paidCostUsd: z.string().regex(/^[0-9]+(?:\.[0-9]{1,6})?$/u) }).strict().optional(),
  recordedAt: z.string().datetime(),
}).strict();
const observationsSchema = z.array(recoveryObservationSchema).max(32);

function observationsKey(scope: AuthorizedWorkspaceStoreScope) {
  assertAuthorizedWorkspaceStoreScope(scope);
  return `${KEY_PREFIX}observations:${tokenDigest(`${scope.ownerId}:${scope.workspaceId}`)}`;
}

/** Bounded, scoped diagnostic receipts contain codes and public IDs, never prompts or credentials. */
export async function recordHybridEvidenceRecoveryObservation(input: {
  scope: AuthorizedWorkspaceStoreScope; observation: unknown; now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<void> {
  const now = input.now ?? new Date();
  const observation = recoveryObservationSchema.parse({ ...(input.observation as object), recordedAt: now.toISOString() });
  const key = observationsKey(input.scope);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const raw = rawValue(await client.get(key));
    const previous = raw ? observationsSchema.parse(JSON.parse(raw)) : [];
    const next = [...previous.filter((entry) => Date.parse(entry.recordedAt) > now.getTime() - 14 * 86_400_000), observation].slice(-32);
    if (await client.compareAndSet(key, raw, JSON.stringify(next))) return;
  }
  throw new HybridEvidenceJobStoreError("job_conflict");
}

export async function readHybridEvidenceRecoveryObservations(scope: AuthorizedWorkspaceStoreScope,
  client: HybridEvidenceJobStoreClient = store()) {
  const raw = rawValue(await client.get(observationsKey(scope)));
  return (raw ? observationsSchema.parse(JSON.parse(raw)) : []).filter((entry) =>
    Date.parse(entry.recordedAt) > Date.now() - 14 * 86_400_000);
}
const recoveryUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(1_000_000),
  outputTokens: z.number().int().nonnegative().max(1_000_000),
  paidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/u).optional(),
}).strict();
export const hybridEvidenceAttemptReceiptSchema = z.object({
  admissionExpiresAt: z.string().datetime().optional(),
  cancellationCompleted: z.literal(true).optional(),
  lane: z.enum(["source_global_extraction", "workspace_semantic"]),
  reservationKey: z.string().min(1).max(300),
  workspace: z.object({
    ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
    workspaceId: z.string().uuid(),
  }).strict().nullable(),
}).strict();
export type HybridEvidenceAttemptReceipt = z.infer<typeof hybridEvidenceAttemptReceiptSchema>;
export type HybridEvidenceRecoveryUsage = z.infer<typeof recoveryUsageSchema>;
const independentEvidenceSchema = z.object({
  expiresAt: z.string().datetime().nullable().default(null),
  claimTokenDigest: digestSchema,
  state: z.enum(["running", "completed", "uncertain"]),
  textByPage: z.array(z.tuple([z.number().int().min(1).max(8), z.string().max(16_000)])).max(8),
  usage: recoveryUsageSchema.nullable(),
  pageUsage: z.array(z.tuple([z.number().int().min(1).max(8), recoveryUsageSchema])).max(8).default([]),
}).strict();
const candidateSchema = z.record(z.string().min(1).max(120), z.unknown()).superRefine(
  (candidate, context) => {
    try {
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > HYBRID_EVIDENCE_LIMITS.maximumPayloadBytes) {
        context.addIssue({ code: "custom", message: "candidate_out_of_bounds" });
      }
    } catch {
      context.addIssue({ code: "custom", message: "candidate_out_of_bounds" });
    }
  },
);
const recordSchema = z.object({
  acceptedResult: hybridAcceptedResultSchema.nullable(),
  candidate: candidateSchema.nullable(),
  candidateDigest: digestSchema.nullable(),
  claimTokenDigest: digestSchema.nullable(),
  claimExpiresAt: z.string().datetime().nullable().default(null),
  attemptReceipt: hybridEvidenceAttemptReceiptSchema.nullable().default(null),
  extractionUsage: recoveryUsageSchema.nullable().default(null),
  independentEvidence: independentEvidenceSchema.nullable().default(null),
  retainedIndependentPages: z.array(z.tuple([z.number().int().min(1).max(8), z.string().max(16_000)])).max(8).default([]),
  admissionRevision: z.number().int().nonnegative().default(0),
  admissionDenied: z.boolean().default(false),
  admission: z.object({ tokenDigest: digestSchema, expiresAt: z.string().datetime() }).strict().nullable().default(null),
  cancelledAdmissions: z.array(hybridEvidenceAttemptReceiptSchema).max(512).default([]),
  failureCode: hybridEvidenceErrorCodeSchema.nullable(),
  job: hybridEvidenceJobSchema,
  quarantineCodes: z.array(hybridEvidenceErrorCodeSchema).max(16),
  researchDecision: hybridEvidenceResearchDecisionSchema.nullable().default(null),
  researchFetchCompleted: z.boolean().default(false),
  researchSearchCompleted: z.boolean().default(false),
  researchUrlGrants: z.array(z.string().url().max(2_048)).max(5).default([]),
  recordType: z.literal("hybrid_evidence_job_record"),
  schemaVersion: z.literal(1),
}).strict();

export type HybridEvidenceJobRecord = Readonly<z.infer<typeof recordSchema>>;

export interface HybridEvidenceJobStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class HybridEvidenceJobStoreError extends Error {
  constructor(readonly code:
    | "artifact_digest_mismatch"
    | "definition_digest_mismatch"
    | "input_projection_invalid"
    | "job_conflict"
    | "job_not_found"
    | "job_record_corrupt"
    | "model_denied"
    | "workspace_scope_mismatch") {
    super(code);
    this.name = "HybridEvidenceJobStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: HybridEvidenceJobStoreClient | undefined;

function store(): HybridEvidenceJobStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new HybridEvidenceJobStoreError("job_record_corrupt");
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

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function recordKey(jobId: string): string {
  return `${KEY_PREFIX}${createHash("sha256").update(jobId).digest("hex")}`;
}

function parseRecord(raw: string | null): HybridEvidenceJobRecord | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new HybridEvidenceJobStoreError("job_record_corrupt");
  }
  try {
    return Object.freeze(recordSchema.parse(JSON.parse(raw)));
  } catch {
    throw new HybridEvidenceJobStoreError("job_record_corrupt");
  }
}

function serialize(record: HybridEvidenceJobRecord): string {
  const parsed = recordSchema.safeParse(record);
  if (!parsed.success) throw new HybridEvidenceJobStoreError("job_record_corrupt");
  const raw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new HybridEvidenceJobStoreError("job_record_corrupt");
  }
  return raw;
}

async function updateRecord<T>(input: {
  client: HybridEvidenceJobStoreClient;
  jobId: string;
  mutate: (record: HybridEvidenceJobRecord | null) => {
    record: HybridEvidenceJobRecord;
    result: T;
  };
}): Promise<T> {
  const key = recordKey(input.jobId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await input.client.get(key));
    const mutation = input.mutate(parseRecord(currentRaw));
    if (await input.client.compareAndSet(key, currentRaw, serialize(mutation.record))) {
      return mutation.result;
    }
  }
  throw new HybridEvidenceJobStoreError("job_conflict");
}

function normalizeScopeForReuse(scope: z.infer<typeof hybridEvidenceScopeSchema>) {
  return scope.kind === "source_global"
    ? { kind: scope.kind, sourceInstanceId: scope.sourceInstanceId }
    : scope;
}

export function deriveHybridEvidenceInputDigest(input: {
  artifacts: readonly EvidenceArtifactManifest[];
  definition: HybridEvidenceJobDefinition;
  inputContextDigest?: string;
  locators: readonly EvidenceLocator[];
  modelId: string;
  scope: z.infer<typeof hybridEvidenceScopeSchema>;
}): string {
  return digestHybridEvidenceValue({
    artifactDigests: input.artifacts.map(({ contentDigest }) => contentDigest).sort(),
    definitionDigest: input.definition.definitionDigest,
    inputContextDigest: input.inputContextDigest ?? null,
    locatorDigests: input.locators.map(digestHybridEvidenceValue).sort(),
    modelId: input.modelId,
    scope: normalizeScopeForReuse(input.scope),
  });
}

export async function prepareHybridEvidenceJob(input: {
  artifacts: readonly EvidenceArtifactManifest[];
  definition: HybridEvidenceJobDefinition;
  inputContextDigest?: string;
  inputProjection?: unknown;
  locators: readonly EvidenceLocator[];
  modelId: string;
  now?: Date;
  scope: z.infer<typeof hybridEvidenceScopeSchema>;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const definition = hybridEvidenceJobDefinitionSchema.parse(input.definition);
  const scope = hybridEvidenceScopeSchema.parse(input.scope);
  const artifacts = input.artifacts.map((artifact) => evidenceArtifactManifestSchema.parse(artifact));
  const locators = input.locators.map((locator) => evidenceLocatorSchema.parse(locator));
  if (!definition.allowedModelIds.includes(input.modelId)) {
    throw new HybridEvidenceJobStoreError("model_denied");
  }
  if (
    artifacts.some((artifact) =>
      artifact.accessClassification !== "public" ||
      !definition.allowedMediaTypes.includes(artifact.mediaType) ||
      (artifact.parserEligibility !== null &&
        !definition.allowedAdapterIds.includes(artifact.parserEligibility.adapterId))
    ) ||
    locators.some((locator) =>
      "artifactDigest" in locator &&
      !artifacts.some(({ contentDigest }) => contentDigest === locator.artifactDigest)
    )
  ) {
    throw new HybridEvidenceJobStoreError("artifact_digest_mismatch");
  }
  const inputDigest = deriveHybridEvidenceInputDigest({
    artifacts,
    definition,
    inputContextDigest: input.inputContextDigest,
    locators,
    modelId: input.modelId,
    scope,
  });
  const inputProjectionDigest = input.inputProjection === undefined
    ? undefined
    : digestHybridEvidenceValue(input.inputProjection);
  if (
    inputProjectionDigest !== undefined &&
    input.inputContextDigest !== inputProjectionDigest
  ) throw new HybridEvidenceJobStoreError("input_projection_invalid");
  const jobId = `hybrid-job.${inputDigest}`;
  const timestamp = (input.now ?? new Date()).toISOString();
  const job = hybridEvidenceJobSchema.parse({
    artifactDigests: artifacts.map(({ contentDigest }) => contentDigest).sort(),
    attempt: 0,
    budgetReservation: {
      key: `hybrid:${jobId}:attempt:1`,
      kind: "hybrid_model_attempt",
      scope: scope.kind === "source_global" ? "deployment_source_recovery" : "workspace",
    },
    completedAt: null,
    createdAt: timestamp,
    definitionDigest: definition.definitionDigest,
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
    idempotencyKey: inputDigest,
    inputDigest,
    ...(inputProjectionDigest === undefined ? {} : { inputProjectionDigest }),
    jobId,
    locatorDigests: locators.map(digestHybridEvidenceValue).sort(),
    modelId: input.modelId,
    purpose: definition.purpose,
    recordType: "hybrid_evidence_job",
    schemaVersion: 1,
    scope,
    startedAt: null,
    state: "prepared",
    updatedAt: timestamp,
  });
  return updateRecord({
    client,
    jobId,
    mutate(current) {
      if (current) {
        if (
          current.job.inputDigest !== inputDigest ||
          current.job.definitionDigest !== definition.definitionDigest ||
          (scope.kind === "workspace" && JSON.stringify(current.job.scope) !== JSON.stringify(scope))
        ) {
          throw new HybridEvidenceJobStoreError("job_conflict");
        }
        if (current.job.state === "prepared" && current.admissionDenied && scope.kind === "source_global") {
          const rebound = recordSchema.parse({
            ...current,
            admissionDenied: false,
            job: { ...current.job, scope, updatedAt: timestamp },
          });
          return { record: rebound, result: rebound };
        }
        return { record: current, result: current };
      }
      const record = Object.freeze({
        acceptedResult: null,
        candidate: null,
        candidateDigest: null,
        claimTokenDigest: null,
        claimExpiresAt: null,
        attemptReceipt: null,
        extractionUsage: null,
        independentEvidence: null,
        retainedIndependentPages: [],
        admissionRevision: 0,
        admissionDenied: false,
        admission: null,
        cancelledAdmissions: [],
        failureCode: null,
        job,
        quarantineCodes: [],
        researchDecision: null,
        researchFetchCompleted: false,
        researchSearchCompleted: false,
        researchUrlGrants: [],
        recordType: "hybrid_evidence_job_record" as const,
        schemaVersion: 1 as const,
      });
      return { record, result: record };
    },
  });
}

export async function persistHybridEvidenceResearchDecision(input: {
  claimToken: string;
  decision: z.input<typeof hybridEvidenceResearchDecisionSchema>;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const decision = hybridEvidenceResearchDecisionSchema.parse(input.decision);
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (
        current.job.state !== "running" ||
        current.claimTokenDigest !== tokenDigest(input.claimToken)
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      if (current.researchDecision !== null) {
        if (JSON.stringify(current.researchDecision) !== JSON.stringify(decision)) {
          throw new HybridEvidenceJobStoreError("job_conflict");
        }
        return { record: current, result: current };
      }
      const next = recordSchema.parse({
        ...current,
        job: { ...current.job, updatedAt: timestamp },
        researchDecision: decision,
      });
      return { record: next, result: next };
    },
  });
}

export async function persistHybridEvidenceResearchSearch(input: {
  claimToken: string;
  jobId: string;
  now?: Date;
  urls: readonly string[];
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const urls = [...new Set(input.urls.map(normalizeHybridEvidenceResearchUrl))]
    .sort()
    .slice(0, 5);
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (
        current.job.state !== "running" ||
        current.claimTokenDigest !== tokenDigest(input.claimToken) ||
        current.researchDecision?.decision !== "research_needed"
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      if (current.researchSearchCompleted) {
        if (JSON.stringify(current.researchUrlGrants) !== JSON.stringify(urls)) {
          throw new HybridEvidenceJobStoreError("job_conflict");
        }
        return { record: current, result: current };
      }
      const next = recordSchema.parse({
        ...current,
        job: { ...current.job, updatedAt: timestamp },
        researchSearchCompleted: true,
        researchUrlGrants: urls,
      });
      return { record: next, result: next };
    },
  });
}

export async function persistHybridEvidenceResearchFetchCompletion(input: {
  claimToken: string;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (
        current.job.state !== "running" ||
        current.claimTokenDigest !== tokenDigest(input.claimToken) ||
        current.researchDecision?.decision !== "research_needed" ||
        !current.researchSearchCompleted
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      if (current.researchFetchCompleted) return { record: current, result: current };
      const next = recordSchema.parse({
        ...current,
        job: { ...current.job, updatedAt: timestamp },
        researchFetchCompleted: true,
      });
      return { record: next, result: next };
    },
  });
}

export async function readHybridEvidenceJob(
  jobId: string,
  client: HybridEvidenceJobStoreClient = store(),
): Promise<HybridEvidenceJobRecord | null> {
  return parseRecord(rawValue(await client.get(recordKey(jobId))));
}

const DEFAULT_JOB_SETTLEMENT_POLL_INTERVAL_MS = 100;

/**
 * Wait for the canonical durable record to leave its worker-owned states.
 *
 * Eve event streams are reconnectable transport connections, not an
 * authoritative completion signal. In particular, the stream can end before
 * the completion tool's Redis commit becomes visible to its parent workflow.
 */
export async function waitForHybridEvidenceJobSettlement(input: {
  jobId: string;
  maximumWaitMs: number;
  pollIntervalMs?: number;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord | null> {
  const maximumWaitMs = Math.max(0, Math.floor(input.maximumWaitMs));
  let pollIntervalMs = Math.max(
    1,
    Math.floor(input.pollIntervalMs ?? DEFAULT_JOB_SETTLEMENT_POLL_INTERVAL_MS),
  );
  const deadline = Date.now() + maximumWaitMs;
  let record = await readHybridEvidenceJob(input.jobId, client);
  while (
    record &&
    (record.job.state === "prepared" || record.job.state === "running") &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    });
    record = await readHybridEvidenceJob(input.jobId, client);
    pollIntervalMs = Math.min(1_000, pollIntervalMs * 2);
  }
  return record;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function claimHybridEvidenceJob(input: {
  admissionToken?: string;
  attemptReceipt?: HybridEvidenceAttemptReceipt;
  claimToken: string;
  expiresAt?: Date;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const digest = tokenDigest(input.claimToken);
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === "running" && current.claimTokenDigest === digest) {
        return { record: current, result: current };
      }
      if (current.job.state !== "prepared") {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      if (current.admission && (current.admission.tokenDigest !== tokenDigest(input.admissionToken ?? "") ||
        Date.parse(current.admission.expiresAt) <= Date.parse(timestamp))) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      if (input.attemptReceipt && (
        input.attemptReceipt.reservationKey !== current.job.budgetReservation.key ||
        (current.job.scope.kind === "source_global" && input.attemptReceipt.workspace &&
          input.attemptReceipt.workspace.workspaceId !== current.job.scope.initiatingWorkspaceId) ||
        (current.job.scope.kind === "workspace" && (
          input.attemptReceipt.workspace?.workspaceId !== current.job.scope.workspaceId ||
          input.attemptReceipt.workspace.ownerId !== current.job.scope.ownerId
        ))
      )) throw new HybridEvidenceJobStoreError("workspace_scope_mismatch");
      const running = recordSchema.parse({
        ...current,
        claimTokenDigest: digest,
        admission: null,
        claimExpiresAt: input.expiresAt?.toISOString() ?? null,
        attemptReceipt: input.attemptReceipt ?? null,
        job: {
          ...current.job,
          attempt: current.job.attempt + 1,
          startedAt: timestamp,
          state: "running",
          updatedAt: timestamp,
        },
      });
      return { record: running, result: running };
    },
  });
}

/** Own admission before touching either ledger. Every lease has its own key. */
export async function claimHybridEvidenceJobAdmission(input: {
  jobId: string;
  token: string;
  workspace: HybridEvidenceAttemptReceipt["workspace"];
  initiatingWorkspaceId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const now = input.now ?? new Date();
  return updateRecord({ client, jobId: input.jobId, mutate(current) {
    if (!current || current.job.state !== "prepared" || current.job.scope.kind !== "source_global" ||
      (current.admission && Date.parse(current.admission.expiresAt) > now.getTime())) {
      throw new HybridEvidenceJobStoreError("job_conflict");
    }
    const revision = current.admissionRevision + 1;
    const reservationKey = `hybrid:${current.job.jobId}:attempt:${current.job.attempt + 1}:admission:${revision}`;
    const next = recordSchema.parse({ ...current,
      admission: { tokenDigest: tokenDigest(input.token), expiresAt: new Date(now.getTime() + 120_000).toISOString() },
      admissionRevision: revision, admissionDenied: false,
      // Never forget a cancelled key before its ledger writes can be repaired.
      cancelledAdmissions: [...current.cancelledAdmissions,
        ...(current.admission && current.attemptReceipt ? [current.attemptReceipt] : [])],
      attemptReceipt: { lane: "source_global_extraction", reservationKey, workspace: input.workspace,
        admissionExpiresAt: new Date(now.getTime() + 120_000).toISOString() },
      job: { ...current.job, scope: { ...current.job.scope, initiatingWorkspaceId: input.initiatingWorkspaceId },
        budgetReservation: { ...current.job.budgetReservation, key: reservationKey }, updatedAt: now.toISOString() },
    });
    return { record: next, result: next };
  } });
}

/** Only an expired claim is uncertain. A competing caller cannot revoke live work. */
export async function expireHybridEvidenceJobClaim(input: {
  definition: HybridEvidenceJobDefinition;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const now = input.now ?? new Date();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.definitionDigest !== input.definition.definitionDigest) {
        throw new HybridEvidenceJobStoreError("definition_digest_mismatch");
      }
      const expiry = current.claimExpiresAt ?? (current.job.startedAt
        ? new Date(Date.parse(current.job.startedAt) + input.definition.limits.maximumRuntimeMs).toISOString()
        : null);
      if (current.job.state !== "running" || !expiry || now.getTime() <= Date.parse(expiry)) {
        return { record: current, result: current };
      }
      const next = recordSchema.parse({
        ...current,
        failureCode: "execution_uncertain",
        job: { ...current.job, completedAt: now.toISOString(), state: "uncertain", updatedAt: now.toISOString() },
      });
      return { record: next, result: next };
    },
  });
}

/** Pre-dispatch denial can be retried by another subscriber, without reusing a released key. */
export async function resetHybridEvidenceJobAdmission(input: {
  admissionToken?: string;
  ownerCompleted?: boolean;
  jobId: string;
  reservationKey: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state !== "prepared" || current.claimTokenDigest !== null ||
        current.job.budgetReservation.key !== input.reservationKey ||
        (current.admission && current.admission.tokenDigest !== tokenDigest(input.admissionToken ?? ""))) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const revision = current.admissionRevision + 1;
      const next = recordSchema.parse({
        ...current,
        admissionDenied: true,
        admission: null,
        attemptReceipt: null,
        cancelledAdmissions: [...current.cancelledAdmissions, ...(current.attemptReceipt ? [{ ...current.attemptReceipt,
          ...(input.ownerCompleted ? { cancellationCompleted: true as const } : {}) }] : [])],
        admissionRevision: revision,
        job: {
          ...current.job,
          budgetReservation: { ...current.job.budgetReservation,
            key: `hybrid:${current.job.jobId}:attempt:${current.job.attempt + 1}:admission:${revision}` },
          updatedAt: (input.now ?? new Date()).toISOString(),
        },
      });
      return { record: next, result: next };
    },
  });
}

/** Forget only owner-completed denials after both ledger repairs succeeded. */
export async function pruneCompletedHybridEvidenceAdmissions(input: {
  jobId: string; reservationKeys: readonly string[];
}, client: HybridEvidenceJobStoreClient = store()): Promise<void> {
  const repaired = new Set(input.reservationKeys);
  await updateRecord({ client, jobId: input.jobId, mutate(current) {
    if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
    const record = recordSchema.parse({ ...current, cancelledAdmissions: current.cancelledAdmissions.filter((receipt) =>
      !receipt.cancellationCompleted || !repaired.has(receipt.reservationKey)) });
    return { record, result: undefined };
  } });
}

export async function persistHybridEvidenceExtractionUsage(input: {
  claimToken: string;
  jobId: string;
  usage: HybridEvidenceRecoveryUsage;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const usage = recoveryUsageSchema.parse(input.usage);
  return updateRecord({ client, jobId: input.jobId, mutate(current) {
    if (!current || current.job.state !== "completed" ||
      current.claimTokenDigest !== tokenDigest(input.claimToken)) {
      throw new HybridEvidenceJobStoreError("job_conflict");
    }
    if (current.extractionUsage && JSON.stringify(current.extractionUsage) !== JSON.stringify(usage)) {
      throw new HybridEvidenceJobStoreError("job_conflict");
    }
    const next = recordSchema.parse({ ...current, extractionUsage: usage });
    return { record: next, result: next };
  } });
}

/** An interrupted OCR phase is retained, never silently purchased a second time. */
export async function persistHybridEvidenceIndependentEvidence(input: {
  claimToken: string;
  jobId: string;
  state: "running" | "completed" | "uncertain";
  textByPage?: readonly (readonly [number, string])[];
  usage?: HybridEvidenceRecoveryUsage;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const evidence = independentEvidenceSchema.parse({
    expiresAt: input.state === "running" ? new Date(Date.now() + 90_000).toISOString() : null,
    claimTokenDigest: tokenDigest(input.claimToken),
    state: input.state,
    textByPage: input.textByPage ?? [],
    usage: input.usage ?? null,
  });
  return updateRecord({ client, jobId: input.jobId, mutate(current) {
    if (!current || current.job.state !== "completed") throw new HybridEvidenceJobStoreError("job_conflict");
    const previous = current.independentEvidence;
    if (previous?.state === "completed" && JSON.stringify(previous) === JSON.stringify(evidence)) {
      return { record: current, result: current };
    }
    if ((!previous && evidence.state !== "running") || (previous && (
      previous.claimTokenDigest !== evidence.claimTokenDigest || previous.state !== "running"
    ))) throw new HybridEvidenceJobStoreError("job_conflict");
    const next = recordSchema.parse({ ...current, independentEvidence: input.state === "uncertain" ? {
      ...evidence, textByPage: input.textByPage ?? previous?.textByPage ?? [],
      usage: input.usage ?? previous?.usage ?? null, pageUsage: previous?.pageUsage ?? [],
    } : evidence });
    return { record: next, result: next };
  } });
}

export async function persistHybridEvidenceIndependentPage(input: {
  claimToken: string; jobId: string; page: number; text: string; usage: HybridEvidenceRecoveryUsage;
}, client: HybridEvidenceJobStoreClient = store()): Promise<void> {
  await updateRecord({ client, jobId: input.jobId, mutate(current) {
    const phase = current?.independentEvidence;
    if (!current || current.job.state !== "completed" || phase?.state !== "running" ||
      phase.claimTokenDigest !== tokenDigest(input.claimToken)) throw new HybridEvidenceJobStoreError("job_conflict");
    const texts = new Map(phase.textByPage);
    const usages = new Map(phase.pageUsage);
    if (texts.has(input.page) && (texts.get(input.page) !== input.text || JSON.stringify(usages.get(input.page)) !== JSON.stringify(input.usage))) {
      throw new HybridEvidenceJobStoreError("job_conflict");
    }
    texts.set(input.page, input.text); usages.set(input.page, input.usage);
    const next = recordSchema.parse({ ...current, independentEvidence: { ...phase,
      textByPage: [...texts.entries()], pageUsage: [...usages.entries()],
    } });
    return { record: next, result: undefined };
  } });
}

/** Resume only the unpaid/missing OCR pages under a fresh, bounded admission.
 * The old allowance remains uncertain; a paid extraction is never repeated. */
export async function retryHybridEvidenceIndependentPhase(input: {
  definition: HybridEvidenceJobDefinition; jobId: string; now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const now = input.now ?? new Date();
  return updateRecord({ client, jobId: input.jobId, mutate(current) {
    const phase = current?.independentEvidence;
    if (!current || current.job.state !== "completed" || !current.candidate || !phase ||
      current.job.definitionDigest !== input.definition.definitionDigest ||
      current.job.attempt >= input.definition.limits.maximumAttempts ||
      (phase.state !== "uncertain" && !(phase.state === "running" && phase.expiresAt && Date.parse(phase.expiresAt) < now.getTime()))) {
      throw new HybridEvidenceJobStoreError("job_conflict");
    }
    const next = recordSchema.parse({ ...current,
      claimTokenDigest: null, claimExpiresAt: null, attemptReceipt: null, independentEvidence: null,
      retainedIndependentPages: [...new Map([...current.retainedIndependentPages, ...phase.textByPage]).entries()],
      extractionUsage: { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" },
      job: { ...current.job, state: "prepared", completedAt: null, startedAt: null, updatedAt: now.toISOString(),
        budgetReservation: { ...current.job.budgetReservation, key: `hybrid:${current.job.jobId}:attempt:${current.job.attempt + 1}` } },
    });
    return { record: next, result: next };
  } });
}

export async function retryUncertainHybridEvidenceJob(input: {
  definition: HybridEvidenceJobDefinition;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const definition = hybridEvidenceJobDefinitionSchema.parse(input.definition);
  const requestedTimestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (
        current.job.definitionDigest !== definition.definitionDigest ||
        current.job.state !== "uncertain" ||
        current.job.attempt >= definition.limits.maximumAttempts
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const timestamp = requestedTimestamp < current.job.updatedAt
        ? current.job.updatedAt
        : requestedTimestamp;
      const nextAttempt = current.job.attempt + 1;
      const prepared = recordSchema.parse({
        ...current,
        acceptedResult: null,
        candidate: null,
        candidateDigest: null,
        claimTokenDigest: null,
        claimExpiresAt: null,
        attemptReceipt: null,
        extractionUsage: null,
        independentEvidence: null,
        failureCode: null,
        job: {
          ...current.job,
          budgetReservation: {
            ...current.job.budgetReservation,
            key: `hybrid:${current.job.jobId}:attempt:${nextAttempt}`,
          },
          completedAt: null,
          startedAt: null,
          state: "prepared",
          updatedAt: timestamp,
        },
        quarantineCodes: [],
        researchDecision: null,
        researchFetchCompleted: false,
        researchSearchCompleted: false,
        researchUrlGrants: [],
      });
      return { record: prepared, result: prepared };
    },
  });
}

export async function completeHybridEvidenceJob(input: {
  candidate: Record<string, unknown>;
  claimToken: string;
  jobId: string;
  now?: Date;
  usage?: HybridEvidenceRecoveryUsage;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const candidate = candidateSchema.parse(input.candidate);
  const candidateDigest = digestHybridEvidenceValue(candidate);
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === "completed" && current.candidateDigest === candidateDigest &&
        current.claimTokenDigest === tokenDigest(input.claimToken)) {
        return { record: current, result: current };
      }
      if (
        current.job.state !== "running" ||
        current.claimTokenDigest !== tokenDigest(input.claimToken)
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const completed = recordSchema.parse({
        ...current,
        candidate,
        candidateDigest,
        extractionUsage: input.usage ?? current.extractionUsage,
        job: { ...current.job, completedAt: timestamp, state: "completed", updatedAt: timestamp },
      });
      return { record: completed, result: completed };
    },
  });
}

export async function acceptHybridEvidenceJob(input: {
  jobId: string;
  now?: Date;
  result: HybridAcceptedResult;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const result = hybridAcceptedResultSchema.parse(input.result);
  const requestedTimestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === "accepted" && current.acceptedResult?.resultId === result.resultId) {
        return { record: current, result: current };
      }
      if (
        current.job.state !== "completed" ||
        result.jobId !== current.job.jobId ||
        result.inputDigest !== current.job.inputDigest ||
        result.definition.definitionDigest !== current.job.definitionDigest ||
        result.model.modelId !== current.job.modelId ||
        JSON.stringify(result.scope) !== JSON.stringify(current.job.scope)
      ) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const timestamp = requestedTimestamp < current.job.updatedAt
        ? current.job.updatedAt
        : requestedTimestamp;
      const accepted = recordSchema.parse({
        ...current,
        acceptedResult: result,
        job: { ...current.job, state: "accepted", updatedAt: timestamp },
      });
      return { record: accepted, result: accepted };
    },
  });
}

export async function quarantineHybridEvidenceJob(input: {
  codes: readonly z.infer<typeof hybridEvidenceErrorCodeSchema>[];
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const codes = [...new Set(input.codes)].sort();
  const requestedTimestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === "quarantined" && JSON.stringify(current.quarantineCodes) === JSON.stringify(codes)) {
        return { record: current, result: current };
      }
      if (current.job.state !== "completed" || codes.length === 0) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const timestamp = requestedTimestamp < current.job.updatedAt
        ? current.job.updatedAt
        : requestedTimestamp;
      const quarantined = recordSchema.parse({
        ...current,
        failureCode: codes[0],
        job: { ...current.job, state: "quarantined", updatedAt: timestamp },
        quarantineCodes: codes,
      });
      return { record: quarantined, result: quarantined };
    },
  });
}

async function terminateHybridEvidenceJob(input: {
  code: z.infer<typeof hybridEvidenceErrorCodeSchema>;
  jobId: string;
  now?: Date;
  state: "failed" | "uncertain";
}, client: HybridEvidenceJobStoreClient): Promise<HybridEvidenceJobRecord> {
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === input.state && current.failureCode === input.code) {
        return { record: current, result: current };
      }
      if (!(["prepared", "running"] as const).includes(current.job.state as "prepared" | "running")) {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const startedAt = current.job.startedAt ?? timestamp;
      const terminal = recordSchema.parse({
        ...current,
        failureCode: input.code,
        job: {
          ...current.job,
          attempt: Math.max(1, current.job.attempt),
          completedAt: timestamp,
          startedAt,
          state: input.state,
          updatedAt: timestamp,
        },
      });
      return { record: terminal, result: terminal };
    },
  });
}

export function failHybridEvidenceJob(input: {
  code: z.infer<typeof hybridEvidenceErrorCodeSchema>;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()) {
  return terminateHybridEvidenceJob({ ...input, state: "failed" }, client);
}

export function markHybridEvidenceJobUncertain(input: {
  code?: "execution_uncertain";
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()) {
  return terminateHybridEvidenceJob({
    ...input,
    code: input.code ?? "execution_uncertain",
    state: "uncertain",
  }, client);
}

export function assertHybridEvidenceJobCurrent(input: {
  artifactDigests: readonly string[];
  definitionDigest: string;
  inputDigest: string;
  record: HybridEvidenceJobRecord;
}): void {
  if (input.record.job.definitionDigest !== input.definitionDigest) {
    throw new HybridEvidenceJobStoreError("definition_digest_mismatch");
  }
  if (
    input.record.job.inputDigest !== input.inputDigest ||
    JSON.stringify([...input.artifactDigests].sort()) !== JSON.stringify(input.record.job.artifactDigests)
  ) {
    throw new HybridEvidenceJobStoreError("artifact_digest_mismatch");
  }
}
