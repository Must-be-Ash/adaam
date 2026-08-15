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

export interface EventTriggerScheduleDependencies {
  readonly claimEventTriggers: typeof eventTriggerStore.claimDue;
  readonly claimWorkspaceMonitors: typeof claimDueWorkspaceMonitors;
  readonly finishWorkspaceBudget: typeof finishWorkspaceMonitorDispatchBudget;
  readonly now: () => Date;
  readonly prepareWorkspaceWorker: typeof prepareWorkspaceWorkerRun;
  readonly recordWorkspaceFailure: typeof recordWorkspaceMonitorFailure;
  readonly releaseWorkspaceLease: typeof releaseWorkspaceMonitorLease;
  readonly requireWorkspaceOutcome: typeof requireWorkspaceWorkerOutcome;
  readonly reserveWorkspaceBudget: typeof reserveWorkspaceMonitorDispatchBudget;
  readonly resolveRuntimeFlags: typeof resolveWorkspaceRuntimeFlags;
  readonly startWorkspaceWorker: typeof startWorkspaceWorkerTask;
}

const productionDependencies: EventTriggerScheduleDependencies = Object.freeze({
  claimEventTriggers: (...args: Parameters<typeof eventTriggerStore.claimDue>) =>
    eventTriggerStore.claimDue(...args),
  claimWorkspaceMonitors: claimDueWorkspaceMonitors,
  finishWorkspaceBudget: finishWorkspaceMonitorDispatchBudget,
  now: () => new Date(),
  prepareWorkspaceWorker: prepareWorkspaceWorkerRun,
  recordWorkspaceFailure: recordWorkspaceMonitorFailure,
  releaseWorkspaceLease: releaseWorkspaceMonitorLease,
  requireWorkspaceOutcome: requireWorkspaceWorkerOutcome,
  reserveWorkspaceBudget: reserveWorkspaceMonitorDispatchBudget,
  resolveRuntimeFlags: resolveWorkspaceRuntimeFlags,
  startWorkspaceWorker: startWorkspaceWorkerTask,
});

async function executeWorkspaceJob(
  job: ClaimedWorkspaceMonitor,
  budget: WorkspaceDispatchReservation,
  dependencies: EventTriggerScheduleDependencies,
): Promise<void> {
  if (
    (budget.global.state === "settled" &&
      (budget.workspace.state === "reconciled" ||
        budget.workspace.state === "uncertain")) ||
    (budget.global.state === "released" &&
      budget.workspace.state === "released")
  ) {
    // A redelivered schedule occurrence may observe the exact reservation
    // after it was already settled/released. Its durable outcome is
    // authoritative; starting another model turn would duplicate work and
    // produce different token usage for the same reservation identity.
    return;
  }
  let started = false;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const prepared = await dependencies.prepareWorkspaceWorker({
      claimed: job,
      dispatchBudget: budget,
    });
    const session = await dependencies.startWorkspaceWorker(prepared.request);
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
    await dependencies.requireWorkspaceOutcome(prepared);
    await dependencies.finishWorkspaceBudget(job, budget, {
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      outcome: "reconciled",
    });
  } catch (error) {
    if (started) {
      try {
        await dependencies.recordWorkspaceFailure({
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
        await dependencies.releaseWorkspaceLease({
          leaseToken: job.leaseToken,
          monitorId: job.monitor.monitorId,
          scope: job.scope,
        });
      } catch {
        // Lease expiry recovery remains authoritative.
      }
    }
    await dependencies.finishWorkspaceBudget(job, budget, {
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

export function createEventTriggerSchedule(
  overrides: Partial<EventTriggerScheduleDependencies> = {},
) {
  const dependencies = Object.freeze({
    ...productionDependencies,
    ...overrides,
  });
  return defineSchedule({
    cron: "* * * * *",
    run({ to, waitUntil, appAuth }) {
      waitUntil(
        (async () => {
        const now = dependencies.now();
        const flags = dependencies.resolveRuntimeFlags();
        const [jobs, workspaceJobs] = await Promise.all([
          dependencies.claimEventTriggers({
            now,
            limit: 10,
            leaseForMs: 2 * 60 * 60_000,
          }),
          flags.dispatch
            ? dependencies.claimWorkspaceMonitors({
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
            const budget = await dependencies.reserveWorkspaceBudget(job, {
              now,
            });
            admittedWorkspaceJobs.push({ budget, job });
          } catch (error) {
            await dependencies.releaseWorkspaceLease({
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
            executeWorkspaceJob(job, budget, dependencies),
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
}

export default createEventTriggerSchedule();
