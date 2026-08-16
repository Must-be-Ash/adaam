import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  advanceCongressionalCoverage,
  applyCongressionalHistoryChanges,
  createCongressionalHistoryRevision,
  createCongressionalRetractionSignal,
  deriveCongressionalClusters,
  evaluateCongressionalPatternBreak,
  shouldCreateCongressionalCorrectionAlert,
  type CongressionalClusterCandidate,
  type CongressionalHistoryEntry,
} from "../agent/lib/congressional-history";
import {
  persistCongressionalHistory,
  persistCongressionalSignalRecords,
  readCongressionalHistory,
  type CongressionalSignalStoreClient,
} from "../agent/lib/congressional-signal-store";
import {
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_2,
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_POLICY_V1_2,
} from "../agent/lib/congressional-reference-catalog";
import {
  congressionalFilingSignalSchema,
  deriveCongressionalSignalId,
  deriveCongressionalSignalRevisionId,
  deriveHouseStrategyTransactionId,
  deriveHouseStrategyTransactionRevisionId,
  houseStrategyTransactionSchema,
  type HouseStrategyTransaction,
} from "../agent/lib/congressional-signal-schema";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { evaluateCongressionalTransaction } from "../agent/lib/congressional-strategy";

class MemoryStore implements CongressionalSignalStoreClient {
  readonly records = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }

  async createOrRead(key: string, value: string): Promise<{ created: boolean; value: unknown }> {
    const current = this.records.get(key);
    if (current !== undefined) return { created: false, value: current };
    this.records.set(key, value);
    return { created: true, value };
  }

  async get(key: string): Promise<unknown> {
    return this.records.get(key) ?? null;
  }
}

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/congressional-signals/sprint-3-history-clusters-corrections.json", import.meta.url),
  "utf8",
)) as { readonly scenarios: readonly string[] };
assert.deepEqual(fixture.scenarios, [
  "coverage-89-days-unavailable",
  "coverage-90-days-complete",
  "coverage-gap-resets",
  "pattern-amount-above-history",
  "pattern-new-industry",
  "pattern-new-direction",
  "pattern-insufficient-history",
  "same-member-cluster",
  "same-member-replay-dedupe",
  "committee-cluster",
  "committee-distinct-member-dedupe",
  "party-diversity-descriptive-only",
  "correction-replaces-contribution",
  "retraction-removes-cluster",
  "retraction-replay",
  "correction-alert-change-gate",
]);
const priorPackDigests = ["1.0.0", "1.1.0"].map((version) =>
  strategyPackCatalog.resolve({ id: "congressional-signals", version })?.contentDigest);
assert.deepEqual(priorPackDigests, [
  "c5031a9d345956d491b35e5459043195437497bc90ce18f8fe8600a596fa8d29",
  "54b09e91047f9e34681994eefc5f1284c45b658f55873df49ba3fab3ad211630",
]);
assert.deepEqual(
  strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.2.0" })?.evidenceContracts,
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_2,
);

const workspaceId = "123e4567-e89b-42d3-a456-426614174303";
const reference = (id: string, version = "1.1.0") => ({
  catalogDigest: id.slice(0, 1).charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
  catalogId: id,
  catalogVersion: version,
});

