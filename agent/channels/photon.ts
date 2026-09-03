import { createHash } from "node:crypto";

import { createRedisState } from "@chat-adapter/state-redis";
import type { Thread } from "chat";
import {
  chatSdkChannel,
  messageToUserContent,
} from "eve/channels/chat-sdk";
import type { InputRequest } from "eve/client";
import type { SessionContext } from "eve/context";

import {
  createPhotonApprovalPrompt,
  isPhotonApprovalAlias,
  isPhotonApprovalSupported,
  parsePhotonTextDecision,
  type PhotonApprovalDecision,
  type PhotonApprovalPrompt,
} from "../lib/photon-approval";
import { agentcashPhotonProgress } from "../lib/agentcash-photon-progress";
import {
  activatePhotonApproval,
  claimCurrentPhotonApprovalDecision,
  claimPhotonApprovalEvent,
  clearPhotonApproval,
  completePhotonApprovalDecision,
  failPhotonApprovalDecision,
  getCurrentPhotonApprovalActivity,
  getPhotonApprovalView,
  hasCurrentPhotonApproval,
  releasePhotonApprovalProcessing,
  savePhotonApproval,
  type PhotonApprovalProcessingRelease,
} from "../lib/photon-approval-store.js";
import { photonAuth, photonPrincipalId } from "../lib/photon-auth";
import {
  assignPhotonIngress,
  createPhotonCompletionReceipt,
  createPhotonDispatchReceipt,
  createPhotonIngressReceipt,
  createPhotonResponseDeliveryReceipt,
  markPhotonDispatchAccepted,
  markPhotonResponseDelivery,
  photonIngressAuthAttributes,
  photonIngressIdFromAuth,
  quarantinePhotonDispatch,
  readPhotonIngressReceipt,
  readPhotonDispatchReceipt,
  readPhotonResponseDeliveryReceipt,
  type PhotonIngressReceipt,
} from "../lib/photon-ingress-store";
import {
  claimPhotonHeldAlertReply,
  classifyPhotonAlertReply,
  holdPhotonAlertReply,
  parsePhotonHeldReplyChoice,
  readActivePhotonHeldReply,
  readRecentPhotonAlerts,
} from "../lib/photon-alert-reply-store";
import {
  OwnerIdentityDeniedError,
  requirePhotonOwnerAccess,
  resolvePhotonOwnerConversationIdentity,
} from "../lib/owner-identity";
import {
  photonArtifactPresentation,
  photonApprovalAppUrl,
  photonWorkspaceAppUrl,
} from "../lib/photon-mini-app";
import {
  consumePhotonPendingAlertContext,
  getPhotonWorkspaceState,
  mintPhotonWorkspaceManager,
  savePhotonWorkspaceSession,
  selectPhotonWorkspace,
  type PhotonWorkspace,
  type PhotonWorkspaceState,
} from "../lib/photon-workspace-store";
import {
  isPhotonSessionManagerRequest,
  photonApprovalWorkspace,
  photonLegacyMonitoringContext,
  photonWorkspaceContext,
  photonWorkspaceThread,
  parsePhotonWorkspaceThreadId,
  physicalPhotonThreadId,
  workspaceAwarePhotonAdapter,
} from "../lib/photon-workspace";
import { projectPhotonWorkspaceRuntimeScope } from "../lib/workspace-runtime-scope";
import { workspaceAlertTurnContext } from "../lib/workspace-alert-presentation";
import { readWorkspaceAlertById } from "../lib/workspace-alert-store";
import { createPhotonImessageAdapter } from "../lib/photon-imessage-adapter";
import { isPhotonContentlessOutboundControlEcho } from "../lib/photon-imessage-ingress";
import {
  PhotonIngressRolloutError,
  resolvePhotonIngressRolloutMode,
} from "../lib/photon-ingress-rollout";
import { authorizePhotonWorkspaceControlPlaneStore } from "../lib/workspace-store-authorization";

const imessageAdapter = createPhotonImessageAdapter();
const routedImessageAdapter = workspaceAwarePhotonAdapter(imessageAdapter);

