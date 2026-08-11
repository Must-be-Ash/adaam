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
const PHOTON_SESSION_ICON_PATH = `${PHOTON_WORKSPACE_APP_PATH}/logo.svg`;
const PHOTON_SESSION_MANIFEST_PATH = `${PHOTON_WORKSPACE_APP_PATH}/manifest.webmanifest`;
const PHOTON_SESSION_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 726.15 726.15">' +
  '<rect width="726.15" height="726.15" rx="107.9" ry="107.9" fill="#1733ff"/>' +
  '<path fill="#fff" d="M256.31 323.87c11.83-37.31 44.54-63.92 83.91-70.79 48.52-8.47 96.93 15.39 119.31 59.41 21.43 42.15 14.42 95.38-20.25 130.31-27.4 27.6-66.36 37.18-102.06 29.3-39-8.6-70.08-36.21-82.76-74.85 18.03 12.07 39.46 15.06 56.57 1.85 19.14-14.78 22.12-42.22 9.32-60.84-13.79-20.06-39.11-26.97-64.04-14.4Z"/>' +
  '<path fill="#fff" d="M363.08 172.98c-104.99 0-190.1 85.11-190.1 190.1s85.11 190.1 190.1 190.1 190.1-85.11 190.1-190.1-85.11-190.1-190.1-190.1Zm0 345.56c-85.86 0-155.46-69.6-155.46-155.46s69.6-155.46 155.46-155.46 155.46 69.6 155.46 155.46-69.6 155.46-155.46 155.46Z"/>' +
  "</svg>";
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

function assetHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
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

