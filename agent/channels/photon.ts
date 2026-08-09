import { createMemoryState } from "@chat-adapter/state-memory";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { connectPhotonCredentials } from "@vercel/connect/eve";
import { vercelOidc } from "eve/channels/auth";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";

const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET;
const bridge = chatSdkChannel({
  adapters: {
    imessage: createiMessageAdapter({
      credentials: connectPhotonCredentials("photon/earnings-call-analyser"),
      ...(webhookSecret
        ? { webhookSecret }
        : { webhookVerifier: vercelOidc() }),
    }),
  },
  concurrency: "concurrent",
  events: {
    async "authorization.required"(data, channel, ctx) {
      if (!channel.thread) return;
      if (ctx.session.auth.current?.principalType === "runtime") return;

      const displayName = data.authorization?.displayName ?? data.name;
      const url = data.authorization?.url;
      const userCode = data.authorization?.userCode;
      const instructions = [
        `Authorization required for ${displayName}.`,
        url ? `Open this link to continue: ${url}` : undefined,
        userCode ? `Code: ${userCode}` : undefined,
      ].filter((line): line is string => line !== undefined);

      await channel.thread.post(instructions.join("\n\n"));
    },
    async "authorization.completed"(data, channel) {
      if (!channel.thread) return;

      if (data.outcome === "authorized") {
        await channel.thread.post("Masterkey connected. Continuing your request.");
      }
    },
  },
  routes: { imessage: "/eve/v1/photon" },
  state: createMemoryState(),
  streaming: false,
  userName: "eve",
});

async function dispatch(
  thread: Parameters<
    Parameters<typeof bridge.bot.onDirectMessage>[0]
  >[0],
  message: Parameters<
    Parameters<typeof bridge.bot.onDirectMessage>[0]
  >[1],
): Promise<void> {
  if (message.author.isBot || !thread.isDM) return;

  const senderId = message.author.userId;
  await bridge.send(
    {
      context: [
        "This request arrived through a private iMessage conversation.",
      ],
      message: messageToUserContent(message),
    },
    {
      auth: {
        attributes: {
          channel: "photon",
          thread_id: thread.id,
        },
        authenticator: "photon-imessage-webhook",
        issuer: "photon-imessage",
        principalId: `imessage:${senderId}`,
        principalType: "user",
        subject: senderId,
      },
      thread,
      turnPolicy: "experimental-steer",
    },
  );
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
