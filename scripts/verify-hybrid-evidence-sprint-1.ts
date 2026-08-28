import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createHybridEvidenceArtifactStore,
  HybridEvidenceArtifactStoreError,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import {
  HybridEvidenceBudgetError,
  reconcileHybridEvidenceAttempt,
  reserveHybridEvidenceAttempt,
} from "../agent/lib/hybrid-evidence-budget";
import {
  advanceHybridSourceResultLineage,
  readHybridInvalidation,
  type HybridEvidenceLineageStoreClient,
} from "../agent/lib/hybrid-evidence-lineage-store";
import {
  acceptHybridEvidenceJob,
  claimHybridEvidenceJob,
  completeHybridEvidenceJob,
  failHybridEvidenceJob,
  markHybridEvidenceJobUncertain,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  type HybridEvidenceJobStoreClient,
} from "../agent/lib/hybrid-evidence-job-store";
import {
  digestHybridEvidenceValue,
  hybridAcceptedResultSchema,
  hybridEvidenceJobDefinitionSchema,
  type EvidenceArtifactManifest,
  type EvidenceLocator,
  type HybridEvidenceJobDefinition,
} from "../agent/lib/hybrid-evidence-schema";
import {
  bindHybridEvidenceWorkerSessionCapability,
  decodeHybridEvidenceWorkerToken,
  hybridEvidenceWorkerTokenFromSessionAuth,
  requireHybridEvidenceWorkerAuth,
  signHybridEvidenceWorkerEnvelope,
} from "../agent/lib/hybrid-evidence-auth";
import {
  completeHybridEvidenceJobForWorker,
  prepareHybridEvidenceWorkerRun,
  readHybridEvidenceSliceForWorker,
} from "../agent/lib/hybrid-evidence-worker";
import {
  readWorkspaceBudgetLedger,
  reserveWorkspaceRunBudget,
  summarizeWorkspaceBudgetUsage,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import {
  readGlobalDispatchBudgetLedger,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { writeWorkspaceDocument, type WorkspaceStateStoreClient } from "../agent/lib/workspace-state-store";

class MemoryCas implements HybridEvidenceArtifactIndexClient,
  HybridEvidenceJobStoreClient, WorkspaceBudgetLedgerClient,
  WorkspaceGlobalBudgetClient, WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  readonly deleted: string[] = [];
  readonly values = new Map<string, Uint8Array>();
  puts = 0;

  async delete(storageKey: string) {
    this.deleted.push(storageKey);
    this.values.delete(storageKey);
  }

  async get(storageKey: string) {
    return this.values.get(storageKey) ?? null;
  }

  async put(storageKey: string, bytes: Uint8Array) {
    this.puts += 1;
    this.values.set(storageKey, Uint8Array.from(bytes));
  }
}

class FaultInjectingLineageCas extends MemoryCas implements HybridEvidenceLineageStoreClient {
  failNextInvalidationWrite = false;

  override async compareAndSet(key: string, expected: string | null, next: string) {
    if (this.failNextInvalidationWrite && key.includes(":invalidation:")) {
      this.failNextInvalidationWrite = false;
      throw new Error("injected_invalidation_write_failure");
    }
    return super.compareAndSet(key, expected, next);
  }
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = new Date();
const ownerId = "owner_fixture";
const workspaceA = "123e4567-e89b-42d3-a456-426614174200";
const workspaceB = "123e4567-e89b-42d3-a456-426614174201";
const modelId = "fixture/hybrid-evidence-model";
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 7).toString("base64url"),
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: modelId,
  EVE_HYBRID_SOURCE_RECOVERY_CONCURRENT_WORKERS: "2",
  EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "30000",
  EVE_HYBRID_SOURCE_RECOVERY_OUTPUT_TOKENS_PER_DAY: "5000",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_CALL: "0.25",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_DAY: "1.00",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_MONTH: "5.00",
} as const;
Object.assign(process.env, environment, {
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: "B".repeat(43),
  KV_REST_API_TOKEN: "fixture",
  KV_REST_API_URL: "https://fixture.invalid",
  REDIS_URL: "redis://localhost:6379",
});

