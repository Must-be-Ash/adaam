import { defineTool } from "eve/tools";
import { z } from "zod";

import { listWorkspaceMonitors } from "../lib/workspace-monitor-store";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "List durable monitors in the current authenticated workspace. Use this before changing an ambiguous monitor reference; never guess by nearest name.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const monitors = await listWorkspaceMonitors(scope);
    return {
      count: monitors.length,
      monitors: monitors.map((monitor) => ({
        configurationRevision: monitor.configurationRevision,
        consecutiveFailures: monitor.consecutiveFailures,
        lastCompletedAt: monitor.lastCompletedAt,
        lastErrorCode: monitor.lastErrorCode,
        lastRunAt: monitor.lastRunAt,
        lifecycleState: monitor.lifecycleState,
        monitorId: monitor.monitorId,
        name: monitor.name,
        nextOccurrenceAt: monitor.nextOccurrenceAt,
        schedule: monitor.schedule,
        sourceCheckpoint: monitor.sourceCheckpoint,
        sources: monitor.sources,
        tighteningLimits: monitor.tighteningLimits,
      })),
    };
  },
});
