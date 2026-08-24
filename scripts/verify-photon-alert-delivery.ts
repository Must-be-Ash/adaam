import assert from "node:assert/strict";

import {
  deliverWorkspaceAlertToPhoton,
  PhotonAlertDeliveryUncertainError,
} from "../agent/lib/photon-alert-delivery";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import {
  createPhotonWorkspace,
  getPhotonWorkspaceState,
} from "../agent/lib/photon-workspace-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import type { WorkspaceMonitor } from "../agent/lib/workspace-monitor-store";

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}
class MemoryWorkspaceStore {
  values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return "conflict" as const;
    this.values.set(key, next);
    return "swapped" as const;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string, options?: { nx?: true }) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
}

process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example.test";
const workspaceClient = new MemoryWorkspaceStore();
const photonScope = { principalId: "imessage:fixture-owner", threadId: "imessage:fixture-thread" };
const initialWorkspaceState = await getPhotonWorkspaceState(photonScope, workspaceClient);
const workspaceState = await createPhotonWorkspace({
  ...photonScope,
  expectedRevision: initialWorkspaceState.revision,
  name: "IPO Filings",
  select: false,
}, workspaceClient);
const workspaceId = workspaceState.workspaces.find(
  (workspace) => workspace.name === "IPO Filings",
)!.id;
const scope = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId }, {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
});
const now = new Date("2026-08-14T20:00:00.000Z");
const monitor = {
  configurationRevision: 1,
  deliverySubscriptionId: "subscription.photon.fixture",
  monitorId: "323e4567-e89b-42d3-a456-426614174000",
  workspaceId,
} as WorkspaceMonitor;
const baseAlert = {
  alertId: `alert_${"a".repeat(64)}`,
  createdAt: now.toISOString(),
  eventTime: "2026-08-14T19:58:00.000Z",
  findingId: `finding_${"b".repeat(64)}`,
  ownerId: "owner_fixture",
  recordType: "workspace_alert" as const,
  schemaVersion: 1 as const,
  sourceLinks: [{
    canonicalUrl: "https://www.sec.gov/Archives/fixture.htm",
    sourceId: "sec-latest-s1-filings",
  }],
  sourceRefs: ["sec-latest-s1-filings"],
  state: "ready" as const,
  title: "New S-1 registration filing",
  whyMatched: "Fixture Corp filed a new registration statement.",
  workspaceId,
  workspaceName: "IPO Filings",
};
const subscription = {
  conversationId: `conversation_${"c".repeat(64)}`,
  destination: "private-photon-thread",
  ownerId: "owner_fixture",
  ...photonScope,
  subscriptionId: monitor.deliverySubscriptionId,
};
const alertClient = new MemoryAlertStore();
let recorded = 0;
let sentCard;
const delivered = await deliverWorkspaceAlertToPhoton({
  alert: baseAlert,
  alertClient,
  monitor,
  now,
  pauseMonitor: async () => { throw new Error("Must not pause successful delivery."); },
  recordRecent: async () => { recorded += 1; },
  scope,
  send: async (card) => {
    sentCard = card;
    return { messageId: "message_alert_fixture" };
  },
  subscription,
  workspaceClient,
});
assert.equal(delivered.state, "delivered");
assert.equal(recorded, 1);
assert.match(sentCard!.heading, /IPO Filings/u);
// The observed timestamp is not user-facing; it stays off the owner card.
assert.equal(/Observed [A-Z][a-z]+ \d/u.test(sentCard!.fallbackText), false);
assert.match(sentCard!.fallbackText, /https:\/\/www\.sec\.gov\/Archives\/fixture\.htm/u);
assert.match(
  sentCard!.discussUrl,
  /#[-_A-Za-z0-9]{43}\.[-_A-Za-z0-9]{43}$/u,
);
assert.match(sentCard!.manageUrl, /#[-_A-Za-z0-9]{43}$/u);
let duplicateSends = 0;
assert.equal((await deliverWorkspaceAlertToPhoton({
  alert: baseAlert,
  alertClient,
  monitor,
  now: new Date(now.getTime() + 500),
  pauseMonitor: async () => { throw new Error("Must not pause duplicate delivery."); },
  recordRecent: async () => { throw new Error("Must not re-record duplicate delivery."); },
  scope,
  send: async () => { duplicateSends += 1; return { messageId: "duplicate" }; },
  subscription,
  workspaceClient,
})).state, "delivered");
assert.equal(duplicateSends, 0);

let paused = 0;
await assert.rejects(() => deliverWorkspaceAlertToPhoton({
  alert: { ...baseAlert, alertId: `alert_${"d".repeat(64)}`, findingId: `finding_${"e".repeat(64)}` },
  alertClient,
  monitor: { ...monitor, deliverySubscriptionId: "subscription.photon.uncertain" },
  now: new Date(now.getTime() + 1_000),
  pauseMonitor: async () => { paused += 1; },
  recordRecent: async () => { throw new Error("Must not record uncertain delivery."); },
  scope,
  send: async () => { throw new Error("Acceptance unknown."); },
  subscription: { ...subscription, subscriptionId: "subscription.photon.uncertain" },
  workspaceClient,
}), (error) => error instanceof PhotonAlertDeliveryUncertainError && error.delivery.state === "delivery_uncertain");
assert.equal(paused, 1);

console.info("Photon alert delivery and uncertainty verification passed.");
