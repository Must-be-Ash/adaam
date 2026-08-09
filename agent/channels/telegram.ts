import { telegramChannel } from "eve/channels/telegram";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to use the Telegram channel.`);
  }
  return value;
}

export default telegramChannel({
  botUsername: process.env.TELEGRAM_BOT_USERNAME,
  credentials: {
    botToken: () => requiredEnvironmentVariable("TELEGRAM_BOT_TOKEN"),
    webhookSecretToken: () =>
      requiredEnvironmentVariable("TELEGRAM_WEBHOOK_SECRET_TOKEN"),
  },
  events: {
    async "authorization.required"(data, channel, ctx) {
      if (ctx.session.auth.current?.principalType === "runtime") return;

      const displayName = data.authorization?.displayName ?? data.name;
      const url = data.authorization?.url;
      const userCode = data.authorization?.userCode;
      const text = [
        `Authorization required for ${displayName}.`,
        url ? `Open this link to continue: ${url}` : undefined,
        userCode ? `Code: ${userCode}` : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n\n");

      const triggeringUserId = channel.state.triggeringUserId;
      if (channel.state.chatType !== "private" && triggeringUserId) {
        await channel.telegram.request("sendMessage", {
          chat_id: triggeringUserId,
          text,
        });
        return;
      }

      await channel.telegram.post(text);
    },
  },
  uploadPolicy: {
    allowedMediaTypes: [
      "application/pdf",
      "image/*",
      "text/markdown",
      "text/plain",
    ],
    maxBytes: 20 * 1024 * 1024,
  },
});
