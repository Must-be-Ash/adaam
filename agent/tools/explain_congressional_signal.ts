import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  readCongressionalSignalExplanation,
  readLatestCongressionalSignalExplanation,
} from "../lib/congressional-signal-presentation";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "Explain the latest Congressional Signals result, or one exact revision, from the current authenticated session using only its validated, bounded deterministic traces. This is read-only and cannot inspect another session.",
  inputSchema: z.object({
    signalRevisionId: z.string().regex(/^congressional-signal-revision\.[a-f0-9]{64}$/u).optional(),
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
    return input.signalRevisionId
      ? readCongressionalSignalExplanation({ scope, signalRevisionId: input.signalRevisionId })
      : readLatestCongressionalSignalExplanation(scope);
  },
});
