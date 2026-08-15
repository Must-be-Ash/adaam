import assert from "node:assert/strict";
import { createJiti } from "jiti";

import {
  parseWorkspaceRuntimeObservation,
  WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES,
  WORKSPACE_RUNTIME_COUNTERS,
  WORKSPACE_RUNTIME_ERROR_CODES,
} from "../agent/lib/workspace-runtime-observability.ts";

const jiti = createJiti(import.meta.url);
const { createEventTriggerSchedule } = await jiti.import(
  "../agent/schedules/event-triggers.ts",
);

assert.equal(new Set(WORKSPACE_RUNTIME_ERROR_CODES).size, 31);
assert.equal(new Set(WORKSPACE_RUNTIME_COUNTERS).size, 13);
assert.equal(new Set(WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES).size, 4);

for (const value of [
  ...WORKSPACE_RUNTIME_ERROR_CODES,
  ...WORKSPACE_RUNTIME_COUNTERS,
  ...WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES,
]) {
  assert.match(value, /^[a-z][a-z0-9_]*$/u);
  assert.equal(value.startsWith("$eve"), false);
}

for (const counter of WORKSPACE_RUNTIME_COUNTERS) {
  const observation = parseWorkspaceRuntimeObservation({
    counter,
    ...(counter === "workspace_routing_confirmation_total"
      ? { outcome: "candidate_selected" }
      : {}),
  });
  assert.equal(observation.counter, counter);
  assert.equal(observation.value, 1);
}

assert.deepEqual(
  parseWorkspaceRuntimeObservation({
    counter: "workspace_monitor_retryable_failure_total",
    errorCode: "source_payload_invalid",
    value: 2,
  }),
  {
    counter: "workspace_monitor_retryable_failure_total",
    errorCode: "source_payload_invalid",
    value: 2,
  },
);

for (const invalid of [
  {
    counter: "workspace_monitor_started_total",
    ownerId: "owner_fixture",
  },
  {
    counter: "workspace_monitor_started_total",
    workspaceId: "workspace_fixture",
  },
  {
    counter: "workspace_monitor_started_total",
    sourceUrl: "https://www.sec.gov/fixture",
  },
  {
    counter: "workspace_monitor_started_total",
    observedAt: "2026-08-14T16:00:00.000Z",
  },
  {
    counter: "workspace_monitor_retryable_failure_total",
    errorCode: "provider said the complete private payload was invalid",
  },
  {
    counter: "workspace_routing_confirmation_total",
  },
  {
    counter: "workspace_monitor_completed_total",
    outcome: "candidate_selected",
  },
  {
    counter: "workspace_monitor_completed_total",
    value: 0,
  },
]) {
  assert.throws(() => parseWorkspaceRuntimeObservation(invalid));
}

const privateSentinels = [
  "owner_private_fixture",
  "workspace_private_fixture",
  "monitor_private_fixture",
  "conversation_private_fixture",
  "alert_private_fixture",
  "message_private_fixture",
  "prompt_private_fixture",
  "configuration_private_fixture",
  "provider_private_fixture",
  "credential_private_fixture",
  "https://private.example/source?credential=credential_private_fixture",
  "arbitrary exception text that must not be logged",
];
const now = new Date("2026-08-15T19:00:00.000Z");
const claimedJob = {
  leaseToken: "credential_private_fixture",
  monitor: {
    configurationRevision: 1,
    monitorId: "monitor_private_fixture",
    workspaceId: "workspace_private_fixture",
  },
  occurrence: { attempt: 1 },
  scope: {
    ownerId: "owner_private_fixture",
    workspaceId: "workspace_private_fixture",
  },
};
const runtimeFlags = {
  dispatch: true,
  legacyTriggerCreation: false,
  monitorWrites: true,
  paidResearch: false,
  photonAlerts: false,
  sourceEvents: false,
  state: true,
};

async function runProductionSchedule(overrides) {
  const observations = [];
  const schedule = createEventTriggerSchedule({
    claimEventTriggers: async () => [],
    claimWorkspaceMonitors: async () => [claimedJob],
    emitRuntimeObservation: (observation) => observations.push(observation),
    now: () => now,
    releaseWorkspaceLease: async () => true,
    resolveRuntimeFlags: () => runtimeFlags,
    ...overrides,
  });
  assert.ok("run" in schedule && schedule.run);
  const waiters = [];
  schedule.run({
    appAuth: {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    to() {
      throw new Error("legacy schedule delivery was not expected");
    },
    waitUntil(task) {
      waiters.push(task);
    },
  });
  assert.equal(waiters.length, 1);
  const settled = await Promise.allSettled(waiters);
  return { observations, settled };
}

function assertPrivateValuesAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const sentinel of privateSentinels) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
}

