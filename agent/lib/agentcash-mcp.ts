import { createMCPClient, type CallToolResult, type MCPClient } from "@ai-sdk/mcp";

import { BoundedStdioMCPTransport } from "./bounded-stdio-transport";
import {
  AGENTCASH_CLI_PATH,
  agentcashChildEnvironment,
  safeAgentcashFailure,
} from "./agentcash-cli";
import { agentcashMcpNormalizationPolicy } from "./agentcash-mcp-policy";
import { normalizeMcpToolResult, type JsonValue } from "./mcp-tool-result";

const INITIALIZE_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 180_000;
const MAX_AGENTCASH_STDIO_BYTES = 8 * 1024 * 1024;

interface AgentcashClientHandle {
  client: MCPClient;
  transportErrors: AbortController;
}

async function createAgentcashClient(): Promise<AgentcashClientHandle> {
  const transportErrors = new AbortController();
  const signalTransportError = (error: unknown): void => {
    if (!transportErrors.signal.aborted) transportErrors.abort(error);
  };
  const client = await createMCPClient({
    clientName: "eve-agentcash",
    initializationOptions: {
      signal: transportErrors.signal,
      timeout: INITIALIZE_TIMEOUT_MS,
    },
    maxRetries: 0,
    onUncaughtError: signalTransportError,
    transport: new BoundedStdioMCPTransport({
      args: [AGENTCASH_CLI_PATH, "server"],
      command: process.execPath,
      env: agentcashChildEnvironment(),
      maximumBytes: MAX_AGENTCASH_STDIO_BYTES,
      onLimitExceeded: signalTransportError,
      stderr: "ignore",
    }),
    version: "1.0.0",
  });
  return { client, transportErrors };
}

export async function callAgentcashMcpTool(
  name: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<JsonValue> {
  let handle: AgentcashClientHandle | undefined;
  try {
    handle = await createAgentcashClient();
    const signals = [
      handle.transportErrors.signal,
      ...(options.signal ? [options.signal] : []),
    ];
    const result: CallToolResult = await handle.client.callTool({
      arguments: input,
      name,
      options: {
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        timeout: TOOL_TIMEOUT_MS,
      },
    });
    return normalizeMcpToolResult(
      result,
      agentcashMcpNormalizationPolicy(name),
    );
  } catch (error) {
    throw safeAgentcashFailure(handle?.transportErrors.signal.reason ?? error);
  } finally {
    if (handle) await handle.client.close().catch(() => undefined);
  }
}
