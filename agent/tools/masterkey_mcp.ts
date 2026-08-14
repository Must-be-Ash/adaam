import { defineDynamic, defineTool, toolOutput } from "eve/tools";

import {
  callMasterkeyMcpTool,
  MASTERKEY_MCP_URL,
  masterkeyAuthorization,
  MasterkeyAuthenticationError,
} from "../lib/masterkey-mcp";
import { masterkeyToolApproval } from "../lib/masterkey-mcp-policy";
import type { JsonObject } from "../lib/mcp-tool-result";

interface MasterkeyToolDefinition {
  description: string;
  inputSchema: JsonObject;
  name: string;
}

const MASTERKEY_AUTH_OPTIONS = {
  authKey: "masterkey-x402",
  connection: { url: MASTERKEY_MCP_URL },
  displayName: "Masterkey",
} as const;

const TOOL_DEFINITIONS: readonly MasterkeyToolDefinition[] = [
  {
    name: "search_services",
    description:
      "Find Masterkey services by a narrow query. Returns at most 10 compact service summaries. Use get_service next.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Specific capability or dataset to find.",
        },
        category: {
          type: "string",
          description: "Optional category or subcategory slug.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum results. Defaults to 10.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_service",
    description:
      "Get one Masterkey service's callable schema, providers, coverage, and pricing.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: {
          type: "string",
          description: "Exact service id from search_services.",
        },
      },
      required: ["serviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "estimate_cost",
    description:
      "Get a service price estimate without executing or paying for the service.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "string", description: "Exact service id." },
        backendProviderId: {
          type: "string",
          description: "Optional provider id.",
        },
        operation: {
          type: "string",
          description: "Optional API operation name.",
        },
      },
      required: ["serviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_limits",
    description:
      "Return the current user's Masterkey spend limits and authorized scopes.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_usage",
    description:
      "Return Masterkey spend, remaining budget, reset date, and recent calls.",
    inputSchema: {
      type: "object",
      properties: {
        period: {
          type: "string",
          enum: ["month", "day", "session"],
          description: "Optional usage period; defaults to month.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_service",
    description:
      "Pay for and run one previously inspected Masterkey service after explicit user approval. Use get_limits, get_service, and estimate_cost first; Eve supplies replay protection.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: {
          type: "string",
          description: "Exact service id.",
        },
        operation: {
          type: "string",
          description: "Operation for a multi-operation API service.",
        },
        backendProviderId: {
          type: "string",
          description: "Optional provider id.",
        },
        model: {
          type: "string",
          description: "Optional model override.",
        },
        input: {
          type: "object",
          additionalProperties: {},
          description: "Payload matching the inspected service schema.",
        },
      },
      required: ["serviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_result",
    description:
      "Retrieve one asynchronous Masterkey job result. Call at most once; never poll in a loop.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Exact job id returned by run_service.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
];

function boundedInput(
  toolName: string,
  input: Record<string, unknown>,
  callId: string,
): Record<string, unknown> {
  if (toolName === "run_service") {
    return {
      ...input,
      idempotencyKey: `eve:${callId}`,
    };
  }
  if (toolName !== "search_services") return input;
  const requested = input.limit;
  const limit =
    typeof requested === "number" && Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), 10)
      : 10;
  return { ...input, limit };
}

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => {
      if (ctx.session.auth.current?.principalType === "runtime") return null;

      return Object.fromEntries(
        TOOL_DEFINITIONS.map((definition) => [
          `masterkey-x402__${definition.name}`,
          defineTool({
            description: definition.description,
            inputSchema: definition.inputSchema,
            approval: (approvalCtx) =>
              masterkeyToolApproval(
                approvalCtx.session.auth.current?.principalType,
              ),
            async execute(input, toolCtx) {
              if (toolCtx.session.auth.current?.principalType === "runtime") {
                throw new Error(
                  "Scheduled public-feed checks cannot use paid services.",
                );
              }
              const { token } = await toolCtx.getToken(
                masterkeyAuthorization,
                MASTERKEY_AUTH_OPTIONS,
              );
              try {
                return await callMasterkeyMcpTool(
                  definition.name,
                  boundedInput(definition.name, input, toolCtx.callId),
                  token,
                  { signal: toolCtx.abortSignal },
                );
              } catch (error) {
                if (
                  error instanceof MasterkeyAuthenticationError ||
                  (error instanceof Error &&
                    error.name === "MasterkeyAuthenticationError")
                ) {
                  toolCtx.requireAuth(
                    masterkeyAuthorization,
                    MASTERKEY_AUTH_OPTIONS,
                  );
                }
                throw error;
              }
            },
            toModelOutput(output) {
              return toolOutput.json(output);
            },
          }),
        ]),
      );
    },
  },
});
