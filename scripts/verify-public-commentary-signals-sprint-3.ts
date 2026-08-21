import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { createPublicCommentaryPipeline, INVERSE_CRAMER_POLICY, materializePublicCommentaryCorrection, materializePublicCommentarySignal, readAttestedCommentarySemanticResult } from "../agent/lib/public-commentary-vertical";
import {
  createCommentarySemanticDefinition,
  createInverseCramerSemanticDefinition,
} from "../agent/lib/public-commentary-semantics";
import { digestHybridEvidenceValue, hybridAcceptedResultSchema } from "../agent/lib/hybrid-evidence-schema";
import type { PublicCommentaryAttemptStoreClient } from "../agent/lib/public-commentary-attempt-store";
import { readLatestPublicCommentaryFinding, readPublicCommentaryFindingByStatementRevision, type PublicCommentaryFindingStoreClient } from "../agent/lib/public-commentary-finding-store";
import { readLatestPublicCommentaryFindingExplanation, readPublicCommentaryFindingExplanation, readPublicCommentaryWorkspacePresentation } from "../agent/lib/public-commentary-presentation";
import { digestPublicCommentaryValue, publicStatementSchema, webCorroborationSearchSchema, type PublicStatement } from "../agent/lib/public-commentary-schema";
import { projectPublicCommentarySourceEvent } from "../agent/lib/public-commentary-workspace-isolation";
import { createExaWebCorroborationProvider, compileWebCorroborationQuery } from "../agent/lib/web-corroboration-search";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { workspaceFindingCandidateSchema } from "../agent/lib/workspace-finding-store";
import { readWorkspaceBudgetLedger, reserveWorkspaceRunBudget, type WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import { writeWorkspaceDocument, type WorkspaceStateStoreClient } from "../agent/lib/workspace-state-store";
import { isWorkspaceMonitorCheckpointOnlyBaseline, prepareWorkspaceMonitorCreate, requiresManagedMonitorActivationWatermark } from "../agent/lib/workspace-monitor-store";
import { PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID } from "../agent/lib/workspace-monitor-lifecycle-contract";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "../agent/lib/strategy-pack-reference-catalog";
import { commitThenAcknowledgePublicCommentaryResult, createProductionPublicCommentaryPipeline } from "../agent/lib/public-commentary-workspace-worker";
import { authorizeWorkspaceXExactPostFetch, completeWorkspaceSourceCoverage, createWorkspaceSourceCoverage, readWorkspaceSourceCoverage, WorkspaceSourceCoverageError } from "../agent/lib/workspace-source-coverage";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import { createWorkspaceSemanticSource } from "../agent/lib/hybrid-evidence-semantic-store";
import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import type { PublicSourceSubscriptionStoreClient } from "../agent/lib/public-source-subscription-store";
import { readRevocableEvidenceEnvelope, type RevocableEvidenceStoreClient } from "../agent/lib/revocable-evidence-store";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";

class MemoryStore implements PublicCommentaryFindingStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async compareAndSetMany(operations: readonly Readonly<{ expected: string | null; key: string; next: string }>[]) {
    if (operations.some(({ expected, key }) => (this.values.get(key) ?? null) !== expected)) return false;
    for (const { key, next } of operations) this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryAttemptStore implements PublicCommentaryAttemptStoreClient {
  readonly values = new Map<string, string>();
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current !== undefined) return current;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryCas implements WorkspaceBudgetLedgerClient, WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async compareAndSetMany(operations: readonly Readonly<{ expected: string | null; key: string; next: string }>[]) {
    if (operations.some(({ expected, key }) => (this.values.get(key) ?? null) !== expected)) return false;
    for (const { key, next } of operations) this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryRuntimeCas extends MemoryCas implements
  HybridEvidenceArtifactIndexClient,
  PublicSourceAcquisitionStoreClient,
  PublicSourceSubscriptionStoreClient,
  RevocableEvidenceStoreClient,
  WorkspaceSourceCoverageClient {
  async delete(key: string) { this.values.delete(key); }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) { this.values.set(key, Uint8Array.from(bytes)); }
}

const ownerId = "owner_fixture";
const environment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const workspaceC = "33333333-3333-4333-8333-333333333333";
const scopeA = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceA }, environment);
const scopeB = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceB }, environment);
const scopeC = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceC }, environment);
const store = new MemoryStore();
const now = "2026-08-18T18:00:00.000Z";
const text = "I remain bullish on $AAPL for the next quarter.";
const spanDigest = createHash("sha256").update(text).digest("hex");
const artifactDigest = "a".repeat(64);
const citation = { artifactDigest, end: text.length, kind: "text_span" as const, spanDigest, start: 0 };
const claim = (statement: string) => ({ citations: [citation], statement });

let commitBoundaryAcknowledgements = 0;
await assert.rejects(commitThenAcknowledgePublicCommentaryResult({
  acknowledge: async () => { commitBoundaryAcknowledgements += 1; },
  commit: async () => { throw new Error("injected_workspace_commit_failure"); },
}), /injected_workspace_commit_failure/u);
assert.equal(commitBoundaryAcknowledgements, 0, "a failed deterministic commit must leave rehydration replayable");
assert.equal(await commitThenAcknowledgePublicCommentaryResult({
  acknowledge: async () => { commitBoundaryAcknowledgements += 1; },
  commit: async () => "committed" as const,
}), "committed");
assert.equal(commitBoundaryAcknowledgements, 1);

function statement(overrides: Partial<PublicStatement> = {}) {
  return publicStatementSchema.parse({
    attribution: "direct",
    canonicalUrl: "https://x.com/jimcramer/status/200",
    contentDigest: digestPublicCommentaryValue(text),
    contentReference: { envelopeId: "revocable-evidence.x.200", revision: 1 },
    editChainIds: ["200"],
    editableUntil: null,
    entities: { cashtags: ["AAPL"], mentions: [], urls: [] },
    lifecycle: "final",
    observedAt: now,
    provider: "x",
    publishedAt: "2026-08-18T17:00:00.000Z",
    recordType: "public_statement",
    references: { conversationId: "200", referencedPostIds: [] },
    revision: 1,
    role: "original",
    schemaVersion: 1,
    speaker: { displayLabel: "Jim Cramer", stableId: "14216123", username: "jimcramer" },
    stablePostId: "200",
    textLocators: [{ end: text.length, spanDigest, start: 0 }],
    ...overrides,
  });
}

