import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { EARNINGS_CALL_POLICY, earningsCallPolicySchema, resolveEarningsCallFlags } from "../agent/lib/earnings-call-policy";
import {
  EARNINGS_CALL_LIMITS,
  digestEarningsCallValue,
  earningsComparisonSchema,
  earningsEventSchema,
  earningsFindingSchema,
  earningsIssuerCatalogRevisionSchema,
  earningsSourceFamilySchema,
  earningsSourceInstanceSchema,
  earningsTranscriptSchema,
} from "../agent/lib/earnings-call-schema";
import {
  EARNINGS_CALL_MISSING_PRODUCTION_SEAMS,
  EarningsCallMissingProductionSeamError,
  assertEarningsCallProductionSeams,
} from "../evals/earnings-call-changes/contract-harness";
import {
  earningsSemanticBenchmarkSchema,
  registerEarningsSemanticBenchmark,
} from "../evals/earnings-call-changes/semantic-benchmark";

const fixtures = new URL("./fixtures/earnings-call-changes/", import.meta.url);
const readJson = async (name: string) => JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const now = "2026-08-16T20:00:00.000Z";

const cohort = await readJson("issuer-cohort.json") as {
  exchanges: string[];
  issuers: Array<{ cik: string; exchange: string; sector: string; ticker: string }>;
};
assert.equal(cohort.issuers.length, 50);
assert.deepEqual(new Set(cohort.exchanges), new Set(["Nasdaq", "NYSE"]));
assert.ok(new Set(cohort.issuers.map(({ sector }) => sector)).size >= 3);
assert.equal(new Set(cohort.issuers.map(({ cik }) => cik)).size, 50);
assert.equal(new Set(cohort.issuers.map(({ ticker }) => ticker)).size, 50);

const sourceManifest = await readJson("reviewed-public-source-families.json") as {
  families: Array<{ cik: string; events: Array<{ callDate: string; discoveryEvidence: string; role: string }>; sector: string; ticker: string }>;
};
assert.equal(sourceManifest.families.length, 5);
assert.ok(sourceManifest.families.every(({ cik }) => cohort.issuers.some((issuer) => issuer.cik === cik)));
assert.equal(new Set(sourceManifest.families.map(({ sector }) => sector)).size, 4);
assert.ok(sourceManifest.families.every(({ events }) =>
  events.length === 2 && new Set(events.map(({ role }) => role)).size === 2));
assert.equal(sourceManifest.families.find(({ ticker }) => ticker === "FDX")!
  .events.find(({ role }) => role === "current")!.callDate, "2026-06-23");
assert.equal(sourceManifest.families.flatMap(({ events }) => events)
  .filter(({ discoveryEvidence }) => discoveryEvidence === "direct_link").length, 9);

const viability = await readJson("source-viability-lock.json") as {
  cohort: { cohortDigest: string };
  qualifyingCorpora: Array<{ current: { digest: string }; prior: { digest: string }; ticker: string }>;
  revisedPublicSourceAudit: { cohortDigest: string; qualifyingPairCount: number; sectorCount: number };
  secOnlyAudit: { candidateExhibitCount: number; maximumCandidatesPerIssuer: number; qualifyingPairCount: number };
};
assert.equal(viability.secOnlyAudit.qualifyingPairCount, 0);
assert.equal(viability.secOnlyAudit.candidateExhibitCount, 408);
assert.equal(viability.secOnlyAudit.maximumCandidatesPerIssuer, 12);
assert.equal(viability.revisedPublicSourceAudit.qualifyingPairCount, 5);
assert.equal(viability.revisedPublicSourceAudit.sectorCount, 4);
assert.equal(viability.revisedPublicSourceAudit.cohortDigest, viability.cohort.cohortDigest);
assert.equal(viability.qualifyingCorpora.length, 5);
assert.deepEqual(
  new Set(viability.qualifyingCorpora.map(({ ticker }) => ticker)),
  new Set(sourceManifest.families.map(({ ticker }) => ticker)),
);
assert.ok(viability.qualifyingCorpora.every(({ current, prior }) =>
  /^[a-f0-9]{64}$/u.test(current.digest) && /^[a-f0-9]{64}$/u.test(prior.digest) && current.digest !== prior.digest));

const sourceNegatives = await readJson("source-negative-fixtures.json") as {
  fixtures: Array<{ expectedReason: string; expectedState: string; id: string }>;
};
assert.equal(sourceNegatives.fixtures.length, 7);

