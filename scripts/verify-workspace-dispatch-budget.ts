import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  finishWorkspaceMonitorDispatchBudget,
  readGlobalDispatchBudgetLedger,
  reserveWorkspaceMonitorDispatchBudget,
  reserveHybridEvidenceDeploymentBudget,
  reconcileHybridEvidenceDeploymentBudget,
  resolveWorkspaceGlobalBudgetLimits,
  WorkspaceDispatchBudgetError,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import {
  readWorkspaceBudgetLedger,
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  summarizeWorkspaceBudgetUsage,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import {
  authorizeDeploymentWorkspaceStore,
  type AuthorizedWorkspaceStoreScope,
} from "../agent/lib/workspace-store-authorization";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";

class MemoryStore
  implements WorkspaceGlobalBudgetClient, WorkspaceBudgetLedgerClient, WorkspaceStateStoreClient
{
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

const now = new Date("2026-08-14T17:00:00.000Z");
const releasedHybridStore = new MemoryStore();
const staleHybridStore = new MemoryStore();
const releasedHybridInput = { inputTokens: 100, outputTokens: 20, modelId: "fixture/recovery", now,
  paidCostCeiling: "0.1", reservationKey: "released-hybrid-fixture" };
const releasedHybridOptions = { client: releasedHybridStore,
  environment: { EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/recovery" } };
await reserveHybridEvidenceDeploymentBudget(releasedHybridInput, { ...releasedHybridOptions, client: staleHybridStore });
await reserveHybridEvidenceDeploymentBudget({ ...releasedHybridInput, now: new Date(now.getTime() + 3 * 3600000) },
  { ...releasedHybridOptions, client: staleHybridStore });
assert.equal((await readGlobalDispatchBudgetLedger(staleHybridStore)).reservations[0]!.state, "uncertain",
  "idempotent lookups durably expire stale reservations");
await reserveHybridEvidenceDeploymentBudget(releasedHybridInput, releasedHybridOptions);
await reconcileHybridEvidenceDeploymentBudget({ reservationKey: releasedHybridInput.reservationKey, now, outcome: "released" }, releasedHybridStore);
await assert.rejects(reserveHybridEvidenceDeploymentBudget(releasedHybridInput, releasedHybridOptions), /global_budget_conflict/u);
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "2",
  EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "3",
};
const policy = {
  effectiveAt: now.toISOString(),
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 2_000,
  maximumInputTokensPerRun: 600,
  maximumOutputTokensPerDay: 1_000,
  maximumOutputTokensPerRun: 300,
  maximumPaidPerCall: "0",
  maximumPaidPerDay: "0",
  maximumPaidPerMonth: "0",
  maximumScheduledRunsPerDay: 3,
  ownerTimezone: "America/Vancouver",
  unknownPriceFallbackCeiling: "0",
};

function scope(workspaceId: string): AuthorizedWorkspaceStoreScope {
  return authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId },
    environment,
  );
}

function job(
  authorizedScope: AuthorizedWorkspaceStoreScope,
  suffix: string,
): ClaimedWorkspaceMonitor {
  return {
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    leaseToken: `lease_${suffix}`,
    monitor: {
      configurationRevision: 1,
      consecutiveFailures: 0,
      createdAt: now.toISOString(),
      deliverySubscriptionId: "delivery.fixture",
      endAt: null,
      instruction: "Inspect the configured public source.",
      lastCompletedAt: null,
      lastErrorCode: null,
      lastRunAt: null,
      lifecycleState: "enabled",
      monitorId: `${suffix.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`,
      name: `Monitor ${suffix}`,
      nextOccurrenceAt: now.toISOString(),
      ownerId: authorizedScope.ownerId,
      pauseReason: null,
      pausedAt: null,
      requiredCapabilityIds: [],
      schedule: { at: now.toISOString(), kind: "one_time" },
      schemaVersion: 1,
      sourceCheckpoint: { contentDigest: null, watermark: null },
      sources: [
        {
          accessClassification: "public",
          canonicalUrl: "https://example.gov/feed",
          origin: "https://example.gov",
          sourceId: "source.fixture",
        },
      ],
      tighteningLimits: {
        inputTokensPerRun: 300,
        outputTokensPerRun: 100,
        paidPerRun: null,
      },
      updatedAt: now.toISOString(),
      workspaceBindingImmutable: true,
      workspaceId: authorizedScope.workspaceId,
    },
    occurrence: {
      attempt: 1,
      configurationRevision: 1,
      leaseTokenDigest: "a".repeat(64),
      monitorId: `${suffix.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`,
      occurrenceIdentity: `${now.toISOString()}:${suffix}`,
      occurrenceKey: suffix.padEnd(64, "a").slice(0, 64),
      scheduledFor: now.toISOString(),
      schemaVersion: 1,
      status: "leased",
      updatedAt: now.toISOString(),
    },
    scope: authorizedScope,
    skippedOccurrenceIdentities: [],
  };
}

async function putPolicy(
  authorizedScope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceStateStoreClient,
) {
  await writeWorkspaceDocument(
    "budget",
    { expectedRevision: 0, now, scope: authorizedScope, value: policy },
    client,
  );
}

assert.deepEqual(resolveWorkspaceGlobalBudgetLimits({}), {
  maximumConcurrentWorkers: 8,
  maximumRunsPerDay: 500,
});
assert.throws(
  () => resolveWorkspaceGlobalBudgetLimits({ EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "501" }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "global_budget_invalid",
);

const global = new MemoryStore();
const state = new MemoryStore();
const workspace = new MemoryStore();
const clients = { global, state, workspace };
const scopeA = scope("123e4567-e89b-42d3-a456-426614174000");
const scopeB = scope("223e4567-e89b-42d3-a456-426614174000");
const scopeC = scope("323e4567-e89b-42d3-a456-426614174000");
await Promise.all([
  putPolicy(scopeA, state),
  putPolicy(scopeB, state),
  putPolicy(scopeC, state),
]);

const jobA = job(scopeA, "a1");
const admittedA = await reserveWorkspaceMonitorDispatchBudget(jobA, {
  clients,
  environment,
  now,
});
assert.equal(admittedA.workspace.inputTokens, 300);
assert.equal(admittedA.workspace.outputTokens, 100);

await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "a2"), {
    clients,
    environment,
    now,
  }),
  (error: unknown) => error instanceof Error && error.message === "budget_exhausted",
);

