import { defineChannel, POST } from "eve/channels";
import type { SessionContext } from "eve/context";

import {
  eventTriggerStore,
  scheduledEventTriggerContext,
} from "../lib/event-trigger-store";

async function settle(
  ctx: SessionContext,
  outcome: "completed" | "failed",
): Promise<void> {
  const scheduled = scheduledEventTriggerContext(ctx);
  if (scheduled) {
    try {
      await eventTriggerStore.settleRun(
        scheduled.triggerId,
        scheduled.runId,
        outcome,
      );
    } catch {
      // The dispatcher requeues an expired in-flight lease.
    }
  }
  try {
    await eventTriggerStore.clearRunSession(ctx.session.id);
  } catch {
    // The session mapping expires automatically.
  }
}

export default defineChannel<
  undefined,
  void,
  { triggerId: string; runId: string }
>({
  routes: [
    POST("/eve/v1/internal/event-trigger-runner", () =>
      Promise.resolve(new Response(null, { status: 404 })),
    ),
  ],
  async receive(input, ctx) {
    const session = await ctx.from(
      `${input.target.triggerId}:${input.target.runId}`,
    ).send(
      input.message,
      {
        auth: input.auth,
        mode: "task",
      },
    );
    await eventTriggerStore.registerRunSession(
      session.id,
      input.target.triggerId,
      input.target.runId,
    );
    return session;
  },
  events: {
    async "turn.completed"(_event, _channel, ctx) {
      await settle(ctx, "completed");
    },
    async "turn.failed"(_event, _channel, ctx) {
      await settle(ctx, "failed");
    },
    async "turn.cancelled"(_event, _channel, ctx) {
      await settle(ctx, "failed");
    },
    async "session.failed"(event) {
      try {
        await eventTriggerStore.settleRunBySessionId(
          event.sessionId,
          "failed",
        );
      } catch {
        // The dispatcher requeues an expired in-flight lease.
      }
    },
  },
});
