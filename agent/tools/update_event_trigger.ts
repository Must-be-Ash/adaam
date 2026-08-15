import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { eventTriggerStore } from "../lib/event-trigger-store";
import {
  WORKSPACE_MONITOR_SOURCE_LIMIT,
  WORKSPACE_MONITOR_SOURCE_LIMIT_CODE,
} from "../lib/workspace-monitor-input";

export const updateEventTriggerInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
    instruction: z.string().trim().min(1).max(8_000).optional(),
    sourceIds: z.array(z.string().trim().min(1)).max(WORKSPACE_MONITOR_SOURCE_LIMIT).optional(),
    sourceUrls: z.array(z.string().url().max(2_048)).max(WORKSPACE_MONITOR_SOURCE_LIMIT).optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    nextRunAt: z.string().datetime({ offset: true }).optional(),
    everyMinutes: z
      .number()
      .int()
      .min(15)
      .max(525_600)
      .nullable()
      .optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (
      (input.sourceIds?.length ?? 0) + (input.sourceUrls?.length ?? 0) >
      WORKSPACE_MONITOR_SOURCE_LIMIT
    ) {
      context.addIssue({ code: "custom", message: WORKSPACE_MONITOR_SOURCE_LIMIT_CODE });
    }
  })
  .refine(
    ({ id: _id, ...patch }) =>
      Object.values(patch).some((value) => value !== undefined),
    { message: "Provide at least one event-trigger change." },
  );

export default defineTool({
  description:
    "Change, pause, or resume one of the current user's event triggers. List triggers first when the user's reference is ambiguous.",
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason: "Scheduled runs cannot update event triggers.",
        }
      : "not-applicable",
  inputSchema: updateEventTriggerInputSchema,
  async execute({ id, nextRunAt, ...patch }, ctx) {
    const parsedNextRunAt = nextRunAt ? new Date(nextRunAt) : undefined;
    if (parsedNextRunAt && parsedNextRunAt.getTime() < Date.now() - 2 * 60_000) {
      throw new Error(
        "nextRunAt is in the past. Use the current time for an immediate check.",
      );
    }

    return {
      trigger: await eventTriggerStore.update(
        requireEventTriggerOwner(ctx),
        id,
        {
          ...patch,
          ...(parsedNextRunAt
            ? {
                nextRunAt:
                  parsedNextRunAt.getTime() < Date.now()
                    ? new Date()
                    : parsedNextRunAt,
              }
            : {}),
        },
      ),
    };
  },
});
