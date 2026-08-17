import assert from "node:assert/strict";

import { workspaceHtml } from "../agent/channels/photon-workspace-app";
import {
  persistEarningsCallFinding,
  readEarningsCallFinding,
  readLatestEarningsCallFinding,
  type EarningsCallFindingStoreClient,
} from "../agent/lib/earnings-call-finding-store";
import {
  decideEarningsCallMateriality,
  earningsCallMaterialityScore,
} from "../agent/lib/earnings-call-materiality";
import { readEarningsCallWorkspacePresentation } from "../agent/lib/earnings-call-presentation";
import {
  persistEarningsCallIssuerStatus,
  readEarningsCallIssuerStatus,
  type EarningsCallIssuerStatusStoreClient,
} from "../agent/lib/earnings-call-status-store";
import {
  digestEarningsCallValue,
  EARNINGS_CALL_SCHEMA_VERSION,
  earningsComparisonSchema,
  earningsFindingSchema,
} from "../agent/lib/earnings-call-schema";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveStrategyPackConfiguration } from "../agent/lib/strategy-pack-service";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { workspaceAlertTurnContext } from "../agent/lib/workspace-alert-presentation";
import {
  prepareWorkspaceMonitorCreate,
  WorkspaceMonitorError,
} from "../agent/lib/workspace-monitor-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryFindingStore implements EarningsCallFindingStoreClient, EarningsCallIssuerStatusStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return { created: false, value: current };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const pack = strategyPackCatalog.entries.find((entry) =>
  entry.id === "earnings-call-changes" && entry.version === "1.0.0");
assert.ok(pack);
assert.equal(pack.availability, "available");
assert.equal(pack.monitors[0]?.activationDefault, "paused");
assert.equal(pack.monitors[0]?.requiredCapabilityIds[0], "evaluate_earnings_call_changes");
assert.equal(pack.sources[0]?.parameterization?.selectionConfigurationKey, "selectedIssuerCiks");
assert.equal(pack.evidenceContracts?.length, 3);
assert.deepEqual(resolveStrategyPackConfiguration(pack, {
  dailyTimes: ["08:30"],
  materialityThreshold: "threshold_65",
  selectedIssuerCiks: ["0000789019"],
  timezone: "America/Vancouver",
}).configuration.selectedIssuerCiks, ["0000789019"]);
assert.throws(() => resolveStrategyPackConfiguration(pack, {
  selectedIssuerCiks: [],
}), /strategy_pack_invalid_request/u);

const metricCore = {
  cik: "0000789019",
  comparisonId: "comparison.fixture.sprint4",
  current: {
    artifactDigest: "a".repeat(64), eventRevisionId: "event.current.fixture",
    fiscalPeriod: "FY2026-Q3", transcriptId: "transcript.current.fixture",
  },
  metricVersion: "1.0.0",
  metrics: [
    { currentValue: 6, delta: 6, metricId: "commitment_language_rate" as const, priorValue: 0, sectionKind: "prepared_remarks" as const, unit: "ratio" as const },
    { currentValue: 5, delta: 5, metricId: "specificity_rate" as const, priorValue: 0, sectionKind: "prepared_remarks" as const, unit: "ratio" as const },
    { currentValue: 4, delta: 4, metricId: "qa_directness_rate" as const, priorValue: 0, sectionKind: "questions_and_answers" as const, unit: "ratio" as const },
    { currentValue: 3, delta: 3, metricId: "risk_language_rate" as const, priorValue: 0, sectionKind: "questions_and_answers" as const, unit: "ratio" as const },
  ],
  prior: {
    artifactDigest: "b".repeat(64), eventRevisionId: "event.prior.fixture",
    fiscalPeriod: "FY2026-Q2", transcriptId: "transcript.prior.fixture",
  },
  recordType: "earnings_call_comparison" as const,
  schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
  secondaryYearAgo: null,
};
const comparison = earningsComparisonSchema.parse({
  ...metricCore,
  comparisonDigest: digestEarningsCallValue(metricCore),
});
assert.equal(earningsCallMaterialityScore(comparison), 80);
assert.equal(decideEarningsCallMateriality({
  activationWatermark: "2026-08-16T00:00:00.000Z",
  comparison,
  currentPublishedAt: "2026-08-17T00:00:00.000Z",
  outcome: "accepted",
  threshold: 65,
}).alertEligible, true);
assert.equal(decideEarningsCallMateriality({
  activationWatermark: "2026-08-18T00:00:00.000Z",
  comparison,
  currentPublishedAt: "2026-08-17T00:00:00.000Z",
  outcome: "accepted",
  threshold: 65,
}).alertEligible, false);