const jobB = job(scopeB, "b1");
const admittedB = await reserveWorkspaceMonitorDispatchBudget(jobB, {
  clients,
  environment,
  now,
});
await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeC, "c1"), {
    clients,
    environment,
    now,
  }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "global_budget_exhausted",
);
await finishWorkspaceMonitorDispatchBudget(
  jobA,
  admittedA,
  { now, outcome: "released" },
  clients,
);
const jobC = job(scopeC, "c2");
const admittedC = await reserveWorkspaceMonitorDispatchBudget(jobC, {
  clients,
  environment,
  now,
});
await finishWorkspaceMonitorDispatchBudget(
  jobB,
  admittedB,
  { actualInputTokens: 200, actualOutputTokens: 50, now, outcome: "reconciled" },
  clients,
);
await finishWorkspaceMonitorDispatchBudget(
  jobC,
  admittedC,
  { now, outcome: "released" },
  clients,
);
const ledger = await readGlobalDispatchBudgetLedger(global);
assert.equal(ledger.reservations.filter((entry) => entry.state === "reserved").length, 0);
assert.equal(ledger.reservations.filter((entry) => entry.state === "settled").length, 1);

// A process death can strand the global reservation after every legitimate
// monitor lease and hybrid worker deadline has expired. It must stop counting
// as active concurrency while remaining conservatively charged as uncertain.
const staleGlobal = new MemoryStore();
const staleState = new MemoryStore();
const staleWorkspace = new MemoryStore();
await Promise.all([putPolicy(scopeA, staleState), putPolicy(scopeB, staleState)]);
await reserveWorkspaceMonitorDispatchBudget(job(scopeA, "stalea"), {
  clients: { global: staleGlobal, state: staleState, workspace: staleWorkspace },
  environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
  now,
});
const afterStaleDeadline = new Date(now.getTime() + 2 * 60 * 60_000 + 1);
await reserveWorkspaceMonitorDispatchBudget(job(scopeB, "staleb"), {
  clients: { global: staleGlobal, state: staleState, workspace: staleWorkspace },
  environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
  now: afterStaleDeadline,
});
const staleLedger = await readGlobalDispatchBudgetLedger(staleGlobal);
assert.equal(staleLedger.reservations.find(({ runId }) =>
  runId.startsWith(job(scopeA, "stalea").occurrence.occurrenceKey))?.state, "uncertain");
