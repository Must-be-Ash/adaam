import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  finishWorkspaceMonitorDispatchBudget,
  readGlobalDispatchBudgetLedger,
  reserveWorkspaceMonitorDispatchBudget,
  resolveWorkspaceGlobalBudgetLimits,
  WorkspaceDispatchBudgetError,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import {
  authorizeDeploymentWorkspaceStore,
  type AuthorizedWorkspaceStoreScope,
} from "../agent/lib/workspace-store-authorization";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";

class MemoryStore
  implements WorkspaceGlobalBudgetClient, WorkspaceBudgetLedgerClient, WorkspaceStateStoreClient
{
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

const now = new Date("2026-08-14T17:00:00.000Z");
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "2",
  EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "3",
};
const policy = {
  effectiveAt: now.toISOString(),
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 2_000,
  maximumInputTokensPerRun: 600,
  maximumOutputTokensPerDay: 1_000,
  maximumOutputTokensPerRun: 300,
  maximumPaidPerCall: "0",
  maximumPaidPerDay: "0",
  maximumPaidPerMonth: "0",
  maximumScheduledRunsPerDay: 3,
  ownerTimezone: "America/Vancouver",
  unknownPriceFallbackCeiling: "0",
};

function scope(workspaceId: string): AuthorizedWorkspaceStoreScope {
  return authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId },
    environment,
  );
}

function job(
  authorizedScope: AuthorizedWorkspaceStoreScope,
  suffix: string,
): ClaimedWorkspaceMonitor {
  return {
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    leaseToken: `lease_${suffix}`,
    monitor: {
      configurationRevision: 1,
      consecutiveFailures: 0,
      createdAt: now.toISOString(),
      deliverySubscriptionId: "delivery.fixture",
      endAt: null,
      instruction: "Inspect the configured public source.",
      lastCompletedAt: null,
      lastErrorCode: null,
      lastRunAt: null,
      lifecycleState: "enabled",
      monitorId: `${suffix.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`,
      name: `Monitor ${suffix}`,
      nextOccurrenceAt: now.toISOString(),
      ownerId: authorizedScope.ownerId,
      pauseReason: null,
      pausedAt: null,
      requiredCapabilityIds: [],
      schedule: { at: now.toISOString(), kind: "one_time" },
      schemaVersion: 1,
      sourceCheckpoint: { contentDigest: null, watermark: null },
      sources: [
        {
          accessClassification: "public",
          canonicalUrl: "https://example.gov/feed",
          origin: "https://example.gov",
          sourceId: "source.fixture",
        },
      ],
      tighteningLimits: {
        inputTokensPerRun: 300,
        outputTokensPerRun: 100,
        paidPerRun: null,
      },
      updatedAt: now.toISOString(),
      workspaceBindingImmutable: true,
      workspaceId: authorizedScope.workspaceId,
    },
    occurrence: {
      attempt: 1,
      configurationRevision: 1,
      leaseTokenDigest: "a".repeat(64),
      monitorId: `${suffix.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`,
      occurrenceIdentity: `${now.toISOString()}:${suffix}`,
      occurrenceKey: suffix.padEnd(64, "a").slice(0, 64),
      scheduledFor: now.toISOString(),
      schemaVersion: 1,
      status: "leased",
      updatedAt: now.toISOString(),
    },
    scope: authorizedScope,
    skippedOccurrenceIdentities: [],
  };
}

async function putPolicy(
  authorizedScope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceStateStoreClient,
) {
  await writeWorkspaceDocument(
    "budget",
    { expectedRevision: 0, now, scope: authorizedScope, value: policy },
    client,
  );
}

