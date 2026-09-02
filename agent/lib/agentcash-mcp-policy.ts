import type { McpNormalizationPolicy } from "./mcp-tool-result";

export function agentcashMcpNormalizationPolicy(
  toolName: string,
): McpNormalizationPolicy {
  return {
    maxArrayItems: 50,
    maxOutputCharacters: 120_000,
    maxResultItems: toolName === "search" ? 20 : 50,
    metadataKey: "agentcash",
  };
}