function definition(input: {
  purpose?: "extraction_recovery" | "semantic_interpretation";
  version?: string;
} = {}): HybridEvidenceJobDefinition {
  const purpose = input.purpose ?? "extraction_recovery";
  const version = input.version ?? "1.0.0";
  const core = {
    accessClassifications: ["public"],
    allowedAdapterIds: ["fixture-adapter"],
    allowedMediaTypes: ["text/plain"],
    allowedModelIds: [modelId],
    definitionId: purpose === "extraction_recovery" ? "fixture-extraction" : "fixture-semantic",
    definitionVersion: version,
    inputProjection: { schemaId: "fixture-text-slice", schemaVersion: "1.0.0" },
    instructionTemplate: {
      delimiterPolicy: "xml_data_envelope/v1",
      digest: sha256(`prompt:${purpose}:${version}`),
      templateId: purpose === "extraction_recovery" ? "fixture-extract" : "fixture-interpret",
      version,
    },
    limits: {
      maximumAttempts: 1,
      maximumEvidenceBytes: 4096,
      maximumInputTokens: 2000,
      maximumOutputTokens: 400,
      maximumPages: 0,
      maximumPaidCostUsd: "0.05",
      maximumRows: 0,
      maximumRuntimeMs: 60000,
    },
    outputSchema: { schemaId: "fixture-candidate", schemaVersion: "1.0.0" },
    purpose,
    recordType: "hybrid_evidence_job_definition",
    requiredValidator: { validatorId: "fixture-validator", version: "1.0.0" },
    resultScope: purpose === "extraction_recovery" ? "source_global" : "workspace",
    schemaVersion: 1,
    triggeringParserCodes: purpose === "extraction_recovery" ? ["layout_unsupported"] : [],
  } as const;
  return hybridEvidenceJobDefinitionSchema.parse({
    ...core,
    definitionDigest: digestHybridEvidenceValue(core),
  });
}

function sourceScope(initiatingWorkspaceId: string) {
  return {
    initiatingWorkspaceId,
    kind: "source_global" as const,
    sourceInstanceId: "source.fixture.public-text",
  };
}

function workspaceScope(workspaceId: string) {
  return {
    bindingRevision: 1,
    kind: "workspace" as const,
    ownerId,
    packContentDigest: sha256(`pack:${workspaceId}`),
    packId: "fixture-pack",
    packVersion: "1.0.0",
    workspaceId,
  };
}

async function persistText(
  store: ReturnType<typeof createHybridEvidenceArtifactStore>,
  text: string,
  acquisitionId = "acquisition.fixture.1",
): Promise<EvidenceArtifactManifest> {
  return store.persist({
    acquisitionId,
    authority: "Fixture Authority",
    bytes: Buffer.from(text, "utf8"),
    canonicalPublicUrl: `https://example.gov/evidence/${acquisitionId}.txt`,
    mediaType: "text/plain",
    now,
    observedAt: now.toISOString(),
    parserEligibility: {
      adapterId: "fixture-adapter",
      factSchemaVersion: "fixture-fact/v1",
      outcomeDigest: sha256(`outcome:${acquisitionId}`),
      reasonCode: "layout_unsupported",
      state: "unsupported",
    },
    sourceInstanceId: "source.fixture.public-text",
    structure: {
      characterCount: text.length,
      columnCount: null,
      pageCount: null,
      rowCount: null,
      sheetCount: null,
    },
  });
}

const artifactIndex = new MemoryCas();
const blobs = new MemoryBlob();
const artifacts = createHybridEvidenceArtifactStore({
  blob: blobs,
  index: artifactIndex,
  quota: {
    deploymentBytesPerDay: 4096,
    deploymentCountPerDay: 4,
    sourceBytesPerDay: 4096,
    sourceCountPerDay: 4,
  },
});
const evidenceText = "Management expects resilient demand, but conversion timing remains uncertain.";
const artifact = await persistText(artifacts, evidenceText);
assert.equal(artifact.storageKey, `hybrid-evidence/sha256/${artifact.contentDigest}`);
assert.equal(blobs.puts, 1);
assert.deepEqual(await persistText(artifacts, evidenceText), artifact);
assert.equal(blobs.puts, 1, "content-addressed reuse must not write Blob twice");

