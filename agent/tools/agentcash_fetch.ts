import { defineTool } from "eve/tools";

import {
  agentcashInteractivePaymentApproval,
  agentcashMaximumPaymentUsd,
  requireAgentcashToolAccess,
} from "../lib/agentcash-access";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";
import { executeAgentcashPayment } from "../lib/agentcash-operation-store";
import {
  agentcashFetchSchema,
  enforceAgentcashFetch,
} from "../lib/agentcash-policy";

export default defineTool({
  description:
    "Call one HTTPS API through AgentCash with automatic SIWX and x402/MPP payment. Requires a caller-visible per-request USD ceiling and explicit user approval. Call agentcash_check_endpoint_schema first for a new endpoint.",
  inputSchema: agentcashFetchSchema,
  approval: agentcashInteractivePaymentApproval,
  async execute(input, ctx) {
    const principalId = await requireAgentcashToolAccess(ctx, true);
    const toolInput = enforceAgentcashFetch(
      input,
      agentcashMaximumPaymentUsd(),
    );
    return executeAgentcashPayment({
      callId: ctx.callId,
      operation: () =>
        callAgentcashMcpTool("fetch", toolInput, {
          signal: ctx.abortSignal,
        }),
      principalId,
      toolInput,
    });
  },
});