const semantic = {
  assumptions: ["The statement remains attributable to the pinned public identity."],
  confidence: "high" as const,
  counterevidence: [claim("The statement may have no predictive value.")],
  facts: [claim("The statement explicitly describes AAPL as bullish.")],
  forecast: {
    catalysts: [claim("A product update could alter the scenario.")],
    invalidationConditions: [claim("An edit or deletion invalidates the current evidence revision.")],
    likelyImplication: claim("The registered policy can produce an opposite-direction research candidate."),
    risks: [claim("Public commentary may not predict price movement.")],
    scenarios: [{ citations: [citation], condition: "The statement remains current.", direction: "negative" as const, label: "base" as const, rationale: "Only the registered transform supplies direction." }],
  },
  horizon: "months" as const,
  inferences: [claim("The speaker expresses a bullish investment view.")],
  outcome: "accepted" as const,
  rationale: "The final direct view is explicit and exactly cited.",
  recommendation: { action: "research_candidate" as const, assumptions: [], citations: [citation], rationale: "Research the inverse direction; do not trade." },
};
const corroboration = webCorroborationSearchSchema.parse({
  completeness: "complete",
  cost: { amountUsd: "0.000000", billableUnits: 0, currency: "USD" },
  provider: "exa",
  queriedAt: now,
  queryDigest: "b".repeat(64),
  recordType: "web_corroboration_search",
  requestId: "exa-local.sprint-3",
  results: [],
  schemaVersion: 1,
  status: "not_run",
});
const pack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.0.0" });
assert.ok(pack && pack.availability === "available");
assert.equal(pack.monitors[0]?.activationDefault, "paused");
assert.equal(pack.monitors[0] && "intervalMinutesConfigurationKey" in pack.monitors[0] ? pack.monitors[0].intervalMinutesConfigurationKey : null, "cadenceMinutes");
assert.equal(pack.evidenceContracts.find(({ id }) => id === INVERSE_CRAMER_POLICY.policy.policyId)?.digest, INVERSE_CRAMER_POLICY.policy.definitionDigest);
assert.ok(pack.capabilities.hardDenied.includes("broker.mutation"));
assert.ok(!STRATEGY_PACK_REFERENCE_CATALOG.capabilityIds.some((id) => /broker|order|trade/iu.test(id)));
assert.equal(requiresManagedMonitorActivationWatermark({
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: pack.contentDigest,
    packId: "inverse-cramer",
    packVersion: "1.0.0",
    resourceId: "evaluate-public-commentary",
  },
}), true);
const activeMonitor = prepareWorkspaceMonitorCreate({
  activateManagedMonitor: true,
  deliverySubscriptionId: "delivery.inverse-cramer.sprint-3",
  instruction: "Evaluate bounded public commentary.",
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: pack.contentDigest,
    packId: "inverse-cramer",
    packVersion: "1.0.0",
    resourceId: "evaluate-public-commentary",
  },
  name: "Inverse Cramer",
  nextOccurrenceAt: "2026-08-18T18:05:00.000Z",
  now: new Date(now),
  schedule: { anchor: now, everyMinutes: 10, kind: "interval" },
  scope: scopeA,
  sources: [{
    accessClassification: "public",
    canonicalUrl: "https://api.x.com/2/users/14216123/tweets",
    origin: "https://api.x.com",
    sourceId: "x-jim-cramer-public-statements",
  }],
});
assert.equal(activeMonitor.monitor.activationWatermark, now);
assert.equal(isWorkspaceMonitorCheckpointOnlyBaseline(activeMonitor.monitor), true);
const pausedMonitor = prepareWorkspaceMonitorCreate({
  ...activeMonitor.monitor,
  activateManagedMonitor: false,
  deliverySubscriptionId: activeMonitor.monitor.deliverySubscriptionId,
  instruction: activeMonitor.monitor.instruction,
  managedBy: activeMonitor.monitor.managedBy!,
  name: activeMonitor.monitor.name,
  nextOccurrenceAt: activeMonitor.monitor.nextOccurrenceAt!,
  now: new Date(now),
  schedule: activeMonitor.monitor.schedule,
  scope: scopeA,
  sources: activeMonitor.monitor.sources,
});
assert.equal(pausedMonitor.monitor.activationWatermark, undefined);

function attestedSemanticResult(workspaceId: string) {
  const modelId = "openai/gpt-5.4";
  const definition = createCommentarySemanticDefinition([modelId]);
  return hybridAcceptedResultSchema.parse({
    citations: [citation],
    definition: {
      definitionDigest: definition.definitionDigest,
      definitionId: definition.definitionId,
      definitionVersion: definition.definitionVersion,
    },
    disposition: "accepted",
    inputDigest: digestHybridEvidenceValue([workspaceId, "statement.x.200.1"]),
    jobId: `hybrid-job.${digestHybridEvidenceValue([workspaceId, "statement.x.200.1"])}`,
    model: {
      modelId,
      modelOutputDigest: digestHybridEvidenceValue(semantic),
      promptTemplateDigest: definition.instructionTemplate.digest,
    },
    outputDigest: digestHybridEvidenceValue(semantic),
    payload: semantic,
    purpose: "semantic_interpretation",
    recordType: "hybrid_evidence_accepted_result",
    resultId: `hybrid-result.${digestHybridEvidenceValue([workspaceId, semantic])}`,
    schemaVersion: 1,
    scope: {
      bindingRevision: 1,
      kind: "workspace",
      ownerId,
      packContentDigest: pack.contentDigest,
      packId: "inverse-cramer",
      packVersion: "1.0.0",
      workspaceId,
    },
    uncertainty: { confidence: null, coverage: "complete", unknowns: [] },
    usage: { inputTokens: 400, outputTokens: 200, paidCostUsd: "0.0100" },
    validatedAt: now,
    validationTrace: [{
      errorCode: null,
      outcome: "passed",
      validatorId: definition.requiredValidator.validatorId,
      validatorVersion: definition.requiredValidator.version,
    }],
  });
}
const semanticResultA = attestedSemanticResult(workspaceA);
const semanticResultB = attestedSemanticResult(workspaceB);
assert.equal(readAttestedCommentarySemanticResult({ pack: { contentDigest: pack.contentDigest, id: "inverse-cramer", version: "1.0.0" }, result: semanticResultA, scope: scopeA }).outcome, "accepted");
assert.throws(() => readAttestedCommentarySemanticResult({
  pack: { contentDigest: pack.contentDigest, id: "inverse-cramer", version: "1.0.0" },
  result: { ...semanticResultA, validationTrace: [{ ...semanticResultA.validationTrace[0]!, outcome: "failed", errorCode: "validator_failed" }] },
  scope: scopeA,
}), /accepted_result_invalid|public_commentary_semantic_attestation_invalid/u);

