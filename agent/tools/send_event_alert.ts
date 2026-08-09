import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import { photonBot } from "../channels/photon";
import {
  eventTriggerStore,
  scheduledEventTriggerContext,
} from "../lib/event-trigger-store";

const inputSchema = z.object({
  event: z.string().min(1).max(300),
  whyMatched: z.string().min(1).max(700),
  companyOrTicker: z.string().min(1).max(100).optional(),
  publishedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  sourceUrls: z.array(z.string().url().max(700)).min(1).max(3),
});

function safeAlertText(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/[[\]<>`]/gu, "")
    .replace(/\b[a-z][a-z0-9+.-]{1,20}:\S+/giu, "[link omitted]")
    .replace(
      /\b(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}(?:\/\S*)?/giu,
      "[link omitted]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/\S*)?/gu, "[link omitted]")
    .replace(/@[a-z0-9_]{2,}/giu, "[mention omitted]")
    .replace(/#[\p{L}\p{N}_]{2,}/giu, "[tag omitted]")
    .trim();
}

function formatAlert(input: z.infer<typeof inputSchema>): string {
  return [
    `Event alert: ${safeAlertText(input.event)}`,
    input.companyOrTicker
      ? `Company/ticker: ${safeAlertText(input.companyOrTicker)}`
      : undefined,
    `Published: ${input.publishedAt}`,
    input.updatedAt ? `Updated: ${input.updatedAt}` : undefined,
    `Why it matched: ${safeAlertText(input.whyMatched)}`,
    "Sources:",
    ...input.sourceUrls,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function postTelegramAlert(
  destination: {
    chatId: string;
    messageThreadId?: number;
  },
  message: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Telegram delivery is not configured.");

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: destination.chatId,
        text: message,
        ...(destination.messageThreadId
          ? { message_thread_id: destination.messageThreadId }
          : {}),
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Telegram alert delivery failed with HTTP ${response.status}.`);
  }
}

export default defineDynamic({
  events: {
    "turn.started": (_event, dynamicCtx) => {
      if (!scheduledEventTriggerContext(dynamicCtx)) return null;

      return defineTool({
        description:
          "Deliver one structured matched-event alert to the conversation that owns the active scheduled trigger. Source links must use configured-source origins. Call exactly once and only after every configured source was fetched successfully.",
        inputSchema,
        async execute(input, ctx) {
          const scheduled = scheduledEventTriggerContext(ctx);
          if (!scheduled) {
            throw new Error("No active scheduled event-trigger run was found.");
          }
          const job = await eventTriggerStore.beginDelivery(
            scheduled.triggerId,
            scheduled.runId,
          );
          if (!job) {
            throw new Error(
              "The trigger changed, expired, or has incomplete source coverage. No alert was sent.",
            );
          }

          let deliveryAttempted = false;
          try {
            await eventTriggerStore.validateAlertSourceUrls(
              scheduled.triggerId,
              scheduled.runId,
              input.sourceUrls,
              input.updatedAt ?? input.publishedAt,
            );
            const message = formatAlert(input);
            if (message.length > 3_900) {
              throw new Error("The structured alert exceeds the delivery limit.");
            }
            if (job.record.destination.kind === "photon") {
              deliveryAttempted = true;
              const { adapterName, threadId } = job.record.destination;
              const qualifiedThreadId = threadId.startsWith(`${adapterName}:`)
                ? threadId
                : `${adapterName}:${threadId}`;
              await photonBot.thread(qualifiedThreadId).post({
                markdown: message,
              });
            } else {
              deliveryAttempted = true;
              await postTelegramAlert(job.record.destination, message);
            }
            await eventTriggerStore.markDeliverySucceeded(
              job.id,
              job.runId,
              job.windowEndAtMs,
            );
          } catch (error) {
            if (!deliveryAttempted) {
              await eventTriggerStore.abortDelivery(job.id, job.runId);
            }
            throw error;
          }

          return { delivered: true };
        },
      });
    },
  },
});