function transaction(input: {
  amountLower?: string;
  amountUpper?: string;
  date: string;
  direction?: "P" | "S";
  fact?: string;
  industry?: string;
  member?: string;
  security?: string;
}): HouseStrategyTransaction {
  const fact = input.fact ?? `fact.${input.member ?? "M000001"}.${input.date}`;
  const member = input.member ?? "M000001";
  const security = input.security ?? "security.fixture.alpha";
  const industry = input.industry ?? "industry.fixture.alpha";
  const subscriptionId = "subscription.fixture.congressional-history";
  const core = {
    amountRange: {
      label: `$${input.amountLower ?? "1001"} - $${input.amountUpper ?? "15000"}`,
      lower: input.amountLower ?? "1001",
      upper: input.amountUpper ?? "15000",
    },
    asset: { description: `${security} common stock`, reportedTicker: "FIX" },
    catalogReferences: {
      committeeAssignments: reference("congressional-committee-assignments", "1.0.0"),
      committeeJurisdictions: reference("congressional-committee-jurisdictions", "1.0.0"),
      member: reference("congressional-house-members"),
      security: reference("congressional-security-classifications"),
    },
    createdAt: "2026-08-16T18:00:00.000Z",
    disclosedMember: { firstName: member, lastName: "Fixture", prefix: null, stateDistrict: "VA09", suffix: null },
    disclosureLagDays: 16,
    eligibility: { reasonCodes: ["eligible"], state: "eligible" },
    filingDate: "2026-08-16",
    lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" },
    memberResolution: { bioguideId: member, state: "resolved" },
    notificationDate: null,
    observedAt: "2026-08-16T18:00:00.000Z",
    owner: { disclosedCode: "SELF", relationship: "self" },
    packBinding: { bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "congressional-signals", packVersion: "1.2.0" },
    policyReference: { policyDigest: CONGRESSIONAL_POLICY_V1_2.policyDigest, policyId: CONGRESSIONAL_POLICY_V1_2.policyId, policyVersion: CONGRESSIONAL_POLICY_V1_2.policyVersion },
    processingMode: "live",
    recordType: "house_strategy_transaction",
    schemaVersion: 1,
    securityResolution: { canonicalSecurityId: security, classification: "security", industryId: industry, state: "resolved" },
    source: {
      authority: "House Clerk",
      factLogicalKey: fact,
      factRevisionId: `${fact}.revision.1`,
      filingLogicalKey: `filing.${member}.${input.date}`,
      projectionId: `projection.${fact}`,
      publicDocumentUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/fixture.pdf",
      rowIdentity: "row:1",
      sourceInstanceId: "source-instance.fixture.congressional",
      subscriptionId,
    },
    transactionDate: input.date,
    transactionId: deriveHouseStrategyTransactionId({ factLogicalKey: fact, subscriptionId, workspaceId }),
    transactionType: input.direction ?? "P",
    workspaceId,
  } as const;
  return houseStrategyTransactionSchema.parse({
    ...core,
    transactionRevisionId: deriveHouseStrategyTransactionRevisionId(core),
  });
}

let coverage = null;
for (let offset = 0; offset < 89; offset += 1) {
  const observedOn = new Date(Date.UTC(2026, 4, 20 + offset)).toISOString().slice(0, 10);
  coverage = advanceCongressionalCoverage(coverage, {
    maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
    observedOn,
    requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
    sourceComplete: true,
  });
}
assert.equal(coverage.consecutiveDays, 89);
assert.equal(coverage.state, "incomplete");
coverage = advanceCongressionalCoverage(coverage, {
  maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
  observedOn: "2026-08-17",
  requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
  sourceComplete: true,
});
assert.equal(coverage.consecutiveDays, 90);
assert.equal(coverage.state, "complete");
const resetCoverage = advanceCongressionalCoverage(coverage, {
  maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
  observedOn: "2026-08-21",
  requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
  sourceComplete: true,
});
assert.equal(resetCoverage.consecutiveDays, 1);
assert.equal(resetCoverage.startedOn, "2026-08-21");
const incompleteCoverage = advanceCongressionalCoverage(coverage, {
  maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
  observedOn: "2026-08-18",
  requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
  sourceComplete: false,
});
assert.equal(incompleteCoverage.consecutiveDays, 0);
assert.equal(advanceCongressionalCoverage(incompleteCoverage, {
  maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
  observedOn: "2026-08-19",
  requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
  sourceComplete: true,
}).consecutiveDays, 1);

