import assert from "node:assert/strict";

import {
  createCongressionalHistoryRevision,
  type CongressionalHistoryEntry,
} from "../agent/lib/congressional-history";
import {
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
} from "../agent/lib/congressional-signal-schema";
import {
  explainCongressionalSignal,
  readCongressionalMemberHistory,
  readCongressionalSignalExplanation,
  readCongressionalWorkspacePresentation,
} from "../agent/lib/congressional-signal-presentation";
import {
  persistCongressionalHistory,
  persistCongressionalSignalRecords,
  type CongressionalSignalStoreClient,
} from "../agent/lib/congressional-signal-store";
import { evaluateCongressionalTransaction } from "../agent/lib/congressional-strategy";
import { deliverWorkspaceAlertToPhoton } from "../agent/lib/photon-alert-delivery";
import {
  applyPhotonAlertDiscussAction,
  consumePhotonPendingAlertContext,
  createPhotonWorkspace,
  getPhotonWorkspaceState,
} from "../agent/lib/photon-workspace-store";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import type { WorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import { createStrategyPackSessionInputSchema } from "../agent/tools/create_strategy_pack_session";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { photonStrategyPackActionRequestSchema } from "../agent/channels/photon-workspace-app";

class MemorySignalStore implements CongressionalSignalStoreClient {
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

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryWorkspaceStore {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return "conflict" as const;
    this.values.set(key, next);
    return "swapped" as const;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string, options?: { nx?: true }) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK" as const;
  }
}

assert.deepEqual(createStrategyPackSessionInputSchema.parse({
  activateMonitorResourceIds: ["evaluate-house-ptrs"],
  configuration: {
    dailyTimes: ["08:30", "16:00"],
    minimumAlertBand: "review",
    selectedMemberBioguideIds: ["G000568", "H001082"],
    timezone: "America/Vancouver",
  },
  name: "Congressional Signals",
  packId: "congressional-signals",
  packVersion: "1.2.0",
}).configuration, {
  dailyTimes: ["08:30", "16:00"],
  minimumAlertBand: "review",
  selectedMemberBioguideIds: ["G000568", "H001082"],
  timezone: "America/Vancouver",
});
assert.equal(photonStrategyPackActionRequestSchema.safeParse({
  action: "strategy-pack-configure",
  configuration: {
    dailyTimes: ["08:30", "16:00"],
    minimumAlertBand: "review",
    selectedMemberBioguideIds: ["G000568"],
    timezone: "America/Vancouver",
  },
  confirmedConsequences: true,
  expectedBindingRevision: 4,
  expectedRoutingRevision: 7,
  managerToken: "A".repeat(43),
  packMutationIdentity: {
    actionId: "sprint-4-spectrum",
    expectedRegistryRevision: 7,
    issuedAt: "2026-08-16T18:00:00.000Z",
    nonce: "sprint_4_nonce_123456789",
    routingScopeDigest: "a".repeat(64),
    signature: "b".repeat(64),
    sourceWorkspaceGeneration: 3,
    sourceWorkspaceId: "123e4567-e89b-42d3-a456-426614174399",
    transport: "spectrum",
  },
  sourceWorkspaceGeneration: 3,
  sourceWorkspaceId: "123e4567-e89b-42d3-a456-426614174399",
}).success, true);