const locator: EvidenceLocator = {
  artifactDigest: artifact.contentDigest,
  end: evidenceText.length,
  kind: "text_span",
  spanDigest: sha256(evidenceText),
  start: 0,
};
assert.equal((await artifacts.readSlice({ locator, maximumBytes: 4096 })).content, evidenceText);
await assert.rejects(
  artifacts.readSlice({ locator: { ...locator, end: evidenceText.length + 1 }, maximumBytes: 4096 }),
  (error) => error instanceof HybridEvidenceArtifactStoreError && error.code === "locator_out_of_bounds",
);
await assert.rejects(
  artifacts.readSlice({ locator: { ...locator, spanDigest: "0".repeat(64) }, maximumBytes: 4096 }),
  (error) => error instanceof HybridEvidenceArtifactStoreError && error.code === "artifact_digest_mismatch",
);

const tightArtifacts = createHybridEvidenceArtifactStore({
  blob: new MemoryBlob(),
  index: new MemoryCas(),
  quota: {
    deploymentBytesPerDay: 4096,
    deploymentCountPerDay: 1,
    sourceBytesPerDay: 4096,
    sourceCountPerDay: 1,
  },
});
await persistText(tightArtifacts, "first", "acquisition.fixture.quota-1");
await assert.rejects(
  persistText(tightArtifacts, "second", "acquisition.fixture.quota-2"),
  (error) => error instanceof HybridEvidenceArtifactStoreError && error.code === "artifact_quota_exceeded",
);

const expiring = await persistText(artifacts, "orphan evidence", "acquisition.fixture.orphan");
await artifacts.setRetention({ artifactDigest: expiring.contentDigest, now, state: "orphaned" });
assert.deepEqual(await artifacts.collectExpired({ now: new Date(now.getTime() + 29 * 24 * 60 * 60_000) }), []);
assert.deepEqual(await artifacts.collectExpired({ now: new Date(now.getTime() + 31 * 24 * 60 * 60_000) }), [expiring.contentDigest]);
assert.deepEqual(blobs.deleted, [expiring.storageKey]);

const interleavedIndex = new MemoryCas();
let releaseStaleDelete!: () => void;
let staleDeleteStarted!: () => void;
const staleDeleteReady = new Promise<void>((resolve) => { staleDeleteStarted = resolve; });
const staleDeleteRelease = new Promise<void>((resolve) => { releaseStaleDelete = resolve; });
const interleavedBlobs = new MemoryBlob();
const originalDelete = interleavedBlobs.delete.bind(interleavedBlobs);
interleavedBlobs.delete = async (key) => {
  staleDeleteStarted();
  await staleDeleteRelease;
  await originalDelete(key);
};
const interleavedArtifacts = createHybridEvidenceArtifactStore({
  blob: interleavedBlobs,
  index: interleavedIndex,
  quota: {
    deploymentBytesPerDay: 4096,
    deploymentCountPerDay: 4,
    sourceBytesPerDay: 4096,
    sourceCountPerDay: 4,
  },
});
const interleavedText = "repersisted while stale garbage collection is paused";
const staleArtifact = await persistText(
  interleavedArtifacts,
  interleavedText,
  "acquisition.fixture.gc-stale",
);
await interleavedArtifacts.setRetention({
  artifactDigest: staleArtifact.contentDigest,
  now,
  state: "orphaned",
});
const staleCollection = interleavedArtifacts.collectExpired({
  now: new Date(now.getTime() + 31 * 24 * 60 * 60_000),
});
await staleDeleteReady;
await assert.rejects(
  persistText(
    interleavedArtifacts,
    interleavedText,
    "acquisition.fixture.gc-repersisted",
  ),
  (error) => error instanceof HybridEvidenceArtifactStoreError &&
    error.code === "artifact_store_conflict",
);
releaseStaleDelete();
assert.deepEqual(await staleCollection, [staleArtifact.contentDigest]);
const repersistedArtifact = await persistText(
  interleavedArtifacts,
  interleavedText,
  "acquisition.fixture.gc-repersisted",
);
assert.equal((await interleavedArtifacts.readManifest(staleArtifact.contentDigest))?.storageKey, repersistedArtifact.storageKey);
assert.equal((await interleavedArtifacts.readSlice({
  locator: {
    artifactDigest: repersistedArtifact.contentDigest,
    end: interleavedText.length,
    kind: "text_span",
    spanDigest: sha256(interleavedText),
    start: 0,
  },
  maximumBytes: 4096,
})).content, interleavedText, "GC tombstones must fence a concurrent digest repersist");

