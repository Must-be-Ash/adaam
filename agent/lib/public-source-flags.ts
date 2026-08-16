export type SecPublicSourceRuntimePath =
  | "legacy_sec_workspace_worker"
  | "public_source_adapter";

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolveSecPublicSourceRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): SecPublicSourceRuntimePath {
  return enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
    enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED) &&
    enabled(environment.EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED)
    ? "public_source_adapter"
    : "legacy_sec_workspace_worker";
}
