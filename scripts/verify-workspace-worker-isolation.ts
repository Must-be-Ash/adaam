import assert from "node:assert/strict";

import { IPO_FILINGS_CAPABILITY_MANIFEST, SEC_IPO_SOURCE_ID, SEC_IPO_SOURCE_URL } from "../agent/lib/sec-ipo-reference";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceFindingStoreClient } from "../agent/lib/workspace-finding-store";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  prepareWorkspaceWorkerRun,
  requireWorkspaceWorkerOutcome,
  WorkspaceWorkerRunnerError,
} from "../agent/lib/workspace-worker-runner";

class MemoryCasStore implements WorkspaceStateStoreClient, WorkspaceSourceCoverageClient {
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

class EmptyFindingStore implements WorkspaceFindingStoreClient {
  async createOutcomeWithIdentityClaims(input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0]) {
    return { status: "created" as const, value: input.outcomeValue };
  }

  async createOrRead(_key: string, value: string) {
    return value;
  }

  async get() {
    return null;
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 19).toString("base64url"),
};
const now = new Date("2026-08-14T17:00:00.000Z");
const state = new MemoryCasStore();
const workspaceIds = [
  "123e4567-e89b-42d3-a456-426614174000",
  "223e4567-e89b-42d3-a456-426614174000",
] as const;
const scopes = workspaceIds.map((workspaceId) =>
  authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId }, environment),
);

for (const [index, scope] of scopes.entries()) {
  await writeWorkspaceDocument("brief", {
    expectedRevision: 0,
    now,
    scope,
    value: {
      currentFindingsSummary: "",
      goal: `isolated-goal-${index + 1}`,
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
  }, state);
  await writeWorkspaceDocument("strategy", {
    expectedRevision: 0,
    now,
    scope,
    value: { configuration: {}, strategyPack: null },
  }, state);
  await writeWorkspaceDocument("capabilities", {
    expectedRevision: 0,
    now,
    scope,
    value: IPO_FILINGS_CAPABILITY_MANIFEST,
  }, state);
  await writeWorkspaceDocument("budget", {
    expectedRevision: 0,
    now,
    scope,
    value: {
      effectiveAt: now.toISOString(),
      maximumConcurrentWorkers: 2,
      maximumInputTokensPerDay: 20_000,
      maximumInputTokensPerRun: 10_000,
      maximumOutputTokensPerDay: 4_000,
      maximumOutputTokensPerRun: 2_000,
      maximumPaidPerCall: null,
      maximumPaidPerDay: null,
      maximumPaidPerMonth: null,
      maximumScheduledRunsPerDay: 8,
      ownerTimezone: "America/Vancouver",
      unknownPriceFallbackCeiling: "0",
    },
  }, state);
}

function claimed(index: number): ClaimedWorkspaceMonitor {
  const scope = scopes[index]!;
  const monitorId = `${index + 3}23e4567-e89b-42d3-a456-426614174000`;
  const occurrenceKey = String.fromCharCode(97 + index).repeat(64);
  return {
    leaseExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    leaseToken: `lease-${index + 1}`,
    monitor: {
      configurationRevision: 1,
      consecutiveFailures: 0,
      createdAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
      deliverySubscriptionId: `delivery.${index + 1}`,
      endAt: null,
      instruction: `Evaluate only IPO workspace ${index + 1}.`,
      lastCompletedAt: null,
      lastErrorCode: null,
      lastRunAt: null,
      lifecycleState: "enabled",
      monitorId,
      name: `IPO fixture ${index + 1}`,
      nextOccurrenceAt: now.toISOString(),
      ownerId: scope.ownerId,
      pauseReason: null,
      pausedAt: null,
      requiredCapabilityIds: ["tool.fetch_public_source"],
      schedule: { everyMinutes: 60, kind: "interval", startsAt: new Date(now.getTime() - 60 * 60_000).toISOString() },
      schemaVersion: 1,
      sourceCheckpoint: { contentDigest: null, watermark: null },
      sources: [{
        accessClassification: "public",
        canonicalUrl: SEC_IPO_SOURCE_URL,
        origin: "https://www.sec.gov",
        sourceId: SEC_IPO_SOURCE_ID,
      }],
      tighteningLimits: { inputTokensPerRun: 10_000, outputTokensPerRun: 2_000, paidPerRun: null },
      updatedAt: now.toISOString(),
      workspaceBindingImmutable: true,
      workspaceId: scope.workspaceId,
    },
    occurrence: {
      attempt: 1,
      configurationRevision: 1,
      leaseTokenDigest: String(index + 3).repeat(64),
      monitorId,
      occurrenceIdentity: `interval:${now.toISOString()}`,
      occurrenceKey,
      scheduledFor: now.toISOString(),
      schemaVersion: 1,
      status: "leased",
      updatedAt: now.toISOString(),
    },
    scope,
    skippedOccurrenceIdentities: [],
  };
}

function reservation(job: ClaimedWorkspaceMonitor): WorkspaceDispatchReservation {
  const runId = `${job.occurrence.occurrenceKey}:attempt:1`;
  const common = {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId,
    state: "reserved" as const,
    updatedAt: now.toISOString(),
  };
  return {
    global: common,
    runId,
    workspace: {
      ...common,
      calendarMonth: now.toISOString().slice(0, 7),
      inputTokens: 10_000,
      outputTokens: 2_000,
      paidMicros: "0",
      policyRevision: 1,
      reconciledInputTokens: null,
      reconciledOutputTokens: null,
      reconciledPaidMicros: null,
    },
  };
}

const jobs = [claimed(0), claimed(1)];
const prepared = await Promise.all(jobs.map((job) =>
  prepareWorkspaceWorkerRun({
    claimed: job,
    clients: { sourceCoverage: state, state },
    dispatchBudget: reservation(job),
    environment,
    now,
  }),
));

for (const run of prepared) {
  // A scheduled occurrence no longer runs an LLM worker, so the prepared request
  // carries no prompt, brief, strategy, or session config to leak across
  // workspaces - only the signed runtime auth. The deterministic evaluator reads
  // everything else from durable stores keyed off that envelope. Isolation now
  // means the auth is scoped to exactly this workspace's run.
  assert.deepEqual(Object.keys(run.request).sort(), ["auth"]);
  assert.equal(run.envelope.strategyPack, null);
  assert.equal(run.request.auth.attributes.workspace_id, run.envelope.workspaceId);
  assert.equal(run.request.auth.attributes.workspace_run_id, run.envelope.runId);
  assert.equal(run.request.auth.principalId, `workspace-run:${run.envelope.runId}`);
  assert.equal(run.request.auth.subject, run.envelope.runId);
  for (const forbidden of ["conversationId", "generation", "interactive history", "threadId"]) {
    assert.equal(JSON.stringify(run.request).includes(forbidden), false);
  }
}
// Two different workspaces must never share a run identity or a scoped principal.
assert.notEqual(prepared[0]!.envelope.workspaceId, prepared[1]!.envelope.workspaceId);
assert.notEqual(prepared[0]!.envelope.runId, prepared[1]!.envelope.runId);
assert.notEqual(prepared[0]!.request.auth.principalId, prepared[1]!.request.auth.principalId);

await assert.rejects(
  requireWorkspaceWorkerOutcome(prepared[0]!, new EmptyFindingStore()),
  (error) => error instanceof WorkspaceWorkerRunnerError &&
    error.code === "workspace_worker_required_outcome_missing",
);

console.info("Workspace worker isolation verification passed.");
