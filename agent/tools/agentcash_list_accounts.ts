import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgentcashToolAccess } from "../lib/agentcash-access";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";

export default defineTool({
  description:
    "List the deployment AgentCash wallet accounts, networks, addresses, and balances. This is read-only and never makes a payment.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await requireAgentcashToolAccess(ctx);
    return callAgentcashMcpTool("list_accounts", {}, { signal: ctx.abortSignal });
  },
});
