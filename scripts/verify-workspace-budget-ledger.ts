import assert from "node:assert/strict";

import {
  formatWorkspacePaidMicros,
  readWorkspaceBudgetLedger,
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  summarizeWorkspaceBudgetUsage,
  WorkspaceBudgetError,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import { authorizePhotonWorkspaceControlPlaneStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements WorkspaceBudgetLedgerClient {
  getCalls = 0;
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};
const scope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "worker",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const policy = {
  effectiveAt: "2026-08-14T00:00:00.000Z",
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 1_000,
  maximumInputTokensPerRun: 600,
  maximumOutputTokensPerDay: 500,
  maximumOutputTokensPerRun: 300,
  maximumPaidPerCall: "0.75",
  maximumPaidPerDay: "1.00",
  maximumPaidPerMonth: "2.00",
  maximumScheduledRunsPerDay: 3,
  ownerTimezone: "America/Vancouver",
  unknownPriceFallbackCeiling: "0.75",
};
const now = new Date("2026-08-14T17:00:00.000Z");
const client = new MemoryStore();

const reservation = await reserveWorkspaceRunBudget(
  {
    inputTokens: 400,
    now,
    outputTokens: 200,
    paidCostCeiling: { amount: "0.1", kind: "known" },
    policy,
    policyRevision: 1,
    runId: "run_fixture_1",
    scope,
  },
  client,
);
assert.equal(reservation.paidMicros, "100000");
assert.equal(reservation.state, "reserved");
assert.equal(
  summarizeWorkspaceBudgetUsage(
    await readWorkspaceBudgetLedger(scope, client),
    now,
    policy.ownerTimezone,
  ).activeWorkers,
  1,
);
assert.equal(
  formatWorkspacePaidMicros("9007199254740993"),
  "$9007199254.740993",
);
assert.deepEqual(
  await reserveWorkspaceRunBudget(
    {
      inputTokens: 400,
      now,
      outputTokens: 200,
      paidCostCeiling: { amount: "0.10", kind: "known" },
      policy,
      policyRevision: 1,
      runId: "run_fixture_1",
      scope,
    },
    client,
  ),
  reservation,
);
await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 100,
      now,
      outputTokens: 50,
      policy,
      policyRevision: 1,
      runId: "run_concurrent_blocked",
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
);

const completed = await reconcileWorkspaceRunBudget(
  {
    actualInputTokens: 350,
    actualOutputTokens: 150,
    actualPaidCost: "0.05",
    now: new Date("2026-08-14T17:01:00.000Z"),
    outcome: "reconciled",
    runId: reservation.runId,
    scope,
  },
  client,
);
assert.equal(completed.reconciledPaidMicros, "50000");
assert.equal(completed.state, "reconciled");
assert.deepEqual(
  await reconcileWorkspaceRunBudget(
    {
      actualInputTokens: 350,
      actualOutputTokens: 150,
      actualPaidCost: "0.050000",
      now: new Date("2026-08-14T17:02:00.000Z"),
      outcome: "reconciled",
      runId: reservation.runId,
      scope,
    },
    client,
  ),
  completed,
);
await assert.rejects(
  reconcileWorkspaceRunBudget(
    {
      actualPaidCost: "0.06",
      outcome: "reconciled",
      runId: reservation.runId,
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError &&
    error.code === "budget_reservation_conflict",
);

const unknown = await reserveWorkspaceRunBudget(
  {
    inputTokens: 100,
    now,
    outputTokens: 50,
    paidCostCeiling: { kind: "unknown" },
    policy,
    policyRevision: 1,
    runId: "run_uncertain",
    scope,
  },
  client,
);
assert.equal(unknown.paidMicros, "750000");
const uncertain = await reconcileWorkspaceRunBudget(
  {
    outcome: "uncertain",
    runId: unknown.runId,
    scope,
  },
  client,
);
assert.equal(uncertain.state, "uncertain");
assert.equal(uncertain.reconciledPaidMicros, null);
await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 10,
      now,
      outputTokens: 10,
      paidCostCeiling: { amount: "0.21", kind: "known" },
      policy,
      policyRevision: 1,
      runId: "run_paid_blocked",
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
);
const finalReservation = await reserveWorkspaceRunBudget(
  {
    inputTokens: 10,
    now,
    outputTokens: 10,
    paidCostCeiling: { amount: "0.20", kind: "known" },
    policy,
    policyRevision: 1,
    runId: "run_paid_boundary",
    scope,
  },
  client,
);
assert.equal(finalReservation.paidMicros, "200000");
await reconcileWorkspaceRunBudget(
  { outcome: "released", runId: finalReservation.runId, scope },
  client,
);
const resolvedUncertain = await reconcileWorkspaceRunBudget(
  {
    actualInputTokens: 90,
    actualOutputTokens: 40,
    actualPaidCost: "0.70",
    outcome: "reconciled",
    runId: unknown.runId,
    scope,
  },
  client,
);
assert.equal(resolvedUncertain.state, "reconciled");
assert.equal(resolvedUncertain.reconciledPaidMicros, "700000");
await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 561,
      now,
      outputTokens: 1,
      policy,
      policyRevision: 1,
      runId: "run_daily_tokens_blocked",
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
);

await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 10,
      now,
      outputTokens: 10,
      policy,
      policyRevision: 0,
      runId: "run_stale_policy",
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError && error.code === "budget_policy_stale",
);

