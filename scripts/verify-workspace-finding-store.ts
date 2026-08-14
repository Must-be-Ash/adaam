import assert from "node:assert/strict";

import {
  readWorkspaceRunOutcome,
  WorkspaceFindingError,
  type WorkspaceFindingStoreClient,
} from "../agent/lib/workspace-finding-store";
import { createWorkspaceMonitor, type WorkspaceMonitorStoreClient } from "../agent/lib/workspace-monitor-store";
import {
  createWorkspaceSourceCoverage,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
  WorkspaceSourceCoverageError,
  type WorkspaceSourceCoverageClient,
} from "../agent/lib/workspace-source-coverage";
import { writeWorkspaceDocument, type WorkspaceStateStoreClient } from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  COMPLETE_WORKSPACE_RUN_TOOL_ID,
  completeWorkspaceRunForWorker,
  WRITE_WORKSPACE_FINDING_TOOL_ID,
  writeWorkspaceFindingForWorker,
  WorkspaceWorkerCommitError,
} from "../agent/lib/workspace-worker-control-plane";
import {
  createWorkspaceWorkerEnvelope,
  signWorkspaceWorkerEnvelope,
  workspaceWorkerExecutionAuth,
} from "../agent/lib/workspace-worker-auth";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";

class MemoryCasStore implements WorkspaceStateStoreClient, WorkspaceSourceCoverageClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryFindingStore implements WorkspaceFindingStoreClient {
  readonly values = new Map<string, string>();
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  readonly values = new Map<string, string>();
  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    const raw = this.values.get(input.recordKey);
    if (!raw) return "missing" as const;
    if (raw !== input.expectedRaw) return "stale" as const;
    const monitor = JSON.parse(input.nextRaw);
    if (monitor.configurationRevision !== input.configurationRevision) return "stale" as const;
    this.values.set(input.recordKey, input.nextRaw);
    return "completed" as const;
  }
  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    return true;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async claim(): Promise<{ status: "missing" }> { return { status: "missing" }; }
  async list(): Promise<unknown[]> { return []; }
  async listDue(): Promise<[]> { return []; }
  async releaseLease(): Promise<boolean> { return false; }
  async update(): Promise<boolean> { return false; }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 9).toString("base64url"),
};
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const otherScope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "323e4567-e89b-42d3-a456-426614174000",
}, environment);
const stateClient = new MemoryCasStore();
const coverageClient = new MemoryCasStore();
const findingClient = new MemoryFindingStore();
const monitorClient = new MemoryMonitorStore();
const now = new Date();
const window = {
  endAt: now.toISOString(),
  startAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
};
const source = {
  accessClassification: "public" as const,
  canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
  origin: "https://www.sec.gov",
  sourceId: "sec.latest",
};
const monitor = await createWorkspaceMonitor({
  deliverySubscriptionId: "subscription.fixture",
  instruction: "Check for a new filing.",
  name: "Finding fixture",
  nextOccurrenceAt: now.toISOString(),
  now,
  requiredCapabilityIds: [
    COMPLETE_WORKSPACE_RUN_TOOL_ID,
    WRITE_WORKSPACE_FINDING_TOOL_ID,
    "fetch_public_source",
  ],
  schedule: { at: now.toISOString(), kind: "one_time" },
  scope,
  sources: [source],
  tighteningLimits: { inputTokensPerRun: 500, outputTokensPerRun: 200, paidPerRun: null },
}, monitorClient);
await writeWorkspaceDocument("capabilities", {
  expectedRevision: 0,
  now,
  scope,
  value: {
    connectionIds: [],
    controlPlaneToolIds: [COMPLETE_WORKSPACE_RUN_TOOL_ID, WRITE_WORKSPACE_FINDING_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["filesystem.write"],
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: ["fetch_public_source"],
    skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
    sources: [{ origin: source.origin, sourceId: source.sourceId }],
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 200 },
  },
}, stateClient);