const ownerId = "owner_fixture_congressional_sprint_4";
const workspaceId = "123e4567-e89b-42d3-a456-426614174304";
const environment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, environment);
const reference = (id: string, version: string) => ({
  catalogDigest: id.slice(0, 1).charCodeAt(0).toString(16).padStart(2, "0").repeat(32),
  catalogId: id,
  catalogVersion: version,
});
const subscriptionId = "subscription.fixture.congressional-sprint-4";
const transactionCore = {
  amountRange: { label: "$1,001 - $15,000", lower: "1001", upper: "15000" },
  asset: { description: "Fixture common stock", reportedTicker: "FIX" },
  catalogReferences: {
    committeeAssignments: reference("congressional-committee-assignments", "1.0.0"),
    committeeJurisdictions: reference("congressional-committee-jurisdictions", "1.0.0"),
    member: reference("congressional-house-members", "1.1.0"),
    security: reference("congressional-security-classifications", "1.1.0"),
  },
  createdAt: "2026-08-16T18:00:00.000Z",
  disclosedMember: { firstName: "Jared", lastName: "Moskowitz", prefix: null, stateDistrict: "FL23", suffix: null },
  disclosureLagDays: 10,
  eligibility: { reasonCodes: ["eligible"] as const, state: "eligible" as const },
  filingDate: "2026-08-16",
  lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" as const },
  memberResolution: { bioguideId: "M001217", state: "resolved" as const },
  notificationDate: null,
  observedAt: "2026-08-16T18:00:00.000Z",
  owner: { disclosedCode: "SELF", relationship: "self" as const },
  packBinding: {
    bindingRevision: 4,
    packContentDigest: "a".repeat(64),
    packId: "congressional-signals" as const,
    packVersion: "1.2.0" as const,
  },
  policyReference: {
    policyDigest: CONGRESSIONAL_POLICY_V1_2.policyDigest,
    policyId: CONGRESSIONAL_POLICY_V1_2.policyId,
    policyVersion: CONGRESSIONAL_POLICY_V1_2.policyVersion,
  },
  processingMode: "live" as const,
  recordType: "house_strategy_transaction" as const,
  schemaVersion: 1 as const,
  securityResolution: {
    canonicalSecurityId: "security.fixture.alpha",
    classification: "security" as const,
    industryId: "industry.fixture.alpha",
    state: "resolved" as const,
  },
  source: {
    authority: "House Clerk" as const,
    factLogicalKey: "fact.fixture.congressional-sprint-4",
    factRevisionId: "fact.fixture.congressional-sprint-4.revision.1",
    filingFactRevisionId: "fact.fixture.congressional-sprint-4.filing.revision.1",
    filingLogicalKey: "filing.fixture.congressional-sprint-4",
    projectionId: "projection.fixture.congressional-sprint-4",
    publicDocumentUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/fixture.pdf",
    rowIdentity: "row:1" as const,
    sourceInstanceId: "source-instance.fixture.congressional-sprint-4",
    subscriptionId,
  },
  transactionDate: "2026-08-06",
  transactionId: deriveHouseStrategyTransactionId({
    factLogicalKey: "fact.fixture.congressional-sprint-4",
    subscriptionId,
    workspaceId,
  }),
  transactionType: "P" as const,
  workspaceId,
};
const transaction = houseStrategyTransactionSchema.parse({
  ...transactionCore,
  transactionRevisionId: deriveHouseStrategyTransactionRevisionId(transactionCore),
});
const evaluation = evaluateCongressionalTransaction(
  transaction,
  CONGRESSIONAL_POLICY_V1_2,
  {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  },
  {
    clusters: [],
    coverage: { consecutiveDays: 90, lastCompleteOn: "2026-08-16", startedOn: "2026-05-19", state: "complete" },
    priorEntries: [],
  },
);
assert.equal(evaluation.band, "review");
const signalId = deriveCongressionalSignalId({
  filingLogicalKey: transaction.source.filingLogicalKey,
  packBinding: transaction.packBinding,
  workspaceId,
});
const signalCore = {
  alertEligible: true,
  band: evaluation.band,
  catalogReferences: transaction.catalogReferences,
  createdAt: transaction.createdAt,
  filingLogicalKey: transaction.source.filingLogicalKey,
  lineage: transaction.lineage,
  packBinding: transaction.packBinding,
  policyReference: transaction.policyReference,
  reasonTrace: evaluation.reasonCodes.map((reasonCode) => ({
    reasonCode,
    sourceRevisionId: transaction.transactionRevisionId,
    state: "applied" as const,
  })),
  recordType: "congressional_filing_signal" as const,
  schemaVersion: 1 as const,
  signalId,
  transactionEvaluations: [evaluation],
  workspaceId,
};
const signal = congressionalFilingSignalSchema.parse({
  ...signalCore,
  signalRevisionId: deriveCongressionalSignalRevisionId(signalCore),
});
const entry: CongressionalHistoryEntry = {
  alertEligible: signal.alertEligible,
  band: evaluation.band,
  committeeKeys: evaluation.committeeResolution.committeeKeys,
  party: "Republican",
  signalRevisionId: signal.signalRevisionId,
  transaction,
};
const history = createCongressionalHistoryRevision({
  activeEntries: [entry],
  clusters: [],
  correctionAlertKeys: [],
  coverage: { consecutiveDays: 90, lastCompleteOn: "2026-08-16", startedOn: "2026-05-19", state: "complete" },
  createdAt: "2026-08-16T18:00:00.000Z",
  recordType: "congressional_history_revision",
  schemaVersion: 1,
  workspaceId,
});
const signalStore = new MemorySignalStore();
await persistCongressionalSignalRecords({ scope, signal, transactions: [transaction] }, signalStore);
await persistCongressionalHistory({
  expectedHistoryRevisionId: null,
  history,
  scope,
}, signalStore);