assert.deepEqual(earningsCallPolicySchema.parse(EARNINGS_CALL_POLICY), EARNINGS_CALL_POLICY);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumAggregateInputTokens, 24_000);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumAggregateOutputTokens, 4_000);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumSectionJobs, 4);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumSynthesisJobs, 1);

assert.deepEqual(resolveEarningsCallFlags({}), {
  alertDelivery: false,
  configuration: "disabled",
  execution: false,
  sourceAcquisition: false,
});
assert.equal(resolveEarningsCallFlags({ EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED: "1" }).configuration, "misconfigured");
const sourceEnvironment = {
  EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED: "1",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
};
assert.deepEqual(resolveEarningsCallFlags(sourceEnvironment), {
  alertDelivery: false,
  configuration: "enabled",
  execution: false,
  sourceAcquisition: true,
});
assert.equal(resolveEarningsCallFlags({
  ...sourceEnvironment,
  EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED: "1",
}).configuration, "misconfigured");
const executionEnvironment = {
  ...sourceEnvironment,
  EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED: "1",
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
assert.equal(resolveEarningsCallFlags(executionEnvironment).execution, true);
assert.equal(resolveEarningsCallFlags({
  ...executionEnvironment,
  EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: "1",
}).alertDelivery, true);

const catalogCore = {
  catalogId: "sec-issuers",
  entries: [{
    cik: "0000789019",
    companyName: "Microsoft Corporation",
    coverage: { lastSuccessfulEventAt: now, reasonCode: null, state: "baseline_ready" },
    exchange: "Nasdaq",
    sector: "technology",
    ticker: "MSFT",
  }],
  recordType: "earnings_issuer_catalog_revision",
  revision: 1,
  schemaVersion: 1,
} as const;
const catalog = earningsIssuerCatalogRevisionSchema.parse({
  ...catalogCore,
  catalogDigest: digestEarningsCallValue(catalogCore),
});
assert.equal(catalog.entries[0]!.cik, "0000789019");
assert.throws(() => earningsIssuerCatalogRevisionSchema.parse({
  ...catalog,
  entries: [catalog.entries[0], catalog.entries[0]],
}));

const familyCore = {
  artifact: { mediaTypes: ["text/html"], origin: "https://www.microsoft.com", pathPattern: "^/en-us/investor/events/fy-2026/earnings-fy-2026-q[23]$" },
  cik: "0000789019",
  discovery: { mediaTypes: ["text/html"], origin: "https://www.microsoft.com", pathPattern: "^/en-us/investor/events/fy-2026/earnings-fy-2026-q[23]$" },
  familyId: "earnings-source.msft",
  maximumArtifactBytes: EARNINGS_CALL_LIMITS.maximumArtifactBytes,
  maximumRedirects: 3,
  recordType: "earnings_call_source_family",
  schemaVersion: 1,
} as const;
const family = earningsSourceFamilySchema.parse({
  ...familyCore,
  familyDigest: digestEarningsCallValue(familyCore),
});
assert.equal(family.cik, "0000789019");
assert.throws(() => earningsSourceFamilySchema.parse({ ...family, maximumArtifactBytes: EARNINGS_CALL_LIMITS.maximumArtifactBytes + 1 }));

const source = earningsSourceInstanceSchema.parse({
  artifactUrl: "https://www.microsoft.com/en-us/investor/events/fy-2026/earnings-fy-2026-q3",
  cik: family.cik,
  discoveryUrl: "https://www.microsoft.com/en-us/investor/events/fy-2026/earnings-fy-2026-q3",
  familyDigest: family.familyDigest,
  familyId: family.familyId,
  fiscalPeriod: "FY2026-Q3",
  instanceId: "earnings-source.msft.fy2026-q3",
  recordType: "earnings_call_source_instance",
  schemaVersion: 1,
});
assert.equal(source.fiscalPeriod, "FY2026-Q3");

const currentEvent = earningsEventSchema.parse({
  artifactByteCount: 345536,
  artifactDigest: digestA,
  callDate: "2026-04-29",
  cik: family.cik,
  eventId: "earnings-event.msft.fy2026-q3",
  fiscalPeriod: "FY2026-Q3",
  observedAt: now,
  publishedAt: now,
  recordType: "earnings_call_event",
  revision: 1,
  revisionId: "earnings-event-revision.msft.fy2026-q3.1",
  schemaVersion: 1,
  secAccession: "0001193125-26-100001",
  sourceInstanceId: source.instanceId,
});
const priorEvent = earningsEventSchema.parse({
  ...currentEvent,
  artifactDigest: digestB,
  callDate: "2026-01-28",
  eventId: "earnings-event.msft.fy2026-q2",
  fiscalPeriod: "FY2026-Q2",
  revisionId: "earnings-event-revision.msft.fy2026-q2.1",
  sourceInstanceId: "earnings-source.msft.fy2026-q2",
});

const currentTranscript = earningsTranscriptSchema.parse({
  artifactDigest: currentEvent.artifactDigest,
  characterCount: 200,
  coverage: { liveCallCompleteness: "not_attested", omissionNotice: null, preparedRemarks: "document_complete", questionsAndAnswers: "document_complete" },
  eventRevisionId: currentEvent.revisionId,
  normalizedTextDigest: digestC,
  parserVersion: "1.0.0",
  qaPairs: [{ answerTurnIds: ["turn.answer.1"], pairId: "qa-pair.1", questionTurnIds: ["turn.question.1"] }],
  recordType: "earnings_call_transcript",
  schemaVersion: 1,
  sections: [
    { characterCount: 100, end: 100, sectionDigest: digestA, sectionId: "section.prepared.1", sectionKind: "prepared_remarks", start: 0 },
    { characterCount: 100, end: 200, sectionDigest: digestB, sectionId: "section.qa.1", sectionKind: "questions_and_answers", start: 100 },
  ],
  speakerTurns: [
    { end: 150, role: "analyst", sectionId: "section.qa.1", speakerName: "Analyst", start: 100, turnDigest: digestA, turnId: "turn.question.1" },
    { end: 200, role: "executive", sectionId: "section.qa.1", speakerName: "Executive", start: 150, turnDigest: digestB, turnId: "turn.answer.1" },
  ],
  transcriptId: "transcript.msft.fy2026-q3.1",
});
assert.throws(() => earningsTranscriptSchema.parse({
  ...currentTranscript,
  sections: currentTranscript.sections.filter(({ sectionKind }) => sectionKind !== "questions_and_answers"),
}));

const comparisonCore = {
  cik: "0000789019",
  comparisonId: "comparison.msft.fy2026-q3-q2.1",
  current: { artifactDigest: currentEvent.artifactDigest, eventRevisionId: currentEvent.revisionId, fiscalPeriod: "FY2026-Q3", transcriptId: currentTranscript.transcriptId },
  metricVersion: "1.0.0",
  metrics: [{ currentValue: 0.5, delta: 0.2, metricId: "specificity_rate", priorValue: 0.3, sectionKind: "prepared_remarks", unit: "ratio" }],
  prior: { artifactDigest: priorEvent.artifactDigest, eventRevisionId: priorEvent.revisionId, fiscalPeriod: "FY2026-Q2", transcriptId: "transcript.msft.fy2026-q2.1" },
  recordType: "earnings_call_comparison",
  schemaVersion: 1,
  secondaryYearAgo: null,
} as const;
const comparison = earningsComparisonSchema.parse({
  ...comparisonCore,
  comparisonDigest: digestEarningsCallValue(comparisonCore),
});
assert.throws(() => earningsComparisonSchema.parse({ ...comparison, prior: comparison.current }));

const citation = {
  artifactDigest: currentEvent.artifactDigest,
  end: 80,
  eventRevisionId: currentEvent.revisionId,
  sectionId: "section.prepared.1",
  spanDigest: digestA,
  start: 20,
  transcriptId: currentTranscript.transcriptId,
};
const assertion = { citations: [citation], statement: "Management supplied more specific operating assumptions." };
const materiality = {
  alertEligible: true,
  configuredThreshold: 60,
  decisionReasons: ["material_change"],
  deterministicScore: 75,
  policyVersion: "1.0.0",
};
const findingCore = {
  activationWatermark: "2026-04-01T00:00:00.000Z",
  analysisLineage: {
    budgetAttempt: 1,
    configurationRevision: 1,
    definitionDigest: digestC,
    definitionId: "earnings-call-semantic-comparison",
    definitionVersion: "1.0.0",
    modelId: "fixture/earnings-model",
    promptDigest: digestB,
    validatorVersion: "1.0.0",
  },
  comparisonDigest: comparison.comparisonDigest,
  comparisonId: comparison.comparisonId,
  confidence: "medium",
  counterevidence: [],
  facts: [assertion],
  findingId: "finding.msft.fy2026-q3.1",
  forecast: {
    catalysts: [],
    citations: [citation],
    direction: "positive",
    horizon: "next_quarter",
    invalidationConditions: ["The stated operating assumptions do not materialize."],
    likelyMarketInterpretation: "The added specificity may support a more constructive near-term interpretation.",
    risks: [],
    scenarios: [{ condition: "Assumptions hold.", direction: "positive", label: "base", rationale: "Specific commitments are delivered." }],
  },
  inferences: [assertion],
  materiality,
  monitorId: "monitor.fixture.msft",
  outcome: "accepted",
  ownerId: "owner.fixture",
  pack: { contentDigest: digestB, id: "earnings-call-changes", version: "1.0.0" },
  recommendation: {
    assumptions: ["Only the cited public transcript evidence is considered."],
    citations: [citation],
    conditionalImplication: "Investigate whether operating data confirms the stated assumptions.",
    rationale: "Specificity improved while guidance remained supported.",
    stance: "constructive",
    valuationAssessment: "not_assessed",
  },
  recordType: "earnings_call_finding",
  schemaVersion: 1,
  unknowns: [],
  workspaceId: "workspace.fixture",
} as const;
const finding = earningsFindingSchema.parse({
  ...findingCore,
  findingDigest: digestEarningsCallValue(findingCore),
});
assert.equal(finding.materiality.alertEligible, true);
assert.throws(() => earningsFindingSchema.parse({ ...finding, forecast: null }));
assert.throws(() => earningsFindingSchema.parse({ ...finding, materiality: { ...materiality, deterministicScore: 20 } }));
assert.throws(() => earningsFindingSchema.parse({
  ...finding,
  materiality: {
    ...materiality,
    decisionReasons: ["material_change", "not_after_activation_watermark"],
  },
}));

const benchmark = earningsSemanticBenchmarkSchema.parse(JSON.parse(await readFile(
  new URL("../evals/earnings-call-changes/semantic-benchmark-v1.json", import.meta.url),
  "utf8",
)));
const registration = registerEarningsSemanticBenchmark(benchmark);
assert.equal(registration.caseCount, 12);

const intended = z.object({
  missingProductionSeams: z.array(z.enum(EARNINGS_CALL_MISSING_PRODUCTION_SEAMS)).length(5),
  recordType: z.literal("earnings_call_sprint_0_intended_outcomes"),
  schemaVersion: z.literal(1),
  semanticOutcomes: z.array(z.object({ direction: z.string(), id: z.string(), materialChange: z.boolean(), outcome: z.string() }).strict()).length(12),
  sourceOutcomes: z.array(z.object({ id: z.string(), outcome: z.string(), reason: z.string() }).strict()).length(7),
}).strict().parse(await readJson("sprint-0-intended-outcomes.json"));
assert.deepEqual(intended.sourceOutcomes, sourceNegatives.fixtures.map((fixture) => ({
  id: fixture.id,
  outcome: fixture.expectedState,
  reason: fixture.expectedReason,
})));
assert.deepEqual(intended.semanticOutcomes, benchmark.cases.map(({ expected, id }) => ({
  direction: expected.direction,
  id,
  materialChange: expected.materialChange,
  outcome: expected.outcome,
})));
assert.deepEqual(intended.missingProductionSeams, [...EARNINGS_CALL_MISSING_PRODUCTION_SEAMS]);

for (let index = 0; index < EARNINGS_CALL_MISSING_PRODUCTION_SEAMS.length; index += 1) {
  const registered = Object.fromEntries(
    EARNINGS_CALL_MISSING_PRODUCTION_SEAMS.slice(0, index).map((seam) => [seam, true]),
  );
  assert.throws(
    () => assertEarningsCallProductionSeams(registered),
    (error: unknown) => error instanceof EarningsCallMissingProductionSeamError &&
      error.seam === EARNINGS_CALL_MISSING_PRODUCTION_SEAMS[index],
  );
}
assert.doesNotThrow(() => assertEarningsCallProductionSeams(Object.fromEntries(
  EARNINGS_CALL_MISSING_PRODUCTION_SEAMS.map((seam) => [seam, true]),
)));

assert.equal(digestEarningsCallValue({ b: 2, a: 1 }), digestEarningsCallValue({ a: 1, b: 2 }));
process.stdout.write(JSON.stringify({
  benchmarkCases: benchmark.cases.length,
  missingProductionSeams: intended.missingProductionSeams,
  policyDigest: EARNINGS_CALL_POLICY.policyDigest,
  qualifyingIssuerPairs: viability.revisedPublicSourceAudit.qualifyingPairCount,
  sourceNegativeFixtures: sourceNegatives.fixtures.length,
  status: "contracts_green_production_seams_intentionally_missing",
}, null, 2) + "\n");