const runId = `${"c".repeat(64)}:attempt:1`;
const claimed = {
  leaseExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  leaseToken: "lease_fixture",
  monitor,
  occurrence: {
    attempt: 1,
    configurationRevision: monitor.configurationRevision,
    leaseTokenDigest: "d".repeat(64),
    monitorId: monitor.monitorId,
    occurrenceIdentity: `one_time:${now.toISOString()}`,
    occurrenceKey: "c".repeat(64),
    scheduledFor: now.toISOString(),
    schemaVersion: 1,
    status: "leased",
    updatedAt: now.toISOString(),
  },
  scope,
  skippedOccurrenceIdentities: [],
} satisfies ClaimedWorkspaceMonitor;
const dispatchBudget = {
  global: {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
  runId,
  workspace: {
    calendarDay: now.toISOString().slice(0, 10),
    calendarMonth: now.toISOString().slice(0, 7),
    createdAt: now.toISOString(),
    inputTokens: 500,
    outputTokens: 200,
    paidMicros: "0",
    policyRevision: 1,
    reconciledInputTokens: null,
    reconciledOutputTokens: null,
    reconciledPaidMicros: null,
    runId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
} satisfies WorkspaceDispatchReservation;
const envelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed,
  dispatchBudget,
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  window,
});
const token = signWorkspaceWorkerEnvelope(envelope, environment);
const ctx = { session: { auth: { current: workspaceWorkerExecutionAuth(envelope, token) } } };
const clients = {
  alert: new MemoryAlertStore(),
  finding: findingClient,
  monitor: monitorClient,
  sourceCoverage: coverageClient,
  state: stateClient,
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);

const finding = {
  accessClassification: "public" as const,
  artifactRefs: [],
  asOf: now.toISOString(),
  provenance: [{
    accessClassification: "public" as const,
    canonicalUrl: "https://www.sec.gov/Archives/edgar/data/1000001/fixture-s1.htm",
    origin: source.origin,
    sourceId: source.sourceId,
  }],
  summary: "Fixture Corp filed a potential IPO registration on Form S-1.",
};

await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now }),
  (error) => error instanceof WorkspaceSourceCoverageError && error.code === "source_coverage_incomplete",
);
await reserveWorkspaceSourceAttempt({ now, runId, scope, sourceId: source.sourceId }, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "e".repeat(64),
  now,
  runId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx,
    environment,
    finding: { ...finding, accessClassification: "owner_private" },
    now,
  }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_classification_denied",
);
const outcome = await writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now });
assert.equal(outcome.outcome, "finding_staged");
assert.equal(outcome.ownerId, scope.ownerId);
assert.equal(outcome.workspaceId, scope.workspaceId);
assert.equal(outcome.runId, runId);
assert.equal(outcome.finding?.summary, finding.summary);
assert.match(outcome.finding?.findingId ?? "", /^finding_[a-f0-9]{64}$/u);
assert.deepEqual(
  await writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now: new Date(now.getTime() + 1_000) }),
  outcome,
);
await assert.rejects(
  completeWorkspaceRunForWorker({ clients, ctx, environment, now }),
  (error) => error instanceof WorkspaceFindingError && error.code === "finding_conflict",
);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx,
    environment,
    finding: {
      ...finding,
      provenance: [{
        ...finding.provenance[0],
        canonicalUrl: "https://sec.gov.evil.example/fixture-s1.htm",
        origin: "https://sec.gov.evil.example",
      }],
    },
    now,
  }),
  (error) =>
    error instanceof WorkspaceFindingError &&
    error.code === "finding_source_outside_fence",
);
assert.deepEqual(await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, findingClient), outcome);
assert.equal(await readWorkspaceRunOutcome(otherScope, envelope.occurrenceKey, findingClient), null);

