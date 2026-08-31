import { defineSchedule, type ScheduleToFn } from "eve/schedules";
import type { SessionAuthContext } from "eve/context";

import eventTriggerRunner from "../channels/event-trigger-runner";
import { runWorkspaceEvaluatorForMonitor } from "../lib/workspace-evaluator-dispatch";
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
  updateWorkspaceMonitor,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
} from "../lib/workspace-monitor-store";
import { resolveManagedMonitorLifecycleContract } from "../lib/workspace-monitor-lifecycle-contract";
import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import { resolveWorkspaceRuntimeFlags } from "../lib/workspace-runtime-flags";
import {
  emitWorkspaceRuntimeObservation,
  safeWorkspaceRuntimeErrorCode,
  type WorkspaceRuntimeErrorCode,
  type WorkspaceRuntimeObservationSink,
} from "../lib/workspace-runtime-observability";
import { recoverWorkspaceRunForControlPlane } from "../lib/workspace-worker-recovery";
import {
  clearEarningsCallSourceRetry,
  readEarningsCallSourceRetry,
} from "../lib/earnings-call-source-lifecycle-store";
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
  readonly deferWorkspaceBudget: typeof deferWorkspaceMonitorForBudget;
  readonly emitRuntimeObservation: WorkspaceRuntimeObservationSink;
  readonly executeEventTrigger: typeof executeEventTriggerJob;
  readonly finishWorkspaceBudget: typeof finishWorkspaceMonitorDispatchBudget;
  readonly getWorkspaceMonitor: typeof getWorkspaceMonitor;
  readonly inspectWorkspaceLease: typeof inspectWorkspaceMonitorOccurrenceLease;
  readonly now: () => Date;
  readonly prepareWorkspaceRecovery: typeof prepareWorkspaceWorkerRecovery;
  readonly prepareWorkspaceWorker: typeof prepareWorkspaceWorkerRun;
  readonly clearWorkspaceSourceRetry: typeof clearEarningsCallSourceRetry;
  readonly readWorkspaceSourceRetry: typeof readEarningsCallSourceRetry;
  readonly recordWorkspaceFailure: typeof recordWorkspaceMonitorFailure;
  readonly recoverWorkspaceOutcome: typeof recoverWorkspaceRunForControlPlane;
  readonly releaseWorkspaceLease: typeof releaseWorkspaceMonitorLease;
  readonly requireWorkspaceOutcome: typeof requireWorkspaceWorkerOutcome;
  readonly reserveWorkspaceBudget: typeof reserveWorkspaceMonitorDispatchBudget;
  readonly resolveRuntimeFlags: typeof resolveWorkspaceRuntimeFlags;
  readonly runWorkspaceEvaluator: typeof runWorkspaceEvaluatorForMonitor;
}

const productionDependencies: EventTriggerScheduleDependencies = Object.freeze({
  claimEventTriggers: (...args: Parameters<typeof eventTriggerStore.claimDue>) =>
    eventTriggerStore.claimDue(...args),
  claimWorkspaceMonitors: claimDueWorkspaceMonitors,
  deliverWorkspaceOutcome: deliverWorkspaceOutcomeToPhoton,
  deferWorkspaceBudget: deferWorkspaceMonitorForBudget,
  emitRuntimeObservation: emitWorkspaceRuntimeObservation,
  executeEventTrigger: executeEventTriggerJob,
  finishWorkspaceBudget: finishWorkspaceMonitorDispatchBudget,
  getWorkspaceMonitor,
  inspectWorkspaceLease: inspectWorkspaceMonitorOccurrenceLease,
  now: () => new Date(),
  prepareWorkspaceRecovery: prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorker: prepareWorkspaceWorkerRun,
  clearWorkspaceSourceRetry: clearEarningsCallSourceRetry,
  readWorkspaceSourceRetry: readEarningsCallSourceRetry,
  recordWorkspaceFailure: recordWorkspaceMonitorFailure,
  recoverWorkspaceOutcome: recoverWorkspaceRunForControlPlane,
  releaseWorkspaceLease: releaseWorkspaceMonitorLease,
  requireWorkspaceOutcome: requireWorkspaceWorkerOutcome,
  reserveWorkspaceBudget: reserveWorkspaceMonitorDispatchBudget,
  resolveRuntimeFlags: resolveWorkspaceRuntimeFlags,
  runWorkspaceEvaluator: runWorkspaceEvaluatorForMonitor,
});

