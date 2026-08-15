import assert from "node:assert/strict";

import {
  parseWorkspaceRuntimeObservation,
  WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES,
  WORKSPACE_RUNTIME_COUNTERS,
  WORKSPACE_RUNTIME_ERROR_CODES,
} from "../agent/lib/workspace-runtime-observability.ts";

assert.equal(new Set(WORKSPACE_RUNTIME_ERROR_CODES).size, 30);
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

console.log("Workspace runtime observability contract passed.");
