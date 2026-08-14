import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assignLegacyMonitorToWorkspace,
  readWorkspaceLegacyMonitorAssignment,
  WorkspaceLegacyMonitorAssignmentError,
  type WorkspaceLegacyMonitorAssignmentClient,
} from "../agent/lib/workspace-legacy-monitor-assignment";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements WorkspaceLegacyMonitorAssignmentClient {
  readonly active = new Set<string>();
  readonly due = new Map<string, number>();
  readonly indexes = new Map<string, Set<string>>();
  readonly values = new Map<string, string>();

  async assign(input: Parameters<WorkspaceLegacyMonitorAssignmentClient["assign"]>[0]) {
    const existing = this.values.get(input.assignmentKey);
    if (existing) return existing;
    if (this.values.get(input.legacyRecordKey) !== input.legacyRaw) return "__conflict__";
    if (this.active.has(input.legacyLeaseKey) || this.active.has(input.activeRunKey)) {
      return "__busy__";
    }
    if (this.values.has(input.monitorRecordKey)) return "__conflict__";
    this.values.set(input.legacyRecordKey, input.legacyNextRaw);
    this.due.delete(input.legacyId);
    this.values.set(input.monitorRecordKey, input.monitorRaw);
    const index = this.indexes.get(input.monitorIndexKey) ?? new Set<string>();
    index.add(input.monitorRecordKey);
    this.indexes.set(input.monitorIndexKey, index);
    if (input.monitorDueAtMs !== null) {
      this.due.set(input.monitorRecordKey, input.monitorDueAtMs);
    }
    this.values.set(input.assignmentKey, input.assignmentRaw);
    return input.assignmentRaw;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
  environment,
);
const otherScope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId: "223e4567-e89b-42d3-a456-426614174000" },
  environment,
);
const ownerKey = "a".repeat(64);
const triggerId = "323e4567-e89b-42d3-a456-426614174000";
const now = new Date("2026-08-14T17:00:00.000Z");

function legacyRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    consecutiveFailures: 0,
    createdAtMs: Date.parse("2026-08-01T17:00:00.000Z"),
    destination: { adapterName: "imessage", kind: "photon", threadId: "imessage:fixture" },
    enabled: true,
    everyMinutes: 60,
    expiresAtMs: Date.parse("2026-09-01T17:00:00.000Z"),
    id,
    instruction: "Check the configured SEC page.",
    lastCompletedAtMs: Date.parse("2026-08-14T16:00:00.000Z"),
    lastErrorCode: null,
    lastRunAtMs: Date.parse("2026-08-14T16:00:00.000Z"),
    name: "Legacy SEC monitor",
    nextRunAtMs: Date.parse("2026-08-14T18:00:00.000Z"),
    ownerKey,
    revision: 4,
    runCount: 12,
    schemaVersion: 1,
    sourceIds: [],
    sourceUrls: ["https://www.sec.gov/Archives/edgar/data/"],
    timezone: "America/Vancouver",
    updatedAtMs: Date.parse("2026-08-14T16:00:00.000Z"),
    userId: "imessage:fixture-owner",
    ...overrides,
  };
}

const client = new MemoryStore();
client.values.set(`eve:event-trigger:v1:record:${triggerId}`, JSON.stringify(legacyRecord(triggerId)));
client.due.set(triggerId, Date.parse("2026-08-14T18:00:00.000Z"));
const assigned = await assignLegacyMonitorToWorkspace(
  {
    deliverySubscriptionId: "conversation_fixture",
    expectedLegacyRevision: 4,
    legacyOwnerKey: ownerKey,
    legacyTriggerId: triggerId,
    now,
    scope,
  },
  client,
);
assert.equal(assigned.monitor.workspaceId, scope.workspaceId);
assert.equal(assigned.monitor.workspaceBindingImmutable, true);
assert.equal(assigned.monitor.schedule.kind, "interval");
assert.equal(assigned.monitor.nextOccurrenceAt, "2026-08-14T18:00:00.000Z");
assert.equal(assigned.monitor.sourceCheckpoint.watermark, "2026-08-14T16:00:00.000Z");
assert.equal(assigned.monitor.sourceCheckpoint.contentDigest, null);
assert.equal(assigned.monitor.sources.length, 1);
const disabledLegacy = JSON.parse(client.values.get(`eve:event-trigger:v1:record:${triggerId}`)!);
assert.equal(disabledLegacy.enabled, false);
assert.equal(disabledLegacy.nextRunAtMs, null);
assert.equal(disabledLegacy.lastErrorCode, "assigned_to_workspace");
assert.equal(disabledLegacy.revision, 5);
assert.equal(client.due.has(triggerId), false);
assert.equal(client.due.size, 1);
assert.deepEqual(
  await readWorkspaceLegacyMonitorAssignment(scope, triggerId, client),
  assigned.assignment,
);

const retried = await assignLegacyMonitorToWorkspace(
  {
    deliverySubscriptionId: "conversation_fixture",
    expectedLegacyRevision: 4,
    legacyOwnerKey: ownerKey,
    legacyTriggerId: triggerId,
    now: new Date("2026-08-14T17:01:00.000Z"),
    scope,
  },
  client,
);
assert.deepEqual(retried, assigned);
await assert.rejects(
  assignLegacyMonitorToWorkspace(
    {
      deliverySubscriptionId: "conversation_fixture",
      expectedLegacyRevision: 4,
      legacyOwnerKey: ownerKey,
      legacyTriggerId: triggerId,
      now,
      scope: otherScope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceLegacyMonitorAssignmentError &&
    error.code === "legacy_assignment_conflict",
);

const busyId = "423e4567-e89b-42d3-a456-426614174000";
client.values.set(`eve:event-trigger:v1:record:${busyId}`, JSON.stringify(legacyRecord(busyId)));
client.active.add(`eve:event-trigger:v1:active-run:${busyId}`);
await assert.rejects(
  assignLegacyMonitorToWorkspace(
    {
      deliverySubscriptionId: "conversation_fixture",
      expectedLegacyRevision: 4,
      legacyOwnerKey: ownerKey,
      legacyTriggerId: busyId,
      now,
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceLegacyMonitorAssignmentError &&
    error.code === "legacy_assignment_busy",
);
assert.equal(JSON.parse(client.values.get(`eve:event-trigger:v1:record:${busyId}`)!).enabled, true);

const telegramId = "523e4567-e89b-42d3-a456-426614174000";
client.values.set(
  `eve:event-trigger:v1:record:${telegramId}`,
  JSON.stringify(legacyRecord(telegramId, { destination: { chatId: "1", kind: "telegram" } })),
);
await assert.rejects(
  assignLegacyMonitorToWorkspace(
    {
      deliverySubscriptionId: "conversation_fixture",
      expectedLegacyRevision: 4,
      legacyOwnerKey: ownerKey,
      legacyTriggerId: telegramId,
      now,
      scope,
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceLegacyMonitorAssignmentError &&
    error.code === "legacy_assignment_incompatible",
);

assert.equal([...client.values.keys()].some((key) => key.includes("generation")), false);
const assignmentTool = await readFile(
  new URL("../agent/tools/assign_legacy_monitor_to_workspace.ts", import.meta.url),
  "utf8",
);
assert.match(assignmentTool, /authorizePhotonWorkspaceToolStore/u);
assert.match(assignmentTool, /requireWorkspaceMonitorWrites/u);
assert.doesNotMatch(assignmentTool, /workspaceId\s*:/u);
console.info("Workspace legacy monitor assignment verification passed.");