const base = {
  contextSearchRevisionId: null,
  corroboration,
  extractionDefinitionDigest: "c".repeat(64),
  fastModelId: "anthropic/claude-haiku-4.5",
  frontierModelId: "openai/gpt-5.4",
  interpretationDefinitionDigest: "d".repeat(64),
  monitorId: "monitor.inverse-cramer.fixture",
  now: new Date(now),
  ownerId,
  pack: { contentDigest: pack.contentDigest, id: "inverse-cramer" as const, version: "1.0.0" as const },
  plaintext: text,
  source: {
    accessClassification: "public" as const,
    adapterId: "x-public-statements",
    canonicalUrl: "https://api.x.com/2/users/14216123/tweets",
    origin: "https://api.x.com",
    sourceId: "x-jim-cramer-public-statements",
    sourceInstanceId: "x-public-statements.jim-cramer.v1",
  },
  statement: statement(),
  statementRevisionId: "statement.x.200.1",
  configurationGeneration: 1,
};
const configuration = {
  alerts: "enabled" as const,
  cadenceMinutes: "minutes_10" as const,
  includeQuotePosts: "exclude" as const,
  includeReplies: "exclude" as const,
  minimumConfidence: "medium" as const,
  minimumMateriality: "threshold_65" as const,
  relatedSourceSearch: "disabled" as const,
  selectedSymbols: [],
  timezone: "UTC",
};
const stageOrder: string[] = [];
const pipelineStore = new MemoryStore();
const attemptStore = new MemoryAttemptStore();
const pipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => {
    stageOrder.push("acquisition_projection");
    return { checkpoint: { contentDigest: "e".repeat(64), watermark: "200" }, statements: [{ plaintext: text, source: base.source, statement: statement(), statementRevisionId: "statement.x.200.1" }] };
  },
  attempts: attemptStore,
  corroboration: {
    async search() {
      stageOrder.push("related_search");
      return corroboration;
    },
  },
  findings: pipelineStore,
  interpret: async () => {
    stageOrder.push("frontier_interpretation");
    return {
      evidence: { result: semanticResultA },
      record: { job: { state: "accepted" } },
      strategyEvidence: { result: semanticResultA },
    } as never;
  },
});
const pipelineResult = await pipeline.run({
  configuration,
  configurationGeneration: 1,
  environment: {},
  monitorId: base.monitorId,
  ownerId,
  pack: base.pack,
  scope: scopeA,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
});
assert.deepEqual(stageOrder, ["acquisition_projection", "frontier_interpretation"]);
assert.equal(pipelineResult.analyzedStatements, 1);
assert.ok(pipelineResult.finding);
assert.equal(pipelineResult.checkpoint.watermark, "200");

const paidState = new MemoryCas();
const paidBudget = new MemoryCas();
const paidAttempts = new MemoryAttemptStore();
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now: new Date(now),
  scope: scopeA,
  value: {
    effectiveAt: now,
    maximumConcurrentWorkers: 4,
    maximumInputTokensPerDay: 10_000,
    maximumInputTokensPerRun: 4_000,
    maximumOutputTokensPerDay: 4_000,
    maximumOutputTokensPerRun: 1_000,
    maximumPaidPerCall: "0.01",
    maximumPaidPerDay: "0.05",
    maximumPaidPerMonth: "0.50",
    maximumScheduledRunsPerDay: 144,
    ownerTimezone: "UTC",
    unknownPriceFallbackCeiling: "0.01",
  },
}, paidState);
let paidExaCalls = 0;
const paidAttemptIds: string[] = [];
const paidPipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "f".repeat(64), watermark: "200" },
    statements: [{ plaintext: text, source: base.source, statement: statement(), statementRevisionId: "statement.x.200.1" }],
  }),
  attempts: paidAttempts,
  budget: paidBudget,
  corroboration: {
    async search({ now: queriedAt, query }) {
      paidExaCalls += 1;
      return webCorroborationSearchSchema.parse({
        completeness: "complete",
        cost: { amountUsd: "0.007000", billableUnits: 1, currency: "USD" },
        provider: "exa",
        queriedAt: queriedAt!.toISOString(),
        queryDigest: query.queryDigest,
        recordType: "web_corroboration_search",
        requestId: "exa-request.paid-fixture",
        results: [],
        schemaVersion: 1,
        status: "not_found",
      });
    },
  },
  findings: new MemoryStore(),
  interpret: async ({ attemptId }) => {
    paidAttemptIds.push(attemptId);
    return {
      evidence: { result: semanticResultA },
      record: { job: { state: "accepted" } },
      strategyEvidence: { result: semanticResultA },
    } as never;
  },
  state: paidState,
});
const paidRequest = {
  configuration: { ...configuration, relatedSourceSearch: "enabled" as const },
  configurationGeneration: 2,
  environment: {
    EVE_EXA_CORROBORATION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
  },
  monitorId: base.monitorId,
  ownerId,
  pack: base.pack,
  scope: scopeA,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
} as const;
await paidPipeline.run(paidRequest);
await paidPipeline.run(paidRequest);
assert.equal(paidExaCalls, 1, "a later batch replay must reuse the paid Exa result");
assert.equal(new Set(paidAttemptIds).size, 1, "statement attempt identity must be stable across replay");
const paidLedger = await readWorkspaceBudgetLedger(scopeA, paidBudget);
assert.equal(paidLedger.reservations.length, 1);
assert.equal(paidLedger.reservations[0]?.state, "reconciled");
assert.equal(paidLedger.reservations[0]?.reconciledPaidMicros, "7000");

let gatedProviderCalls = 0;
const gatedPipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "9".repeat(64), watermark: "200" },
    statements: [{ plaintext: text, source: base.source, statement: statement(), statementRevisionId: "statement.x.200.1" }],
  }),
  attempts: new MemoryAttemptStore(),
  corroboration: { async search() { gatedProviderCalls += 1; throw new Error("must_not_call"); } },
  findings: new MemoryStore(),
  interpret: async () => ({ evidence: { result: semanticResultA }, record: { job: { state: "accepted" } }, strategyEvidence: { result: semanticResultA } } as never),
});
await gatedPipeline.run({ ...paidRequest, configurationGeneration: 3, environment: {} });
assert.equal(gatedProviderCalls, 0, "owner setting alone cannot call Exa without the runtime flag");

let filteredSemanticCalls = 0;
const filteredPipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "8".repeat(64), watermark: "200" },
    statements: [
      { plaintext: text, source: base.source, statement: statement({ role: "reply" }), statementRevisionId: "statement.x.200.reply.1" },
      { plaintext: text, source: base.source, statement: statement({ role: "quote" }), statementRevisionId: "statement.x.200.quote.1" },
    ],
  }),
  attempts: new MemoryAttemptStore(),
  corroboration: { async search() { throw new Error("filtered_statement_must_not_search"); } },
  interpret: async () => { filteredSemanticCalls += 1; throw new Error("filtered_statement_must_not_run_semantics"); },
});
const filteredResult = await filteredPipeline.run({ ...paidRequest, configuration, configurationGeneration: 4, environment: {} });
assert.equal(filteredSemanticCalls, 0);
assert.equal(filteredResult.analyzedStatements, 2);
assert.equal(filteredResult.finding, null);

