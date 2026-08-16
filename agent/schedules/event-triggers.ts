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
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  type ClaimedWorkspaceMonitor,
} from "../lib/workspace-monitor-store";
import { resolveWorkspaceRuntimeFlags } from "../lib/workspace-runtime-flags";
import {
  emitWorkspaceRuntimeObservation,
  safeWorkspaceRuntimeErrorCode,
  type WorkspaceRuntimeErrorCode,
  type WorkspaceRuntimeObservationSink,
} from "../lib/workspace-runtime-observability";
import { recoverWorkspaceRunForControlPlane } from "../lib/workspace-worker-recovery";
import { deliverWorkspaceOutcomeToPhoton } from "../lib/workspace-alert-dispatch";
import {
  prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorkerRun,
  requireWorkspaceWorkerOutcome,
} from "../lib/workspace-worker-runner";

export interface EventTriggerScheduleDependencies {
  readonly claimEventTriggers: typeof eventTriggerStore.claimDue;
  readonly claimWorkspaceMonitors: typeof claimDueWorkspaceMonitors;
  readonly deliverWorkspaceOutcome: typeof deliverWorkspaceOutcomeToPhoton;
  readonly emitRuntimeObservation: WorkspaceRuntimeObservationSink;
  readonly executeEventTrigger: typeof executeEventTriggerJob;
  readonly finishWorkspaceBudget: typeof finishWorkspaceMonitorDispatchBudget;
  readonly getWorkspaceMonitor: typeof getWorkspaceMonitor;
  readonly inspectWorkspaceLease: typeof inspectWorkspaceMonitorOccurrenceLease;
  readonly now: () => Date;
  readonly prepareWorkspaceRecovery: typeof prepareWorkspaceWorkerRecovery;
  readonly prepareWorkspaceWorker: typeof prepareWorkspaceWorkerRun;
  readonly recordWorkspaceFailure: typeof recordWorkspaceMonitorFailure;
  readonly recoverWorkspaceOutcome: typeof recoverWorkspaceRunForControlPlane;
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
  deliverWorkspaceOutcome: deliverWorkspaceOutcomeToPhoton,
  emitRuntimeObservation: emitWorkspaceRuntimeObservation,
  executeEventTrigger: executeEventTriggerJob,
  finishWorkspaceBudget: finishWorkspaceMonitorDispatchBudget,
  getWorkspaceMonitor,
  inspectWorkspaceLease: inspectWorkspaceMonitorOccurrenceLease,
  now: () => new Date(),
  prepareWorkspaceRecovery: prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorker: prepareWorkspaceWorkerRun,
  recordWorkspaceFailure: recordWorkspaceMonitorFailure,
  recoverWorkspaceOutcome: recoverWorkspaceRunForControlPlane,
  releaseWorkspaceLease: releaseWorkspaceMonitorLease,
  requireWorkspaceOutcome: requireWorkspaceWorkerOutcome,
  reserveWorkspaceBudget: reserveWorkspaceMonitorDispatchBudget,
  resolveRuntimeFlags: resolveWorkspaceRuntimeFlags,
  startWorkspaceWorker: startWorkspaceWorkerTask,
});

function recoveryFailureCode(error: unknown): string {
  if (error instanceof Error && error.message === "finding_invalid") {
    return "worker_recovery_outcome_corrupt";
  }
  if (
    error instanceof Error &&
    (error.message === "workspace_worker_run_stale" ||
      error.message === "workspace_worker_capability_denied" ||
      error.message === "workspace_worker_state_stale" ||
      error.message === "monitor_occurrence_stale")
  ) {
    return "worker_recovery_stale";
  }
  return "worker_recovery_failed";
}

function leaseInspectionInput(job: ClaimedWorkspaceMonitor) {
  return {
    configurationRevision: job.monitor.configurationRevision,
    leaseToken: job.leaseToken,
    leaseTokenDigest: job.occurrence.leaseTokenDigest,
    monitorId: job.monitor.monitorId,
    occurrenceKey: job.occurrence.occurrenceKey,
    scope: job.scope,
  };
}

async function monitorWasSuperseded(
  job: ClaimedWorkspaceMonitor,
  dependencies: EventTriggerScheduleDependencies,
): Promise<boolean> {
  const current = await dependencies.getWorkspaceMonitor(
    job.scope,
    job.monitor.monitorId,
  );
  return (
    !current ||
    current.configurationRevision !== job.monitor.configurationRevision ||
    current.lifecycleState !== "enabled"
  );
}

