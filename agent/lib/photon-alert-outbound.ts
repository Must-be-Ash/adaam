import type { PhotonAlertCard } from "./photon-alert-delivery";
import { createPhotonImessageAdapter } from "./photon-imessage-adapter";

let outboundAdapter: ReturnType<typeof createPhotonImessageAdapter> | undefined;

export async function sendPhotonWorkspaceAlertCard(input: {
  card: PhotonAlertCard;
  destination: string;
}): Promise<{ messageId: string }> {
  outboundAdapter ??= createPhotonImessageAdapter();
  await outboundAdapter.postMessage(input.destination, {
    markdown: input.card.fallbackText,
  });
  const delivered = await outboundAdapter.sendMiniApp(
    input.destination,
    input.card.discussUrl,
  );
  return { messageId: delivered.id };
}