const naturalLanguageText = "Micron is executing better than anyone expected and its HBM position keeps improving.";
const naturalLanguageSpan = {
  end: naturalLanguageText.length,
  spanDigest: createHash("sha256").update(naturalLanguageText).digest("hex"),
  start: 0,
};
const naturalLanguageStatement = statement({
  contentDigest: digestPublicCommentaryValue(naturalLanguageText),
  entities: { cashtags: [], mentions: [], urls: [] },
  textLocators: [naturalLanguageSpan],
});
const directModelPack = { contentDigest: "5".repeat(64), id: "inverse-cramer", version: "1.4.4" } as const;
const directModelDefinition = createInverseCramerSemanticDefinition(["openai/gpt-5.4"], {
  definitionVersion: "1.0.3",
});
const naturalLanguageCitation = { artifactDigest, kind: "text_span" as const, ...naturalLanguageSpan };
const directModelSemantic = {
  ...semantic,
  counterevidence: [{ citations: [naturalLanguageCitation], statement: "The statement alone does not prove future returns." }],
  facts: [{ citations: [naturalLanguageCitation], statement: "Cramer describes Micron's execution and HBM position positively." }],
  forecast: {
    ...semantic.forecast,
    catalysts: [{ citations: [naturalLanguageCitation], statement: "Further HBM execution could support the expressed view." }],
    invalidationConditions: [{ citations: [naturalLanguageCitation], statement: "A later reversal by the speaker would invalidate the current view." }],
    likelyImplication: { citations: [naturalLanguageCitation], statement: "The registered inverse policy can evaluate an opposite-direction research candidate." },
    risks: [{ citations: [naturalLanguageCitation], statement: "The statement does not establish predictive accuracy." }],
    scenarios: [{ citations: [naturalLanguageCitation], condition: "The statement remains current.", direction: "negative" as const, label: "base" as const, rationale: "Only the registered transform supplies direction." }],
  },
  inferences: [{ citations: [naturalLanguageCitation], statement: "The speaker expresses a bullish view of Micron." }],
  marketView: {
    stance: "bullish" as const,
    targets: [{ displayName: "Micron Technology", symbol: "MU", type: "equity" as const }],
  },
  rationale: "The signed statement supports a positive view of Micron.",
  recommendation: {
    ...semantic.recommendation,
    citations: [naturalLanguageCitation],
  },
};
const directModelSemanticResult = hybridAcceptedResultSchema.parse({
  ...semanticResultA,
  definition: {
    definitionDigest: directModelDefinition.definitionDigest,
    definitionId: directModelDefinition.definitionId,
    definitionVersion: directModelDefinition.definitionVersion,
  },
  model: {
    ...semanticResultA.model,
    modelOutputDigest: digestHybridEvidenceValue(directModelSemantic),
    promptTemplateDigest: directModelDefinition.instructionTemplate.digest,
  },
  outputDigest: digestHybridEvidenceValue(directModelSemantic),
  payload: directModelSemantic,
  resultId: `hybrid-result.${digestHybridEvidenceValue(directModelSemantic)}`,
  scope: {
    ...semanticResultA.scope,
    packContentDigest: directModelPack.contentDigest,
    packId: directModelPack.id,
    packVersion: directModelPack.version,
  },
  validationTrace: [{
    errorCode: null,
    outcome: "passed",
    validatorId: directModelDefinition.requiredValidator.validatorId,
    validatorVersion: directModelDefinition.requiredValidator.version,
  }],
});
assert.equal(readAttestedCommentarySemanticResult({
  pack: directModelPack,
  result: directModelSemanticResult,
  scope: scopeA,
}).outcome, "accepted", "the active Inverse Cramer semantic version must attest without downgrading");
let directModelSelectedSymbols: readonly string[] | null = null;
const directModelPipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "5".repeat(64), watermark: "200" },
    statements: [{
      plaintext: naturalLanguageText,
      source: base.source,
      statement: naturalLanguageStatement,
      statementRevisionId: "statement.x.200.natural-language.1",
    }],
  }),
  attempts: new MemoryAttemptStore(),
  corroboration: { async search() { throw new Error("direct_model_path_must_not_search_before_materiality"); } },
  directModelActionability: true,
  findings: new MemoryStore(),
  interpret: async ({ selectedSymbols }) => {
    directModelSelectedSymbols = selectedSymbols;
    return {
      evidence: { result: directModelSemanticResult },
      record: { job: { state: "accepted" } },
      strategyEvidence: { result: directModelSemanticResult },
    } as never;
  },
});
const directModelResult = await directModelPipeline.run({
  ...paidRequest,
  configuration: { ...configuration, selectedSymbols: ["MU"] },
  configurationGeneration: 5,
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  },
  pack: directModelPack,
});
assert.deepEqual(directModelSelectedSymbols, ["MU"], "the signed semantic input must receive the owner watchlist");
assert.equal(directModelResult.finding?.facts[0]?.finding.policyDecision.researchDirection, "bearish");

let overflowSemanticCalls = 0;
let overflowSemanticActive = 0;
let overflowSemanticMaximumActive = 0;
const overflowAttempts = new MemoryAttemptStore();
const overflowFindings = new MemoryStore();
const overflowPipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "7".repeat(64), watermark: "707" },
    statements: Array.from({ length: 508 }, (_, index) => ({
      plaintext: text,
      source: base.source,
      statement: statement({ editChainIds: [String(200 + index)], stablePostId: String(200 + index) }),
      statementRevisionId: `statement.x.${200 + index}.1`,
    })),
  }),
  attempts: overflowAttempts,
  corroboration: { async search() { throw new Error("overflow_must_not_search"); } },
  findings: overflowFindings,
  interpret: async () => {
    overflowSemanticCalls += 1;
    overflowSemanticActive += 1;
    overflowSemanticMaximumActive = Math.max(overflowSemanticMaximumActive, overflowSemanticActive);
    await new Promise<void>((resolve) => setImmediate(resolve));
    overflowSemanticActive -= 1;
    return { evidence: { result: semanticResultA }, record: { job: { state: "accepted" } }, strategyEvidence: { result: semanticResultA } } as never;
  },
});
const overflowResult = await overflowPipeline.run({
  ...paidRequest,
  configuration,
  configurationGeneration: 6,
  environment: {},
});
assert.equal(overflowResult.analyzedStatements, 508);
assert.equal(overflowSemanticCalls, 508);
assert.equal(overflowSemanticMaximumActive, 2, "semantic preparation must respect the bounded model concurrency budget");
assert.equal(overflowResult.finding?.factIdentities.length, 8);
assert.equal(
  [...overflowAttempts.values.values()].some((value) => value.includes('"reason":"statements_overflow"')),
  false,
  "a normal multi-batch backlog must not quarantine the occurrence",
);

let overEnvelopeSemanticCalls = 0;
const overEnvelopeAttempts = new MemoryAttemptStore();
const overEnvelopePipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: "6".repeat(64), watermark: "708" },
    statements: Array.from({ length: 509 }, (_, index) => ({
      plaintext: text,
      source: base.source,
      statement: statement({ editChainIds: [String(300 + index)], stablePostId: String(300 + index) }),
      statementRevisionId: `statement.x.${300 + index}.1`,
    })),
  }),
  attempts: overEnvelopeAttempts,
  corroboration: { async search() { throw new Error("over_envelope_must_not_search"); } },
  interpret: async () => {
    overEnvelopeSemanticCalls += 1;
    throw new Error("over_envelope_must_not_run_semantics");
  },
});
await assert.rejects(
  overEnvelopePipeline.run({ ...paidRequest, configuration, configurationGeneration: 7, environment: {} }),
  /public_commentary_occurrence_statements_overflow/u,
);
assert.equal(overEnvelopeSemanticCalls, 0);
assert.equal(
  [...overEnvelopeAttempts.values.values()].some((value) => value.includes('"reason":"statements_overflow"')),
  true,
  "only a source-envelope violation should quarantine the occurrence",
);

