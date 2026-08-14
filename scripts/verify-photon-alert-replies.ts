import assert from "node:assert/strict";

import {
  claimPhotonHeldAlertReply,
  classifyPhotonAlertReply,
  holdPhotonAlertReply,
  parsePhotonHeldReplyChoice,
  readActivePhotonHeldReply,
  readRecentPhotonAlerts,
  recordRecentPhotonAlert,
} from "../agent/lib/photon-alert-reply-store";
import {
  assignPhotonIngress,
  createPhotonDispatchReceipt,
  createPhotonIngressReceipt,
} from "../agent/lib/photon-ingress-store";

class MemoryStore {
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
  async set(key: string, value: string) { this.values.set(key, value); return "OK"; }
}

class MemoryIngressStore {
  values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return { created: false, value: current };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const client = new MemoryStore();
const selectedWorkspaceId = "123e4567-e89b-42d3-a456-426614174000";
const candidateWorkspaceId = "223e4567-e89b-42d3-a456-426614174000";
const conversationId = `conversation_${"a".repeat(64)}`;
const candidate = {
  alertId: `alert_${"b".repeat(64)}`,
  deliveredAt: "2026-08-14T18:00:00.000Z",
  deliveryMessageId: "message_alert_1",
  title: "New S-1 registration filing",
  workspaceId: candidateWorkspaceId,
  workspaceName: "IPO Filings",
} as const;
await recordRecentPhotonAlert({ candidate, conversationId }, client);
assert.deepEqual(await readRecentPhotonAlerts(conversationId, client), [candidate]);
assert.equal(classifyPhotonAlertReply({
  candidates: [candidate],
  messageText: "What changed in the IPO Filings registration?",
  selectedWorkspaceId,
})?.alertId, candidate.alertId);
assert.equal(classifyPhotonAlertReply({
  candidates: [candidate],
  messageText: "What changed?",
  selectedWorkspaceId,
}), null);
assert.equal(classifyPhotonAlertReply({
  candidates: [candidate],
  messageText: "What changed?",
  quotedMessageId: "message_alert_1",
  selectedWorkspaceId,
})?.alertId, candidate.alertId);

const held = await holdPhotonAlertReply({
  candidateAlertId: candidate.alertId,
  candidateWorkspaceId,
  candidateWorkspaceName: candidate.workspaceName,
  conversationId,
  ingressId: `ingress_${"c".repeat(64)}`,
  messageText: "What changed in the IPO Filings registration?",
  ownerId: "owner_fixture",
  routingRevision: 4,
  selectedWorkspaceId,
  selectedWorkspaceName: "Main",
}, client);
assert.equal((await readActivePhotonHeldReply(conversationId, client))?.state, "held");
assert.equal(parsePhotonHeldReplyChoice("use IPO Filings", held), "candidate");
assert.equal(parsePhotonHeldReplyChoice("stay in Main", held), "selected");
assert.equal(parsePhotonHeldReplyChoice("maybe", held), null);
const claimed = await claimPhotonHeldAlertReply({ choice: "candidate", ingressId: held.ingressId }, client);
assert.equal(claimed?.state, "assigned");
assert.equal(claimed?.assignedWorkspaceId, candidateWorkspaceId);
assert.equal(await claimPhotonHeldAlertReply({ choice: "candidate", ingressId: held.ingressId }, client), null);

const ingressClient = new MemoryIngressStore();
const ingress = (await createPhotonIngressReceipt({
  classification: "held_alert_reply",
  conversationId,
  eventId: "event_held_fixture",
  now: new Date("2026-08-14T18:01:00.000Z"),
  ownerId: "owner_fixture",
}, ingressClient)).record;
const assignment = await assignPhotonIngress({
  generation: 1,
  ingress,
  now: new Date("2026-08-14T18:02:00.000Z"),
  reason: "confirmed_held_reply",
  routingRevision: 5,
  workspaceId: candidateWorkspaceId,
}, ingressClient);
assert.equal(assignment.reason, "confirmed_held_reply");
const dispatch = await createPhotonDispatchReceipt({
  assignment,
  continuationTarget: `thread\0workspace\0${1}`,
  now: new Date("2026-08-14T18:03:00.000Z"),
}, ingressClient);
assert.equal(dispatch.created, true);
assert.equal((await createPhotonDispatchReceipt({
  assignment,
  continuationTarget: `thread\0workspace\0${1}`,
  now: new Date("2026-08-14T18:04:00.000Z"),
}, ingressClient)).created, false);

console.info("Photon held alert-reply verification passed.");
