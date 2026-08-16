import { defineTool } from "eve/tools";
import { z } from "zod";

import { inspectStrategyPack } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";

export const inspectStrategyPackInputSchema = z.object({
  id: z.string().min(2).max(64),
  version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
}).strict();

export default defineTool({
  description:
    "Inspect one exact reviewed strategy pack: purpose, version, configuration, requested capabilities, sources, and suggested monitors. This never installs or activates anything.",
  inputSchema: inspectStrategyPackInputSchema,
  execute(input, ctx) {
    requirePhotonWorkspaceToolScope(ctx);
    return inspectStrategyPack(input);
  },
});