const quarantinedArtifact = await persistText(
  artifacts,
  "quarantined evidence",
  "acquisition.fixture.quarantine-retention",
);
await artifacts.setRetention({ artifactDigest: quarantinedArtifact.contentDigest, now, state: "quarantined" });
assert.deepEqual(await artifacts.collectExpired({ now: new Date(now.getTime() + 89 * 24 * 60 * 60_000) }), []);
assert.deepEqual(
  await artifacts.collectExpired({ now: new Date(now.getTime() + 91 * 24 * 60 * 60_000) }),
  [quarantinedArtifact.contentDigest],
);

const lineage = new FaultInjectingLineageCas();
const firstLineageResult = {
  lineageKey: "source.fixture:document.fixture:fixture-extraction",
  now,
  resultId: "hybrid-result.fixture.lineage-1",
  sourceDigest: sha256("source revision 1"),
  sourceRevision: "source-revision.fixture.1",
};
assert.equal(await advanceHybridSourceResultLineage(firstLineageResult, lineage), null);
const secondLineageResult = {
  ...firstLineageResult,
  now: new Date(now.getTime() + 1_000),
  resultId: "hybrid-result.fixture.lineage-2",
  sourceDigest: sha256("source revision 2"),
  sourceRevision: "source-revision.fixture.2",
};
lineage.failNextInvalidationWrite = true;
await assert.rejects(
  advanceHybridSourceResultLineage(secondLineageResult, lineage),
  /injected_invalidation_write_failure/u,
);
const recoveredInvalidation = await advanceHybridSourceResultLineage(secondLineageResult, lineage);
assert.ok(recoveredInvalidation, "replay must recover the pending invalidation");
assert.equal(recoveredInvalidation.resultId, firstLineageResult.resultId);
assert.equal(recoveredInvalidation.supersedingResultId, secondLineageResult.resultId);
assert.deepEqual(
  await readHybridInvalidation(recoveredInvalidation.invalidationId, lineage),
  recoveredInvalidation,
);
assert.equal(
  await advanceHybridSourceResultLineage(secondLineageResult, lineage),
  null,
  "a converged lineage replay must be inert",
);

const jobs = new MemoryCas();
const extractionDefinition = definition();
const preparedA = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: extractionDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceA),
}, jobs);
assert.equal(preparedA.job.inputDigest, preparedA.job.idempotencyKey);
assert.equal(preparedA.job.state, "prepared");
assert.deepEqual(await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: extractionDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceA),
}, jobs), preparedA);

