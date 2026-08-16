import { resolveWorkspaceRuntimeFlags } from "./workspace-runtime-flags";

export interface HybridEvidenceFlags {
  readonly configuration: "disabled" | "enabled" | "misconfigured";
  readonly enabled: boolean;
  readonly extractionRecovery: boolean;
  readonly semanticReasoning: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolveHybridEvidenceFlags(
  environment: NodeJS.ProcessEnv = process.env,
): HybridEvidenceFlags {
  const parentRequested = enabled(environment.EVE_HYBRID_EVIDENCE_ENABLED);
  const extractionRequested = enabled(
    environment.EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED,
  );
  const semanticRequested = enabled(
    environment.EVE_HYBRID_SEMANTIC_REASONING_ENABLED,
  );
  const anyRequested = parentRequested || extractionRequested || semanticRequested;
  const workspace = resolveWorkspaceRuntimeFlags(environment);
  const dependenciesAvailable = workspace.state && workspace.dispatch;
  const misconfigured = anyRequested && (!parentRequested || !dependenciesAvailable);
  const layerEnabled = parentRequested && dependenciesAvailable && !misconfigured;

  return Object.freeze({
    configuration: !anyRequested
      ? "disabled"
      : misconfigured
        ? "misconfigured"
        : "enabled",
    enabled: layerEnabled,
    extractionRecovery: layerEnabled && extractionRequested,
    semanticReasoning: layerEnabled && semanticRequested,
  });
}
