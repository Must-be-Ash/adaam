export interface PublicCommentaryRuntimeFlags {
  readonly corroborationEnabled: boolean;
  readonly sourceEnabled: boolean;
  readonly strategyExecutionEnabled: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolvePublicCommentaryRuntimeFlags(
  environment: NodeJS.ProcessEnv = process.env,
  source?: Readonly<{ adapterId?: "official-web-statements" | "x-public-statements" }>,
): PublicCommentaryRuntimeFlags {
  const sourceParentsEnabled =
    enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
    enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED);
  const adapterEnabled = source?.adapterId === "official-web-statements"
    ? enabled(environment.EVE_OFFICIAL_WEB_STATEMENT_SOURCE_ENABLED)
    : source?.adapterId === "x-public-statements"
      ? enabled(environment.EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED)
      : enabled(environment.EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED) ||
        enabled(environment.EVE_OFFICIAL_WEB_STATEMENT_SOURCE_ENABLED);
  const sourceEnabled = adapterEnabled && sourceParentsEnabled;
  const strategyParentsEnabled =
    enabled(environment.EVE_STRATEGY_PACK_RUNTIME_ENABLED) &&
    enabled(environment.EVE_HYBRID_EVIDENCE_ENABLED) &&
    enabled(environment.EVE_HYBRID_SEMANTIC_REASONING_ENABLED);
  return Object.freeze({
    corroborationEnabled:
      enabled(environment.EVE_EXA_CORROBORATION_ENABLED) && sourceParentsEnabled,
    sourceEnabled,
    strategyExecutionEnabled:
      enabled(environment.EVE_INVERSE_CRAMER_EXECUTION_ENABLED) &&
      sourceEnabled && strategyParentsEnabled,
  });
}
