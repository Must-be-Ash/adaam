import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { generateText } from "ai";

import {
  HYBRID_EVIDENCE_ERROR_CODES,
  HYBRID_EVIDENCE_EVENTS,
  HYBRID_EVIDENCE_JOB_STATES,
  digestHybridEvidenceValue,
  evidenceArtifactManifestSchema,
  evidenceLocatorSchema,
  hybridAcceptedResultSchema,
  hybridEvidenceJobDefinitionSchema,
  hybridEvidenceJobSchema,
  hybridEvidenceLaneSchema,
  hybridEvidenceObservationSchema,
  hybridInvalidationRecordSchema,
  hybridPromotionRecordSchema,
  parseHybridEvidenceRecord,
} from "../agent/lib/hybrid-evidence-schema";
import { resolveHybridEvidenceFlags } from "../agent/lib/hybrid-evidence-flags";
import { congressionalSignalsExecutionEnabled } from "../agent/lib/congressional-signal-flags";
import { resolveHousePublicSourceRuntimePath } from "../agent/lib/public-source-flags";
import {
  HybridEvidenceMissingProductionSeamError,
  createHybridEvidenceMockModelHarness,
  hybridEvidenceFixtureCorpusSchema,
  runHybridEvidenceContractHarness,
} from "../evals/hybrid-evidence/mock-model-harness";

const corpus = hybridEvidenceFixtureCorpusSchema.parse(JSON.parse(await readFile(
  new URL("./fixtures/hybrid-evidence/corpus-v1.json", import.meta.url),
  "utf8",
)));
assert.equal(corpus.cases.length, 16);
assert.deepEqual(new Set(corpus.cases.map(({ evidence }) => evidence.shape)), new Set([
  "pdf",
  "semantic_text",
  "spreadsheet",
]));
for (const outcome of ["accepted", "abstained", "quarantined"] as const) {
  assert.ok(corpus.cases.some((fixture) => fixture.expected.outcome === outcome));
}
for (const tag of ["false_success_layout", "hostile_document", "prompt_injection"] as const) {
  assert.ok(corpus.cases.some((fixture) => fixture.tags.includes(tag)));
}
assert.equal(hybridEvidenceLaneSchema.parse("source_global_extraction"), "source_global_extraction");
assert.equal(hybridEvidenceLaneSchema.parse("workspace_semantic"), "workspace_semantic");
assert.throws(() => hybridEvidenceLaneSchema.parse("cross_workspace_semantic"));

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const observedAt = "2026-08-16T20:00:00.000Z";
const artifact = evidenceArtifactManifestSchema.parse({
  accessClassification: "public",
  acquisitionId: "acquisition.fixture.house.1",
  artifactId: "hybrid-evidence.artifact.fixture-house-ptr",
  authority: "House Clerk",
  byteCount: 4096,
  canonicalPublicUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20000001.pdf",
  contentDigest: digestA,
  mediaType: "application/pdf",
  observedAt,
  parserEligibility: {
    adapterId: "house-financial-disclosures",
    factSchemaVersion: "house-ptr-transaction/v1",
    outcomeDigest: digestB,
    reasonCode: "pdf_scanned_unsupported",
    state: "unsupported",
  },
  recordType: "hybrid_evidence_artifact",
  retention: { expiresAt: null, state: "active" },
  schemaVersion: 1,
  sourceInstanceId: "source.house-financial-disclosures.2026",
  storageKey: `hybrid-evidence/sha256/${digestA}`,
  structure: { characterCount: null, columnCount: null, pageCount: 2, rowCount: null, sheetCount: null },
});
assert.throws(() => evidenceArtifactManifestSchema.parse({
  ...artifact,
  accessClassification: "owner_private",
}));
assert.throws(() => evidenceArtifactManifestSchema.parse({
  ...artifact,
  canonicalPublicUrl: `${artifact.canonicalPublicUrl}?token=secret`,
}));
assert.throws(() => evidenceArtifactManifestSchema.parse({
  ...artifact,
  storageKey: `hybrid-evidence/sha256/${digestB}`,
}));
const semanticArtifact = evidenceArtifactManifestSchema.parse({
  ...artifact,
  artifactId: "hybrid-evidence.artifact.fixture-public-text",
  canonicalPublicUrl: "https://example.gov/public-statement.txt",
  contentDigest: digestB,
  mediaType: "text/plain",
  parserEligibility: null,
  storageKey: `hybrid-evidence/sha256/${digestB}`,
  structure: {
    characterCount: 240,
    columnCount: null,
    pageCount: null,
    rowCount: null,
    sheetCount: null,
  },
});
assert.equal(semanticArtifact.parserEligibility, null);