const priorTransactions = [1, 2, 3, 4, 5].map((day) => transaction({
  date: `2026-07-${String(day).padStart(2, "0")}`,
  direction: "S",
  fact: `fact.prior.${day}`,
}));
const entries = priorTransactions.map((item, index): CongressionalHistoryEntry => ({
  alertEligible: index === 0,
  band: index === 0 ? "review" : "record_only",
  committeeKeys: ["committee.house-fixture"],
  party: index % 2 === 0 ? "Democratic" : "Republican",
  signalRevisionId: `signal-revision.prior.${index}`,
  transaction: item,
}));

const amountBreak = evaluateCongressionalPatternBreak({
  coverage,
  current: transaction({ amountLower: "50001", amountUpper: "100000", date: "2026-08-01", fact: "fact.current.amount" }),
  minimumPriorTransactions: CONGRESSIONAL_POLICY_V1_2.historyMinimumTransactions!,
  priorEntries: entries,
});
assert.equal(amountBreak.state, "yes");
assert.deepEqual(amountBreak.ruleCodes, ["amount_above_history", "new_direction"]);
const industryBreak = evaluateCongressionalPatternBreak({
  coverage,
  current: transaction({ date: "2026-08-01", direction: "S", fact: "fact.current.industry", industry: "industry.fixture.new" }),
  minimumPriorTransactions: CONGRESSIONAL_POLICY_V1_2.historyMinimumTransactions!,
  priorEntries: entries,
});
assert.deepEqual(industryBreak.ruleCodes, ["new_industry"]);
const directionBreak = evaluateCongressionalPatternBreak({
  coverage,
  current: transaction({ date: "2026-08-01", fact: "fact.current.direction" }),
  minimumPriorTransactions: CONGRESSIONAL_POLICY_V1_2.historyMinimumTransactions!,
  priorEntries: entries,
});
assert.deepEqual(directionBreak.ruleCodes, ["new_direction"]);
const directionBreakTransaction = transaction({ date: "2026-08-01", fact: "fact.current.direction" });
assert.equal(evaluateCongressionalPatternBreak({
  coverage: resetCoverage,
  current: directionBreakTransaction,
  minimumPriorTransactions: CONGRESSIONAL_POLICY_V1_2.historyMinimumTransactions!,
  priorEntries: entries,
}).state, "unavailable");
assert.equal(evaluateCongressionalPatternBreak({
  coverage,
  current: directionBreakTransaction,
  minimumPriorTransactions: CONGRESSIONAL_POLICY_V1_2.historyMinimumTransactions!,
  priorEntries: entries.slice(0, 4),
}).state, "unavailable");

function candidate(
  item: HouseStrategyTransaction,
  committeeKeys: readonly string[],
  party: "Democratic" | "Independent" | "Republican",
): CongressionalClusterCandidate {
  return { committeeKeys, party, transaction: item };
}
const sameMemberCandidates = [1, 10, 30].map((day) => candidate(transaction({
  date: `2026-07-${String(day).padStart(2, "0")}`,
  fact: `fact.same-member.${day}`,
}), ["committee.house-fixture"], "Republican"));
const sameMemberClusters = deriveCongressionalClusters({
  candidates: [...sameMemberCandidates, sameMemberCandidates[0]!],
  minimumFacts: CONGRESSIONAL_POLICY_V1_2.clusterMinimumFacts!,
  windowDays: CONGRESSIONAL_POLICY_V1_2.clusterWindowDays!,
  workspaceId,
});
assert.equal(sameMemberClusters.filter(({ kind }) => kind === "same_member").length, 1);
assert.equal(sameMemberClusters.find(({ kind }) => kind === "same_member")?.factLogicalKeys.length, 3);

