import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  getWorkspaceMonitor,
  updateWorkspaceMonitor,
} from "../lib/workspace-monitor-store";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export const manageWorkspaceMonitorInputSchema = z.object({
  action: z.enum(["pause", "resume", "retire"]),
  expectedRevision: z.number().int().positive(),
  monitorId: z.string().uuid(),
}).strict();

export default defineTool({
  description:
    "Pause, resume, or recoverably retire one exact monitor ID in the current authenticated workspace. List monitors first when the reference is ambiguous.",
  inputSchema: manageWorkspaceMonitorInputSchema,
  async execute(input, ctx) {
    requireWorkspaceMonitorWrites();
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const monitor = await getWorkspaceMonitor(scope, input.monitorId);
    if (!monitor) throw new Error("monitor_not_found");
    if (monitor.configurationRevision !== input.expectedRevision) {
      throw new Error("monitor_conflict");
    }
    const now = new Date();
    if (input.action === "resume") {
      const next = nextWorkspaceMonitorOccurrence(monitor.schedule, now);
      if (!next) throw new Error("monitor_schedule_complete");
      return {
        monitor: await updateWorkspaceMonitor({
          expectedRevision: input.expectedRevision,
          monitorId: input.monitorId,
          now,
          patch: {
            lastErrorCode: null,
            lifecycleState: "enabled",
            nextOccurrenceAt: next.scheduledAt,
            pauseReason: null,
            pausedAt: null,
          },
          scope,
        }),
      };
    }
    return {
      monitor: await updateWorkspaceMonitor({
        expectedRevision: input.expectedRevision,
        monitorId: input.monitorId,
        now,
        patch: {
          lifecycleState: input.action === "pause" ? "paused" : "retired",
          nextOccurrenceAt: null,
          pauseReason: input.action === "pause" ? "owner_paused" : "owner_retired",
          pausedAt: now.toISOString(),
        },
        scope,
      }),
    };
  },
});
