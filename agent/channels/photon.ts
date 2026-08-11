import { randomBytes } from "node:crypto";

import { createRedisState } from "@chat-adapter/state-redis";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { connectPhotonCredentials } from "@vercel/connect/eve";
import type { Thread } from "chat";
import { vercelOidc } from "eve/channels/auth";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";
import type { InputRequest, MessageStreamEvent } from "eve/client";

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
  failPhotonApprovalDecision,
  getPhotonApprovalView,
  hasCurrentPhotonApproval,
  savePhotonApproval,
  type PhotonApprovalDelivery,
} from "../lib/photon-approval-store";
import { photonAuth, photonPrincipalId } from "../lib/photon-auth";
import { photonApprovalAppUrl } from "../lib/photon-mini-app";
import {
  completePhotonSessionMigration,
  PHOTON_SESSION_GENERATION,
  releasePhotonSessionMigration,
  reservePhotonSessionMigration,
  savePhotonSessionBinding,
} from "../lib/photon-session-store";

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
): Promise<"accepted" | "uncertain"> {
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
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { status?: unknown }
          | null;
        return body?.status === "uncertain" ? "uncertain" : "accepted";
      }
      if (response.status < 500 || attempt === 2) {
        throw new Error("Eve rejected the Photon approval response.");
      }
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Eve did not acknowledge the Photon approval response.");
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
  concurrency: "queue",
  events: {
    async "turn.failed"(data, channel, ctx) {
      console.error("[photon.turn] Eve turn failed", {
        error_code: data.code,
        session_id: ctx.session.id,
        turn_id: data.turnId,
      });
      if (!channel.thread) return;
      await channel.thread.post(
        `I couldn't finish that request (${data.code}). I won't retry it automatically. If it involved an order, check Coinbase before trying again.`,
      );
    },
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
      } catch (error) {
        console.error("[photon.approval] Approval prompt creation failed", {
          error_type: error instanceof Error ? error.name : typeof error,
          request_id: request.requestId,
          session_id: ctx.session.id,
          tool_name: request.action.toolName,
        });
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
      } catch (error) {
        console.error("[photon.approval] Approval reservation failed", {
          error_type: error instanceof Error ? error.name : typeof error,
          request_id: request.requestId,
          session_id: ctx.session.id,
          tool_name: request.action.toolName,
        });
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
      } catch (error) {
        console.warn("[photon.approval] Mini-app delivery failed", {
          error_type: error instanceof Error ? error.name : typeof error,
          request_id: request.requestId,
          session_id: ctx.session.id,
          tool_name: request.action.toolName,
        });
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
        console.info("[photon.approval] Approval ready", {
          delivery: "mini-app",
          request_id: request.requestId,
          session_id: ctx.session.id,
          tool_name: request.action.toolName,
        });
      } catch (error) {
        console.warn("[photon.approval] Approval activation uncertain", {
          error_type: error instanceof Error ? error.name : typeof error,
          request_id: request.requestId,
          session_id: ctx.session.id,
          tool_name: request.action.toolName,
        });
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
  state: createRedisState({
    keyPrefix: "eve:photon:chat-sdk",
  }),
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

  let acknowledgement =
    claim.delivery.expired
      ? "That approval expired. No action was taken."
      : claim.delivery.decision === "approve"
        ? "Approved. Continuing…"
        : "Denied. No action will be taken.";
  try {
    const deliveryStatus = await deliverPhotonApprovalResponse(claim.delivery);
    if (deliveryStatus === "uncertain") {
      acknowledgement =
        "Approval status is uncertain. Check Coinbase before retrying this order.";
    }
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

async function readSessionEvent(
  reader: ReadableStreamDefaultReader<MessageStreamEvent>,
  timeoutMs: number,
) {
  return new Promise<Awaited<ReturnType<typeof reader.read>>>(
    (resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the session refresh turn.")),
        timeoutMs,
      );
      reader.read().then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    },
  );
}

async function waitForSessionRefreshTurn(
  session: Awaited<ReturnType<typeof bridge.send>>,
  controlMessage: string,
): Promise<void> {
  const tailIndex = await session.getStreamTailIndex();
  const stream = await session.getEventStream({
    startIndex: Math.max(0, tailIndex - 50),
  });
  const reader = stream.getReader();
  const deadline = Date.now() + 90_000;
  let controlTurnId: string | undefined;
  let observedEvents = 0;

  try {
    while (observedEvents < 10_000) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("Timed out waiting for the session refresh turn.");
      }
      const result = await readSessionEvent(reader, remainingMs);
      if (result.done) {
        throw new Error("The session event stream ended before refresh.");
      }
      observedEvents += 1;
      const event = result.value;
      if (
        event.type === "message.received" &&
        event.data.message === controlMessage
      ) {
        controlTurnId = event.data.turnId;
        continue;
      }
      if (!controlTurnId) continue;
      if (event.type === "session.waiting") return;
      if (
        event.type === "session.completed" ||
        event.type === "session.failed"
      ) {
        return;
      }
    }
    throw new Error("The session refresh produced too many events.");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function invalidateCurrentPhotonApproval(input: {
  principalId: string;
  threadId: string;
}): Promise<void> {
  const claim = await claimCurrentPhotonApprovalDecision({
    decision: "deny",
    principalId: input.principalId,
    threadId: input.threadId,
  });
  if (claim.status === "deliver") {
    await failPhotonApprovalDecision({
      decision: claim.delivery.decision,
      recordKey: claim.delivery.recordKey,
    });
    return;
  }
  if (claim.status === "conflict") {
    throw new Error("A Photon approval decision is already being delivered.");
  }
}

async function ensureCurrentPhotonSession(
  thread: Thread,
  senderId: string,
): Promise<boolean> {
  const principalId = photonPrincipalId(senderId);
  let reservation;
  try {
    reservation = await reservePhotonSessionMigration({
      generation: PHOTON_SESSION_GENERATION,
      principalId,
      threadId: thread.id,
    });
  } catch {
    await thread.post(
      "I couldn't verify this conversation's session state. Please try again.",
    );
    return false;
  }
  if (reservation.status === "current") return true;
  if (reservation.status === "busy") {
    await thread.post(
      "This conversation is already refreshing. Please try again in a moment.",
    );
    return false;
  }

  let stage = "open";
  try {
    const refreshId = randomBytes(12).toString("base64url");
    const controlMessage =
      `Refresh this conversation for the current runtime (${refreshId}). ` +
      "Wait for any earlier request to finish, then do not call tools or take actions.";
    const previousSession = await bridge.send(
      {
        context: [
          "This is a session migration control turn. Do not call tools or take actions. Reply only that the conversation is refreshing.",
        ],
        message: controlMessage,
      },
      {
        auth: photonAuth(senderId, thread.id),
        thread,
        turnPolicy: "queue",
      },
    );
    stage = "wait";
    await waitForSessionRefreshTurn(previousSession, controlMessage);
    stage = "reset";
    await previousSession.reset({
      reason: "Move this iMessage conversation to the current runtime.",
    });
    stage = "invalidate-approval";
    await invalidateCurrentPhotonApproval({
      principalId,
      threadId: thread.id,
    });
    stage = "commit";
    const completed = await completePhotonSessionMigration({
      generation: PHOTON_SESSION_GENERATION,
      migrationToken: reservation.migrationToken,
      principalId,
      threadId: thread.id,
    });
    if (!completed) {
      throw new Error("The Photon session migration reservation expired.");
    }
    console.info("[photon.session] Migrated conversation to current runtime", {
      previous_session_id: previousSession.id,
      runtime_generation: PHOTON_SESSION_GENERATION,
    });
  } catch (error) {
    await releasePhotonSessionMigration({
      migrationToken: reservation.migrationToken,
      principalId,
      threadId: thread.id,
    }).catch(() => undefined);
    console.error("[photon.session] Session migration failed", {
      error_type: error instanceof Error ? error.name : typeof error,
      migration_stage: stage,
      runtime_generation: PHOTON_SESSION_GENERATION,
    });
    await thread.post(
      "I couldn't refresh this conversation safely. No action was taken; please try again.",
    );
    return false;
  }
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
  context?: Parameters<
    Parameters<typeof bridge.bot.onDirectMessage>[0]
  >[2],
): Promise<void> {
  for (const skipped of context?.skipped ?? []) {
    await dispatch(thread, skipped);
  }
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

  const session = await bridge.send(
    {
      context: [
        "This request arrived through a private iMessage conversation.",
      ],
      message: messageToUserContent(message),
    },
    {
      auth: photonAuth(senderId, thread.id),
      thread,
      turnPolicy: "queue",
    },
  );
  await savePhotonSessionBinding({
    generation: PHOTON_SESSION_GENERATION,
    principalId: photonPrincipalId(senderId),
    sessionId: session.id,
    threadId: thread.id,
  }).catch((error: unknown) => {
    console.error("[photon.session] Session binding update failed", {
      error_type: error instanceof Error ? error.name : typeof error,
      runtime_generation: PHOTON_SESSION_GENERATION,
      session_id: session.id,
    });
  });
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