const admissionFailure = await runProductionSchedule({
  reserveWorkspaceBudget: async () => {
    const error = new Error(privateSentinels.at(-1));
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("provider_private_fixture");
      },
    });
    error.payload = {
      alert: "alert_private_fixture",
      configuration: "configuration_private_fixture",
      message: "message_private_fixture",
      prompt: "prompt_private_fixture",
      sourceUrl:
        "https://private.example/source?credential=credential_private_fixture",
    };
    throw error;
  },
});
assert.deepEqual(admissionFailure.settled.map(({ status }) => status), [
  "fulfilled",
]);
assert.deepEqual(admissionFailure.observations, [
  { counter: "workspace_monitor_claimed_total", value: 1 },
  {
    counter: "workspace_monitor_retryable_failure_total",
    errorCode: "storage_unavailable",
    value: 1,
  },
]);
assertPrivateValuesAbsent(admissionFailure);

const budgetDeferred = await runProductionSchedule({
  reserveWorkspaceBudget: async () => {
    throw Object.assign(new Error("global_budget_exhausted"), {
      code: "global_budget_exhausted",
    });
  },
});
assert.deepEqual(budgetDeferred.observations, [
  { counter: "workspace_monitor_claimed_total", value: 1 },
  {
    counter: "workspace_monitor_budget_deferred_total",
    errorCode: "run_budget_exhausted",
    value: 1,
  },
]);

const completedNoMatch = await runProductionSchedule({
  finishWorkspaceBudget: async () => undefined,
  prepareWorkspaceWorker: async () => ({ request: {} }),
  requireWorkspaceOutcome: async () => ({ outcome: "no_match" }),
  reserveWorkspaceBudget: async () => ({
    global: { state: "reserved" },
    runId: "run_private_fixture",
    workspace: { state: "reserved" },
  }),
  startWorkspaceWorker: async () => ({
    events: (async function* () {})(),
  }),
});
assert.deepEqual(completedNoMatch.observations, [
  { counter: "workspace_monitor_claimed_total", value: 1 },
  { counter: "workspace_monitor_started_total", value: 1 },
  { counter: "workspace_monitor_completed_total", value: 1 },
  { counter: "workspace_monitor_no_match_total", value: 1 },
]);
assertPrivateValuesAbsent(completedNoMatch);

const workerFailure = await runProductionSchedule({
  finishWorkspaceBudget: async () => undefined,
  prepareWorkspaceWorker: async () => ({ request: {} }),
  recordWorkspaceFailure: async () => undefined,
  reserveWorkspaceBudget: async () => ({
    global: { state: "reserved" },
    runId: "run_private_fixture",
    workspace: { state: "reserved" },
  }),
  startWorkspaceWorker: async () => ({
    events: (async function* () {
      yield {
        data: { error: "provider_private_fixture" },
        type: "session.failed",
      };
    })(),
  }),
});
assert.deepEqual(workerFailure.observations, [
  { counter: "workspace_monitor_claimed_total", value: 1 },
  { counter: "workspace_monitor_started_total", value: 1 },
  {
    counter: "workspace_monitor_terminal_failure_total",
    errorCode: "evaluation_failed",
    value: 1,
  },
]);
assertPrivateValuesAbsent(workerFailure);

const claimFailure = await runProductionSchedule({
  claimWorkspaceMonitors: async () => {
    throw new Error(privateSentinels.at(-1));
  },
});
assert.deepEqual(claimFailure.observations, [
  {
    counter: "workspace_monitor_retryable_failure_total",
    errorCode: "storage_unavailable",
    value: 1,
  },
]);
assert.equal(claimFailure.settled[0]?.status, "rejected");
const claimError = claimFailure.settled[0]?.reason;
assert.ok(claimError instanceof AggregateError);
assert.equal(claimError.message, "schedule_job_failed");
assert.ok(claimError.errors.length > 0);
for (const error of claimError.errors) {
  assert.ok(error instanceof Error);
  assert.ok(WORKSPACE_RUNTIME_ERROR_CODES.includes(error.message));
}
assertPrivateValuesAbsent({
  errors: claimError.errors.map((error) => error.message),
  message: claimError.message,
  observations: claimFailure.observations,
});

console.log("Workspace runtime observability contract passed.");