const explanation = explainCongressionalSignal(signal);
assert.equal(explanation.signalRevisionId, signal.signalRevisionId);
assert.equal(explanation.band, "review");
assert.deepEqual(explanation.transactionOutcomeCounts, { priority: 0, record_only: 0, review: 1 });
assert.match(explanation.caveat, /not evidence of wrongdoing or a trade instruction/u);
assert.equal(JSON.stringify(explanation).includes("disclosedMember"), false);
const storedExplanation = await readCongressionalSignalExplanation({ scope,
  signalRevisionId: signal.signalRevisionId }, signalStore);
assert.deepEqual({ ...storedExplanation, effectiveDelivery: undefined },
  { ...explanation, effectiveDelivery: undefined });
assert.equal(storedExplanation.effectiveDelivery?.alertEligible, true);
assert.equal(storedExplanation.effectiveDelivery?.transactions[0]?.officialUrl,
  transaction.source.publicDocumentUrl);
const manager = await readCongressionalWorkspacePresentation(scope, signalStore);
assert.equal(manager.state, "available");
assert.deepEqual(manager.outcomeCounts, {
  alertEligible: 1,
  priority: 0,
  recordOnly: 0,
  review: 1,
  total: 1,
});
assert.equal(manager.latestSignal?.signalRevisionId, signal.signalRevisionId);
assert.equal(manager.latestSignal?.alertEligible, true);
assert.equal(manager.latestSignal?.transactions[0]?.rowIdentity, transaction.source.rowIdentity);
const moskowitzHistory = await readCongressionalMemberHistory({
  member: "Jared Moskowitz",
  scope,
}, signalStore);
assert.equal(moskowitzHistory.member.bioguideId, "M001217");
assert.equal(moskowitzHistory.filings.length, 1);
assert.equal(moskowitzHistory.filings[0]?.transactions[0]?.asset, "Fixture common stock");
const pelosiHistory = await readCongressionalMemberHistory({
  member: "Nancy Pelosi",
  scope,
}, signalStore);
assert.equal(pelosiHistory.member.bioguideId, "P000197");
assert.equal(pelosiHistory.filings.length, 0);
assert.equal(JSON.stringify(pelosiHistory).includes("M001217"), false,
  "A Pelosi history query must never expose the latest Moskowitz filing");
const emptyHistory = await readCongressionalMemberHistory({
  member: "Nancy Pelosi",
  scope,
}, new MemorySignalStore());
assert.equal(emptyHistory.member.bioguideId, "P000197");
assert.deepEqual(emptyHistory.filings, []);
assert.equal(emptyHistory.coverage, null,
  "an authorized workspace without a history record must expose unknown coverage, not transaction facts");
assert.equal((await readCongressionalMemberHistory({ member: "M001217", scope }, signalStore))
  .member.officialName, "Jared Moskowitz");
await assert.rejects(
  () => readCongressionalMemberHistory({ member: "Not A House Member", scope }, signalStore),
  /congressional_member_not_found/u,
);
await assert.rejects(
  () => readCongressionalSignalExplanation({
    scope,
    signalRevisionId: `congressional-signal-revision.${"f".repeat(64)}`,
  }, signalStore),
  /congressional_signal_not_found/u,
);
const unrelatedSignalScope = authorizeDeploymentWorkspaceStore({
  ownerId,
  workspaceId: "223e4567-e89b-42d3-a456-426614174304",
}, environment);
await assert.rejects(
  () => readCongressionalSignalExplanation({
    scope: unrelatedSignalScope,
    signalRevisionId: signal.signalRevisionId,
  }, signalStore),
  /congressional_signal_not_found/u,
);