assert.equal(staleLedger.reservations.filter(({ state }) => state === "reserved").length, 1);

// A monitor admitted after UTC midnight must not prune the recovery lane's
// monthly charges or the receipts needed to reconcile interrupted work.
for (const scenario of ["expired", "uncertain", "settled", "month-boundary"] as const) {
  const overnightGlobal = new MemoryStore();
  const overnightState = new MemoryStore();
  const overnightWorkspace = new MemoryStore();
  await Promise.all([putPolicy(scopeA, overnightState), putPolicy(scopeB, overnightState)]);
  const prior = new Date(scenario === "month-boundary" ? "2026-08-31T21:00:00.000Z" : "2026-08-14T21:00:00.000Z");
  const next = new Date(scenario === "month-boundary" ? "2026-09-01T01:00:00.000Z" : "2026-08-15T01:00:00.000Z");
  const recoveryOptions = { client: overnightGlobal, environment: {
    EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/recovery",
    EVE_HYBRID_SOURCE_RECOVERY_CONCURRENT_WORKERS: "1",
    EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_DAY: "1",
    EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_MONTH: "1",
  } };
  const recoveryInput = { ...releasedHybridInput, now: prior, paidCostCeiling: "0.75", reservationKey: "overnight-recovery" };
  await reserveHybridEvidenceDeploymentBudget(recoveryInput, recoveryOptions);
  if (scenario === "uncertain" || scenario === "settled") {
    await reconcileHybridEvidenceDeploymentBudget({ reservationKey: recoveryInput.reservationKey,
      now: prior, outcome: scenario === "settled" ? "reconciled" : "uncertain",
      ...(scenario === "settled" ? { actualPaidCost: "0.75", actualInputTokens: 100, actualOutputTokens: 20 } : {}),
    }, overnightGlobal);
  }
  const overnightClients = { global: overnightGlobal, state: overnightState, workspace: overnightWorkspace };
  const overnightEnvironment = { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" };
  const oldMonitor = job(scopeA, "overnight-old");
  const oldMonitorReservation = await reserveWorkspaceMonitorDispatchBudget(oldMonitor, {
    clients: overnightClients, environment: overnightEnvironment, now: prior,
  });
  await reserveWorkspaceMonitorDispatchBudget(job(scopeB, "overnight-new"), {
    clients: overnightClients, environment: overnightEnvironment, now: next,
  });
  const overnightLedger = await readGlobalDispatchBudgetLedger(overnightGlobal);
  assert.equal(overnightLedger.reservations.find(({ runId }) => runId === recoveryInput.reservationKey)?.state,
    scenario === "settled" ? "settled" : "uncertain", `${scenario}: monitor admission must retain recovery receipt`);
  assert.equal(overnightLedger.reservations.find(({ runId }) => runId === oldMonitorReservation.runId)?.state,
    "uncertain", `${scenario}: preserve interrupted monitor receipt without consuming concurrency`);
  assert.equal(overnightLedger.reservations.filter(({ kind, state }) => kind === "scheduled_monitor" && state === "reserved").length, 1);
  // An uncertain recovery no longer occupies the sole hybrid worker slot.
  await reserveHybridEvidenceDeploymentBudget({ ...recoveryInput, now: next, paidCostCeiling: "0.10", reservationKey: "overnight-affordable" }, recoveryOptions);
  await reconcileHybridEvidenceDeploymentBudget({ reservationKey: "overnight-affordable", now: next,
    outcome: "reconciled", actualPaidCost: "0.10", actualInputTokens: 100, actualOutputTokens: 20 }, overnightGlobal);
  await assert.rejects(reserveHybridEvidenceDeploymentBudget({ ...recoveryInput, now: next,
    paidCostCeiling: "0.20", reservationKey: "overnight-monthly-denied" }, recoveryOptions),
  /global_budget_exhausted/u, `${scenario}: prior recovery still consumes the monthly allowance`);
  const repaired = await reconcileHybridEvidenceDeploymentBudget({ reservationKey: recoveryInput.reservationKey,
    now: next, outcome: "reconciled", actualInputTokens: 100, actualOutputTokens: 20,
    actualPaidCost: scenario === "settled" ? "0.75" : "0.40" }, overnightGlobal);
  assert.equal(repaired.state, "settled", `${scenario}: original attempt remains reconcilable`);
  assert.equal(repaired.reconciledPaidMicros, scenario === "settled" ? "750000" : "400000");
  await reserveHybridEvidenceDeploymentBudget({ ...recoveryInput, now: next,
    paidCostCeiling: scenario === "settled" ? "0.15" : "0.50", reservationKey: "overnight-after-reconciliation" }, recoveryOptions);
}

const missingGlobal = new MemoryStore();
const missingWorkspace = new MemoryStore();
await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "missing"), {
    clients: { global: missingGlobal, state: new MemoryStore(), workspace: missingWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "workspace_budget_missing",
);
const validState = new MemoryStore();
await putPolicy(scopeB, validState);
await reserveWorkspaceMonitorDispatchBudget(job(scopeB, "valid"), {
  clients: { global: missingGlobal, state: validState, workspace: missingWorkspace },
  environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
  now,
});

const raceGlobal = new MemoryStore();
const raceState = new MemoryStore();
const raceWorkspace = new MemoryStore();
await Promise.all([putPolicy(scopeA, raceState), putPolicy(scopeB, raceState)]);
const race = await Promise.allSettled([
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "racea"), {
    clients: { global: raceGlobal, state: raceState, workspace: raceWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
  reserveWorkspaceMonitorDispatchBudget(job(scopeB, "raceb"), {
    clients: { global: raceGlobal, state: raceState, workspace: raceWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
]);
assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(race.filter((result) => result.status === "rejected").length, 1);

const overlapGlobal = new MemoryStore();
const overlapState = new MemoryStore();
const overlapWorkspace = new MemoryStore();
await Promise.all([
  putPolicy(scopeA, overlapState),
  putPolicy(scopeB, overlapState),
  putPolicy(scopeC, overlapState),
]);
const overlapClients = {
  global: overlapGlobal,
  state: overlapState,
  workspace: overlapWorkspace,
};
const overlapJobA = job(scopeA, "overlapa");
const overlapJobB = job(scopeB, "overlapb");
const [overlapBudgetA, overlapBudgetB] = await Promise.all([
  reserveWorkspaceMonitorDispatchBudget(overlapJobA, {
    clients: overlapClients,
    environment,
    now,
  }),
  reserveWorkspaceMonitorDispatchBudget(overlapJobB, {
    clients: overlapClients,
    environment,
    now,
  }),
]);
let releaseWorkers!: () => void;
const workerGate = new Promise<void>((resolve) => { releaseWorkers = resolve; });
let confirmOverlap!: () => void;
const overlapped = new Promise<void>((resolve) => { confirmOverlap = resolve; });
const activeWorkspaces = new Set<string>();
let maximumOverlap = 0;
async function executeFixtureWorker(
  fixtureJob: ClaimedWorkspaceMonitor,
  reservation: Awaited<ReturnType<typeof reserveWorkspaceMonitorDispatchBudget>>,
) {
  activeWorkspaces.add(fixtureJob.scope.workspaceId);
  maximumOverlap = Math.max(maximumOverlap, activeWorkspaces.size);
  if (activeWorkspaces.size === 2) confirmOverlap();
  await workerGate;
  activeWorkspaces.delete(fixtureJob.scope.workspaceId);
  await finishWorkspaceMonitorDispatchBudget(
    fixtureJob,
    reservation,
    { actualInputTokens: 100, actualOutputTokens: 25, now, outcome: "reconciled" },
    overlapClients,
  );
}
const runningWorkers = [
  executeFixtureWorker(overlapJobA, overlapBudgetA),
  executeFixtureWorker(overlapJobB, overlapBudgetB),
];
await overlapped;
assert.deepEqual(activeWorkspaces, new Set([scopeA.workspaceId, scopeB.workspaceId]));
await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeC, "overlapc"), {
    clients: overlapClients,
    environment,
    now,
  }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "global_budget_exhausted",
);
releaseWorkers();
await Promise.all(runningWorkers);
assert.equal(maximumOverlap, 2);
const recoveredJob = job(scopeC, "overlapd");
const recoveredBudget = await reserveWorkspaceMonitorDispatchBudget(recoveredJob, {
  clients: overlapClients,
  environment,
  now,
});
await finishWorkspaceMonitorDispatchBudget(
  recoveredJob,
  recoveredBudget,
  { now, outcome: "released" },
  overlapClients,
);

const nestedGlobal = new MemoryStore();
const nestedState = new MemoryStore();
const nestedWorkspace = new MemoryStore();
const nestedPolicy = {
  ...policy,
  maximumPaidPerCall: "0.500000",
  maximumPaidPerDay: "1.000000",
  maximumPaidPerMonth: "2.000000",
};
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now,
  scope: scopeC,
  value: nestedPolicy,
}, nestedState);
const nestedBaseJob = job(scopeC, "nested");
const nestedJob = {
  ...nestedBaseJob,
  monitor: {
    ...nestedBaseJob.monitor,
    tighteningLimits: {
      ...nestedBaseJob.monitor.tighteningLimits,
      paidPerRun: "0.500000",
    },
  },
};
const nestedReservation = await reserveWorkspaceMonitorDispatchBudget(nestedJob, {
  clients: {
    global: nestedGlobal,
    state: nestedState,
    workspace: nestedWorkspace,
  },
  environment,
  now,
});
assert.equal(nestedReservation.workspace.paidMicros, "500000");
const nestedModel = await reserveWorkspaceRunBudget({
  inputTokens: 200,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 50,
  paidCostCeiling: { amount: "0.400000", kind: "known" },
  parentRunId: nestedReservation.runId,
  policy: nestedPolicy,
  policyRevision: 1,
  runId: "nested-model",
  scope: scopeC,
}, nestedWorkspace);
const nestedSearch = await reserveWorkspaceRunBudget({
  inputTokens: 0,
  kind: "paid_source_attempt",
  now,
  outputTokens: 0,
  paidCostCeiling: { amount: "0.010000", kind: "known" },
  parentRunId: nestedReservation.runId,
  policy: nestedPolicy,
  policyRevision: 1,
  runId: "nested-search",
  scope: scopeC,
}, nestedWorkspace);
await Promise.all([
  reconcileWorkspaceRunBudget({
    actualInputTokens: 100,
    actualOutputTokens: 25,
    actualPaidCost: "0.300000",
    outcome: "reconciled",
    runId: nestedModel.runId,
    scope: scopeC,
  }, nestedWorkspace),
  reconcileWorkspaceRunBudget({
    actualPaidCost: "0.005000",
    outcome: "reconciled",
    runId: nestedSearch.runId,
    scope: scopeC,
  }, nestedWorkspace),
]);
await finishWorkspaceMonitorDispatchBudget(
  nestedJob,
  nestedReservation,
  { now, outcome: "reconciled" },
  { global: nestedGlobal, workspace: nestedWorkspace },
);
const nestedLedger = await readWorkspaceBudgetLedger(scopeC, nestedWorkspace);
const settledParent = nestedLedger.reservations.find(
  ({ runId }) => runId === nestedReservation.runId,
);
assert.equal(settledParent?.reconciledInputTokens, 100);
assert.equal(settledParent?.reconciledOutputTokens, 25);
assert.equal(settledParent?.reconciledPaidMicros, "305000");
assert.equal(
  summarizeWorkspaceBudgetUsage(nestedLedger, now, nestedPolicy.ownerTimezone)
    .activeWorkers,
  0,
);

// A scheduled parent without a per-run dollar cap reserves $0 because it is
// an aggregate occurrence envelope, not a provider call. Paid children still
// reconcile into that parent; otherwise the parent remains reserved forever
// and maximumConcurrentWorkers blocks every later occurrence.
const aggregateGlobal = new MemoryStore();
const aggregateState = new MemoryStore();
const aggregateWorkspace = new MemoryStore();
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now,
  scope: scopeB,
  value: nestedPolicy,
}, aggregateState);
const aggregateJob = job(scopeB, "aggregate");
const aggregateReservation = await reserveWorkspaceMonitorDispatchBudget(aggregateJob, {
  clients: {
    global: aggregateGlobal,
    state: aggregateState,
    workspace: aggregateWorkspace,
  },
  environment,
  now,
});
assert.equal(aggregateReservation.workspace.paidMicros, "0");
const aggregateChild = await reserveWorkspaceRunBudget({
  inputTokens: 200,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 50,
  paidCostCeiling: { amount: "0.400000", kind: "known" },
  parentRunId: aggregateReservation.runId,
  policy: nestedPolicy,
  policyRevision: 1,
  runId: "aggregate-model",
  scope: scopeB,
}, aggregateWorkspace);
await reconcileWorkspaceRunBudget({
  actualInputTokens: 100,
  actualOutputTokens: 25,
  actualPaidCost: "0.300000",
  outcome: "reconciled",
  runId: aggregateChild.runId,
  scope: scopeB,
}, aggregateWorkspace);
await finishWorkspaceMonitorDispatchBudget(
  aggregateJob,
  aggregateReservation,
  { now, outcome: "reconciled" },
  { global: aggregateGlobal, workspace: aggregateWorkspace },
);
const aggregateLedger = await readWorkspaceBudgetLedger(scopeB, aggregateWorkspace);
const aggregateParent = aggregateLedger.reservations.find(
  ({ runId }) => runId === aggregateReservation.runId,
);
assert.equal(aggregateParent?.state, "reconciled");
assert.equal(aggregateParent?.reconciledPaidMicros, "300000");
assert.equal(
  summarizeWorkspaceBudgetUsage(aggregateLedger, now, nestedPolicy.ownerTimezone)
    .activeWorkers,
  0,
);

const scheduleSource = await readFile(
  new URL("../agent/schedules/event-triggers.ts", import.meta.url),
  "utf8",
);
assert.ok(
  scheduleSource.indexOf("dependencies.claimWorkspaceMonitors({") <
    scheduleSource.indexOf("dependencies.reserveWorkspaceBudget(job"),
);
assert.match(scheduleSource, /releaseWorkspaceMonitorLease/u);

console.info("Workspace dispatch budget verification passed.");
