import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  updateWorkspaceMonitor,
  workspaceMonitorScheduleSchema,
} from "../lib/workspace-monitor-store";
import { workspaceMonitorUpdateSourcesSchema } from "../lib/workspace-monitor-input";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export const updateWorkspaceMonitorInputSchema = z.object({
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  expectedRevision: z.number().int().positive(),
  instruction: z.string().trim().min(1).max(8_000).optional(),
  monitorId: z.string().uuid(),
  name: z.string().trim().min(1).max(160).optional(),
  requiredCapabilityIds: z.array(z.string().trim().min(1).max(160)).max(32).optional(),
  schedule: workspaceMonitorScheduleSchema.optional(),
  sources: workspaceMonitorUpdateSourcesSchema.optional(),
  tighteningLimits: z.object({
    inputTokensPerRun: z.number().int().positive().nullable(),
    outputTokensPerRun: z.number().int().positive().nullable(),
    paidPerRun: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u).nullable(),
  }).strict().optional(),
}).strict().refine(
  ({ expectedRevision: _expectedRevision, monitorId: _monitorId, ...patch }) =>
    Object.values(patch).some((value) => value !== undefined),
  { message: "monitor_update_empty" },
);

export default defineTool({
  description:
    "Update an exact monitor ID in the current authenticated workspace using its current configuration revision.",
  inputSchema: updateWorkspaceMonitorInputSchema,
  async execute({ expectedRevision, monitorId, schedule, ...patch }, ctx) {
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const now = new Date();
    const next = schedule ? nextWorkspaceMonitorOccurrence(schedule, now) : undefined;
    if (schedule?.kind === "one_time" && !next) {
      throw new Error("monitor_schedule_invalid");
    }
    return {
      monitor: await updateWorkspaceMonitor({
        expectedRevision,
        monitorId,
        now,
        patch: {
          ...patch,
          ...(schedule
            ? { nextOccurrenceAt: next?.scheduledAt ?? null, schedule }
            : {}),
        },
        scope,
      }),
    };
  },
});
