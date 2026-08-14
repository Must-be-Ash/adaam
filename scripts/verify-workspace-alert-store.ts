import assert from "node:assert/strict";

import {
  readWorkspaceAlert,
  readWorkspaceAlertById,
  stageWorkspaceAlert,
  stageWorkspaceAlertDelivery,
  type WorkspaceAlertStoreClient,
} from "../agent/lib/workspace-alert-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import type { WorkspaceFinding } from "../agent/lib/workspace-finding-store";
import type { WorkspaceMonitor } from "../agent/lib/workspace-monitor-store";

class MemoryStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const otherScope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "223e4567-e89b-42d3-a456-426614174000",
}, environment);
const now = new Date("2026-08-14T17:00:00.000Z");
const finding = {
  accessClassification: "public",
  artifactRefs: [],
  asOf: now.toISOString(),
  contentHash: "a".repeat(64),
  findingId: `finding_${"b".repeat(64)}`,
  monitorId: "323e4567-e89b-42d3-a456-426614174000",
  ownerId: scope.ownerId,
  provenance: [{
    accessClassification: "public",
    canonicalUrl: "https://www.sec.gov/Archives/fixture.htm",
    origin: "https://www.sec.gov",
    sourceId: "sec-latest-s1-filings",
  }],
  recordType: "workspace_finding",
  runId: "run_fixture",
  schemaVersion: 1,
  state: "committed",
  summary: "Fixture Corp filed a new S-1 registration.",
  workspaceId: scope.workspaceId,
} satisfies WorkspaceFinding;
const monitor = {
  configurationRevision: 1,
  consecutiveFailures: 0,
  createdAt: now.toISOString(),
  deliverySubscriptionId: "subscription.photon.fixture",
  endAt: null,
  instruction: "Find new IPO registrations.",
  lastCompletedAt: null,
  lastErrorCode: null,
  lastRunAt: null,
  lifecycleState: "enabled",
  monitorId: finding.monitorId,
  name: "IPO Filings",
  nextOccurrenceAt: now.toISOString(),
  ownerId: scope.ownerId,
  pauseReason: null,
  pausedAt: null,
  requiredCapabilityIds: [],
  schedule: { at: now.toISOString(), kind: "one_time" },
  schemaVersion: 1,
  sourceCheckpoint: { contentDigest: null, watermark: null },
  sources: [{
    accessClassification: "public",
    canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
    origin: "https://www.sec.gov",
    sourceId: "sec-latest-s1-filings",
  }],
  tighteningLimits: { inputTokensPerRun: null, outputTokensPerRun: null, paidPerRun: null },
  updatedAt: now.toISOString(),
  workspaceBindingImmutable: true,
  workspaceId: scope.workspaceId,
} satisfies WorkspaceMonitor;
const client = new MemoryStore();
const alert = await stageWorkspaceAlert({ finding, monitor, now, scope }, client);
assert.equal(alert.workspaceName, "IPO Filings");
assert.equal(alert.findingId, finding.findingId);
assert.deepEqual(await stageWorkspaceAlert({ finding, monitor, now: new Date(now.getTime() + 1_000), scope }, client), alert);
assert.deepEqual(await readWorkspaceAlert(scope, finding.findingId, client), alert);
assert.deepEqual(await readWorkspaceAlertById(scope, alert.alertId, client), alert);
assert.equal(await readWorkspaceAlert(otherScope, finding.findingId, client), null);

const delivery = await stageWorkspaceAlertDelivery({
  alert,
  destination: "private-photon-thread",
  now,
  scope,
  subscriptionId: monitor.deliverySubscriptionId,
}, client);
assert.equal(delivery.state, "staged");
assert.equal(delivery.attempt, 0);
assert.equal(JSON.stringify(delivery).includes("private-photon-thread"), false);
assert.deepEqual(await stageWorkspaceAlertDelivery({
  alert,
  destination: "private-photon-thread",
  now: new Date(now.getTime() + 1_000),
  scope,
  subscriptionId: monitor.deliverySubscriptionId,
}, client), delivery);

console.info("Workspace alert outbox verification passed.");