const citation = {
  artifactDigest: "a".repeat(64), end: 48, eventRevisionId: "event.current.fixture",
  sectionId: "section.current.fixture", spanDigest: "c".repeat(64), start: 12,
  transcriptId: "transcript.current.fixture",
};
const ownerId = "owner_fixture_earnings_sprint_4";
const environment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const scopeA = authorizeDeploymentWorkspaceStore({
  ownerId,
  workspaceId: "123e4567-e89b-42d3-a456-426614174441",
}, environment);
const scopeB = authorizeDeploymentWorkspaceStore({
  ownerId,
  workspaceId: "123e4567-e89b-42d3-a456-426614174442",
}, environment);
const scopeC = authorizeDeploymentWorkspaceStore({
  ownerId,
  workspaceId: "123e4567-e89b-42d3-a456-426614174443",
}, environment);
const monitorInput = (cik: string) => {
  const sourceId = `earnings-call-transcripts.${cik}`;
  const reviewed = cik === "0000789019" ? resolveReviewedPublicSource(sourceId) : null;
  return {
    activateManagedMonitor: true,
    deliverySubscriptionId: "delivery.earnings-call-sprint-4",
    instruction: "Compare reviewed earnings-call transcripts.",
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack" as const,
      packContentDigest: pack.contentDigest,
      packId: "earnings-call-changes",
      packVersion: "1.0.0",
      resourceId: "compare-earnings-calls",
    },
    name: "Compare earnings calls",
    nextOccurrenceAt: "2026-08-18T09:00:00.000Z",
    now: new Date("2026-08-17T17:00:00.000Z"),
    schedule: { at: "2026-08-18T09:00:00.000Z", kind: "one_time" as const },
    scope: scopeA,
    sources: [{
      accessClassification: "public" as const,
      canonicalUrl: reviewed?.sourceContract.canonicalUrl ?? `https://unsupported.example/${cik}`,
      origin: reviewed?.sourceInstance.authorityOrigin ?? "https://unsupported.example",
      sourceId,
    }],
  };
};
assert.equal(
  prepareWorkspaceMonitorCreate(monitorInput("0000789019")).monitor.activationWatermark,
  "2026-08-17T17:00:00.000Z",
);
assert.throws(
  () => prepareWorkspaceMonitorCreate(monitorInput("0001341439")),
  (error) => error instanceof WorkspaceMonitorError && error.code === "monitor_invalid",
);
const findingFor = (workspaceId: string, suffix: string) => {
  const core = {
    activationWatermark: "2026-08-16T00:00:00.000Z",
    analysisLineage: {
      budgetAttempt: 1, configurationRevision: 2, definitionDigest: "d".repeat(64),
      definitionId: "earnings-call-semantic-comparison", definitionVersion: "1.0.0",
      modelId: "google/gemini-3.6-flash", promptDigest: "e".repeat(64), validatorVersion: "1.0.0",
    },
    comparisonDigest: comparison.comparisonDigest,
    comparisonId: comparison.comparisonId,
    confidence: "high" as const,
    counterevidence: [{ citations: [citation], statement: "Demand stability remains an explicit condition." }],
    facts: [{ citations: [citation], statement: "Management added explicit shipment and margin assumptions." }],
    findingId: `earnings-finding.fixture.${suffix}`,
    forecast: {
      catalysts: [], citations: [citation], direction: "positive" as const, horizon: "next_quarter" as const,
      invalidationConditions: ["Demand weakens materially."],
      likelyMarketInterpretation: "The added specificity may be interpreted constructively.",
      risks: [], scenarios: [{ condition: "Demand remains stable.", direction: "positive" as const, label: "base" as const, rationale: "Execution follows stated assumptions." }],
    },
    inferences: [{ citations: [citation], statement: "The outlook became more specific and constructive." }],
    materiality: {
      alertEligible: true, configuredThreshold: 65, decisionReasons: ["material_change" as const],
      deterministicScore: 80, policyVersion: "1.0.0",
    },
    monitorId: "223e4567-e89b-42d3-a456-426614174440",
    outcome: "accepted" as const,
    ownerId,
    pack: { contentDigest: pack.contentDigest, id: "earnings-call-changes" as const, version: "1.0.0" },
    recordType: "earnings_call_finding" as const,
    recommendation: {
      assumptions: ["Demand remains stable."], citations: [citation],
      conditionalImplication: "Watch execution against the stated assumptions.",
      rationale: "Specificity improved with cited operating conditions.", stance: "constructive" as const,
      valuationAssessment: "not_assessed" as const,
    },
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    unknowns: [],
    workspaceId,
  };
  return earningsFindingSchema.parse({ ...core, findingDigest: digestEarningsCallValue(core) });
};
const recordFor = (scope: typeof scopeA, suffix: string) => ({
  cik: "0000789019",
  companyName: "Microsoft Corporation",
  createdAt: "2026-08-17T17:00:00.000Z",
  finding: findingFor(scope.workspaceId, suffix),
  recordType: "earnings_call_finding_record" as const,
  schemaVersion: 1 as const,
  sources: [
    { canonicalUrl: "https://www.microsoft.com/en-us/Investor/events/FY-2026-Q3.html", eventRevisionId: "event.current.fixture", fiscalPeriod: "FY2026-Q3", role: "current" as const },
    { canonicalUrl: "https://www.microsoft.com/en-us/Investor/events/FY-2026-Q2.html", eventRevisionId: "event.prior.fixture", fiscalPeriod: "FY2026-Q2", role: "prior" as const },
  ],
  ticker: "MSFT",
});
const store = new MemoryFindingStore();
const recordA = recordFor(scopeA, "workspace-a");
const recordB = recordFor(scopeB, "workspace-b");
assert.equal(await persistEarningsCallFinding({ record: recordA, scope: scopeA }, store), "created");
assert.equal(await persistEarningsCallFinding({ record: recordB, scope: scopeB }, store), "created");
assert.equal((await readLatestEarningsCallFinding(scopeA, store))?.finding.findingId, recordA.finding.findingId);
assert.equal((await readLatestEarningsCallFinding(scopeB, store))?.finding.findingId, recordB.finding.findingId);
assert.equal(await readEarningsCallFinding(scopeB, recordA.finding.findingId, store), null);
assert.equal(await persistEarningsCallIssuerStatus({
  cik: "0000019617",
  coverage: {
    lastSuccessfulEventAt: "2026-08-17T16:00:00.000Z",
    reasonCode: null,
    state: "current",
  },
  scope: scopeA,
  updatedAt: "2026-08-17T17:00:00.000Z",
}, store), "updated");
assert.equal(await persistEarningsCallIssuerStatus({
  cik: "0000019617",
  coverage: {
    lastSuccessfulEventAt: null,
    reasonCode: "source_failed",
    state: "degraded",
  },
  scope: scopeA,
  updatedAt: "2026-08-17T16:59:00.000Z",
}, store), "stale", "an older run cannot overwrite a workspace issuer projection");
assert.equal(await persistEarningsCallIssuerStatus({
  cik: "0000019617",
  coverage: {
    lastSuccessfulEventAt: "2026-08-17T15:00:00.000Z",
    reasonCode: "source_failed",
    state: "degraded",
  },
  scope: scopeB,
  updatedAt: "2026-08-17T17:01:00.000Z",
}, store), "updated");
assert.equal((await readEarningsCallIssuerStatus(scopeA, "0000019617", store))?.coverage.state, "current");
assert.equal((await readEarningsCallIssuerStatus(scopeB, "0000019617", store))?.coverage.state, "degraded");
assert.equal((await readEarningsCallWorkspacePresentation({
  scope: scopeC,
  selectedIssuerCiks: ["0000019617"],
}, { findings: store, statuses: store })).coverage[0]?.state, "awaiting_comparable_call");
assert.deepEqual((await readEarningsCallWorkspacePresentation({
  scope: scopeC,
  selectedIssuerCiks: ["0000019617", "0000789019", "0001341439"],
}, { findings: store, statuses: store })).coverage.map(({ cik }) => cik),
  ["0000019617", "0000789019", "0001341439"],
  "presentation must retain supported and unsupported selected CIKs");
