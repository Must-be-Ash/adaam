import { createHash } from "node:crypto";

import type { SessionAuthContext, SessionContext } from "eve/context";

export type EventTriggerDestination =
  | {
      kind: "photon";
      adapterName: "imessage";
      threadId: string;
    }
  | {
      kind: "telegram";
      chatId: string;
      messageThreadId?: number;
    };

export interface EventTriggerOwner {
  ownerKey: string;
  userId: string;
  destination: EventTriggerDestination;
}

function stringAttribute(
  auth: SessionAuthContext,
  name: string,
): string | undefined {
  const value = auth.attributes[name];
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value[0] : undefined;
}

function stableUserId(auth: SessionAuthContext): string {
  if (auth.authenticator === "telegram-webhook") {
    const telegramUserId = stringAttribute(auth, "user_id");
    if (telegramUserId) return `telegram:${telegramUserId}`;
  }
  return auth.principalId;
}

function ownerKey(auth: SessionAuthContext, userId: string): string {
  const stableIssuer =
    auth.authenticator === "telegram-webhook"
      ? "telegram"
      : (auth.issuer ?? "");
  return createHash("sha256")
    .update([auth.authenticator, stableIssuer, userId].join("\u0000"))
    .digest("hex");
}

function resolveDestination(
  auth: SessionAuthContext,
): EventTriggerDestination | null {
  if (
    auth.authenticator === "photon-imessage-webhook" &&
    stringAttribute(auth, "channel") === "photon"
  ) {
    const threadId = stringAttribute(auth, "thread_id");
    if (threadId) {
      return {
        kind: "photon",
        adapterName: "imessage",
        threadId,
      };
    }
  }

  if (auth.authenticator === "telegram-webhook") {
    if (stringAttribute(auth, "chat_type") !== "private") return null;
    const chatId = stringAttribute(auth, "chat_id");
    const messageThreadId = Number(stringAttribute(auth, "message_thread_id"));
    if (chatId) {
      return {
        kind: "telegram",
        chatId,
        ...(Number.isSafeInteger(messageThreadId) && messageThreadId > 0
          ? { messageThreadId }
          : {}),
      };
    }
  }

  return null;
}

export function requireEventTriggerOwner(ctx: SessionContext): EventTriggerOwner {
  const auth = ctx.session.auth.current;
  if (!auth || auth.principalType !== "user") {
    throw new Error(
      "An authenticated iMessage or Telegram user is required to manage event triggers.",
    );
  }

  const destination = resolveDestination(auth);
  if (!destination) {
    if (
      auth.authenticator === "telegram-webhook" &&
      stringAttribute(auth, "chat_type") !== "private"
    ) {
      throw new Error(
        "Manage event triggers in a private Telegram chat with Eve. Group chats are not supported for trigger management.",
      );
    }
    throw new Error(
      "Event-trigger delivery is available from an iMessage or Telegram conversation. Create the trigger from the conversation where alerts should arrive.",
    );
  }

  const userId = stableUserId(auth);
  return {
    ownerKey: ownerKey(auth, userId),
    userId,
    destination,
  };
}
