import assert from "node:assert/strict";

import {
  coinbaseApproval,
  coinbaseInteractiveCapabilityIds,
  requireCoinbaseAccess,
} from "../agent/lib/coinbase-access";
import {
  coinbaseInteractiveApproval,
  InteractiveToolCapabilityDeniedError,
  requireInteractiveToolCapabilities,
} from "../agent/lib/interactive-tool-capabilities";
import { photonAuth } from "../agent/lib/photon-auth";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceCapabilityManifestValue,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { projectPhotonWorkspaceRuntimeScope } from "../agent/lib/workspace-runtime-scope";

class MemoryStore {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const now = new Date("2026-08-17T18:00:00.000Z");
const ownerId = "owner_fixture";
const principalId = "imessage:fixture-owner";
const threadId = "imessage:fixture-thread";
const environment = {
  COINBASE_ALLOWED_PRINCIPALS: principalId,
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: principalId,
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
const memory = new MemoryStore();
process.env.COINBASE_ALLOWED_PRINCIPALS = principalId;

function context(workspaceId: string) {
  const scope = projectPhotonWorkspaceRuntimeScope({
    generation: 1,
    principalId,
    threadId,
    workspaceId,
  }, environment);
  return {
    session: {
      auth: { current: photonAuth("fixture-owner", threadId, scope) },
    },
  };
}

const earningsWorkspaceId = "123e4567-e89b-42d3-a456-426614174000";
const earningsScope = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId: earningsWorkspaceId },
  environment,
);
const earningsPack = strategyPackCatalog.resolve({
  id: "earnings-call-changes",
  version: "1.0.0",
});
assert.ok(earningsPack);
const earningsConfiguration = Object.fromEntries(
  earningsPack.configuration.map((field) => [
    field.key,
    Array.isArray(field.default) ? [...field.default] : field.default,
  ]),
);
const earningsCapabilities: WorkspaceCapabilityManifestValue = {
  connectionIds: [],
  controlPlaneToolIds: [],
  financialToolIds: [],
  hardDeniedCapabilityIds: [
    ...new Set([
      "financial.mutation",
      "provider.mutation",
      ...earningsPack.capabilities.hardDenied,
    ]),
  ].sort(),
  maximumDataAccessClassification: "public",
  paidResearchAllowed: false,
  providerTools: [],
  researchToolIds: earningsPack.capabilities.required
    .filter((id) => !id.startsWith("skill."))
    .sort(),
  skills: earningsPack.skills.map(({ id, version }) => ({ id, version })),
  sources: resolveParameterizedStrategyPackSources(
    earningsPack,
    earningsConfiguration,
  ).map((source) => ({
    allowedOrigins: [...source.allowedOrigins],
    contractDigest: source.contractDigest,
    contractVersion: source.contractVersion,
    origin: new URL(source.canonicalUrl).origin,
    sourceId: source.sourceId,
  })),
  workerModelPolicy: {
    allowedModelIds: ["google/gemini-3.6-flash"],
    maximumOutputTokens: 4_000,
  },
};
const snapshot = {
  bindingRevision: 1,
  capabilityManifestRevision: 1,
  packContentDigest: earningsPack.contentDigest,
  packId: earningsPack.id,
  packVersion: earningsPack.version,
  workspaceGeneration: 1,
};
for (const prepared of [
  prepareInitialWorkspaceDocument("capabilities", {
    now,
    scope: earningsScope,
    value: earningsCapabilities,
  }),
  prepareInitialWorkspaceStrategyBinding({
    now,
    scope: earningsScope,
    value: {
      bindingRevision: 1,
      configuration: earningsConfiguration,
      effectiveCapabilityManifestRevision: 1,
      health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
      lastActiveSnapshot: snapshot,
      lifecycleState: "active",
      managedResources: {},
      ownerOverrides: {},
      pack: {
        contentDigest: earningsPack.contentDigest,
        id: earningsPack.id,
        version: earningsPack.version,
      },
      pendingSnapshot: null,
      timestamps: {
        activatedAt: now.toISOString(),
        configuredAt: now.toISOString(),
        generationRolloverAt: now.toISOString(),
        installedAt: now.toISOString(),
      },
    },
  }),
]) {
  memory.values.set(prepared.key, prepared.raw);
}

for (const toolId of [
  "coinbase_preview_order",
  "coinbase_create_order",
  "coinbase_balance",
] as const) {
  await assert.rejects(
    requireInteractiveToolCapabilities({
      capabilityIds: coinbaseInteractiveCapabilityIds(toolId),
      catalog: strategyPackCatalog,
      ctx: context(earningsWorkspaceId),
      environment,
      stateClient: memory,
      toolId,
    }),
    (error: unknown) =>
      error instanceof InteractiveToolCapabilityDeniedError &&
      error.code === "interactive_tool_capability_denied",
    `${toolId} must be denied in the bound earnings workspace`,
  );
}

const approvalContext = {
  ...context(earningsWorkspaceId),
  approvedTools: new Set<string>(),
  callId: "call_fixture_create_order",
  toolInput: {},
  toolName: "coinbase_create_order",
} as never;
const createApproval = await coinbaseInteractiveApproval({
  capabilityIds: coinbaseInteractiveCapabilityIds("coinbase_create_order"),
  catalog: strategyPackCatalog,
  ctx: approvalContext,
  environment,
  requiresUserApproval: true,
  stateClient: memory,
  toolId: "coinbase_create_order",
});
assert.deepEqual(createApproval, {
  reason: "Coinbase is not available in the current strategy session.",
  type: "denied",
});
assert.equal(await coinbaseApproval(approvalContext, true), "user-approval");
await assert.rejects(
  coinbaseInteractiveApproval({
    capabilityIds: coinbaseInteractiveCapabilityIds("coinbase_create_order"),
    catalog: strategyPackCatalog,
    ctx: approvalContext,
    environment,
    requiresUserApproval: true,
    stateClient: {
      compareAndSet: async () => true,
      get: async () => {
        throw new Error("fixture_state_unavailable");
      },
    },
    toolId: "coinbase_create_order",
  }),
  /fixture_state_unavailable/u,
  "unexpected capability-store failures must not be presented as a strategy denial",
);

const controlWorkspaceId = "223e4567-e89b-42d3-a456-426614174000";
const controlScope = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId: controlWorkspaceId },
  environment,
);
const unbound = prepareInitialWorkspaceStrategyBinding({
  now,
  scope: controlScope,
  value: {
    bindingRevision: 1,
    configuration: {},
    effectiveCapabilityManifestRevision: null,
    health: { checkedAt: now.toISOString(), code: null, status: "unbound" },
    lastActiveSnapshot: null,
    lifecycleState: "unbound",
    managedResources: {},
    ownerOverrides: {},
    pack: null,
    pendingSnapshot: null,
    timestamps: {
      activatedAt: null,
      configuredAt: null,
      generationRolloverAt: null,
      installedAt: null,
    },
  },
});
memory.values.set(unbound.key, unbound.raw);
const controlContext = context(controlWorkspaceId);
await requireInteractiveToolCapabilities({
  capabilityIds: ["coinbase_mcp"],
  catalog: strategyPackCatalog,
  ctx: controlContext,
  environment,
  stateClient: memory,
  toolId: "coinbase_balance",
});
assert.deepEqual(
  requireCoinbaseAccess(controlContext as never),
  { channel: "imessage", id: principalId },
  "an unbound workspace must continue through the ordinary Coinbase principal gate",
);

console.log("Interactive strategy-workspace tool capability verification passed.");