assert.deepEqual(resolveWorkspaceGlobalBudgetLimits({}), {
  maximumConcurrentWorkers: 8,
  maximumRunsPerDay: 500,
});
assert.throws(
  () => resolveWorkspaceGlobalBudgetLimits({ EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "501" }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "global_budget_invalid",
);

const global = new MemoryStore();
const state = new MemoryStore();
const workspace = new MemoryStore();
const clients = { global, state, workspace };
const scopeA = scope("123e4567-e89b-42d3-a456-426614174000");
const scopeB = scope("223e4567-e89b-42d3-a456-426614174000");
const scopeC = scope("323e4567-e89b-42d3-a456-426614174000");
await Promise.all([
  putPolicy(scopeA, state),
  putPolicy(scopeB, state),
  putPolicy(scopeC, state),
]);

const jobA = job(scopeA, "a1");
const admittedA = await reserveWorkspaceMonitorDispatchBudget(jobA, {
  clients,
  environment,
  now,
});
assert.equal(admittedA.workspace.inputTokens, 300);
assert.equal(admittedA.workspace.outputTokens, 100);

await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "a2"), {
    clients,
    environment,
    now,
  }),
  (error: unknown) => error instanceof Error && error.message === "budget_exhausted",
);

const jobB = job(scopeB, "b1");
const admittedB = await reserveWorkspaceMonitorDispatchBudget(jobB, {
  clients,
  environment,
  now,
});
await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeC, "c1"), {
    clients,
    environment,
    now,
  }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "global_budget_exhausted",
);
await finishWorkspaceMonitorDispatchBudget(
  jobA,
  admittedA,
  { now, outcome: "released" },
  clients,
);
const jobC = job(scopeC, "c2");
const admittedC = await reserveWorkspaceMonitorDispatchBudget(jobC, {
  clients,
  environment,
  now,
});
await finishWorkspaceMonitorDispatchBudget(
  jobB,
  admittedB,
  { actualInputTokens: 200, actualOutputTokens: 50, now, outcome: "reconciled" },
  clients,
);
await finishWorkspaceMonitorDispatchBudget(
  jobC,
  admittedC,
  { now, outcome: "released" },
  clients,
);
const ledger = await readGlobalDispatchBudgetLedger(global);
assert.equal(ledger.reservations.filter((entry) => entry.state === "reserved").length, 0);
assert.equal(ledger.reservations.filter((entry) => entry.state === "settled").length, 1);

const missingGlobal = new MemoryStore();
const missingWorkspace = new MemoryStore();
await assert.rejects(
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "missing"), {
    clients: { global: missingGlobal, state: new MemoryStore(), workspace: missingWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
  (error) =>
    error instanceof WorkspaceDispatchBudgetError &&
    error.code === "workspace_budget_missing",
);
const validState = new MemoryStore();
await putPolicy(scopeB, validState);
await reserveWorkspaceMonitorDispatchBudget(job(scopeB, "valid"), {
  clients: { global: missingGlobal, state: validState, workspace: missingWorkspace },
  environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
  now,
});

const raceGlobal = new MemoryStore();
const raceState = new MemoryStore();
const raceWorkspace = new MemoryStore();
await Promise.all([putPolicy(scopeA, raceState), putPolicy(scopeB, raceState)]);
const race = await Promise.allSettled([
  reserveWorkspaceMonitorDispatchBudget(job(scopeA, "racea"), {
    clients: { global: raceGlobal, state: raceState, workspace: raceWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
  reserveWorkspaceMonitorDispatchBudget(job(scopeB, "raceb"), {
    clients: { global: raceGlobal, state: raceState, workspace: raceWorkspace },
    environment: { ...environment, EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1" },
    now,
  }),
]);
assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(race.filter((result) => result.status === "rejected").length, 1);

const scheduleSource = await readFile(
  new URL("../agent/schedules/event-triggers.ts", import.meta.url),
  "utf8",
);
assert.ok(
  scheduleSource.indexOf("claimDueWorkspaceMonitors({") <
    scheduleSource.indexOf("reserveWorkspaceMonitorDispatchBudget(job"),
);
assert.match(scheduleSource, /releaseWorkspaceMonitorLease/u);

console.info("Workspace dispatch budget verification passed.");