const retryRunId = `${"c".repeat(64)}:attempt:2`;
const retryClaimed = {
  ...claimed,
  occurrence: {
    ...claimed.occurrence,
    attempt: 2,
    leaseTokenDigest: "9".repeat(64),
  },
} satisfies ClaimedWorkspaceMonitor;
const retryEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: retryClaimed,
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: retryRunId },
    runId: retryRunId,
    workspace: { ...dispatchBudget.workspace, runId: retryRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  window,
});
const retryToken = signWorkspaceWorkerEnvelope(retryEnvelope, environment);
const retryCtx = {
  session: { auth: { current: workspaceWorkerExecutionAuth(retryEnvelope, retryToken) } },
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: retryRunId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
await reserveWorkspaceSourceAttempt({
  now,
  runId: retryRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "e".repeat(64),
  now,
  runId: retryRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
assert.deepEqual(
  await writeWorkspaceFindingForWorker({ clients, ctx: retryCtx, environment, finding, now }),
  outcome,
);

const noMatchRunId = `${"f".repeat(64)}:attempt:1`;
const noMatchClaimed = {
  ...claimed,
  occurrence: {
    ...claimed.occurrence,
    leaseTokenDigest: "f".repeat(64),
    occurrenceKey: "f".repeat(64),
  },
} satisfies ClaimedWorkspaceMonitor;
const noMatchDispatchBudget = {
  ...dispatchBudget,
  global: { ...dispatchBudget.global, runId: noMatchRunId },
  runId: noMatchRunId,
  workspace: { ...dispatchBudget.workspace, runId: noMatchRunId },
} satisfies WorkspaceDispatchReservation;
const noMatchEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: noMatchClaimed,
  dispatchBudget: noMatchDispatchBudget,
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  window,
});
const noMatchToken = signWorkspaceWorkerEnvelope(noMatchEnvelope, environment);
const noMatchCtx = {
  session: { auth: { current: workspaceWorkerExecutionAuth(noMatchEnvelope, noMatchToken) } },
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: noMatchRunId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
await reserveWorkspaceSourceAttempt({
  now,
  runId: noMatchRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "a".repeat(64),
  now,
  runId: noMatchRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
const noMatch = await completeWorkspaceRunForWorker({
  clients,
  ctx: noMatchCtx,
  environment,
  now,
});
assert.equal(noMatch.outcome, "no_match");
assert.equal(noMatch.finding, null);
assert.deepEqual(
  await completeWorkspaceRunForWorker({ clients, ctx: noMatchCtx, environment, now }),
  noMatch,
);
await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx: noMatchCtx, environment, finding, now }),
  (error) => error instanceof WorkspaceFindingError && error.code === "finding_conflict",
);

const rawMonitor = [...monitorClient.values.entries()][0];
assert.ok(rawMonitor);
monitorClient.values.set(rawMonitor[0], JSON.stringify({
  ...JSON.parse(rawMonitor[1]),
  configurationRevision: monitor.configurationRevision + 1,
}));
await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_run_stale",
);

await writeWorkspaceDocument("capabilities", {
  expectedRevision: 1,
  now: new Date(now.getTime() + 2_000),
  scope,
  value: {
    connectionIds: [],
    controlPlaneToolIds: [COMPLETE_WORKSPACE_RUN_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["filesystem.write"],
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: ["fetch_public_source"],
    skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
    sources: [{ origin: source.origin, sourceId: source.sourceId }],
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 200 },
  },
}, stateClient);
const deniedRunId = `${"b".repeat(64)}:attempt:1`;
const deniedEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 2,
  claimed: {
    ...claimed,
    occurrence: {
      ...claimed.occurrence,
      leaseTokenDigest: "b".repeat(64),
      occurrenceKey: "b".repeat(64),
    },
  },
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: deniedRunId },
    runId: deniedRunId,
    workspace: { ...dispatchBudget.workspace, runId: deniedRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  window,
});
const deniedToken = signWorkspaceWorkerEnvelope(deniedEnvelope, environment);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx: {
      session: { auth: { current: workspaceWorkerExecutionAuth(deniedEnvelope, deniedToken) } },
    },
    environment,
    finding,
    now,
  }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_capability_denied",
);

console.info("Scoped workspace finding and completion verification passed.");
