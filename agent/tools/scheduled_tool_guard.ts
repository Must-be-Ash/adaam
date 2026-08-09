import { defineDynamic, defineTool } from "eve/tools";
import { webFetch } from "eve/tools/defaults";
import { z } from "zod";

import {
  assertScheduledSourceAllowed,
  markScheduledSourceSuccess,
  reserveScheduledSourceAttempt,
  scheduledEventTriggerContext,
} from "../lib/event-trigger-store";

const blockedInput = z.object({}).passthrough();
const webFetchInput = z.object({ url: z.string().url() }).passthrough();

function scheduledTools() {
  return {
        web_fetch: defineTool({
          ...webFetch,
          async execute(input, toolCtx) {
            const parsed = webFetchInput.parse(input);
            const scope = await assertScheduledSourceAllowed(toolCtx, {
              url: parsed.url,
            });
            await reserveScheduledSourceAttempt(scope);
            const result = await webFetch.execute(input, toolCtx);
            if (
              typeof result === "object" &&
              result !== null &&
              Reflect.get(result, "truncated") === true
            ) {
              throw new Error(
                "The configured page was truncated and cannot advance the event-trigger watermark.",
              );
            }
            await markScheduledSourceSuccess(scope);
            return result;
          },
        }),
        web_search: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "Web search is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        bash: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "Shell access is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        read_file: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "File access is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        write_file: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "File access is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        glob: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "File access is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        grep: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "File access is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
        todo: defineTool({
          description:
            "Unavailable during isolated scheduled public-feed evaluation.",
          inputSchema: blockedInput,
          execute() {
            throw new Error(
              "Todo management is unavailable during scheduled public-feed evaluation.",
            );
          },
        }),
  };
}

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      scheduledEventTriggerContext(ctx) ? scheduledTools() : null,
    "step.started": (_event, ctx) =>
      scheduledEventTriggerContext(ctx) ? scheduledTools() : null,
  },
});