async function quarantineWorkspaceRecoveryFailure(
  job: ClaimedWorkspaceMonitor,
  errorCode: string,
  dependencies: EventTriggerScheduleDependencies,
): Promise<void> {
  let quarantineError: unknown;
  try {
    await dependencies.recordWorkspaceFailure({
      errorCode,
      expectedRevision: job.monitor.configurationRevision,
      failureThreshold: 1,
      monitorId: job.monitor.monitorId,
      scope: job.scope,
    });
  } catch (error) {
    let superseded = false;
    try {
      superseded = await monitorWasSuperseded(job, dependencies);
    } catch {
      // The original quarantine write remains the authoritative failure. Still
      // attempt lease cleanup below before surfacing it to the scheduler.
    }
    if (!superseded) {
      quarantineError = error;
    }
  }

  let releaseError: unknown;
  try {
    const released = await dependencies.releaseWorkspaceLease({
      leaseToken: job.leaseToken,
      monitorId: job.monitor.monitorId,
      scope: job.scope,
    });
    if (!released) {
      const lease = await dependencies.inspectWorkspaceLease(
        leaseInspectionInput(job),
      );
      if (lease === "current") {
        releaseError = new Error("worker_recovery_lease_release_failed");
      }
    }
  } catch (error) {
    const lease = await dependencies.inspectWorkspaceLease(
      leaseInspectionInput(job),
    );
    if (lease === "current") releaseError = error;
  }
  if (quarantineError) throw quarantineError;
  if (releaseError) throw releaseError;
}

async function executeWorkspaceRecovery(
  job: ClaimedWorkspaceMonitor,
  dependencies: EventTriggerScheduleDependencies,
  deliverAlerts: boolean,
  expectedRunId?: string,
): Promise<void> {
  let failureCode = "worker_recovery_failed";
  try {
    const prepared = await dependencies.prepareWorkspaceRecovery({
      claimed: job,
      ...(expectedRunId ? { expectedRunId } : {}),
    });
    const result = await dependencies.recoverWorkspaceOutcome({ prepared });
    if (result.status === "recovered" || result.status === "already_completed") {
      if (deliverAlerts) {
        await dependencies.deliverWorkspaceOutcome({
          job,
          outcome: result.outcome,
        });
      }
      return;
    }
    failureCode = result.status === "missing"
      ? "worker_recovery_outcome_missing"
      : "worker_recovery_not_applicable";
  } catch (error) {
    failureCode = recoveryFailureCode(error);
  }
  await quarantineWorkspaceRecoveryFailure(job, failureCode, dependencies);
  dependencies.emitRuntimeObservation({
    counter: "workspace_monitor_terminal_failure_total",
    errorCode: failureCode === "worker_recovery_stale"
      ? "stale_configuration"
      : "evaluation_failed",
    value: 1,
  });
}

