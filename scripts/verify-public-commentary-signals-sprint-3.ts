import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { createPublicCommentaryPipeline, INVERSE_CRAMER_POLICY, materializePublicCommentaryCorrection, materializePublicCommentarySignal } from "../agent/lib/public-commentary-vertical";
import { readLatestPublicCommentaryFinding, type PublicCommentaryFindingStoreClient } from "../agent/lib/public-commentary-finding-store";
import { readLatestPublicCommentaryFindingExplanation, readPublicCommentaryFindingExplanation, readPublicCommentaryWorkspacePresentation } from "../agent/lib/public-commentary-presentation";
import { digestPublicCommentaryValue, publicStatementSchema, webCorroborationSearchSchema, type PublicStatement } from "../agent/lib/public-commentary-schema";
import { projectPublicCommentarySourceEvent } from "../agent/lib/public-commentary-workspace-isolation";
import { createExaWebCorroborationProvider, compileWebCorroborationQuery } from "../agent/lib/web-corroboration-search";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { workspaceFindingCandidateSchema } from "../agent/lib/workspace-finding-store";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "../agent/lib/strategy-pack-reference-catalog";

class MemoryStore implements PublicCommentaryFindingStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const ownerId = "owner_fixture";
const environment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const scopeA = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceA }, environment);
const scopeB = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceB }, environment);
const store = new MemoryStore();
const now = "2026-08-18T18:00:00.000Z";
const text = "I remain bullish on $AAPL for the next quarter.";
const spanDigest = createHash("sha256").update(text).digest("hex");
const artifactDigest = "a".repeat(64);
const citation = { artifactDigest, end: text.length, kind: "text_span" as const, spanDigest, start: 0 };
const claim = (statement: string) => ({ citations: [citation], statement });

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
  semantic,
  statement: statement(),
  statementRevisionId: "statement.x.200.1",
  configurationGeneration: 1,
};
const configuration = { alerts: "enabled" as const, minimumConfidence: "medium" as const, minimumMateriality: "threshold_65" as const, selectedSymbols: ["AAPL"] };
const stageOrder: string[] = [];
const pipelineStore = new MemoryStore();
const pipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => {
    stageOrder.push("acquisition_projection");
    return { checkpoint: { contentDigest: "e".repeat(64), watermark: "200" }, statements: [{ plaintext: text, statement: statement(), statementRevisionId: "statement.x.200.1" }] };
  },
  corroboration: {
    async search() {
      stageOrder.push("related_search");
      return corroboration;
    },
  },
  findings: pipelineStore,
  interpret: async () => {
    stageOrder.push("frontier_interpretation");
    return semantic;
  },
});
const pipelineResult = await pipeline.run({
  configuration: { ...configuration, relatedSourceSearch: "disabled" },
  configurationGeneration: 1,
  environment: {},
  monitorId: base.monitorId,
  ownerId,
  pack: base.pack,
  scope: scopeA,
  window: { endAt: now, startAt: "2026-08-18T17:50:00.000Z" },
});
assert.deepEqual(stageOrder, ["acquisition_projection", "related_search", "frontier_interpretation"]);
assert.equal(pipelineResult.analyzedStatements, 1);
assert.ok(pipelineResult.finding);
assert.equal(pipelineResult.checkpoint.watermark, "200");
const acceptedA = await materializePublicCommentarySignal({ ...base, configuration, scope: scopeA }, store);
assert.equal(acceptedA.record.finding.outcome, "accepted");
assert.equal(acceptedA.record.finding.policyDecision.researchDirection, "bearish");
assert.ok(acceptedA.genericFinding);
workspaceFindingCandidateSchema.parse(acceptedA.genericFinding);
assert.match(acceptedA.alertPresentation!.whyMatched, /Primary citation: https:\/\/x\.com\/jimcramer\/status\/200 revision 1/u);
assert.match(acceptedA.alertPresentation!.whyMatched, /Inverse Cramer policy/u);
assert.match(acceptedA.alertPresentation!.whyMatched, /Related coverage: not_run/u);
const storedCount = store.values.size;
const replayA = await materializePublicCommentarySignal({ ...base, configuration, scope: scopeA }, store);
assert.equal(replayA.record.finding.findingId, acceptedA.record.finding.findingId);
assert.equal(store.values.size, storedCount);

const acceptedB = await materializePublicCommentarySignal({
  ...base,
  configuration: { ...configuration, alerts: "disabled", selectedSymbols: ["TSLA"] },
  scope: scopeB,
}, store);
assert.equal(acceptedB.alertPresentation, null);
assert.equal(acceptedB.record.finding.materiality.alertEligible, false);
assert.notEqual(acceptedB.record.finding.findingId, acceptedA.record.finding.findingId);
await assert.rejects(readPublicCommentaryFindingExplanation({ findingId: acceptedA.record.finding.findingId, scope: scopeB }, store), /public_commentary_finding_not_found/u);
assert.equal((await readLatestPublicCommentaryFindingExplanation(scopeA, store)).findingId, acceptedA.record.finding.findingId);

const projectionA = projectPublicCommentarySourceEvent({ configurationGeneration: 1, envelopeId: "revocable-evidence.x.200", factRevisionId: "statement.x.200.1", sourceEventId: "event.x.200.1", sourceInstanceId: "source.x-public-statements.14216123", workspaceId: workspaceA });
const projectionB = projectPublicCommentarySourceEvent({ configurationGeneration: 2, envelopeId: "revocable-evidence.x.200", factRevisionId: "statement.x.200.1", sourceEventId: "event.x.200.1", sourceInstanceId: "source.x-public-statements.14216123", workspaceId: workspaceB });
assert.notEqual(projectionA.budgetScopeId, projectionB.budgetScopeId);
assert.notEqual(projectionA.modelJobId, projectionB.modelJobId);
assert.notEqual(projectionA.findingStoreScopeId, projectionB.findingStoreScopeId);
assert.notEqual(projectionA.chatContextId, projectionB.chatContextId);

const correction = await materializePublicCommentaryCorrection({ current: acceptedA.record, lifecycle: "deleted", now: new Date("2026-08-18T19:00:00.000Z"), scope: scopeA, sourceRevision: 2 }, store);
assert.equal(correction.record.finding.outcome, "retracted");
assert.equal(correction.record.correction?.reason, "source_deleted");
assert.match(correction.alertPresentation.whyMatched, /invalidated/u);
workspaceFindingCandidateSchema.parse(correction.genericFinding);
assert.equal((await readLatestPublicCommentaryFinding(scopeA, store))?.finding.findingId, correction.record.finding.findingId);
assert.equal((await readLatestPublicCommentaryFinding(scopeB, store))?.finding.findingId, acceptedB.record.finding.findingId);

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

const workerCapabilities = await readFile(new URL("../agent/subagents/workspace-worker/tools/capabilities.ts", import.meta.url), "utf8");
assert.match(workerCapabilities, /evaluatePublicCommentarySignalsTool/u);
assert.doesNotMatch(workerCapabilities, /broker|coinbase_create_order/u);
const explanationTool = await readFile(new URL("../agent/tools/explain_public_commentary_signal.ts", import.meta.url), "utf8");
assert.match(explanationTool, /authorizePhotonWorkspaceToolStore/u);
assert.match(explanationTool, /inverse-cramer/u);

console.info("public commentary Sprint 3 pack, vertical, correction, alert, Manage, Discuss, and isolation verification passed");
