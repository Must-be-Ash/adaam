import { createHash } from "node:crypto";

export const FIXTURE_RUNTIME_ALLOWED_TOOLS = Object.freeze([
  "fetch_public_source",
  "write_workspace_finding",
  "complete_workspace_run",
]);

export const LIVE_FINANCIAL_MUTATION_TOOLS = Object.freeze([
  "coinbase_create_order",
  "coinbase_orders_edit",
  "coinbase_orders_cancel",
  "coinbase_convert_execute",
  "coinbase_transfer",
  "coinbase_portfolios_create",
  "coinbase_portfolios_edit",
  "coinbase_portfolios_delete",
]);

export class FixtureToolUnavailableError extends Error {
  constructor(toolName) {
    super(`Tool ${toolName} is unavailable in the Photon integration fixture.`);
    this.code = "fixture_tool_unavailable";
    this.name = "FixtureToolUnavailableError";
    this.toolName = toolName;
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createWorkspacePhotonHarness({ handleWebhook }) {
  if (typeof handleWebhook !== "function") {
    throw new TypeError("A fixture webhook handler is required.");
  }

  const events = [];
  const ingressByEvent = new Map();
  const assignments = new Map();
  const eveDispatches = [];
  const photonDeliveries = [];
  const alertDeliveries = new Map();
  const toolCalls = [];
  const ownersByAliasDigest = new Map([
    [digest("photon_fixture_alias"), "owner_fixture"],
  ]);
  const routing = {
    revision: 0,
    selectedWorkspaceId: "workspace_main",
    workspaces: new Map([
      ["workspace_main", { generation: 1, name: "Main", status: "active" }],
      ["workspace_ipo", { generation: 1, name: "IPO Filings", status: "active" }],
    ]),
  };

  const ports = Object.freeze({
    auth: Object.freeze({
      resolveOwner(alias) {
        const ownerId = ownersByAliasDigest.get(digest(alias));
        if (!ownerId) throw new Error("fixture_owner_denied");
        return ownerId;
      },
    }),
    state: Object.freeze({
      createIngress(event) {
        const eventDigest = digest(event.eventId);
        const existing = ingressByEvent.get(eventDigest);
        if (existing) return { created: false, receipt: existing };
        const receipt = Object.freeze({
          ingressId: `ingress_${eventDigest.slice(0, 16)}`,
          eventDigest,
          state: "received",
        });
        ingressByEvent.set(eventDigest, receipt);
        events.push({ type: "ingress.created", ingressId: receipt.ingressId });
        return { created: true, receipt };
      },
      persistAssignment(input) {
        const existing = assignments.get(input.ingressId);
        if (existing) {
          if (
            existing.workspaceId !== input.workspaceId ||
            existing.generation !== input.generation
          ) throw new Error("fixture_assignment_immutable");
          return existing;
        }
        const assignment = Object.freeze({ ...input });
        assignments.set(input.ingressId, assignment);
        events.push({ type: "assignment.persisted", ingressId: input.ingressId });
        return assignment;
      },
      routing() {
        return structuredClone({
          revision: routing.revision,
          selectedWorkspaceId: routing.selectedWorkspaceId,
          workspaces: Object.fromEntries(routing.workspaces),
        });
      },
      selectWorkspace({ expectedRevision, workspaceId }) {
        if (expectedRevision !== routing.revision) throw new Error("fixture_stale_action");
        const workspace = routing.workspaces.get(workspaceId);
        if (!workspace || workspace.status !== "active") throw new Error("fixture_workspace_unavailable");
        routing.selectedWorkspaceId = workspaceId;
        routing.revision += 1;
        events.push({ type: "workspace.selected", workspaceId });
        return this.routing();
      },
      startFresh({ expectedRevision, workspaceId }) {
        if (expectedRevision !== routing.revision) throw new Error("fixture_stale_action");
        const workspace = routing.workspaces.get(workspaceId);
        if (!workspace || workspace.status !== "active") throw new Error("fixture_workspace_unavailable");
        workspace.generation += 1;
        routing.revision += 1;
        events.push({ type: "workspace.started_fresh", workspaceId });
        return this.routing();
      },
    }),
    eve: Object.freeze({
      async dispatch(input) {
        if (!assignments.has(input.ingressId)) {
          throw new Error("fixture_assignment_required");
        }
        eveDispatches.push(structuredClone(input));
        events.push({ type: "eve.dispatched", ingressId: input.ingressId });
        return Object.freeze({
          responseId: `response_${input.ingressId}`,
          text: "Fixture Eve response",
        });
      },
    }),
    photon: Object.freeze({
      async deliver(input) {
        photonDeliveries.push(structuredClone(input));
        events.push({ type: "photon.delivered", ingressId: input.ingressId });
        return Object.freeze({ deliveryId: `delivery_${input.ingressId}` });
      },
      async deliverAlert(input) {
        const deliveryKey = `${input.alertId}\0${input.destinationId}`;
        const existing = alertDeliveries.get(deliveryKey);
        if (existing) {
          if (existing.state === "delivery_uncertain") throw new Error("fixture_uncertain_replay_denied");
          return { duplicate: true, ...existing };
        }
        const delivery = Object.freeze({
          alertId: input.alertId,
          destinationId: input.destinationId,
          state: input.uncertain ? "delivery_uncertain" : "delivered",
          workspaceId: input.workspaceId,
        });
        alertDeliveries.set(deliveryKey, delivery);
        events.push({ type: input.uncertain ? "alert.uncertain" : "alert.delivered", alertId: input.alertId });
        if (input.uncertain) throw new Error("fixture_alert_delivery_uncertain");
        return { duplicate: false, ...delivery };
      },
    }),
    tools: Object.freeze({
      async invoke(toolName, input) {
        if (!FIXTURE_RUNTIME_ALLOWED_TOOLS.includes(toolName)) {
          throw new FixtureToolUnavailableError(toolName);
        }
        toolCalls.push({ input: structuredClone(input), toolName });
        return Object.freeze({ fixture: true, ok: true, toolName });
      },
    }),
  });

  return Object.freeze({
    async receive(event) {
      return await handleWebhook(structuredClone(event), ports);
    },
    async deliverAlert(input) {
      return ports.photon.deliverAlert(structuredClone(input));
    },
    snapshot() {
      return structuredClone({
        assignments: [...assignments.values()],
        alertDeliveries: [...alertDeliveries.values()],
        eveDispatches,
        events,
        photonDeliveries,
        toolCalls,
        routing: ports.state.routing(),
      });
    },
  });
}
