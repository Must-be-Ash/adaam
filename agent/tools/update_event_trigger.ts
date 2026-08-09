import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { eventTriggerStore } from "../lib/event-trigger-store";

const updateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(160).optional(),
    instruction: z.string().trim().min(1).max(8_000).optional(),
    sourceIds: z.array(z.string().trim().min(1)).max(20).optional(),
    sourceUrls: z.array(z.string().url().max(2_048)).max(20).optional(),
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
  inputSchema: updateSchema,
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
