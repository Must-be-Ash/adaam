import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  getWorkspaceMonitor,
  updateWorkspaceMonitor,
  workspaceMonitorScheduleSchema,
} from "../lib/workspace-monitor-store";
import {
  workspaceMonitorSourceSchema,
  workspaceMonitorSourcesSchema,
  workspaceMonitorUpdateSourcesSchema,
  type WorkspaceMonitorSourceInput,
} from "../lib/workspace-monitor-input";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export const updateWorkspaceMonitorInputSchema = z.object({
  addDailyTimes: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)).min(1).max(16).optional(),
  addSources: z.array(workspaceMonitorSourceSchema).min(1).max(8).optional(),
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

export function mergeWorkspaceMonitorDailyTimes(
  schedule: z.infer<typeof workspaceMonitorScheduleSchema>,
  additions: readonly string[],
) {
  if (schedule.kind !== "daily_local") {
    throw new Error("monitor_additive_schedule_requires_daily_local");
  }
  return workspaceMonitorScheduleSchema.parse({
    ...schedule,
    times: [...new Set([...schedule.times, ...additions])].sort(),
  });
}

export function mergeWorkspaceMonitorSources(
  current: readonly WorkspaceMonitorSourceInput[],
  additions: readonly WorkspaceMonitorSourceInput[],
) {
  return workspaceMonitorSourcesSchema.parse([...current, ...additions]);
}

export default defineTool({
  description:
    "Update an exact monitor ID in the current authenticated workspace using its current configuration revision.",
  inputSchema: updateWorkspaceMonitorInputSchema,
  async execute({ addDailyTimes, addSources, expectedRevision, monitorId, schedule, ...patch }, ctx) {
    requireWorkspaceMonitorWrites();
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const now = new Date();
    const current = addDailyTimes || addSources
      ? await getWorkspaceMonitor(scope, monitorId)
      : null;
    if ((addDailyTimes || addSources) && !current) throw new Error("monitor_not_found");
    if (addDailyTimes && schedule) throw new Error("monitor_schedule_change_conflict");
    if (addSources && patch.sources) throw new Error("monitor_source_change_conflict");
    const effectiveSchedule = addDailyTimes
      ? mergeWorkspaceMonitorDailyTimes(current!.schedule, addDailyTimes)
      : schedule;
    const effectiveSources = addSources
      ? mergeWorkspaceMonitorSources(current!.sources, addSources)
      : patch.sources;
    const next = effectiveSchedule ? nextWorkspaceMonitorOccurrence(effectiveSchedule, now) : undefined;
    if (effectiveSchedule?.kind === "one_time" && !next) {
      throw new Error("monitor_schedule_invalid");
    }
    return {
      monitor: await updateWorkspaceMonitor({
        expectedRevision,
        monitorId,
        now,
        patch: {
          ...patch,
          ...(effectiveSources ? { sources: effectiveSources } : {}),
          ...(effectiveSchedule
            ? { nextOccurrenceAt: next?.scheduledAt ?? null, schedule: effectiveSchedule }
            : {}),
        },
        scope,
      }),
    };
  },
});