const globalBudget = new MemoryCas();
const laneABudget = await reserveHybridEvidenceAttempt({
  definition: extractionDefinition,
  environment,
  job: preparedA.job,
  now,
}, { global: globalBudget });
assert.equal(laneABudget.lane, "source_global_extraction");
assert.equal(laneABudget.reservation.kind, "hybrid_model_attempt");
const worker = await prepareHybridEvidenceWorkerRun({
  budget: laneABudget,
  definition: extractionDefinition,
  environment,
  jobClient: jobs,
  locators: [locator],
  now,
  prepared: preparedA,
});
assert.equal(worker.request.mode, "task");
assert.equal(worker.request.requestInput, false);
assert.deepEqual(worker.request.input.outputSchema.required, ["jobId", "state"]);
const workerCtx = { session: { auth: { current: worker.request.auth } } };
assert.equal((await readHybridEvidenceSliceForWorker({
  clients: { artifacts, jobs }, ctx: workerCtx, environment, locator,
})).content, evidenceText);
const replacedCurrentAuth = {
  ...worker.request.auth,
  attributes: {
    ...worker.request.auth.attributes,
    hybrid_evidence_runtime_token: "invalid.current-token",
  },
};
const durableWorkerAuth = {
  current: replacedCurrentAuth,
  initiator: worker.request.auth,
};
assert.equal(
  hybridEvidenceWorkerTokenFromSessionAuth(durableWorkerAuth),
  worker.token,
  "the immutable worker initiator must outrank a replaced active-turn principal",
);
assert.equal((await requireHybridEvidenceWorkerAuth({
  session: { auth: durableWorkerAuth, id: "fixture-durable-worker-session" },
}, { jobId: preparedA.job.jobId }, environment)).token, worker.token);
const sessionBoundId = "fixture-session-bound-worker";
const alternateValidToken = signHybridEvidenceWorkerEnvelope({
  ...decodeHybridEvidenceWorkerToken(worker.token, { now }),
  expiresAt: new Date(now.getTime() + 90_000).toISOString(),
}, environment);
assert.notEqual(alternateValidToken, worker.token);
const previousFixtureTransport = process.env.EVE_HYBRID_EVIDENCE_WORKER_LOCAL_TRANSPORT;
process.env.EVE_HYBRID_EVIDENCE_WORKER_LOCAL_TRANSPORT = "1";
try {
  await bindHybridEvidenceWorkerSessionCapability({
    sessionId: sessionBoundId,
    token: worker.token,
  }, environment);
  assert.equal((await requireHybridEvidenceWorkerAuth({
    session: {
      auth: {
        current: {
          ...worker.request.auth,
          attributes: {
            ...worker.request.auth.attributes,
            hybrid_evidence_runtime_token: alternateValidToken,
          },
        },
        initiator: {
          ...worker.request.auth,
          attributes: {
            ...worker.request.auth.attributes,
            hybrid_evidence_runtime_token: alternateValidToken,
          },
        },
      },
      id: sessionBoundId,
    },
  }, { jobId: preparedA.job.jobId }, environment)).token, worker.token,
  "the session-bound claim token must outrank alternate valid Eve principals");
} finally {
  if (previousFixtureTransport === undefined) {
    delete process.env.EVE_HYBRID_EVIDENCE_WORKER_LOCAL_TRANSPORT;
  } else {
    process.env.EVE_HYBRID_EVIDENCE_WORKER_LOCAL_TRANSPORT = previousFixtureTransport;
  }
}
await assert.rejects(
  readHybridEvidenceSliceForWorker({
    clients: { artifacts, jobs },
    ctx: workerCtx,
    environment,
    locator: { ...locator, end: locator.end - 1, spanDigest: sha256(evidenceText.slice(0, -1)) },
  }),
  /capability_denied/u,
);

const candidate = {
  citations: [locator],
  disposition: "accepted" as const,
  fields: { demand: "resilient", timing: "uncertain" },
  unknowns: ["conversion timing"],
};
for (let replay = 0; replay < 2; replay += 1) {
  assert.deepEqual(await completeHybridEvidenceJobForWorker({
    candidate,
    ctx: workerCtx,
    environment,
    jobClient: jobs,
    now: new Date(now.getTime() + 1_000),
  }), { jobId: preparedA.job.jobId, state: "completed" });
}

