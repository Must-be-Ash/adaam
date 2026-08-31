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

// Per-run reservations are soft dispatch envelopes: once a bounded child call
// starts below the envelope, its actual usage may finish slightly above it.
// The true usage must be recorded so hard day/month limits stop later work.
const softClient = new MemoryStore();
const softParent = await reserveWorkspaceRunBudget({
  inputTokens: 100,
  kind: "scheduled_monitor",
  now,
  outputTokens: 50,
  paidCostCeiling: { amount: "0.10", kind: "known" },
  policy,
  policyRevision: 1,
  runId: "soft-parent",
  scope,
}, softClient);
const softChildOne = await reserveWorkspaceRunBudget({
  inputTokens: 400,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 200,
  paidCostCeiling: { amount: "0.40", kind: "known" },
  parentRunId: softParent.runId,
  policy,
  policyRevision: 1,
  runId: "soft-child-one",
  scope,
}, softClient);
await reconcileWorkspaceRunBudget({
  actualInputTokens: 350,
  actualOutputTokens: 150,
  actualPaidCost: "0.30",
  outcome: "reconciled",
  runId: softChildOne.runId,
  scope,
}, softClient);
const softChildTwo = await reserveWorkspaceRunBudget({
  inputTokens: 200,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 100,
  paidCostCeiling: { amount: "0.40", kind: "known" },
  parentRunId: softParent.runId,
  policy,
  policyRevision: 1,
  runId: "soft-child-two",
  scope,
}, softClient);
await reconcileWorkspaceRunBudget({
  actualInputTokens: 200,
  actualOutputTokens: 100,
  actualPaidCost: "0.30",
  outcome: "reconciled",
  runId: softChildTwo.runId,
  scope,
}, softClient);
const softChildAfterEnvelope = await reserveWorkspaceRunBudget({
  inputTokens: 1,
  kind: "hybrid_model_attempt",
  now,
  outputTokens: 1,
  paidCostCeiling: { amount: "0.10", kind: "known" },
  parentRunId: softParent.runId,
  policy,
  policyRevision: 1,
  runId: "soft-child-after-envelope",
  scope,
}, softClient);
await reconcileWorkspaceRunBudget({
  actualInputTokens: 1,
  actualOutputTokens: 1,
  actualPaidCost: "0.01",
  outcome: "reconciled",
  runId: softChildAfterEnvelope.runId,
  scope,
}, softClient);
const softCompleted = await reconcileWorkspaceRunBudget({
  actualInputTokens: 551,
  actualOutputTokens: 251,
  actualPaidCost: "0.61",
  outcome: "reconciled",
  runId: softParent.runId,
  scope,
}, softClient);
assert.equal(softCompleted.reconciledPaidMicros, "610000");
await assert.rejects(
  reserveWorkspaceRunBudget({
    inputTokens: 1,
    kind: "scheduled_monitor",
    now,
    outputTokens: 1,
    paidCostCeiling: { amount: "0.50", kind: "known" },
    policy,
    policyRevision: 1,
    runId: "hard-daily-limit-still-blocks",
    scope,
  }, softClient),
  (error) => error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
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

// Every active parent's child overrun must be visible to other admissions,
// including new top-level runs, before the parent itself is reconciled.
for (const limit of ["input", "output", "paid-day", "paid-month"] as const) {
  for (const admission of ["child", "top-level"] as const) {
    const interleavedClient = new MemoryStore();
    const interleavedPolicy = {
      ...policy,
      maximumConcurrentWorkers: 3,
      maximumInputTokensPerRun: 1_000,
      maximumInputTokensPerDay: 1_000,
      maximumOutputTokensPerRun: 1_000,
      maximumOutputTokensPerDay: 1_000,
      maximumPaidPerCall: "10",
      maximumPaidPerDay: limit === "paid-day" ? "10" : "20",
      maximumPaidPerMonth: limit === "paid-month" ? "10" : "20",
    };
    const paidLimit = limit.startsWith("paid");
    const reserve = (runId: string, amount: number, parentRunId?: string) => reserveWorkspaceRunBudget({
      inputTokens: limit === "input" ? amount : 0,
      outputTokens: limit === "output" ? amount : 0,
      paidCostCeiling: { amount: paidLimit ? String(amount / 100) : "0", kind: "known" },
      kind: parentRunId ? "hybrid_model_attempt" : "scheduled_monitor",
      parentRunId,
      now,
      policy: interleavedPolicy,
      policyRevision: 1,
      runId,
      scope,
    }, interleavedClient);
    await reserve("parent-a", 200);
    await reserve("parent-b", 200);
    await reserve("child-a", 700, "parent-a");
    await assert.rejects(reserve("over-hard-cap", 700, admission === "child" ? "parent-b" : undefined),
      (error) => error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
      `${limit}: ${admission} must see another parent's overrun`);
    const before = await readWorkspaceBudgetLedger(scope, interleavedClient);
    const usage = summarizeWorkspaceBudgetUsage(before, now, policy.ownerTimezone);
    assert.equal(usage.inputTokensToday, limit === "input" ? 900 : 0);
    assert.equal(usage.outputTokensToday, limit === "output" ? 900 : 0);
    assert.equal(usage.paidMicrosToday, paidLimit ? "9000000" : "0");
    assert.equal(usage.paidMicrosThisMonth, paidLimit ? "9000000" : "0");
    // Soft envelopes still permit the exact hard boundary, and a failed CAS
    // admission must not have left a reservation behind.
    assert.equal(before.reservations.length, 3);
    await reserve("at-hard-cap", admission === "child" ? 300 : 100,
      admission === "child" ? "parent-b" : undefined);
    const boundary = summarizeWorkspaceBudgetUsage(await readWorkspaceBudgetLedger(scope, interleavedClient), now, policy.ownerTimezone);
    assert.equal(boundary.inputTokensToday, limit === "input" ? 1_000 : 0);
    assert.equal(boundary.outputTokensToday, limit === "output" ? 1_000 : 0);
    assert.equal(boundary.paidMicrosToday, paidLimit ? "10000000" : "0");
    assert.equal(boundary.paidMicrosThisMonth, paidLimit ? "10000000" : "0");
  }
}

// Periods belong to each reservation, not to its parent's creation date.
// Retained/legacy children must remain charged even if their parent is no
// longer present or has been released. These seeded records also exercise
// accounting after old parent records have been pruned.
const softLedger = await readWorkspaceBudgetLedger(scope, softClient);
for (const parentState of ["reserved", "reconciled", "released", "missing", "previous-day", "previous-month"] as const) {
  const family = {
    ...softLedger,
    reservations: softLedger.reservations.filter(({ runId }) => runId === softParent.runId || runId === softChildOne.runId)
      .filter(({ runId }) => parentState !== "missing" || runId !== softParent.runId)
      .map((entry) => entry.runId !== softParent.runId ? entry : {
        ...entry,
        state: parentState === "released" ? "released" as const : parentState === "reconciled" ? "reconciled" as const : "reserved" as const,
        inputTokens: 100,
        outputTokens: 50,
        paidMicros: "100000",
        reconciledInputTokens: parentState === "reconciled" ? 350 : null,
        reconciledOutputTokens: parentState === "reconciled" ? 150 : null,
        reconciledPaidMicros: parentState === "reconciled" ? "300000" : null,
        calendarDay: parentState === "previous-month" ? "2026-07-31" : parentState === "previous-day" ? "2026-08-13" : entry.calendarDay,
        calendarMonth: parentState === "previous-month" ? "2026-07" : entry.calendarMonth,
      }),
  };
  const familyUsage = summarizeWorkspaceBudgetUsage(family, now, policy.ownerTimezone);
  assert.equal(familyUsage.inputTokensToday, 350, `${parentState}: retained child input`);
  assert.equal(familyUsage.outputTokensToday, 150, `${parentState}: retained child output`);
  assert.equal(familyUsage.paidMicrosToday, "300000", `${parentState}: retained child paid/day`);
  assert.equal(familyUsage.paidMicrosThisMonth, "300000", `${parentState}: retained child paid/month`);
  for (const hardLimit of ["input", "output", "paid-day", "paid-month"] as const) {
    const familyClient = new MemoryStore();
    familyClient.values.set([...softClient.values.keys()][0]!, JSON.stringify(family));
    await assert.rejects(reserveWorkspaceRunBudget({
      inputTokens: hardLimit === "input" ? 1 : 0,
      outputTokens: hardLimit === "output" ? 1 : 0,
      paidCostCeiling: { amount: hardLimit.startsWith("paid") ? "0.01" : "0", kind: "known" },
      kind: "scheduled_monitor", now, policyRevision: 1, runId: "retained-child-blocks", scope,
      policy: { ...policy, maximumConcurrentWorkers: 2,
        maximumInputTokensPerRun: 350, maximumInputTokensPerDay: 350,
        maximumOutputTokensPerRun: 150, maximumOutputTokensPerDay: 150,
        maximumPaidPerDay: hardLimit === "paid-day" ? "0.30" : "1",
        maximumPaidPerMonth: hardLimit === "paid-month" ? "0.30" : "2" },
    }, familyClient), (error) => error instanceof WorkspaceBudgetError && error.code === "budget_exhausted",
    `${parentState}: ${hardLimit} admission must agree with summary`);
  }
}

console.log("Atomic workspace budget ledger verification passed.");
