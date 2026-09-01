import { defineTool } from "eve/tools";
import { z } from "zod";

import { readCongressionalMemberHistory } from "../lib/congressional-signal-presentation";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export async function executeCongressionalHistoryQuery(
  input: { readonly member: string },
  ctx: Parameters<typeof requirePhotonWorkspaceToolScope>[0],
  dependencies: Readonly<{
    environment?: NodeJS.ProcessEnv;
    inspect?: typeof inspectStrategyPackWorkspace;
    read?: typeof readCongressionalMemberHistory;
  }> = {},
) {
  const environment = dependencies.environment ?? process.env;
  const runtimeScope = requirePhotonWorkspaceToolScope(ctx, {}, environment);
  const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope, environment);
  const binding = await (dependencies.inspect ?? inspectStrategyPackWorkspace)({
    scope,
    workspaceGeneration: runtimeScope.generation,
  });
  if (
    binding.state !== "active" ||
    binding.pack?.id !== "congressional-signals"
  ) throw new Error("congressional_signal_workspace_unavailable");
  return (dependencies.read ?? readCongressionalMemberHistory)({ member: input.member, scope });
}

export default defineTool({
  description:
    "Read verified active House PTR purchase and sale history for one exact member from the current Congressional Signals workspace. The member filter is applied before any filing facts are returned, so an unrelated latest filing cannot answer a member-specific question. Returns official citations and coverage state without mutating data or widening sources.",
  inputSchema: z.object({
    member: z.string().trim().min(2).max(240).describe(
      "Exact official House member name or Bioguide ID, for example Nancy Pelosi or P000197.",
    ),
  }).strict(),
  async execute(input, ctx) {
    return executeCongressionalHistoryQuery(input, ctx);
  },
});