const acceptedResult = hybridAcceptedResultSchema.parse({
  citations: [locator],
  definition: {
    definitionDigest: extractionDefinition.definitionDigest,
    definitionId: extractionDefinition.definitionId,
    definitionVersion: extractionDefinition.definitionVersion,
  },
  disposition: "accepted",
  inputDigest: preparedA.job.inputDigest,
  jobId: preparedA.job.jobId,
  model: {
    modelId,
    modelOutputDigest: digestHybridEvidenceValue(candidate),
    promptTemplateDigest: extractionDefinition.instructionTemplate.digest,
  },
  outputDigest: digestHybridEvidenceValue(candidate.fields),
  payload: candidate.fields,
  purpose: "extraction_recovery",
  recordType: "hybrid_evidence_accepted_result",
  resultId: `hybrid-result.${sha256(preparedA.job.jobId)}`,
  schemaVersion: 1,
  scope: preparedA.job.scope,
  uncertainty: { confidence: 0.9, coverage: "partial", unknowns: candidate.unknowns },
  usage: { inputTokens: 300, outputTokens: 80, paidCostUsd: "0.01" },
  validatedAt: new Date(now.getTime() + 2_000).toISOString(),
  validationTrace: [{
    errorCode: null,
    outcome: "passed",
    validatorId: extractionDefinition.requiredValidator.validatorId,
    validatorVersion: extractionDefinition.requiredValidator.version,
  }],
});
const accepted = await acceptHybridEvidenceJob({
  jobId: preparedA.job.jobId,
  // Scheduled callers retain the occurrence timestamp while the delegated
  // model completes later. Acceptance must not regress the durable job clock.
  now,
  result: acceptedResult,
}, jobs);
assert.equal(accepted.job.state, "accepted");
assert.equal(
  accepted.job.updatedAt,
  new Date(now.getTime() + 1_000).toISOString(),
  "accepting a completed job must preserve monotonic lifecycle time",
);
await artifacts.setReference({
  active: true,
  artifactDigest: artifact.contentDigest,
  kind: "accepted_result",
  referenceId: acceptedResult.resultId,
});
await assert.rejects(
  artifacts.setRetention({ artifactDigest: artifact.contentDigest, now, state: "orphaned" }),
  (error) => error instanceof HybridEvidenceArtifactStoreError && error.code === "artifact_store_conflict",
);

const reusedByWorkspaceB = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: extractionDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceB),
}, jobs);
assert.equal(reusedByWorkspaceB.job.jobId, accepted.job.jobId);
assert.equal(reusedByWorkspaceB.job.state, "accepted");
await assert.rejects(
  reserveHybridEvidenceAttempt({
    definition: extractionDefinition, environment, job: reusedByWorkspaceB.job, now,
  }, { global: globalBudget }),
  (error) => error instanceof HybridEvidenceBudgetError && error.code === "job_not_dispatchable",
);
const globalLedger = await readGlobalDispatchBudgetLedger(globalBudget);
assert.equal(globalLedger.reservations.length, 1);
assert.equal(globalLedger.reservations[0]?.runId, preparedA.job.budgetReservation.key);
await reconcileHybridEvidenceAttempt({
  actualInputTokens: 300,
  actualOutputTokens: 80,
  actualPaidCost: "0.01",
  now: new Date(now.getTime() + 3_000),
  outcome: "reconciled",
  reservation: laneABudget,
}, { global: globalBudget });
assert.equal(
  (await readGlobalDispatchBudgetLedger(globalBudget)).reservations[0]?.reconciledPaidMicros,
  "10000",
);

const revisedDefinition = definition({ version: "1.1.0" });
const definitionRevisionJob = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: revisedDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceA),
}, jobs);
assert.notEqual(definitionRevisionJob.job.jobId, preparedA.job.jobId);
const revisedText = `${evidenceText} Updated.`;
const artifactRevision = await persistText(artifacts, revisedText, "acquisition.fixture.revision");
const revisedLocator: EvidenceLocator = {
  artifactDigest: artifactRevision.contentDigest,
  end: revisedText.length,
  kind: "text_span",
  spanDigest: sha256(revisedText),
  start: 0,
};
const artifactRevisionJob = await prepareHybridEvidenceJob({
  artifacts: [artifactRevision], definition: extractionDefinition, locators: [revisedLocator], modelId, now,
  scope: sourceScope(workspaceA),
}, jobs);
assert.notEqual(artifactRevisionJob.job.jobId, preparedA.job.jobId);

