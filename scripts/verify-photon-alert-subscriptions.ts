import assert from "node:assert/strict";

import {
  readPhotonAlertDeliverySubscription,
  savePhotonAlertDeliverySubscription,
  type PhotonAlertDeliverySubscriptionStoreClient,
} from "../agent/lib/photon-alert-subscription-store";
import { resolvePhotonOwnerConversationIdentity } from "../agent/lib/owner-identity";

class MemorySubscriptionStore implements PhotonAlertDeliverySubscriptionStoreClient {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }
}

const principalId = "imessage:fixture-owner";
const threadId = "imessage:fixture-thread";
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: Buffer.alloc(32, 7).toString("base64url"),
  EVE_PHOTON_OWNER_PRINCIPALS: principalId,
};
const identity = resolvePhotonOwnerConversationIdentity(
  { principalId, threadId },
  environment,
);
const client = new MemorySubscriptionStore();

await savePhotonAlertDeliverySubscription({
  conversationId: identity.conversationId,
  ownerId: identity.ownerId,
  principalId,
  subscriptionId: identity.conversationId,
  threadId,
}, client, environment);

assert.deepEqual(
  await readPhotonAlertDeliverySubscription({
    ownerId: identity.ownerId,
    subscriptionId: identity.conversationId,
  }, client, environment),
  {
    conversationId: identity.conversationId,
    destination: threadId,
    ownerId: identity.ownerId,
    principalId,
    subscriptionId: identity.conversationId,
    threadId,
  },
);

await assert.rejects(
  readPhotonAlertDeliverySubscription({
    ownerId: "owner_other",
    subscriptionId: identity.conversationId,
  }, client, environment),
  /photon_alert_subscription_unavailable/u,
);

console.info("Photon alert delivery subscription verification passed.");