const acceptedA = await materializePublicCommentarySignal({ ...base, configuration, scope: scopeA, semanticResult: semanticResultA }, store);
assert.equal(acceptedA.record.finding.outcome, "accepted");
assert.equal(acceptedA.record.finding.policyDecision.researchDirection, "bearish");
assert.ok(acceptedA.genericFinding);
workspaceFindingCandidateSchema.parse(acceptedA.genericFinding);
assert.match(acceptedA.alertPresentation!.whyMatched, /Primary citation: https:\/\/x\.com\/jimcramer\/status\/200 revision 1/u);
assert.match(acceptedA.alertPresentation!.whyMatched, /Inverse Cramer policy/u);
assert.match(acceptedA.alertPresentation!.whyMatched, /Related coverage: not_run/u);
const storedCount = store.values.size;
const replayA = await materializePublicCommentarySignal({ ...base, configuration, scope: scopeA, semanticResult: semanticResultA }, store);
assert.equal(replayA.record.finding.findingId, acceptedA.record.finding.findingId);
assert.equal(store.values.size, storedCount);

const acceptedB = await materializePublicCommentarySignal({
  ...base,
  configuration: { ...configuration, alerts: "enabled", selectedSymbols: ["TSLA"] },
  scope: scopeB,
  semanticResult: semanticResultB,
}, store);
assert.equal(acceptedB.alertPresentation, null);
assert.equal(acceptedB.record.finding.materiality.alertEligible, false);
assert.equal(acceptedB.record.finding.outcome, "accepted", "a nonmatching watchlist filters the alert, not the finding");
assert.deepEqual(acceptedB.record.finding.materiality.decisionReasons, ["target_not_selected"]);
assert.notEqual(acceptedB.record.finding.findingId, acceptedA.record.finding.findingId);
await assert.rejects(readPublicCommentaryFindingExplanation({ findingId: acceptedA.record.finding.findingId, scope: scopeB }, store), /public_commentary_finding_not_found/u);
assert.equal((await readLatestPublicCommentaryFindingExplanation(scopeA, store)).findingId, acceptedA.record.finding.findingId);

const projectionA = projectPublicCommentarySourceEvent({ configurationGeneration: 1, envelopeId: "revocable-evidence.x.200", factRevisionId: "statement.x.200.1", sourceEventId: "event.x.200.1", sourceInstanceId: "source.x-public-statements.14216123", workspaceId: workspaceA });
const projectionB = projectPublicCommentarySourceEvent({ configurationGeneration: 2, envelopeId: "revocable-evidence.x.200", factRevisionId: "statement.x.200.1", sourceEventId: "event.x.200.1", sourceInstanceId: "source.x-public-statements.14216123", workspaceId: workspaceB });
assert.notEqual(projectionA.budgetScopeId, projectionB.budgetScopeId);
assert.notEqual(projectionA.modelJobId, projectionB.modelJobId);
assert.notEqual(projectionA.findingStoreScopeId, projectionB.findingStoreScopeId);
assert.notEqual(projectionA.chatContextId, projectionB.chatContextId);

assert.equal(
  (await readPublicCommentaryFindingByStatementRevision(scopeA, acceptedA.record.finding.statementRevisionId, store))?.finding.findingId,
  acceptedA.record.finding.findingId,
  "the first lifecycle correction must resolve the ordinary finding before a supersession head exists",
);

const correction = await materializePublicCommentaryCorrection({ current: acceptedA.record, lifecycle: "deleted", now: new Date("2026-08-18T19:00:00.000Z"), scope: scopeA, sourceRevision: 2 }, store);
assert.equal(correction.record.finding.outcome, "retracted");
assert.equal(correction.record.correction?.reason, "source_deleted");
assert.match(correction.alertPresentation.whyMatched, /invalidated/u);
workspaceFindingCandidateSchema.parse(correction.genericFinding);
assert.equal((await readLatestPublicCommentaryFinding(scopeA, store))?.finding.findingId, correction.record.finding.findingId);
assert.equal((await readLatestPublicCommentaryFinding(scopeB, store))?.finding.findingId, acceptedB.record.finding.findingId);
const reopenedDeleted = await readPublicCommentaryFindingExplanation({ findingId: acceptedA.record.finding.findingId, scope: scopeA }, store);
assert.equal(reopenedDeleted.findingId, correction.record.finding.findingId);
assert.equal(reopenedDeleted.lifecycle, "deleted");
assert.equal(reopenedDeleted.direction, null);
assert.equal(reopenedDeleted.interpretationId, null);
assert.deepEqual(reopenedDeleted.targetSymbols, []);
assert.equal(reopenedDeleted.sourceFreshness, "correction_observed");
assert.equal(reopenedDeleted.liveRevalidation, "not_performed");
assert.equal(correction.record.statement.contentReference, null);
assert.deepEqual(correction.record.statement.textLocators, []);
assert.equal(correction.record.statement.revision, 2);
assert.equal(correction.record.finding.analysisIdentity.statementRevisionId, correction.record.finding.statementRevisionId);
assert.equal(correction.record.extraction, null);
assert.equal(correction.record.interpretation, null);
assert.equal(correction.record.directionDisclosure, null);
assert.equal(JSON.stringify(correction.record).includes(text), false);
assert.equal(JSON.stringify(correction.record).includes('"bearish"'), false);
assert.equal(JSON.stringify(correction.record).includes('"bullish"'), false);
assert.equal(
  (await readPublicCommentaryFindingByStatementRevision(scopeA, acceptedA.record.finding.statementRevisionId, store))?.finding.findingId,
  correction.record.finding.findingId,
);

const edited = await materializePublicCommentaryCorrection({ current: acceptedB.record, lifecycle: "edited", now: new Date("2026-08-18T19:05:00.000Z"), scope: scopeB, sourceRevision: 2 }, store);
const reopenedEdited = await readPublicCommentaryFindingExplanation({ findingId: acceptedB.record.finding.findingId, scope: scopeB }, store);
assert.equal(reopenedEdited.findingId, edited.record.finding.findingId);
assert.equal(reopenedEdited.lifecycle, "edited");
assert.equal(reopenedEdited.direction, null);
assert.equal(edited.record.statement.contentReference, null);
assert.deepEqual(edited.record.statement.textLocators, []);

const manage = await readPublicCommentaryWorkspacePresentation({
  credentialStatus: "configured",
  estimatedCostUsd: "0.005000",
  monitor: { lifecycleState: "paused", sourceCheckpoint: { watermark: "200" } },
  scope: scopeA,
  sourceStatus: "healthy",
}, store);
assert.equal(manage.credentialStatus, "configured");
assert.equal(manage.cost.mode, "pay_per_use");
assert.equal(manage.outcomes.retracted, 1);
assert.equal(manage.coverage, "not_run");

