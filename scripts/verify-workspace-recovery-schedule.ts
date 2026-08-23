import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type { ScheduleToFn } from "eve/schedules";

import {
  createEventTriggerSchedule,
  workspaceOccurrenceFailureCode,
  type EventTriggerScheduleDependencies,
} from "../agent/schedules/event-triggers";
import type { ClaimedEventTrigger } from "../agent/lib/event-trigger-store";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceRunOutcome } from "../agent/lib/workspace-finding-store";
import {
  workspaceMonitorOccurrenceKey,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import {
  IPO_FILINGS_CAPABILITY_MANIFEST,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import {
  prepareWorkspaceWorkerRecovery,
  type PreparedWorkspaceWorkerRecovery,
  type PreparedWorkspaceWorkerRun,
} from "../agent/lib/workspace-worker-runner";

const now = new Date("2026-08-14T20:00:00.000Z");
const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const leaseToken = "attempt-2-lease";
const monitorId = "323e4567-e89b-42d3-a456-426614174000";
const occurrenceIdentity = `interval:${now.toISOString()}`;

const monitor: WorkspaceMonitor = {
  configurationRevision: 1,
  consecutiveFailures: 0,
  createdAt: "2026-08-14T19:00:00.000Z",
  deliverySubscriptionId: "delivery.fixture",
  endAt: null,
  instruction: "Evaluate the configured SEC source.",
  lastCompletedAt: null,
  lastErrorCode: null,
  lastRunAt: null,
  lifecycleState: "enabled",
  monitorId,
  name: "Recovery fixture",
  nextOccurrenceAt: now.toISOString(),
  ownerId: scope.ownerId,
  pauseReason: null,
  pausedAt: null,
  requiredCapabilityIds: ["evaluate_sec_ipo_source"],
  schedule: {
    anchor: "2026-08-14T19:00:00.000Z",
    everyMinutes: 60,
    kind: "interval",
  },
  schemaVersion: 1,
  sourceCheckpoint: { contentDigest: null, watermark: null },
  sources: [{
    accessClassification: "public",
    canonicalUrl: SEC_IPO_SOURCE_URL,
    origin: "https://www.sec.gov",
    sourceId: SEC_IPO_SOURCE_ID,
  }],
  tighteningLimits: {
    inputTokensPerRun: 10_000,
    outputTokensPerRun: 2_000,
    paidPerRun: null,
  },
  updatedAt: now.toISOString(),
  workspaceBindingImmutable: true,
  workspaceId: scope.workspaceId,
};

const occurrenceKey = workspaceMonitorOccurrenceKey({
  configurationRevision: monitor.configurationRevision,
  monitorId,
  occurrenceIdentity,
  scope,
});
const job: ClaimedWorkspaceMonitor = {
  leaseExpiresAt: "2026-08-14T20:30:00.000Z",
  leaseToken,
  monitor,
  occurrence: {
    attempt: 2,
    configurationRevision: monitor.configurationRevision,
    leaseTokenDigest: createHash("sha256").update(leaseToken).digest("hex"),
    monitorId,
    occurrenceIdentity,
    occurrenceKey,
    scheduledFor: now.toISOString(),
    schemaVersion: 1,
    status: "leased",
    updatedAt: now.toISOString(),
  },
  scope,
  skippedOccurrenceIdentities: [],
};
const prepared: PreparedWorkspaceWorkerRecovery = {
  capabilityRevision: 1,
  claimed: job,
  expectedRunId: null,
  monitor,
  scope,
};

interface ScenarioEvidence {
  readonly failureCodes: string[];
  readonly inspections: number;
  readonly releases: number;
  readonly reservations: number;
  readonly starts: number;
}

function aggregateContains(error: unknown, message: string): boolean {
  return error instanceof AggregateError && error.errors.some(
    (nested) => nested instanceof Error && nested.message === message,
  );
}

async function runScenario(overrides: Partial<EventTriggerScheduleDependencies>): Promise<ScenarioEvidence> {
  const failureCodes: string[] = [];
  let claimed = false;
  let inspections = 0;
  let releases = 0;
  let reservations = 0;
  let starts = 0;
  const dependencies: Partial<EventTriggerScheduleDependencies> = {
    claimEventTriggers: async () => [],
    claimWorkspaceMonitors: async () => {
      if (claimed) return [];
      claimed = true;
      return [job];
    },
    finishWorkspaceBudget: async () => undefined,
    getWorkspaceMonitor: async () => monitor,
    inspectWorkspaceLease: async () => {
      inspections += 1;
      return "current";
    },
    now: () => now,
    prepareWorkspaceRecovery: async () => prepared,
    prepareWorkspaceWorker: async () => {
      throw new Error("first_attempt_worker_preparation_not_expected");
    },
    recordWorkspaceFailure: async (input) => {
      failureCodes.push(input.errorCode);
      return {
        ...monitor,
        configurationRevision: 2,
        consecutiveFailures: 1,
        lastErrorCode: input.errorCode,
        lifecycleState: "paused_failure",
        pauseReason: input.errorCode,
        pausedAt: now.toISOString(),
      };
    },
    recoverWorkspaceOutcome: async () => ({ status: "missing" }),
    releaseWorkspaceLease: async () => {
      releases += 1;
      return true;
    },
    requireWorkspaceOutcome: async () => {
      throw new Error("first_attempt_outcome_not_expected");
    },
    reserveWorkspaceBudget: async () => {
      reservations += 1;
      throw new Error("retry_budget_admission_not_expected");
    },
    resolveRuntimeFlags: () => ({
      dispatch: true,
      legacyTriggerCreation: false,
      monitorWrites: true,
      paidResearch: false,
      photonAlerts: false,
      sourceEvents: false,
      state: true,
    }),
    startWorkspaceWorker: async () => {
      starts += 1;
      throw new Error("retry_worker_start_not_expected");
    },
    ...overrides,
  };
  const schedule = createEventTriggerSchedule(dependencies);
  assert.ok("run" in schedule && schedule.run);
  const waiters: Promise<unknown>[] = [];
  schedule.run({
    appAuth: {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    to: (() => {
      throw new Error("legacy_dispatch_not_expected");
    }) as ScheduleToFn,
    waitUntil(task) {
      waiters.push(task);
    },
  });
  assert.equal(waiters.length, 1);
  await Promise.all(waiters);
  return { failureCodes, inspections, releases, reservations, starts };
}

const arbitraryRecovery = await runScenario({
  recoverWorkspaceOutcome: async () => {
    throw new Error("fixture_recovery_failed");
  },
});
assert.deepEqual(arbitraryRecovery.failureCodes, ["worker_recovery_failed"]);
assert.equal(arbitraryRecovery.releases, 1);
assert.equal(arbitraryRecovery.reservations, 0);
assert.equal(arbitraryRecovery.starts, 0);

for (const [status, expectedCode] of [
  ["missing", "worker_recovery_outcome_missing"],
  ["not_applicable", "worker_recovery_not_applicable"],
] as const) {
  const evidence = await runScenario({
    recoverWorkspaceOutcome: async () => ({ status }),
  });
  assert.deepEqual(evidence.failureCodes, [expectedCode]);
  assert.equal(evidence.releases, 1);
  assert.equal(evidence.reservations, 0);
  assert.equal(evidence.starts, 0);
}

for (const staleCode of [
  "workspace_worker_state_stale",
  "workspace_worker_capability_denied",
  "workspace_worker_run_stale",
  "monitor_occurrence_stale",
]) {
  const evidence = await runScenario({
    prepareWorkspaceRecovery: async () => {
      throw new Error(staleCode);
    },
  });
  assert.deepEqual(evidence.failureCodes, ["worker_recovery_stale"]);
  assert.equal(evidence.reservations, 0);
  assert.equal(evidence.starts, 0);
}

await assert.rejects(
  runScenario({
    getWorkspaceMonitor: async () => monitor,
    recordWorkspaceFailure: async () => {
      throw new Error("quarantine_write_failed");
    },
  }),
  (error) => aggregateContains(error, "schedule_job_failed"),
);

const supersededQuarantine = await runScenario({
  getWorkspaceMonitor: async () => ({
    ...monitor,
    configurationRevision: 2,
    lifecycleState: "paused_failure",
    pauseReason: "concurrent_change",
    pausedAt: now.toISOString(),
  }),
  recordWorkspaceFailure: async () => {
    throw new Error("monitor_revision_conflict");
  },
});
assert.equal(supersededQuarantine.releases, 1);

await assert.rejects(
  runScenario({
    inspectWorkspaceLease: async () => "current",
    releaseWorkspaceLease: async () => false,
  }),
  (error) => aggregateContains(error, "schedule_job_failed"),
);
await assert.rejects(
  runScenario({
    inspectWorkspaceLease: async () => "current",
    releaseWorkspaceLease: async () => {
      throw new Error("lease_release_failed");
    },
  }),
  (error) => aggregateContains(error, "schedule_job_failed"),
);
await runScenario({
  inspectWorkspaceLease: async () => "stale",
  releaseWorkspaceLease: async () => {
    throw new Error("concurrent_lease_change");
  },
});

function workspaceJob(input: {
  attempt: number;
  monitorId: string;
}): ClaimedWorkspaceMonitor {
  const selectedMonitor = { ...monitor, monitorId: input.monitorId };
  const selectedOccurrenceKey = workspaceMonitorOccurrenceKey({
    configurationRevision: selectedMonitor.configurationRevision,
    monitorId: input.monitorId,
    occurrenceIdentity,
    scope,
  });
  const selectedLeaseToken = `lease-${input.monitorId}`;
  return {
    ...job,
    leaseToken: selectedLeaseToken,
    monitor: selectedMonitor,
    occurrence: {
      ...job.occurrence,
      attempt: input.attempt,
      leaseTokenDigest: createHash("sha256")
        .update(selectedLeaseToken)
        .digest("hex"),
      monitorId: input.monitorId,
      occurrenceKey: selectedOccurrenceKey,
    },
  };
}

const failingRecoveryJob = workspaceJob({
  attempt: 2,
  monitorId: "523e4567-e89b-42d3-a456-426614174000",
});
const successfulRecoveryJob = workspaceJob({
  attempt: 2,
  monitorId: "623e4567-e89b-42d3-a456-426614174000",
});
const firstAttemptJob = workspaceJob({
  attempt: 1,
  monitorId: "723e4567-e89b-42d3-a456-426614174000",
});
const firstAttemptRunId =
  `${firstAttemptJob.occurrence.occurrenceKey}:attempt:1`;
const firstAttemptReservation: WorkspaceDispatchReservation = {
  global: {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId: firstAttemptRunId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
  runId: firstAttemptRunId,
  workspace: {
    calendarDay: now.toISOString().slice(0, 10),
    calendarMonth: now.toISOString().slice(0, 7),
    createdAt: now.toISOString(),
    inputTokens: 1_000,
    outputTokens: 200,
    paidMicros: "0",
    policyRevision: 1,
    reconciledInputTokens: null,
    reconciledOutputTokens: null,
    reconciledPaidMicros: null,
    runId: firstAttemptRunId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
};
const firstAttemptOutcome: WorkspaceRunOutcome = {
  checkpoint: {
    completedAt: now.toISOString(),
    contentDigest: "a".repeat(64),
    watermark: now.toISOString(),
  },
  configurationRevision: firstAttemptJob.monitor.configurationRevision,
  createdAt: now.toISOString(),
  finding: null,
  monitorId: firstAttemptJob.monitor.monitorId,
  occurrenceKey: firstAttemptJob.occurrence.occurrenceKey,
  outcome: "no_match",
  ownerId: scope.ownerId,
  recordType: "workspace_run_outcome",
  runId: firstAttemptRunId,
  schemaVersion: 1,
  workspaceId: scope.workspaceId,
};
const legacyJob = { id: "legacy.fixture" } as ClaimedEventTrigger;
let successfulRecoveryRuns = 0;
let recoveryCleanupAttempts = 0;
let recoveryQuarantineWrites = 0;
let firstAttemptWorkerRuns = 0;
let firstAttemptFinishes = 0;
let legacyRuns = 0;
let mixedClaimed = false;
const mixedSchedule = createEventTriggerSchedule({
  claimEventTriggers: async () => mixedClaimed ? [] : [legacyJob],
  claimWorkspaceMonitors: async () => {
    if (mixedClaimed) return [];
    mixedClaimed = true;
    return [failingRecoveryJob, successfulRecoveryJob, firstAttemptJob];
  },
  executeEventTrigger: async () => {
    legacyRuns += 1;
  },
  finishWorkspaceBudget: async () => {
    firstAttemptFinishes += 1;
  },
  getWorkspaceMonitor: async () => failingRecoveryJob.monitor,
  inspectWorkspaceLease: async () => "current",
  now: () => now,
  prepareWorkspaceRecovery: async ({ claimed }) => ({
    capabilityRevision: 1,
    claimed,
    expectedRunId: null,
    monitor: claimed.monitor,
    scope: claimed.scope,
  }),
  prepareWorkspaceWorker: async () => ({
    envelope: {} as PreparedWorkspaceWorkerRun["envelope"],
    prompt: "fixture",
    request: {} as PreparedWorkspaceWorkerRun["request"],
    scope,
  }),
  recordWorkspaceFailure: async () => {
    recoveryQuarantineWrites += 1;
    throw new Error("quarantine_write_failed");
  },
  recoverWorkspaceOutcome: async ({ prepared }) => {
    if (prepared.monitor.monitorId === failingRecoveryJob.monitor.monitorId) {
      throw new Error("recovery_failed");
    }
    successfulRecoveryRuns += 1;
    return { outcome: firstAttemptOutcome, status: "recovered" };
  },
  releaseWorkspaceLease: async () => {
    recoveryCleanupAttempts += 1;
    throw new Error("lease_release_failed");
  },
  requireWorkspaceOutcome: async () => firstAttemptOutcome,
  reserveWorkspaceBudget: async () => firstAttemptReservation,
  resolveRuntimeFlags: () => ({
    dispatch: true,
    legacyTriggerCreation: false,
    monitorWrites: true,
    paidResearch: false,
    photonAlerts: false,
    sourceEvents: false,
    state: true,
  }),
  startWorkspaceWorker: async () => {
    firstAttemptWorkerRuns += 1;
    return {
      events: (async function* () {
        return;
      })(),
    } as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>;
  },
});
assert.ok("run" in mixedSchedule && mixedSchedule.run);
const mixedWaiters: Promise<unknown>[] = [];
mixedSchedule.run({
  appAuth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  to: (() => {
    throw new Error("legacy_to_not_expected");
  }) as ScheduleToFn,
  waitUntil(task) {
    mixedWaiters.push(task);
  },
});
assert.equal(mixedWaiters.length, 1);
let mixedRejected = false;
try {
  await Promise.all(mixedWaiters);
} catch (error) {
  mixedRejected = true;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "schedule_job_failed");
  assert.equal(successfulRecoveryRuns, 1);
  assert.equal(recoveryQuarantineWrites, 1);
  assert.equal(recoveryCleanupAttempts, 1);
  assert.equal(firstAttemptWorkerRuns, 1);
  assert.equal(firstAttemptFinishes, 1);
  assert.equal(legacyRuns, 1);
}
assert.equal(mixedRejected, true);

const retryAt = new Date(now.getTime() + 60_000);
const delayedRetryFirst = workspaceJob({
  attempt: 1,
  monitorId: "823e4567-e89b-42d3-a456-426614174000",
});
const delayedRetryEarningsMonitor: WorkspaceMonitor = {
  ...delayedRetryFirst.monitor,
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: "b".repeat(64),
    packId: "earnings-call-changes",
    packVersion: "1.0.0",
    resourceId: "compare-earnings-calls",
  },
};
const delayedRetryFirstEarnings: ClaimedWorkspaceMonitor = {
  ...delayedRetryFirst,
  monitor: delayedRetryEarningsMonitor,
};
const delayedRetrySecond: ClaimedWorkspaceMonitor = {
  ...delayedRetryFirstEarnings,
  leaseToken: "delayed-retry-second-lease",
  occurrence: {
    ...delayedRetryFirstEarnings.occurrence,
    attempt: 2,
    leaseTokenDigest: createHash("sha256").update("delayed-retry-second-lease").digest("hex"),
    updatedAt: retryAt.toISOString(),
  },
};
let delayedRetryClaim = 0;
let delayedRetryStarts = 0;
let delayedRetryRecoveries = 0;
let delayedRetryFailures = 0;
let delayedRetryClears = 0;
const delayedRetryReleases: Array<string | undefined> = [];
let delayedRetryClock = now;
let pendingRetry = {
  acquisitionId: "acquisition.fixture.timeout",
  retryAfterSeconds: 60,
  retryAt: retryAt.toISOString(),
  runId: `${delayedRetryFirstEarnings.occurrence.occurrenceKey}:attempt:1`,
  sourceId: "earnings-call-transcripts.0000019617",
};
const delayedRetryOutcome: WorkspaceRunOutcome = {
  ...firstAttemptOutcome,
  monitorId: delayedRetrySecond.monitor.monitorId,
  occurrenceKey: delayedRetrySecond.occurrence.occurrenceKey,
  runId: `${delayedRetrySecond.occurrence.occurrenceKey}:attempt:2`,
};
const delayedRetrySchedule = createEventTriggerSchedule({
  claimEventTriggers: async () => [],
  claimWorkspaceMonitors: async () => {
    delayedRetryClaim += 1;
    return delayedRetryClaim === 1 ? [delayedRetryFirstEarnings]
      : delayedRetryClaim === 2 ? [delayedRetrySecond] : [];
  },
  clearWorkspaceSourceRetry: async () => {
    delayedRetryClears += 1;
    pendingRetry = null as never;
  },
  finishWorkspaceBudget: async () => undefined,
  now: () => delayedRetryClock,
  prepareWorkspaceRecovery: async () => {
    throw new Error("delayed_retry_must_not_use_recovery");
  },
  prepareWorkspaceWorker: async () => ({
    envelope: {} as PreparedWorkspaceWorkerRun["envelope"],
    prompt: "fixture",
    request: {} as PreparedWorkspaceWorkerRun["request"],
    scope,
  }),
  readWorkspaceSourceRetry: async () => pendingRetry,
  recordWorkspaceFailure: async () => {
    delayedRetryFailures += 1;
    return monitor;
  },
  recoverWorkspaceOutcome: async () => {
    delayedRetryRecoveries += 1;
    return { status: "missing" };
  },
  releaseWorkspaceLease: async (input) => {
    delayedRetryReleases.push(input.retryAt);
    return true;
  },
  requireWorkspaceOutcome: async () => delayedRetryOutcome,
  reserveWorkspaceBudget: async (claimed) => {
    const runId = `${claimed.occurrence.occurrenceKey}:attempt:${claimed.occurrence.attempt}`;
    return {
      ...firstAttemptReservation,
      global: { ...firstAttemptReservation.global, runId },
      runId,
      workspace: { ...firstAttemptReservation.workspace, runId },
    };
  },
  resolveRuntimeFlags: () => ({
    dispatch: true,
    legacyTriggerCreation: false,
    monitorWrites: true,
    paidResearch: false,
    photonAlerts: false,
    sourceEvents: false,
    state: true,
  }),
  startWorkspaceWorker: async () => {
    delayedRetryStarts += 1;
    return {
      events: (async function* () {
        if (delayedRetryStarts === 1) {
          yield { type: "session.failed", data: {} };
        }
      })(),
    } as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>;
  },
});
assert.ok("run" in delayedRetrySchedule && delayedRetrySchedule.run);
const runDelayedRetryTick = async () => {
  const waiters: Promise<unknown>[] = [];
  delayedRetrySchedule.run!({
    appAuth: { attributes: {}, authenticator: "app", principalId: "eve:app", principalType: "runtime" },
    to: (() => { throw new Error("legacy_dispatch_not_expected"); }) as ScheduleToFn,
    waitUntil(task) { waiters.push(task); },
  });
  await Promise.all(waiters);
};
await runDelayedRetryTick();
assert.deepEqual(delayedRetryReleases, [retryAt.toISOString()]);
assert.equal(delayedRetryFailures, 0, "retryable acquisition failure must not increment pause counters");
delayedRetryClock = retryAt;
await runDelayedRetryTick();
assert.equal(delayedRetryStarts, 2);
assert.equal(delayedRetryRecoveries, 0);
assert.equal(delayedRetryClears, 1);

const concurrentRetryJobs = [
  workspaceJob({ attempt: 2, monitorId: "923e4567-e89b-42d3-a456-426614174000" }),
  workspaceJob({ attempt: 2, monitorId: "a23e4567-e89b-42d3-a456-426614174000" }),
].map((claimed) => ({
  ...claimed,
  monitor: {
    ...claimed.monitor,
    managedBy: delayedRetryEarningsMonitor.managedBy,
  },
}));
let concurrentRetryClaimed = false;
let activeRetryReads = 0;
let maximumConcurrentRetryReads = 0;
const concurrentRetryReleases: string[] = [];
const concurrentRetrySchedule = createEventTriggerSchedule({
  claimEventTriggers: async () => [],
  claimWorkspaceMonitors: async () => {
    if (concurrentRetryClaimed) return [];
    concurrentRetryClaimed = true;
    return concurrentRetryJobs;
  },
  now: () => now,
  readWorkspaceSourceRetry: async ({ occurrenceKey }) => {
    activeRetryReads += 1;
    maximumConcurrentRetryReads = Math.max(maximumConcurrentRetryReads, activeRetryReads);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRetryReads -= 1;
    return {
      acquisitionId: `acquisition.${occurrenceKey}`,
      retryAfterSeconds: 60,
      retryAt: retryAt.toISOString(),
      runId: `${occurrenceKey}:attempt:1`,
      sourceId: "earnings-call-transcripts.0000019617",
    };
  },
  releaseWorkspaceLease: async ({ monitorId }) => {
    concurrentRetryReleases.push(monitorId);
    return true;
  },
  resolveRuntimeFlags: () => ({
    dispatch: true,
    legacyTriggerCreation: false,
    monitorWrites: true,
    paidResearch: false,
    photonAlerts: false,
    sourceEvents: false,
    state: true,
  }),
});
assert.ok("run" in concurrentRetrySchedule && concurrentRetrySchedule.run);
const concurrentRetryWaiters: Promise<unknown>[] = [];
concurrentRetrySchedule.run({
  appAuth: { attributes: {}, authenticator: "app", principalId: "eve:app", principalType: "runtime" },
  to: (() => { throw new Error("legacy_dispatch_not_expected"); }) as ScheduleToFn,
  waitUntil(task) { concurrentRetryWaiters.push(task); },
});
await Promise.all(concurrentRetryWaiters);
assert.equal(maximumConcurrentRetryReads, 2, "independent retry-state reads must run concurrently");
assert.deepEqual(
  concurrentRetryReleases,
  concurrentRetryJobs.map(({ monitor }) => monitor.monitorId),
  "retry classification and lease release must preserve claim order",
);

async function verifyClaimIsolation(
  failingClaim: "event_trigger" | "workspace",
): Promise<void> {
  const claimError = `${failingClaim}_claim_failed`;
  let workspaceRuns = 0;
  let workspaceFinishes = 0;
  let eventTriggerRuns = 0;
  const claimSchedule = createEventTriggerSchedule({
    claimEventTriggers: async () => {
      if (failingClaim === "event_trigger") throw new Error(claimError);
      return [legacyJob];
    },
    claimWorkspaceMonitors: async () => {
      if (failingClaim === "workspace") throw new Error(claimError);
      return [firstAttemptJob];
    },
    executeEventTrigger: async () => {
      eventTriggerRuns += 1;
    },
    finishWorkspaceBudget: async () => {
      workspaceFinishes += 1;
    },
    now: () => now,
    prepareWorkspaceWorker: async () => ({
      envelope: {} as PreparedWorkspaceWorkerRun["envelope"],
      prompt: "fixture",
      request: {} as PreparedWorkspaceWorkerRun["request"],
      scope,
    }),
    requireWorkspaceOutcome: async () => firstAttemptOutcome,
    reserveWorkspaceBudget: async () => firstAttemptReservation,
    resolveRuntimeFlags: () => ({
      dispatch: true,
      legacyTriggerCreation: false,
      monitorWrites: true,
      paidResearch: false,
      photonAlerts: false,
      sourceEvents: false,
      state: true,
    }),
    startWorkspaceWorker: async () => {
      workspaceRuns += 1;
      return {
        events: (async function* () {
          return;
        })(),
      } as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>;
    },
  });
  assert.ok("run" in claimSchedule && claimSchedule.run);
  const waiters: Promise<unknown>[] = [];
  claimSchedule.run({
    appAuth: {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    to: (() => {
      throw new Error("legacy_to_not_expected");
    }) as ScheduleToFn,
    waitUntil(task) {
      waiters.push(task);
    },
  });
  assert.equal(waiters.length, 1);
  let rejected = false;
  try {
    await Promise.all(waiters);
  } catch (error) {
    rejected = true;
    assert.ok(aggregateContains(error, "storage_unavailable"));
    if (failingClaim === "event_trigger") {
      assert.equal(workspaceRuns, 1);
      assert.equal(workspaceFinishes, 1);
      assert.equal(eventTriggerRuns, 0);
    } else {
      assert.equal(workspaceRuns, 0);
      assert.equal(workspaceFinishes, 0);
      assert.equal(eventTriggerRuns, 1);
    }
  }
  assert.equal(rejected, true);
}

await verifyClaimIsolation("event_trigger");
await verifyClaimIsolation("workspace");

let deliveredWorkspaceOutcomes = 0;
let deliveryClaimed = false;
const deliveryDependencies = {
  claimEventTriggers: async () => [],
  claimWorkspaceMonitors: async () => {
    if (deliveryClaimed) return [];
    deliveryClaimed = true;
    return [firstAttemptJob];
  },
  deliverWorkspaceOutcome: async (input: {
    job: ClaimedWorkspaceMonitor;
    outcome: WorkspaceRunOutcome;
  }) => {
    assert.equal(input.job.monitor.monitorId, firstAttemptJob.monitor.monitorId);
    assert.equal(input.outcome.runId, firstAttemptOutcome.runId);
    deliveredWorkspaceOutcomes += 1;
  },
  finishWorkspaceBudget: async () => undefined,
  now: () => now,
  prepareWorkspaceWorker: async () => ({
    envelope: {} as PreparedWorkspaceWorkerRun["envelope"],
    prompt: "fixture",
    request: {} as PreparedWorkspaceWorkerRun["request"],
    scope,
  }),
  requireWorkspaceOutcome: async () => firstAttemptOutcome,
  reserveWorkspaceBudget: async () => firstAttemptReservation,
  resolveRuntimeFlags: () => ({
    dispatch: true,
    legacyTriggerCreation: false,
    monitorWrites: true,
    paidResearch: false,
    photonAlerts: true,
    sourceEvents: false,
    state: true,
  }),
  startWorkspaceWorker: async () => ({
    events: (async function* () {
      return;
    })(),
  }) as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>,
} as Partial<EventTriggerScheduleDependencies> & {
  deliverWorkspaceOutcome(input: {
    job: ClaimedWorkspaceMonitor;
    outcome: WorkspaceRunOutcome;
  }): Promise<void>;
};
const deliverySchedule = createEventTriggerSchedule(deliveryDependencies);
assert.ok("run" in deliverySchedule && deliverySchedule.run);
const deliveryWaiters: Promise<unknown>[] = [];
deliverySchedule.run({
  appAuth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  to: (() => {
    throw new Error("legacy_to_not_expected");
  }) as ScheduleToFn,
  waitUntil(task) {
    deliveryWaiters.push(task);
  },
});
await Promise.all(deliveryWaiters);
assert.equal(
  deliveredWorkspaceOutcomes,
  1,
  "a completed production workspace run must enter the Photon alert delivery path",
);

/*
 * The worker commits its outcome inside its own tool, before this tick reaches
 * the end of the session. Production dropped an owner alert for a committed
 * finding because the session then reported a terminal failure - one the
 * harness had already retried - and the throw sat above delivery. A committed
 * outcome must still be delivered, and the session failure must still surface.
 */
let deliveredAfterSessionFailure = 0;
let recordedSessionFailureCode: string | null = null;
let sessionFailureClaimed = false;
const sessionFailureDependencies = {
  ...deliveryDependencies,
  claimWorkspaceMonitors: async () => {
    if (sessionFailureClaimed) return [];
    sessionFailureClaimed = true;
    return [firstAttemptJob];
  },
  deliverWorkspaceOutcome: async (input: {
    job: ClaimedWorkspaceMonitor;
    outcome: WorkspaceRunOutcome;
  }) => {
    assert.equal(input.outcome.runId, firstAttemptOutcome.runId);
    deliveredAfterSessionFailure += 1;
  },
  emitRuntimeObservation: () => undefined,
  recordWorkspaceFailure: async (input: { errorCode: string }) => {
    recordedSessionFailureCode = input.errorCode;
  },
  releaseWorkspaceLease: async () => true,
  startWorkspaceWorker: async () => ({
    events: (async function* () {
      yield { data: {}, type: "turn.failed" };
    })(),
  }) as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>,
} as unknown as EventTriggerScheduleDependencies;
const sessionFailureSchedule = createEventTriggerSchedule(sessionFailureDependencies);
assert.ok("run" in sessionFailureSchedule && sessionFailureSchedule.run);
const sessionFailureWaiters: Promise<unknown>[] = [];
sessionFailureSchedule.run({
  appAuth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  to: (() => {
    throw new Error("legacy_to_not_expected");
  }) as ScheduleToFn,
  waitUntil(task) {
    sessionFailureWaiters.push(task);
  },
});
await Promise.all(sessionFailureWaiters);
assert.equal(
  deliveredAfterSessionFailure,
  1,
  "a committed outcome must still be delivered when the session then reports a terminal failure",
);
assert.equal(
  recordedSessionFailureCode,
  "workspace_worker_failed",
  "the session failure must still surface after delivery, with its existing code",
);

/*
 * Delivery runs inside the same try as the worker session, so a delivery
 * failure would otherwise record the same code as the session failing. A live
 * monitor failing every occurrence could not be told apart from one whose
 * alerts were failing to send.
 */
let deliveryFailureCode: string | null = null;
let deliveryFailureClaimed = false;
const deliveryFailureSchedule = createEventTriggerSchedule({
  ...deliveryDependencies,
  claimWorkspaceMonitors: async () => {
    if (deliveryFailureClaimed) return [];
    deliveryFailureClaimed = true;
    return [firstAttemptJob];
  },
  deliverWorkspaceOutcome: async () => {
    throw new Error("photon_alert_workspace_unavailable");
  },
  emitRuntimeObservation: () => undefined,
  recordWorkspaceFailure: async (input: { errorCode: string }) => {
    deliveryFailureCode = input.errorCode;
  },
  releaseWorkspaceLease: async () => true,
} as unknown as EventTriggerScheduleDependencies);
assert.ok("run" in deliveryFailureSchedule && deliveryFailureSchedule.run);
const deliveryFailureWaiters: Promise<unknown>[] = [];
deliveryFailureSchedule.run({
  appAuth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  to: (() => {
    throw new Error("legacy_to_not_expected");
  }) as ScheduleToFn,
  waitUntil(task) {
    deliveryFailureWaiters.push(task);
  },
});
await Promise.all(deliveryFailureWaiters);
assert.equal(
  deliveryFailureCode,
  "alert_delivery.photon_alert_workspace_unavailable",
  "the recorded code must name why delivery failed, not merely that it did",
);
// Production logs have rolled before a failure could be read more than once, so
// the durable monitor record has to carry the cause on its own, bounded to what
// the record accepts.
assert.ok(deliveryFailureCode !== null && deliveryFailureCode.length <= 64);
assert.equal(
  workspaceOccurrenceFailureCode(new Error("workspace_worker_required_outcome_missing")),
  "worker_outcome_missing",
);
assert.equal(
  workspaceOccurrenceFailureCode(new Error("workspace_worker_session_failed")),
  "workspace_worker_failed",
);

/*
 * A session that reports a terminal failure having committed nothing must say
 * so. Reporting a generic session failure hid the more specific fact behind the
 * less useful one, and an operator reading it could not tell whether the
 * occurrence produced anything.
 */
let missingOutcomeCode: string | null = null;
let missingOutcomeClaimed = false;
const missingOutcomeSchedule = createEventTriggerSchedule({
  ...deliveryDependencies,
  claimWorkspaceMonitors: async () => {
    if (missingOutcomeClaimed) return [];
    missingOutcomeClaimed = true;
    return [firstAttemptJob];
  },
  deliverWorkspaceOutcome: async () => {
    throw new Error("delivery_must_not_run_without_an_outcome");
  },
  emitRuntimeObservation: () => undefined,
  recordWorkspaceFailure: async (input: { errorCode: string; failureThreshold?: number }) => {
    missingOutcomeCode = input.errorCode;
    // Main-path failures share one threshold; immediate quarantine belongs to
    // the recovery path, where the runtime cannot tell whether paid work
    // already happened.
    assert.equal(input.failureThreshold, undefined);
  },
  releaseWorkspaceLease: async () => true,
  requireWorkspaceOutcome: async () => {
    throw new Error("workspace_worker_required_outcome_missing");
  },
  startWorkspaceWorker: async () => ({
    events: (async function* () {
      yield { data: {}, type: "turn.failed" };
    })(),
  }) as Awaited<ReturnType<EventTriggerScheduleDependencies["startWorkspaceWorker"]>>,
} as unknown as EventTriggerScheduleDependencies);
assert.ok("run" in missingOutcomeSchedule && missingOutcomeSchedule.run);
const missingOutcomeWaiters: Promise<unknown>[] = [];
missingOutcomeSchedule.run({
  appAuth: {
    attributes: {},
    authenticator: "app",
    principalId: "eve:app",
    principalType: "runtime",
  },
  to: (() => {
    throw new Error("legacy_to_not_expected");
  }) as ScheduleToFn,
  waitUntil(task) {
    missingOutcomeWaiters.push(task);
  },
});
await Promise.all(missingOutcomeWaiters);
assert.equal(
  missingOutcomeCode,
  "worker_outcome_missing",
  "a session that failed having committed nothing must report the missing outcome",
);

/*
 * The commit path stages the first presentation unkeyed so delivery can find
 * it. Keying all of them is what made every commentary alert undeliverable.
 */
{
  const controlPlane = await readFile(
    new URL("../agent/lib/workspace-worker-control-plane.ts", import.meta.url),
    "utf8",
  );
  const keyedStagings = [...controlPlane.matchAll(
    /\.\.\.\(presentation(?: && index > 0)? \? \{ presentationKey/gu,
  )];
  assert.equal(keyedStagings.length, 2, "both commit paths stage alerts");
  for (const [staging] of keyedStagings) {
    assert.match(staging, /index > 0/u, "the first presentation must stay unkeyed");
  }
}

const mismatchedClaims: ClaimedWorkspaceMonitor[] = [
  { ...job, monitor: { ...monitor, ownerId: "other_owner" } },
  {
    ...job,
    monitor: {
      ...monitor,
      workspaceId: "223e4567-e89b-42d3-a456-426614174000",
    },
  },
  {
    ...job,
    occurrence: {
      ...job.occurrence,
      monitorId: "423e4567-e89b-42d3-a456-426614174000",
    },
  },
  {
    ...job,
    occurrence: { ...job.occurrence, configurationRevision: 2 },
  },
  { ...job, leaseToken: "tampered-attempt-2-lease" },
];
for (const mismatched of mismatchedClaims) {
  await assert.rejects(
    prepareWorkspaceWorkerRecovery({ claimed: mismatched }),
    /workspace_worker_state_stale/u,
  );
}
await assert.rejects(
  prepareWorkspaceWorkerRecovery({
    claimed: job,
    expectedRunId: `${job.occurrence.occurrenceKey}:attempt:2`,
  }),
  /workspace_worker_state_stale/u,
);

class MemoryStateStore implements WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const staleCapabilityState = new MemoryStateStore();
await writeWorkspaceDocument("brief", {
  expectedRevision: 0,
  now,
  scope,
  value: {
    currentFindingsSummary: "",
    goal: "Track official public SEC S-1 filings.",
    lastMaterialChange: "",
    openQuestions: [],
    promotedFacts: [],
    sourcePolicy: {
      allowedSourceIds: [SEC_IPO_SOURCE_ID],
      maximumAccessClassification: "public",
    },
    strategyConfigurationRevision: 1,
    thesis: "",
    watchlist: [],
  },
}, staleCapabilityState);
await writeWorkspaceDocument("strategy", {
  expectedRevision: 0,
  now,
  scope,
  value: { configuration: {}, strategyPack: null },
}, staleCapabilityState);
await writeWorkspaceDocument("capabilities", {
  expectedRevision: 0,
  now,
  scope,
  value: { ...IPO_FILINGS_CAPABILITY_MANIFEST, sources: [] },
}, staleCapabilityState);
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now,
  scope,
  value: {
    effectiveAt: now.toISOString(),
    maximumConcurrentWorkers: 1,
    maximumInputTokensPerDay: 80_000,
    maximumInputTokensPerRun: 10_000,
    maximumOutputTokensPerDay: 20_000,
    maximumOutputTokensPerRun: 2_000,
    maximumPaidPerCall: null,
    maximumPaidPerDay: null,
    maximumPaidPerMonth: null,
    maximumScheduledRunsPerDay: 20,
    ownerTimezone: "America/Vancouver",
    unknownPriceFallbackCeiling: "0",
  },
}, staleCapabilityState);
const monitorReadClient = {
  get: async () => JSON.stringify(monitor),
} as WorkspaceMonitorStoreClient;
await assert.rejects(
  prepareWorkspaceWorkerRecovery({
    claimed: job,
    clients: { monitor: monitorReadClient, state: staleCapabilityState },
  }),
  /workspace_worker_state_stale/u,
);

console.log("Workspace recovery schedule verification passed.");