const committeeCandidates = [
  candidate(transaction({ date: "2026-07-01", fact: "fact.committee.1", member: "A000001" }), ["committee.house-fixture"], "Democratic"),
  candidate(transaction({ date: "2026-07-10", fact: "fact.committee.2", member: "B000001" }), ["committee.house-fixture"], "Republican"),
  candidate(transaction({ date: "2026-07-30", fact: "fact.committee.3", member: "C000001" }), ["committee.house-fixture"], "Independent"),
];
const committeeClusters = deriveCongressionalClusters({
  candidates: [...committeeCandidates, candidate(transaction({
    date: "2026-07-20",
    fact: "fact.committee.duplicate-member",
    member: "A000001",
  }), ["committee.house-fixture"], "Democratic")],
  minimumFacts: CONGRESSIONAL_POLICY_V1_2.clusterMinimumFacts!,
  windowDays: CONGRESSIONAL_POLICY_V1_2.clusterWindowDays!,
  workspaceId,
});
const committeeCluster = committeeClusters.find(({ kind }) => kind === "committee")!;
assert.deepEqual(committeeCluster.memberBioguideIds, ["A000001", "B000001", "C000001"]);
assert.deepEqual(committeeCluster.descriptiveParties, ["Democratic", "Independent", "Republican"]);
assert.equal(committeeCluster.evidenceStrength, "qualifying");
const evaluationCatalogs = {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
};
const sameMemberEvaluation = evaluateCongressionalTransaction(
  sameMemberCandidates[0]!.transaction,
  CONGRESSIONAL_POLICY_V1_2,
  evaluationCatalogs,
  { clusters: sameMemberClusters, coverage, priorEntries: entries },
);
assert.equal(sameMemberEvaluation.band, "review");
assert.equal(sameMemberEvaluation.evidence.find(({ reasonCode }) =>
  reasonCode === "same_member_cluster")?.state, "applied");
const committeeEvaluation = evaluateCongressionalTransaction(
  committeeCandidates[0]!.transaction,
  CONGRESSIONAL_POLICY_V1_2,
  evaluationCatalogs,
  { clusters: committeeClusters, coverage, priorEntries: entries },
);
assert.equal(committeeEvaluation.band, "priority");
assert.deepEqual(committeeEvaluation.clusterRevisionIds, [committeeCluster.clusterRevisionId]);

const correctedCore = {
  ...priorTransactions[0],
  source: { ...priorTransactions[0]!.source, factRevisionId: "fact.prior.1.revision.2" },
  transactionType: "P" as const,
};
const { transactionRevisionId: _correctedRevision, ...correctedWithoutRevision } = correctedCore;
const corrected = houseStrategyTransactionSchema.parse({
  ...correctedWithoutRevision,
  transactionRevisionId: deriveHouseStrategyTransactionRevisionId(correctedWithoutRevision),
});
const changes = applyCongressionalHistoryChanges({
  currentTransactions: [corrected],
  observedAt: "2026-08-16T20:00:00.000Z",
  priorEntries: entries,
  retractions: [{
    fromRevisionId: priorTransactions[1]!.source.factRevisionId,
    logicalKey: priorTransactions[1]!.source.factLogicalKey,
    retractionId: "retraction.fixture.prior.2",
  }],
});
assert.equal(changes.currentTransactions[0]?.lineage.priorRevisionId, priorTransactions[0]!.transactionRevisionId);
assert.ok(changes.currentTransactions[0]?.lineage.correctionId?.startsWith("congressional-correction."));
assert.equal(changes.activeEntries.some(({ transaction }) =>
  transaction.transactionId === priorTransactions[1]!.transactionId), false);
assert.equal(changes.retractedTransactions.length, 1);
assert.equal(changes.retractedTransactions[0]?.lineage.retractionId, "retraction.fixture.prior.2");
assert.deepEqual(applyCongressionalHistoryChanges({
  currentTransactions: [],
  observedAt: "2026-08-16T20:00:00.000Z",
  priorEntries: changes.activeEntries,
  retractions: [{
    fromRevisionId: priorTransactions[1]!.source.factRevisionId,
    logicalKey: priorTransactions[1]!.source.factLogicalKey,
    retractionId: "retraction.fixture.prior.2",
  }],
}).retractedTransactions, []);
assert.equal(deriveCongressionalClusters({
  candidates: sameMemberCandidates.filter(({ transaction: item }) =>
    item.transactionId !== sameMemberCandidates[1]!.transaction.transactionId),
  minimumFacts: 3,
  windowDays: 30,
  workspaceId,
}).some(({ kind }) => kind === "same_member"), false);
assert.equal(shouldCreateCongressionalCorrectionAlert({
  currentBand: "record_only",
  currentTransaction: changes.retractedTransactions[0]!,
  priorEntry: entries[1]!,
}), false);
assert.equal(shouldCreateCongressionalCorrectionAlert({
  currentBand: "record_only",
  currentTransaction: changes.currentTransactions[0]!,
  priorEntry: entries[0]!,
}), true);

