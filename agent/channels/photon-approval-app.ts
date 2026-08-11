import { randomBytes } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import {
  claimPhotonApprovalDecision,
  completePhotonApprovalDecision,
  failPhotonApprovalDecision,
  getPhotonApprovalView,
  type PhotonApprovalDelivery,
} from "../lib/photon-approval-store";
import { photonAuth, photonSenderId } from "../lib/photon-auth";
import { PHOTON_APPROVAL_APP_PATH } from "../lib/photon-mini-app";
import { getPhotonWorkspaceState } from "../lib/photon-workspace-store";

const requestSchema = z.object({
  approvalToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
const decisionRequestSchema = requestSchema.extend({
  decision: z.enum(["approve", "deny"]),
});

type AttachSession = (sessionId: string) => {
  respond(
    inputResponses: readonly { optionId: string; requestId: string }[],
    options: { auth: ReturnType<typeof photonAuth> },
  ): Promise<
    | { sessionId: string; status: "accepted" }
    | { status: "session_not_active" }
  >;
};

function responseHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store, max-age=0",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: responseHeaders("application/json; charset=utf-8"),
    status,
  });
}

async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > 1_024) {
    return json({ error: "Request too large." }, 413);
  }
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return json({ error: "Expected JSON." }, 415);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Origin not allowed." }, 403);
  }
  try {
    const body = await request.text();
    if (body.length > 1_024) {
      return json({ error: "Request too large." }, 413);
    }
    return schema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
}

async function deliverApproval(
  delivery: PhotonApprovalDelivery,
  attachSession: AttachSession,
): Promise<"accepted" | "uncertain"> {
  const senderId = photonSenderId(delivery.principalId);
  if (!senderId) {
    throw new Error("The Photon approval identity is unavailable.");
  }
  let result;
  try {
    result = await attachSession(delivery.sessionId).respond(
      [
        {
          optionId: delivery.decision,
          requestId: delivery.requestId,
        },
      ],
      {
        auth: photonAuth(senderId, delivery.threadId),
      },
    );
  } catch (error) {
    console.error("[photon.approval] Approval delivery failed", {
      decision: delivery.decision,
      error_type: error instanceof Error ? error.name : typeof error,
      request_id: delivery.requestId,
      session_id: delivery.sessionId,
      tool_name: delivery.toolName,
    });
    if (delivery.decision === "deny") {
      await failPhotonApprovalDecision({
        decision: delivery.decision,
        recordKey: delivery.recordKey,
      }).catch(() => undefined);
    }
    return "uncertain";
  }
  if (result.status !== "accepted") {
    console.warn("[photon.approval] Approval target session is inactive", {
      decision: delivery.decision,
      request_id: delivery.requestId,
      session_id: delivery.sessionId,
      tool_name: delivery.toolName,
    });
    await failPhotonApprovalDecision({
      decision: delivery.decision,
      recordKey: delivery.recordKey,
    }).catch(() => undefined);
    return "uncertain";
  }
  try {
    await completePhotonApprovalDecision({
      decision: delivery.decision,
      recordKey: delivery.recordKey,
    });
  } catch (error) {
    if (delivery.decision === "deny") {
      await failPhotonApprovalDecision({
        decision: delivery.decision,
        recordKey: delivery.recordKey,
      }).catch(() => undefined);
    }
    console.error("[photon.approval] Approval completion failed", {
      decision: delivery.decision,
      error_type: error instanceof Error ? error.name : typeof error,
      request_id: delivery.requestId,
      session_id: delivery.sessionId,
      tool_name: delivery.toolName,
    });
    return "uncertain";
  }
  console.info("[photon.approval] Approval decision delivered", {
    decision: delivery.decision,
    expired: delivery.expired,
    request_id: delivery.requestId,
    session_id: delivery.sessionId,
    tool_name: delivery.toolName,
  });
  return "accepted";
}

