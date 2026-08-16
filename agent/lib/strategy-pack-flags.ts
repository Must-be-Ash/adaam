import { resolveWorkspaceRuntimeFlags } from "./workspace-runtime-flags";

export interface StrategyPackFlags {
  readonly catalog: boolean;
  readonly managedDispatch: boolean;
  readonly mutations: boolean;
  readonly runtimeComposition: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolveStrategyPackFlags(
  environment: NodeJS.ProcessEnv = process.env,
): StrategyPackFlags {
  const workspace = resolveWorkspaceRuntimeFlags(environment);
  const catalog =
    workspace.state && enabled(environment.EVE_STRATEGY_PACK_CATALOG_ENABLED);
  const runtimeComposition =
    catalog && enabled(environment.EVE_STRATEGY_PACK_RUNTIME_ENABLED);

  return Object.freeze({
    catalog,
    managedDispatch:
      runtimeComposition &&
      workspace.dispatch &&
      enabled(environment.EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED),
    mutations:
      catalog &&
      workspace.monitorWrites &&
      enabled(environment.EVE_STRATEGY_PACK_MUTATIONS_ENABLED),
    runtimeComposition,
  });
}

export function resolveStrategyPackBindingAvailability(input: {
  readonly flags: StrategyPackFlags;
  readonly hasBinding: boolean;
}):
  | { readonly reason: null; readonly state: "active" | "unbound" }
  | {
      readonly reason: "strategy_pack_runtime_disabled";
      readonly state: "unavailable";
    } {
  if (!input.hasBinding) return Object.freeze({ reason: null, state: "unbound" });
  if (!input.flags.runtimeComposition) {
    return Object.freeze({
      reason: "strategy_pack_runtime_disabled",
      state: "unavailable",
    });
  }
  return Object.freeze({ reason: null, state: "active" });
}
