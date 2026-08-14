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

const routingHarness = createWorkspacePhotonHarness({
  async handleWebhook(event, ports) {
    const ownerId = ports.auth.resolveOwner(event.alias);
    const ingress = ports.state.createIngress(event);
    if (!ingress.created) return { duplicate: true };
    if (event.action === "select") {
      return ports.state.selectWorkspace({
        expectedRevision: event.expectedRevision,
        workspaceId: event.workspaceId,
      });
    }
    if (event.action === "start_fresh") {
      return ports.state.startFresh({
        expectedRevision: event.expectedRevision,
        workspaceId: event.workspaceId,
      });
    }
    const routing = ports.state.routing();
    const workspace = routing.workspaces[routing.selectedWorkspaceId];
    ports.state.persistAssignment({
      generation: workspace.generation,
      ingressId: ingress.receipt.ingressId,
      ownerId,
      workspaceId: routing.selectedWorkspaceId,
    });
    return ports.eve.dispatch({
      generation: workspace.generation,
      ingressId: ingress.receipt.ingressId,
      ownerId,
      workspaceId: routing.selectedWorkspaceId,
    });
  },
});

await routingHarness.receive({ alias: "photon_fixture_alias", eventId: "route_main", text: "hello" });
await routingHarness.receive({
  action: "select",
  alias: "photon_fixture_alias",
  eventId: "select_ipo",
  expectedRevision: 0,
  workspaceId: "workspace_ipo",
});
await assert.rejects(() => routingHarness.receive({
  action: "select",
  alias: "photon_fixture_alias",
  eventId: "stale_select",
  expectedRevision: 0,
  workspaceId: "workspace_main",
}), /fixture_stale_action/u);
await routingHarness.receive({
  action: "start_fresh",
  alias: "photon_fixture_alias",
  eventId: "fresh_ipo",
  expectedRevision: 1,
  workspaceId: "workspace_ipo",
});
const [firstDuplicate, secondDuplicate] = await Promise.all([
  routingHarness.receive({ alias: "photon_fixture_alias", eventId: "route_once", text: "once" }),
  routingHarness.receive({ alias: "photon_fixture_alias", eventId: "route_once", text: "duplicate" }),
]);
assert.equal([firstDuplicate, secondDuplicate].filter((result) => result.duplicate).length, 1);
const alert = await routingHarness.deliverAlert({
  alertId: "alert_fixture",
  destinationId: "conversation_fixture",
  workspaceId: "workspace_main",
});
assert.equal(alert.duplicate, false);
assert.equal((await routingHarness.deliverAlert({
  alertId: "alert_fixture",
  destinationId: "conversation_fixture",
  workspaceId: "workspace_main",
})).duplicate, true);
assert.equal(routingHarness.snapshot().routing.selectedWorkspaceId, "workspace_ipo");
await assert.rejects(() => routingHarness.deliverAlert({
  alertId: "alert_uncertain",
  destinationId: "conversation_fixture",
  uncertain: true,
  workspaceId: "workspace_main",
}), /fixture_alert_delivery_uncertain/u);
await assert.rejects(() => routingHarness.deliverAlert({
  alertId: "alert_uncertain",
  destinationId: "conversation_fixture",
  workspaceId: "workspace_main",
}), /fixture_uncertain_replay_denied/u);
await routingHarness.receive({
  action: "select",
  alias: "photon_fixture_alias",
  eventId: "discuss_main",
  expectedRevision: 2,
  workspaceId: "workspace_main",
});
await routingHarness.receive({ alias: "photon_fixture_alias", eventId: "discuss_message", text: "discuss it" });
await assert.rejects(() => routingHarness.receive({
  alias: "photon_unknown_alias",
  eventId: "owner_denied",
  text: "must fail",
}), /fixture_owner_denied/u);
const routingSnapshot = routingHarness.snapshot();
assert.equal(routingSnapshot.routing.selectedWorkspaceId, "workspace_main");
assert.equal(routingSnapshot.routing.workspaces.workspace_ipo.generation, 2);
assert.deepEqual(
  routingSnapshot.eveDispatches.map((entry) => [entry.workspaceId, entry.generation]),
  [
    ["workspace_main", 1],
    ["workspace_ipo", 2],
    ["workspace_main", 1],
  ],
);

console.log("Fixture-backed Photon integration harness passed.");
