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
  normalizeAgentcashFetchInput,
} from "../lib/agentcash-policy";

export default defineTool({
  description:
    "Call one HTTPS API through AgentCash with automatic SIWX and x402/MPP payment. Requires a per-request USD ceiling. Requests capped below $1 execute without a prompt by default; at or above the configured approval threshold require user approval. Use the smallest sufficient ceiling; never split a purchase to bypass approval. Call agentcash_check_endpoint_schema first for a new endpoint.",
  inputSchema: agentcashFetchSchema,
  approval: agentcashInteractivePaymentApproval,
  async execute(input, ctx) {
    const principalId = await requireAgentcashToolAccess(ctx, true);
    const toolInput = enforceAgentcashFetch(
      normalizeAgentcashFetchInput(input),
      agentcashMaximumPaymentUsd(),
    );
    return executeAgentcashPayment({
      callId: ctx.callId,
      attemptScope: `${ctx.session.id}:${ctx.session.turn.id}`,
      operation: () =>
        callAgentcashMcpTool("fetch", toolInput, {
          signal: ctx.abortSignal,
        }),
      principalId,
      toolInput,
    });
  },
});