let exaCalls = 0;
const query = compileWebCorroborationQuery({ endPublishedAt: now, publicTargetTerms: ["Apple"], publicTopicTerms: [], startPublishedAt: "2026-08-11T18:00:00.000Z" });
const disabledSearch = await createExaWebCorroborationProvider({ apiKey: "unused", fetch: async () => { exaCalls += 1; throw new Error("must_not_call"); } }).search({ budgetAuthorized: false, enabled: false, now: new Date(now), query });
assert.equal(disabledSearch.status, "not_run");
assert.equal(exaCalls, 0);

const productionRuntime = new MemoryRuntimeCas();
const productionMonitor = prepareWorkspaceMonitorCreate({
  activateManagedMonitor: true,
  deliverySubscriptionId: "delivery.inverse-cramer.production-wiring",
  idempotencyKey: "inverse-cramer-production-wiring",
  instruction: "Establish a checkpoint-only public-commentary baseline.",
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: pack.contentDigest,
    packId: "inverse-cramer",
    packVersion: "1.0.0",
    resourceId: "monitor-inverse-cramer-commentary",
  },
  name: "Inverse Cramer production wiring fixture",
  nextOccurrenceAt: now,
  now: new Date(now),
  publicSourceIds: ["x-jim-cramer-public-statements"],
  schedule: { anchor: now, everyMinutes: 10, kind: "interval" },
  scope: scopeA,
  sources: [{
    accessClassification: "public",
    canonicalUrl: "https://api.x.com/2/users/14216123/tweets",
    origin: "https://api.x.com",
    sourceId: "x-jim-cramer-public-statements",
  }],
}).monitor;
const productionRunId = "run.inverse-cramer.production-wiring";
await createWorkspaceSourceCoverage({
  configurationRevision: productionMonitor.configurationRevision,
  monitorId: productionMonitor.monitorId,
  now: new Date(now),
  runId: productionRunId,
  scope: scopeA,
  sources: [{
    canonicalUrl: "https://api.x.com/2/users/14216123/tweets",
    origin: "https://api.x.com",
    sourceId: "x-jim-cramer-public-statements",
  }],
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
}, productionRuntime);
await assert.rejects(authorizeWorkspaceXExactPostFetch({
  providerPostId: "900",
  runId: productionRunId,
  scope: scopeA,
  sourceId: "x-jim-cramer-public-statements",
  url: "https://api.x.com/2/tweets/901",
}, productionRuntime), /source_outside_fence/u);
let productionXCalls = 0;
let productionPhase: "baseline" | "rehydration" = "baseline";
const productionExactUrls: string[] = [];
const authorityArtifactStore = createHybridEvidenceEphemeralArtifactStore({
  blob: new MemoryBlob(),
  index: new MemoryRuntimeCas(),
});
const xAuthorityArtifact = await authorityArtifactStore.persist({
  acquisitionId: "acquisition.x-authority",
  authority: "X",
  bytes: Buffer.from("x", "utf8"),
  canonicalPublicUrl: "https://x.com/jimcramer/status/900",
  mediaType: "text/plain",
  now: new Date(now),
  observedAt: now,
  parserEligibility: null,
  sourceInstanceId: "source.x-public-statements.14216123",
  structure: {
    characterCount: 1,
    columnCount: null,
    pageCount: null,
    rowCount: null,
    sheetCount: null,
  },
});
assert.equal(createWorkspaceSemanticSource({
  artifact: xAuthorityArtifact,
  authority: "X",
  factLogicalKey: "fact.x-authority",
  factPayloadDigest: "a".repeat(64),
  factRevisionId: "fact-revision.x-authority",
  projectionId: "projection.x-authority",
  sourceId: "x-jim-cramer-public-statements",
  sourceInstanceId: "source.x-public-statements.14216123",
  subscriptionId: "subscription.x-authority",
}).authority, "X");
const productionClients = {
  acquisition: productionRuntime,
  artifacts: createHybridEvidenceEphemeralArtifactStore({
    blob: new MemoryBlob(),
    index: productionRuntime,
  }),
  commentaryFindings: productionRuntime,
  corroboration: { async search() { throw new Error("baseline_must_not_search"); } },
  fetchResponse: async (request: { kind: "exact_post" | "timeline"; url: string }) => {
    productionXCalls += 1;
    if (request.kind === "exact_post") {
      productionExactUrls.push(request.url);
      const providerPostId = new URL(request.url).pathname.split("/").at(-1)!;
      return {
        body: JSON.stringify({
          data: {
            author_id: "14216123",
            conversation_id: "900",
            created_at: "2026-08-18T17:00:00.000Z",
            edit_controls: { editable_until: "2026-08-18T17:30:00.000Z" },
            edit_history_tweet_ids: ["900", "901"],
            entities: { cashtags: [{ tag: "AAPL" }] },
            id: providerPostId,
            text,
            ...(providerPostId === "901" ? { withheld: { country_codes: ["US"] } } : {}),
          },
        }),
        finalUrl: request.url,
        observedAt: "2026-08-19T18:01:00.000Z",
        rateLimit: 100,
        rateRemaining: 98,
        rateReset: 1_777_100_000,
        requestedUrl: request.url,
        status: 200,
      };
    }
    return {
      body: JSON.stringify(productionPhase === "baseline" ? {
        data: [{
          author_id: "14216123",
          conversation_id: "900",
          created_at: "2026-08-18T17:00:00.000Z",
          edit_controls: { editable_until: "2026-08-18T17:30:00.000Z" },
          edit_history_tweet_ids: ["900"],
          entities: { cashtags: [{ tag: "AAPL" }] },
          id: "900",
          text,
        }],
        meta: { newest_id: "900", result_count: 1 },
      } : { data: [], meta: { result_count: 0 } }),
      finalUrl: request.url,
      observedAt: productionPhase === "baseline" ? "2026-08-18T18:00:16.000Z" : "2026-08-19T18:01:00.000Z",
      rateLimit: 100,
      rateRemaining: 99,
      rateReset: 1_777_000_000,
      requestedUrl: request.url,
      status: 200,
    };
  },
  sourceCoverage: productionRuntime,
  semantic: { budget: productionRuntime },
  state: productionRuntime,
  subscription: productionRuntime,
  xEvidence: {
    client: productionRuntime,
    encryptionKey: Buffer.alloc(32, 7),
    keyReference: "kms://fixture/public-commentary",
  },
};
const productionPipeline = createProductionPublicCommentaryPipeline({
  allowedModelIds: ["openai/gpt-5.4"],
  clients: productionClients,
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
  },
  monitor: productionMonitor,
  now: new Date(now),
  runId: productionRunId,
  scope: scopeA,
  workspaceGeneration: 1,
});
const productionBudget = {
  effectiveAt: now,
  maximumConcurrentWorkers: 4,
  maximumInputTokensPerDay: 10_000,
  maximumInputTokensPerRun: 4_000,
  maximumOutputTokensPerDay: 4_000,
  maximumOutputTokensPerRun: 1_000,
  maximumPaidPerCall: "1.00",
  maximumPaidPerDay: "3.00",
  maximumPaidPerMonth: "30.00",
  maximumScheduledRunsPerDay: 144,
  ownerTimezone: "UTC",
  unknownPriceFallbackCeiling: "1.00",
} as const;
for (const scope of [scopeA, scopeB]) {
  await writeWorkspaceDocument("budget", {
    expectedRevision: 0,
    now: new Date(now),
    scope,
    value: productionBudget,
  }, productionRuntime);
}
const reserveProductionOccurrence = async (scope: typeof scopeA, runId: string, occurrenceNow: string) =>
  reserveWorkspaceRunBudget({
    inputTokens: productionBudget.maximumInputTokensPerRun,
    kind: "scheduled_monitor",
    now: new Date(occurrenceNow),
    outputTokens: productionBudget.maximumOutputTokensPerRun,
    paidCostCeiling: { amount: "2.000000", kind: "known" },
    policy: productionBudget,
    policyRevision: 1,
    runId,
    scope,
  }, productionRuntime);