process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example.test";
const routing = {
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread-congressional-sprint-4",
};
const workspaceStore = new MemoryWorkspaceStore();
let routingState = await getPhotonWorkspaceState(routing, workspaceStore);
routingState = await createPhotonWorkspace({
  ...routing,
  expectedRevision: routingState.revision,
  name: "Congressional Signals",
  select: false,
}, workspaceStore);
const congressionalWorkspace = routingState.workspaces.find(({ name }) => name === "Congressional Signals")!;
routingState = await createPhotonWorkspace({
  ...routing,
  expectedRevision: routingState.revision,
  name: "Unrelated Research",
  select: true,
}, workspaceStore);
const unrelatedWorkspace = routingState.activeWorkspace;
assert.notEqual(unrelatedWorkspace.id, congressionalWorkspace.id);

const monitor = {
  configurationRevision: 1,
  deliverySubscriptionId: "subscription.photon.congressional-sprint-4",
  monitorId: "223e4567-e89b-42d3-a456-426614174304",
  workspaceId: congressionalWorkspace.id,
} as WorkspaceMonitor;
const alert = {
  alertId: `alert_${"a".repeat(64)}`,
  createdAt: signal.createdAt,
  eventTime: signal.createdAt,
  findingId: `finding_${"b".repeat(64)}`,
  ownerId,
  recordType: "workspace_alert" as const,
  schemaVersion: 1 as const,
  sourceLinks: [{
    canonicalUrl: transaction.source.publicDocumentUrl,
    sourceId: "house-financial-disclosures-2026",
  }],
  sourceRefs: ["house-financial-disclosures-2026"],
  state: "ready" as const,
  title: "House PTR research signal · review",
  whyMatched: explanation.caveat,
  workspaceId: congressionalWorkspace.id,
  workspaceName: "Congressional Signals",
};
const alertScope = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId: congressionalWorkspace.id },
  environment,
);
const alertStore = new MemoryAlertStore();
let deliveredCard: { discussUrl: string; fallbackText: string } | null = null;
const delivery = await deliverWorkspaceAlertToPhoton({
  alert,
  alertClient: alertStore,
  monitor,
  now: new Date(signal.createdAt),
  pauseMonitor: async () => { throw new Error("successful_delivery_must_not_pause"); },
  recordRecent: async () => {},
  scope: alertScope,
  send: async (card) => {
    deliveredCard = card;
    return { messageId: "message_congressional_sprint_4" };
  },
  subscription: {
    conversationId: `conversation_${"c".repeat(64)}`,
    destination: "private-photon-thread",
    ownerId,
    ...routing,
    subscriptionId: monitor.deliverySubscriptionId,
  },
  workspaceClient: workspaceStore,
});
assert.equal(delivery.state, "delivered");
assert.match(deliveredCard!.fallbackText, /research signal only/u);
assert.equal((await getPhotonWorkspaceState(routing, workspaceStore)).activeWorkspace.id, unrelatedWorkspace.id);

const alertToken = new URL(deliveredCard!.discussUrl).hash.slice(1).split(".")[0]!;
const discussed = await applyPhotonAlertDiscussAction(alertToken, workspaceStore);
assert.equal(discussed.status, "applied");
if (discussed.status !== "applied") throw new Error("discuss_action_not_applied");
assert.equal(discussed.state.activeWorkspace.id, congressionalWorkspace.id);
const wrongWorkspace = await consumePhotonPendingAlertContext({
  ...routing,
  workspaceId: unrelatedWorkspace.id,
}, workspaceStore);
assert.equal(wrongWorkspace.context, null);
const selectedWorkspace = await consumePhotonPendingAlertContext({
  ...routing,
  workspaceId: congressionalWorkspace.id,
}, workspaceStore);
assert.equal(selectedWorkspace.context?.alertId, alert.alertId);
assert.equal(selectedWorkspace.context?.findingId, alert.findingId);
assert.equal(selectedWorkspace.context?.workspaceId, congressionalWorkspace.id);
await assert.rejects(() => deliverWorkspaceAlertToPhoton({
  alert,
  alertClient: alertStore,
  monitor: { ...monitor, workspaceId: unrelatedWorkspace.id },
  pauseMonitor: async () => {},
  scope: alertScope,
  send: async () => ({ messageId: "must-not-send" }),
  subscription: {
    conversationId: `conversation_${"c".repeat(64)}`,
    destination: "private-photon-thread",
    ownerId,
    ...routing,
    subscriptionId: monitor.deliverySubscriptionId,
  },
  workspaceClient: workspaceStore,
}), /photon_alert_subscription_scope_mismatch/u);

console.info("Congressional Signals Sprint 4 configuration, manager, explanation, and routed-alert verification passed.");
