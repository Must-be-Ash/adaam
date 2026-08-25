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
  /*
   * When the story has a report, deliver it as its own mini-app card - the rich
   * surface (charts, sources, metadata) the owner expects, matching how token
   * research is presented - before the discuss card that opens a chat about it.
   */
  if (input.card.artifactUrl) {
    await outboundAdapter.sendMiniApp(input.destination, input.card.artifactUrl);
  }
  const delivered = await outboundAdapter.sendMiniApp(
    input.destination,
    input.card.discussUrl,
  );
  return { messageId: delivered.id };
}