export async function deferWorkspaceMonitorForBudget(input: {
  readonly job: ClaimedWorkspaceMonitor;
  readonly now: Date;
}): Promise<WorkspaceMonitor> {
  const afterOccurrence = new Date(Date.parse(input.job.occurrence.scheduledFor) + 1);
  const next = nextWorkspaceMonitorOccurrence(input.job.monitor.schedule, afterOccurrence);
  return updateWorkspaceMonitor({
    expectedRevision: input.job.monitor.configurationRevision,
    monitorId: input.job.monitor.monitorId,
    now: input.now,
    patch: next
      ? {
          lastErrorCode: "run_budget_exhausted",
          nextOccurrenceAt: next.scheduledAt,
        }
      : {
          lastErrorCode: "run_budget_exhausted",
          lifecycleState: "paused",
          nextOccurrenceAt: null,
          pauseReason: "run_budget_exhausted",
          pausedAt: input.now.toISOString(),
        },
    scope: input.job.scope,
  });
}

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

/*
 * Only a monitor whose declared lifecycle contract carries an occurrence-scoped
 * source retry may defer a failed attempt instead of terminalizing it. The
 * scheduler reads that declaration; it does not know which strategy needs it.
 */
function usesDeferredSourceRetry(job: ClaimedWorkspaceMonitor): boolean {
  return resolveManagedMonitorLifecycleContract(job.monitor)?.deferredSourceRetry ===
    "occurrence_scoped";
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

/*
 * Marks a failure that happened while delivering an alert for an outcome the
 * worker had already committed, so it is never conflated with the worker
 * session failing.
 */
class WorkspaceAlertDeliveryFailure extends Error {
  constructor(readonly cause: unknown) {
    super("workspace_alert_delivery_failed");
    this.name = "WorkspaceAlertDeliveryFailure";
  }
}

/*
 * The session reported a terminal failure and the worker committed nothing. The
 * accurate statement is that the occurrence produced no outcome, which is what
 * an operator needs to see; reporting a generic session failure hid the more
 * specific fact behind the less useful one.
 *
 * This changes only the recorded code, not what happens next: main-path
 * failures all advance the same consecutive-failure count and pause at the same
 * threshold. Immediate pausing belongs to the recovery path, which quarantines
 * at a threshold of one because a lost outcome there means the runtime cannot
 * tell whether paid work already happened. Here it can: nothing was committed.
 */
class WorkspaceMissingOutcomeFailure extends Error {
  constructor(readonly cause: unknown) {
    super("workspace_worker_required_outcome_missing");
    this.name = "WorkspaceMissingOutcomeFailure";
  }
}

/*
 * Production logs have repeatedly rolled or been truncated before a failure
 * could be read, so the recorded code carries the cause itself. The monitor
 * record is durable and readable from the manager, which makes a failing
 * occurrence diagnosable without racing a log window.
 */
export function workspaceOccurrenceFailureCode(error: unknown): string {
  if (error instanceof WorkspaceAlertDeliveryFailure) {
    const cause = error.cause;
    const causeCode = cause instanceof Error && /^[a-z][a-z0-9_]{2,40}$/u.test(cause.message)
      ? cause.message
      : cause instanceof Error
        ? cause.name.replace(/[^A-Za-z0-9]/gu, "").slice(0, 40)
        : null;
    return causeCode ? `alert_delivery.${causeCode}`.slice(0, 64) : "workspace_alert_delivery_failed";
  }
  return error instanceof Error &&
    error.message === "workspace_worker_required_outcome_missing"
    ? "worker_outcome_missing"
    : "workspace_worker_failed";
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
  /*
   * The recovery path terminalizes an occurrence and quarantines the monitor,
   * but logged nothing beyond a counter that carries no identity at all - so a
   * `worker_recovery_not_applicable` was undiagnosable and unattributable. It
   * is a terminal failure like any other and owes the same bounded summary.
   */
  console.error("[workspace.runtime] workspace recovery failed", {
    failureCode,
    monitorId: job.monitor.monitorId,
    packId: job.monitor.managedBy?.packId ?? null,
  });
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
  try {
    const prepared = await dependencies.prepareWorkspaceWorker({
      claimed: job,
      dispatchBudget: budget,
    });
    started = true;
    dependencies.emitRuntimeObservation({
      counter: "workspace_monitor_started_total",
      value: 1,
    });
    /*
     * Run the occurrence deterministically. The evaluator is a plain function of
     * the signed dispatch envelope; there is no LLM worker turn, so the
     * intermittent empty-response failure that used to pause live monitors
     * cannot happen. All materiality, research, and brief judgement still runs on
     * the frontier model inside nested hybrid-evidence child jobs. The evaluator
     * commits its durable outcome (finding, alert presentations, checkpoint)
     * before returning; a throw here carries the occurrence's real cause.
     */
    let evaluatorError: unknown = null;
    try {
      await dependencies.runWorkspaceEvaluator({
        prepared,
        requiredCapabilityIds: job.monitor.requiredCapabilityIds,
      });
    } catch (error) {
      evaluatorError = error;
    }
    /*
     * The evaluator may have committed its outcome before a later step threw, so
     * deliver any committed outcome first - the finding is already durable and
     * nothing downstream would ever mention it otherwise - then surface the
     * failure. A committed-then-failed occurrence is still recorded as failed,
     * exactly as before, but the owner keeps the alert for the durable finding.
     */
    let committedOutcome: Awaited<
      ReturnType<EventTriggerScheduleDependencies["requireWorkspaceOutcome"]>
    > | null = null;
    let missingOutcome: unknown = null;
    try {
      committedOutcome = await dependencies.requireWorkspaceOutcome(prepared);
    } catch (error) {
      if (!evaluatorError) throw error;
      missingOutcome = error;
    }
    if (committedOutcome && deliverAlerts) {
      try {
        await dependencies.deliverWorkspaceOutcome({ job, outcome: committedOutcome });
      } catch (error) {
        // Delivery runs inside this try so a committed outcome is always
        // attempted, which means a delivery failure would otherwise be
        // indistinguishable from the evaluator failing. Mark it so the recorded
        // code says which half broke.
        throw new WorkspaceAlertDeliveryFailure(error);
      }
    }
    if (evaluatorError) {
      // Nothing committed: the accurate statement is the occurrence produced no
      // outcome. Something committed then failed later: surface the real cause.
      throw missingOutcome
        ? new WorkspaceMissingOutcomeFailure(evaluatorError)
        : evaluatorError;
    }
    const outcome = committedOutcome!;
    if (usesDeferredSourceRetry(job)) {
      await dependencies.clearWorkspaceSourceRetry({
        occurrenceKey: job.occurrence.occurrenceKey,
        scope: job.scope,
      });
    }
    // No LLM worker turn runs any more, so the occurrence spends no worker-level
    // model tokens; the frontier child jobs account their own usage through the
    // workspace budget ledger, which `finishWorkspaceMonitorDispatchBudget` sums
    // in independently. Reconcile the worker portion at zero.
    await dependencies.finishWorkspaceBudget(job, budget, {
      actualInputTokens: 0,
      actualOutputTokens: 0,
      outcome: "reconciled",
    });
    // A fully evaluated delivery page may durably stage an alert while the
    // source checkpoint is held for later pages; it is not a completed scan.
    if (outcome.sourcePending) return;
    /*
     * A completed occurrence emitted only identity-free counters, so when two
     * monitors ran in the same window - IPO Live and Tracker Live share a
     * cadence - the log could not say which one succeeded, or with what.
     * Failures already name their strategy; successes owe the same. Bounded to
     * registry identity and a fixed outcome word, never owner or source data.
     */
    console.info("[workspace.runtime] workspace occurrence completed", {
      monitorId: job.monitor.monitorId,
      outcome: outcome.outcome,
      packId: job.monitor.managedBy?.packId ?? null,
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
    let retry = null;
    try {
      retry = usesDeferredSourceRetry(job) ? await dependencies.readWorkspaceSourceRetry({
        occurrenceKey: job.occurrence.occurrenceKey,
        scope: job.scope,
      }) : null;
    } catch {
      // A corrupt or unavailable retry record must not turn a terminal failure
      // into a blind acquisition replay.
    }
    /*
     * The bounded observation carries only a counter and a fixed code, so an
     * unrecognized error collapses to `evaluation_failed` and nothing records
     * what actually threw. That is how a repeatedly failing live monitor stayed
     * undiagnosable. Log a bounded summary alongside it: the error name always,
     * and the message only when it is one of this system's code-shaped
     * identifiers, so untrusted source content can never reach the log.
     */
    const failureMessage = error instanceof Error ? error.message : "";
    const failureCause = error instanceof WorkspaceAlertDeliveryFailure ||
      error instanceof WorkspaceMissingOutcomeFailure ? error.cause : null;
    console.error("[workspace.runtime] workspace occurrence failed", {
      cause_message: failureCause instanceof Error &&
        /^[a-z][a-z0-9_]{2,63}$/u.test(failureCause.message) ? failureCause.message : null,
      cause_type: failureCause instanceof Error ? failureCause.name : null,
      error_message: /^[a-z][a-z0-9_]{2,63}$/u.test(failureMessage) ? failureMessage : null,
      error_type: error instanceof Error ? error.name : typeof error,
      failureCode: workspaceOccurrenceFailureCode(error),
      monitorId: job.monitor.monitorId,
      /*
       * The pack id is registry identity, not owner data, so it is safe here
       * where a workspace or owner id would not be - and without it a failure
       * is only a UUID, readable solely by cross-referencing manager state.
       * Skipping that cross-reference is how a Congressional occurrence was
       * read as a commentary one while both were live.
       */
      packId: job.monitor.managedBy?.packId ?? null,
      started,
    });
    dependencies.emitRuntimeObservation({
      counter: retry
        ? "workspace_monitor_retryable_failure_total"
        : started
        ? "workspace_monitor_terminal_failure_total"
        : "workspace_monitor_retryable_failure_total",
      errorCode: safeWorkspaceRuntimeErrorCode(error, "evaluation_failed"),
      value: 1,
    });
    if (started) {
      if (!retry) {
        try {
          await dependencies.recordWorkspaceFailure({
          errorCode: workspaceOccurrenceFailureCode(error),
          expectedRevision: job.monitor.configurationRevision,
          monitorId: job.monitor.monitorId,
          scope: job.scope,
          });
        } catch {
          // A concurrent lifecycle/configuration edit is authoritative.
        }
      }
      try {
        await dependencies.releaseWorkspaceLease({
          leaseToken: job.leaseToken,
          monitorId: job.monitor.monitorId,
          ...(retry ? { retryAt: retry.retryAt } : {}),
          scope: job.scope,
        });
      } catch {
        // Lease expiry recovery remains authoritative.
      }
    }
    await dependencies.finishWorkspaceBudget(job, budget, {
      actualInputTokens: started ? 0 : undefined,
      actualOutputTokens: started ? 0 : undefined,
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
        const recoveryJobs: ClaimedWorkspaceMonitor[] = [];
        const retryJobs: ClaimedWorkspaceMonitor[] = [];
        const repeatedJobs = workspaceJobs.filter(({ occurrence }) => occurrence.attempt > 1);
        const retries = await Promise.all(repeatedJobs.map(async (job) => {
          try {
            return usesDeferredSourceRetry(job) ? await dependencies.readWorkspaceSourceRetry({
              occurrenceKey: job.occurrence.occurrenceKey,
              scope: job.scope,
            }) : null;
          } catch {
            // Missing/corrupt retry state retains the recovery-only fail-closed path.
            return null;
          }
        }));
        for (const [index, job] of repeatedJobs.entries()) {
          const retry = retries[index];
          if (retry && Date.parse(retry.retryAt) <= now.getTime()) retryJobs.push(job);
          else if (retry) {
            await dependencies.releaseWorkspaceLease({
              leaseToken: job.leaseToken,
              monitorId: job.monitor.monitorId,
              retryAt: retry.retryAt,
              scope: job.scope,
            });
          } else recoveryJobs.push(job);
        }
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
        for (const job of [...firstAttemptJobs, ...retryJobs]) {
          try {
            const budget = await dependencies.reserveWorkspaceBudget(job, {
              now,
            });
            admittedWorkspaceJobs.push({ budget, job });
          } catch (error) {
            const errorCode = safeWorkspaceRuntimeErrorCode(
              error,
              "storage_unavailable",
            );
            try {
              if (errorCode === "run_budget_exhausted") {
                await dependencies.deferWorkspaceBudget({ job, now });
              }
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
