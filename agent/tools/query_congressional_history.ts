import { defineTool } from "eve/tools";
import { z } from "zod";

import { readCongressionalMemberHistory } from "../lib/congressional-signal-presentation";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "Read verified active House PTR purchase and sale history for one exact member from the current Congressional Signals workspace. The member filter is applied before any filing facts are returned, so an unrelated latest filing cannot answer a member-specific question. Returns official citations and coverage state without mutating data or widening sources.",
  inputSchema: z.object({
    member: z.string().trim().min(2).max(240).describe(
      "Exact official House member name or Bioguide ID, for example Nancy Pelosi or P000197.",
    ),
  }).strict(),
  async execute(input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const binding = await inspectStrategyPackWorkspace({
      scope,
      workspaceGeneration: runtimeScope.generation,
    });
    if (
      binding.state !== "active" ||
      binding.pack?.id !== "congressional-signals"
    ) throw new Error("congressional_signal_workspace_unavailable");
    return readCongressionalMemberHistory({ member: input.member, scope });
  },
});
