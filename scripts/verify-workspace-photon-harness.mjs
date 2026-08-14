import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createWorkspacePhotonHarness,
  FixtureToolUnavailableError,
  LIVE_FINANCIAL_MUTATION_TOOLS,
} from "./fixtures/workspace-photon-harness.mjs";

let capturedPorts;
const harness = createWorkspacePhotonHarness({
  async handleWebhook(event, ports) {
    capturedPorts = ports;
    const ownerId = ports.auth.resolveOwner(event.alias);
    const ingress = ports.state.createIngress(event);
    if (!ingress.created) return { duplicate: true, ingressId: ingress.receipt.ingressId };
    ports.state.persistAssignment({
      generation: 1,
      ingressId: ingress.receipt.ingressId,
      ownerId,
      workspaceId: "workspace_fixture",
    });
    const response = await ports.eve.dispatch({
      generation: 1,
      ingressId: ingress.receipt.ingressId,
      ownerId,
      workspaceId: "workspace_fixture",
    });
    await ports.photon.deliver({
      ingressId: ingress.receipt.ingressId,
      responseId: response.responseId,
    });
    return { duplicate: false, ingressId: ingress.receipt.ingressId };
  },
});

let networkAttempts = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Fixture harness attempted outbound network access.");
};

try {
  const first = await harness.receive({
    alias: "photon_fixture_alias",
    eventId: "fixture_event_001",
    text: "Check the configured public source.",
  });
  const duplicate = await harness.receive({
    alias: "photon_fixture_alias",
    eventId: "fixture_event_001",
    text: "Duplicate webhook payload is ignored.",
  });
  assert.equal(first.duplicate, false);
  assert.deepEqual(duplicate, { duplicate: true, ingressId: first.ingressId });

  for (const toolName of LIVE_FINANCIAL_MUTATION_TOOLS) {
    await assert.rejects(
      () => capturedPorts.tools.invoke(toolName, {}),
      (error) =>
        error instanceof FixtureToolUnavailableError &&
        error.code === "fixture_tool_unavailable" &&
        error.toolName === toolName,
    );
  }

  assert.equal(Object.hasOwn(capturedPorts, "broker"), false);
  assert.equal(Object.hasOwn(capturedPorts, "network"), false);
  assert.equal(networkAttempts, 0);

  const snapshot = harness.snapshot();
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ["ingress.created", "assignment.persisted", "eve.dispatched", "photon.delivered"],
  );
  assert.equal(snapshot.assignments.length, 1);
  assert.equal(snapshot.eveDispatches.length, 1);
  assert.equal(snapshot.photonDeliveries.length, 1);
  assert.deepEqual(snapshot.toolCalls, []);
} finally {
  globalThis.fetch = originalFetch;
}

const harnessSource = await readFile(
  new URL("./fixtures/workspace-photon-harness.mjs", import.meta.url),
  "utf8",
);
for (const forbiddenImport of [
  "agent/lib/coinbase",
  "agent/tools/coinbase",
  "#coinbase",
  "api.coinbase.com",
]) {
  assert.equal(harnessSource.includes(forbiddenImport), false);
}
assert.equal(/\bfetch\s*\(/u.test(harnessSource), false);
assert.equal(/\bspawn\s*\(/u.test(harnessSource), false);

console.log("Fixture-backed Photon integration harness passed.");