assert.equal((await readEarningsCallWorkspacePresentation({
  monitor: {
    lastErrorCode: null,
    lifecycleState: "paused",
    sourceCheckpoint: { contentDigest: "a".repeat(64), watermark: "2026-08-17T16:00:00.000Z" },
    sources: [{ sourceId: "earnings-call-transcripts.0000019617" }],
  },
  scope: scopeC,
  selectedIssuerCiks: ["0000019617"],
}, { findings: store, statuses: store })).coverage[0]?.state, "baseline_ready");
const unavailableDiscoveryPresentation = await readEarningsCallWorkspacePresentation({
  scope: scopeA,
  selectedIssuerCiks: ["0000789019"],
}, { findings: store, statuses: store });
assert.equal(unavailableDiscoveryPresentation.latestAnalysis?.findingId, recordA.finding.findingId);
assert.equal(unavailableDiscoveryPresentation.coverage[0]?.state, "coverage_unavailable");
assert.equal((await readEarningsCallWorkspacePresentation({
  scope: scopeA,
  selectedIssuerCiks: ["0000019617"],
}, { findings: store, statuses: store })).coverage[0]?.state, "current");
assert.equal((await readEarningsCallWorkspacePresentation({
  monitor: {
    lastErrorCode: "worker_failed",
    lifecycleState: "paused_failure",
    sourceCheckpoint: { contentDigest: "a".repeat(64), watermark: "2026-08-17T16:00:00.000Z" },
    sources: [{ sourceId: "earnings-call-transcripts.0000019617" }],
  },
  scope: scopeA,
  selectedIssuerCiks: ["0000019617"],
}, { findings: store, statuses: store })).coverage[0]?.state, "paused_failure");
assert.equal((await readEarningsCallWorkspacePresentation({
  scope: scopeA,
  selectedIssuerCiks: ["0000019617"],
  sourceHealth: [{ healthState: "degraded", sourceId: "earnings-call-transcripts.0000019617" }],
}, { findings: store, statuses: store })).coverage[0]?.state, "degraded");