const semanticDefinition = definition({ purpose: "semantic_interpretation" });
const semanticA = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: semanticDefinition, locators: [locator], modelId, now,
  scope: workspaceScope(workspaceA),
}, jobs);
const semanticB = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: semanticDefinition, locators: [locator], modelId, now,
  scope: workspaceScope(workspaceB),
}, jobs);
assert.notEqual(semanticA.job.jobId, semanticB.job.jobId);
assert.notEqual(semanticA.job.inputDigest, semanticB.job.inputDigest);

const state = new MemoryCas();
const workspaceBudget = new MemoryCas();
const authorizedA = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceA }, environment);
const workspacePolicy = {
  effectiveAt: now.toISOString(),
  maximumConcurrentWorkers: 4,
  maximumInputTokensPerDay: 10000,
  maximumInputTokensPerRun: 4000,
  maximumOutputTokensPerDay: 4000,
  maximumOutputTokensPerRun: 1000,
  maximumPaidPerCall: "0.25",
  maximumPaidPerDay: "1.00",
  maximumPaidPerMonth: "5.00",
  maximumScheduledRunsPerDay: 1,
  ownerTimezone: "UTC",
  unknownPriceFallbackCeiling: "0.25",
};
await writeWorkspaceDocument("budget", {
  expectedRevision: 0, now, scope: authorizedA, value: workspacePolicy,
}, state);
await writeWorkspaceDocument("capabilities", {
  expectedRevision: 0,
  now,
  scope: authorizedA,
  value: {
    connectionIds: [],
    controlPlaneToolIds: [],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["broker.mutation"],
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: [],
    skills: [],
    sources: [],
    workerModelPolicy: { allowedModelIds: [modelId], maximumOutputTokens: 400 },
  },
}, state);
await reserveWorkspaceRunBudget({
  inputTokens: 10,
  now,
  outputTokens: 10,
  policy: workspacePolicy,
  policyRevision: 1,
  runId: "scheduled-fixture",
  scope: authorizedA,
}, workspaceBudget);
const laneBBudget = await reserveHybridEvidenceAttempt({
  definition: semanticDefinition,
  job: semanticA.job,
  now,
  scope: authorizedA,
}, { state, workspace: workspaceBudget });
assert.equal(laneBBudget.lane, "workspace_semantic");
assert.equal(laneBBudget.reservation.kind, "hybrid_model_attempt");
const workspaceLedger = await readWorkspaceBudgetLedger(authorizedA, workspaceBudget);
assert.equal(workspaceLedger.reservations.length, 2);
assert.equal(
  summarizeWorkspaceBudgetUsage(workspaceLedger, now, "UTC").runsToday,
  1,
  "hybrid attempts must not increment scheduled monitor runs",
);
await reconcileHybridEvidenceAttempt({
  actualInputTokens: 250,
  actualOutputTokens: 70,
  actualPaidCost: "0.01",
  now: new Date(now.getTime() + 3_000),
  outcome: "reconciled",
  reservation: laneBBudget,
}, { workspace: workspaceBudget });
assert.equal(
  (await readWorkspaceBudgetLedger(authorizedA, workspaceBudget)).reservations
    .find(({ kind }) => kind === "hybrid_model_attempt")?.reconciledInputTokens,
  250,
);

const uncertainJobs = new MemoryCas();
const uncertain = await prepareHybridEvidenceJob({
  artifacts: [artifactRevision], definition: revisedDefinition, locators: [revisedLocator], modelId,
  now, scope: sourceScope(workspaceB),
}, uncertainJobs);
await claimHybridEvidenceJob({ claimToken: "claim-a", jobId: uncertain.job.jobId, now }, uncertainJobs);
assert.equal((await claimHybridEvidenceJob({
  claimToken: "claim-b", jobId: uncertain.job.jobId, now: new Date(now.getTime() + 1_000),
}, uncertainJobs)).job.state, "uncertain");

