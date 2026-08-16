import { defineTool } from "eve/tools";
import { z } from "zod";

import { listStrategyPacks } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";

export default defineTool({
  description:
    "List the compact reviewed strategy-pack catalog available to the current authenticated Photon session. This only inspects metadata and never installs a pack or starts work.",
  inputSchema: z.object({}).strict(),
  execute(_input, ctx) {
    requirePhotonWorkspaceToolScope(ctx);
    return listStrategyPacks();
  },
});
