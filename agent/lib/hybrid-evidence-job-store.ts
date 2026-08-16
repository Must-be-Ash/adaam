import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

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

const KEY_PREFIX = "eve:hybrid-evidence:v1:job:";
const MAX_CAS_ATTEMPTS = 8;
const MAX_RECORD_BYTES = 256 * 1_024;
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
  failureCode: hybridEvidenceErrorCodeSchema.nullable(),
  job: hybridEvidenceJobSchema,
  quarantineCodes: z.array(hybridEvidenceErrorCodeSchema).max(16),
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
  locators: readonly EvidenceLocator[];
  modelId: string;
  scope: z.infer<typeof hybridEvidenceScopeSchema>;
}): string {
  return digestHybridEvidenceValue({
    artifactDigests: input.artifacts.map(({ contentDigest }) => contentDigest).sort(),
    definitionDigest: input.definition.definitionDigest,
    locatorDigests: input.locators.map(digestHybridEvidenceValue).sort(),
    modelId: input.modelId,
    scope: normalizeScopeForReuse(input.scope),
  });
}

export async function prepareHybridEvidenceJob(input: {
  artifacts: readonly EvidenceArtifactManifest[];
  definition: HybridEvidenceJobDefinition;
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
      locator.kind !== "source_fact" &&
      !artifacts.some(({ contentDigest }) => contentDigest === locator.artifactDigest)
    )
  ) {
    throw new HybridEvidenceJobStoreError("artifact_digest_mismatch");
  }
  const inputDigest = deriveHybridEvidenceInputDigest({
    artifacts,
    definition,
    locators,
    modelId: input.modelId,
    scope,
  });
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
        return { record: current, result: current };
      }
      const record = Object.freeze({
        acceptedResult: null,
        candidate: null,
        candidateDigest: null,
        claimTokenDigest: null,
        failureCode: null,
        job,
        quarantineCodes: [],
        recordType: "hybrid_evidence_job_record" as const,
        schemaVersion: 1 as const,
      });
      return { record, result: record };
    },
  });
}

export async function readHybridEvidenceJob(
  jobId: string,
  client: HybridEvidenceJobStoreClient = store(),
): Promise<HybridEvidenceJobRecord | null> {
  return parseRecord(rawValue(await client.get(recordKey(jobId))));
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function claimHybridEvidenceJob(input: {
  claimToken: string;
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
      if (current.job.state === "running") {
        const uncertain = recordSchema.parse({
          ...current,
          failureCode: "execution_uncertain",
          job: { ...current.job, completedAt: timestamp, state: "uncertain", updatedAt: timestamp },
        });
        return { record: uncertain, result: uncertain };
      }
      if (current.job.state !== "prepared") {
        throw new HybridEvidenceJobStoreError("job_conflict");
      }
      const running = recordSchema.parse({
        ...current,
        claimTokenDigest: digest,
        job: { ...current.job, attempt: 1, startedAt: timestamp, state: "running", updatedAt: timestamp },
      });
      return { record: running, result: running };
    },
  });
}

export async function completeHybridEvidenceJob(input: {
  candidate: Record<string, unknown>;
  claimToken: string;
  jobId: string;
  now?: Date;
}, client: HybridEvidenceJobStoreClient = store()): Promise<HybridEvidenceJobRecord> {
  const candidate = candidateSchema.parse(input.candidate);
  const candidateDigest = digestHybridEvidenceValue(candidate);
  const timestamp = (input.now ?? new Date()).toISOString();
  return updateRecord({
    client,
    jobId: input.jobId,
    mutate(current) {
      if (!current) throw new HybridEvidenceJobStoreError("job_not_found");
      if (current.job.state === "completed" && current.candidateDigest === candidateDigest) {
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
  const timestamp = (input.now ?? new Date()).toISOString();
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
  const timestamp = (input.now ?? new Date()).toISOString();
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
