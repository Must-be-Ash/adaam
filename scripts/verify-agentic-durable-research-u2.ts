import assert from "node:assert/strict";

import {
  executeReplaySafeExaResearch,
  executeReplaySafePublicDocumentResearch,
  HybridEvidenceResearchAttemptError,
  readHybridEvidenceResearchAttemptReceipt,
  type HybridEvidenceResearchAttemptStoreClient,
} from "../agent/lib/hybrid-evidence-research-receipt";
import {
  readWorkspaceBudgetLedger,
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  summarizeWorkspaceBudgetUsage,
  WorkspaceBudgetError,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { compileWebCorroborationQuery } from "../agent/lib/web-corroboration-search";
import type { WorkspaceBudgetPolicyValue } from "../agent/lib/workspace-state-store";

class MemoryStore implements
  HybridEvidenceResearchAttemptStoreClient,
  WorkspaceBudgetLedgerClient {
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

const now = new Date("2026-08-20T18:00:00.000Z");
const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const policy = {
  effectiveAt: now.toISOString(),
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 20_000,
  maximumInputTokensPerRun: 10_000,
  maximumOutputTokensPerDay: 4_000,
  maximumOutputTokensPerRun: 2_000,
  maximumPaidPerCall: "0.500000",
  maximumPaidPerDay: "1.000000",
  maximumPaidPerMonth: "2.000000",
  maximumScheduledRunsPerDay: 4,
  ownerTimezone: "America/Vancouver",
  unknownPriceFallbackCeiling: "0.500000",
} satisfies WorkspaceBudgetPolicyValue;
const parentRunId = `${"a".repeat(64)}:attempt:1`;
const store = new MemoryStore();

const parent = await reserveWorkspaceRunBudget({
  inputTokens: 10_000,
  kind: "scheduled_monitor",
  now,
  outputTokens: 2_000,
  paidCostCeiling: { amount: "0.500000", kind: "known" },
  policy,
  policyRevision: 1,
  runId: parentRunId,
  scope,
}, store);
const modelChild = await reserveWorkspaceRunBudget({
  inputTokens: 8_000,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 1_000,
  paidCostCeiling: { amount: "0.400000", kind: "known" },
  parentRunId,
  policy,
  policyRevision: 1,
  runId: "hybrid-model-child",
  scope,
}, store);
assert.equal(modelChild.parentRunId, parentRunId);
assert.deepEqual(summarizeWorkspaceBudgetUsage(
  await readWorkspaceBudgetLedger(scope, store),
  now,
  policy.ownerTimezone,
), {
  activeWorkers: 1,
  calendarDay: "2026-08-20",
  calendarMonth: "2026-08",
  inputTokensToday: 10_000,
  outputTokensToday: 2_000,
  paidMicrosThisMonth: "500000",
  paidMicrosToday: "500000",
  runsToday: 1,
});

const query = compileWebCorroborationQuery({
  endPublishedAt: "2026-08-20T18:00:00.000Z",
  publicTargetTerms: ["Example Holdings"],
  publicTopicTerms: ["S-1"],
  startPublishedAt: "2026-08-01T00:00:00.000Z",
});
let providerCalls = 0;
let releaseProvider!: () => void;
const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
let providerStarted!: () => void;
const providerStart = new Promise<void>((resolve) => { providerStarted = resolve; });
const provider = {
  async search() {
    providerCalls += 1;
    providerStarted();
    await providerGate;
    return {
      completeness: "complete" as const,
      cost: { amountUsd: "0.005000", billableUnits: 1, currency: "USD" as const },
      provider: "exa" as const,
      queriedAt: now.toISOString(),
      queryDigest: query.queryDigest,
      recordType: "web_corroboration_search" as const,
      requestId: "exa-request-1",
      results: [{
        author: null,
        publishedAt: now.toISOString(),
        resultId: "result-1",
        title: "Example Holdings profile",
        url: "https://research.example/example-holdings",
      }],
      schemaVersion: 1 as const,
      status: "candidates_found" as const,
    };
  },
};
const searchInput = {
  budget: { policy, policyRevision: 1 },
  claimToken: "claim-token",
  clients: { budget: store, receipts: store },
  jobId: "hybrid-job.fixture",
  now,
  parentRunId,
  provider,
  query,
  scope,
};
const firstSearch = executeReplaySafeExaResearch(searchInput);
await providerStart;
const duplicateSearch = executeReplaySafeExaResearch(searchInput);
releaseProvider();
const [firstResult, duplicateResult] = await Promise.all([
  firstSearch,
  duplicateSearch,
]);
assert.deepEqual(duplicateResult, firstResult);
assert.equal(providerCalls, 1);

const replayedResult = await executeReplaySafeExaResearch(searchInput);
assert.deepEqual(replayedResult, firstResult);
assert.equal(providerCalls, 1, "settled research replay must not call Exa again");
const conflictingQuery = compileWebCorroborationQuery({
  endPublishedAt: "2026-08-20T18:00:00.000Z",
  publicTargetTerms: ["Different Holdings"],
  publicTopicTerms: ["S-1"],
  startPublishedAt: "2026-08-01T00:00:00.000Z",
});
await assert.rejects(executeReplaySafeExaResearch({
  ...searchInput,
  query: conflictingQuery,
}), (error: unknown) =>
  error instanceof HybridEvidenceResearchAttemptError &&
  error.code === "research_attempt_conflict"
);
assert.equal(providerCalls, 1, "one job cannot fan out into a second paid query");
const receipt = await readHybridEvidenceResearchAttemptReceipt({
  jobId: searchInput.jobId,
  operation: "exa_search",
  parentRunId,
  requestDigest: query.queryDigest,
  scope,
}, store);
assert.equal(receipt?.state, "settled");
assert.equal(receipt?.actualPaidMicros, "5000");
assert.equal(receipt?.providerRequestId, "exa-request-1");
assert.equal(receipt?.resultDigest.length, 64);

const crashStore = new MemoryStore();
const crashParent = await reserveWorkspaceRunBudget({
  inputTokens: 10_000,
  kind: "scheduled_monitor",
  now,
  outputTokens: 2_000,
  paidCostCeiling: { amount: "0.500000", kind: "known" },
  policy,
  policyRevision: 1,
  runId: "crash-parent",
  scope,
}, crashStore);
let crashProviderCalls = 0;
let failReconcile = true;
const crashingBudget: WorkspaceBudgetLedgerClient = {
  compareAndSet: async (key, expected, next) => {
    if (
      failReconcile &&
      next.includes('"kind":"paid_source_attempt"') &&
      next.includes('"state":"reconciled"')
    ) {
      failReconcile = false;
      throw new Error("simulated_crash_after_receipt");
    }
    return crashStore.compareAndSet(key, expected, next);
  },
  get: (key) => crashStore.get(key),
};
const crashInput = {
  ...searchInput,
  clients: { budget: crashingBudget, receipts: crashStore },
  jobId: "hybrid-job.crash-after-receipt",
  parentRunId: crashParent.runId,
  provider: {
    async search() {
      crashProviderCalls += 1;
      return provider.search();
    },
  },
};
await assert.rejects(
  executeReplaySafeExaResearch(crashInput),
  /simulated_crash_after_receipt/u,
);
assert.equal(crashProviderCalls, 1);
await executeReplaySafeExaResearch({
  ...crashInput,
  clients: { budget: crashStore, receipts: crashStore },
});
assert.equal(
  crashProviderCalls,
  1,
  "replay after a stored provider receipt must only reconcile the ledger",
);

await reconcileWorkspaceRunBudget({
  actualInputTokens: 3_000,
  actualOutputTokens: 500,
  actualPaidCost: "0.300000",
  outcome: "reconciled",
  runId: modelChild.runId,
  scope,
}, store);
await assert.rejects(reserveWorkspaceRunBudget({
  inputTokens: 5_001,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 501,
  paidCostCeiling: { amount: "0.195001", kind: "known" },
  parentRunId,
  policy,
  policyRevision: 1,
  runId: "child-over-parent-envelope",
  scope,
}, store), (error: unknown) =>
  error instanceof WorkspaceBudgetError && error.code === "budget_exhausted"
);

await reconcileWorkspaceRunBudget({
  actualInputTokens: 3_000,
  actualOutputTokens: 500,
  actualPaidCost: "0.305000",
  outcome: "reconciled",
  runId: parent.runId,
  scope,
}, store);
const settledUsage = summarizeWorkspaceBudgetUsage(
  await readWorkspaceBudgetLedger(scope, store),
  now,
  policy.ownerTimezone,
);
assert.equal(settledUsage.activeWorkers, 0);
assert.equal(settledUsage.inputTokensToday, 3_000);
assert.equal(settledUsage.outputTokensToday, 500);
assert.equal(settledUsage.paidMicrosToday, "305000");

let documentCalls = 0;
const documentInput = {
  allowedUrls: ["https://research.example/example-holdings"],
  claimToken: "claim-token",
  clients: { receipts: store },
  fetchDocument: async () => {
    documentCalls += 1;
    return {
      byteCount: 26,
      content: "Public supplementary text.",
      contentType: "text/plain",
      url: "https://research.example/example-holdings",
    };
  },
  jobId: searchInput.jobId,
  now,
  parentRunId,
  scope,
  url: "https://research.example/example-holdings",
};
const firstDocument = await executeReplaySafePublicDocumentResearch(documentInput);
const replayedDocument = await executeReplaySafePublicDocumentResearch(documentInput);
assert.deepEqual(replayedDocument, firstDocument);
assert.equal(documentCalls, 1);

const deniedStore = new MemoryStore();
const deniedParent = await reserveWorkspaceRunBudget({
  inputTokens: 10_000,
  kind: "scheduled_monitor",
  now,
  outputTokens: 2_000,
  paidCostCeiling: { amount: "0.400000", kind: "known" },
  policy,
  policyRevision: 1,
  runId: "denied-parent",
  scope,
}, deniedStore);
await reserveWorkspaceRunBudget({
  inputTokens: 8_000,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 1_000,
  paidCostCeiling: { amount: "0.400000", kind: "known" },
  parentRunId: deniedParent.runId,
  policy,
  policyRevision: 1,
  runId: "denied-model",
  scope,
}, deniedStore);
let deniedProviderCalls = 0;
await assert.rejects(executeReplaySafeExaResearch({
  ...searchInput,
  clients: { budget: deniedStore, receipts: deniedStore },
  parentRunId: deniedParent.runId,
  provider: {
    async search() {
      deniedProviderCalls += 1;
      return provider.search();
    },
  },
}), (error: unknown) =>
  error instanceof HybridEvidenceResearchAttemptError &&
  error.code === "research_budget_denied"
);
assert.equal(deniedProviderCalls, 0);
assert.equal((await readWorkspaceBudgetLedger(scope, deniedStore)).reservations.length, 2);

const uncertainStore = new MemoryStore();
const uncertainParent = await reserveWorkspaceRunBudget({
  inputTokens: 10_000,
  kind: "scheduled_monitor",
  now,
  outputTokens: 2_000,
  paidCostCeiling: { amount: "0.500000", kind: "known" },
  policy,
  policyRevision: 1,
  runId: "uncertain-parent",
  scope,
}, uncertainStore);
let uncertainCalls = 0;
const uncertainInput = {
  ...searchInput,
  clients: { budget: uncertainStore, receipts: uncertainStore },
  parentRunId: uncertainParent.runId,
  provider: {
    async search() {
      uncertainCalls += 1;
      throw new Error("provider completion unknown");
    },
  },
};
await assert.rejects(executeReplaySafeExaResearch(uncertainInput), (error: unknown) =>
  error instanceof HybridEvidenceResearchAttemptError &&
  error.code === "research_completion_uncertain"
);
await assert.rejects(executeReplaySafeExaResearch(uncertainInput), (error: unknown) =>
  error instanceof HybridEvidenceResearchAttemptError &&
  error.code === "research_completion_uncertain"
);
assert.equal(uncertainCalls, 1);
const uncertainLedger = await readWorkspaceBudgetLedger(scope, uncertainStore);
assert.equal(
  uncertainLedger.reservations.find(({ kind }) => kind === "paid_source_attempt")?.state,
  "uncertain",
);

console.info("Agentic durable research U2 verification passed.");
