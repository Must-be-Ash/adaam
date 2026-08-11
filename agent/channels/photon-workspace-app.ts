import { randomBytes } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import { getCurrentPhotonApprovalActivity } from "../lib/photon-approval-store";
import { PHOTON_WORKSPACE_APP_PATH } from "../lib/photon-mini-app";
import {
  applyPhotonWorkspaceManagerAction,
  getPhotonWorkspaceManagerScope,
  getPhotonWorkspaceManagerState,
  PhotonWorkspaceApprovalBlockedError,
  PhotonWorkspaceConflictError,
  PhotonWorkspaceValidationError,
  type PhotonWorkspaceAction,
  type PhotonWorkspaceState,
} from "../lib/photon-workspace-store";

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const workspaceIdSchema = z.string().uuid();
const stateRequestSchema = z.object({
  managerToken: tokenSchema,
});
const actionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("archive"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    replacementWorkspaceId: workspaceIdSchema.optional(),
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("create"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    name: z.string().min(1).max(80),
    select: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("rename"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    name: z.string().min(1).max(80),
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("restore"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("select"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("start-fresh"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    workspaceId: workspaceIdSchema,
  }),
]);

type AttachSession = (sessionId: string) => {
  reset(options: { reason: string }): Promise<unknown>;
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
  if (!Number.isFinite(contentLength) || contentLength > 2_048) {
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
    if (body.length > 2_048) {
      return json({ error: "Request too large." }, 413);
    }
    return schema.parse(JSON.parse(body));
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
}

function publicState(state: PhotonWorkspaceState) {
  return {
    activeWorkspaceId: state.activeWorkspace.id,
    revision: state.revision,
    workspaces: state.workspaces.map((workspace) => ({
      generation: workspace.generation,
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
    })),
  };
}

async function resetRetiredSession(
  retiredSessionId: string | undefined,
  attachSession: AttachSession,
): Promise<boolean> {
  if (!retiredSessionId) return false;
  try {
    await attachSession(retiredSessionId).reset({
      reason: "The owner started a fresh Photon session.",
    });
    return true;
  } catch (error) {
    console.warn("[photon.workspace] Retired session cleanup failed", {
      error_type: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

function workspaceHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta property="og:title" content="Manage Eve Sessions">
  <meta property="og:description" content="Create and switch isolated Eve sessions.">
  <title>Manage Eve Sessions</title>
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
      padding: max(22px, env(safe-area-inset-top)) 18px max(28px, env(safe-area-inset-bottom));
      background: Canvas;
    }
    main {
      width: min(100%, 560px);
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .eyebrow {
      margin: 0;
      color: GrayText;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 { margin: 5px 0 0; font-size: 32px; letter-spacing: -.03em; }
    h2 { margin: 0; font-size: 18px; }
    #status, .note {
      margin: 0;
      color: GrayText;
      font-size: 14px;
      line-height: 1.45;
    }
    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
    }
    input, button {
      min-height: 44px;
      border-radius: 12px;
      font: inherit;
    }
    input {
      width: 100%;
      border: 1px solid color-mix(in srgb, CanvasText 18%, Canvas);
      padding: 0 13px;
      background: Canvas;
      color: CanvasText;
    }
    button {
      border: 0;
      padding: 0 14px;
      font-weight: 650;
      cursor: pointer;
      background: color-mix(in srgb, CanvasText 10%, Canvas);
      color: CanvasText;
    }
    button.primary { background: #1677ff; color: white; }
    button.danger { color: #d82c2c; }
    button:disabled { cursor: default; opacity: .45; }
    #workspaces { display: grid; gap: 11px; }
    .workspace {
      border: 1px solid color-mix(in srgb, CanvasText 13%, Canvas);
      border-radius: 16px;
      padding: 14px;
      display: grid;
      gap: 12px;
    }
    .workspace.active {
      border-color: color-mix(in srgb, #1677ff 65%, Canvas);
      background: color-mix(in srgb, #1677ff 7%, Canvas);
    }
    .workspace.archived { opacity: .72; }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .name { margin: 0; font-size: 17px; font-weight: 700; }
    .badge {
      border-radius: 999px;
      padding: 4px 8px;
      background: color-mix(in srgb, #1677ff 14%, Canvas);
      color: #1677ff;
      font-size: 12px;
      font-weight: 700;
    }
    .meta { margin: 2px 0 0; color: GrayText; font-size: 12px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .actions button { min-height: 38px; font-size: 14px; }
    @media (prefers-reduced-motion: no-preference) {
      button { transition: opacity 120ms ease, transform 120ms ease; }
      button:active:not(:disabled) { transform: scale(.98); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Eve · Control plane</p>
      <h1>Manage Sessions</h1>
    </header>
    <p id="status" role="status" aria-live="polite">Loading your sessions…</p>
    <section>
      <form id="create-form">
        <input id="new-name" maxlength="40" autocomplete="off" placeholder="New session name" aria-label="New session name">
        <button class="primary" type="submit">Create</button>
      </form>
    </section>
    <section>
      <div id="workspaces"></div>
    </section>
    <p class="note">Start fresh clears only that session's model history. Archive keeps it available for later and can be reversed.</p>
  </main>
  <script nonce="${nonce}">
    (() => {
      const token = location.hash.slice(1);
      const status = document.querySelector("#status");
      const list = document.querySelector("#workspaces");
      const form = document.querySelector("#create-form");
      const nameInput = document.querySelector("#new-name");
      let state = null;
      let busy = false;

      const request = async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const error = new Error(payload.error || "Request failed.");
          error.status = response.status;
          throw error;
        }
        return payload;
      };

      const button = (label, action, workspace, options = {}) => {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        if (options.primary) element.classList.add("primary");
        if (options.danger) element.classList.add("danger");
        element.disabled = busy || Boolean(options.disabled);
        element.addEventListener("click", () => void handle(action, workspace));
        return element;
      };

      const render = () => {
        list.replaceChildren();
        if (!state) return;
        for (const workspace of state.workspaces) {
          const card = document.createElement("article");
          const isActive = workspace.id === state.activeWorkspaceId;
          card.className =
            "workspace" + (isActive ? " active" : "") +
            (workspace.status === "archived" ? " archived" : "");

          const titleRow = document.createElement("div");
          titleRow.className = "title-row";
          const titleWrap = document.createElement("div");
          const title = document.createElement("p");
          title.className = "name";
          title.textContent = workspace.name;
          const meta = document.createElement("p");
          meta.className = "meta";
          meta.textContent =
            workspace.status === "archived"
              ? "Archived"
              : isActive
                ? "Current session"
                : "Available";
          titleWrap.append(title, meta);
          titleRow.append(titleWrap);
          if (isActive) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "Active";
            titleRow.append(badge);
          }

          const actions = document.createElement("div");
          actions.className = "actions";
          if (workspace.status === "archived") {
            actions.append(button("Restore", "restore", workspace));
          } else {
            if (!isActive) {
              actions.append(
                button("Switch here", "select", workspace, { primary: true }),
              );
            }
            actions.append(button("Rename", "rename", workspace));
            actions.append(button("Start fresh", "start-fresh", workspace));
            actions.append(
              button("Archive", "archive", workspace, {
                danger: true,
                disabled: isActive,
              }),
            );
          }
          card.append(titleRow, actions);
          list.append(card);
        }
      };

      const load = async () => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
          status.textContent = "This session manager link is unavailable. Ask Eve to open it again.";
          form.hidden = true;
          return;
        }
        try {
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/state", {
            managerToken: token,
          });
          status.textContent =
            "Active session: " +
            state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId).name;
          render();
        } catch (error) {
          status.textContent =
            error instanceof Error ? error.message : "Could not load sessions.";
        }
      };

      const mutate = async (action) => {
        if (!state || busy) return;
        busy = true;
        render();
        status.textContent = "Updating sessions…";
        try {
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/action", {
            ...action,
            expectedRevision: state.revision,
            managerToken: token,
          });
          status.textContent = state.cleanupPending
            ? "Fresh routing is active, but cleanup of the prior session could not be confirmed."
            : "Active session: " +
              state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId).name;
        } catch (error) {
          status.textContent =
            error instanceof Error ? error.message : "Could not update sessions.";
          if (error && error.status === 409) await load();
        } finally {
          busy = false;
          render();
        }
      };

      const handle = async (action, workspace) => {
        if (action === "rename") {
          const name = prompt("Rename session", workspace.name);
          if (!name || name === workspace.name) return;
          await mutate({ action, name, workspaceId: workspace.id });
          return;
        }
        if (action === "start-fresh") {
          if (!confirm("Clear model history for “" + workspace.name + "”? The session name is retained.")) return;
        }
        if (action === "archive") {
          if (!confirm("Archive “" + workspace.name + "”?")) return;
        }
        await mutate({ action, workspaceId: workspace.id });
      };

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        await mutate({ action: "create", name, select: true });
        nameInput.value = "";
      });

      void load();
    })();
  </script>
</body>
</html>`;
}

export default defineChannel({
  routes: [
    GET(PHOTON_WORKSPACE_APP_PATH, async () => {
      const nonce = randomBytes(18).toString("base64url");
      const headers = responseHeaders("text/html; charset=utf-8");
      headers["content-security-policy"] =
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`;
      return new Response(workspaceHtml(nonce), { headers });
    }),
    POST(`${PHOTON_WORKSPACE_APP_PATH}/state`, async (request) => {
      const body = await readJson(request, stateRequestSchema);
      if (body instanceof Response) return body;
      const state = await getPhotonWorkspaceManagerState(body.managerToken);
      return state
        ? json(publicState(state))
        : json({ error: "This session manager link expired." }, 410);
    }),
    POST(
      `${PHOTON_WORKSPACE_APP_PATH}/action`,
      async (request, { attachSession }) => {
        const body = await readJson(request, actionRequestSchema);
        if (body instanceof Response) return body;
        const scope = await getPhotonWorkspaceManagerScope(body.managerToken);
        if (!scope) {
          return json({ error: "This session manager link expired." }, 410);
        }
        const approvalActivity =
          await getCurrentPhotonApprovalActivity(scope).catch(() => "active");
        if (approvalActivity) {
          return json(
            {
              error:
                "Finish or cancel the pending financial approval before changing sessions.",
            },
            409,
          );
        }
        const { managerToken: _managerToken, ...action } = body;
        try {
          const result = await applyPhotonWorkspaceManagerAction(
            body.managerToken,
            action as PhotonWorkspaceAction,
          );
          if (!result) {
            return json({ error: "This session manager link expired." }, 410);
          }
          const retired =
            body.action === "start-fresh"
              ? await resetRetiredSession(
                  result.retiredSessionId,
                  attachSession,
                )
              : true;
          return json({
            ...publicState(result.state),
            ...(!retired ? { cleanupPending: true } : {}),
          });
        } catch (error) {
          if (
            error instanceof PhotonWorkspaceApprovalBlockedError ||
            error instanceof PhotonWorkspaceConflictError
          ) {
            return json({ error: error.message }, 409);
          }
          if (error instanceof PhotonWorkspaceValidationError) {
            return json({ error: error.message }, 400);
          }
          console.error("[photon.workspace] Manager action failed", {
            action: body.action,
            error_type: error instanceof Error ? error.name : typeof error,
          });
          return json(
            {
              error:
                "Eve could not confirm the session update. Refresh before trying another change.",
            },
            503,
          );
        }
      },
    ),
  ],
});
