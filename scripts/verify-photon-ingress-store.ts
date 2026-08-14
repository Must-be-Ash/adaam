import assert from "node:assert/strict";

import {
  assignPhotonIngress,
  createPhotonCompletionReceipt,
  createPhotonDispatchReceipt,
  createPhotonIngressReceipt,
  createPhotonResponseDeliveryReceipt,
  markPhotonDispatchAccepted,
  photonIngressAuthAttributes,
  PhotonIngressStoreError,
  readPhotonDispatchReceipt,
  type PhotonIngressStoreClient,
} from "../agent/lib/photon-ingress-store";

class MemoryStore implements PhotonIngressStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return { created: false, value: existing };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const client = new MemoryStore();
const now = new Date("2026-08-14T17:00:00.000Z");
const input = {
  classification: "ordinary" as const,
  conversationId: `conversation_${"a".repeat(64)}`,
  eventId: "provider-event-secret-fixture",
  now,
  ownerId: "owner_fixture",
};
const first = await createPhotonIngressReceipt(input, client);
assert.equal(first.created, true);
const duplicate = await createPhotonIngressReceipt({ ...input, now: new Date(now.getTime() + 1_000) }, client);
assert.equal(duplicate.created, false);
assert.deepEqual(duplicate.record, first.record);
assert.equal(JSON.stringify([...client.values.values()]).includes(input.eventId), false);
assert.deepEqual(photonIngressAuthAttributes(first.record), {
  photon_ingress_id: first.record.ingressId,
});
const concurrentClient = new MemoryStore();
const concurrent = await Promise.all([
  createPhotonIngressReceipt(input, concurrentClient),
  createPhotonIngressReceipt(input, concurrentClient),
]);
assert.equal(concurrent.filter((result) => result.created).length, 1);
assert.deepEqual(concurrent[0]!.record, concurrent[1]!.record);

const assignment = await assignPhotonIngress({
  generation: 2,
  ingress: first.record,
  now,
  reason: "selected_workspace",
  routingRevision: 7,
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, client);
assert.equal(assignment.immutable, true);
assert.deepEqual(await assignPhotonIngress({
  generation: 2,
  ingress: first.record,
  now: new Date(now.getTime() + 1_000),
  reason: "selected_workspace",
  routingRevision: 7,
  workspaceId: assignment.workspaceId,
}, client), assignment);
await assert.rejects(
  assignPhotonIngress({
    generation: 2,
    ingress: first.record,
    now,
    reason: "selected_workspace",
    routingRevision: 7,
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  }, client),
  (error) => error instanceof PhotonIngressStoreError && error.code === "photon_assignment_immutable",
);

const dispatchCreation = await createPhotonDispatchReceipt({
  assignment,
  continuationTarget: "private-continuation-target",
  now,
}, client);
assert.equal(dispatchCreation.created, true);
assert.equal(dispatchCreation.record.state, "dispatching");
assert.equal(JSON.stringify([...client.values.values()]).includes("private-continuation-target"), false);
const dispatched = await markPhotonDispatchAccepted({
  ingressId: first.record.ingressId,
  now,
  sessionId: "private-eve-session-id",
}, client);
assert.equal(dispatched.state, "dispatched");
assert.equal(JSON.stringify(dispatched).includes("private-eve-session-id"), false);
const completion = await createPhotonCompletionReceipt({
  dispatch: dispatched,
  now,
  outcome: "completed",
}, client);
assert.equal(completion.outcome, "completed");
assert.equal((await readPhotonDispatchReceipt(first.record.ingressId, client))?.state, "completed");
assert.deepEqual(await createPhotonCompletionReceipt({
  dispatch: { ...dispatched, state: "completed" },
  now: new Date(now.getTime() + 1_000),
  outcome: "completed",
}, client), completion);

const response = await createPhotonResponseDeliveryReceipt({
  content: "private assistant response",
  destination: "private physical thread",
  ingressId: first.record.ingressId,
  now,
}, client);
assert.equal(response.record.state, "staged");
const serialized = JSON.stringify(response.record);
assert.equal(serialized.includes("private assistant response"), false);
assert.equal(serialized.includes("private physical thread"), false);

console.info("Photon ingress and response receipt verification passed.");
