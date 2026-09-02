import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgentcashToolAccess } from "../lib/agentcash-access";
import { callAgentcashMcpTool } from "../lib/agentcash-mcp";

export default defineTool({
  description:
    "Read the deployment AgentCash wallet settings. This is read-only and never makes a payment.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    await requireAgentcashToolAccess(ctx);
    return callAgentcashMcpTool("get_settings", {}, { signal: ctx.abortSignal });
  },
});
