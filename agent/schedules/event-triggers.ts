import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import type { SessionAuthContext } from "eve/context";

import eventTriggerRunner from "../channels/event-trigger-runner";
import { startWorkspaceWorkerTask } from "../lib/eve-workspace-worker-runtime";
import {
  buildEventTriggerPrompt,
  type ClaimedEventTrigger,
  eventTriggerExecutionAuth,
  eventTriggerStore,
} from "../lib/event-trigger-store";
import {
  finishWorkspaceMonitorDispatchBudget,
  reserveWorkspaceMonitorDispatchBudget,
  type WorkspaceDispatchReservation,
} from "../lib/workspace-dispatch-budget";
import {
  claimDueWorkspaceMonitors,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  type ClaimedWorkspaceMonitor,
} from "../lib/workspace-monitor-store";
import { resolveWorkspaceRuntimeFlags } from "../lib/workspace-runtime-flags";
import {
  prepareWorkspaceWorkerRun,
  requireWorkspaceWorkerOutcome,
} from "../lib/workspace-worker-runner";

async function executeWorkspaceJob(
  job: ClaimedWorkspaceMonitor,
  budget: WorkspaceDispatchReservation,
): Promise<void> {
  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const prepared = await prepareWorkspaceWorkerRun({
      claimed: job,
      dispatchBudget: budget,
    });
    const session = await startWorkspaceWorkerTask(prepared.request);
    started = true;
    let terminalFailure = false;
    for await (const event of session.events) {
      if (event.type === "step.completed") {
        inputTokens += event.data.usage?.inputTokens ?? 0;
        outputTokens += event.data.usage?.outputTokens ?? 0;
      } else if (
        event.type === "turn.failed" ||
        event.type === "turn.cancelled" ||
        event.type === "session.failed"
      ) {
        terminalFailure = true;
      }
    }
    if (terminalFailure) throw new Error("workspace_worker_session_failed");
    await requireWorkspaceWorkerOutcome(prepared);
    await finishWorkspaceMonitorDispatchBudget(job, budget, {
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      outcome: "reconciled",
    });
  } catch (error) {
    if (started) {
      try {
        await recordWorkspaceMonitorFailure({
          errorCode:
            error instanceof Error &&
            error.message === "workspace_worker_required_outcome_missing"
              ? "worker_outcome_missing"
              : "workspace_worker_failed",
          expectedRevision: job.monitor.configurationRevision,
          monitorId: job.monitor.monitorId,
          scope: job.scope,
        });
      } catch {
        // A concurrent lifecycle/configuration edit is authoritative.
      }
      try {
        await releaseWorkspaceMonitorLease({
          leaseToken: job.leaseToken,
          monitorId: job.monitor.monitorId,
          scope: job.scope,
        });
      } catch {
        // Lease expiry recovery remains authoritative.
      }
    }
    await finishWorkspaceMonitorDispatchBudget(job, budget, {
      actualInputTokens: started ? inputTokens : undefined,
      actualOutputTokens: started ? outputTokens : undefined,
      outcome: started ? "reconciled" : "released",
    });
  }
}

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
        const admittedWorkspaceJobs = [];
        for (const job of workspaceJobs) {
          try {
            const budget = await reserveWorkspaceMonitorDispatchBudget(job, {
              now,
            });
            admittedWorkspaceJobs.push({ budget, job });
          } catch (error) {
            await releaseWorkspaceMonitorLease({
              leaseToken: job.leaseToken,
              monitorId: job.monitor.monitorId,
              scope: job.scope,
            });
            console.warn("[workspace.monitor] Dispatch admission denied", {
              code: error instanceof Error ? error.message : "budget_admission_failed",
              monitor_id: job.monitor.monitorId,
              workspace_id: job.monitor.workspaceId,
            });
          }
        }
        if (admittedWorkspaceJobs.length > 0) {
          console.info("[workspace.monitor] Dispatch budgets reserved", {
            admitted_count: admittedWorkspaceJobs.length,
          });
        }

        await Promise.all(
          admittedWorkspaceJobs.map(({ budget, job }) =>
            executeWorkspaceJob(job, budget),
          ),
        );

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
