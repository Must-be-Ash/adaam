import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";

import {
  eventTriggerStore,
  scheduledEventTriggerContext,
} from "../lib/event-trigger-store";

export default defineDynamic({
  events: {
    "turn.started": (_event, dynamicCtx) => {
      if (!scheduledEventTriggerContext(dynamicCtx)) return null;

      return defineTool({
        description:
          "Record that a scheduled event check found no matching event after every configured source was fetched successfully. Call exactly once only for a no-match result.",
        inputSchema: z.object({}),
        async execute(_input, ctx) {
          const scheduled = scheduledEventTriggerContext(ctx);
          if (!scheduled) {
            throw new Error("No active scheduled event-trigger run was found.");
          }
          await eventTriggerStore.markNoMatch(
            scheduled.triggerId,
            scheduled.runId,
          );
          return { completed: true, matched: false };
        },
      });
    },
  },
});
