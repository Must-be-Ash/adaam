import {
  createMCPClient,
  type MCPClient,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";

import {
  COINBASE_CLI_PATH,
  coinbaseChildEnvironment,
  safeCoinbaseFailure,
} from "./coinbase-cli";
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

async function createCoinbaseClient(): Promise<MCPClient> {
  return createMCPClient({
    clientName: "eve-coinbase",
    initializationOptions: { timeout: INITIALIZE_TIMEOUT_MS },
    maxRetries: 0,
    transport: new Experimental_StdioMCPTransport({
      args: [COINBASE_CLI_PATH, "mcp"],
      command: process.execPath,
      env: coinbaseChildEnvironment(),
      stderr: "ignore",
    }),
    version: "1.0.0",
  });
}

export async function listCoinbaseMcpTools(): Promise<
  CoinbaseMcpToolDefinition[]
> {
  let client: MCPClient | undefined;
  try {
    client = await createCoinbaseClient();
    const definitions: CoinbaseMcpToolDefinition[] = [];
    let cursor: string | undefined;

    do {
      const page = await client.listTools({
        ...(cursor ? { params: { cursor } } : {}),
        options: { timeout: INITIALIZE_TIMEOUT_MS },
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
    throw safeCoinbaseFailure(error);
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}

export async function callCoinbaseMcpTool(
  name: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal } = {},
): Promise<JsonValue> {
  let client: MCPClient | undefined;
  try {
    client = await createCoinbaseClient();
    const result = await client.callTool({
      arguments: input,
      name,
      options: {
        timeout: TOOL_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    });
    return normalizeCoinbaseMcpToolResult(result, name);
  } catch (error) {
    throw safeCoinbaseFailure(error);
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
}
