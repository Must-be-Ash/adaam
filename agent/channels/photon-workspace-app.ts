import { Buffer } from "node:buffer";
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
const PHOTON_SESSION_ICON_PATH = `${PHOTON_WORKSPACE_APP_PATH}/icon.png`;
const PHOTON_SESSION_MANIFEST_PATH = `${PHOTON_WORKSPACE_APP_PATH}/manifest.webmanifest`;
const PHOTON_SESSION_ICON = Buffer.from(
  "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",
  "base64",
);
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
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f3f6fb">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0c1119">
  <meta name="apple-mobile-web-app-title" content="Eve">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Eve">
  <meta property="og:title" content="Manage Eve Sessions">
  <meta property="og:description" content="Create and switch isolated Eve sessions.">
  <meta property="og:image" content="${iconUrl}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="180">
  <meta property="og:image:height" content="180">
  <link rel="icon" type="image/png" sizes="180x180" href="${iconUrl}">
  <link rel="apple-touch-icon" sizes="180x180" href="${iconUrl}">
  <link rel="manifest" href="${manifestUrl}">
  <title>Manage Eve Sessions</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --bg: #f3f6fb;
      --surface: #ffffff;
      --surface-raised: #f8fafd;
      --text: #111827;
      --muted: #667085;
      --line: rgba(17, 24, 39, .11);
      --line-strong: rgba(17, 24, 39, .18);
      --accent: #2f6fed;
      --accent-strong: #245bca;
      --accent-soft: #eaf1ff;
      --danger: #b42318;
      --danger-soft: #fff0ee;
      --shadow: 0 1px 2px rgba(15, 23, 42, .04), 0 12px 28px rgba(15, 23, 42, .05);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0c1119;
        --surface: #131a24;
        --surface-raised: #18212d;
        --text: #f2f5f9;
        --muted: #98a6b8;
        --line: rgba(255, 255, 255, .09);
        --line-strong: rgba(255, 255, 255, .15);
        --accent: #6593ff;
        --accent-strong: #7ca3ff;
        --accent-soft: rgba(65, 112, 216, .14);
        --danger: #ff8178;
        --danger-soft: rgba(248, 81, 73, .10);
        --shadow: 0 1px 2px rgba(0, 0, 0, .16), 0 16px 36px rgba(0, 0, 0, .12);
      }
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
      gap: 24px;
    }
    header {
      display: grid;
      gap: 12px;
    }
    .brand-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      border-radius: 8px;
      box-shadow: 0 4px 14px rgba(30, 64, 175, .16);
    }
    .eyebrow {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      letter-spacing: .12em;
      text-transform: uppercase;
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
      width: fit-content;
      max-width: 100%;
      margin: -8px 0 0;
      padding: 7px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 13px;
      font-weight: 620;
      line-height: 1.35;
    }
    #status::before {
      content: "";
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 999px;
      background: currentColor;
      box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
    }
    #status.error {
      background: var(--danger-soft);
      color: var(--danger);
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
      box-shadow: var(--shadow);
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
      border-color: color-mix(in srgb, var(--accent) 55%, transparent);
      background: var(--surface-raised);
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
      border-color: transparent;
      background: #3978f6;
      color: #ffffff;
      box-shadow: 0 7px 18px rgba(30, 96, 230, .18);
    }
    button.danger {
      border-color: color-mix(in srgb, var(--danger) 18%, transparent);
      background: var(--danger-soft);
      color: var(--danger);
    }
    button:focus-visible {
      outline: 3px solid color-mix(in srgb, var(--accent) 32%, transparent);
      outline-offset: 2px;
    }
    button:disabled { cursor: default; opacity: .45; }
    #workspaces { display: grid; gap: 14px; }
    .workspace {
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 18px;
      display: grid;
      gap: 16px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }
    .workspace.active {
      border-color: color-mix(in srgb, var(--accent) 42%, var(--line));
      background: color-mix(in srgb, var(--accent-soft) 48%, var(--surface));
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--accent) 13%, transparent),
        var(--shadow);
    }
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
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 5px 9px;
      background: var(--accent-soft);
      color: var(--accent-strong);
      font-size: 12px;
      font-weight: 700;
    }
    .badge::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
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
      button:active:not(:disabled) { transform: scale(.985); }
      .workspace { animation: settle 180ms ease-out both; }
      @keyframes settle {
        from { opacity: 0; transform: translateY(3px); }
        to { opacity: 1; transform: translateY(0); }
      }
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
      <div class="brand-row">
        <img class="brand-mark" src="${iconUrl}" alt="">
        <p class="eyebrow">Eve · Sessions</p>
      </div>
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
          if (isActive) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "Active";
            titleRow.append(badge);
          }

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
      return new Response(new Uint8Array(PHOTON_SESSION_ICON), {
        headers: assetHeaders("image/png"),
      });
    }),
    GET(PHOTON_SESSION_MANIFEST_PATH, async (request) => {
      const iconUrl = new URL(
        PHOTON_SESSION_ICON_PATH,
        new URL(request.url).origin,
      ).toString();
      return new Response(
        JSON.stringify({
          background_color: "#0c1119",
          display: "standalone",
          icons: [
            {
              purpose: "any maskable",
              sizes: "180x180",
              src: iconUrl,
              type: "image/png",
            },
          ],
          name: "Eve Sessions",
          short_name: "Eve",
          theme_color: "#3978f6",
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
