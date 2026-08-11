import { createMemoryState } from "@chat-adapter/state-memory";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { connectPhotonCredentials } from "@vercel/connect/eve";
import {
  Modal,
  Select,
  SelectOption,
  type ModalSubmitEvent,
  type Thread,
} from "chat";
import { vercelOidc } from "eve/channels/auth";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";
import type { SessionAuthContext } from "eve/context";

import {
  PHOTON_APPROVAL_CALLBACK_ID,
  PHOTON_APPROVAL_DECISION_FIELD,
  approvalCodeFromPollTitle,
  createPhotonApprovalPrompt,
  isPhotonApprovalSupported,
  isUnscopedApprovalAlias,
  parsePhotonPollVote,
  parsePhotonTextDecision,
  type PhotonApprovalDecision,
  type PhotonApprovalPrompt,
} from "../lib/photon-approval";
import {
  activatePhotonApproval,
  claimPhotonApprovalEvent,
  clearPhotonApproval,
  consumePhotonApproval,
  savePhotonApproval,
} from "../lib/photon-approval-store";

const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET;
const imessageAdapter = createiMessageAdapter({
  credentials: connectPhotonCredentials("photon/earnings-call-analyser"),
  ...(webhookSecret
    ? { webhookSecret }
    : { webhookVerifier: vercelOidc() }),
});
const approvalThreads = new Map<string, Thread>();

function photonAuth(senderId: string, threadId: string): SessionAuthContext {
  return {
    attributes: {
      channel: "photon",
      thread_id: threadId,
    },
    authenticator: "photon-imessage-webhook",
    issuer: "photon-imessage",
    principalId: `imessage:${senderId}`,
    principalType: "user",
    subject: senderId,
  };
}

function approvalThreadKey(threadId: string, pollTitle: string): string {
  return `${threadId}\u0000${pollTitle}`;
}

function pollTitleFromApprovalThreadKey(key: string): string | null {
  const separator = key.indexOf("\u0000");
  return separator >= 0 ? key.slice(separator + 1) : null;
}

function rememberApprovalThread(pollTitle: string, thread: Thread): void {
  const key = approvalThreadKey(thread.id, pollTitle);
  approvalThreads.delete(key);
  approvalThreads.set(key, thread);
  if (approvalThreads.size <= 64) return;
  const oldest = approvalThreads.keys().next().value;
  if (typeof oldest === "string") approvalThreads.delete(oldest);
}

function approvalFallbackText(prompt: PhotonApprovalPrompt): string {
  return `${prompt.pollTitle}\n\nUse the approval prompt above, or reply APPROVE ${prompt.approvalCode} or DENY ${prompt.approvalCode}. The first choice Eve confirms is final.`;
}

function unavailableApprovalText(prompt: string): string {
  return `${prompt}\n\nApproval controls are unavailable. Reply DENY to cancel; no action has been authorized.`;
}

function inputFallbackText(input: {
  allowFreeform?: boolean;
  options?: readonly {
    description?: string;
    id: string;
    label: string;
  }[];
  prompt: string;
}): string {
  if (input.options && input.options.length > 0) {
    return `${input.prompt}\n\nOptions: ${input.options
      .map((option) => {
        const id =
          option.id.toLowerCase() === option.label.toLowerCase()
            ? ""
            : ` (${option.id})`;
        return `${option.label}${id}${option.description ? ` — ${option.description}` : ""}`;
      })
      .join(" / ")}\nReply with one option.`;
  }
  return input.allowFreeform
    ? `${input.prompt}\n\nReply with your answer.`
    : input.prompt;
}

const bridge = chatSdkChannel({
  adapters: {
    imessage: imessageAdapter,
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
    async "input.requested"(data, channel, ctx) {
      if (!channel.thread) return;
      const [request] = data.requests;
      const auth = ctx.session.auth.current;

      if (
        data.requests.length !== 1 ||
        !request ||
        request.kind !== "tool-approval"
      ) {
        const containsApproval = data.requests.some(
          (pending) => pending.kind === "tool-approval",
        );
        await channel.thread.post(
          containsApproval
            ? "I can only handle one approval at a time. Reply DENY to cancel this batch; no action has been authorized."
            : data.requests.map(inputFallbackText).join("\n\n"),
        );
        return;
      }

      if (
        auth?.authenticator !== "photon-imessage-webhook" ||
        auth.principalType !== "user" ||
        !auth.principalId.startsWith("imessage:")
      ) {
        await channel.thread.post(unavailableApprovalText(request.prompt));
        return;
      }
      if (!isPhotonApprovalSupported(request)) {
        await channel.thread.post(
          `${request.prompt}\n\nThis action cannot be approved from iMessage yet. Reply DENY to cancel; no action has been authorized.`,
        );
        return;
      }

      let prompt: PhotonApprovalPrompt;
      try {
        prompt = createPhotonApprovalPrompt(request);
      } catch {
        await channel.thread.post(unavailableApprovalText(request.prompt));
        return;
      }
      try {
        await savePhotonApproval({
          principalId: auth.principalId,
          prompt,
          threadId: channel.thread.id,
        });
      } catch {
        await channel.thread.post(unavailableApprovalText(prompt.pollTitle));
        return;
      }

      try {
        await imessageAdapter.openModal(
          channel.thread.id,
          Modal({
            callbackId: PHOTON_APPROVAL_CALLBACK_ID,
            children: [
              Select({
                id: PHOTON_APPROVAL_DECISION_FIELD,
                label: "Choose",
                options: [
                  SelectOption({ label: "Approve", value: "approve" }),
                  SelectOption({ label: "Deny", value: "deny" }),
                ],
              }),
            ],
            privateMetadata: approvalThreadKey(
              channel.thread.id,
              prompt.pollTitle,
            ),
            title: prompt.pollTitle,
          }),
          channel.thread.id,
        );
        await activatePhotonApproval({
          approvalCode: prompt.approvalCode,
          principalId: auth.principalId,
          threadId: channel.thread.id,
        });
        rememberApprovalThread(prompt.pollTitle, channel.thread);
      } catch {
        await clearPhotonApproval({
          approvalCode: prompt.approvalCode,
          principalId: auth.principalId,
          threadId: channel.thread.id,
        }).catch(() => undefined);
        await channel.thread.post(unavailableApprovalText(prompt.pollTitle));
        return;
      }
      await channel.thread.post(approvalFallbackText(prompt)).catch(() => undefined);
    },
  },
  routes: { imessage: "/eve/v1/photon" },
  state: createMemoryState(),
  streaming: false,
  userName: "eve",
});