const terminalJobs = new MemoryCas();
const failedPrepared = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: revisedDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceA),
}, terminalJobs);
assert.equal((await failHybridEvidenceJob({
  code: "execution_failed", jobId: failedPrepared.job.jobId, now,
}, terminalJobs)).job.state, "failed");
const quarantinePrepared = await prepareHybridEvidenceJob({
  artifacts: [artifactRevision], definition: extractionDefinition, locators: [revisedLocator], modelId, now,
  scope: sourceScope(workspaceA),
}, terminalJobs);
await claimHybridEvidenceJob({ claimToken: "quarantine-claim", jobId: quarantinePrepared.job.jobId, now }, terminalJobs);
await completeHybridEvidenceJob({
  candidate: { citations: [revisedLocator], disposition: "quarantined", fields: {}, unknowns: ["layout"] },
  claimToken: "quarantine-claim",
  jobId: quarantinePrepared.job.jobId,
  now: new Date(now.getTime() + 1_000),
}, terminalJobs);
const quarantinedWithOccurrenceClock = await quarantineHybridEvidenceJob({
  codes: ["validator_failed"],
  jobId: quarantinePrepared.job.jobId,
  // Scheduled callers retain the occurrence timestamp while model completion
  // advances the durable job clock. Quarantine must remain monotonic.
  now,
}, terminalJobs);
assert.equal(quarantinedWithOccurrenceClock.job.state, "quarantined");
assert.equal(
  quarantinedWithOccurrenceClock.job.updatedAt,
  new Date(now.getTime() + 1_000).toISOString(),
  "quarantining a completed job must preserve monotonic lifecycle time",
);
assert.equal((await readHybridEvidenceJob(quarantinePrepared.job.jobId, terminalJobs))?.candidateDigest !== null, true);

const explicitUncertain = new MemoryCas();
const explicitUncertainPrepared = await prepareHybridEvidenceJob({
  artifacts: [artifact], definition: extractionDefinition, locators: [locator], modelId, now,
  scope: sourceScope(workspaceA),
}, explicitUncertain);
assert.equal((await markHybridEvidenceJobUncertain({
  jobId: explicitUncertainPrepared.job.jobId, now,
}, explicitUncertain)).job.state, "uncertain");

const eveEntry = import.meta.resolve("eve");
const { compileAgent } = await import(new URL("./compiler/compile-agent.js", eveEntry).href) as
  typeof import("../node_modules/eve/dist/src/compiler/compile-agent.js");
const compilation = await compileAgent({ startPath: process.cwd() });
const manifest = compilation.manifest;
const [packageJson, environmentExample] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../.env.example", import.meta.url), "utf8"),
]);
const compiledWorker = manifest.subagents.find(
  ({ nodeId }: { nodeId: string }) => nodeId === "subagents/hybrid-evidence-worker",
);
assert.ok(compiledWorker, "compiled hybrid evidence worker missing");
assert.deepEqual(
  compiledWorker.agent.dynamicTools.map(({ slug }: { slug: string }) => slug),
  ["capabilities"],
);
for (const denied of ["bash", "read_file", "write_file", "glob", "grep", "web_fetch", "web_search", "todo"]) {
  assert.ok(compiledWorker.agent.disabledFrameworkTools.includes(denied));
}
assert.equal(packageJson.scripts["verify:hybrid-evidence:sprint-1"], "jiti scripts/verify-hybrid-evidence-sprint-1.ts");
for (const key of [
  "EVE_HYBRID_EVIDENCE_AUTH_SECRET",
  "EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS",
  "EVE_HYBRID_SOURCE_RECOVERY_CONCURRENT_WORKERS",
]) assert.match(environmentExample, new RegExp(`^${key}=`, "mu"));

console.log("Hybrid evidence Sprint 1 durable artifacts, jobs, budgets, auth, and isolated worker passed.");