async function executeWorkspaceJob(
  job: ClaimedWorkspaceMonitor,
  budget: WorkspaceDispatchReservation,
  dependencies: EventTriggerScheduleDependencies,
  deliverAlerts: boolean,
): Promise<void> {
  const settled =
    budget.global.state === "settled" &&
    (budget.workspace.state === "reconciled" ||
      budget.workspace.state === "uncertain");
  if (settled) {
    // A settled reservation proves the model work is terminal, but a crash may
    // still have happened after the durable outcome and before alert/checkpoint
    // finalization. Recover that deterministic tail without another model turn.
    await executeWorkspaceRecovery(job, dependencies, deliverAlerts, budget.runId);
    return;
  }
  if (
    budget.global.state === "released" &&
    budget.workspace.state === "released"
  ) {
    // Known-not-started reservations have no model or outcome work to replay.
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
    dependencies.emitRuntimeObservation({
      counter: "workspace_monitor_started_total",
      value: 1,
    });
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
    const outcome = await dependencies.requireWorkspaceOutcome(prepared);
    if (deliverAlerts) {
      await dependencies.deliverWorkspaceOutcome({ job, outcome });
    }
    await dependencies.finishWorkspaceBudget(job, budget, {
      actualInputTokens: inputTokens,
      actualOutputTokens: outputTokens,
      outcome: "reconciled",
    });
    dependencies.emitRuntimeObservation({
      counter: "workspace_monitor_completed_total",
      value: 1,
    });
    if (outcome.outcome === "no_match") {
      dependencies.emitRuntimeObservation({
        counter: "workspace_monitor_no_match_total",
        value: 1,
      });
    }
  } catch (error) {
    dependencies.emitRuntimeObservation({
      counter: started
        ? "workspace_monitor_terminal_failure_total"
        : "workspace_monitor_retryable_failure_total",
      errorCode: safeWorkspaceRuntimeErrorCode(error, "evaluation_failed"),
      value: 1,
    });
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

async function executeEventTriggerJob(input: {
  appAuth: SessionAuthContext;
  job: ClaimedEventTrigger;
  to: ScheduleToFn;
}): Promise<void> {
  try {
    const prepared = await eventTriggerStore.prepareDispatch(input.job);
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
      await eventTriggerStore.defer(prepared, new Date(nextBudgetWindow));
      return;
    }
    await deliver(input.to, prepared, input.appAuth);
  } catch {
    await eventTriggerStore.release(input.job, {
      code: "channel_handoff_failed",
    });
  }
}

function collectScheduleFailures(
  failures: WorkspaceRuntimeErrorCode[],
  results: readonly PromiseSettledResult<unknown>[],
  fallback: WorkspaceRuntimeErrorCode,
): void {
  for (const result of results) {
    if (result.status !== "rejected") continue;
    failures.push(safeWorkspaceRuntimeErrorCode(result.reason, fallback));
  }
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
        const scheduleFailures: WorkspaceRuntimeErrorCode[] = [];
        const [eventTriggerClaim, workspaceClaim] = await Promise.allSettled([
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
        collectScheduleFailures(
          scheduleFailures,
          [eventTriggerClaim],
          "storage_unavailable",
        );
        collectScheduleFailures(
          scheduleFailures,
          [workspaceClaim],
          "storage_unavailable",
        );
        if (workspaceClaim.status === "rejected") {
          dependencies.emitRuntimeObservation({
            counter: "workspace_monitor_retryable_failure_total",
            errorCode: safeWorkspaceRuntimeErrorCode(
              workspaceClaim.reason,
              "storage_unavailable",
            ),
            value: 1,
          });
        }
        const jobs = eventTriggerClaim.status === "fulfilled"
          ? eventTriggerClaim.value
          : [];
        const workspaceJobs = workspaceClaim.status === "fulfilled"
          ? workspaceClaim.value
          : [];
        if (workspaceJobs.length > 0) {
          dependencies.emitRuntimeObservation({
            counter: "workspace_monitor_claimed_total",
            value: workspaceJobs.length,
          });
        }
        const recoveryJobs = workspaceJobs.filter(
          (job) => job.occurrence.attempt > 1,
        );
        const firstAttemptJobs = workspaceJobs.filter(
          (job) => job.occurrence.attempt === 1,
        );
        collectScheduleFailures(
          scheduleFailures,
          await Promise.allSettled(
            recoveryJobs.map((job) =>
              executeWorkspaceRecovery(job, dependencies, flags.photonAlerts)
            ),
          ),
          "schedule_job_failed",
        );

        const admittedWorkspaceJobs = [];
        for (const job of firstAttemptJobs) {
          try {
            const budget = await dependencies.reserveWorkspaceBudget(job, {
              now,
            });
            admittedWorkspaceJobs.push({ budget, job });
          } catch (error) {
            try {
              await dependencies.releaseWorkspaceLease({
                leaseToken: job.leaseToken,
                monitorId: job.monitor.monitorId,
                scope: job.scope,
              });
            } catch (releaseError) {
              const errorCode = safeWorkspaceRuntimeErrorCode(
                releaseError,
                "storage_unavailable",
              );
              scheduleFailures.push(errorCode);
              dependencies.emitRuntimeObservation({
                counter: "workspace_monitor_retryable_failure_total",
                errorCode,
                value: 1,
              });
            }
            const errorCode = safeWorkspaceRuntimeErrorCode(
              error,
              "storage_unavailable",
            );
            dependencies.emitRuntimeObservation({
              counter: errorCode === "run_budget_exhausted"
                ? "workspace_monitor_budget_deferred_total"
                : "workspace_monitor_retryable_failure_total",
              errorCode,
              value: 1,
            });
          }
        }

        collectScheduleFailures(
          scheduleFailures,
          await Promise.allSettled(
            admittedWorkspaceJobs.map(({ budget, job }) =>
              executeWorkspaceJob(
                job,
                budget,
                dependencies,
                flags.photonAlerts,
              )
            ),
          ),
          "schedule_job_failed",
        );

        collectScheduleFailures(
          scheduleFailures,
          await Promise.allSettled(
            jobs.map((job) =>
              dependencies.executeEventTrigger({ appAuth, job, to })
            ),
          ),
          "schedule_job_failed",
        );
        if (scheduleFailures.length > 0) {
          throw new AggregateError(
            scheduleFailures.map((code) => new Error(code)),
            "schedule_job_failed",
          );
        }
        })(),
      );
    },
  });
}

export default createEventTriggerSchedule();
