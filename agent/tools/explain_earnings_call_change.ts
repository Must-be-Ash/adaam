import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  readEarningsCallFindingExplanation,
  readLatestEarningsCallFindingExplanation,
} from "../lib/earnings-call-presentation";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "Read one exact accepted Earnings Call Changes finding, or the latest finding in the current authenticated workspace. Returns bounded analysis and exact citation locators without mutating state or widening sources.",
  inputSchema: z.object({
    findingId: z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u).optional(),
  }).strict(),
  async execute(input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const binding = await inspectStrategyPackWorkspace({
      scope,
      workspaceGeneration: runtimeScope.generation,
    });
    if (binding.state !== "active" || binding.pack?.id !== "earnings-call-changes") {
      throw new Error("earnings_call_workspace_unavailable");
    }
    return input.findingId
      ? readEarningsCallFindingExplanation({ findingId: input.findingId, scope })
      : readLatestEarningsCallFindingExplanation(scope);
  },
});
