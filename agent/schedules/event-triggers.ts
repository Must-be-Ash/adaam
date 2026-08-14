import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import type { SessionAuthContext } from "eve/context";

import eventTriggerRunner from "../channels/event-trigger-runner";
import {
  buildEventTriggerPrompt,
  type ClaimedEventTrigger,
  eventTriggerExecutionAuth,
  eventTriggerStore,
} from "../lib/event-trigger-store";
import { claimDueWorkspaceMonitors } from "../lib/workspace-monitor-store";
import { resolveWorkspaceRuntimeFlags } from "../lib/workspace-runtime-flags";

async function deliver(
  to: ScheduleToFn,
  job: ClaimedEventTrigger,
  appAuth: SessionAuthContext,
): Promise<void> {
  const prompt = buildEventTriggerPrompt(job.record, job.windowEndAtMs);
  const auth = eventTriggerExecutionAuth(appAuth, job);

  await to(eventTriggerRunner, {
    triggerId: job.id,
    runId: job.runId,
  }).send(prompt, { auth });
}

export default defineSchedule({
  cron: "* * * * *",
  run({ to, waitUntil, appAuth }) {
    waitUntil(
      (async () => {
        const now = new Date();
        const flags = resolveWorkspaceRuntimeFlags();
        const [jobs, workspaceJobs] = await Promise.all([
          eventTriggerStore.claimDue({
            now,
            limit: 10,
            leaseForMs: 2 * 60 * 60_000,
          }),
          flags.dispatch
            ? claimDueWorkspaceMonitors({
                leaseForMs: 30 * 60_000,
                limit: 10,
                now,
                recoveryWindowMs: 6 * 60 * 60_000,
              })
            : Promise.resolve([]),
        ]);
        if (workspaceJobs.length > 0) {
          console.info("[workspace.monitor] Minute claim pass completed", {
            claim_count: workspaceJobs.length,
          });
        }

        await Promise.all(
          jobs.map(async (job) => {
            try {
              const prepared = await eventTriggerStore.prepareDispatch(job);
              if (!prepared) return;
              if (!(await eventTriggerStore.reserveDailyBudget(prepared))) {
                const now = new Date();
                const nextBudgetWindow =
                  Date.UTC(
                    now.getUTCFullYear(),
                    now.getUTCMonth(),
                    now.getUTCDate() + 1,
                  ) +
                  5 * 60_000 +
                  Math.floor(Math.random() * 30 * 60_000);
                await eventTriggerStore.defer(
                  prepared,
                  new Date(nextBudgetWindow),
                );
                return;
              }
              await deliver(to, prepared, appAuth);
            } catch {
              await eventTriggerStore.release(job, {
                code: "channel_handoff_failed",
              });
            }
          }),
        );
      })(),
    );
  },
});
