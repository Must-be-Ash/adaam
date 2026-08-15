import { defineTool } from "eve/tools";
import { z } from "zod";

import { workspaceFindingInputSchema } from "./workspace-finding-store";
import {
  completeWorkspaceRunForWorker,
  writeWorkspaceFindingForWorker,
} from "./workspace-worker-control-plane";

export const completeWorkspaceRunTool = defineTool({
  description:
    "Complete this one workspace monitor occurrence as no-match. This succeeds only after every exact configured source was fetched successfully.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const outcome = await completeWorkspaceRunForWorker({ ctx });
    return {
      checkpoint: outcome.checkpoint,
      completed: true,
      outcome: outcome.outcome,
      runId: outcome.runId,
    };
  },
});

export const writeWorkspaceFindingTool = defineTool({
  description:
    "Stage one bounded structured workspace finding for this occurrence. Identity is derived from runtime auth and every provenance record must stay within the configured source origins.",
  inputSchema: workspaceFindingInputSchema,
  async execute(finding, ctx) {
    const outcome = await writeWorkspaceFindingForWorker({ ctx, finding });
    return {
      checkpoint: outcome.checkpoint,
      findingId: outcome.finding?.findingId,
      outcome: outcome.outcome,
      runId: outcome.runId,
      staged: true,
    };
  },
});