const pdfLocator = evidenceLocatorSchema.parse({
  artifactDigest: digestA,
  evidenceDigest: digestB,
  kind: "pdf_page",
  page: 1,
  region: { height: 0.2, width: 0.8, x: 0.1, y: 0.1 },
});
const spreadsheetLocator = evidenceLocatorSchema.parse({
  artifactDigest: digestA,
  kind: "spreadsheet_range",
  normalizedRangeDigest: digestB,
  range: "A1:C2",
  sheetId: "Holdings",
});
const textLocator = evidenceLocatorSchema.parse({
  artifactDigest: digestA,
  end: 24,
  kind: "text_span",
  spanDigest: digestB,
  start: 0,
});
const sourceFactLocator = evidenceLocatorSchema.parse({
  factRevisionId: "fact-revision.fixture.1",
  kind: "source_fact",
  payloadDigest: digestB,
});
for (const locator of [pdfLocator, spreadsheetLocator, textLocator, sourceFactLocator]) {
  assert.deepEqual(evidenceLocatorSchema.parse(locator), locator);
}
assert.throws(() => evidenceLocatorSchema.parse({ ...pdfLocator, page: 0 }));

const definitionCore = {
  accessClassifications: ["public"],
  allowedAdapterIds: ["house-financial-disclosures"],
  allowedMediaTypes: ["application/pdf"],
  allowedModelIds: ["fixture/hybrid-evidence-model"],
  definitionId: "house-ptr-document-row-recovery",
  definitionVersion: "1.0.0",
  inputProjection: { schemaId: "hybrid-pdf-pages", schemaVersion: "1.0.0" },
  instructionTemplate: {
    delimiterPolicy: "xml_data_envelope/v1",
    digest: digestA,
    templateId: "extract-house-ptr-rows",
    version: "1.0.0",
  },
  limits: {
    maximumAttempts: 1,
    maximumEvidenceBytes: 1048576,
    maximumInputTokens: 12000,
    maximumOutputTokens: 2000,
    maximumPages: 4,
    maximumPaidCostUsd: "0.25",
    maximumRows: 64,
    maximumRuntimeMs: 60000,
  },
  outputSchema: { schemaId: "house-ptr-row-candidate", schemaVersion: "1.0.0" },
  purpose: "extraction_recovery",
  recordType: "hybrid_evidence_job_definition",
  requiredValidator: { validatorId: "house-ptr-row-validator", version: "1.0.0" },
  resultScope: "source_global",
  schemaVersion: 1,
  triggeringParserCodes: ["pdf_scanned_unsupported"],
} as const;
const definition = hybridEvidenceJobDefinitionSchema.parse({
  ...definitionCore,
  definitionDigest: digestHybridEvidenceValue(definitionCore),
});
assert.throws(() => hybridEvidenceJobDefinitionSchema.parse({
  ...definition,
  definitionDigest: "0".repeat(64),
}));
const { definitionDigest: _definitionDigest, ...semanticDefinitionBase } = {
  ...definition,
  allowedAdapterIds: ["public-text-fixture"],
  allowedMediaTypes: ["text/plain"],
  definitionId: "semantic-public-text",
  inputProjection: { schemaId: "bounded-public-text", schemaVersion: "1.0.0" },
  instructionTemplate: {
    ...definition.instructionTemplate,
    templateId: "interpret-public-text",
  },
  outputSchema: { schemaId: "semantic-public-text-result", schemaVersion: "1.0.0" },
  purpose: "semantic_interpretation",
  requiredValidator: { validatorId: "semantic-public-text-validator", version: "1.0.0" },
  resultScope: "workspace",
  triggeringParserCodes: [],
} as const;
const semanticDefinition = hybridEvidenceJobDefinitionSchema.parse({
  ...semanticDefinitionBase,
  definitionDigest: digestHybridEvidenceValue(semanticDefinitionBase),
});
assert.equal(semanticDefinition.triggeringParserCodes.length, 0);

