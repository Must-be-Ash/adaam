import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { eventTriggerStore } from "../lib/event-trigger-store";
import {
  WORKSPACE_MONITOR_SOURCE_LIMIT,
  WORKSPACE_MONITOR_SOURCE_LIMIT_CODE,
} from "../lib/workspace-monitor-input";

const MAX_FUTURE_MS = 89 * 24 * 60 * 60 * 1_000;

export const createEventTriggerInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  instruction: z.string().trim().min(1).max(8_000).describe(
    "A precise, evidence-based condition describing which new events should generate an alert.",
  ),
  sourceIds: z.array(z.string().trim().min(1))
    .max(WORKSPACE_MONITOR_SOURCE_LIMIT)
    .default([])
    .describe("IDs of fixed feeds returned by list_public_sources."),
  sourceUrls: z.array(z.string().url().max(2_048))
    .max(WORKSPACE_MONITOR_SOURCE_LIMIT)
    .default([])
    .describe("Exact official HTTPS URLs for issuer IR pages or resolved source templates."),
  timezone: z.string().trim().min(1).max(80).describe(
    "The user's IANA time zone, such as America/Vancouver.",
  ),
  firstRunAt: z.string().datetime({ offset: true }).describe(
    "ISO 8601 date-time with an explicit UTC offset.",
  ),
  everyMinutes: z.number().int().min(15).max(525_600).nullable().default(null)
    .describe("Recurring interval, or null for a one-time check."),
}).superRefine((input, context) => {
  if (input.sourceIds.length + input.sourceUrls.length > WORKSPACE_MONITOR_SOURCE_LIMIT) {
    context.addIssue({ code: "custom", message: WORKSPACE_MONITOR_SOURCE_LIMIT_CODE });
  }
});

export default defineTool({
  description:
    "Create a one-time or recurring public-event trigger for the current iMessage or Telegram conversation. The trigger checks only the configured official sources and stays silent unless a new event matches.",
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason: "Scheduled runs cannot create event triggers.",
        }
      : "not-applicable",
  inputSchema: createEventTriggerInputSchema,
  async execute(input, ctx) {
    const now = Date.now();
    const requested = new Date(input.firstRunAt);
    if (requested.getTime() < now - 2 * 60_000) {
      throw new Error(
        "firstRunAt is in the past. Use the current time for an immediate check.",
      );
    }
    if (requested.getTime() > now + MAX_FUTURE_MS) {
      throw new Error(
        "firstRunAt must be within the trigger's 90-day lifetime.",
      );
    }

    const trigger = await eventTriggerStore.create(
      requireEventTriggerOwner(ctx),
      {
        ...input,
        idempotencyKey: ctx.callId,
        firstRunAt: requested.getTime() < now ? new Date(now) : requested,
      },
    );

    return {
      trigger,
      note:
        trigger.everyMinutes === null
          ? "This is a one-time check and will disable itself after a successful run."
          : "This trigger repeats until it is paused, deleted, or reaches its 90-day expiry.",
    };
  },
});
