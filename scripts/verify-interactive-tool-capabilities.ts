import assert from "node:assert/strict";
import { base58 } from "@scure/base";

import {
  coinbaseApproval,
  coinbaseInteractiveCapabilityIds,
  requireCoinbaseAccess,
} from "../agent/lib/coinbase-access";
import {
  agentcashInteractiveCapabilityIds,
  agentcashInteractivePaymentApproval,
  requireAgentcashToolAccess,
} from "../agent/lib/agentcash-access";
import { normalizeAgentcashSolanaPrivateKey } from "../agent/lib/agentcash-wallet";
import {
  coinbaseInteractiveApproval,
  InteractiveToolCapabilityDeniedError,
  requireInteractiveToolCapabilities,
} from "../agent/lib/interactive-tool-capabilities";
import { photonAuth } from "../agent/lib/photon-auth";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import { executeCoinbasePreviewOrder } from "../agent/tools/coinbase_preview_order";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceCapabilityManifestValue,
  workspaceDocumentStorageKey,
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
const solanaPrivateKey = normalizeAgentcashSolanaPrivateKey(
  base58.encode(new Uint8Array(32).fill(11)),
)!;
const environment = {
  AGENTCASH_ALLOWED_PRINCIPALS: principalId,
  AGENTCASH_MAX_PAYMENT_USD: "2.50",
  COINBASE_ALLOWED_PRINCIPALS: principalId,
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: principalId,
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
  X402_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  X402_SOLANA_PRIVATE_KEY: solanaPrivateKey,
};
const memory = new MemoryStore();
process.env.COINBASE_ALLOWED_PRINCIPALS = principalId;
process.env.COINBASE_KEY_ID = "fixture-key-id";
process.env.COINBASE_KEY_SECRET = "fixture-key-secret";
process.env.AGENTCASH_ALLOWED_PRINCIPALS = principalId;
process.env.AGENTCASH_MAX_PAYMENT_USD = environment.AGENTCASH_MAX_PAYMENT_USD;
process.env.X402_PRIVATE_KEY = environment.X402_PRIVATE_KEY;
process.env.X402_SOLANA_PRIVATE_KEY = environment.X402_SOLANA_PRIVATE_KEY;

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
    allowedModelIds: ["zai/glm-5.3-flash"],
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
  "agentcash_fetch",
] as const) {
  await assert.doesNotReject(
    requireInteractiveToolCapabilities({
      capabilityIds: toolId.startsWith("agentcash_")
        ? agentcashInteractiveCapabilityIds(true)
        : coinbaseInteractiveCapabilityIds(toolId),
      catalog: strategyPackCatalog,
      ctx: context(earningsWorkspaceId),
      environment,
      stateClient: memory,
      toolId,
    }),
    `${toolId} must remain available to the owner in a bound strategy workspace`,
  );
}

await assert.rejects(
  requireInteractiveToolCapabilities({
    capabilityIds: ["filesystem.write"],
    catalog: strategyPackCatalog,
    ctx: context(earningsWorkspaceId),
    environment,
    stateClient: memory,
    toolId: "filesystem.write",
  }),
  (error: unknown) =>
    error instanceof InteractiveToolCapabilityDeniedError &&
    error.code === "interactive_tool_capability_denied",
  "non-personal strategy-denied capabilities must remain blocked",
);

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
assert.equal(createApproval, "user-approval");
assert.equal(await coinbaseApproval(approvalContext, true), "user-approval");
assert.equal(
  await requireAgentcashToolAccess(
    context(earningsWorkspaceId) as never,
    true,
  ),
  principalId,
  "AgentCash must use the ordinary owner allowlist in a bound strategy workspace",
);
assert.equal(
  await agentcashInteractivePaymentApproval(approvalContext),
  "user-approval",
  "AgentCash paid calls must still require approval in a bound strategy workspace",
);
assert.equal(
  await coinbaseInteractiveApproval({
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
  "user-approval",
  "owner-global personal tools must not depend on strategy state availability",
);
await assert.rejects(
  coinbaseInteractiveApproval({
    capabilityIds: ["filesystem.write"],
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
    toolId: "filesystem.write",
  }),
  /fixture_state_unavailable/u,
  "strategy-scoped capability checks must still surface unexpected store failures",
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

async function testLegacyMainWithAbsentStrategyDocumentReachesCoinbaseProviderBoundary() {
  const legacyMainWorkspaceId = "323e4567-e89b-42d3-a456-426614174000";
  const legacyMainScope = authorizeDeploymentWorkspaceStore(
    { ownerId, workspaceId: legacyMainWorkspaceId },
    environment,
  );
  assert.equal(
    memory.values.has(workspaceDocumentStorageKey("strategy", legacyMainScope)),
    false,
    "legacy Main must begin with no strategy key",
  );

  const providerCalls: string[] = [];
  const result = await executeCoinbasePreviewOrder(
    {
      productId: "BTC-USD",
      quoteSize: "1.00",
      side: "BUY",
      type: "market",
    },
    {
      ...context(legacyMainWorkspaceId),
      abortSignal: new AbortController().signal,
      callId: "call_fixture_legacy_main_preview",
      toolName: "coinbase_preview_order",
    } as never,
    {
      callCoinbaseMcpTool: async (toolName) => {
        providerCalls.push(toolName);
        if (toolName === "coinbase_products_get") {
          return { product_id: "BTC-USD", product_type: "SPOT", status: "ONLINE" };
        }
        if (toolName === "coinbase_orders_preview") {
          return { preview_id: "fixture-preview", product_id: "BTC-USD" };
        }
        throw new Error(`unexpected fake Coinbase provider call: ${toolName}`);
      },
      requireInteractiveToolCapabilities: (input) =>
        requireInteractiveToolCapabilities({
          ...input,
          catalog: strategyPackCatalog,
          environment,
          stateClient: memory,
        }),
    },
  );

  assert.deepEqual(
    providerCalls,
    ["coinbase_products_get", "coinbase_orders_preview"],
    "legacy Main with an absent strategy document must reach the ordinary fake Coinbase provider boundary",
  );
  assert.equal(result.preview.preview_id, "fixture-preview");
}

await testLegacyMainWithAbsentStrategyDocumentReachesCoinbaseProviderBoundary();

console.log("Interactive strategy-workspace tool capability verification passed.");
