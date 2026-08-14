import { defineDynamic, type ToolDefinition } from "eve/tools";

import { resolveWorkspaceWorkerStepCapabilities } from "../../../lib/workspace-worker-capabilities";
import fetchPublicSource from "../../../tools/fetch_public_source";

const registry = Object.freeze([
  {
    definition: fetchPublicSource as ToolDefinition,
    metadata: { category: "research" as const, id: "fetch_public_source" },
  },
]);

export default defineDynamic({
  events: {
    "step.started": async (_event, ctx) => {
      const capabilities = await resolveWorkspaceWorkerStepCapabilities({
        ctx,
        registry,
      });
      return capabilities.tools;
    },
    "turn.started": async (_event, ctx) => {
      const capabilities = await resolveWorkspaceWorkerStepCapabilities({
        ctx,
        registry,
      });
      return capabilities.tools;
    },
  },
});
