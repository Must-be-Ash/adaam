import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";

import { sendPhotonWorkspaceAlertCard } from "../agent/lib/photon-alert-outbound";
import { deliverWorkspaceAlertToPhoton } from "../agent/lib/photon-alert-delivery";
import { readPhotonAlertDeliverySubscription } from "../agent/lib/photon-alert-subscription-store";
import {
  applyPhotonAlertDiscussAction,
  consumePhotonPendingAlertContext,
  getPhotonWorkspaceState,
} from "../agent/lib/photon-workspace-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import type { WorkspaceAlert } from "../agent/lib/workspace-alert-store";
import type { WorkspaceMonitor } from "../agent/lib/workspace-monitor-store";

async function runEarningsCallPhotonAlertAcceptance(
  expectDisabled = process.argv.includes("--expect-disabled"),
) {
const FLAG = "EVE_PHOTON_WORKSPACE_ALERTS_ENABLED";
const SUBSCRIPTION_PREFIX = "eve:workspace-runtime:v1:photon-alert-subscription:";
if (expectDisabled) {
  assert.notEqual(process.env[FLAG], "1", "Photon alerts must be disabled");
  return { outcome: "acceptance_alert_flag_off" as const, sendAttempts: 0 };
}
assert.equal(process.env[FLAG], "1", "Photon alerts must be enabled for the live acceptance");

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const ownerId = process.env.EVE_DEPLOYMENT_OWNER_ID;
assert.ok(url && token && ownerId, "production workspace storage must be configured");
const redis = new Redis({ automaticDeserialization: false, token, url });
const keys = await redis.keys(`${SUBSCRIPTION_PREFIX}*`);
const records = (await Promise.all(keys.map(async (key) => {
  const raw = await redis.get<string>(key);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value.ownerId === ownerId && typeof value.subscriptionId === "string" &&
      typeof value.createdAt === "string" ? value : null;
  } catch {
    return null;
  }
}))).filter((value): value is Record<string, string> => value !== null)
  .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
let subscription: Awaited<ReturnType<typeof readPhotonAlertDeliverySubscription>> | null = null;
for (const record of records) {
  try {
    subscription = await readPhotonAlertDeliverySubscription({
      ownerId,
      subscriptionId: record.subscriptionId,
    });
    break;
  } catch {
    continue;
  }
}
assert.ok(subscription, "an authorized Photon alert subscription is required");

const initial = await getPhotonWorkspaceState(subscription);
const targetWorkspace = initial.activeWorkspace;

const now = new Date();
const findingId = "earnings-finding.7d3a2b8967a5d2dd3c2dba1ef10fa2cff2c1ffcd5b961587";
const alertId = `alert_live_${createHash("sha256").update(`${findingId}\0${now.toISOString()}`).digest("hex")}`;
const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: targetWorkspace.id });
const alert: WorkspaceAlert = {
  alertId,
  artifactRefs: [findingId, "comparison.6d4f2c802720afd79f49e48ba01c21f7b1066f9e"],
  createdAt: now.toISOString(),
  eventTime: "2026-07-14T00:00:00.000Z",
  findingId,
  ownerId,
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceLinks: [{
    canonicalUrl: "https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/2nd-quarter/2Q26-earnings-transcript.pdf",
    sourceId: "earnings-call-transcripts.0000019617",
  }],
  sourceRefs: ["earnings-call-transcripts.0000019617"],
  state: "ready",
  title: "JPM 2Q26 earnings-call change · production acceptance",
  whyMatched: "Controlled acceptance: the real Q2/Q1 evidence produced an alert-eligible materiality score of 86. No action is required.",
  workspaceId: targetWorkspace.id,
  workspaceName: targetWorkspace.name,
};
const monitor = {
  configurationRevision: 1,
  deliverySubscriptionId: subscription.subscriptionId,
  monitorId: "00000000-0000-4000-8000-00000000004b",
  workspaceId: targetWorkspace.id,
} as WorkspaceMonitor;
let discussUrl: string | null = null;
const delivery = await deliverWorkspaceAlertToPhoton({
  alert,
  monitor,
  pauseMonitor: async () => { throw new Error("successful_acceptance_delivery_must_not_pause"); },
  scope,
  send: async (card) => {
    discussUrl = card.discussUrl;
    return sendPhotonWorkspaceAlertCard({ card, destination: subscription.destination });
  },
  subscription,
});
assert.equal(delivery.state, "delivered");
assert.ok(discussUrl);
const alertToken = new URL(discussUrl).hash.slice(1).split(".")[0]!;
const discussed = await applyPhotonAlertDiscussAction(alertToken);
assert.equal(discussed.status, "applied");
if (discussed.status !== "applied") throw new Error("live_discuss_action_not_applied");
assert.equal(discussed.state.activeWorkspace.id, targetWorkspace.id);
const consumed = await consumePhotonPendingAlertContext({
  principalId: subscription.principalId,
  threadId: subscription.threadId,
  workspaceId: targetWorkspace.id,
});
assert.equal(consumed.context?.alertId, alertId);
assert.equal(consumed.context?.findingId, findingId);
assert.equal(consumed.state.activeWorkspace.id, targetWorkspace.id);

return {
  alertId,
  deliveryId: delivery.deliveryId,
  discussOutcome: discussed.status,
  findingId,
  outcome: "acceptance_alert_delivered" as const,
  workspaceSelectionPreserved: true,
};
}

console.info(JSON.stringify(await runEarningsCallPhotonAlertAcceptance()));
