import type { SessionContext } from "eve/context";
import type { ApprovalContext, ApprovalStatus } from "eve/tools";

import { coinbaseApproval } from "./coinbase-access";
import type { StrategyPackRuntimeCatalog } from "./strategy-pack-runtime";
import { resolveSessionStrategyPackRuntime } from "./strategy-pack-runtime";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";

export class InteractiveToolCapabilityDeniedError extends Error {
  readonly code = "interactive_tool_capability_denied";

  constructor() {
    super("This tool is not available in the current strategy session.");
    this.name = "InteractiveToolCapabilityDeniedError";
  }
}

function isOwnerGlobalPersonalTool(toolId: string): boolean {
  return (
    toolId === "coinbase_mcp" ||
    toolId.startsWith("coinbase_") ||
    toolId === "agentcash_x402" ||
    toolId.startsWith("agentcash_")
  );
}

export async function requireInteractiveToolCapabilities(input: {
  readonly capabilityIds?: readonly string[];
  readonly catalog?: StrategyPackRuntimeCatalog;
  readonly ctx: {
    readonly session: { readonly auth: SessionContext["session"]["auth"] };
  };
  readonly environment?: NodeJS.ProcessEnv;
  readonly stateClient?: WorkspaceStateStoreClient;
  readonly toolId: string;
}): Promise<void> {
  // A strategy pack scopes its automated workspace runtime; it does not turn an
  // authenticated owner's private conversation into a different agent. These
  // personal tools retain their own principal allowlists, wallet/credential
  // checks, spot-only policy, replay guards, and explicit mutation/payment
  // approvals. Scheduled and delegated workers are still filtered separately by
  // SHARED_RUNTIME_HARD_DENIED_CAPABILITIES before they receive any tools.
  if (isOwnerGlobalPersonalTool(input.toolId)) return;

  const runtime = await resolveSessionStrategyPackRuntime({
    catalog: input.catalog,
    ctx: input.ctx,
    environment: input.environment,
    stateClient: input.stateClient,
  });
  if (!runtime || runtime.state === "unbound") return;

  const denied = new Set(runtime.hardDeniedCapabilityIds);
  if (
    [input.toolId, ...(input.capabilityIds ?? [])].some((id) => denied.has(id))
  ) {
    throw new InteractiveToolCapabilityDeniedError();
  }
}

export async function coinbaseInteractiveApproval(input: {
  readonly capabilityIds?: readonly string[];
  readonly catalog?: StrategyPackRuntimeCatalog;
  readonly ctx: ApprovalContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requiresUserApproval: boolean;
  readonly stateClient?: WorkspaceStateStoreClient;
  readonly toolId: string;
}): Promise<ApprovalStatus> {
  try {
    await requireInteractiveToolCapabilities({
      capabilityIds: input.capabilityIds,
      catalog: input.catalog,
      ctx: input.ctx,
      environment: input.environment,
      stateClient: input.stateClient,
      toolId: input.toolId,
    });
  } catch (error) {
    if (!(error instanceof InteractiveToolCapabilityDeniedError)) throw error;
    return {
      type: "denied",
      reason: "Coinbase is not available in the current strategy session.",
    };
  }
  return coinbaseApproval(input.ctx, input.requiresUserApproval);
}