async function completePhotonDispatchReceipt(
  ctx: SessionContext,
  outcome: "cancelled" | "completed" | "failed",
): Promise<void> {
  const ingressId = photonIngressIdFromAuth(ctx.session.auth.current);
  if (!ingressId) return;
  const dispatch = await readPhotonDispatchReceipt(ingressId);
  if (!dispatch) return;
  await createPhotonCompletionReceipt({ dispatch, outcome });
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
  _workspaceName: string | null,
  text: string,
): string {
  return text;
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
    async "action.result"(data, channel, ctx) {
      if (
        !channel.thread ||
        data.result.kind !== "tool-result" ||
        data.result.toolName !== "agentcash_fetch" ||
        data.result.isError === true
      ) {
        return;
      }
      const progress = agentcashPhotonProgress(data.result.output);
      const principalId = ctx.session.auth.current?.principalId;
      if (!progress || !principalId?.startsWith("imessage:")) return;
      const eventId = `agentcash-progress:${ctx.session.id}:${data.result.callId}:${progress.id}`;
      const deliveryId = `agentcash_progress_${createHash("sha256")
        .update(eventId)
        .digest("hex")}`;
      try {
        const workspaceName = await photonWorkspaceResponseName({
          principalId,
          sessionId: ctx.session.id,
          threadId: channel.thread.id,
        });
        const responseText = photonWorkspaceLabeledText(
          workspaceName,
          progress.message,
        );
        const delivery = await createPhotonResponseDeliveryReceipt({
          content: responseText,
          destination: physicalPhotonThreadId(channel.thread.id),
          ingressId: deliveryId,
        });
        if (!delivery.created && delivery.record.state !== "staged") {
          if (delivery.record.state === "delivering") {
            await markPhotonResponseDelivery({
              failureCode: "agentcash_progress_delivery_uncertain",
              ingressId: deliveryId,
              state: "delivery_uncertain",
            });
          }
          return;
        }
        await markPhotonResponseDelivery({
          ingressId: deliveryId,
          state: "delivering",
        });
        try {
          await channel.thread.post(responseText);
          await markPhotonResponseDelivery({
            ingressId: deliveryId,
            state: "delivered",
          });
        } catch (error) {
          await markPhotonResponseDelivery({
            failureCode: "agentcash_progress_delivery_uncertain",
            ingressId: deliveryId,
            state: "delivery_uncertain",
          }).catch(() => undefined);
          throw error;
        }
        console.info("[photon.agentcash] Progress delivered", {
          call_id: data.result.callId,
          progress_id: progress.id,
          session_id: ctx.session.id,
        });
      } catch (error) {
        console.warn("[photon.agentcash] Progress delivery failed", {
          call_id: data.result.callId,
          error_type: error instanceof Error ? error.name : typeof error,
          progress_id: progress.id,
          session_id: ctx.session.id,
        });
      }
    },
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
      const artifact = photonArtifactPresentation(data.message);
      const responseText = photonWorkspaceLabeledText(
        workspaceName,
        artifact?.message ?? data.message,
      );
      const ingressId = photonIngressIdFromAuth(ctx.session.auth.current);
      if (ingressId) {
        const delivery = await createPhotonResponseDeliveryReceipt({
          content: responseText,
          destination: physicalPhotonThreadId(channel.thread.id),
          ingressId,
        });
        if (!delivery.created) {
          if (delivery.record.state === "delivering") {
            await markPhotonResponseDelivery({
              failureCode: "response_delivery_uncertain",
              ingressId,
              state: "delivery_uncertain",
            });
          }
          return;
        }
        await markPhotonResponseDelivery({ ingressId, state: "delivering" });
      }
      try {
        await channel.thread.post({ markdown: responseText });
        if (ingressId) {
          await markPhotonResponseDelivery({ ingressId, state: "delivered" });
        }
      } catch (error) {
        if (ingressId) {
          await markPhotonResponseDelivery({
            failureCode: "response_delivery_uncertain",
            ingressId,
            state: "delivery_uncertain",
          }).catch(() => undefined);
        }
        throw error;
      }
      if (artifact) {
        try {
          await imessageAdapter.sendMiniApp(
            physicalPhotonThreadId(channel.thread.id),
            artifact.url,
          );
        } catch (error) {
          console.warn("[photon.artifact] Mini-app delivery failed", {
            error_type: error instanceof Error ? error.name : typeof error,
            session_id: ctx.session.id,
          });
        }
      }
    },
    async "turn.failed"(data, channel, ctx) {
      await completePhotonDispatchReceipt(ctx, "failed");
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
      await completePhotonDispatchReceipt(ctx, "completed");
      const principalId = ctx.session.auth.current?.principalId;
      const workspaceName =
        principalId && channel.thread
          ? await photonWorkspaceResponseName({
              principalId,
              sessionId: ctx.session.id,
              threadId: channel.thread.id,
            })
          : null;
      // Capture approval activity before releasing a settled Coinbase guard.
      // Releasing removes the active approval pointer; checking only afterward
      // can misclassify the approval-card turn as silent and post a false
      // "nothing changed" fallback while its continuation is still running.
      const approvalWasActive =
        principalId && channel.thread
          ? await hasCurrentPhotonApproval({
              principalId,
              threadId: channel.thread.id,
            })
          : false;
      const release = await releaseApprovedOrderGuard(ctx.session.id);
      if (release === "retained" && channel.thread) {
        await channel.thread.post(
          photonWorkspaceLabeledText(
            workspaceName,
            "The Coinbase order status is not safely settled. Check Coinbase before trying another order; new orders remain blocked for safety.",
          ),
        );
        return;
      }

      // A turn can finish having produced no assistant message at all - an empty
      // model response, or a loop that ended on a tool-call boundary. The
      // message.completed handler has nothing to post in that case and returns
      // silently, so the conversation simply stops answering with no error
      // anywhere. A tool failure must never cost Eve the ability to reply.
      const ingressId = photonIngressIdFromAuth(ctx.session.auth.current);
      if (!channel.thread || !ingressId || !principalId) return;
      if (await readPhotonResponseDeliveryReceipt(ingressId)) return;
      // An approval card is a reply; it just isn't delivered through
      // message.completed. Parking for one is not silence.
      if (
        approvalWasActive ||
        (await hasCurrentPhotonApproval({
          principalId,
          threadId: channel.thread.id,
        }))
      ) {
        return;
      }

      console.error("[photon.turn] Turn completed without delivering a reply", {
        session_id: ctx.session.id,
      });
      // "no order was placed" is only safe to assert when this turn processed no
      // approved order at all (`release === "missing"`). A cleanly released guard
      // (`release === "released"`) means an approved order reached a terminal
      // state this turn - it may have SUCCEEDED - so we must not tell the owner
      // nothing happened and risk a duplicate resubmission.
      const notice = photonWorkspaceLabeledText(
        workspaceName,
        release === "released"
          ? "I couldn't put a reply together for that one. If you just approved an order, check Coinbase for its status before retrying. Reply `new session` if I keep coming up empty and I'll start with a clean slate."
          : "I couldn't put a reply together for that one. Nothing was changed and no order was placed. Try sending it again - and if I keep coming up empty, reply `new session` and I'll start with a clean slate.",
      );
      const delivery = await createPhotonResponseDeliveryReceipt({
        content: notice,
        destination: physicalPhotonThreadId(channel.thread.id),
        ingressId,
      });
      if (!delivery.created) return;
      await markPhotonResponseDelivery({ ingressId, state: "delivering" });
      try {
        await channel.thread.post({ markdown: notice });
        await markPhotonResponseDelivery({ ingressId, state: "delivered" });
      } catch (error) {
        await markPhotonResponseDelivery({
          failureCode: "response_delivery_uncertain",
          ingressId,
          state: "delivery_uncertain",
        }).catch(() => undefined);
        throw error;
      }
    },
    async "turn.cancelled"(_data, channel, ctx) {
      await completePhotonDispatchReceipt(ctx, "cancelled");
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
          "This session failed and did not complete its request. Eve will not retry it automatically.",
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
            "Connection authorized. Continuing your request.",
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
            "I couldn't bind this approval to the active session. The action was denied; ask again from the intended session.",
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
            "The session changed or could not be verified before this approval opened. The action was denied; ask again from the intended active session.",
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
    workspace =
      photonApprovalWorkspace(state, claim.delivery) ?? undefined;
  } catch {
    // The approval is failed below before any response reaches Eve.
  }
  if (!workspace) {
    await failPhotonApprovalDecision({
      decision: claim.delivery.decision,
      recordKey: claim.delivery.recordKey,
    }).catch(() => undefined);
    await thread.post(
      "I couldn't match that approval to its session. No action was authorized; ask Eve to prepare it again.",
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
    const runtimeScope = resolvePhotonIngressRolloutMode() === "durable"
      ? projectPhotonWorkspaceRuntimeScope({
          generation: workspace.generation,
          principalId,
          threadId: thread.id,
          workspaceId: workspace.id,
        })
      : undefined;
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
        auth: photonAuth(senderId, thread.id, runtimeScope),
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

async function openPhotonSessionManager(input: {
  senderId: string;
  thread: Thread;
}): Promise<void> {
  const scope = {
    principalId: photonPrincipalId(input.senderId),
    threadId: input.thread.id,
  };
  try {
    const manager = await mintPhotonWorkspaceManager(scope);
    await imessageAdapter.sendMiniApp(
      input.thread.id,
      photonWorkspaceAppUrl(manager.managerToken),
    );
  } catch (error) {
    console.warn("[photon.workspace] Session manager delivery failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await input.thread
      .post("I couldn't open the session manager. Please try again.")
      .catch(() => undefined);
  }
}

async function dispatchPhotonWorkspaceTurn(input: {
  alertContext?: string;
  ingress: PhotonIngressReceipt;
  messageContent: ReturnType<typeof messageToUserContent> | string;
  principalId: string;
  reason: "confirmed_held_reply" | "discuss_action" | "selected_workspace";
  senderId: string;
  thread: Thread;
  workspaceState: PhotonWorkspaceState;
}): Promise<void> {
  const activeWorkspace = input.workspaceState.activeWorkspace;
  const runtimeScope = projectPhotonWorkspaceRuntimeScope({
    generation: activeWorkspace.generation,
    principalId: input.principalId,
    threadId: input.thread.id,
    workspaceId: activeWorkspace.id,
  });
  const assignment = await assignPhotonIngress({
    generation: activeWorkspace.generation,
    ingress: input.ingress,
    reason: input.reason,
    routingRevision: input.workspaceState.revision,
    workspaceId: activeWorkspace.id,
  });
  const dispatchReceipt = await createPhotonDispatchReceipt({
    assignment,
    continuationTarget: `${input.thread.id}\0${activeWorkspace.id}\0${activeWorkspace.generation}`,
  });
  if (!dispatchReceipt.created) return;
  let session;
  try {
    session = await bridge.send(
      {
        context: [
          photonWorkspaceContext(activeWorkspace),
          ...(input.alertContext ? [input.alertContext] : []),
        ],
        message: input.messageContent,
      },
      {
        auth: photonAuth(
          input.senderId,
          input.thread.id,
          runtimeScope,
          {
            ...photonIngressAuthAttributes(input.ingress),
            photon_routing_revision: String(input.workspaceState.revision),
          },
        ),
        thread: photonWorkspaceThread(input.thread, activeWorkspace),
        turnPolicy: "steer",
      },
    );
    await markPhotonDispatchAccepted({
      ingressId: input.ingress.ingressId,
      sessionId: session.id,
    });
  } catch (error) {
    await quarantinePhotonDispatch({
      failureCode: "model_dispatch_uncertain",
      ingressId: input.ingress.ingressId,
      quarantineReason: "manual_reconciliation_required",
    }).catch(() => undefined);
    throw error;
  }
  await savePhotonWorkspaceSession({
    generation: activeWorkspace.generation,
    principalId: input.principalId,
    sessionId: session.id,
    threadId: input.thread.id,
    workspaceId: activeWorkspace.id,
  }).catch((error: unknown) => {
    console.error("[photon.workspace] Session binding update failed", {
      error_type: error instanceof Error ? error.name : typeof error,
      session_id: session.id,
    });
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
  if (
    message.author.isBot ||
    message.author.isMe ||
    isPhotonContentlessOutboundControlEcho(message) ||
    !thread.isDM
  ) {
    return;
  }

  const senderId = message.author.userId;
  const principalId = photonPrincipalId(senderId);
  const textDecision = parsePhotonTextDecision(message.text);
  let rolloutMode;
  try {
    rolloutMode = resolvePhotonIngressRolloutMode();
  } catch (error) {
    if (!(error instanceof PhotonIngressRolloutError)) throw error;
    await thread.post("Eve's iMessage rollout configuration is incomplete. No message was sent.");
    return;
  }
  if (rolloutMode === "durable") {
    try {
      requirePhotonOwnerAccess({ principalId, resource: "session" });
    } catch (error) {
      if (!(error instanceof OwnerIdentityDeniedError)) throw error;
      await thread.post("This iMessage identity is not authorized to use Eve.");
      return;
    }
  }
  const ingressIdentity = rolloutMode === "durable"
    ? resolvePhotonOwnerConversationIdentity({
        principalId,
        threadId: thread.id,
      })
    : null;
  const ingressCreation = ingressIdentity
    ? await createPhotonIngressReceipt({
        classification:
          textDecision || isPhotonApprovalAlias(message.text)
            ? "approval_reply"
            : isPhotonSessionManagerRequest(message.text)
              ? "session_management"
              : "ordinary",
        conversationId: ingressIdentity.conversationId,
        eventId: message.id,
        ownerId: ingressIdentity.ownerId,
      })
    : null;
  if (ingressCreation && !ingressCreation.created) return;
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

  if (isPhotonSessionManagerRequest(message.text)) {
    await openPhotonSessionManager({ senderId, thread });
    return;
  }

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
      "I couldn't verify the active session, so this message was not sent. Please try again.",
    );
    return;
  }

  if (rolloutMode === "legacy") {
    const activeWorkspace = workspaceState.activeWorkspace;
    const session = await bridge.send(
      {
        context: [
          photonWorkspaceContext(activeWorkspace),
          photonLegacyMonitoringContext(),
        ],
        message: messageToUserContent(message),
      },
      {
        auth: photonAuth(senderId, thread.id),
        thread: photonWorkspaceThread(thread, activeWorkspace),
        turnPolicy: "steer",
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
    return;
  }
  if (!ingressIdentity || !ingressCreation) {
    throw new PhotonIngressRolloutError();
  }

  const held = await readActivePhotonHeldReply(ingressIdentity.conversationId);
  if (held) {
    const choice = parsePhotonHeldReplyChoice(message.text, held);
    if (choice) {
      if (workspaceState.revision !== held.routingRevision) {
        await thread.post("The session selection changed, so that alert reply was not routed. Please send it again.");
        return;
      }
      const claimed = await claimPhotonHeldAlertReply({ choice, ingressId: held.ingressId });
      if (!claimed?.assignedWorkspaceId) return;
      if (workspaceState.activeWorkspace.id !== claimed.assignedWorkspaceId) {
        workspaceState = await selectPhotonWorkspace({
          expectedRevision: workspaceState.revision,
          principalId,
          threadId: thread.id,
          workspaceId: claimed.assignedWorkspaceId,
        });
      }
      const heldIngress = await readPhotonIngressReceipt(claimed.ingressId);
      if (!heldIngress) {
        await thread.post("I couldn't recover that held reply, so it was not sent. Please send it again.");
        return;
      }
      await dispatchPhotonWorkspaceTurn({
        ingress: heldIngress,
        messageContent: claimed.messageText,
        principalId,
        reason: "confirmed_held_reply",
        senderId,
        thread,
        workspaceState,
      });
      await thread.post(`Continuing in ${workspaceState.activeWorkspace.name}.`).catch(() => undefined);
      return;
    }
  }

  const recentAlerts = await readRecentPhotonAlerts(ingressIdentity.conversationId);
  const alertReply = classifyPhotonAlertReply({
    candidates: recentAlerts,
    messageText: message.text,
    selectedWorkspaceId: workspaceState.activeWorkspace.id,
  });
  if (alertReply) {
    await holdPhotonAlertReply({
      candidateAlertId: alertReply.alertId,
      candidateWorkspaceId: alertReply.workspaceId,
      candidateWorkspaceName: alertReply.workspaceName,
      conversationId: ingressIdentity.conversationId,
      ingressId: ingressCreation.record.ingressId,
      messageText: message.text,
      ownerId: ingressIdentity.ownerId,
      routingRevision: workspaceState.revision,
      selectedWorkspaceId: workspaceState.activeWorkspace.id,
      selectedWorkspaceName: workspaceState.activeWorkspace.name,
    });
    await thread.post(
      `That looks related to the ${alertReply.workspaceName} alert. Reply “use ${alertReply.workspaceName}” to switch and send it there, or “stay in ${workspaceState.activeWorkspace.name}” to keep the current session.`,
    );
    return;
  }

  let alertContext: string | undefined;
  try {
    const pending = await consumePhotonPendingAlertContext({
      principalId,
      threadId: thread.id,
      workspaceId: workspaceState.activeWorkspace.id,
    });
    workspaceState = pending.state;
    if (pending.context) {
      const alertScope = authorizePhotonWorkspaceControlPlaneStore({
        principalId,
        resource: "alert",
        workspaceId: pending.context.workspaceId,
      });
      const alert = await readWorkspaceAlertById(alertScope, pending.context.alertId);
      if (!alert || alert.findingId !== pending.context.findingId) {
        throw new Error("pending_alert_unavailable");
      }
      alertContext = workspaceAlertTurnContext({
        ...alert,
        workspaceName: workspaceState.activeWorkspace.name,
      });
    }
  } catch (error) {
    console.error("[photon.alert] Pending context resolution failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    await thread.post(
      "I couldn't verify that alert context, so this message was not sent. Please try again.",
    );
    return;
  }

  const activeWorkspace = workspaceState.activeWorkspace;
  const ingress = ingressCreation.record;
  await dispatchPhotonWorkspaceTurn({
    ...(alertContext ? { alertContext } : {}),
    ingress,
    messageContent: messageToUserContent(message),
    principalId,
    reason: alertContext ? "discuss_action" : "selected_workspace",
    senderId,
    thread,
    workspaceState,
  });
}

bridge.bot.onDirectMessage(dispatch);
bridge.bot.onNewMessage(/[\s\S]*/u, dispatch);

export const photonBot = bridge.bot;
export const photon = bridge.channel;
export default bridge.channel;
