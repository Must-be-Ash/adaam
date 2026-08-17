import { defineTool } from "eve/tools";
import { z } from "zod";

import { listWorkspaceMonitors } from "../lib/workspace-monitor-store";
import { readWorkspaceDocument } from "../lib/workspace-state-store";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";
import { inspectWorkspaceHybridEvidence } from "../lib/hybrid-evidence-semantic";

export default defineTool({
  description: "Inspect current-workspace monitor health, schedules, checkpoints, and budget policy without changing state.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const [monitors, budget, hybridEvidence] = await Promise.all([
      listWorkspaceMonitors(scope),
      readWorkspaceDocument("budget", scope),
      inspectWorkspaceHybridEvidence({ scope }),
    ]);
    return {
      budget,
      hybridEvidence,
      monitorCounts: {
        enabled: monitors.filter((monitor) => monitor.lifecycleState === "enabled").length,
        paused: monitors.filter((monitor) => monitor.lifecycleState !== "enabled" && monitor.lifecycleState !== "retired").length,
        retired: monitors.filter((monitor) => monitor.lifecycleState === "retired").length,
        total: monitors.length,
      },
      monitors,
    };
  },
});
