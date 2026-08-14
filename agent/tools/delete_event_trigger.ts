import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { eventTriggerStore } from "../lib/event-trigger-store";

export default defineTool({
  description:
    "Legacy compatibility only: permanently delete an old event trigger. New workspace monitors use recoverable retirement through manage_workspace_monitor. List legacy triggers first when the reference is ambiguous.",
  inputSchema: z.object({
    id: z.string().uuid(),
  }),
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason: "Scheduled runs cannot delete event triggers.",
        }
      : "user-approval",
  async execute({ id }, ctx) {
    return {
      deleted: await eventTriggerStore.delete(
        requireEventTriggerOwner(ctx),
        id,
      ),
      id,
    };
  },
});