function workspaceHtml(nonce: string, origin: string): string {
  const iconUrl = new URL(PHOTON_SESSION_ICON_PATH, origin).toString();
  const manifestUrl = new URL(PHOTON_SESSION_MANIFEST_PATH, origin).toString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#171717">
  <meta name="apple-mobile-web-app-title" content="Eve">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Eve">
  <meta property="og:title" content="Manage Eve Sessions">
  <meta property="og:description" content="Create and switch isolated Eve sessions.">
  <meta property="og:image" content="${iconUrl}">
  <meta property="og:image:type" content="image/svg+xml">
  <meta property="og:image:width" content="726">
  <meta property="og:image:height" content="726">
  <link rel="icon" type="image/svg+xml" sizes="any" href="${iconUrl}">
  <link rel="apple-touch-icon" href="${iconUrl}">
  <link rel="manifest" href="${manifestUrl}">
  <title>Manage Eve Sessions</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #171717;
      --surface: #202020;
      --surface-raised: #292929;
      --text: #f2f2f2;
      --muted: #a0a0a0;
      --line: #333333;
      --line-strong: #4a4a4a;
      --primary: #e8e8e8;
      --primary-text: #181818;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      margin: 0;
      min-height: 100svh;
      padding:
        max(38px, calc(env(safe-area-inset-top) + 28px))
        20px
        max(34px, calc(env(safe-area-inset-bottom) + 24px));
      background: var(--bg);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    main {
      width: min(100%, 560px);
      margin: 0 auto;
      display: grid;
      gap: 22px;
    }
    h1 {
      margin: 0;
      max-width: 12ch;
      font-size: clamp(34px, 9vw, 40px);
      font-weight: 760;
      letter-spacing: -.045em;
      line-height: 1.03;
      text-wrap: balance;
    }
    #status {
      margin: -10px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.4;
    }
    #status.error {
      color: #d6d6d6;
      font-weight: 650;
    }
    .create-section {
      display: grid;
      gap: 9px;
    }
    .form-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: .02em;
    }
    form {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      padding: 7px;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--surface);
    }
    input, button {
      min-height: 44px;
      border-radius: 12px;
      font: inherit;
    }
    input {
      width: 100%;
      min-width: 0;
      border: 1px solid transparent;
      padding: 0 12px;
      background: transparent;
      color: var(--text);
      font-size: 16px;
      outline: none;
    }
    input::placeholder { color: var(--muted); opacity: .78; }
    input:focus-visible {
      border-color: #5a5a5a;
      background: #252525;
    }
    button {
      border: 1px solid var(--line);
      padding: 0 13px;
      font-weight: 680;
      cursor: pointer;
      background: var(--surface-raised);
      color: var(--text);
      -webkit-tap-highlight-color: transparent;
    }
    button.primary {
      border-color: var(--primary);
      background: var(--primary);
      color: var(--primary-text);
    }
    button.danger {
      border-color: #3a3a3a;
      background: #242424;
      color: #bdbdbd;
    }
    button:focus-visible {
      outline: 3px solid #686868;
      outline-offset: 2px;
    }
    button:disabled { cursor: default; opacity: .45; }
    #workspaces { display: grid; gap: 14px; }
    .workspace {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      display: grid;
      gap: 16px;
      background: var(--surface);
    }
    .workspace.active { border-color: #d8d8d8; }
    .workspace.archived { opacity: .76; }
    .title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .name {
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 17px;
      font-weight: 730;
      letter-spacing: -.012em;
      line-height: 1.24;
    }
    .meta {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
    }
    .actions button {
      grid-column: span 2;
      min-width: 0;
      min-height: 44px;
      padding-inline: 8px;
      font-size: 13px;
      white-space: nowrap;
    }
    .actions button.primary { grid-column: 1 / -1; }
    .workspace.active .actions button { grid-column: span 3; }
    .note {
      margin: -2px 0 0;
      padding-top: 19px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    @media (prefers-reduced-motion: no-preference) {
      button {
        transition:
          background-color 140ms ease,
          border-color 140ms ease,
          opacity 140ms ease,
          transform 100ms ease;
      }
      button:hover:not(:disabled) {
        border-color: var(--line-strong);
      }
      button.primary:hover:not(:disabled) {
        background: #f2f2f2;
      }
      button:active:not(:disabled) { transform: scale(.985); }
    }
    @media (max-width: 370px) {
      body { padding-inline: 16px; }
      .workspace { padding: 16px; }
      .actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .actions button,
      .workspace.active .actions button { grid-column: auto; }
      .actions button.primary { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Manage Sessions</h1>
    </header>
    <p id="status" role="status" aria-live="polite">Loading your sessions…</p>
    <section class="create-section">
      <label class="form-label" for="new-name">New session</label>
      <form id="create-form">
        <input id="new-name" maxlength="40" autocomplete="off" placeholder="Name your session">
        <button class="primary" type="submit">Create</button>
      </form>
    </section>
    <section>
      <div id="workspaces"></div>
    </section>
    <p class="note">Start fresh clears that session’s conversation history. Archived sessions can be restored later.</p>
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

          const actions = document.createElement("div");
          actions.className = "actions";
          if (workspace.status === "archived") {
            actions.append(
              button("Restore session", "restore", workspace, { primary: true }),
            );
          } else {
            if (!isActive) {
              actions.append(
                button("Switch here", "select", workspace, { primary: true }),
              );
            }
            actions.append(button("Rename", "rename", workspace));
            actions.append(button("Start fresh", "start-fresh", workspace));
            if (!isActive) {
              actions.append(
                button("Archive", "archive", workspace, { danger: true }),
              );
            }
          }
          card.append(titleRow, actions);
          list.append(card);
        }
      };

      const load = async () => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
          status.classList.add("error");
          status.textContent = "This session manager link is unavailable. Ask Eve to open it again.";
          form.hidden = true;
          return;
        }
        try {
          status.classList.remove("error");
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/state", {
            managerToken: token,
          });
          status.textContent =
            "Active session: " +
            state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId).name;
          render();
        } catch (error) {
          status.classList.add("error");
          status.textContent =
            error instanceof Error ? error.message : "Could not load sessions.";
        }
      };

      const mutate = async (action) => {
        if (!state || busy) return;
        busy = true;
        render();
        status.classList.remove("error");
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
          status.classList.add("error");
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
    GET(PHOTON_SESSION_ICON_PATH, async () => {
      return new Response(PHOTON_SESSION_ICON, {
        headers: assetHeaders("image/svg+xml; charset=utf-8"),
      });
    }),
    GET(PHOTON_SESSION_MANIFEST_PATH, async (request) => {
      const iconUrl = new URL(
        PHOTON_SESSION_ICON_PATH,
        new URL(request.url).origin,
      ).toString();
      return new Response(
        JSON.stringify({
          background_color: "#171717",
          display: "standalone",
          icons: [
            {
              purpose: "any maskable",
              sizes: "any",
              src: iconUrl,
              type: "image/svg+xml",
            },
          ],
          name: "Eve Sessions",
          short_name: "Eve",
          theme_color: "#171717",
        }),
        {
          headers: assetHeaders(
            "application/manifest+json; charset=utf-8",
          ),
        },
      );
    }),
    GET(PHOTON_WORKSPACE_APP_PATH, async (request) => {
      const nonce = randomBytes(18).toString("base64url");
      const headers = responseHeaders("text/html; charset=utf-8");
      headers["content-security-policy"] =
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'`;
      return new Response(
        workspaceHtml(nonce, new URL(request.url).origin),
        { headers },
      );
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
