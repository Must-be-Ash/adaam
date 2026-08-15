import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { ScheduleToFn } from "eve/schedules";

import { createEventTriggerSchedule, type EventTriggerScheduleDependencies } from "../agent/schedules/event-triggers";
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
  /quarantine_write_failed/u,
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
  /worker_recovery_lease_release_failed/u,
);
await assert.rejects(
  runScenario({
    inspectWorkspaceLease: async () => "current",
    releaseWorkspaceLease: async () => {
      throw new Error("lease_release_failed");
    },
  }),
  /lease_release_failed/u,
);
await runScenario({
  inspectWorkspaceLease: async () => "stale",
  releaseWorkspaceLease: async () => {
    throw new Error("concurrent_lease_change");
  },
});

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
