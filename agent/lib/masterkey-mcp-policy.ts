import type { McpNormalizationPolicy } from "./mcp-tool-result";

const RUNTIME_DENIAL_REASON =
  "Scheduled public-feed checks cannot use paid services.";

export function masterkeyToolApproval(
  principalType: string | undefined,
):
  | "not-applicable"
  | { reason: typeof RUNTIME_DENIAL_REASON; type: "denied" } {
  return principalType === "runtime"
    ? { reason: RUNTIME_DENIAL_REASON, type: "denied" }
    : "not-applicable";
}

export function masterkeyMcpNormalizationPolicy(
  toolName: string,
): McpNormalizationPolicy {
  return {
    maxArrayItems: 50,
    maxOutputCharacters: 120_000,
    maxResultItems: toolName === "search_services" ? 10 : 50,
    metadataKey: "masterkey",
  };
}