const priorEvaluation = evaluateCongressionalTransaction(
  priorTransactions[1]!,
  CONGRESSIONAL_POLICY_V1_2,
  evaluationCatalogs,
  { clusters: [], coverage, priorEntries: entries },
);
const priorSignalId = deriveCongressionalSignalId({
  filingLogicalKey: priorTransactions[1]!.source.filingLogicalKey,
  packBinding: priorTransactions[1]!.packBinding,
  workspaceId,
});
const priorSignalCore = {
  alertEligible: true,
  band: "review" as const,
  catalogReferences: priorTransactions[1]!.catalogReferences,
  createdAt: "2026-08-16T18:00:00.000Z",
  filingLogicalKey: priorTransactions[1]!.source.filingLogicalKey,
  lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" as const },
  packBinding: priorTransactions[1]!.packBinding,
  policyReference: priorTransactions[1]!.policyReference,
  reasonTrace: [{
    reasonCode: "eligible" as const,
    sourceRevisionId: priorTransactions[1]!.transactionRevisionId,
    state: "applied" as const,
  }],
  recordType: "congressional_filing_signal" as const,
  schemaVersion: 1 as const,
  signalId: priorSignalId,
  transactionEvaluations: [{
    ...priorEvaluation,
    band: "review" as const,
    clusterRevisionIds: [...priorEvaluation.clusterRevisionIds],
    patternResolution: {
      ...priorEvaluation.patternResolution,
      priorTransactionRevisionIds: [...priorEvaluation.patternResolution.priorTransactionRevisionIds],
      ruleCodes: [...priorEvaluation.patternResolution.ruleCodes],
    },
  }],
  workspaceId,
};
const priorSignal = congressionalFilingSignalSchema.parse({
  ...priorSignalCore,
  signalRevisionId: deriveCongressionalSignalRevisionId(priorSignalCore),
});
const retractionSignal = createCongressionalRetractionSignal({
  observedAt: "2026-08-16T20:00:00.000Z",
  priorSignal,
  retractedTransaction: changes.retractedTransactions[0]!,
});
assert.equal(retractionSignal.lineage.priorRevisionId, priorSignal.signalRevisionId);
assert.equal(retractionSignal.lineage.state, "retracted");
assert.deepEqual(retractionSignal.transactionEvaluations[0]?.reasonCodes, ["superseded"]);

const history = createCongressionalHistoryRevision({
  activeEntries: [...entries].sort((left, right) =>
    left.transaction.transactionId.localeCompare(right.transaction.transactionId)),
  clusters: [...committeeClusters].sort((left, right) =>
    left.clusterRevisionId.localeCompare(right.clusterRevisionId)),
  correctionAlertKeys: [],
  coverage,
  createdAt: "2026-08-17T18:00:00.000Z",
  recordType: "congressional_history_revision",
  schemaVersion: 1,
  workspaceId,
});
const scope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture_congressional", workspaceId },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture_congressional" },
);
const store = new MemoryStore();
assert.equal(await persistCongressionalHistory({
  expectedHistoryRevisionId: null,
  history,
  scope,
}, store), "created");
assert.deepEqual(await readCongressionalHistory(scope, store), history);
assert.equal(await persistCongressionalHistory({
  expectedHistoryRevisionId: null,
  history,
  scope,
}, store), "reused");
await persistCongressionalSignalRecords({
  scope,
  signal: retractionSignal,
  transactions: changes.retractedTransactions,
}, store);

console.info("Congressional Signals Sprint 3 history, cluster, and correction verification passed.");
