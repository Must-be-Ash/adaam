import { defineDynamic, type ToolDefinition } from "eve/tools";

import { resolveWorkspaceWorkerStepCapabilities } from "../../../lib/workspace-worker-capabilities";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  evaluateSecIpoSourceTool,
} from "../../../lib/sec-ipo-workspace-worker";
import fetchPublicSource from "../../../tools/fetch_public_source";
import {
  completeWorkspaceRunTool,
  writeWorkspaceFindingTool,
} from "../../../lib/workspace-worker-tool-definitions";
import {
  COMPLETE_WORKSPACE_RUN_TOOL_ID,
  WRITE_WORKSPACE_FINDING_TOOL_ID,
} from "../../../lib/workspace-worker-control-plane";

const registry = Object.freeze([
  {
    definition: evaluateSecIpoSourceTool as ToolDefinition,
    metadata: {
      category: "control_plane" as const,
      id: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
    },
  },
  {
    definition: completeWorkspaceRunTool as ToolDefinition,
    metadata: { category: "control_plane" as const, id: COMPLETE_WORKSPACE_RUN_TOOL_ID },
  },
  {
    definition: fetchPublicSource as ToolDefinition,
    metadata: { category: "research" as const, id: "fetch_public_source" },
  },
  {
    definition: writeWorkspaceFindingTool as ToolDefinition,
    metadata: { category: "control_plane" as const, id: WRITE_WORKSPACE_FINDING_TOOL_ID },
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