await reserveProductionOccurrence(scopeA, productionRunId, now);
const productionBaseline = await productionPipeline.run({
  configuration,
  configurationGeneration: 1,
  environment: {},
  monitorId: productionMonitor.monitorId,
  ownerId,
  pack: base.pack,
  scope: scopeA,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
});
await productionBaseline.acknowledgeDurableCommit?.();
assert.equal(productionXCalls, 1);
assert.equal(productionBaseline.analyzedStatements, 0);
assert.equal(productionBaseline.finding, null);
assert.equal(productionBaseline.checkpoint.watermark, now);
assert.equal((await readWorkspaceSourceCoverage(scopeA, productionRunId, productionRuntime))?.successes.length, 1);
const committedProductionCoverage = await completeWorkspaceSourceCoverage({
  checkpoint: productionBaseline.checkpoint,
  now: new Date("2026-08-18T18:00:17.000Z"),
  runId: productionRunId,
  scope: scopeA,
}, productionRuntime);
assert.equal(committedProductionCoverage.state, "complete", "the first delayed-observation result commit must succeed");
assert.deepEqual(await completeWorkspaceSourceCoverage({
  checkpoint: productionBaseline.checkpoint,
  now: new Date("2026-08-18T18:00:18.000Z"),
  runId: productionRunId,
  scope: scopeA,
}, productionRuntime), committedProductionCoverage, "an identical completed result commit must be idempotent");
await assert.rejects(completeWorkspaceSourceCoverage({
  checkpoint: {
    contentDigest: "f".repeat(64),
    watermark: productionBaseline.checkpoint.watermark,
  },
  now: new Date("2026-08-18T18:00:19.000Z"),
  runId: productionRunId,
  scope: scopeA,
}, productionRuntime), (error) =>
  error instanceof WorkspaceSourceCoverageError && error.code === "source_coverage_conflict",
  "a different completed result must remain a genuine conflict");

const cadenceRuntime = new MemoryRuntimeCas();
const cadencePack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.0" });
assert.ok(cadencePack && cadencePack.availability === "available");
const cadenceMonitor = prepareWorkspaceMonitorCreate({
  activateManagedMonitor: true,
  deliverySubscriptionId: "delivery.inverse-cramer.cadence-first-run",
  idempotencyKey: "inverse-cramer-cadence-first-run",
  instruction: "Evaluate exactly one cadence-derived first-run interval.",
  lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: cadencePack.contentDigest,
    packId: cadencePack.id,
    packVersion: cadencePack.version,
    resourceId: "evaluate-public-commentary",
  },
  name: "Inverse Cramer cadence first-run fixture",
  nextOccurrenceAt: now,
  now: new Date(now),
  publicSourceIds: ["x-jim-cramer-public-statements"],
  schedule: { anchor: now, everyMinutes: 720, kind: "interval" },
  scope: scopeC,
  sources: productionMonitor.sources,
}).monitor;
assert.equal(isWorkspaceMonitorCheckpointOnlyBaseline(cadenceMonitor), true);
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now: new Date(now),
  scope: scopeC,
  value: productionBudget,
}, cadenceRuntime);
const cadenceRunId = "run.inverse-cramer.cadence-first-run";
await reserveWorkspaceRunBudget({
  inputTokens: productionBudget.maximumInputTokensPerRun,
  kind: "scheduled_monitor",
  now: new Date(now),
  outputTokens: productionBudget.maximumOutputTokensPerRun,
  paidCostCeiling: { amount: "2.000000", kind: "known" },
  policy: productionBudget,
  policyRevision: 1,
  runId: cadenceRunId,
  scope: scopeC,
}, cadenceRuntime);
await createWorkspaceSourceCoverage({
  configurationRevision: cadenceMonitor.configurationRevision,
  monitorId: cadenceMonitor.monitorId,
  now: new Date(now),
  runId: cadenceRunId,
  scope: scopeC,
  sources: cadenceMonitor.sources.map(({ canonicalUrl, origin, sourceId }) => ({
    canonicalUrl,
    origin,
    sourceId,
  })),
  window: { endAt: now, startAt: "2026-08-18T06:00:00.000Z" },
}, cadenceRuntime);
const cadenceTimelineUrls: string[] = [];
const cadencePipeline = createProductionPublicCommentaryPipeline({
  allowedModelIds: ["openai/gpt-5.4"],
  clients: {
    acquisition: cadenceRuntime,
    artifacts: createHybridEvidenceEphemeralArtifactStore({
      blob: new MemoryBlob(),
      index: cadenceRuntime,
    }),
    commentaryFindings: cadenceRuntime,
    corroboration: { async search() { throw new Error("non_actionable_first_run_must_not_search"); } },
    fetchResponse: async (request) => {
      assert.equal(request.kind, "timeline");
      cadenceTimelineUrls.push(request.url);
      const cadenceText = "Tune in tonight for the latest market discussion.";
      return {
        body: JSON.stringify({
          data: [{
            author_id: "14216123",
            conversation_id: "950",
            created_at: "2026-08-18T17:00:00.000Z",
            edit_controls: { editable_until: "2026-08-18T17:30:00.000Z" },
            edit_history_tweet_ids: ["950"],
            entities: {},
            id: "950",
            text: cadenceText,
          }],
          meta: { newest_id: "950", result_count: 1 },
        }),
        finalUrl: request.url,
        observedAt: "2026-08-18T18:00:16.000Z",
        rateLimit: 100,
        rateRemaining: 99,
        rateReset: 1_777_000_000,
        requestedUrl: request.url,
        status: 200,
      };
    },
    sourceCoverage: cadenceRuntime,
    semantic: { budget: cadenceRuntime },
    state: cadenceRuntime,
    subscription: cadenceRuntime,
    xEvidence: {
      client: cadenceRuntime,
      encryptionKey: Buffer.alloc(32, 8),
      keyReference: "kms://fixture/public-commentary-cadence",
    },
  },
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
  },
  monitor: cadenceMonitor,
  now: new Date(now),
  runId: cadenceRunId,
  scope: scopeC,
  workspaceGeneration: 1,
});
const cadenceFirstRun = await cadencePipeline.run({
  configuration: { ...configuration, cadenceMinutes: "hours_12" },
  configurationGeneration: 1,
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  },
  initialBackfill: true,
  monitorId: cadenceMonitor.monitorId,
  ownerId,
  parentBudgetRunId: cadenceRunId,
  pack: {
    contentDigest: cadencePack.contentDigest,
    id: cadencePack.id,
    lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    version: cadencePack.version,
  },
  scope: scopeC,
  window: { endAt: now, startAt: "2026-08-18T06:00:00.000Z" },
});
assert.equal(new URL(cadenceTimelineUrls[0]!).searchParams.get("start_time"), "2026-08-18T06:00:00.000Z");
assert.equal(cadenceFirstRun.analyzedStatements, 1,
  "a cadence-derived first run must pass its acquired interval into deterministic statement analysis");