const turnContext = workspaceAlertTurnContext({
  alertId: "alert_fixture_earnings_sprint_4",
  artifactRefs: [recordA.finding.findingId, comparison.comparisonId, "event.current.fixture"],
  createdAt: "2026-08-17T17:00:00.000Z",
  eventTime: "2026-08-17T16:00:00.000Z",
  findingId: "finding_fixture_earnings_sprint_4",
  ownerId,
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceLinks: [{ canonicalUrl: "https://data.sec.gov/submissions/CIK0000789019.json", sourceId: "earnings-call-transcripts.0000789019" }],
  sourceRefs: ["earnings-call-transcripts.0000789019"],
  state: "ready",
  title: "MSFT FY2026-Q3 earnings-call change",
  whyMatched: "The outlook became more specific. Forecast positive; stance constructive; confidence high.",
  workspaceId: scopeA.workspaceId,
  workspaceName: "Earnings research",
});
assert.match(turnContext, /Exact finding\/evidence references/u);
assert.match(turnContext, /event\.current\.fixture/u);

const html = workspaceHtml("fixture_nonce", "https://example.com");
for (const required of [
  "Search ticker, company, or CIK",
  "Duplicate selection",
  "Selection limit reached",
  "unsaved changes",
  "aria-busy",
  "Company coverage",
  "Stance and conditional forecast",
  "Supporting changes and metrics",
  "Counterevidence and invalidation",
  "Current and prior citations",
]) assert.match(html, new RegExp(required, "u"));

console.log("Earnings Call Changes Sprint 4 verification passed.");
