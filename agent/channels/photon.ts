import { createRedisState } from "@chat-adapter/state-redis";
import { createiMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { createConnectWebhookVerifier } from "@vercel/connect/chat";
import { connectPhotonCredentials } from "@vercel/connect/eve";
import type { Thread } from "chat";
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
  completePhotonApprovalDecision,
  failPhotonApprovalDecision,
  getCurrentPhotonApprovalActivity,
  getPhotonApprovalView,
  photonApprovalGuardKey,
  releasePhotonApprovalProcessing,
  savePhotonApproval,
  type PhotonApprovalProcessingRelease,
} from "../lib/photon-approval-store.js";
import { photonAuth, photonPrincipalId } from "../lib/photon-auth";
import {
  photonApprovalAppUrl,
  photonWorkspaceAppUrl,
} from "../lib/photon-mini-app";
import {
  archivePhotonWorkspace,
  createPhotonWorkspace,
  findPhotonWorkspaceByName,
  getPhotonWorkspaceState,
  mintPhotonWorkspaceManager,
  renamePhotonWorkspace,
  savePhotonWorkspaceSession,
  selectPhotonWorkspace,
  startFreshPhotonWorkspace,
  type PhotonWorkspace,
  type PhotonWorkspaceState,
  PhotonWorkspaceApprovalBlockedError,
  PhotonWorkspaceValidationError,
} from "../lib/photon-workspace-store";
import {
  photonWorkspaceContext,
  photonWorkspaceThread,
  parsePhotonWorkspaceThreadId,
  physicalPhotonThreadId,
  workspaceAwarePhotonAdapter,
} from "../lib/photon-workspace";

const webhookSecret = process.env.IMESSAGE_WEBHOOK_SECRET;
const imessageAdapter = createiMessageAdapter({
  credentials: connectPhotonCredentials("photon/earnings-call-analyser"),
  ...(webhookSecret
    ? { webhookSecret }
    : { webhookVerifier: createConnectWebhookVerifier() }),
});
const routedImessageAdapter = workspaceAwarePhotonAdapter(imessageAdapter);

function isPhotonSessionResetCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
  return normalized === "reset session" || normalized === "start fresh";
}

type PhotonWorkspaceControl =
  | { action: "archive"; name: string }
  | { action: "create"; name: string }
  | { action: "list" }
  | { action: "manage" }
  | { action: "rename"; currentName: string; name: string }
  | { action: "select"; name: string };

function parsePhotonWorkspaceControl(
  text: string,
): PhotonWorkspaceControl | null {
  const request = text.trim().replace(/[.!?]+$/u, "").trim();
  if (
    /^(?:manage|show|open)(?: my)? workspaces$/iu.test(request) ||
    /^workspace settings$/iu.test(request)
  ) {
    return { action: "manage" };
  }
  if (/^list(?: my)? workspaces$/iu.test(request)) {
    return { action: "list" };
  }
  let match = request.match(/^create(?: a)? workspace(?: called)? (.+)$/iu);
  if (match?.[1]) {
    return { action: "create", name: match[1] };
  }
  match = request.match(
    /^(?:use|select|switch to)(?: the)? workspace (.+)$/iu,
  );
  if (match?.[1]) {
    return { action: "select", name: match[1] };
  }
  match = request.match(/^switch workspace to (.+)$/iu);
  if (match?.[1]) {
    return { action: "select", name: match[1] };
  }
  match = request.match(/^rename workspace (.+?) to (.+)$/iu);
  if (match?.[1] && match[2]) {
    return {
      action: "rename",
      currentName: match[1],
      name: match[2],
    };
  }
  match = request.match(/^archive workspace (.+)$/iu);
  if (match?.[1]) {
    return { action: "archive", name: match[1] };
  }
  return null;
}

