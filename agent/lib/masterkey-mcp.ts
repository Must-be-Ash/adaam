import {
  createMCPClient,
  type CallToolResult,
  type MCPClient,
} from "@ai-sdk/mcp";
import { connect } from "@vercel/connect/eve";

import {
  McpToolResultError,
  normalizeMcpToolResult,
  type JsonValue,
} from "./mcp-tool-result";
import { masterkeyMcpNormalizationPolicy } from "./masterkey-mcp-policy";
import {
  createBoundedFetch,
  McpResponseTooLargeError,
} from "./mcp-response-limit";

const INITIALIZE_TIMEOUT_MS = 10_000;
const TOOL_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;

export const MASTERKEY_MCP_URL = "https://www.masterkey.sh/mcp";

export const masterkeyAuthorization = connect({
  connector: "www.masterkey.sh/masterkey",
  displayName: "Masterkey",
  tokenParams: {
    resources: [MASTERKEY_MCP_URL],
    scopes: ["mcp:read", "mcp:run"],
  },
});

export class MasterkeyAuthenticationError extends Error {
  constructor() {
    super("Masterkey authorization is required.");
    this.name = "MasterkeyAuthenticationError";
  }
}

interface MasterkeyRequestError extends Error {
  cause?: unknown;
  code?: number | string;
  status?: number;
  statusCode?: number;
}

interface MasterkeyClientHandle {
  client: MCPClient;
  transportErrors: AbortController;
}

function diagnosticFor(error: MasterkeyRequestError): string {
  let cause = "";
  if (error.cause instanceof Error) cause = error.cause.message;
  else if (typeof error.cause === "string") cause = error.cause;
  return `${error.name}\n${error.message}\n${cause}`;
}

function safeMasterkeyFailure(error: unknown): Error {
  if (error instanceof McpToolResultError) return error;
  if (error instanceof McpResponseTooLargeError) {
    return new Error(
      "Masterkey returned more than 8 MiB inline, so Eve aborted before retaining it. A paid call may have completed; inspect usage or the returned job before retrying, and ask for fewer records or a durable output URL instead of binary data.",
    );
  }
  const failure =
    error instanceof Error
      ? (error as MasterkeyRequestError)
      : (new Error("Unknown Masterkey failure.") as MasterkeyRequestError);
  const diagnostic = diagnosticFor(failure);

  if (/MCP response exceeded \d+ bytes/iu.test(diagnostic)) {
    return new Error(
      "Masterkey returned more than 8 MiB inline, so Eve aborted before retaining it. A paid call may have completed; inspect usage or the returned job before retrying, and ask for fewer records or a durable output URL instead of binary data.",
    );
  }
  if (
    failure.status === 401 ||
    failure.statusCode === 401 ||
    /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|invalid bearer|invalid token/iu.test(
      diagnostic,
    )
  ) {
    return new MasterkeyAuthenticationError();
  }
  if (
    failure.code === "ETIMEDOUT" ||
    failure.name === "AbortError" ||
    /timed?\s*out|timeout/iu.test(diagnostic)
  ) {
    return new Error(
      "The Masterkey request timed out. A paid call may have completed; inspect usage or the returned job before retrying it.",
    );
  }

  return new Error("The Masterkey request failed without a safe diagnostic.");
}

async function createMasterkeyClient(
  token: string,
): Promise<MasterkeyClientHandle> {
  const transportErrors = new AbortController();
  const signalTransportError = (error: unknown): void => {
    if (!transportErrors.signal.aborted) transportErrors.abort(error);
  };
  const client = await createMCPClient({
    clientName: "eve-masterkey",
    initializationOptions: {
      signal: transportErrors.signal,
      timeout: INITIALIZE_TIMEOUT_MS,
    },
    maxRetries: 0,
    onUncaughtError: signalTransportError,
    transport: {
      fetch: createBoundedFetch(
        MAX_MCP_RESPONSE_BYTES,
        globalThis.fetch,
        signalTransportError,
      ),
      headers: {
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      terminateSessionOnClose: false,
      type: "http",
      url: MASTERKEY_MCP_URL,
    },
    version: "1.0.0",
  });
  return { client, transportErrors };
}

async function closeMasterkeyClient(client: MCPClient): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const closing = client.close().catch(() => undefined);
  try {
    await Promise.race([
      closing,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function callMasterkeyMcpTool(
  name: string,
  input: Record<string, unknown>,
  token: string,
  options: { signal?: AbortSignal } = {},
): Promise<JsonValue> {
  let handle: MasterkeyClientHandle | undefined;
  try {
    handle = await createMasterkeyClient(token);
    const signals = [
      handle.transportErrors.signal,
      ...(options.signal ? [options.signal] : []),
    ];
    const result: CallToolResult = await handle.client.callTool({
      arguments: input,
      name,
      options: {
        signal:
          signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        timeout: TOOL_TIMEOUT_MS,
      },
    });
    return normalizeMcpToolResult(
      result,
      masterkeyMcpNormalizationPolicy(name),
    );
  } catch (error) {
    throw safeMasterkeyFailure(
      handle?.transportErrors.signal.reason ?? error,
    );
  } finally {
    if (handle) await closeMasterkeyClient(handle.client);
  }
}