const job = hybridEvidenceJobSchema.parse({
  artifactDigests: [artifact.contentDigest],
  attempt: 0,
  budgetReservation: {
    key: "hybrid:job.fixture.1:attempt:1",
    kind: "hybrid_model_attempt",
    scope: "deployment_source_recovery",
  },
  completedAt: null,
  createdAt: observedAt,
  definitionDigest: definition.definitionDigest,
  definitionId: definition.definitionId,
  definitionVersion: definition.definitionVersion,
  idempotencyKey: digestB,
  inputDigest: digestA,
  jobId: "hybrid-job.fixture.1",
  locatorDigests: [digestHybridEvidenceValue(pdfLocator)],
  modelId: "fixture/hybrid-evidence-model",
  purpose: "extraction_recovery",
  recordType: "hybrid_evidence_job",
  schemaVersion: 1,
  scope: {
    initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614174200",
    kind: "source_global",
    sourceInstanceId: artifact.sourceInstanceId,
  },
  startedAt: null,
  state: "prepared",
  updatedAt: observedAt,
});
for (const state of HYBRID_EVIDENCE_JOB_STATES) {
  const nonPrepared = state !== "prepared";
  const completed = !["prepared", "running"].includes(state);
  const lifecycleJob = hybridEvidenceJobSchema.parse({
    ...job,
    attempt: nonPrepared ? 1 : 0,
    completedAt: completed ? "2026-08-16T20:00:02.000Z" : null,
    jobId: `hybrid-job.fixture.lifecycle-${state}`,
    startedAt: nonPrepared ? "2026-08-16T20:00:01.000Z" : null,
    state,
    updatedAt: completed
      ? "2026-08-16T20:00:02.000Z"
      : nonPrepared
        ? "2026-08-16T20:00:01.000Z"
        : observedAt,
  });
  assert.equal(lifecycleJob.state, state);
}
assert.throws(() => hybridEvidenceJobSchema.parse({
  ...job,
  state: "running",
}));

const result = hybridAcceptedResultSchema.parse({
  citations: [pdfLocator],
  definition: {
    definitionDigest: definition.definitionDigest,
    definitionId: definition.definitionId,
    definitionVersion: definition.definitionVersion,
  },
  disposition: "accepted",
  inputDigest: digestA,
  jobId: job.jobId,
  model: { modelId: job.modelId, modelOutputDigest: digestB, promptTemplateDigest: digestA },
  outputDigest: digestB,
  payload: { amountRange: "$1,001-$15,000" },
  purpose: "extraction_recovery",
  recordType: "hybrid_evidence_accepted_result",
  resultId: "hybrid-result.fixture.1",
  schemaVersion: 1,
  scope: job.scope,
  uncertainty: { confidence: 0.99, coverage: "complete", unknowns: [] },
  usage: { inputTokens: 1200, outputTokens: 180, paidCostUsd: "0.01" },
  validatedAt: observedAt,
  validationTrace: [{
    errorCode: null,
    outcome: "passed",
    validatorId: definition.requiredValidator.validatorId,
    validatorVersion: definition.requiredValidator.version,
  }],
});
assert.throws(() => hybridAcceptedResultSchema.parse({ ...result, citations: [] }));
const semanticAbstention = hybridAcceptedResultSchema.parse({
  ...result,
  citations: [textLocator, sourceFactLocator],
  definition: {
    definitionDigest: semanticDefinition.definitionDigest,
    definitionId: semanticDefinition.definitionId,
    definitionVersion: semanticDefinition.definitionVersion,
  },
  disposition: "abstained",
  payload: { claims: [], counterevidence: [], classification: "unknown" },
  purpose: "semantic_interpretation",
  resultId: "hybrid-result.fixture.semantic-abstention",
  scope: {
    bindingRevision: 1,
    kind: "workspace",
    ownerId: "owner_fixture",
    packContentDigest: digestA,
    packId: "fixture-semantic-pack",
    packVersion: "1.0.0",
    workspaceId: "123e4567-e89b-42d3-a456-426614174201",
  },
  uncertainty: { confidence: null, coverage: "unknown", unknowns: ["direction"] },
});
assert.equal(semanticAbstention.disposition, "abstained");
assert.throws(() => hybridAcceptedResultSchema.parse({
  ...result,
  disposition: "abstained",
}));

