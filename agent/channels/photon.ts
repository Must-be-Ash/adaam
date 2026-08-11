import { createMemoryState } from "@chat-adapter/state-memory";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { connectPhotonCredentials } from "@vercel/connect/eve";
import type { Thread } from "chat";
import { vercelOidc } from "eve/channels/auth";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";
import type { InputRequest } from "eve/client";

import {
  createPhotonApprovalPrompt,
  isPhotonApprovalAlias,
  isPhotonApprovalSupported,
  parsePhotonTextDecision,
  type PhotonApprovalDecision,
  type PhotonApprovalPrompt,
} from "../lib/photon-approval";
import {
  activatePhotonApproval,
  claimCurrentPhotonApprovalDecision,
  claimPhotonApprovalEvent,
  clearPhotonApproval,
  getPhotonApprovalView,
  hasCurrentPhotonApproval,
  savePhotonApproval,
  type PhotonApprovalDelivery,
} from "../lib/photon-approval-store";
import { photonAuth, photonPrincipalId } from "../lib/photon-auth";
import { photonApprovalAppUrl } from "../lib/photon-mini-app";

const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET;
const imessageAdapter = createiMessageAdapter({
  credentials: connectPhotonCredentials("photon/earnings-call-analyser"),
  ...(webhookSecret
    ? { webhookSecret }
    : { webhookVerifier: vercelOidc() }),
});

function approvalRequestText(prompt: PhotonApprovalPrompt): string {
  return `${prompt.approvalText}\n\nOpen the approval card to choose Approve or Deny. If the card does not open, reply YES or NO.`;
}