assert.equal(cadenceFirstRun.finding, null);

const productionMonitorB = prepareWorkspaceMonitorCreate({
  activateManagedMonitor: true,
  deliverySubscriptionId: "delivery.inverse-cramer.production-wiring-b",
  idempotencyKey: "inverse-cramer-production-wiring-b",
  instruction: "Establish a second checkpoint-only public-commentary baseline.",
  managedBy: productionMonitor.managedBy!,
  name: "Inverse Cramer production wiring fixture B",
  nextOccurrenceAt: now,
  now: new Date(now),
  publicSourceIds: ["x-jim-cramer-public-statements"],
  schedule: { anchor: now, everyMinutes: 10, kind: "interval" },
  scope: scopeB,
  sources: productionMonitor.sources,
}).monitor;
const productionRunIdB = "run.inverse-cramer.production-wiring-b";
await reserveProductionOccurrence(scopeB, productionRunIdB, now);
const productionSources = productionMonitor.sources.map(({ canonicalUrl, origin, sourceId }) => ({
  canonicalUrl,
  origin,
  sourceId,
}));
await createWorkspaceSourceCoverage({
  configurationRevision: productionMonitorB.configurationRevision,
  monitorId: productionMonitorB.monitorId,
  now: new Date(now),
  runId: productionRunIdB,
  scope: scopeB,
  sources: productionSources,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
}, productionRuntime);
const productionPipelineB = createProductionPublicCommentaryPipeline({
  allowedModelIds: ["openai/gpt-5.4"],
  clients: productionClients,
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
  },
  monitor: productionMonitorB,
  now: new Date(now),
  runId: productionRunIdB,
  scope: scopeB,
  workspaceGeneration: 1,
});
const productionBaselineB = await productionPipelineB.run({
  configuration,
  configurationGeneration: 1,
  environment: {},
  monitorId: productionMonitorB.monitorId,
  ownerId,
  pack: base.pack,
  scope: scopeB,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
});
await productionBaselineB.acknowledgeDurableCommit?.();
assert.equal(productionXCalls, 1, "the second workspace must reuse the source-global baseline");
productionPhase = "rehydration";
const rehydrationNow = "2026-08-19T18:01:00.000Z";
const rehydrationWindow = { endAt: rehydrationNow, startAt: "2026-08-19T17:51:00.000Z" };
const activeProductionMonitorA = {
  ...productionMonitor,
  sourceCheckpoint: productionBaseline.checkpoint,
};
const activeProductionMonitorB = {
  ...productionMonitorB,
  sourceCheckpoint: productionBaseline.checkpoint,
};
const pendingLifecycleCommits = [] as Array<() => Promise<void>>;
for (const [scope, monitor, runId] of [
  [scopeA, activeProductionMonitorA, "run.inverse-cramer.rehydration-a"],
  [scopeB, activeProductionMonitorB, "run.inverse-cramer.rehydration-b"],
] as const) {
  await reserveProductionOccurrence(scope, runId, rehydrationNow);
  await createWorkspaceSourceCoverage({
    configurationRevision: monitor.configurationRevision,
    monitorId: monitor.monitorId,
    now: new Date(rehydrationNow),
    runId,
    scope,
    sources: productionSources,
    window: rehydrationWindow,
  }, productionRuntime);
  const lifecyclePipeline = createProductionPublicCommentaryPipeline({
    allowedModelIds: ["openai/gpt-5.4"],
    clients: productionClients,
    environment: {
      EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
      EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
      EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
      EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
      EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
      EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
      EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
    },
    monitor,
    now: new Date(rehydrationNow),
    runId,
    scope,
    workspaceGeneration: 1,
  });
  const lifecycleResult = await lifecyclePipeline.run({
    configuration,
    configurationGeneration: 1,
    environment: {},
    monitorId: monitor.monitorId,
    ownerId,
    pack: base.pack,
    scope,
    window: rehydrationWindow,
  });
  assert.ok(lifecycleResult.acknowledgeDurableCommit);
  pendingLifecycleCommits.push(lifecycleResult.acknowledgeDurableCommit);
}
assert.equal(productionExactUrls.length, 2, "one bounded edit-chain lookup must fan out to both workspaces");
for (const acknowledge of pendingLifecycleCommits) await acknowledge();
assert.equal(new URL(productionExactUrls[0]!).pathname, "/2/tweets/900");
assert.equal(new URL(productionExactUrls[1]!).pathname, "/2/tweets/901");
assert.equal(productionXCalls, 4, "baseline, next timeline, and one bounded shared edit-chain lookup are the only external reads");
const productionBudgetLedger = await readWorkspaceBudgetLedger(scopeA, productionRuntime);
const exactReservation = productionBudgetLedger.reservations.find(({ runId }) => runId.startsWith("x-exact."));
assert.equal(exactReservation?.state, "reconciled");
assert.equal(exactReservation?.reconciledPaidMicros, "10000");
const paidTimelineReservation = productionBudgetLedger.reservations.find(({ runId }) =>
  runId.startsWith("x-timeline.") && runId.includes(createHash("sha256").update(productionRunId).digest("hex")));
assert.equal(paidTimelineReservation?.state, "reconciled");
assert.equal(paidTimelineReservation?.reconciledPaidMicros, "5000");
assert.equal((await readRevocableEvidenceEnvelope("revocable-evidence.x.900", productionRuntime))?.currentLifecycle, "withheld");

const workerCapabilities = await readFile(new URL("../agent/subagents/workspace-worker/tools/capabilities.ts", import.meta.url), "utf8");
assert.match(workerCapabilities, /evaluatePublicCommentarySignalsTool/u);
assert.doesNotMatch(workerCapabilities, /broker|coinbase_create_order/u);
const explanationTool = await readFile(new URL("../agent/tools/explain_public_commentary_signal.ts", import.meta.url), "utf8");
assert.match(explanationTool, /authorizePhotonWorkspaceToolStore/u);
assert.match(explanationTool, /inverse-cramer/u);

console.info("public commentary Sprint 3 pack, vertical, correction, alert, Manage, Discuss, and isolation verification passed");
