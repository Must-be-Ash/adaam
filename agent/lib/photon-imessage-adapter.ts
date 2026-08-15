import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { createConnectWebhookVerifier } from "@vercel/connect/chat";
import { connectPhotonCredentials } from "@vercel/connect/eve";

export function createPhotonImessageAdapter() {
  const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET;
  const photonConnectorId =
    process.env.PHOTON_CONNECTOR_ID?.trim() ||
    "photon/earnings-call-analyser";

  return createiMessageAdapter({
    credentials: connectPhotonCredentials(photonConnectorId),
    ...(webhookSecret
      ? { webhookSecret }
      : { webhookVerifier: createConnectWebhookVerifier() }),
  });
}