const promotion = hybridPromotionRecordSchema.parse({
  canonicalFactRevisionIds: ["fact-revision.fixture.1"],
  correctionIds: [],
  createdAt: observedAt,
  promotionId: "hybrid-promotion.fixture.1",
  recordType: "hybrid_evidence_promotion",
  resultId: result.resultId,
  retractionIds: [],
  schemaVersion: 1,
});
const invalidation = hybridInvalidationRecordSchema.parse({
  cause: { digest: digestA, kind: "definition_revision", revision: "1.1.0" },
  createdAt: observedAt,
  invalidationId: "hybrid-invalidation.fixture.1",
  recordType: "hybrid_evidence_invalidation",
  resultId: result.resultId,
  schemaVersion: 1,
  supersedingResultId: null,
});
for (const record of [artifact, definition, job, result, promotion, invalidation]) {
  assert.deepEqual(parseHybridEvidenceRecord(record), record);
}

assert.deepEqual([...HYBRID_EVIDENCE_ERROR_CODES].sort(), [...HYBRID_EVIDENCE_ERROR_CODES]);
assert.deepEqual([...HYBRID_EVIDENCE_EVENTS].sort(), [...HYBRID_EVIDENCE_EVENTS]);
assert.equal(new Set(HYBRID_EVIDENCE_ERROR_CODES).size, HYBRID_EVIDENCE_ERROR_CODES.length);
assert.deepEqual(hybridEvidenceObservationSchema.parse({
  definitionVersion: "1.0.0",
  errorCode: null,
  event: "hybrid_job_accepted",
  modelFamily: "fixture",
  purpose: "extraction_recovery",
  state: "accepted",
  validatorOutcome: "passed",
  value: 1,
}), {
  definitionVersion: "1.0.0",
  errorCode: null,
  event: "hybrid_job_accepted",
  modelFamily: "fixture",
  purpose: "extraction_recovery",
  state: "accepted",
  validatorOutcome: "passed",
  value: 1,
});
assert.throws(() => hybridEvidenceObservationSchema.parse({
  event: "hybrid_job_accepted",
  jobId: job.jobId,
  purpose: "extraction_recovery",
  value: 1,
}));

const allOff = resolveHybridEvidenceFlags({});
assert.deepEqual(allOff, {
  configuration: "disabled",
  enabled: false,
  extractionRecovery: false,
  semanticReasoning: false,
});
assert.equal(Object.isFrozen(allOff), true);
const existingRuntimeEnvironment = {
  EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
  EVE_HYBRID_EVIDENCE_ENABLED: "0",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "0",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "0",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
  EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED: "1",
} as const;
assert.equal(
  resolveHousePublicSourceRuntimePath(existingRuntimeEnvironment),
  resolveHousePublicSourceRuntimePath({
    EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
  }),
);
assert.equal(
  congressionalSignalsExecutionEnabled(existingRuntimeEnvironment),
  congressionalSignalsExecutionEnabled({ EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED: "1" }),
);
assert.deepEqual(resolveHybridEvidenceFlags(existingRuntimeEnvironment), allOff);

