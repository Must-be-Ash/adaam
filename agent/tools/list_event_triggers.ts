import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { eventTriggerStore } from "../lib/event-trigger-store";

export default defineTool({
  description:
    "List the current user's event triggers, including cadence, next run, status, sources, and latest execution state. Use this before changing an ambiguous trigger.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const triggers = await eventTriggerStore.list(
      requireEventTriggerOwner(ctx),
    );
    return {
      triggers,
      count: triggers.length,
    };
  },
});