const nullablePolicy = {
  ...policy,
  maximumPaidPerCall: null,
  maximumPaidPerDay: null,
  maximumPaidPerMonth: null,
};
const inheritClient = new MemoryStore();
await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 1,
      now,
      outputTokens: 1,
      paidCostCeiling: { amount: "0.50", kind: "known" },
      policy: nullablePolicy,
      policyRevision: 1,
      runId: "run_unresolved_cap",
      scope,
    },
    inheritClient,
  ),
  (error) =>
    error instanceof WorkspaceBudgetError &&
    error.code === "budget_policy_unresolved",
);
await reserveWorkspaceRunBudget(
  {
    deploymentPaidCaps: {
      maximumPaidPerCall: "1.00",
      maximumPaidPerDay: "2.00",
      maximumPaidPerMonth: "10.00",
    },
    inputTokens: 1,
    now,
    outputTokens: 1,
    paidCostCeiling: { amount: "0.50", kind: "known" },
    policy: nullablePolicy,
    policyRevision: 1,
    runId: "run_inherited_cap",
    scope,
  },
  inheritClient,
);

const raceClient = new MemoryStore();
const race = await Promise.allSettled(
  ["run_race_a", "run_race_b"].map((runId) =>
    reserveWorkspaceRunBudget(
      {
        inputTokens: 100,
        now,
        outputTokens: 50,
        policy,
        policyRevision: 1,
        runId,
        scope,
      },
      raceClient,
    ),
  ),
);
assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(race.filter((result) => result.status === "rejected").length, 1);

const ledger = await readWorkspaceBudgetLedger(scope, client);
assert.equal(ledger.schemaVersion, 1);
assert.equal(ledger.reservations.length, 3);
assert.equal(ledger.reservations.find((item) => item.runId === "run_uncertain")?.state, "reconciled");
assert.deepEqual(summarizeWorkspaceBudgetUsage(ledger, now, policy.ownerTimezone), {
  activeWorkers: 0,
  calendarDay: "2026-08-14",
  calendarMonth: "2026-08",
  inputTokensToday: 440,
  outputTokensToday: 190,
  paidMicrosThisMonth: "750000",
  paidMicrosToday: "750000",
  runsToday: 2,
});

const deniedClient = new MemoryStore();
await assert.rejects(
  readWorkspaceBudgetLedger(
    { ownerId: scope.ownerId, workspaceId: scope.workspaceId },
    deniedClient,
  ),
  /authoritative owner and workspace scope/u,
);
assert.equal(deniedClient.getCalls, 0);

console.log("Atomic workspace budget ledger verification passed.");