function photonWorkspaceListText(state: PhotonWorkspaceState): string {
  const lines = state.workspaces.map((workspace) => {
    const active =
      workspace.id === state.activeWorkspace.id ? " · active" : "";
    const archived = workspace.status === "archived" ? " · archived" : "";
    return `• ${workspace.name}${active}${archived}`;
  });
  return [
    "Eve control · Workspaces",
    ...lines,
    "",
    "Send “manage workspaces” for the workspace manager.",
  ].join("\n");
}

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
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
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
          photonWorkspaceLabeledText(
            null,
            "I couldn't safely cancel that approval request. No action was authorized.",
          ),
        )
        .catch(() => undefined);
      return;
    }
  }
  await input.thread.post(input.notice);
}

async function releaseApprovedOrderGuard(
  sessionId: string,
): Promise<PhotonApprovalProcessingRelease> {
  try {
    return await releasePhotonApprovalProcessing(sessionId);
  } catch (error) {
    console.error("[photon.approval] Processing guard release failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return "retained";
  }
}

async function photonWorkspaceResponseName(input: {
  principalId: string;
  sessionId: string;
  threadId: string;
}): Promise<string | null> {
  try {
    const state = await getPhotonWorkspaceState({
      principalId: input.principalId,
      threadId: physicalPhotonThreadId(input.threadId),
    });
    const matched = state.workspaces.find(
      (workspace) => workspace.sessionId === input.sessionId,
    );
    if (matched) return matched.name;
    return input.threadId === physicalPhotonThreadId(input.threadId) &&
      state.activeWorkspace.continuation === "physical"
      ? state.activeWorkspace.name
      : null;
  } catch {
    return null;
  }
}

function photonWorkspaceLabeledText(
  workspaceName: string | null,
  text: string,
): string {
  return `[Workspace: ${workspaceName ?? "unavailable"}]\n\n${text}`;
}

async function activePhotonWorkspaceForSession(input: {
  principalId: string;
  routedThreadId: string;
  sessionId: string;
}): Promise<PhotonWorkspace | null> {
  const route = parsePhotonWorkspaceThreadId(input.routedThreadId);
  const state = await getPhotonWorkspaceState({
    principalId: input.principalId,
    threadId: physicalPhotonThreadId(input.routedThreadId),
  });
  if (route) {
    const workspace = state.workspaces.find(
      (candidate) => candidate.id === route.workspaceId,
    );
    return workspace?.status === "active" &&
      workspace.id === state.activeWorkspace.id &&
      workspace.generation === route.generation &&
      (!workspace.sessionId || workspace.sessionId === input.sessionId)
      ? workspace
      : null;
  }
  const workspace = state.activeWorkspace;
  return workspace.status === "active" &&
    workspace.continuation === "physical" &&
    (!workspace.sessionId || workspace.sessionId === input.sessionId)
    ? workspace
    : null;
}

const bridge = chatSdkChannel({
  adapters: {
    imessage: routedImessageAdapter,
  },
  concurrency: "queue",
  events: {
    async "message.completed"(data, channel, ctx) {
      if (
        data.finishReason === "tool-calls" ||
        !data.message ||
        !channel.thread
      ) {
        return;
      }
      const principalId = ctx.session.auth.current?.principalId;
      const workspaceName = principalId
        ? await photonWorkspaceResponseName({
            principalId,
            sessionId: ctx.session.id,
            threadId: channel.thread.id,
          })
        : null;
      await channel.thread.post({
        markdown: photonWorkspaceLabeledText(workspaceName, data.message),
      });
    },
    async "turn.failed"(data, channel, ctx) {
      const release = await releaseApprovedOrderGuard(ctx.session.id);
      console.error("[photon.turn] Eve turn failed", {
        error_code: data.code,
        session_id: ctx.session.id,
        turn_id: data.turnId,
      });
      if (!channel.thread) return;
      const principalId = ctx.session.auth.current?.principalId;
      const workspaceName = principalId
        ? await photonWorkspaceResponseName({
            principalId,
            sessionId: ctx.session.id,
            threadId: channel.thread.id,
          })
        : null;
      await channel.thread.post(
        photonWorkspaceLabeledText(
          workspaceName,
          release === "retained"
            ? `I couldn't finish that request (${data.code}). The Coinbase order status is uncertain, so new orders remain blocked. Check Coinbase before taking another action.`
            : `I couldn't finish that request (${data.code}). I won't retry it automatically. If it involved an order, check Coinbase before trying again.`,
        ),
      );
    },
    async "turn.completed"(_data, channel, ctx) {
      const release = await releaseApprovedOrderGuard(ctx.session.id);
      if (release === "retained" && channel.thread) {
        const principalId = ctx.session.auth.current?.principalId;
        const workspaceName = principalId
          ? await photonWorkspaceResponseName({
              principalId,
              sessionId: ctx.session.id,
              threadId: channel.thread.id,
            })
          : null;
        await channel.thread.post(
          photonWorkspaceLabeledText(
            workspaceName,
            "The Coinbase order status is not safely settled. Check Coinbase before trying another order; new orders remain blocked for safety.",
          ),
        );
      }
    },
    async "turn.cancelled"(_data, channel, ctx) {
      const release = await releaseApprovedOrderGuard(ctx.session.id);
      if (release !== "missing" && channel.thread) {
        const principalId = ctx.session.auth.current?.principalId;
        const workspaceName = principalId
          ? await photonWorkspaceResponseName({
              principalId,
              sessionId: ctx.session.id,
              threadId: channel.thread.id,
            })
          : null;
        await channel.thread.post(
          photonWorkspaceLabeledText(
            workspaceName,
            release === "released"
              ? "The approved order turn was interrupted after Coinbase settled it. Check Coinbase before submitting another order."
              : "The approved order turn was interrupted and its status is uncertain. Check Coinbase; new orders remain blocked for safety.",
          ),
        );
      }
    },
    async "session.completed"(_data, _channel, ctx) {
      await releaseApprovedOrderGuard(ctx.session.id);
    },
    async "session.failed"(_data, channel) {
      if (!channel.thread) return;
      await channel.thread.post(
        photonWorkspaceLabeledText(
          null,
          "This workspace session failed and did not complete its request. Eve will not retry it automatically.",
        ),
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

      const principalId = ctx.session.auth.current?.principalId;
      const workspaceName = principalId
        ? await photonWorkspaceResponseName({
            principalId,
            sessionId: ctx.session.id,
            threadId: channel.thread.id,
          })
        : null;
      await channel.thread.post(
        photonWorkspaceLabeledText(
          workspaceName,
          instructions.join("\n\n"),
        ),
      );
    },
    async "authorization.completed"(data, channel, ctx) {
      if (!channel.thread) return;

      if (data.outcome === "authorized") {
        const principalId = ctx.session.auth.current?.principalId;
        const workspaceName = principalId
          ? await photonWorkspaceResponseName({
              principalId,
              sessionId: ctx.session.id,
              threadId: channel.thread.id,
            })
          : null;
        await channel.thread.post(
          photonWorkspaceLabeledText(
            workspaceName,
            "Masterkey connected. Continuing your request.",
          ),
        );
      }
    },
    async "input.requested"(data, channel, ctx) {
      if (!channel.thread) return;
      const [request] = data.requests;
      const auth = ctx.session.auth.current;
      const physicalThreadId = physicalPhotonThreadId(channel.thread.id);
      const workspaceName = auth?.principalId
        ? await photonWorkspaceResponseName({
            principalId: auth.principalId,
            sessionId: ctx.session.id,
            threadId: channel.thread.id,
          })
        : null;
      const labeled = (text: string) =>
        photonWorkspaceLabeledText(workspaceName, text);

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
            notice: labeled(
              "I can only handle one approval at a time. This batch was denied; ask Eve to present one action at a time.",
            ),
            requests: data.requests,
            sessionId: ctx.session.id,
            thread: channel.thread,
          });
        } else {
          await channel.thread.post(
            labeled(data.requests.map(inputFallbackText).join("\n\n")),
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
          notice: labeled(unavailableApprovalText(request.prompt)),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      if (!isPhotonApprovalSupported(request)) {
        await denyApprovalRequests({
          notice: labeled(
            `${request.prompt}\n\nThis action cannot be approved from iMessage yet. It was denied.`,
          ),
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
          notice: labeled(unavailableApprovalText(request.prompt)),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      let approvalWorkspace: PhotonWorkspace | null = null;
      try {
        approvalWorkspace = await activePhotonWorkspaceForSession({
          principalId: auth.principalId,
          routedThreadId: channel.thread.id,
          sessionId: ctx.session.id,
        });
      } catch {
        // An unavailable workspace registry denies the approval below.
      }
      if (!approvalWorkspace) {
        await denyApprovalRequests({
          notice: labeled(
            "I couldn't bind this approval to the active workspace. The action was denied; ask again from the intended workspace.",
          ),
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
          threadId: physicalThreadId,
          workspaceGeneration: approvalWorkspace.generation,
          workspaceId: approvalWorkspace.id,
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
          notice: labeled(unavailableApprovalText(prompt.approvalText)),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }
      if (reused && reservationState !== "draft") {
        return;
      }

      let activeWorkspaceSession: PhotonWorkspace | null = null;
      try {
        activeWorkspaceSession = await activePhotonWorkspaceForSession({
          principalId: auth.principalId,
          routedThreadId: channel.thread.id,
          sessionId: ctx.session.id,
        });
      } catch {
        // Treat an unavailable routing decision as a denied action.
      }
      if (
        !activeWorkspaceSession ||
        activeWorkspaceSession.id !== approvalWorkspace.id ||
        activeWorkspaceSession.generation !== approvalWorkspace.generation
      ) {
        await clearPhotonApproval({
          approvalToken,
          principalId: auth.principalId,
          threadId: physicalThreadId,
        }).catch(() => false);
        await denyApprovalRequests({
          notice: labeled(
            "The workspace changed or could not be verified before this approval opened. The action was denied; ask again from the intended active workspace.",
          ),
          requests: [request],
          sessionId: ctx.session.id,
          thread: channel.thread,
        });
        return;
      }

      try {
        await imessageAdapter.sendMiniApp(
          physicalThreadId,
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
          threadId: physicalThreadId,
        }).catch(() => false);
        if (cleared) {
          await denyApprovalRequests({
            notice: labeled(unavailableApprovalText(prompt.approvalText)),
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
          threadId: physicalThreadId,
        });
        await channel.thread
          .post(labeled(approvalRequestText(prompt)))
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
            .post(labeled(approvalRequestText(prompt)))
            .catch(() => undefined);
          return;
        }
        const cleared = await clearPhotonApproval({
          approvalToken,
          principalId: auth.principalId,
          threadId: physicalThreadId,
        }).catch(() => false);
        if (cleared) {
          await denyApprovalRequests({
            notice: labeled(unavailableApprovalText(prompt.approvalText)),
            requests: [request],
            sessionId: ctx.session.id,
            thread: channel.thread,
          });
        } else {
          await channel.thread
            .post(
              labeled(
                "The approval card was sent, but its status is still being reconciled. No additional action was authorized.",
              ),
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
  decisionSentAtMs: number,
): Promise<boolean> {
  const principalId = photonPrincipalId(senderId);
  let claim;
  try {
    claim = await claimCurrentPhotonApprovalDecision({
      decision,
      decisionSentAtMs,
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
  if (claim.status === "stale") {
    await thread.post(
      "That reply was sent before the current order approval opened, so it was ignored. Review the current order and reply YES or NO again.",
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
  if (claim.status === "processing") {
    await thread.post(
      claim.decision === "approve"
        ? "That approval is already processing. Do not retry it; wait for Eve's result."
        : "That denial is already processing. No additional choice was accepted.",
    );
    return true;
  }
  if (claim.status !== "deliver") {
    await thread.post(
      "I couldn't verify that choice. No action was authorized; try the request again.",
    );
    return true;
  }

  let workspace: PhotonWorkspace | undefined;
  try {
    const state = await getPhotonWorkspaceState({
      principalId,
      threadId: thread.id,
    });
    const matchedWorkspace =
      claim.delivery.workspaceId && claim.delivery.workspaceGeneration
        ? state.workspaces.find(
            (candidate) =>
              candidate.id === claim.delivery.workspaceId &&
              candidate.generation === claim.delivery.workspaceGeneration,
          )
        : state.workspaces.find(
            (candidate) => candidate.sessionId === claim.delivery.sessionId,
          );
    workspace =
      matchedWorkspace?.status === "active" &&
      matchedWorkspace.id === state.activeWorkspace.id
        ? matchedWorkspace
        : undefined;
    if (
      !workspace &&
      !claim.delivery.workspaceId &&
      state.activeWorkspace.continuation === "physical" &&
      state.activeWorkspace.status === "active"
    ) {
      workspace = state.activeWorkspace;
    }
  } catch {
    // The approval is failed below before any response reaches Eve.
  }
  if (!workspace) {
    await failPhotonApprovalDecision({
      decision: claim.delivery.decision,
      recordKey: claim.delivery.recordKey,
    }).catch(() => undefined);
    await thread.post(
      "I couldn't match that approval to its workspace session. No action was authorized; ask Eve to prepare it again.",
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
    await bridge.send(
      {
        inputResponses: [
          {
            optionId: claim.delivery.decision,
            requestId: claim.delivery.requestId,
          },
        ],
      },
      {
        auth: photonAuth(senderId, thread.id),
        thread: photonWorkspaceThread(thread, workspace),
        turnPolicy: "queue",
      },
    );
  } catch {
    if (claim.delivery.decision === "deny") {
      await failPhotonApprovalDecision({
        decision: claim.delivery.decision,
        recordKey: claim.delivery.recordKey,
      }).catch(() => undefined);
    }
    await thread
      .post(
        claim.delivery.decision === "approve"
          ? "The approval delivery status is uncertain. Do not retry the order; check Coinbase before starting another one."
          : "The order was denied. No order was authorized.",
      )
      .catch(() => undefined);
    return true;
  }
  try {
    await completePhotonApprovalDecision({
      decision: claim.delivery.decision,
      recordKey: claim.delivery.recordKey,
    });
  } catch (error) {
    if (claim.delivery.decision === "deny") {
      await failPhotonApprovalDecision({
        decision: claim.delivery.decision,
        recordKey: claim.delivery.recordKey,
      }).catch(() => undefined);
    }
    console.error("[photon.approval] Text approval completion failed", {
      decision: claim.delivery.decision,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await thread
      .post(
        claim.delivery.decision === "approve"
          ? "Your approval reached Eve, but its final status is uncertain. Check Coinbase before trying another order."
          : "The order was denied, but I couldn't finish clearing its approval state. No order was authorized.",
      )
      .catch(() => undefined);
    return true;
  }
  await thread.post(acknowledgement).catch(() => undefined);
  return true;
}

async function invalidateCurrentPhotonApproval(input: {
  principalId: string;
  threadId: string;
}): Promise<"cleared" | "processing"> {
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
    return "cleared";
  }
  if (claim.status === "delivered") {
    return claim.decision === "approve" ? "processing" : "cleared";
  }
  if (claim.status === "conflict") {
    return "processing";
  }
  if (claim.status === "processing") {
    return claim.decision === "approve" ? "processing" : "cleared";
  }
  return "cleared";
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

async function retirePhotonWorkspaceSession(input: {
  senderId: string;
  thread: Thread;
  workspace: PhotonWorkspace;
}): Promise<boolean> {
  try {
    const session = await bridge.send(
      {
        context: [
          "This is an internal workspace-session retirement command. Do not call tools, take actions, or produce a user-facing response.",
        ],
        message: "Retire this workspace session immediately.",
      },
      {
        auth: photonAuth(input.senderId, input.thread.id),
        thread: photonWorkspaceThread(input.thread, input.workspace),
        turnPolicy: "experimental-steer",
      },
    );
    await session.reset({
      reason: "The iMessage owner started this workspace fresh.",
    });
    return true;
  } catch (error) {
    console.warn("[photon.workspace] Session retirement cleanup failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

async function startFreshActivePhotonWorkspace(input: {
  senderId: string;
  thread: Thread;
}): Promise<void> {
  const principalId = photonPrincipalId(input.senderId);
  const state = await getPhotonWorkspaceState({
    principalId,
    threadId: input.thread.id,
  });
  const result = await startFreshPhotonWorkspace({
    approvalGuardKey: photonApprovalGuardKey({
      principalId,
      threadId: input.thread.id,
    }),
    expectedRevision: state.revision,
    principalId,
    threadId: input.thread.id,
    workspaceId: state.activeWorkspace.id,
  });
  const retired = await retirePhotonWorkspaceSession({
    senderId: input.senderId,
    thread: input.thread,
    workspace: state.activeWorkspace,
  });
  await input.thread.post(
    retired
      ? `Eve control · “${result.state.activeWorkspace.name}” started fresh. Its prior model history and pending requests are retired; other workspaces are unchanged.`
      : `Eve control · “${result.state.activeWorkspace.name}” now routes to a fresh session, but cleanup of its prior session could not be confirmed. No pending financial approval from it can be used.`,
  );
}

async function handlePhotonWorkspaceControl(input: {
  control: PhotonWorkspaceControl;
  senderId: string;
  state: PhotonWorkspaceState;
  thread: Thread;
}): Promise<void> {
  const scope = {
    principalId: photonPrincipalId(input.senderId),
    threadId: input.thread.id,
  };
  const guardedScope = {
    ...scope,
    approvalGuardKey: photonApprovalGuardKey(scope),
    expectedRevision: input.state.revision,
  };
  try {
    switch (input.control.action) {
      case "manage": {
        const manager = await mintPhotonWorkspaceManager(scope);
        try {
          await imessageAdapter.sendMiniApp(
            input.thread.id,
            photonWorkspaceAppUrl(manager.managerToken),
          );
          await input.thread.post(
            "Eve control · Workspace manager opened. The link expires in 15 minutes.\n\nText fallback: “list workspaces”, “create workspace NAME”, “use workspace NAME”, “rename workspace OLD to NEW”, or “archive workspace NAME”.",
          );
        } catch {
          await input.thread.post(
            `${photonWorkspaceListText(input.state)}\n\nThe visual manager could not open. Use the text controls shown above.`,
          );
        }
        return;
      }
      case "list":
        await input.thread.post(photonWorkspaceListText(input.state));
        return;
      case "create": {
        const state = await createPhotonWorkspace({
          ...guardedScope,
          name: input.control.name,
          select: true,
        });
        await input.thread.post(
          `Eve control · Created and selected “${state.activeWorkspace.name}”. New messages now use its isolated session.`,
        );
        return;
      }
      case "select": {
        const workspace = findPhotonWorkspaceByName(
          input.state,
          input.control.name,
        );
        if (!workspace || workspace.status !== "active") {
          throw new PhotonWorkspaceValidationError(
            `No active workspace named “${input.control.name.trim()}” exists.`,
          );
        }
        const state = await selectPhotonWorkspace({
          ...guardedScope,
          workspaceId: workspace.id,
        });
        await input.thread.post(
          `Eve control · Switched to “${state.activeWorkspace.name}”. Its existing session context is now active.`,
        );
        return;
      }
      case "rename": {
        const workspace = findPhotonWorkspaceByName(
          input.state,
          input.control.currentName,
        );
        if (!workspace) {
          throw new PhotonWorkspaceValidationError(
            `No workspace named “${input.control.currentName.trim()}” exists.`,
          );
        }
        const state = await renamePhotonWorkspace({
          ...guardedScope,
          name: input.control.name,
          workspaceId: workspace.id,
        });
        const renamed = state.workspaces.find(
          (candidate) => candidate.id === workspace.id,
        );
        await input.thread.post(
          `Eve control · Renamed the workspace to “${renamed?.name ?? input.control.name.trim()}”.`,
        );
        return;
      }
      case "archive": {
        const workspace = findPhotonWorkspaceByName(
          input.state,
          input.control.name,
        );
        if (!workspace || workspace.status !== "active") {
          throw new PhotonWorkspaceValidationError(
            `No active workspace named “${input.control.name.trim()}” exists.`,
          );
        }
        if (workspace.id === input.state.activeWorkspace.id) {
          throw new PhotonWorkspaceValidationError(
            "Switch to another workspace before archiving the active one.",
          );
        }
        await archivePhotonWorkspace({
          ...guardedScope,
          workspaceId: workspace.id,
        });
        await input.thread.post(
          `Eve control · Archived “${workspace.name}”. Its retained state was not deleted.`,
        );
      }
    }
  } catch (error) {
    if (
      error instanceof PhotonWorkspaceApprovalBlockedError ||
      error instanceof PhotonWorkspaceValidationError
    ) {
      await input.thread.post(`Eve control · ${error.message}`);
      return;
    }
    console.error("[photon.workspace] Text control failed", {
      action: input.control.action,
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await input.thread.post(
      "Eve control · I couldn't confirm the workspace update. Send “list workspaces” before trying another change.",
    );
  }
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
  if (isPhotonSessionResetCommand(message.text)) {
    try {
      const invalidation = await invalidateCurrentPhotonApproval({
        principalId: photonPrincipalId(senderId),
        threadId: thread.id,
      });
      if (invalidation === "processing") {
        await thread.post(
          "An approved action is still processing. Wait for Eve's result before clearing this session.",
        );
        return;
      }
      await startFreshActivePhotonWorkspace({ senderId, thread });
    } catch (error) {
      console.error("[photon.workspace] User-requested reset failed", {
        error_type: error instanceof Error ? error.name : typeof error,
      });
      await thread.post(
        "Eve control · I couldn't confirm the start-fresh request. Send “list workspaces” before trying again.",
      );
    }
    return;
  }

  const textDecision = parsePhotonTextDecision(message.text);
  if (textDecision) {
    const decisionSentAtMs = message.metadata.dateSent.getTime();
    if (
      !Number.isSafeInteger(decisionSentAtMs) ||
      decisionSentAtMs < 0 ||
      decisionSentAtMs > Date.now() + 5 * 60_000
    ) {
      await thread.post(
        "I couldn't verify when that reply was sent, so no action was authorized. Review the order and reply YES or NO again.",
      );
      return;
    }
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
    await submitApprovalDecision(
      thread,
      senderId,
      textDecision,
      decisionSentAtMs,
    );
    return;
  }
  if (isPhotonApprovalAlias(message.text)) {
    await thread.post(
      "Reply with the word YES or NO when an order approval is active. No action was authorized.",
    );
    return;
  }

  try {
    const approvalActivity = await getCurrentPhotonApprovalActivity({
      principalId: photonPrincipalId(senderId),
      threadId: thread.id,
    });
    if (approvalActivity) {
      await thread.post(
        approvalActivity === "processing"
          ? "Your approved action is still processing. Wait for Eve's result before sending another request."
          : "An order is waiting for your decision. Reply YES to approve it or NO to cancel it before sending another request.",
      );
      return;
    }
  } catch {
    await thread.post(
      "I couldn't verify the pending order state, so I did not send this message to Eve. Please try again.",
    );
    return;
  }

  const principalId = photonPrincipalId(senderId);
  let workspaceState: PhotonWorkspaceState;
  try {
    workspaceState = await getPhotonWorkspaceState({
      principalId,
      threadId: thread.id,
    });
  } catch (error) {
    console.error("[photon.workspace] Routing lookup failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await thread.post(
      "Eve control · I couldn't verify the active workspace, so this message was not sent. Please try again.",
    );
    return;
  }

  const workspaceControl = parsePhotonWorkspaceControl(message.text);
  if (workspaceControl) {
    await handlePhotonWorkspaceControl({
      control: workspaceControl,
      senderId,
      state: workspaceState,
      thread,
    });
    return;
  }

  const activeWorkspace = workspaceState.activeWorkspace;
  const session = await bridge.send(
    {
      context: [
        photonWorkspaceContext(activeWorkspace),
      ],
      message: messageToUserContent(message),
    },
    {
      auth: photonAuth(senderId, thread.id),
      thread: photonWorkspaceThread(thread, activeWorkspace),
      turnPolicy: "experimental-steer",
    },
  );
  await savePhotonWorkspaceSession({
    generation: activeWorkspace.generation,
    principalId,
    sessionId: session.id,
    threadId: thread.id,
    workspaceId: activeWorkspace.id,
  }).catch((error: unknown) => {
    console.error("[photon.workspace] Session binding update failed", {
      error_type: error instanceof Error ? error.name : typeof error,
      session_id: session.id,
    });
  });
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
