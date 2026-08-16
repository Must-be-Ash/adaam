import assert from "node:assert/strict";

import {
  createWorkspaceWorkerEnvelope,
  requireWorkspaceWorkerAuth,
  signWorkspaceWorkerEnvelope,
  verifyWorkspaceWorkerToken,
  workspaceWorkerExecutionAuth,
  WorkspaceWorkerAuthError,
} from "../agent/lib/workspace-worker-auth";
import { authorizeDeploymentWorkspaceStore, authorizeWorkspaceWorkerStore } from "../agent/lib/workspace-store-authorization";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 7).toString("base64url"),
};
const scope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
  environment,
);
const issuedAt = new Date();
const leaseExpiresAt = new Date(issuedAt.getTime() + 30 * 60_000);
const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000);
const runId = `${"a".repeat(64)}:attempt:1`;
const claimed = {
  leaseExpiresAt: leaseExpiresAt.toISOString(),
  leaseToken: "lease_fixture",
  monitor: {
    configurationRevision: 4,
    consecutiveFailures: 0,
    createdAt: new Date(issuedAt.getTime() - 60_000).toISOString(),
    deliverySubscriptionId: "delivery.fixture",
    endAt: null,
    instruction: "Check the configured source.",
    lastCompletedAt: null,
    lastErrorCode: null,
    lastRunAt: null,
    lifecycleState: "enabled",
    monitorId: "223e4567-e89b-42d3-a456-426614174000",
    name: "Worker auth fixture",
    nextOccurrenceAt: issuedAt.toISOString(),
    ownerId: scope.ownerId,
    pauseReason: null,
    pausedAt: null,
    requiredCapabilityIds: ["tool.fetch_public_source"],
    schedule: { at: issuedAt.toISOString(), kind: "one_time" },
    schemaVersion: 1,
    sourceCheckpoint: { contentDigest: null, watermark: null },
    sources: [{
      accessClassification: "public",
      canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
      origin: "https://www.sec.gov",
      sourceId: "sec.latest",
    }],
    tighteningLimits: { inputTokensPerRun: 500, outputTokensPerRun: 200, paidPerRun: null },
    updatedAt: issuedAt.toISOString(),
    workspaceBindingImmutable: true,
    workspaceId: scope.workspaceId,
  },
  occurrence: {
    attempt: 1,
    configurationRevision: 4,
    leaseTokenDigest: "b".repeat(64),
    monitorId: "223e4567-e89b-42d3-a456-426614174000",
    occurrenceIdentity: `one_time:${issuedAt.toISOString()}`,
    occurrenceKey: "a".repeat(64),
    scheduledFor: issuedAt.toISOString(),
    schemaVersion: 1,
    status: "leased",
    updatedAt: issuedAt.toISOString(),
  },
  scope,
  skippedOccurrenceIdentities: [],
} satisfies ClaimedWorkspaceMonitor;
const dispatchBudget = {
  global: {
    calendarDay: issuedAt.toISOString().slice(0, 10),
    createdAt: issuedAt.toISOString(),
    runId,
    state: "reserved",
    updatedAt: issuedAt.toISOString(),
  },
  runId,
  workspace: {
    calendarDay: issuedAt.toISOString().slice(0, 10),
    calendarMonth: issuedAt.toISOString().slice(0, 7),
    createdAt: issuedAt.toISOString(),
    inputTokens: 500,
    outputTokens: 200,
    paidMicros: "0",
    policyRevision: 3,
    reconciledInputTokens: null,
    reconciledOutputTokens: null,
    reconciledPaidMicros: null,
    runId,
    state: "reserved",
    updatedAt: issuedAt.toISOString(),
  },
} satisfies WorkspaceDispatchReservation;

const envelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 3,
  capabilityRevision: 5,
  claimed,
  dispatchBudget,
  expiresAt,
  issuedAt,
  stateRevision: { brief: 7, strategy: 2 },
  strategyPack: null,
  window: {
    endAt: issuedAt.toISOString(),
    startAt: new Date(issuedAt.getTime() - 60 * 60_000).toISOString(),
  },
});
assert.equal(envelope.workspaceId, scope.workspaceId);
assert.equal(envelope.reservedBudget.inputTokens, 500);
assert.deepEqual(envelope.sources, claimed.monitor.sources);
const serialized = JSON.stringify(envelope);
for (const forbidden of ["threadId", "conversationId", "generation", "history", "lease_fixture"]) {
  assert.equal(serialized.includes(forbidden), false);
}

const token = signWorkspaceWorkerEnvelope(envelope, environment);
assert.equal(signWorkspaceWorkerEnvelope(envelope, environment), token);
assert.deepEqual(verifyWorkspaceWorkerToken(token, { now: issuedAt }, environment), envelope);
const auth = workspaceWorkerExecutionAuth(envelope, token);
assert.deepEqual(Object.keys(auth.attributes).sort(), [
  "workspace_id",
  "workspace_run_id",
  "workspace_runtime_token",
]);
const ctx = { session: { auth: { current: auth } } };
assert.deepEqual(requireWorkspaceWorkerAuth(ctx, { runId }, environment), envelope);
assert.deepEqual(authorizeWorkspaceWorkerStore(ctx, environment), {
  ownerId: scope.ownerId,
  workspaceId: scope.workspaceId,
});

const [payload, signature] = token.split(".");
await assert.rejects(
  Promise.resolve().then(() => verifyWorkspaceWorkerToken(`${payload}x.${signature}`, { now: issuedAt }, environment)),
  WorkspaceWorkerAuthError,
);
assert.throws(
  () => verifyWorkspaceWorkerToken(token, { now: expiresAt }, environment),
  WorkspaceWorkerAuthError,
);
assert.throws(
  () => verifyWorkspaceWorkerToken(token, { now: issuedAt }, {
    ...environment,
    EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 8).toString("base64url"),
  }),
  WorkspaceWorkerAuthError,
);
assert.throws(
  () => requireWorkspaceWorkerAuth({
    session: { auth: { current: { ...auth, attributes: { ...auth.attributes, workspace_id: "223e4567-e89b-42d3-a456-426614174000" } } } },
  }, {}, environment),
  WorkspaceWorkerAuthError,
);
assert.throws(
  () => createWorkspaceWorkerEnvelope({
    budgetRevision: 3,
    capabilityRevision: 5,
    claimed,
    dispatchBudget,
    expiresAt: new Date(issuedAt.getTime() + 3 * 60 * 60_000),
    issuedAt,
    stateRevision: { brief: 7, strategy: 2 },
    strategyPack: null,
    window: { endAt: issuedAt.toISOString(), startAt: new Date(issuedAt.getTime() - 1).toISOString() },
  }),
  WorkspaceWorkerAuthError,
);

console.info("Workspace worker auth verification passed.");
