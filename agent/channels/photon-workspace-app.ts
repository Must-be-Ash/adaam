import { randomBytes } from "node:crypto";

import { defineChannel, GET, POST } from "eve/channels";
import { z } from "zod";

import {
  PHOTON_APP_ICON_PNG,
  PHOTON_APP_ICON_PNG_PATH,
  PHOTON_APP_ICON_SVG,
  PHOTON_APP_ICON_SVG_PATH,
  PHOTON_APP_MANIFEST_PATH,
  photonAppIconHeadHtml,
  photonAppIconManifest,
} from "../lib/photon-app-icon";
import { getCurrentPhotonApprovalActivity } from "../lib/photon-approval-store";
import { PHOTON_WORKSPACE_APP_PATH } from "../lib/photon-mini-app";
import { workspaceMonitorManagerSourcesSchema } from "../lib/workspace-monitor-input";
import {
  readWorkspaceBudgetLedger,
  summarizeWorkspaceBudgetUsage,
} from "../lib/workspace-budget-ledger";
import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  getWorkspaceMonitor,
  listWorkspaceMonitors,
  pauseWorkspaceMonitorsAfterRestore,
  suspendWorkspaceMonitorsForArchive,
  updateWorkspaceMonitor,
  workspaceMonitorScheduleSchema,
} from "../lib/workspace-monitor-store";
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
} from "../lib/workspace-state-store";
import { authorizePhotonWorkspaceControlPlaneStore } from "../lib/workspace-store-authorization";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import {
  PhotonIngressRolloutError,
  resolvePhotonIngressRolloutMode,
} from "../lib/photon-ingress-rollout";
import {
  OwnerIdentityDeniedError,
  requirePhotonOwnerAccess,
} from "../lib/owner-identity";
import {
  applyPhotonWorkspaceManagerAction,
  claimPhotonWorkspaceManagerRequest,
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
const requestIdSchema = z.string().uuid();
export const photonWorkspaceMonitorSourcesSchema =
  workspaceMonitorManagerSourcesSchema;
const PHOTON_SESSION_ICON_PATH = `${PHOTON_WORKSPACE_APP_PATH}/${PHOTON_APP_ICON_SVG_PATH}`;
const PHOTON_SESSION_ICON_PNG_PATH = `${PHOTON_WORKSPACE_APP_PATH}/${PHOTON_APP_ICON_PNG_PATH}`;
const PHOTON_SESSION_MANIFEST_PATH = `${PHOTON_WORKSPACE_APP_PATH}/${PHOTON_APP_MANIFEST_PATH}`;
const stateRequestSchema = z.object({
  managerToken: tokenSchema,
});
const actionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("archive"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    replacementWorkspaceId: workspaceIdSchema.optional(),
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("create"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    name: z.string().min(1).max(80),
    select: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("rename"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    name: z.string().min(1).max(80),
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("restore"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("select"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("start-fresh"),
    expectedRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    workspaceId: workspaceIdSchema,
  }),
]);
const runtimeActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["monitor-pause", "monitor-resume"]),
    expectedMonitorRevision: z.number().int().positive(),
    expectedRoutingRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    monitorId: workspaceIdSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("monitor-schedule"),
    expectedMonitorRevision: z.number().int().positive(),
    expectedRoutingRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    monitorId: workspaceIdSchema,
    schedule: workspaceMonitorScheduleSchema,
    workspaceId: workspaceIdSchema,
  }),
  z.object({
    action: z.literal("workspace-budget"),
    expectedBudgetRevision: z.number().int().positive(),
    expectedRoutingRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    requestId: requestIdSchema,
    maximumConcurrentWorkers: z.number().int().positive().max(32),
    maximumScheduledRunsPerDay: z.number().int().positive().max(32),
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

async function publicManagerState(
  principalId: string,
  state: PhotonWorkspaceState,
) {
  const base = publicState(state);
  return {
    ...base,
    workspaces: await Promise.all(base.workspaces.map(async (workspace) => {
      const scope = authorizePhotonWorkspaceControlPlaneStore({
        principalId,
        resource: "manager",
        workspaceId: workspace.id,
      });
      const [monitors, budget, budgetLedger] = await Promise.all([
        listWorkspaceMonitors(scope),
        readWorkspaceDocument("budget", scope),
        readWorkspaceBudgetLedger(scope),
      ]);
      return {
        ...workspace,
        budget,
        budgetUsage: budget
          ? summarizeWorkspaceBudgetUsage(
              budgetLedger,
              new Date(),
              budget.value.ownerTimezone,
            )
          : null,
        monitors: monitors.map((monitor) => ({
          configurationRevision: monitor.configurationRevision,
          lastCompletedAt: monitor.lastCompletedAt,
          lastErrorCode: monitor.lastErrorCode,
          lastRunAt: monitor.lastRunAt,
          lifecycleState: monitor.lifecycleState,
          monitorId: monitor.monitorId,
          name: monitor.name,
          nextOccurrenceAt: monitor.nextOccurrenceAt,
          schedule: monitor.schedule,
          sources: monitor.sources,
        })),
      };
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
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#171717">
  ${photonAppIconHeadHtml(origin, PHOTON_WORKSPACE_APP_PATH, {
    description: "Create and switch isolated Eve sessions.",
    title: "Manage Eve Sessions",
  })}
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
    .runtime { display: grid; gap: 9px; }
    .runtime-row { padding: 10px 12px; border: 1px solid var(--line); border-radius: 11px; }
    .runtime-detail { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .runtime-row .actions { margin-top: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .runtime-row .actions button { grid-column: auto; }
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
    <p class="note">Start fresh clears that session’s conversation history. Archived sessions can be restored later. If a monitor control is unavailable, ask Eve in chat to list, pause, resume, reschedule, retire, or update the budget for a monitor.</p>
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

      const runtimeButton = (label, action, workspace, monitor = null) => {
        const element = document.createElement("button");
        element.type = "button";
        element.textContent = label;
        element.disabled = busy;
        element.addEventListener("click", () => void handleRuntime(action, workspace, monitor));
        return element;
      };

      const formatSchedule = (schedule) => {
        if (schedule.kind === "daily_local") {
          return schedule.times.join(", ") + " · " + schedule.timezone;
        }
        if (schedule.kind === "interval") {
          return "every " + schedule.everyMinutes + " minutes · anchored " + schedule.anchor;
        }
        return "once · " + schedule.at;
      };

      const paidLimit = (value) => value === null ? "deployment cap" : "$" + value;
      const paidUsage = (micros) => "$" + (Number(micros) / 1000000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

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
          const workspaceMonitors = workspace.monitors || [];
          const enabledMonitors = workspaceMonitors.filter(
            (monitor) => monitor.lifecycleState === "enabled",
          ).length;
          const pausedMonitors = workspaceMonitors.filter(
            (monitor) => monitor.lifecycleState === "paused",
          ).length;
          const errorMonitors = workspaceMonitors.filter(
            (monitor) => monitor.lastErrorCode !== null,
          ).length;
          const monitorCounts = workspaceMonitors.length + " monitor(s) · " +
            enabledMonitors + " enabled · " + pausedMonitors + " paused · " +
            errorMonitors + " error(s)";
          meta.textContent =
            workspace.status === "archived"
              ? "Archived · " + monitorCounts
              : isActive
                ? "Current session · " + monitorCounts
                : "Available · " + monitorCounts;
          titleWrap.append(title, meta);
          titleRow.append(titleWrap);

          const runtime = document.createElement("div");
          runtime.className = "runtime";
          for (const monitor of workspace.monitors || []) {
            const row = document.createElement("div");
            row.className = "runtime-row";
            const monitorName = document.createElement("p");
            monitorName.className = "name";
            monitorName.textContent = monitor.name;
            const monitorMeta = document.createElement("p");
            monitorMeta.className = "meta";
            monitorMeta.textContent = monitor.lifecycleState + " · next " +
              (monitor.nextOccurrenceAt || "none") + " · last " +
              (monitor.lastRunAt || "never") + " · completed " +
              (monitor.lastCompletedAt || "never") +
              (monitor.lastErrorCode ? " · " + monitor.lastErrorCode : "");
            const monitorSchedule = document.createElement("p");
            monitorSchedule.className = "runtime-detail";
            monitorSchedule.textContent = "Schedule · " + formatSchedule(monitor.schedule);
            const monitorSources = document.createElement("p");
            monitorSources.className = "runtime-detail";
            monitorSources.textContent = "Sources · " + monitor.sources.map(
              (source) => source.sourceId + ": " + source.canonicalUrl,
            ).join(" · ");
            const monitorActions = document.createElement("div");
            monitorActions.className = "actions";
            monitorActions.append(
              runtimeButton(monitor.lifecycleState === "enabled" ? "Pause" : "Resume",
                monitor.lifecycleState === "enabled" ? "monitor-pause" : "monitor-resume", workspace, monitor),
              runtimeButton("Edit schedule", "monitor-schedule", workspace, monitor),
            );
            row.append(monitorName, monitorMeta, monitorSchedule, monitorSources, monitorActions);
            runtime.append(row);
          }
          if (workspace.budget) {
            const budget = document.createElement("div");
            budget.className = "runtime-row";
            const budgetMeta = document.createElement("p");
            budgetMeta.className = "meta";
            budgetMeta.textContent = "Budget · " + workspace.budget.value.maximumScheduledRunsPerDay +
              " runs/day · " + workspace.budget.value.maximumConcurrentWorkers + " concurrent worker(s)";
            const budgetTokens = document.createElement("p");
            budgetTokens.className = "runtime-detail";
            budgetTokens.textContent = "Tokens · " + workspace.budget.value.maximumInputTokensPerRun +
              " input/run · " + workspace.budget.value.maximumOutputTokensPerRun +
              " output/run · " + workspace.budget.value.maximumInputTokensPerDay +
              " input/day · " + workspace.budget.value.maximumOutputTokensPerDay + " output/day";
            const budgetPaid = document.createElement("p");
            budgetPaid.className = "runtime-detail";
            budgetPaid.textContent = "Paid limits · " + paidLimit(workspace.budget.value.maximumPaidPerCall) +
              "/call · " + paidLimit(workspace.budget.value.maximumPaidPerDay) +
              "/day · " + paidLimit(workspace.budget.value.maximumPaidPerMonth) +
              "/month · unknown-price reserve $" + workspace.budget.value.unknownPriceFallbackCeiling;
            const budgetUsage = document.createElement("p");
            budgetUsage.className = "runtime-detail";
            budgetUsage.textContent = workspace.budgetUsage
              ? "Usage " + workspace.budgetUsage.calendarDay + " · " + workspace.budgetUsage.runsToday +
                " run(s) · " + workspace.budgetUsage.inputTokensToday + " input · " +
                workspace.budgetUsage.outputTokensToday + " output · " +
                workspace.budgetUsage.activeWorkers + "/" +
                workspace.budget.value.maximumConcurrentWorkers + " active workers · " +
                paidUsage(workspace.budgetUsage.paidMicrosToday) + " paid today · " +
                paidUsage(workspace.budgetUsage.paidMicrosThisMonth) + " paid this month · " +
                workspace.budget.value.ownerTimezone
              : "Usage unavailable";
            const budgetActions = document.createElement("div");
            budgetActions.className = "actions";
            budgetActions.append(runtimeButton("Edit budget", "workspace-budget", workspace));
            budget.append(budgetMeta, budgetTokens, budgetPaid, budgetUsage, budgetActions);
            runtime.append(budget);
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
          card.append(titleRow, runtime, actions);
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
            requestId: crypto.randomUUID(),
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

      const runtimeMutate = async (action) => {
        if (!state || busy) return;
        busy = true;
        render();
        try {
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/runtime-action", {
            ...action,
            expectedRoutingRevision: state.revision,
            managerToken: token,
            requestId: crypto.randomUUID(),
          });
          status.textContent = "Monitor settings updated.";
        } catch (error) {
          status.classList.add("error");
          status.textContent = error instanceof Error ? error.message : "Could not update monitor settings.";
          if (error && error.status === 409) await load();
        } finally {
          busy = false;
          render();
        }
      };

      const handleRuntime = async (action, workspace, monitor) => {
        if (action === "workspace-budget") {
          const runs = Number(prompt("Maximum scheduled runs per day", workspace.budget.value.maximumScheduledRunsPerDay));
          const workers = Number(prompt("Maximum concurrent workers", workspace.budget.value.maximumConcurrentWorkers));
          if (!Number.isInteger(runs) || !Number.isInteger(workers)) return;
          await runtimeMutate({ action, expectedBudgetRevision: workspace.budget.revision,
            maximumConcurrentWorkers: workers, maximumScheduledRunsPerDay: runs, workspaceId: workspace.id });
          return;
        }
        if (action === "monitor-schedule") {
          if (monitor.schedule.kind !== "daily_local") {
            alert("This editor currently supports local daily schedules. Ask Eve in chat to change other schedule types.");
            return;
          }
          const times = prompt("Daily times (24-hour, comma-separated)", monitor.schedule.times.join(", "));
          const timezone = prompt("IANA time zone", monitor.schedule.timezone);
          if (!times || !timezone) return;
          await runtimeMutate({ action, expectedMonitorRevision: monitor.configurationRevision,
            monitorId: monitor.monitorId, schedule: { kind: "daily_local",
              times: times.split(",").map((value) => value.trim()).filter(Boolean), timezone }, workspaceId: workspace.id });
          return;
        }
        await runtimeMutate({ action, expectedMonitorRevision: monitor.configurationRevision,
          monitorId: monitor.monitorId, workspaceId: workspace.id });
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
      return new Response(PHOTON_APP_ICON_SVG, {
        headers: assetHeaders("image/svg+xml; charset=utf-8"),
      });
    }),
    GET(PHOTON_SESSION_ICON_PNG_PATH, async () => {
      return new Response(PHOTON_APP_ICON_PNG, {
        headers: assetHeaders("image/png"),
      });
    }),
    GET(PHOTON_SESSION_MANIFEST_PATH, async (request) => {
      return new Response(
        photonAppIconManifest(new URL(request.url).origin, PHOTON_WORKSPACE_APP_PATH),
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
      const scope = await getPhotonWorkspaceManagerScope(body.managerToken);
      if (!scope) {
        return json({ error: "This session manager link expired." }, 410);
      }
      let rolloutMode;
      try {
        rolloutMode = resolvePhotonIngressRolloutMode();
        if (rolloutMode === "durable") {
          requirePhotonOwnerAccess({
            principalId: scope.principalId,
            resource: "manager",
          });
        }
      } catch (error) {
        if (error instanceof OwnerIdentityDeniedError) {
          return json({ error: "This identity is not authorized." }, 403);
        }
        if (error instanceof PhotonIngressRolloutError) {
          return json({ error: "Eve's iMessage rollout configuration is incomplete." }, 503);
        }
        throw error;
      }
      const state = await getPhotonWorkspaceManagerState(body.managerToken);
      return state
        ? json(rolloutMode === "durable"
            ? await publicManagerState(scope.principalId, state)
            : publicState(state))
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
        let rolloutMode;
        try {
          rolloutMode = resolvePhotonIngressRolloutMode();
          if (rolloutMode === "durable") {
            requirePhotonOwnerAccess({
              principalId: scope.principalId,
              resource: "manager",
            });
          }
        } catch (error) {
          if (error instanceof OwnerIdentityDeniedError) {
            return json({ error: "This identity is not authorized." }, 403);
          }
          if (error instanceof PhotonIngressRolloutError) {
            return json({ error: "Eve's iMessage rollout configuration is incomplete." }, 503);
          }
          throw error;
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
          const requestClaim = await claimPhotonWorkspaceManagerRequest(
            body.managerToken,
            body.requestId,
          );
          if (requestClaim === "unavailable") {
            return json({ error: "This session manager link expired." }, 410);
          }
          if (requestClaim === "replayed") {
            return json({ error: "That manager action was already consumed. Refresh to see current state." }, 409);
          }
          const lifecycleScope = rolloutMode === "durable" && "workspaceId" in action
            ? authorizePhotonWorkspaceControlPlaneStore({
                principalId: scope.principalId,
                resource: "manager",
                workspaceId: action.workspaceId,
              })
            : null;
          if (action.action === "archive" && lifecycleScope) {
            await suspendWorkspaceMonitorsForArchive({ scope: lifecycleScope });
          }
          const result = await applyPhotonWorkspaceManagerAction(
            body.managerToken,
            action as PhotonWorkspaceAction,
          );
          if (action.action === "restore" && lifecycleScope) {
            await pauseWorkspaceMonitorsAfterRestore({ scope: lifecycleScope });
          }
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
            ...(rolloutMode === "durable"
              ? await publicManagerState(scope.principalId, result.state)
              : publicState(result.state)),
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
    POST(`${PHOTON_WORKSPACE_APP_PATH}/runtime-action`, async (request) => {
      const body = await readJson(request, runtimeActionRequestSchema);
      if (body instanceof Response) return body;
      const managerScope = await getPhotonWorkspaceManagerScope(body.managerToken);
      if (!managerScope) return json({ error: "This session manager link expired." }, 410);
      try {
        if (resolvePhotonIngressRolloutMode() !== "durable") {
          return json({ error: "Workspace runtime controls are not enabled." }, 403);
        }
        requirePhotonOwnerAccess({ principalId: managerScope.principalId, resource: "manager" });
        const approvalActivity = await getCurrentPhotonApprovalActivity(managerScope).catch(() => "active");
        if (approvalActivity) {
          return json({ error: "Finish or cancel the pending financial approval before changing monitors." }, 409);
        }
        requireWorkspaceMonitorWrites();
        const requestClaim = await claimPhotonWorkspaceManagerRequest(
          body.managerToken,
          body.requestId,
        );
        if (requestClaim === "unavailable") {
          return json({ error: "This session manager link expired." }, 410);
        }
        if (requestClaim === "replayed") {
          return json({ error: "That manager action was already consumed. Refresh to see current state." }, 409);
        }
        const routing = await getPhotonWorkspaceManagerState(body.managerToken);
        if (!routing) return json({ error: "This session manager link expired." }, 410);
        if (routing.revision !== body.expectedRoutingRevision) {
          return json({ error: "The session state changed. Refresh and try again." }, 409);
        }
        const workspace = routing.workspaces.find(
          (candidate) => candidate.id === body.workspaceId && candidate.status === "active",
        );
        if (!workspace) return json({ error: "That session is unavailable." }, 400);
        const scope = authorizePhotonWorkspaceControlPlaneStore({
          principalId: managerScope.principalId,
          resource: "manager",
          workspaceId: workspace.id,
        });
        const now = new Date();
        if (body.action === "workspace-budget") {
          const budget = await readWorkspaceDocument("budget", scope);
          if (!budget || budget.revision !== body.expectedBudgetRevision) {
            return json({ error: "The workspace budget changed. Refresh and try again." }, 409);
          }
          await writeWorkspaceDocument("budget", {
            expectedRevision: budget.revision,
            now,
            scope,
            value: {
              ...budget.value,
              effectiveAt: now.toISOString(),
              maximumConcurrentWorkers: body.maximumConcurrentWorkers,
              maximumScheduledRunsPerDay: body.maximumScheduledRunsPerDay,
            },
          });
        } else {
          const monitor = await getWorkspaceMonitor(scope, body.monitorId);
          if (!monitor || monitor.configurationRevision !== body.expectedMonitorRevision) {
            return json({ error: "The monitor changed. Refresh and try again." }, 409);
          }
          if (body.action === "monitor-schedule") {
            const next = nextWorkspaceMonitorOccurrence(body.schedule, now);
            if (!next) return json({ error: "That schedule has no future occurrence." }, 400);
            await updateWorkspaceMonitor({
              expectedRevision: monitor.configurationRevision,
              monitorId: monitor.monitorId,
              now,
              patch: { nextOccurrenceAt: next.scheduledAt, schedule: body.schedule },
              scope,
            });
          } else if (body.action === "monitor-resume") {
            const next = nextWorkspaceMonitorOccurrence(monitor.schedule, now);
            if (!next) return json({ error: "That monitor schedule is complete." }, 400);
            await updateWorkspaceMonitor({
              expectedRevision: monitor.configurationRevision,
              monitorId: monitor.monitorId,
              now,
              patch: {
                lastErrorCode: null,
                lifecycleState: "enabled",
                nextOccurrenceAt: next.scheduledAt,
                pauseReason: null,
                pausedAt: null,
              },
              scope,
            });
          } else {
            await updateWorkspaceMonitor({
              expectedRevision: monitor.configurationRevision,
              monitorId: monitor.monitorId,
              now,
              patch: {
                lifecycleState: "paused",
                nextOccurrenceAt: null,
                pauseReason: "owner_paused",
                pausedAt: now.toISOString(),
              },
              scope,
            });
          }
        }
        const refreshed = await getPhotonWorkspaceManagerState(body.managerToken);
        return refreshed
          ? json(await publicManagerState(managerScope.principalId, refreshed))
          : json({ error: "This session manager link expired." }, 410);
      } catch (error) {
        if (error instanceof OwnerIdentityDeniedError) {
          return json({ error: "This identity is not authorized." }, 403);
        }
        if (error instanceof PhotonIngressRolloutError) {
          return json({ error: "Eve's iMessage rollout configuration is incomplete." }, 503);
        }
        console.error("[photon.workspace] Runtime manager action failed", {
          action: body.action,
          error_type: error instanceof Error ? error.name : typeof error,
        });
        return json({ error: "Eve could not confirm the monitor update. Refresh and try again." }, 503);
      }
    }),
  ],
});