async function submitApprovalDecision(
  thread: Thread,
  senderId: string,
  decision: PhotonApprovalDecision,
  approvalCode: string,
  pollTitle?: string,
): Promise<boolean> {
  const principalId = `imessage:${senderId}`;
  let consumption;
  try {
    consumption = await consumePhotonApproval({
      approvalCode,
      principalId,
      threadId: thread.id,
    });
  } catch {
    await thread.post(
      "I couldn't verify that choice. No action was authorized; try the request again.",
    );
    return true;
  }

  if (
    consumption.status === "missing" ||
    consumption.status === "invalid" ||
    consumption.status === "unavailable"
  ) {
    await thread.post(
      "That approval was already used or is no longer active. No additional action was authorized.",
    );
    return false;
  }
  if (consumption.status === "forbidden") {
    await thread.post(
      "That approval belongs to a different sender. No action was authorized.",
    );
    return true;
  }

  if (pollTitle) {
    approvalThreads.delete(approvalThreadKey(thread.id, pollTitle));
  }
  const submittedDecision =
    consumption.status === "expired" ? "deny" : decision;
  const acknowledgement =
    consumption.status === "expired"
      ? "That approval expired. No action was taken."
      : submittedDecision === "approve"
        ? "Approved. Continuing…"
        : "Denied. No action will be taken.";
  try {
    await bridge.send(
      {
        inputResponses: [
          {
            optionId: submittedDecision,
            requestId: consumption.requestId,
          },
        ],
      },
      {
        auth: photonAuth(senderId, thread.id),
        thread,
        turnPolicy: "queue",
      },
    );
  } catch {
    await thread
      .post(
        "I couldn't confirm delivery of that choice. Check the result before trying again.",
      )
      .catch(() => undefined);
    return true;
  }
  await thread.post(acknowledgement).catch(() => undefined);
  return true;
}

async function isFirstApprovalEvent(input: {
  eventId: string;
  senderId: string;
  threadId: string;
}): Promise<boolean> {
  return claimPhotonApprovalEvent({
    eventId: input.eventId,
    principalId: `imessage:${input.senderId}`,
    threadId: input.threadId,
  }).catch(() => true);
}

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
  const pollVote = parsePhotonPollVote(message.raw);
  if (pollVote) {
    if (pollVote.selected && pollVote.decision) {
      if (
        !(await isFirstApprovalEvent({
          eventId: message.id,
          senderId,
          threadId: thread.id,
        }))
      ) {
        return;
      }
      await submitApprovalDecision(
        thread,
        senderId,
        pollVote.decision,
        pollVote.approvalCode,
        pollVote.pollTitle,
      );
    }
    return;
  }

  const textDecision = parsePhotonTextDecision(message.text);
  if (textDecision) {
    if (
      !(await isFirstApprovalEvent({
        eventId: message.id,
        senderId,
        threadId: thread.id,
      }))
    ) {
      return;
    }
    await submitApprovalDecision(
      thread,
      senderId,
      textDecision.decision,
      textDecision.approvalCode,
    );
    return;
  }
  if (isUnscopedApprovalAlias(message.text)) {
    await thread.post(
      "Use a named non-approval option, or use the request-bound approval choice and code. No action was authorized.",
    );
    return;
  }

  await bridge.send(
    {
      context: [
        "This request arrived through a private iMessage conversation.",
      ],
      message: messageToUserContent(message),
    },
    {
      auth: photonAuth(senderId, thread.id),
      thread,
      turnPolicy: "experimental-steer",
    },
  );
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);
bridge.bot.onModalSubmit(
  PHOTON_APPROVAL_CALLBACK_ID,
  async (event: ModalSubmitEvent) => {
    const approvalKey = event.privateMetadata;
    const pollTitle =
      typeof approvalKey === "string"
        ? pollTitleFromApprovalThreadKey(approvalKey)
        : null;
    const approvalCode = pollTitle
      ? approvalCodeFromPollTitle(pollTitle)
      : null;
    const decision = event.values[PHOTON_APPROVAL_DECISION_FIELD];
    const thread =
      typeof approvalKey === "string"
        ? approvalThreads.get(approvalKey)
        : undefined;
    if (
      !thread ||
      !pollTitle ||
      !approvalCode ||
      (decision !== "approve" && decision !== "deny")
    ) {
      return;
    }
    if (
      !(await isFirstApprovalEvent({
        eventId: event.viewId,
        senderId: event.user.userId,
        threadId: thread.id,
      }))
    ) {
      return;
    }
    await submitApprovalDecision(
      thread,
      event.user.userId,
      decision,
      approvalCode,
      pollTitle,
    );
  },
);

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
