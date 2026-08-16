import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "Inspect the exact strategy-pack binding, health, configuration, capabilities, sources, and managed monitors for the current authenticated session.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    return inspectStrategyPackWorkspace({
      scope,
      workspaceGeneration: runtimeScope.generation,
    });
  },
});
