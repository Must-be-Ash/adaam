import { defineTool } from "eve/tools";

import { requireAgentcashToolAccess } from "../lib/agentcash-access";
import { inspectAgentcashEndpointSchema } from "../lib/agentcash-endpoint-schema";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";
import {
  agentcashFreeFetchSchema,
  agentcashNoPaymentCeilingUsd,
  assertAgentcashFreeSiwxEndpoint,
  safeAgentcashReadInput,
} from "../lib/agentcash-policy";

export default defineTool({
  description:
    "Fetch one HTTPS GET endpoint through AgentCash without payment approval, but only after an immediate schema inspection confirms that the exact GET route uses SIWX and requires no payment. Use this for async pollUrl status checks returned by a previously approved paid request.",
  inputSchema: agentcashFreeFetchSchema,
  async execute(input, ctx) {
    await requireAgentcashToolAccess(ctx);
    const safeInspectionInput = safeAgentcashReadInput(
      "check_endpoint_schema",
      {
        headers: input.headers,
        method: "GET",
        url: input.url,
      },
    );
    const inspection = await inspectAgentcashEndpointSchema({
      ...(safeInspectionInput.headers &&
      typeof safeInspectionInput.headers === "object"
        ? {
            headers: safeInspectionInput.headers as Record<string, string>,
          }
        : {}),
      method: "GET",
      signal: ctx.abortSignal,
      url: String(safeInspectionInput.url),
    });
    assertAgentcashFreeSiwxEndpoint(inspection, input.url);
    return callAgentcashMcpTool(
      "fetch",
      {
        headers: input.headers,
        maxAmount: agentcashNoPaymentCeilingUsd,
        method: "GET",
        paymentNetwork: input.paymentNetwork,
        timeout: input.timeout,
        url: input.url,
      },
      { signal: ctx.abortSignal },
    );
  },
});
