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
  const toolCalls = [];
  const ownersByAliasDigest = new Map([
    [digest("photon_fixture_alias"), "owner_fixture"],
  ]);

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
    snapshot() {
      return structuredClone({
        assignments: [...assignments.values()],
        eveDispatches,
        events,
        photonDeliveries,
        toolCalls,
      });
    },
  });
}
