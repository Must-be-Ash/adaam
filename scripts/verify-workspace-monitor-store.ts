import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  claimDueWorkspaceMonitors,
  claimWorkspaceMonitorOccurrence,
  completeWorkspaceMonitorCheckpoint,
  createPausedWorkspaceAcceptanceMonitor,
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  isWorkspaceMonitorCheckpointOnlyBaseline,
  listWorkspaceMonitors,
  pauseWorkspaceMonitorsAfterRestore,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  resolveWorkspaceStrategyManagedMonitors,
  suspendWorkspaceMonitorsForArchive,
  updateWorkspaceMonitor,
  validateWorkspaceMonitorValue,
  workspaceMonitorOccurrenceKey,
  WorkspaceMonitorError,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import type { WorkspaceStrategyBindingValue } from "../agent/lib/workspace-state-store";
import { authorizePhotonWorkspaceControlPlaneStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements WorkspaceMonitorStoreClient {
  calls = 0;
  readonly due = new Map<string, number>();
  readonly inflight = new Map<
    string,
    { expiresAt: number; leaseKey: string }
  >();
  readonly indexes = new Map<string, Set<string>>();
  readonly leases = new Map<string, string>();
  readonly occurrences = new Map<string, {
    attempt: number;
    configurationRevision: number;
    leaseTokenDigest: string;
    monitorId: string;
    occurrenceKey: string;
    status: string;
  }>();
  readonly values = new Map<string, string>();

  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    this.calls += 1;
    const raw = this.values.get(input.recordKey);
    const occurrence = this.occurrences.get(input.occurrenceRecordKey);
    if (!raw) return "missing" as const;
    if (
      occurrence === undefined ||
      JSON.parse(raw).configurationRevision !== input.configurationRevision ||
      occurrence.leaseTokenDigest !== input.leaseTokenDigest
    ) return "stale" as const;
    if (occurrence.status === "completed") return "already_completed" as const;
    if (!this.leases.has(input.leaseKey)) return "lease_mismatch" as const;
    if (raw !== input.expectedRaw || occurrence.status !== "leased") {
      return "stale" as const;
    }
    this.values.set(input.recordKey, input.nextRaw);
    this.occurrences.set(input.occurrenceRecordKey, { ...occurrence, status: "completed" });
    this.leases.delete(input.leaseKey);
    this.inflight.delete(input.recordKey);
    if (input.nextDueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.nextDueAtMs);
    return "completed" as const;
  }

  async claim(input: Parameters<WorkspaceMonitorStoreClient["claim"]>[0]) {
    this.calls += 1;
    const raw = this.values.get(input.recordKey);
    if (!raw) return { status: "missing" as const };
    const record = JSON.parse(raw);
    if (record.configurationRevision !== input.configurationRevision) {
      return { status: "stale" as const };
    }
    if (
      record.lifecycleState !== "enabled" ||
      !record.nextOccurrenceAt ||
      new Date(record.nextOccurrenceAt).getTime() > input.nowMs
    ) {
      return { status: "not_due" as const };
    }
    if (this.leases.has(input.leaseKey)) return { status: "leased" as const };
    const existing = this.occurrences.get(input.occurrenceRecordKey);
    if (existing && existing.status !== "leased") {
      return { status: "duplicate" as const };
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    this.leases.set(input.leaseKey, input.leaseToken);
    this.inflight.set(input.recordKey, {
      expiresAt: input.leaseExpiresAtMs,
      leaseKey: input.leaseKey,
    });
    this.occurrences.set(input.occurrenceRecordKey, {
      attempt,
      configurationRevision: input.configurationRevision,
      leaseTokenDigest: input.leaseTokenDigest,
      monitorId: input.monitorId,
      occurrenceKey: input.occurrenceKey,
      status: "leased",
    });
    this.due.delete(input.recordKey);
    return { attempt, status: "claimed" as const };
  }

  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    this.calls += 1;
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    const index = this.indexes.get(input.workspaceIndexKey) ?? new Set<string>();
    index.add(input.recordKey);
    this.indexes.set(input.workspaceIndexKey, index);
    if (input.dueAtMs !== null) this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async get(key: string) {
    this.calls += 1;
    if (this.leases.has(key)) return this.leases.get(key) ?? null;
    if (this.occurrences.has(key)) {
      return JSON.stringify(this.occurrences.get(key));
    }
    return this.values.get(key) ?? null;
  }

  async list(indexKey: string) {
    this.calls += 1;
    return [...(this.indexes.get(indexKey) ?? [])].map(
      (key) => this.values.get(key) ?? null,
    );
  }

  async listDue(
    input: Parameters<WorkspaceMonitorStoreClient["listDue"]>[0],
  ) {
    this.calls += 1;
    for (const [recordKey, lease] of this.inflight) {
      if (lease.expiresAt <= input.nowMs) {
        this.inflight.delete(recordKey);
        this.leases.delete(lease.leaseKey);
        this.due.set(recordKey, input.nowMs);
      }
    }
    return [...this.due]
      .filter(([, dueAt]) => dueAt <= input.nowMs)
      .slice(0, input.limit)
      .map(([recordKey]) => ({
        raw: this.values.get(recordKey) ?? null,
        recordKey,
      }));
  }

  async releaseLease(
    input: Parameters<WorkspaceMonitorStoreClient["releaseLease"]>[0],
  ) {
    this.calls += 1;
    if (this.leases.get(input.leaseKey) !== input.leaseToken) return false;
    this.leases.delete(input.leaseKey);
    this.inflight.delete(input.recordKey);
    if (input.dueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    this.calls += 1;
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    if (input.dueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};
const scope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const otherScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const client = new MemoryStore();
const now = new Date("2026-08-14T12:00:00.000Z");
const scheduledFor = "2026-08-14T12:05:00.000Z";
const source = (index: number) => ({
  accessClassification: "public" as const,
  canonicalUrl: `https://example.gov/feed/${index}`,
  origin: "https://example.gov",
  sourceId: `source.${index}`,
});

const monitor = await createWorkspaceMonitor(
  {
    deliverySubscriptionId: "delivery.fixture",
    instruction: "Check every configured source for a new matching filing.",
    name: "Fixture monitor",
    nextOccurrenceAt: scheduledFor,
    now,
    requiredCapabilityIds: ["sec.get_filing"],
    schedule: {
      anchor: scheduledFor,
      everyMinutes: 30,
      kind: "interval",
    },
    scope,
    sources: Array.from({ length: 8 }, (_, index) => source(index)),
  },
  client,
);
assert.equal(monitor.schemaVersion, 1);
assert.equal(monitor.configurationRevision, 1);
assert.equal(monitor.workspaceBindingImmutable, true);
assert.equal(monitor.managedBy, null);
const legacyMonitorValue = { ...monitor } as Partial<typeof monitor>;
delete legacyMonitorValue.managedBy;
assert.equal(validateWorkspaceMonitorValue(legacyMonitorValue, scope).managedBy, null);
assert.equal(monitor.sources.length, 8);
assert.equal(client.due.size, 1);
assert.deepEqual(await getWorkspaceMonitor(scope, monitor.monitorId, client), monitor);
assert.deepEqual(await listWorkspaceMonitors(scope, client), [monitor]);
assert.deepEqual(await listWorkspaceMonitors(otherScope, client), []);

const managedClient = new MemoryStore();
const packDigest = "d".repeat(64);
const managedMonitor = await createWorkspaceMonitor(
  {
    deliverySubscriptionId: "delivery.managed",
    idempotencyKey: "strategy-pack:fixture:fixture-monitor",
    instruction: "Remain paused until the owner explicitly enables this schedule.",
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: packDigest,
      packId: "fixture-strategy",
      packVersion: "1.0.0",
      resourceId: "fixture-monitor",
    },
    name: "Pack-managed fixture monitor",
    nextOccurrenceAt: scheduledFor,
    now,
    schedule: { at: scheduledFor, kind: "one_time" },
    scope,
    sources: [source(0)],
  },
  managedClient,
);
assert.equal(managedMonitor.lifecycleState, "paused");
assert.equal(managedMonitor.pauseReason, "strategy_pack_install_only");
assert.equal(managedMonitor.nextOccurrenceAt, scheduledFor);
assert.equal(managedClient.due.size, 0);
const inverseClient = new MemoryStore();
const inverseMonitor = await createWorkspaceMonitor({
  deliverySubscriptionId: "delivery.inverse-cramer",
  instruction: "Establish a checkpoint-only public-commentary baseline before findings.",
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: packDigest,
    packId: "inverse-cramer",
    packVersion: "1.3.0",
    resourceId: "monitor-inverse-cramer-commentary",
  },
  name: "Inverse Cramer",
  nextOccurrenceAt: scheduledFor,
  now,
  schedule: { anchor: scheduledFor, everyMinutes: 10, kind: "interval" },
  scope,
  sources: [source(0)],
}, inverseClient);
assert.equal(inverseMonitor.activationWatermark, undefined);
const inverseActivatedAt = new Date("2026-08-14T12:01:00.000Z");
const activeInverseMonitor = await updateWorkspaceMonitor({
  expectedRevision: inverseMonitor.configurationRevision,
  monitorId: inverseMonitor.monitorId,
  now: inverseActivatedAt,
  patch: {
    lifecycleState: "enabled",
    nextOccurrenceAt: inverseActivatedAt.toISOString(),
    pauseReason: null,
    pausedAt: null,
  },
  scope,
}, inverseClient);
assert.equal(activeInverseMonitor.activationWatermark, inverseActivatedAt.toISOString());
assert.equal(isWorkspaceMonitorCheckpointOnlyBaseline(activeInverseMonitor), true);
const inverseImmediateClaims = await claimDueWorkspaceMonitors(
  {
    environment,
    leaseForMs: 60_000,
    limit: 10,
    now: new Date("2026-08-14T12:04:00.000Z"),
    recoveryWindowMs: 6 * 60 * 60_000,
  },
  inverseClient,
);
assert.equal(inverseImmediateClaims.length, 1);
assert.equal(
  inverseImmediateClaims[0]?.occurrence.occurrenceIdentity,
  `interval:${inverseActivatedAt.toISOString()}`,
);
assert.equal(
  (
    await claimDueWorkspaceMonitors(
      {
        environment,
        leaseForMs: 60_000,
        limit: 10,
        now: new Date("2026-08-14T12:04:00.000Z"),
        recoveryWindowMs: 6 * 60 * 60_000,
      },
      inverseClient,
    )
  ).length,
  0,
);

const staleInverseClient = new MemoryStore();
const staleInverseMonitor = await createWorkspaceMonitor({
  deliverySubscriptionId: "delivery.inverse-cramer.stale",
  instruction: "Skip a stale immediate occurrence outside the recovery window.",
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: packDigest,
    packId: "inverse-cramer",
    packVersion: "1.3.0",
    resourceId: "monitor-inverse-cramer-commentary",
  },
  name: "Stale inverse Cramer",
  nextOccurrenceAt: scheduledFor,
  now,
  schedule: { anchor: scheduledFor, everyMinutes: 720, kind: "interval" },
  scope,
  sources: [source(0)],
}, staleInverseClient);
const staleInverseActivatedAt = new Date("2026-08-14T12:01:00.000Z");
await updateWorkspaceMonitor({
  expectedRevision: staleInverseMonitor.configurationRevision,
  monitorId: staleInverseMonitor.monitorId,
  now: staleInverseActivatedAt,
  patch: {
    lifecycleState: "enabled",
    nextOccurrenceAt: staleInverseActivatedAt.toISOString(),
    pauseReason: null,
    pausedAt: null,
  },
  scope,
}, staleInverseClient);
assert.equal(
  (
    await claimDueWorkspaceMonitors(
      {
        environment,
        leaseForMs: 60_000,
        limit: 10,
        now: new Date("2026-08-14T19:01:01.000Z"),
        recoveryWindowMs: 6 * 60 * 60_000,
      },
      staleInverseClient,
    )
  ).length,
  0,
);
assert.equal(
  (await getWorkspaceMonitor(scope, staleInverseMonitor.monitorId, staleInverseClient))
    ?.lastErrorCode,
  "missed_occurrences_skipped",
);
const binding = {
  bindingRevision: 1,
  configuration: { dailyTimes: ["12:05"], timezone: "UTC" },
  effectiveCapabilityManifestRevision: 1,
  health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
  lastActiveSnapshot: {
    bindingRevision: 1,
    capabilityManifestRevision: 1,
    packContentDigest: packDigest,
    packId: "fixture-strategy",
    packVersion: "1.0.0",
    workspaceGeneration: 1,
  },
  lifecycleState: "active",
  managedResources: {
    "fixture-monitor": {
      monitorId: managedMonitor.monitorId,
      sourceIds: ["source.0"],
    },
  },
  ownerOverrides: {},
  pack: {
    contentDigest: packDigest,
    id: "fixture-strategy",
    version: "1.0.0",
  },
  pendingSnapshot: null,
  timestamps: {
    activatedAt: now.toISOString(),
    configuredAt: null,
    generationRolloverAt: now.toISOString(),
    installedAt: now.toISOString(),
  },
} satisfies WorkspaceStrategyBindingValue;
assert.deepEqual(
  resolveWorkspaceStrategyManagedMonitors(binding, [monitor, managedMonitor]),
  [managedMonitor],
);
assert.throws(
  () => resolveWorkspaceStrategyManagedMonitors(binding, [
    monitor,
    { ...managedMonitor, managedBy: { ...managedMonitor.managedBy!, resourceId: "wrong-resource" } },
  ]),
  (error) => error instanceof WorkspaceMonitorError && error.code === "monitor_invalid",
);
await assert.rejects(
  updateWorkspaceMonitor(
    {
      expectedRevision: managedMonitor.configurationRevision,
      monitorId: managedMonitor.monitorId,
      now,
      patch: { managedBy: null } as never,
      scope,
    },
    managedClient,
  ),
  (error) => error instanceof WorkspaceMonitorError && error.code === "monitor_invalid",
);

const idempotentInput = {
  deliverySubscriptionId: "delivery.idempotent",
  idempotencyKey: "call_fixture_123",
  instruction: "Create this monitor once across durable Eve retries.",
  name: "Idempotent monitor",
  nextOccurrenceAt: scheduledFor,
  now,
  schedule: { at: scheduledFor, kind: "one_time" as const },
  scope,
  sources: [source(0)],
};
const idempotencyClient = new MemoryStore();
const idempotentMonitor = await createWorkspaceMonitor(idempotentInput, idempotencyClient);
const replayedMonitor = await createWorkspaceMonitor(
  { ...idempotentInput, now: new Date(now.getTime() + 1_000) },
  idempotencyClient,
);
assert.deepEqual(replayedMonitor, idempotentMonitor);
assert.equal((await listWorkspaceMonitors(scope, idempotencyClient)).length, 1);

await assert.rejects(
  updateWorkspaceMonitor(
    {
      expectedRevision: monitor.configurationRevision,
      monitorId: monitor.monitorId,
      now,
      patch: { sources: Array.from({ length: 9 }, (_, index) => source(index)) },
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError &&
    error.code === "monitor_source_limit_exceeded",
);

await assert.rejects(
  createWorkspaceMonitor(
    {
      deliverySubscriptionId: "delivery.too-many",
      instruction: "Invalid ninth source.",
      name: "Too many sources",
      nextOccurrenceAt: scheduledFor,
      now,
      schedule: { at: scheduledFor, kind: "one_time" },
      scope,
      sources: Array.from({ length: 9 }, (_, index) => source(index)),
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError &&
    error.code === "monitor_source_limit_exceeded",
);

await assert.rejects(
  createWorkspaceMonitor(
    {
      deliverySubscriptionId: "delivery.fragment",
      instruction: "Reject a source whose fragment changes its exact fence.",
      name: "Fragment source",
      nextOccurrenceAt: scheduledFor,
      now,
      schedule: { at: scheduledFor, kind: "one_time" },
      scope,
      sources: [{ ...source(0), canonicalUrl: `${source(0).canonicalUrl}#fragment` }],
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError && error.code === "monitor_invalid",
);

const occurrenceIdentity = "2026-08-14T12:05:00.000Z";
const occurrenceKey = workspaceMonitorOccurrenceKey({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  occurrenceIdentity,
  scope,
});
assert.equal(
  occurrenceKey,
  workspaceMonitorOccurrenceKey({
    configurationRevision: monitor.configurationRevision,
    monitorId: monitor.monitorId,
    occurrenceIdentity,
    scope,
  }),
);
assert.notEqual(
  occurrenceKey,
  workspaceMonitorOccurrenceKey({
    configurationRevision: monitor.configurationRevision,
    monitorId: monitor.monitorId,
    occurrenceIdentity,
    scope: otherScope,
  }),
);

const firstClaim = await claimWorkspaceMonitorOccurrence(
  {
    configurationRevision: monitor.configurationRevision,
    leaseForMs: 60_000,
    monitorId: monitor.monitorId,
    now: new Date(scheduledFor),
    occurrenceIdentity,
    scheduledFor,
    scope,
  },
  client,
);
assert.equal(firstClaim.occurrence.attempt, 1);
assert.match(firstClaim.leaseToken, /^[A-Za-z0-9_-]{43}$/u);
await assert.rejects(
  claimWorkspaceMonitorOccurrence(
    {
      configurationRevision: monitor.configurationRevision,
      leaseForMs: 60_000,
      monitorId: monitor.monitorId,
      now: new Date(scheduledFor),
      occurrenceIdentity,
      scheduledFor,
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError &&
    error.code === "monitor_occurrence_leased",
);
assert.equal(
  await releaseWorkspaceMonitorLease(
    { leaseToken: "wrong", monitorId: monitor.monitorId, scope },
    client,
  ),
  false,
);
assert.equal(
  await releaseWorkspaceMonitorLease(
    { leaseToken: firstClaim.leaseToken, monitorId: monitor.monitorId, scope },
    client,
  ),
  true,
);
const recovered = await claimWorkspaceMonitorOccurrence(
  {
    configurationRevision: monitor.configurationRevision,
    leaseForMs: 60_000,
    monitorId: monitor.monitorId,
    now: new Date(scheduledFor),
    occurrenceIdentity,
    scheduledFor,
    scope,
  },
  client,
);
assert.equal(recovered.occurrence.occurrenceKey, occurrenceKey);
assert.equal(recovered.occurrence.attempt, 2);

const failedOccurrenceClient = new MemoryStore();
const failedOccurrenceMonitor = await createWorkspaceMonitor({
  deliverySubscriptionId: "delivery.failed-occurrence",
  instruction: "Preserve one occurrence identity across failure recovery.",
  name: "Failed occurrence fixture",
  nextOccurrenceAt: scheduledFor,
  now,
  schedule: { at: scheduledFor, kind: "one_time" },
  scope,
  sources: [source(0)],
}, failedOccurrenceClient);
const failedOccurrenceFirstClaim = await claimWorkspaceMonitorOccurrence({
  configurationRevision: failedOccurrenceMonitor.configurationRevision,
  leaseForMs: 60_000,
  monitorId: failedOccurrenceMonitor.monitorId,
  now: new Date(scheduledFor),
  occurrenceIdentity: scheduledFor,
  scheduledFor,
  scope,
}, failedOccurrenceClient);
const failedOccurrence = await recordWorkspaceMonitorFailure({
  errorCode: "model_output_invalid",
  expectedRevision: failedOccurrenceMonitor.configurationRevision,
  failureThreshold: 3,
  monitorId: failedOccurrenceMonitor.monitorId,
  now: new Date("2026-08-14T12:05:30.000Z"),
  scope,
}, failedOccurrenceClient);
assert.equal(
  failedOccurrence.configurationRevision,
  failedOccurrenceMonitor.configurationRevision,
  "an operational failure must not mint a new occurrence identity",
);
assert.equal(failedOccurrence.consecutiveFailures, 1);
assert.equal(failedOccurrence.lastErrorCode, "model_output_invalid");
assert.equal(await releaseWorkspaceMonitorLease({
  leaseToken: failedOccurrenceFirstClaim.leaseToken,
  monitorId: failedOccurrenceMonitor.monitorId,
  scope,
}, failedOccurrenceClient), true);
const failedOccurrenceRecovery = await claimWorkspaceMonitorOccurrence({
  configurationRevision: failedOccurrence.configurationRevision,
  leaseForMs: 60_000,
  monitorId: failedOccurrence.monitorId,
  now: new Date("2026-08-14T12:05:31.000Z"),
  occurrenceIdentity: scheduledFor,
  scheduledFor,
  scope,
}, failedOccurrenceClient);
assert.equal(
  failedOccurrenceRecovery.occurrence.occurrenceKey,
  failedOccurrenceFirstClaim.occurrence.occurrenceKey,
);
assert.equal(failedOccurrenceRecovery.occurrence.attempt, 2);
const failedOccurrencePaused = await recordWorkspaceMonitorFailure({
  errorCode: "worker_recovery_outcome_missing",
  expectedRevision: failedOccurrence.configurationRevision,
  failureThreshold: 2,
  monitorId: failedOccurrence.monitorId,
  now: new Date("2026-08-14T12:05:32.000Z"),
  scope,
}, failedOccurrenceClient);
assert.equal(failedOccurrencePaused.lifecycleState, "paused_failure");
assert.equal(
  failedOccurrencePaused.configurationRevision,
  failedOccurrence.configurationRevision + 1,
  "a terminal lifecycle change must still mint a new configuration revision",
);
assert.equal(failedOccurrencePaused.nextOccurrenceAt, null);
const completed = await completeWorkspaceMonitorCheckpoint(
  {
    completedAt: new Date("2026-08-14T12:06:00.000Z"),
    configurationRevision: monitor.configurationRevision,
    contentDigest: "a".repeat(64),
    leaseTokenDigest: recovered.occurrence.leaseTokenDigest,
    monitorId: monitor.monitorId,
    occurrenceKey: recovered.occurrence.occurrenceKey,
    scheduledFor,
    scope,
    watermark: scheduledFor,
  },
  client,
);
assert.deepEqual(completed.sourceCheckpoint, {
  contentDigest: "a".repeat(64),
  watermark: scheduledFor,
});
assert.equal(completed.nextOccurrenceAt, "2026-08-14T12:35:00.000Z");
assert.deepEqual(
  await completeWorkspaceMonitorCheckpoint({
    completedAt: new Date("2026-08-14T12:07:00.000Z"),
    configurationRevision: monitor.configurationRevision,
    contentDigest: "a".repeat(64),
    leaseTokenDigest: recovered.occurrence.leaseTokenDigest,
    monitorId: monitor.monitorId,
    occurrenceKey: recovered.occurrence.occurrenceKey,
    scheduledFor,
    scope,
    watermark: scheduledFor,
  }, client),
  completed,
);

const unchangedOccurrenceIdentity = "2026-08-14T12:35:00.000Z";
const unchanged = await claimWorkspaceMonitorOccurrence(
  {
    configurationRevision: completed.configurationRevision,
    leaseForMs: 60_000,
    monitorId: completed.monitorId,
    now: new Date(unchangedOccurrenceIdentity),
    occurrenceIdentity: unchangedOccurrenceIdentity,
    scheduledFor: unchangedOccurrenceIdentity,
    scope,
  },
  client,
);
const unchangedCompleted = await completeWorkspaceMonitorCheckpoint({
  completedAt: new Date("2026-08-14T12:36:00.000Z"),
  configurationRevision: completed.configurationRevision,
  contentDigest: completed.sourceCheckpoint.contentDigest!,
  leaseTokenDigest: unchanged.occurrence.leaseTokenDigest,
  monitorId: completed.monitorId,
  occurrenceKey: unchanged.occurrence.occurrenceKey,
  scheduledFor: unchangedOccurrenceIdentity,
  scope,
  watermark: completed.sourceCheckpoint.watermark!,
}, client);
assert.equal(unchangedCompleted.nextOccurrenceAt, "2026-08-14T13:05:00.000Z");
assert.equal(client.leases.size, 0);
assert.equal(client.inflight.size, 0);
assert.equal(
  client.occurrences.get(
    [...client.occurrences.keys()].find((key) =>
      key.endsWith(unchanged.occurrence.occurrenceKey)
    )!,
  )?.status,
  "completed",
);
assert.deepEqual(
  await completeWorkspaceMonitorCheckpoint({
    completedAt: new Date("2026-08-14T12:37:00.000Z"),
    configurationRevision: completed.configurationRevision,
    contentDigest: completed.sourceCheckpoint.contentDigest!,
    leaseTokenDigest: unchanged.occurrence.leaseTokenDigest,
    monitorId: completed.monitorId,
    occurrenceKey: unchanged.occurrence.occurrenceKey,
    scheduledFor: unchangedOccurrenceIdentity,
    scope,
    watermark: completed.sourceCheckpoint.watermark!,
  }, client),
  unchangedCompleted,
);
assert.equal(
  await inspectWorkspaceMonitorOccurrenceLease({
    configurationRevision: unchanged.occurrence.configurationRevision,
    leaseToken: unchanged.leaseToken,
    leaseTokenDigest: unchanged.occurrence.leaseTokenDigest,
    monitorId: completed.monitorId,
    occurrenceKey: unchanged.occurrence.occurrenceKey,
    scope,
  }, client),
  "completed",
);

const paused = await updateWorkspaceMonitor(
  {
    expectedRevision: monitor.configurationRevision,
    monitorId: monitor.monitorId,
    now: new Date("2026-08-14T12:06:00.000Z"),
    patch: {
      lifecycleState: "paused",
      nextOccurrenceAt: null,
      pauseReason: "owner_paused",
      pausedAt: "2026-08-14T12:06:00.000Z",
    },
    scope,
  },
  client,
);
assert.equal(paused.configurationRevision, 2);
assert.equal(paused.pauseReason, "owner_paused");
assert.equal(client.due.size, 0);
await assert.rejects(
  updateWorkspaceMonitor(
    {
      expectedRevision: 1,
      monitorId: monitor.monitorId,
      patch: { name: "Stale update" },
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError && error.code === "monitor_conflict",
);
await assert.rejects(
  claimWorkspaceMonitorOccurrence(
    {
      configurationRevision: 1,
      leaseForMs: 60_000,
      monitorId: monitor.monitorId,
      now: new Date(scheduledFor),
      occurrenceIdentity: "stale-revision",
      scheduledFor,
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError &&
    error.code === "monitor_occurrence_stale",
);

const retired = await updateWorkspaceMonitor(
  {
    expectedRevision: paused.configurationRevision,
    monitorId: monitor.monitorId,
    patch: {
      lifecycleState: "retired",
      nextOccurrenceAt: null,
      pauseReason: "owner_retired",
      pausedAt: "2026-08-14T12:07:00.000Z",
    },
    scope,
  },
  client,
);
assert.equal(retired.lifecycleState, "retired");
assert.equal((await listWorkspaceMonitors(scope, client)).length, 1);
await assert.rejects(
  updateWorkspaceMonitor(
    {
      expectedRevision: retired.configurationRevision,
      monitorId: monitor.monitorId,
      patch: {
        lifecycleState: "enabled",
        pauseReason: null,
        pausedAt: null,
      },
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceMonitorError && error.code === "monitor_invalid",
);

const callsBeforeForgery = client.calls;
await assert.rejects(
  listWorkspaceMonitors(
    { ownerId: scope.ownerId, workspaceId: scope.workspaceId },
    client,
  ),
  /authoritative owner and workspace scope/u,
);
assert.equal(client.calls, callsBeforeForgery);

const dispatcherClient = new MemoryStore();
const dispatcherMonitor = await createWorkspaceMonitor(
  {
    deliverySubscriptionId: "delivery.dispatcher",
    instruction: "Claim this occurrence through the minute dispatcher.",
    name: "Dispatcher fixture",
    nextOccurrenceAt: scheduledFor,
    now,
    schedule: { at: scheduledFor, kind: "one_time" },
    scope,
    sources: [source(0)],
  },
  dispatcherClient,
);
const dispatchClaims = await claimDueWorkspaceMonitors(
  {
    environment,
    leaseForMs: 60_000,
    limit: 10,
    now: new Date(scheduledFor),
    recoveryWindowMs: 60 * 60_000,
  },
  dispatcherClient,
);
assert.equal(dispatchClaims.length, 1);
assert.equal(
  dispatchClaims[0]?.leaseExpiresAt,
  new Date(new Date(scheduledFor).getTime() + 60_000).toISOString(),
);
assert.equal(dispatchClaims[0]?.monitor.monitorId, dispatcherMonitor.monitorId);
assert.equal(dispatchClaims[0]?.occurrence.attempt, 1);
assert.equal(
  (
    await claimDueWorkspaceMonitors(
      {
        environment,
        leaseForMs: 60_000,
        limit: 10,
        now: new Date(scheduledFor),
        recoveryWindowMs: 60 * 60_000,
      },
      dispatcherClient,
    )
  ).length,
  0,
);
const recoveredDispatchClaims = await claimDueWorkspaceMonitors(
  {
    environment,
    leaseForMs: 60_000,
    limit: 10,
    now: new Date(new Date(scheduledFor).getTime() + 60_001),
    recoveryWindowMs: 60 * 60_000,
  },
  dispatcherClient,
);
assert.equal(recoveredDispatchClaims.length, 1);
assert.equal(recoveredDispatchClaims[0]?.occurrence.attempt, 2);
assert.equal(
  recoveredDispatchClaims[0]?.occurrence.occurrenceKey,
  dispatchClaims[0]?.occurrence.occurrenceKey,
);
assert.equal(
  await inspectWorkspaceMonitorOccurrenceLease({
    configurationRevision: recoveredDispatchClaims[0]!.occurrence.configurationRevision,
    leaseToken: recoveredDispatchClaims[0]!.leaseToken,
    leaseTokenDigest: recoveredDispatchClaims[0]!.occurrence.leaseTokenDigest,
    monitorId: recoveredDispatchClaims[0]!.monitor.monitorId,
    occurrenceKey: recoveredDispatchClaims[0]!.occurrence.occurrenceKey,
    scope,
  }, dispatcherClient),
  "current",
);
assert.equal(
  await inspectWorkspaceMonitorOccurrenceLease({
    configurationRevision: recoveredDispatchClaims[0]!.occurrence.configurationRevision,
    leaseToken: "stale-lease-token",
    leaseTokenDigest: recoveredDispatchClaims[0]!.occurrence.leaseTokenDigest,
    monitorId: recoveredDispatchClaims[0]!.monitor.monitorId,
    occurrenceKey: recoveredDispatchClaims[0]!.occurrence.occurrenceKey,
    scope,
  }, dispatcherClient),
  "stale",
);

const missedClient = new MemoryStore();
const missedMonitor = await createWorkspaceMonitor(
  {
    deliverySubscriptionId: "delivery.missed",
    instruction: "Do not replay outside the recovery window.",
    name: "Missed fixture",
    nextOccurrenceAt: scheduledFor,
    now,
    schedule: { at: scheduledFor, kind: "one_time" },
    scope,
    sources: [source(0)],
  },
  missedClient,
);
assert.equal(
  (
    await claimDueWorkspaceMonitors(
      {
        environment,
        leaseForMs: 60_000,
        limit: 10,
        now: new Date(new Date(scheduledFor).getTime() + 2 * 60 * 60_000),
        recoveryWindowMs: 30 * 60_000,
      },
      missedClient,
    )
  ).length,
  0,
);
const skippedMonitor = await getWorkspaceMonitor(
  scope,
  missedMonitor.monitorId,
  missedClient,
);
assert.equal(skippedMonitor?.lifecycleState, "paused");
assert.equal(skippedMonitor?.pauseReason, "missed_recovery_window");
assert.equal(skippedMonitor?.lastErrorCode, "missed_occurrences_skipped");
const suspended = await suspendWorkspaceMonitorsForArchive({
  now: new Date("2026-08-14T15:00:00.000Z"),
  scope,
}, missedClient);
assert.equal(suspended[0]?.lifecycleState, "suspended_archived");
assert.equal(suspended[0]?.nextOccurrenceAt, null);
const restored = await pauseWorkspaceMonitorsAfterRestore({
  now: new Date("2026-08-14T16:00:00.000Z"),
  scope,
}, missedClient);
assert.equal(restored[0]?.lifecycleState, "paused");
assert.equal(restored[0]?.pauseReason, "workspace_restored_manual_resume_required");
assert.equal(restored[0]?.nextOccurrenceAt, null);

const acceptanceClient = new MemoryStore();
const acceptanceCheckpoint = {
  contentDigest: "a".repeat(64),
  watermark: "2026-08-14T17:00:00.000Z",
};
const acceptanceMonitor = await createPausedWorkspaceAcceptanceMonitor({
  deliverySubscriptionId: "delivery.acceptance",
  idempotencyKey: "acceptance.replay.fixture",
  instruction: "Evaluate the selected public SEC replay once enabled.",
  name: "Acceptance replay",
  nextOccurrenceAt: "2026-08-14T18:00:00.000Z",
  now,
  requiredCapabilityIds: ["evaluate_sec_ipo_source"],
  schedule: { at: "2026-08-14T18:00:00.000Z", kind: "one_time" },
  scope,
  sourceCheckpoint: acceptanceCheckpoint,
  sources: [source(0)],
}, acceptanceClient);
assert.equal(acceptanceMonitor.lifecycleState, "paused");
assert.equal(acceptanceMonitor.pauseReason, "acceptance_replay_initialized");
assert.deepEqual(acceptanceMonitor.sourceCheckpoint, acceptanceCheckpoint);
assert.equal(acceptanceClient.due.size, 0);
assert.deepEqual(await createPausedWorkspaceAcceptanceMonitor({
  deliverySubscriptionId: "delivery.acceptance",
  idempotencyKey: "acceptance.replay.fixture",
  instruction: "Evaluate the selected public SEC replay once enabled.",
  name: "Acceptance replay",
  nextOccurrenceAt: "2026-08-14T18:00:00.000Z",
  now: new Date(now.getTime() + 1_000),
  requiredCapabilityIds: ["evaluate_sec_ipo_source"],
  schedule: { at: "2026-08-14T18:00:00.000Z", kind: "one_time" },
  scope,
  sourceCheckpoint: acceptanceCheckpoint,
  sources: [source(0)],
}, acceptanceClient), acceptanceMonitor);

const minuteSchedule = await readFile(
  new URL("../agent/schedules/event-triggers.ts", import.meta.url),
  "utf8",
);
assert.equal((minuteSchedule.match(/defineSchedule\(/gu) ?? []).length, 1);
assert.match(minuteSchedule, /cron: "\* \* \* \* \*"/u);
const flagCheck = minuteSchedule.indexOf("flags.dispatch");
const workspaceClaim = minuteSchedule.indexOf(
  "dependencies.claimWorkspaceMonitors({",
);
assert.ok(flagCheck >= 0 && flagCheck < workspaceClaim);

console.log("Workspace monitor store verification passed.");
