import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgentcashToolAccess } from "../lib/agentcash-access";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";

export default defineTool({
  description:
    "Get the deployment AgentCash wallet's total balance. This is read-only and never makes a payment.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await requireAgentcashToolAccess(ctx);
    return callAgentcashMcpTool("get_balance", {}, { signal: ctx.abortSignal });
  },
});
