import type { McpNormalizationPolicy } from "./mcp-tool-result";

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
