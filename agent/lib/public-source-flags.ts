export type SecPublicSourceRuntimePath =
  | "legacy_sec_workspace_worker"
  | "public_source_adapter"
  | "public_source_misconfigured";

export type HousePublicSourceRuntimePath =
  | "disabled"
  | "public_source_adapter"
  | "public_source_misconfigured";

export type EarningsCallPublicSourceRuntimePath =
  | "disabled"
  | "public_source_adapter"
  | "public_source_misconfigured";

export type XPublicStatementRuntimePath =
  | "disabled"
  | "public_source_adapter"
  | "public_source_misconfigured";

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolveSecPublicSourceRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): SecPublicSourceRuntimePath {
  if (!enabled(environment.EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED)) {
    return "legacy_sec_workspace_worker";
  }
  return enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
      enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED)
    ? "public_source_adapter"
    : "public_source_misconfigured";
}

export function resolveHousePublicSourceRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): HousePublicSourceRuntimePath {
  if (!enabled(environment.EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED)) {
    return "disabled";
  }
  return enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
      enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED)
    ? "public_source_adapter"
    : "public_source_misconfigured";
}

export function resolveEarningsCallPublicSourceRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): EarningsCallPublicSourceRuntimePath {
  if (!enabled(environment.EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED)) return "disabled";
  return enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
      enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED)
    ? "public_source_adapter"
    : "public_source_misconfigured";
}

export function resolveXPublicStatementRuntimePath(
  environment: NodeJS.ProcessEnv = process.env,
): XPublicStatementRuntimePath {
  if (!enabled(environment.EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED)) return "disabled";
  return enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
      enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED)
    ? "public_source_adapter"
    : "public_source_misconfigured";
}
