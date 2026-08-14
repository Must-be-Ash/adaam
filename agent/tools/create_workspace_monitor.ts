import { defineTool } from "eve/tools";
import { z } from "zod";

import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  createWorkspaceMonitor,
  workspaceMonitorScheduleSchema,
} from "../lib/workspace-monitor-store";
import { workspaceMonitorCreateSourcesSchema } from "../lib/workspace-monitor-input";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export const createWorkspaceMonitorInputSchema = z.object({
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  instruction: z.string().trim().min(1).max(8_000),
  name: z.string().trim().min(1).max(160),
  requiredCapabilityIds: z.array(z.string().trim().min(1).max(160)).max(32).default([]),
  schedule: workspaceMonitorScheduleSchema,
  sources: workspaceMonitorCreateSourcesSchema,
  tighteningLimits: z.object({
    inputTokensPerRun: z.number().int().positive().nullable().default(null),
    outputTokensPerRun: z.number().int().positive().nullable().default(null),
    paidPerRun: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u).nullable().default(null),
  }).strict().default({
    inputTokensPerRun: null,
    outputTokensPerRun: null,
    paidPerRun: null,
  }),
}).strict();

export default defineTool({
  description:
    "Create a durable monitor in the current authenticated workspace. Sources are exact and limited to eight combined entries.",
  inputSchema: createWorkspaceMonitorInputSchema,
  async execute(input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const now = new Date();
    const next = nextWorkspaceMonitorOccurrence(input.schedule, now);
    if (input.schedule.kind === "one_time" && !next) {
      throw new Error("monitor_schedule_invalid");
    }
    return {
      monitor: await createWorkspaceMonitor({
        ...input,
        deliverySubscriptionId: runtimeScope.conversationId,
        nextOccurrenceAt: next?.scheduledAt ?? null,
        now,
        scope,
      }),
    };
  },
});