assert.deepEqual(resolveHybridEvidenceFlags({
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
}), {
  configuration: "misconfigured",
  enabled: false,
  extractionRecovery: false,
  semanticReasoning: false,
});
assert.deepEqual(resolveHybridEvidenceFlags({
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
}), {
  configuration: "misconfigured",
  enabled: false,
  extractionRecovery: false,
  semanticReasoning: false,
});
assert.deepEqual(resolveHybridEvidenceFlags({
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
}), {
  configuration: "enabled",
  enabled: true,
  extractionRecovery: false,
  semanticReasoning: false,
});
assert.deepEqual(resolveHybridEvidenceFlags({
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "0",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
}), {
  configuration: "enabled",
  enabled: true,
  extractionRecovery: true,
  semanticReasoning: false,
});
assert.deepEqual(resolveHybridEvidenceFlags({
  EVE_HYBRID_EVIDENCE_ENABLED: "true",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "yes",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1 ",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
}), allOff);

const harness = createHybridEvidenceMockModelHarness(corpus);
const deterministicCase = corpus.cases.find(({ fixtureId }) =>
  fixtureId === "pdf.changed-layout.accepted")!;
const deterministicBypass = {
  ...deterministicCase,
  deterministicParser: { errorCode: null, state: "complete" as const },
};
const fullyEnabled = resolveHybridEvidenceFlags({
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
});
assert.deepEqual(fullyEnabled, {
  configuration: "enabled",
  enabled: true,
  extractionRecovery: true,
  semanticReasoning: true,
});
assert.equal(await runHybridEvidenceContractHarness({
  fixture: deterministicBypass,
  flags: fullyEnabled,
}), "deterministic_bypass");
assert.equal(await runHybridEvidenceContractHarness({
  fixture: deterministicCase,
  flags: allOff,
}), "hybrid_disabled");
assert.equal(harness.calls.length, 0);

const modelResult = await generateText({
  model: harness.model,
  prompt: JSON.stringify({ fixtureId: deterministicCase.fixtureId }),
});
assert.deepEqual(JSON.parse(modelResult.text), deterministicCase.mockCandidate);
assert.deepEqual(harness.calls, [deterministicCase.fixtureId]);

await assert.rejects(
  runHybridEvidenceContractHarness({ fixture: deterministicCase, flags: fullyEnabled }),
  (error) => error instanceof HybridEvidenceMissingProductionSeamError &&
    error.code === "artifact_store_unimplemented",
);
await assert.rejects(
  runHybridEvidenceContractHarness({
    fixture: deterministicCase,
    flags: fullyEnabled,
    seams: { persistArtifact: async () => undefined },
  }),
  (error) => error instanceof HybridEvidenceMissingProductionSeamError &&
    error.code === "job_store_unimplemented",
);
await assert.rejects(
  runHybridEvidenceContractHarness({
    fixture: deterministicCase,
    flags: fullyEnabled,
    seams: {
      persistArtifact: async () => undefined,
      prepareJob: async () => undefined,
    },
  }),
  (error) => error instanceof HybridEvidenceMissingProductionSeamError &&
    error.code === "worker_runtime_unimplemented",
);

const [environmentExample, packageJson] = await Promise.all([
  readFile(new URL("../.env.example", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
]);
for (const flag of [
  "EVE_HYBRID_EVIDENCE_ENABLED",
  "EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED",
  "EVE_HYBRID_SEMANTIC_REASONING_ENABLED",
]) {
  assert.match(environmentExample, new RegExp(`^${flag}=0$`, "mu"));
}
assert.equal(
  packageJson.scripts["verify:hybrid-evidence:sprint-0"],
  "jiti scripts/verify-hybrid-evidence-sprint-0.ts",
);

console.log("Hybrid evidence Sprint 0 contracts, corpus, flags, and red seams passed.");
