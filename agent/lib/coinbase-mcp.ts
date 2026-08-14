import {
  createMCPClient,
  type MCPClient,
} from "@ai-sdk/mcp";

import { BoundedStdioMCPTransport } from "./bounded-stdio-transport";
import {
  COINBASE_CLI_PATH,
  coinbaseChildEnvironment,
  safeCoinbaseFailure,
} from "./coinbase-cli";
import {
  callCoinbaseEvalTool,
  coinbaseEvalChildEnvironment,
  coinbaseEvalFixtureEnabled,
} from "#coinbase-eval-fixture";
import {
  COINBASE_MAX_PAGE_ITEMS,
  normalizeCoinbaseMcpToolResult,
} from "./coinbase-mcp-policy";
import {
  type JsonObject,
  type JsonValue,
} from "./mcp-tool-result";

const INITIALIZE_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 30_000;
const MAX_COINBASE_STDIO_BYTES = 8 * 1024 * 1024;

interface CoinbaseClientHandle {
  client: MCPClient;
  transportErrors: AbortController;
}

export interface CoinbaseMcpToolDefinition {
  description?: string;
  inputSchema: JsonObject;
  name: string;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInputSchema(schema: JsonObject): JsonObject {
  const properties = schema.properties;
  if (!isJsonObject(properties) || !isJsonObject(properties.limit)) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      limit: {
        ...properties.limit,
        maximum: COINBASE_MAX_PAGE_ITEMS,
        minimum: 1,
      },
    },
  };
}

async function createCoinbaseClient(): Promise<CoinbaseClientHandle> {
  const transportErrors = new AbortController();
  const signalTransportError = (error: unknown): void => {
    if (!transportErrors.signal.aborted) transportErrors.abort(error);
  };
  const client = await createMCPClient({
    clientName: "eve-coinbase",
    initializationOptions: {
      signal: transportErrors.signal,
      timeout: INITIALIZE_TIMEOUT_MS,
    },
    maxRetries: 0,
    onUncaughtError: signalTransportError,
    transport: new BoundedStdioMCPTransport({
      args: [COINBASE_CLI_PATH, "mcp"],
      command: process.execPath,
      env: coinbaseEvalFixtureEnabled()
        ? coinbaseEvalChildEnvironment()
        : coinbaseChildEnvironment(),
      maximumBytes: MAX_COINBASE_STDIO_BYTES,
      onLimitExceeded: signalTransportError,
      stderr: "ignore",
    }),
    version: "1.0.0",
  });
  return { client, transportErrors };
}

export async function listCoinbaseMcpTools(): Promise<
  CoinbaseMcpToolDefinition[]
> {
  let handle: CoinbaseClientHandle | undefined;
  try {
    handle = await createCoinbaseClient();
    const definitions: CoinbaseMcpToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const page = await handle.client.listTools({
        ...(cursor ? { params: { cursor } } : {}),
        options: {
          signal: handle.transportErrors.signal,
          timeout: INITIALIZE_TIMEOUT_MS,
        },
      });
      for (const tool of page.tools) {
        definitions.push({
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: boundedInputSchema(tool.inputSchema as JsonObject),
          name: tool.name,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return definitions;
  } catch (error) {
    throw safeCoinbaseFailure(handle?.transportErrors.signal.reason ?? error);
  } finally {
    if (handle) await handle.client.close().catch(() => undefined);
  }
}

export async function callCoinbaseMcpTool(
  name: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<JsonValue> {
  if (coinbaseEvalFixtureEnabled()) {
    if (options.signal?.aborted) throw options.signal.reason;
    return callCoinbaseEvalTool(name, input);
  }
  let handle: CoinbaseClientHandle | undefined;
  try {
    handle = await createCoinbaseClient();
    const signals = [
      handle.transportErrors.signal,
      ...(options.signal ? [options.signal] : []),
    ];
    const result = await handle.client.callTool({
      arguments: input,
      name,
      options: {
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        timeout: TOOL_TIMEOUT_MS,
      },
    });
    return normalizeCoinbaseMcpToolResult(result, name);
  } catch (error) {
    throw safeCoinbaseFailure(handle?.transportErrors.signal.reason ?? error);
  } finally {
    if (handle) await handle.client.close().catch(() => undefined);
  }
}
