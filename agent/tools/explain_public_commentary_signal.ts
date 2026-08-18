import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  readLatestPublicCommentaryFindingExplanation,
  readPublicCommentaryFindingExplanation,
} from "../lib/public-commentary-presentation";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description: "Read one exact current Inverse Cramer research finding, or the latest finding in the current authenticated workspace. Returns bounded explanation and evidence references without tools or mutations.",
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
    if (binding.state !== "active" || binding.pack?.id !== "inverse-cramer") {
      throw new Error("public_commentary_workspace_unavailable");
    }
    return input.findingId
      ? readPublicCommentaryFindingExplanation({ findingId: input.findingId, scope })
      : readLatestPublicCommentaryFindingExplanation(scope);
  },
});