async function approvalWorkspaceIsActive(
  delivery: PhotonApprovalDelivery,
): Promise<boolean> {
  try {
    const state = await getPhotonWorkspaceState({
      principalId: delivery.principalId,
      threadId: delivery.threadId,
    });
    const workspace =
      delivery.workspaceId && delivery.workspaceGeneration
        ? state.workspaces.find(
            (candidate) =>
              candidate.id === delivery.workspaceId &&
              candidate.generation === delivery.workspaceGeneration,
          )
        : state.workspaces.find(
            (candidate) => candidate.sessionId === delivery.sessionId,
          );
    if (workspace) {
      return (
        workspace.status === "active" &&
        workspace.id === state.activeWorkspace.id
      );
    }
    return (
      !delivery.workspaceId &&
      state.activeWorkspace.continuation === "physical"
    );
  } catch {
    return false;
  }
}

function approvalHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta property="og:title" content="Eve order approval">
  <meta property="og:description" content="Review an order and choose Approve or Deny.">
  <title>Eve order approval</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      background: Canvas;
      color: CanvasText;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      padding: max(20px, env(safe-area-inset-top)) 20px max(20px, env(safe-area-inset-bottom));
      background: Canvas;
    }
    main {
      width: min(100%, 460px);
      display: grid;
      gap: 20px;
    }
    .eyebrow {
      margin: 0;
      color: GrayText;
      font-size: 13px;
      font-weight: 650;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 6px 0 0;
      font-size: clamp(25px, 7vw, 34px);
      line-height: 1.12;
      letter-spacing: -.025em;
    }
    #status {
      margin: 0;
      color: GrayText;
      font-size: 15px;
      line-height: 1.45;
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    button {
      min-height: 52px;
      border: 0;
      border-radius: 14px;
      font: inherit;
      font-size: 17px;
      font-weight: 650;
      cursor: pointer;
    }
    button:disabled { cursor: default; opacity: .55; }
    #approve {
      background: #1677ff;
      color: white;
    }
    #deny {
      background: color-mix(in srgb, CanvasText 10%, Canvas);
      color: CanvasText;
    }
    .hidden { display: none; }
    @media (prefers-reduced-motion: no-preference) {
      button { transition: opacity 120ms ease, transform 120ms ease; }
      button:active:not(:disabled) { transform: scale(.98); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Eve · Coinbase</p>
      <h1 id="summary">Opening approval…</h1>
    </header>
    <p id="status" role="status" aria-live="polite">Verifying this request.</p>
    <div class="actions hidden" id="actions">
      <button id="deny" type="button">Deny</button>
      <button id="approve" type="button">Approve</button>
    </div>
  </main>
  <script nonce="${nonce}">
    (() => {
      const token = location.hash.slice(1);
      const summary = document.querySelector("#summary");
      const status = document.querySelector("#status");
      const actions = document.querySelector("#actions");
      const approve = document.querySelector("#approve");
      const deny = document.querySelector("#deny");
      let settled = false;

      const showFinal = (title, detail) => {
        settled = true;
        summary.textContent = title;
        status.textContent = detail;
        actions.classList.add("hidden");
      };

      const request = async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || "Request failed.");
        return payload;
      };

      const load = async () => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
          showFinal("Approval unavailable", "Ask Eve to prepare the order again.");
          return;
        }
        try {
          const view = await request("${PHOTON_APPROVAL_APP_PATH}/state", {
            approvalToken: token,
          });
          if (view.approvalText) summary.textContent = view.approvalText;
          if (view.status === "active") {
            status.textContent = "This exact order is ready for your decision.";
            actions.classList.remove("hidden");
            return;
          }
          if (view.status === "opening" || view.status === "processing") {
            status.textContent =
              view.status === "opening"
                ? "Opening the secure approval…"
                : "Confirming your choice…";
            setTimeout(load, 500);
            return;
          }
          if (view.status === "approved") {
            showFinal("Order approved", "Eve is continuing the order.");
            return;
          }
          if (view.status === "denied") {
            showFinal("Order denied", "No order will be placed.");
            return;
          }
          if (view.status === "expired") {
            await decide("deny");
            return;
          }
          if (view.status === "unavailable") {
            showFinal(
              "Approval unavailable",
              "This order session ended. Ask Eve to prepare the order again.",
            );
            return;
          }
          showFinal("Approval unavailable", "Ask Eve to prepare the order again.");
        } catch (error) {
          status.textContent =
            error instanceof Error ? error.message : "Could not load approval.";
        }
      };

      const decide = async (decision) => {
        if (settled) return;
        approve.disabled = true;
        deny.disabled = true;
        status.textContent = "Confirming your choice…";
        try {
          const result = await request("${PHOTON_APPROVAL_APP_PATH}/decision", {
            approvalToken: token,
            decision,
          });
          if (result.status === "expired") {
            showFinal("Approval expired", "No order was authorized.");
          } else if (result.status === "uncertain") {
            showFinal(
              "Approval status uncertain",
              "Check Coinbase before retrying this order.",
            );
          } else if (result.status === "approved") {
            showFinal("Order approved", "Eve is continuing the order.");
          } else {
            showFinal("Order denied", "No order will be placed.");
          }
        } catch (error) {
          showFinal(
            "Approval status uncertain",
            error instanceof Error
              ? error.message + " Check Coinbase before starting another order."
              : "Could not confirm. Check Coinbase before starting another order.",
          );
        }
      };

      approve.addEventListener("click", () => decide("approve"));
      deny.addEventListener("click", () => decide("deny"));
      void load();
    })();
  </script>
