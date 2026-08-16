import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "redis";

import {
  readWorkspaceBudgetLedger,
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import {
  assignLegacyMonitorToWorkspace,
  WORKSPACE_LEGACY_ASSIGNMENT_REDIS_SCRIPT,
  type WorkspaceLegacyMonitorAssignmentClient,
} from "../agent/lib/workspace-legacy-monitor-assignment";
import {
  WORKSPACE_FINDING_REDIS_SCRIPTS,
  type WorkspaceFindingStoreClient,
} from "../agent/lib/workspace-finding-store";
import {
  claimDueWorkspaceMonitors,
  claimWorkspaceMonitorOccurrence,
  completeWorkspaceMonitorCheckpoint,
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  pauseWorkspaceMonitorAfterUncertainAlert,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  resolveWorkspaceStrategyManagedMonitors,
  updateWorkspaceMonitor,
  WORKSPACE_MONITOR_REDIS_SCRIPTS,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import {
  completeWorkspaceSourceCoverage,
  createWorkspaceSourceCoverage,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
  type WorkspaceSourceCoverageClient,
} from "../agent/lib/workspace-source-coverage";
import {
  migrateWorkspaceStrategyDocument,
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

const redisServer = process.env.REDIS_SERVER_BIN;
if (!redisServer) throw new Error("Set REDIS_SERVER_BIN to an ephemeral local redis-server binary.");
const port = 20_000 + (process.pid % 20_000);
const directory = await mkdtemp(join(tmpdir(), "eve-workspace-redis-"));
let server: ChildProcess | undefined;
const client = createClient({
  socket: { connectTimeout: 500, reconnectStrategy: false },
  url: `redis://127.0.0.1:${port}`,
});

async function start() {
  server = spawn(redisServer, [
    "--bind", "127.0.0.1",
    "--dir", directory,
    "--port", String(port),
    "--save", "",
    "--appendonly", "no",
  ], { stdio: "ignore" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await client.connect();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Ephemeral Redis did not start.");
}

const evalScript = (script: string, keys: string[], args: string[]) =>
  client.eval(script, { arguments: args, keys });
const casScript = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;
const casClient: WorkspaceBudgetLedgerClient & WorkspaceSourceCoverageClient & WorkspaceStateStoreClient = {
  async compareAndSet(key, expected, next) {
    return Number(await evalScript(casScript, [key], [expected ?? "", next])) === 1;
  },
  get: (key) => client.get(key),
};
const monitorClient: WorkspaceMonitorStoreClient = {
  async complete(input) {
    const result = String(await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.complete,
      [input.recordKey, input.leaseKey, input.dueKey, input.inflightKey, input.occurrenceRecordKey],
      [
        String(input.configurationRevision), input.leaseTokenDigest,
        input.expectedRaw, input.nextRaw, input.completedAt,
        String(90 * 24 * 60 * 60), input.nextDueAtMs === null ? "" : String(input.nextDueAtMs),
      ],
    )) as "completed" | "lease_mismatch" | "missing" | "stale";
    return result;
  },
  async claim(input) {
    const result = await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.claim,
      [input.recordKey, input.leaseKey, input.occurrenceRecordKey, input.dueKey, input.inflightKey],
      [
        String(input.configurationRevision), String(input.nowMs), String(input.dueAtMs),
        input.leaseToken, String(input.leaseForMs), input.occurrenceKey, input.monitorId,
        input.occurrenceIdentity, input.leaseTokenDigest, input.scheduledFor, input.updatedAt,
        String(90 * 24 * 60 * 60), String(input.leaseExpiresAtMs),
      ],
    ) as string[];
    return result[0] === "claimed"
      ? { attempt: Number(result[1]), status: "claimed" as const }
      : { status: result[0] as "duplicate" | "leased" | "missing" | "not_due" | "stale" };
  },
  async create(input) {
    return Number(await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.create,
      [input.recordKey, input.workspaceIndexKey, input.dueKey],
      [input.raw, input.dueAtMs === null ? "" : String(input.dueAtMs)],
    )) === 1;
  },
  get: (key) => client.get(key),
  async list(indexKey) {
    const keys = await client.sMembers(indexKey);
    return keys.length === 0 ? [] : client.mGet(keys);
  },
  async listDue(input) {
    const raw = String(await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.listDue,
      [input.dueKey, input.inflightKey],
      [String(input.nowMs), String(input.limit)],
    ));
    return JSON.parse(raw) as { raw: unknown; recordKey: string }[];
  },
  async releaseLease(input) {
    return Number(await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.releaseLease,
      [input.leaseKey, input.recordKey, input.dueKey, input.inflightKey],
      [input.leaseToken, input.dueAtMs === null ? "" : String(input.dueAtMs)],
    )) === 1;
  },
  async update(input) {
    return Number(await evalScript(
      WORKSPACE_MONITOR_REDIS_SCRIPTS.update,
      [input.recordKey, input.dueKey],
      [input.expected, input.next, input.dueAtMs === null ? "" : String(input.dueAtMs)],
    )) === 1;
  },
};
const assignmentClient: WorkspaceLegacyMonitorAssignmentClient = {
  async assign(input) {
    return String(await evalScript(
      WORKSPACE_LEGACY_ASSIGNMENT_REDIS_SCRIPT,
      [
        input.legacyRecordKey, input.legacyLeaseKey, input.activeRunKey,
        input.monitorRecordKey, input.monitorIndexKey, input.monitorDueKey,
        input.legacyDueKey, input.assignmentKey,
      ],
      [
        input.legacyRaw, input.legacyNextRaw, input.legacyId, input.monitorRaw,
        input.monitorDueAtMs === null ? "" : String(input.monitorDueAtMs), input.assignmentRaw,
      ],
    ));
  },
  get: (key) => client.get(key),
};
const findingClient: WorkspaceFindingStoreClient = {
  async createOutcomeWithIdentityClaims(input) {
    const result = await evalScript(
      WORKSPACE_FINDING_REDIS_SCRIPTS.createOutcomeWithIdentityClaims,
      [input.outcomeKey, ...input.identityClaims.map(({ key }) => key)],
      [input.outcomeValue, ...input.identityClaims.map(({ value }) => value)],
    ) as unknown[];
    return {
      status: String(result[0]) as "created" | "existing" | "identity_conflict",
      value: result[1],
    };
  },
  async createOrRead(key, value) {
    const result = await evalScript(
      `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`,
      [key],
      [value],
    );
    return result;
  },
  get: (key) => client.get(key),
};