function unavailableApprovalText(prompt: string): string {
  return `${prompt}\n\nI couldn't open a safe approval request. No action was authorized; ask Eve to try again.`;
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

async function respondToEveSession(
  sessionId: string,
  inputResponses: readonly { optionId: string; requestId: string }[],
): Promise<void> {
  const host =
    process.env.VERCEL_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (!host || !oidcToken) {
    throw new Error("The internal Eve session responder is unavailable.");
  }
  const baseUrl = host.startsWith("http") ? host : `https://${host}`;
  const url = new URL(
    `/eve/v1/session/${encodeURIComponent(sessionId)}`,
    baseUrl,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        body: JSON.stringify({ inputResponses }),
        headers: {
          authorization: `Bearer ${oidcToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      if (response.status < 500 || attempt === 2) {
        throw new Error("Eve rejected the pending input response.");
      }
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function deliverPhotonApprovalResponse(
  delivery: PhotonApprovalDelivery,
): Promise<void> {
  const host =
    process.env.VERCEL_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (!host || !oidcToken) {
    throw new Error("The internal Photon approval responder is unavailable.");
  }
  const baseUrl = host.startsWith("http") ? host : `https://${host}`;
  const url = new URL(
    "/eve/v1/internal/photon-approval-response",
    baseUrl,
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        body: JSON.stringify({
          decision: delivery.decision,
          recordKey: delivery.recordKey,
        }),
        headers: {
          authorization: `Bearer ${oidcToken}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      if (response.status < 500 || attempt === 2) {
        throw new Error("Eve rejected the Photon approval response.");
      }
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function denyApprovalRequests(input: {
  notice: string;
  requests: readonly InputRequest[];
  sessionId: string;
  thread: Thread;
}): Promise<void> {
  const approvals = input.requests.filter(
    (request) => request.kind === "tool-approval",
  );
  if (approvals.length > 0) {
    try {
      await respondToEveSession(
        input.sessionId,
        approvals.map((request) => ({
          optionId: "deny",
          requestId: request.requestId,
        })),
      );
    } catch {
      await input.thread
        .post(
          "I couldn't safely cancel that approval request. No action was authorized.",
        )
        .catch(() => undefined);
      return;
    }
  }
  await input.thread.post(input.notice);
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
        if (containsApproval) {
          await denyApprovalRequests({
            notice:
              "I can only handle one approval at a time. This batch was denied; ask Eve to present one action at a time.",
            requests: data.requests,
            sessionId: ctx.session.id,
            thread: channel.thread,
          });
        } else {
          await channel.thread.post(
            data.requests.map(inputFallbackText).join("\n\n"),
          );
        }
        return;
      }

      if (
        auth?.authenticator !== "photon-imessage-webhook" ||
        auth.principalType !== "user" ||
        !auth.principalId.startsWith("imessage:")
      ) {
        await denyApprovalRequests({
          notice: unavailableApprovalText(request.prompt),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      if (!isPhotonApprovalSupported(request)) {
        await denyApprovalRequests({
          notice: `${request.prompt}\n\nThis action cannot be approved from iMessage yet. It was denied.`,
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }

      let prompt: PhotonApprovalPrompt;
      try {
        prompt = createPhotonApprovalPrompt(request);
      } catch {
        await denyApprovalRequests({
          notice: unavailableApprovalText(request.prompt),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      let approvalToken: string;
      let reservationState:
        | "active"
        | "delivered"
        | "delivering"
        | "draft"
        | "unavailable";
      let reused: boolean;
      try {
        const reservation = await savePhotonApproval({
          principalId: auth.principalId,
          prompt,
          sessionId: ctx.session.id,
          threadId: channel.thread.id,
        });
        approvalToken = reservation.approvalToken;
        reservationState = reservation.state;
        reused = reservation.reused;
      } catch {
        await denyApprovalRequests({
          notice: unavailableApprovalText(prompt.approvalText),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      if (reused && reservationState !== "draft") {
        return;
      }

      try {
        await imessageAdapter.sendMiniApp(
          channel.thread.id,
          photonApprovalAppUrl(approvalToken),
        );
      } catch {
        const cleared = await clearPhotonApproval({
          approvalToken,
          principalId: auth.principalId,
          threadId: channel.thread.id,
        }).catch(() => false);
        if (cleared) {
          await denyApprovalRequests({
            notice: unavailableApprovalText(prompt.approvalText),
            requests: [request],
            sessionId: ctx.session.id,
            thread: channel.thread,
          });
        }
        return;
      }

      try {
        await activatePhotonApproval({
          approvalToken,
          principalId: auth.principalId,
          threadId: channel.thread.id,
        });
        await channel.thread
          .post(approvalRequestText(prompt))
          .catch(() => undefined);
      } catch {
        const view = await getPhotonApprovalView(approvalToken).catch(
          () => null,
        );
        if (
          view &&
          (view.status === "active" ||
            view.status === "processing" ||
            view.status === "delivered")
        ) {
          await channel.thread
            .post(approvalRequestText(prompt))
            .catch(() => undefined);
          return;
        }
        const cleared = await clearPhotonApproval({
          approvalToken,
          principalId: auth.principalId,
          threadId: channel.thread.id,
        }).catch(() => false);
        if (cleared) {
          await denyApprovalRequests({
            notice: unavailableApprovalText(prompt.approvalText),
            requests: [request],
            sessionId: ctx.session.id,
            thread: channel.thread,
          });
        } else {
          await channel.thread
            .post(
              "The approval card was sent, but its status is still being reconciled. No additional action was authorized.",
            )
            .catch(() => undefined);
        }
        return;
      }
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
): Promise<boolean> {
  const principalId = photonPrincipalId(senderId);
  let claim;
  try {
    claim = await claimCurrentPhotonApprovalDecision({
      decision,
      principalId,
      threadId: thread.id,
    });
  } catch {
    await thread.post(
      "I couldn't verify that choice. No action was authorized; try the request again.",
    );
    return true;
  }

  if (claim.status === "missing") {
    await thread.post(
      "There is no active order approval. Ask Eve to prepare the order again.",
    );
    return true;
  }
  if (claim.status === "unavailable") {
    await thread.post(
      "The approval is still opening. No action was authorized; reply YES or NO again.",
    );
    return true;
  }
  if (claim.status === "invalid") {
    await thread.post(
      "That approval was already used or is no longer active. No additional action was authorized.",
    );
    return true;
  }
  if (claim.status === "forbidden") {
    await thread.post(
      "That approval belongs to a different sender. No action was authorized.",
    );
    return true;
  }
  if (claim.status === "conflict") {
    await thread.post(
      "The other choice is already being confirmed. No second choice was accepted.",
    );
    return true;
  }
  if (claim.status === "delivered") {
    await thread.post(
      claim.decision === "approve"
        ? "That order was already approved."
        : "That order was already denied.",
    );
    return true;
  }
  if (claim.status !== "deliver") {
    await thread.post(
      "I couldn't verify that choice. No action was authorized; try the request again.",
    );
    return true;
  }

  const acknowledgement =
    claim.delivery.expired
      ? "That approval expired. No action was taken."
      : claim.delivery.decision === "approve"
        ? "Approved. Continuing…"
        : "Denied. No action will be taken.";
  try {
    await deliverPhotonApprovalResponse(claim.delivery);
  } catch {
    await thread
      .post(
        "I couldn't confirm that choice yet. Reply with the same choice to retry; the other choice will not be accepted.",
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
    principalId: photonPrincipalId(input.senderId),
    threadId: input.threadId,
  });
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
  const textDecision = parsePhotonTextDecision(message.text);
  if (textDecision) {
    let firstEvent;
    try {
      firstEvent = await isFirstApprovalEvent({
        eventId: message.id,
        senderId,
        threadId: thread.id,
      });
    } catch {
      await thread.post(
        "I couldn't verify that reply, so no action was authorized. Please try again.",
      );
      return;
    }
    if (!firstEvent) {
      return;
    }
    await submitApprovalDecision(thread, senderId, textDecision);
    return;
  }
  if (isPhotonApprovalAlias(message.text)) {
    await thread.post(
      "Reply with the word YES or NO when an order approval is active. No action was authorized.",
    );
    return;
  }

  try {
    if (
      await hasCurrentPhotonApproval({
        principalId: photonPrincipalId(senderId),
        threadId: thread.id,
      })
    ) {
      await thread.post(
        "An order is waiting for your decision. Reply YES to approve it or NO to cancel it before sending another request.",
      );
      return;
    }
  } catch {
    await thread.post(
      "I couldn't verify the pending order state, so I did not send this message to Eve. Please try again.",
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

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