</body>
</html>`;
}

export default defineChannel({
  routes: [
    GET(PHOTON_APPROVAL_APP_PATH, async () => {
      const nonce = randomBytes(18).toString("base64url");
      const headers = responseHeaders("text/html; charset=utf-8");
      headers["content-security-policy"] =
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`;
      return new Response(approvalHtml(nonce), { headers });
    }),
    POST(
      `${PHOTON_APPROVAL_APP_PATH}/state`,
      async (request) => {
        const body = await readJson(request, requestSchema);
        if (body instanceof Response) return body;
        const view = await getPhotonApprovalView(body.approvalToken);
        if (view.status === "delivered") {
          return json({
            approvalText: view.approvalText,
            status: view.decision === "approve" ? "approved" : "denied",
          });
        }
        return json(view);
      },
    ),
    POST(
      `${PHOTON_APPROVAL_APP_PATH}/decision`,
      async (request, { attachSession }) => {
        const body = await readJson(request, decisionRequestSchema);
        if (body instanceof Response) return body;
        const claim = await claimPhotonApprovalDecision(body);
        if (claim.status === "delivered") {
          return json({
            status: claim.decision === "approve" ? "approved" : "denied",
          });
        }
        if (claim.status === "conflict") {
          return json(
            { error: "The other choice is already being confirmed." },
            409,
          );
        }
        if (claim.status === "processing") {
          return json({ status: "uncertain" });
        }
        if (claim.status === "unavailable") {
          return json({ error: "Approval is still opening. Try again." }, 425);
        }
        if (claim.status === "forbidden") {
          return json({ error: "Approval not allowed." }, 403);
        }
        if (claim.status !== "deliver") {
          return json(
            { error: "This approval is no longer available." },
            410,
          );
        }

        if (!(await approvalWorkspaceIsActive(claim.delivery))) {
          await failPhotonApprovalDecision({
            decision: claim.delivery.decision,
            recordKey: claim.delivery.recordKey,
          }).catch(() => undefined);
          return json(
            {
              error:
                "The workspace that requested this approval is no longer active. No action was authorized.",
            },
            409,
          );
        }

        try {
          const result = await deliverApproval(
            claim.delivery,
            attachSession,
          );
          if (result === "uncertain") return json({ status: "uncertain" });
        } catch {
          return json(
            { error: "Eve could not confirm that choice yet." },
            503,
          );
        }
        return json({
          status: claim.delivery.expired
            ? "expired"
            : claim.delivery.decision === "approve"
              ? "approved"
              : "denied",
        });
      },
    ),
  ],
});
