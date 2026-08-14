import assert from "node:assert/strict";

import {
  claimWorkspaceMonitorOccurrence,
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  listWorkspaceMonitors,
  releaseWorkspaceMonitorLease,
  updateWorkspaceMonitor,
  workspaceMonitorOccurrenceKey,
  WorkspaceMonitorError,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import { authorizePhotonWorkspaceControlPlaneStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements WorkspaceMonitorStoreClient {
  calls = 0;
  readonly due = new Map<string, number>();
  readonly indexes = new Map<string, Set<string>>();
  readonly leases = new Map<string, string>();
  readonly occurrences = new Map<string, { attempt: number; status: string }>();
  readonly values = new Map<string, string>();

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
    this.occurrences.set(input.occurrenceRecordKey, {
      attempt,
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
    return this.values.get(key) ?? null;
  }

  async list(indexKey: string) {
    this.calls += 1;
    return [...(this.indexes.get(indexKey) ?? [])].map(
      (key) => this.values.get(key) ?? null,
    );
  }

  async releaseLease(
    input: Parameters<WorkspaceMonitorStoreClient["releaseLease"]>[0],
  ) {
    this.calls += 1;
    if (this.leases.get(input.leaseKey) !== input.leaseToken) return false;
    this.leases.delete(input.leaseKey);
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
assert.equal(monitor.sources.length, 8);
assert.equal(client.due.size, 1);
assert.deepEqual(await getWorkspaceMonitor(scope, monitor.monitorId, client), monitor);
assert.deepEqual(await listWorkspaceMonitors(scope, client), [monitor]);
assert.deepEqual(await listWorkspaceMonitors(otherScope, client), []);

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
await releaseWorkspaceMonitorLease(
  { leaseToken: recovered.leaseToken, monitorId: monitor.monitorId, scope },
  client,
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

console.log("Workspace monitor store verification passed.");
