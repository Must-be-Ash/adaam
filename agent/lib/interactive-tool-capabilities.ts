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