const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_redis" };
const scopeA = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_redis", workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
  environment,
);
const scopeB = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_redis", workspaceId: "223e4567-e89b-42d3-a456-426614174000" },
  environment,
);
const now = new Date("2026-08-14T17:00:00.000Z");
const policy = {
  effectiveAt: now.toISOString(), maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 2_000, maximumInputTokensPerRun: 500,
  maximumOutputTokensPerDay: 1_000, maximumOutputTokensPerRun: 250,
  maximumPaidPerCall: "0", maximumPaidPerDay: "0", maximumPaidPerMonth: "0",
  maximumScheduledRunsPerDay: 3, ownerTimezone: "UTC", unknownPriceFallbackCeiling: "0",
};

try {
  await start();
  await writeWorkspaceDocument("strategy", {
    expectedRevision: 0,
    now,
    scope: scopeA,
    value: {
      configuration: { legacyThreshold: 2 },
      strategyPack: { id: "legacy-redis-pack", version: "1.0.0" },
    },
  }, casClient);
  const migratedLegacy = await migrateWorkspaceStrategyDocument(
    { expectedRevision: 1, now, scope: scopeA },
    casClient,
  );
  assert.equal(migratedLegacy?.value.lifecycleState, "unavailable");
  assert.equal(migratedLegacy?.value.health.code, "legacy_unverified");
  assert.equal((await readWorkspaceDocument("strategy", scopeA, casClient))?.schemaVersion, 2);

  await writeWorkspaceDocument("strategy", {
    expectedRevision: 0,
    now,
    scope: scopeB,
    value: { configuration: {}, strategyPack: null },
  }, casClient);
  let barrierReads = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const migrationRaceClient: WorkspaceStateStoreClient = {
    compareAndSet: (key, expected, next) => casClient.compareAndSet(key, expected, next),
    async get(key) {
      const value = await casClient.get(key);
      barrierReads += 1;
      if (barrierReads === 2) releaseBarrier();
      await barrier;
      return value;
    },
  };
  const migrationRace = await Promise.allSettled([
    migrateWorkspaceStrategyDocument(
      { expectedRevision: 1, now, scope: scopeB },
      migrationRaceClient,
    ),
    migrateWorkspaceStrategyDocument(
      { expectedRevision: 1, now, scope: scopeB },
      migrationRaceClient,
    ),
  ]);
  assert.equal(migrationRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(migrationRace.filter((result) => result.status === "rejected").length, 1);
  const migratedNull = await readWorkspaceDocument("strategy", scopeB, casClient);
  assert.equal(migratedNull?.schemaVersion, 2);
  assert.equal(migratedNull?.value.lifecycleState, "unbound");

  const monitor = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis", instruction: "Check the source.",
    name: "Redis monitor", nextOccurrenceAt: now.toISOString(), now,
    schedule: { anchor: now.toISOString(), everyMinutes: 30, kind: "interval" },
    scope: scopeA,
    sources: [{
      accessClassification: "public", canonicalUrl: "https://example.gov/feed",
      origin: "https://example.gov", sourceId: "source.redis",
    }],
  }, monitorClient);
  assert.equal(monitor.managedBy, null);

  const managedDigest = "e".repeat(64);
  const managedMonitor = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis",
    idempotencyKey: "redis-managed-monitor",
    instruction: "Stay paused until an explicit owner activation.",
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: managedDigest,
      packId: "redis-pack",
      packVersion: "1.0.0",
      resourceId: "redis-monitor",
    },
    name: "Redis managed monitor",
    nextOccurrenceAt: now.toISOString(),
    now,
    schedule: { at: now.toISOString(), kind: "one_time" },
    scope: scopeB,
    sources: [{
      accessClassification: "public",
      canonicalUrl: "https://example.gov/managed",
      origin: "https://example.gov",
      sourceId: "source.managed",
    }],
  }, monitorClient);
  assert.equal(managedMonitor.lifecycleState, "paused");
  assert.equal(managedMonitor.pauseReason, "strategy_pack_install_only");
  assert.deepEqual(resolveWorkspaceStrategyManagedMonitors({
    bindingRevision: 1,
    configuration: {},
    effectiveCapabilityManifestRevision: 1,
    health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
    lastActiveSnapshot: {
      bindingRevision: 1,
      capabilityManifestRevision: 1,
      packContentDigest: managedDigest,
      packId: "redis-pack",
      packVersion: "1.0.0",
      workspaceGeneration: 1,
    },
    lifecycleState: "active",
    managedResources: {
      "redis-monitor": {
        monitorId: managedMonitor.monitorId,
        sourceIds: ["source.managed"],
      },
    },
    ownerOverrides: {},
    pack: { contentDigest: managedDigest, id: "redis-pack", version: "1.0.0" },
    pendingSnapshot: null,
    timestamps: {
      activatedAt: now.toISOString(),
      configuredAt: null,
      generationRolloverAt: now.toISOString(),
      installedAt: now.toISOString(),
    },
  }, [monitor, managedMonitor]), [managedMonitor]);
  const claims = await Promise.allSettled([
    claimWorkspaceMonitorOccurrence({
      configurationRevision: 1, leaseForMs: 1_000, monitorId: monitor.monitorId,
      now, occurrenceIdentity: `interval:${now.toISOString()}`, scheduledFor: now.toISOString(), scope: scopeA,
    }, monitorClient),
    claimWorkspaceMonitorOccurrence({
      configurationRevision: 1, leaseForMs: 1_000, monitorId: monitor.monitorId,
      now, occurrenceIdentity: `interval:${now.toISOString()}`, scheduledFor: now.toISOString(), scope: scopeA,
    }, monitorClient),
  ]);
  assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);
  const firstClaim = claims.find((result) => result.status === "fulfilled")!;
  if (firstClaim.status !== "fulfilled") throw new Error("claim fixture failed");
  assert.equal(await releaseWorkspaceMonitorLease({
    leaseToken: "wrong", monitorId: monitor.monitorId, scope: scopeA,
  }, monitorClient), false);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const recovered = await claimDueWorkspaceMonitors({
    environment, leaseForMs: 1_000, limit: 10,
    now: new Date(now.getTime() + 1_100), recoveryWindowMs: 60_000,
  }, monitorClient);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.occurrence.attempt, 2);
  const completedMonitor = await completeWorkspaceMonitorCheckpoint({
    completedAt: new Date(now.getTime() + 1_200),
    configurationRevision: recovered[0]!.monitor.configurationRevision,
    contentDigest: "f".repeat(64),
    leaseTokenDigest: recovered[0]!.occurrence.leaseTokenDigest,
    monitorId: recovered[0]!.monitor.monitorId,
    occurrenceKey: recovered[0]!.occurrence.occurrenceKey,
    scheduledFor: recovered[0]!.occurrence.scheduledFor,
    scope: recovered[0]!.scope,
    watermark: now.toISOString(),
  }, monitorClient);
  assert.deepEqual(completedMonitor.sourceCheckpoint, {
    contentDigest: "f".repeat(64),
    watermark: now.toISOString(),
  });
  assert.equal(completedMonitor.nextOccurrenceAt, "2026-08-14T17:30:00.000Z");

  let failing = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis", instruction: "Fail deterministically.",
    name: "Failure monitor", nextOccurrenceAt: new Date(now.getTime() + 86_400_000).toISOString(), now,
    schedule: { anchor: new Date(now.getTime() + 86_400_000).toISOString(), everyMinutes: 30, kind: "interval" },
    scope: scopeA,
    sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/failure", origin: "https://example.gov", sourceId: "source.failure" }],
  }, monitorClient);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    failing = await recordWorkspaceMonitorFailure({
      errorCode: "provider_unavailable", expectedRevision: failing.configurationRevision,
      failureThreshold: 3, monitorId: failing.monitorId,
      now: new Date(now.getTime() + attempt + 1), scope: scopeA,
    }, monitorClient);
  }
  assert.equal(failing.lifecycleState, "paused_failure");
  assert.equal(failing.pauseReason, "auto_paused_after_repeated_failures");
  assert.equal(failing.nextOccurrenceAt, null);

  const raceMonitor = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis", instruction: "Race lifecycle controls.",
    name: "Lifecycle race", nextOccurrenceAt: new Date(now.getTime() + 86_400_000).toISOString(), now,
    schedule: { anchor: new Date(now.getTime() + 86_400_000).toISOString(), everyMinutes: 30, kind: "interval" },
    scope: scopeA,
    sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/race", origin: "https://example.gov", sourceId: "source.race" }],
  }, monitorClient);
  const lifecycleRace = await Promise.allSettled([
    updateWorkspaceMonitor({
      expectedRevision: 1, monitorId: raceMonitor.monitorId, now,
      patch: { lifecycleState: "paused", pauseReason: "owner_paused", pausedAt: now.toISOString() }, scope: scopeA,
    }, monitorClient),
    updateWorkspaceMonitor({
      expectedRevision: 1, monitorId: raceMonitor.monitorId, now,
      patch: { lifecycleState: "suspended_archived", pauseReason: "workspace_archived", pausedAt: now.toISOString() }, scope: scopeA,
    }, monitorClient),
  ]);
  assert.equal(lifecycleRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await getWorkspaceMonitor(scopeA, raceMonitor.monitorId, monitorClient))!.configurationRevision, 2);

  const uncertainMonitor = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis", instruction: "Pause on uncertain delivery.",
    name: "Uncertain alert", nextOccurrenceAt: new Date(now.getTime() + 86_400_000).toISOString(), now,
    schedule: { anchor: new Date(now.getTime() + 86_400_000).toISOString(), everyMinutes: 30, kind: "interval" },
    scope: scopeA,
    sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/uncertain", origin: "https://example.gov", sourceId: "source.uncertain" }],
  }, monitorClient);
  const checkpointBefore = uncertainMonitor.sourceCheckpoint;
  const uncertain = await pauseWorkspaceMonitorAfterUncertainAlert({
    expectedRevision: 1, monitorId: uncertainMonitor.monitorId, now, scope: scopeA,
  }, monitorClient);
  assert.equal(uncertain.pauseReason, "alert_delivery_checkpoint_uncertain");
  assert.deepEqual(uncertain.sourceCheckpoint, checkpointBefore);

  const expiring = await createWorkspaceMonitor({
    deliverySubscriptionId: "delivery.redis", endAt: new Date(now.getTime() + 1_000).toISOString(),
    instruction: "Expire before dispatch.", name: "Expiring monitor",
    nextOccurrenceAt: new Date(now.getTime() + 2_000).toISOString(), now,
    schedule: { at: new Date(now.getTime() + 2_000).toISOString(), kind: "one_time" },
    scope: scopeA,
    sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/expiry", origin: "https://example.gov", sourceId: "source.expiry" }],
  }, monitorClient);
  assert.equal((await claimDueWorkspaceMonitors({
    environment, leaseForMs: 1_000, limit: 10,
    now: new Date(now.getTime() + 2_000), recoveryWindowMs: 60_000,
  }, monitorClient)).some((job) => job.monitor.monitorId === expiring.monitorId), false);
  const expired = await getWorkspaceMonitor(scopeA, expiring.monitorId, monitorClient);
  assert.equal(expired?.lifecycleState, "paused");
  assert.equal(expired?.pauseReason, "end_time_reached");

  await writeWorkspaceDocument("budget", {
    expectedRevision: 0, now, scope: scopeA, value: policy,
  }, casClient);
  const budgetRace = await Promise.allSettled([
    reserveWorkspaceRunBudget({ inputTokens: 100, now, outputTokens: 50, policy, policyRevision: 1, runId: "redis_run_a", scope: scopeA }, casClient),
    reserveWorkspaceRunBudget({ inputTokens: 100, now, outputTokens: 50, policy, policyRevision: 1, runId: "redis_run_b", scope: scopeA }, casClient),
  ]);
  assert.equal(budgetRace.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readWorkspaceBudgetLedger(scopeA, casClient)).reservations.length, 1);

  const findingPrefix = "eve:test:workspace-finding-race:";
  const batchA = {
    identityClaims: [
      { key: `${findingPrefix}identity:shared`, value: "claim:shared:occurrence-a" },
      { key: `${findingPrefix}identity:a`, value: "claim:a" },
    ],
    outcomeKey: `${findingPrefix}outcome:a`,
    outcomeValue: "outcome:a",
  };
  const batchB = {
    identityClaims: [
      { key: `${findingPrefix}identity:shared`, value: "claim:shared:occurrence-b" },
      { key: `${findingPrefix}identity:b`, value: "claim:b" },
    ],
    outcomeKey: `${findingPrefix}outcome:b`,
    outcomeValue: "outcome:b",
  };
  const overlappingIdentityRace = await Promise.all([
    findingClient.createOutcomeWithIdentityClaims(batchA),
    findingClient.createOutcomeWithIdentityClaims(batchB),
  ]);
  assert.deepEqual(
    new Set(overlappingIdentityRace.map(({ status }) => status)),
    new Set(["created", "identity_conflict"]),
  );
  const winnerIndex = overlappingIdentityRace.findIndex(
    ({ status }) => status === "created",
  );
  assert.notEqual(winnerIndex, -1);
  const winner = winnerIndex === 0 ? batchA : batchB;
  const loser = winnerIndex === 0 ? batchB : batchA;
  assert.equal(await client.get(winner.outcomeKey), winner.outcomeValue);
  assert.equal(await client.get(loser.outcomeKey), null);
  assert.equal(
    await client.get(winner.identityClaims[0]!.key),
    winner.identityClaims[0]!.value,
  );
  assert.equal(
    await client.get(winner.identityClaims[1]!.key),
    winner.identityClaims[1]!.value,
  );
  assert.equal(await client.get(loser.identityClaims[1]!.key), null);
  assert.equal(
    (await findingClient.createOutcomeWithIdentityClaims(winner)).status,
    "existing",
  );

  const coverage = await createWorkspaceSourceCoverage({
    configurationRevision: 1, monitorId: monitor.monitorId, now, runId: "redis_coverage",
    scope: scopeA, sources: [{ canonicalUrl: "https://example.gov/feed", origin: "https://example.gov", sourceId: "source.redis" }],
    window: { endAt: now.toISOString(), startAt: new Date(now.getTime() - 60_000).toISOString() },
  }, casClient);
  const sourceRace = await Promise.allSettled([
    reserveWorkspaceSourceAttempt({ now, runId: coverage.runId, scope: scopeA, sourceId: "source.redis" }, casClient),
    reserveWorkspaceSourceAttempt({ now, runId: coverage.runId, scope: scopeA, sourceId: "source.redis" }, casClient),
  ]);
  assert.equal(sourceRace.filter((result) => result.status === "fulfilled").length, 1);
  await markWorkspaceSourceSuccess({ contentDigest: "a".repeat(64), now, runId: coverage.runId, scope: scopeA, sourceId: "source.redis" }, casClient);
  assert.equal((await completeWorkspaceSourceCoverage({ now, runId: coverage.runId, scope: scopeA }, casClient)).state, "complete");

  const legacyId = "323e4567-e89b-42d3-a456-426614174000";
  const legacyOwnerKey = "b".repeat(64);
  await client.set(`eve:event-trigger:v1:record:${legacyId}`, JSON.stringify({
    consecutiveFailures: 0, createdAtMs: now.getTime() - 60_000,
    destination: { adapterName: "imessage", kind: "photon", threadId: "imessage:redis" },
    enabled: true, everyMinutes: 60, expiresAtMs: now.getTime() + 86_400_000,
    id: legacyId, instruction: "Check source.", lastCompletedAtMs: now.getTime() - 60_000,
    lastErrorCode: null, lastRunAtMs: now.getTime() - 60_000, name: "Legacy Redis monitor",
    nextRunAtMs: now.getTime() + 60_000, ownerKey: legacyOwnerKey, revision: 2, runCount: 1,
    schemaVersion: 1, sourceIds: [], sourceUrls: ["https://example.gov/feed"],
    timezone: "UTC", updatedAtMs: now.getTime() - 60_000, userId: "imessage:redis",
  }));
  const migrations = await Promise.allSettled([
    assignLegacyMonitorToWorkspace({ deliverySubscriptionId: "delivery.redis", expectedLegacyRevision: 2, legacyOwnerKey, legacyTriggerId: legacyId, now, scope: scopeB }, assignmentClient),
    assignLegacyMonitorToWorkspace({ deliverySubscriptionId: "delivery.redis", expectedLegacyRevision: 2, legacyOwnerKey, legacyTriggerId: legacyId, now, scope: scopeB }, assignmentClient),
  ]);
  assert.equal(migrations.filter((result) => result.status === "fulfilled").length, 2);
  const migrationValues = migrations.flatMap((result) => result.status === "fulfilled" ? [result.value.assignment.monitorId] : []);
  assert.equal(new Set(migrationValues).size, 1);

  const simultaneousAt = new Date(now.getTime() + 3 * 86_400_000);
  const simultaneous = await Promise.all([
    createWorkspaceMonitor({
      deliverySubscriptionId: "delivery.redis", instruction: "Run concurrently in A.",
      name: "Concurrent A", nextOccurrenceAt: simultaneousAt.toISOString(), now,
      schedule: { at: simultaneousAt.toISOString(), kind: "one_time" }, scope: scopeA,
      sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/a", origin: "https://example.gov", sourceId: "source.a" }],
    }, monitorClient),
    createWorkspaceMonitor({
      deliverySubscriptionId: "delivery.redis", instruction: "Run concurrently in B.",
      name: "Concurrent B", nextOccurrenceAt: simultaneousAt.toISOString(), now,
      schedule: { at: simultaneousAt.toISOString(), kind: "one_time" }, scope: scopeB,
      sources: [{ accessClassification: "public", canonicalUrl: "https://example.gov/b", origin: "https://example.gov", sourceId: "source.b" }],
    }, monitorClient),
  ]);
  const concurrentClaims = await claimDueWorkspaceMonitors({
    environment, leaseForMs: 60_000, limit: 10, now: simultaneousAt,
    recoveryWindowMs: 60_000,
  }, monitorClient);
  assert.deepEqual(
    new Set(concurrentClaims
      .filter((job) => simultaneous.some((monitor) => monitor.monitorId === job.monitor.monitorId))
      .map((job) => job.monitor.workspaceId)),
    new Set([scopeA.workspaceId, scopeB.workspaceId]),
  );
  const duplicateClaims = await claimDueWorkspaceMonitors({
    environment, leaseForMs: 60_000, limit: 10, now: simultaneousAt,
    recoveryWindowMs: 60_000,
  }, monitorClient);
  assert.equal(
    duplicateClaims.some((job) => simultaneous.some((monitor) => monitor.monitorId === job.monitor.monitorId)),
    false,
  );

  console.info("Workspace Redis runtime verification passed.");
} finally {
  if (client.isOpen) await client.quit().catch(() => client.destroy());
  server?.kill("SIGTERM");
  await rm(directory, { force: true, recursive: true });
}
