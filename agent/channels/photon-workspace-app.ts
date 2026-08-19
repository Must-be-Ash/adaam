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
import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../lib/strategy-pack-reference-catalog";
import {
  configureStrategyPackWorkspaceFromSelection,
  createStrategyPackWorkspaceFromSelection,
  inspectStrategyPack,
  inspectStrategyPackWorkspace,
  listLatestStrategyPacks,
  mintSpectrumStrategyPackMutationIdentity,
  removeStrategyPackWorkspaceFromSelection,
  resolveStrategyPackInitialMonitorDueAt,
  strategyPackMutationConfigurationSchema,
  StrategyPackServiceError,
  verifySpectrumStrategyPackMutationIdentity,
} from "../lib/strategy-pack-service";
import { resolveStrategyPackFlags } from "../lib/strategy-pack-flags";
import { workspaceMonitorManagerSourcesSchema } from "../lib/workspace-monitor-input";
import {
  formatWorkspacePaidMicros,
  readWorkspaceBudgetLedger,
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  summarizeWorkspaceBudgetUsage,
} from "../lib/workspace-budget-ledger";
import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  readPublicSourceWorkspaceHealth,
  unavailablePublicSourceWorkspaceHealth,
} from "../lib/public-source-health";
import { readCongressionalWorkspacePresentation } from "../lib/congressional-signal-presentation";
import { readEarningsCallWorkspacePresentation } from "../lib/earnings-call-presentation";
import { readPublicCommentaryWorkspacePresentation } from "../lib/public-commentary-presentation";
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
  mintXPublicIdentityResolutionReceipt,
  normalizeXPublicProfile,
  resolveXPublicIdentity,
} from "../lib/x-public-identity";
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
const xIdentityRequestSchema = z.object({
  managerToken: tokenSchema,
  profile: z.string().trim().min(1).max(200),
  requestId: requestIdSchema,
}).strict();
const xIdentityCache = new Map<string, Readonly<{
  expiresAt: number;
  identity: Awaited<ReturnType<typeof resolveXPublicIdentity>>;
}>>();
const packMutationIdentitySchema = z.object({
  actionId: z.string().min(1).max(200),
  expectedRegistryRevision: z.number().int().nonnegative(),
  issuedAt: z.string().datetime({ offset: true }),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
  routingScopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceWorkspaceGeneration: z.number().int().positive(),
  sourceWorkspaceId: workspaceIdSchema,
  transport: z.literal("spectrum"),
}).strict();
const packLifecycleRequestBase = {
  expectedBindingRevision: z.number().int().positive(),
  expectedRoutingRevision: z.number().int().nonnegative(),
  managerToken: tokenSchema,
  packMutationIdentity: packMutationIdentitySchema,
  sourceWorkspaceGeneration: z.number().int().positive(),
  sourceWorkspaceId: workspaceIdSchema,
};
export const photonStrategyPackActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("strategy-pack-create"),
    activateMonitorResourceIds: z.array(z.string().min(2).max(80)).max(16),
    configuration: strategyPackMutationConfigurationSchema,
    expectedRoutingRevision: z.number().int().nonnegative(),
    managerToken: tokenSchema,
    name: z.string().trim().min(1).max(80),
    packId: z.string().min(2).max(64),
    packMutationIdentity: packMutationIdentitySchema,
    packVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
    sourceWorkspaceGeneration: z.number().int().positive(),
    sourceWorkspaceId: workspaceIdSchema,
    xIdentityResolutionReceipt: z.object({
      identityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      issuedAt: z.string().datetime({ offset: true }),
      principalId: z.string().min(1).max(200),
      signature: z.string().regex(/^[a-f0-9]{64}$/u),
      threadId: z.string().min(1).max(200),
    }).strict().optional(),
  }).strict(),
  z.object({
    ...packLifecycleRequestBase,
    action: z.literal("strategy-pack-configure"),
    configuration: strategyPackMutationConfigurationSchema,
    confirmedConsequences: z.literal(true),
  }).strict(),
  z.object({
    ...packLifecycleRequestBase,
    action: z.literal("strategy-pack-remove"),
    confirmedConsequences: z.literal(true),
  }).strict(),
]);
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
  maximumBytes = 2_048,
): Promise<T | Response> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > maximumBytes) {
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
    if (Buffer.byteLength(body, "utf8") > maximumBytes) {
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
  threadId: string,
  state: PhotonWorkspaceState,
) {
  const base = publicState(state);
  const flags = resolveStrategyPackFlags();
  const strategyPackCatalog = flags.catalog
    ? listLatestStrategyPacks().packs.map((summary) =>
        inspectStrategyPack({ id: summary.id, version: summary.version }).pack)
    : [];
  const packMutationIdentity = flags.mutations
    ? mintSpectrumStrategyPackMutationIdentity({
        actionId: randomBytes(24).toString("base64url"),
        expectedRegistryRevision: state.revision,
        issuedAt: new Date(),
        nonce: randomBytes(24).toString("base64url"),
        principalId,
        sourceWorkspaceGeneration: state.activeWorkspace.generation,
        sourceWorkspaceId: state.activeWorkspace.id,
        threadId,
      }, strategyPackActionSecret())
    : null;
  return {
    ...base,
    packMutationIdentity,
    strategyPackCatalog,
    workspaces: await Promise.all(base.workspaces.map(async (workspace) => {
      const scope = authorizePhotonWorkspaceControlPlaneStore({
        principalId,
        resource: "manager",
        workspaceId: workspace.id,
      });
      const [monitors, budget, budgetLedger, inspectedStrategyPack] = await Promise.all([
        listWorkspaceMonitors(scope),
        readWorkspaceDocument("budget", scope),
        readWorkspaceBudgetLedger(scope).catch(() => null),
        flags.catalog
          ? inspectStrategyPackWorkspace({
              scope,
              workspaceGeneration: workspace.generation,
            })
          : Promise.resolve(null),
      ]);
      const budgetUsage = budget && budgetLedger
        ? summarizeWorkspaceBudgetUsage(
            budgetLedger,
            new Date(),
            budget.value.ownerTimezone,
          )
        : null;
      const publicMonitors = await Promise.all(monitors.map(async (monitor) => ({
        configurationRevision: monitor.configurationRevision,
        lastCompletedAt: monitor.lastCompletedAt,
        lastErrorCode: monitor.lastErrorCode,
        lastRunAt: monitor.lastRunAt,
        lifecycleState: monitor.lifecycleState,
        monitorId: monitor.monitorId,
        name: monitor.name,
        nextOccurrenceAt: monitor.nextOccurrenceAt,
        publicSourceHealth: await Promise.all(
          (monitor.publicSourceSubscriptions ?? []).map((reference) =>
            readPublicSourceWorkspaceHealth({ reference, scope }).catch(() =>
              unavailablePublicSourceWorkspaceHealth(reference)),
          ),
        ),
        schedule: monitor.schedule,
        sources: monitor.sources,
      })));
      const congressionalSignals = inspectedStrategyPack?.state === "active" &&
          inspectedStrategyPack.pack?.id === "congressional-signals"
        ? await readCongressionalWorkspacePresentation(scope).catch(() => Object.freeze({
            coverage: null,
            latestSignal: null,
            outcomeCounts: Object.freeze({
              alertEligible: 0,
              priority: 0,
              recordOnly: 0,
              review: 0,
              total: 0,
            }),
            state: "unavailable" as const,
          }))
        : null;
      const earningsCallChanges = inspectedStrategyPack?.state === "active" &&
          inspectedStrategyPack.pack?.id === "earnings-call-changes"
        ? await (() => {
            const monitorRecord = monitors.find((candidate) =>
              candidate.managedBy?.packId === "earnings-call-changes");
            const monitor = publicMonitors.find((candidate) =>
              candidate.monitorId === monitorRecord?.monitorId);
            return readEarningsCallWorkspacePresentation({
              ...(monitor && monitorRecord ? {
                monitor: {
                  lifecycleState: monitor.lifecycleState,
                  sourceCheckpoint: monitorRecord.sourceCheckpoint,
                  sources: monitor.sources,
                },
                sourceHealth: monitor.publicSourceHealth,
              } : {}),
              scope,
              selectedIssuerCiks: Array.isArray(inspectedStrategyPack.configuration?.selectedIssuerCiks)
                ? inspectedStrategyPack.configuration.selectedIssuerCiks.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
            });
          })().catch(() => Object.freeze({
            coverage: Object.freeze([]),
            latestAnalysis: null,
            state: "unavailable" as const,
          }))
        : null;
      const publicCommentary = inspectedStrategyPack?.state === "active" &&
          (inspectedStrategyPack.pack?.id === "inverse-cramer" ||
            inspectedStrategyPack.pack?.id === "public-commentary-tracker")
        ? await (() => {
            const monitorRecord = monitors.find((candidate) =>
              candidate.managedBy?.packId === inspectedStrategyPack.pack?.id);
            const monitor = publicMonitors.find((candidate) =>
              candidate.monitorId === monitorRecord?.monitorId);
            const health = monitor?.publicSourceHealth[0];
            const usesX = monitorRecord?.sources.some(({ canonicalUrl }) => canonicalUrl.startsWith("https://api.x.com/")) ?? false;
            return readPublicCommentaryWorkspacePresentation({
              costMode: usesX ? "pay_per_use" : "first_party",
              credentialStatus: usesX
                ? process.env.X_BEARER_TOKEN ? "configured" : "missing"
                : "not_required",
              estimatedCostUsd: usesX ? "0.005000" : "0.000000",
              monitor: monitorRecord ? {
                lifecycleState: monitorRecord.lifecycleState,
                sourceCheckpoint: monitorRecord.sourceCheckpoint,
              } : null,
              scope,
              sourceStatus: !health ? "disabled"
                : health.healthState === "healthy" ? "healthy"
                : health.healthState === "degraded" ? "degraded"
                : "unavailable",
            });
          })().catch(() => Object.freeze({
            state: "unavailable" as const,
          }))
        : null;
      const strategyPack = congressionalSignals || earningsCallChanges || publicCommentary
        ? Object.freeze({
            ...inspectedStrategyPack,
            ...(congressionalSignals ? { congressionalSignals } : {}),
            ...(earningsCallChanges ? { earningsCallChanges } : {}),
            ...(publicCommentary ? { publicCommentary } : {}),
          })
        : inspectedStrategyPack;
      return {
        ...workspace,
        budget,
        budgetUsage: budgetUsage
          ? {
              ...budgetUsage,
              paidDisplayThisMonth: formatWorkspacePaidMicros(
                budgetUsage.paidMicrosThisMonth,
              ),
              paidDisplayToday: formatWorkspacePaidMicros(
                budgetUsage.paidMicrosToday,
              ),
            }
          : null,
        strategyPack,
        monitors: publicMonitors,
      };
    })),
  };
}

function strategyPackActionSecret(): string {
  const secret = process.env.EVE_OWNER_ALIAS_HMAC_SECRET;
  if (!secret || secret.length < 32) {
    throw new StrategyPackServiceError("strategy_pack_mutations_disabled");
  }
  return secret;
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

export function workspaceHtml(nonce: string, origin: string): string {
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
    input, select, textarea, button {
      min-height: 44px;
      border-radius: 12px;
      font: inherit;
    }
    input, select, textarea {
      width: 100%;
      min-width: 0;
      border: 1px solid transparent;
      padding: 0 12px;
      background: transparent;
      color: var(--text);
      font-size: 16px;
      outline: none;
    }
    select { appearance: none; }
    textarea { min-height: 88px; padding-block: 10px; resize: vertical; }
    input::placeholder, textarea::placeholder { color: var(--muted); opacity: .78; }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
      border-color: #5a5a5a;
      background: #252525;
    }
    .pack-form {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 12px;
    }
    .pack-field { display: grid; gap: 5px; }
    .pack-field.full { grid-column: 1 / -1; }
    .pack-field label, .pack-toggle span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .pack-field input, .pack-field select, .pack-field textarea {
      border-color: var(--line);
      background: #252525;
    }
    .pack-field select[multiple] { min-height: 88px; padding-block: 8px; }
    #pack-configuration-fields { display: contents; }
    .pack-toggle {
      grid-column: 1 / -1;
      min-height: 44px;
      display: flex;
      align-items: center;
      gap: 10px;
      padding-inline: 4px;
    }
    .pack-toggle input { width: 20px; min-height: 20px; height: 20px; }
    .pack-form button { grid-column: 1 / -1; }
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
    .pack-details { margin-top: 7px; }
    .pack-details summary {
      min-height: 44px;
      display: flex;
      align-items: center;
      color: var(--text);
      cursor: pointer;
      font-size: 13px;
      font-weight: 680;
    }
    .pack-details summary:focus-visible {
      outline: 3px solid #686868;
      outline-offset: 2px;
      border-radius: 8px;
    }
    .runtime-row .actions { margin-top: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .runtime-row .actions button { grid-column: auto; }
    .pack-danger { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
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
      .pack-form { grid-template-columns: 1fr; }
      .pack-field.full, .pack-toggle, .pack-form button { grid-column: auto; }
    }
  </style>
</head>
<body>
  <main aria-busy="true">
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
    <section class="create-section" id="pack-create-section" hidden>
      <label class="form-label" for="pack-select">Strategy pack</label>
      <p class="meta" id="pack-catalog-status"></p>
      <form id="pack-create-form" class="pack-form">
        <div class="pack-field full">
          <label for="pack-select">Pack</label>
          <select id="pack-select" required></select>
        </div>
        <div class="pack-field full">
          <label for="pack-name">Session name</label>
          <input id="pack-name" maxlength="40" autocomplete="off" value="IPO Filings" required>
        </div>
        <div id="pack-configuration-fields"></div>
        <label class="pack-toggle" for="pack-activate">
          <input id="pack-activate" type="checkbox">
          <span>Start this schedule now</span>
        </label>
        <button class="primary" type="submit">Create pack session</button>
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
      const main = document.querySelector("main");
      const status = document.querySelector("#status");
      const list = document.querySelector("#workspaces");
      const form = document.querySelector("#create-form");
      const nameInput = document.querySelector("#new-name");
      const packSection = document.querySelector("#pack-create-section");
      const packCatalogStatus = document.querySelector("#pack-catalog-status");
      const packForm = document.querySelector("#pack-create-form");
      const packSelect = document.querySelector("#pack-select");
      const packName = document.querySelector("#pack-name");
      const packConfigurationFields = document.querySelector("#pack-configuration-fields");
      const packActivate = document.querySelector("#pack-activate");
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

      const selectedPack = () => state && state.strategyPackCatalog.find(
        (pack) => pack.id + "@" + pack.version === packSelect.value,
      );

      const configurationChoiceLabel = (value) => {
        const cadence = /^(minutes|hours)_(\d+)$/.exec(value);
        if (cadence) return cadence[2] + " " + cadence[1];
        return value === "off" ? "Off" : value.replaceAll("_", " ");
      };

      const configurationValue = (field, control) => {
        if (field.kind === "bounded_text_list" || field.kind === "impact_hypothesis_list") {
          return [...new Set(control.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))].sort();
        }
        if (field.kind === "daily_local_times" || field.kind === "bounded_token_list") {
          return [...new Set(control.value.split(",").map((item) =>
            field.kind === "bounded_token_list" ? item.trim().toUpperCase() : item.trim()
          ).filter(Boolean))].sort();
        }
        if (field.kind === "x_public_identity") {
          try { return JSON.parse(control.value); } catch { return []; }
        }
        if (field.kind === "canonical_id_list" || field.kind === "catalog_id_list") {
          return Array.from(control.selectedOptions).map((option) => option.value).sort();
        }
        return control.value.trim();
      };

      const readPackConfiguration = (pack) => Object.fromEntries(pack.configuration.map((field) => {
        const control = packConfigurationFields.querySelector('[data-configuration-key="' + field.key + '"]');
        return [field.key, configurationValue(field, control)];
      }));

      const catalogSelectionIssue = (field, control, activationRequested) => {
        const selected = Array.from(control.selectedOptions);
        if (selected.length < field.minimumItems) return "Select at least " + field.minimumItems + " company.";
        if (selected.length > field.maximumItems) return "Select no more than " + field.maximumItems + " companies.";
        if (activationRequested && !selected.some((option) => option.dataset.coverageState !== "coverage_unavailable")) {
          return "Select at least one company with verified coverage before starting the schedule.";
        }
        return null;
      };

      const tokenListIssue = (field, control) => {
        const values = configurationValue(field, control);
        if (values.length < field.minimumItems) return "Enter at least " + field.minimumItems + " symbols.";
        if (values.length > field.maximumItems) return "Enter no more than " + field.maximumItems + " symbols.";
        if (values.some((value) => !/^[A-Z][A-Z0-9.-]{0,15}$/.test(value))) {
          return "Use ticker or token symbols containing only letters, numbers, periods, or hyphens.";
        }
        return null;
      };

      const renderPackConfiguration = () => {
        packConfigurationFields.replaceChildren();
        const pack = selectedPack();
        if (!pack) return;
        packName.value = pack.displayName;
        for (const field of pack.configuration) {
          const wrapper = document.createElement("div");
          wrapper.className = "pack-field" +
            (["bounded_token_list", "bounded_text", "bounded_text_list", "impact_hypothesis_list", "x_public_identity", "canonical_id_list", "catalog_id_list"].includes(field.kind) ? " full" : "");
          const label = document.createElement("label");
          const id = "pack-configuration-" + field.key;
          label.htmlFor = id;
          label.textContent = field.label;
          let control;
          if (field.kind === "bounded_enum" || field.kind === "canonical_id_list" || field.kind === "catalog_id_list") {
            control = document.createElement("select");
            control.multiple = field.kind === "canonical_id_list" || field.kind === "catalog_id_list";
            const choices = field.kind === "catalog_id_list"
              ? field.options
              : field.allowedValues.map((value) => ({ id: value, label: configurationChoiceLabel(value) }));
            if (control.multiple) control.size = Math.min(8, choices.length);
            for (const choice of choices) {
              const option = document.createElement("option");
              option.value = choice.id;
              if (field.kind === "catalog_id_list") {
                option.dataset.coverageState = choice.coverageState;
                option.dataset.searchText = (choice.id + " " + choice.label).toLocaleLowerCase();
              }
              option.textContent = field.kind === "catalog_id_list"
                ? choice.label + " · " + choice.coverageState.replaceAll("_", " ")
                : choice.label;
              option.selected = Array.isArray(field.default)
                ? field.default.includes(choice.id)
                : field.default === choice.id;
              control.append(option);
            }
          } else if (field.kind === "x_public_identity") {
            control = document.createElement("input");
            control.type = "hidden";
            control.value = JSON.stringify(field.default);
          } else {
            control = ["bounded_text_list", "impact_hypothesis_list"].includes(field.kind)
              ? document.createElement("textarea")
              : document.createElement("input");
            control.maxLength = field.kind === "bounded_text"
              ? field.maximumCharacters
              : field.kind === "bounded_token_list"
              ? field.maximumItems * 18
              : ["bounded_text_list", "impact_hypothesis_list"].includes(field.kind) ? 2_000
              : field.kind === "daily_local_times" ? 512 : 80;
            control.autocomplete = "off";
            control.value = Array.isArray(field.default)
              ? field.default.join(["bounded_text_list", "impact_hypothesis_list"].includes(field.kind) ? "\n" : ", ")
              : field.default;
            if (field.kind === "bounded_token_list") {
              control.placeholder = "Add tickers or tokens, separated by commas (for example INTC, BTC)";
              control.setAttribute("aria-description", "Enter up to " + field.maximumItems + " market symbols. Leave empty for all resolved assets.");
            }
          }
          control.id = id;
          control.dataset.configurationKey = field.key;
          control.title = field.description;
          control.required = field.required && (!("minimumItems" in field) || field.minimumItems > 0);
          if (field.kind === "x_public_identity") {
            const profile = document.createElement("input");
            const resolveButton = document.createElement("button");
            const confirmation = document.createElement("label");
            const checkbox = document.createElement("input");
            const identityStatus = document.createElement("p");
            const initial = field.default;
            profile.type = "url";
            profile.value = initial[0];
            profile.placeholder = "https://x.com/handle or @handle";
            profile.autocomplete = "off";
            resolveButton.type = "button";
            resolveButton.textContent = "Resolve public X identity";
            checkbox.type = "checkbox";
            checkbox.checked = false;
            checkbox.disabled = true;
            confirmation.append(checkbox, document.createTextNode(" Confirm this display name and pinned numeric X user ID"));
            identityStatus.className = "runtime-detail";
            identityStatus.setAttribute("role", "status");
            identityStatus.textContent = "Preset suggestion: " + initial[2] + " · @" + initial[1] + " · resolve before confirmation.";
            let resolutionEpoch = 0;
            const invalidate = () => {
              resolutionEpoch += 1;
              checkbox.checked = false;
              checkbox.disabled = true;
              delete control.dataset.resolved;
              delete control.dataset.resolutionReceipt;
              control.value = "[]";
              control.setCustomValidity("Resolve and confirm the pinned X identity before saving.");
            };
            profile.addEventListener("input", invalidate);
            checkbox.addEventListener("change", () => {
              const resolved = control.dataset.resolved ? JSON.parse(control.dataset.resolved) : null;
              control.value = checkbox.checked && resolved
                ? JSON.stringify([...resolved.slice(0, 4), "confirmed"])
                : "[]";
              control.setCustomValidity(checkbox.checked ? "" : "Confirm the pinned X identity before saving.");
            });
            control.value = "[]";
            resolveButton.addEventListener("click", async () => {
              const requestedProfile = profile.value;
              const requestEpoch = ++resolutionEpoch;
              resolveButton.disabled = true;
              identityStatus.textContent = "Resolving public X identity…";
              try {
                const resolved = await request("${PHOTON_WORKSPACE_APP_PATH}/resolve-x-identity", {
                  managerToken: token,
                  profile: requestedProfile,
                  requestId: crypto.randomUUID(),
                });
                if (requestEpoch !== resolutionEpoch || profile.value !== requestedProfile) return;
                const value = [resolved.profileUrl, resolved.username, resolved.displayName, resolved.numericUserId, "confirmed"];
                profile.value = resolved.profileUrl;
                control.dataset.resolved = JSON.stringify(value);
                control.dataset.resolutionReceipt = JSON.stringify(resolved.resolutionReceipt);
                checkbox.checked = false;
                checkbox.disabled = false;
                control.value = "[]";
                control.setCustomValidity("Confirm the pinned X identity before saving.");
                identityStatus.textContent = resolved.displayName + " · @" + resolved.username + " · X user ID " + resolved.numericUserId;
              } catch (error) {
                invalidate();
                identityStatus.textContent = error instanceof Error ? error.message : "Identity resolution failed.";
              } finally {
                resolveButton.disabled = false;
              }
            });
            wrapper.append(label, profile, resolveButton, identityStatus, confirmation, control);
          } else if (field.kind === "catalog_id_list") {
            const search = document.createElement("input");
            const selectorStatus = document.createElement("p");
            const statusId = id + "-status";
            search.type = "search";
            search.autocomplete = "off";
            search.placeholder = "Search ticker, company, or CIK";
            search.setAttribute("aria-label", "Search " + field.label);
            search.setAttribute("aria-controls", id);
            selectorStatus.id = statusId;
            selectorStatus.className = "runtime-detail";
            selectorStatus.setAttribute("role", "status");
            selectorStatus.setAttribute("aria-live", "polite");
            control.setAttribute("aria-describedby", statusId);
            const announceSelection = (message) => {
              const selected = Array.from(control.selectedOptions);
              const unsupported = selected.filter((option) => option.dataset.coverageState === "coverage_unavailable");
              const issue = catalogSelectionIssue(field, control, packActivate.checked);
              control.setAttribute("aria-invalid", String(Boolean(issue)));
              selectorStatus.textContent = message || selected.length + " of " + field.maximumItems +
                " selected" + (unsupported.length ? " · " + unsupported.length + " unsupported" : " · coverage verified") +
                (issue ? " · " + issue : "");
            };
            search.addEventListener("input", () => {
              const query = search.value.trim().toLocaleLowerCase();
              const matches = Array.from(control.options).filter((option) =>
                !query || option.dataset.searchText.includes(query));
              for (const option of control.options) option.hidden = !matches.includes(option);
              const exact = matches.filter((option) => option.value === query ||
                option.textContent.toLocaleLowerCase().startsWith(query + " —"));
              announceSelection(!query
                ? matches.length + " companies available"
                : matches.length === 0
                  ? "No company matches this search"
                  : exact.length === 1
                    ? "Exact match · press Enter to add " + exact[0].textContent
                    : matches.length === 1
                      ? "One result · press Enter to add " + matches[0].textContent
                      : "Ambiguous search · " + matches.length + " results");
            });
            search.addEventListener("keydown", (event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const match = Array.from(control.options).find((option) => !option.hidden);
              if (!match) return announceSelection("No result can be added");
              if (match.selected) return announceSelection("Duplicate selection · " + match.textContent + " is already selected");
              if (control.selectedOptions.length >= field.maximumItems) {
                control.setAttribute("aria-invalid", "true");
                return announceSelection("Selection limit reached · remove a company before adding another");
              }
              match.selected = true;
              announceSelection("Selected " + match.textContent + " · unsaved changes");
            });
            control.addEventListener("change", () => {
              if (control.selectedOptions.length > field.maximumItems) {
                control.selectedOptions[control.selectedOptions.length - 1].selected = false;
                announceSelection("Selection limit reached · the last company was not added");
              } else {
                announceSelection("Company selection changed · unsaved changes");
              }
            });
            wrapper.append(label, search, control, selectorStatus);
            announceSelection("Issuer catalog loaded · " + control.options.length + " companies available");
          } else if (field.kind === "bounded_token_list") {
            const selectorStatus = document.createElement("p");
            const statusId = id + "-status";
            selectorStatus.id = statusId;
            selectorStatus.className = "runtime-detail";
            selectorStatus.setAttribute("role", "status");
            selectorStatus.setAttribute("aria-live", "polite");
            control.setAttribute("aria-describedby", statusId);
            const validateTokens = () => {
              const issue = tokenListIssue(field, control);
              control.setCustomValidity(issue || "");
              control.setAttribute("aria-invalid", String(Boolean(issue)));
              const count = configurationValue(field, control).length;
              selectorStatus.textContent = issue || count + " of " + field.maximumItems +
                " symbols · " + (count === 0 ? "all resolved assets may alert" : "alerts filtered to this watchlist");
            };
            control.addEventListener("input", validateTokens);
            wrapper.append(label, control, selectorStatus);
            validateTokens();
          } else {
            wrapper.append(label, control);
          }
          packConfigurationFields.append(wrapper);
        }
      };

      const promptPackConfiguration = (pack, current) => {
        const configuration = {};
        for (const field of pack.configuration) {
          const existing = current[field.key] === undefined ? field.default : current[field.key];
          const choices = "allowedValues" in field ? " (" + field.allowedValues.join(", ") + ")" : "";
          const answer = prompt(field.label + choices,
            Array.isArray(existing) ? existing.join(["bounded_text_list", "impact_hypothesis_list"].includes(field.kind) ? "\n" : ", ") : existing);
          if (answer === null) return null;
          if (["bounded_token_list", "bounded_text_list", "impact_hypothesis_list", "daily_local_times", "canonical_id_list", "catalog_id_list"].includes(field.kind)) {
            const separator = ["bounded_text_list", "impact_hypothesis_list"].includes(field.kind) ? /\r?\n/ : ",";
            configuration[field.key] = [...new Set(answer.split(separator)
              .map((value) => field.kind === "bounded_token_list" ? value.trim().toUpperCase() : value.trim())
              .filter(Boolean))].sort();
          } else if (field.kind === "x_public_identity") {
            configuration[field.key] = existing;
          } else {
            configuration[field.key] = answer.trim();
          }
        }
        return configuration;
      };

      const strategyPackRow = (workspace) => {
        const strategyPack = workspace.strategyPack;
        const row = document.createElement("div");
        row.className = "runtime-row";
        const name = document.createElement("p");
        name.className = "name";
        name.textContent = "Strategy pack";
        const identity = document.createElement("p");
        identity.className = "meta";
        if (!strategyPack || strategyPack.state === "unbound") {
          identity.textContent = "None installed";
          row.append(name, identity);
          return row;
        }
        const pack = strategyPack.pack || strategyPack.legacyPack;
        const packLabel = pack
          ? (pack.displayName || pack.id) + " · " + pack.version
          : "Unknown pack";
        identity.textContent = packLabel + " · " + strategyPack.state;
        const health = document.createElement("p");
        health.className = "runtime-detail";
        health.textContent = strategyPack.state === "active"
          ? "Health · " + strategyPack.health.status + " · maturity " + (pack?.maturity || "unknown")
          : "Unavailable · " + (strategyPack.reasonCode || "unknown reason");
        row.append(name, identity, health);
        if (pack?.id === "inverse-cramer" && pack.version === "1.1.0") {
          const upgrade = document.createElement("p");
          upgrade.className = "runtime-detail";
          upgrade.textContent = "Upgrade available · create a new Inverse Cramer session to use cadence-derived immediate backfill in 1.2.0. This historical 1.1.0 binding will not be rewritten.";
          row.append(upgrade);
        }
        for (const monitor of strategyPack.managedMonitors || []) {
          const managed = document.createElement("p");
          managed.className = "runtime-detail";
          managed.textContent = "Managed work · " + monitor.name + " · " + monitor.lifecycleState +
            " · next " + (monitor.nextOccurrenceAt || "none") +
            (monitor.lastErrorCode ? " · " + monitor.lastErrorCode : "");
          row.append(managed);
        }
        const canMutate = workspace.id === state.activeWorkspaceId &&
          workspace.status === "active" && state.packMutationIdentity;
        if (canMutate) {
          const controls = document.createElement("div");
          controls.className = "actions";
          if (strategyPack.state === "active") {
            const configure = document.createElement("button");
            configure.type = "button";
            configure.textContent = "Configure";
            configure.disabled = busy;
            configure.addEventListener("click", () => void handlePackLifecycle("configure", workspace));
            controls.append(configure);
          }
          if (strategyPack.state === "active" || strategyPack.state === "unavailable") {
            const danger = document.createElement("div");
            danger.className = "pack-danger";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "danger";
            remove.textContent = "Remove pack";
            remove.disabled = busy;
            remove.addEventListener("click", () => void handlePackLifecycle("remove", workspace));
            danger.append(remove);
            controls.append(danger);
          }
          row.append(controls);
        }
        return row;
      };

      const strategyPackSummary = (strategyPack) => {
        if (!strategyPack || strategyPack.state === "unbound") return null;
        const pack = strategyPack.pack || strategyPack.legacyPack;
        const row = document.createElement("div");
        row.className = "runtime-row";
        const details = document.createElement("details");
        details.className = "pack-details";
        const detailsSummary = document.createElement("summary");
        detailsSummary.textContent = "Pack summary";
        details.append(detailsSummary);
        const purpose = document.createElement("p");
        purpose.className = "runtime-detail";
        purpose.textContent = pack?.description ? "Purpose · " + pack.description : "Purpose unavailable";
        details.append(purpose);
        if (strategyPack.configuration) {
          const configuration = document.createElement("p");
          configuration.className = "runtime-detail";
          configuration.textContent = "Configuration · " + Object.entries(strategyPack.configuration)
            .map(([key, value]) => {
              const field = pack?.configuration?.find((candidate) => candidate.key === key);
              const rendered = Array.isArray(value)
                ? (value.length ? value.join(", ") : "none selected (incomplete)")
                : value;
              return (field?.label || key) + ": " + rendered;
            })
            .join(" · ");
          details.append(configuration);
        }
        if (pack?.evidenceContracts?.length) {
          const evidence = document.createElement("p");
          evidence.className = "runtime-detail";
          evidence.textContent = "Pinned evidence · " + pack.evidenceContracts
            .map((contract) => contract.id + "@" + contract.version + " · " + contract.digest.slice(0, 12))
            .join(" · ");
          details.append(evidence);
        }
        if (strategyPack.capabilities && strategyPack.capabilities.length) {
          const capabilities = document.createElement("p");
          capabilities.className = "runtime-detail";
          capabilities.textContent = "Capabilities · " + strategyPack.capabilities
            .map((capability) => capability.id + ": " + capability.status).join(" · ");
          details.append(capabilities);
        }
        if (strategyPack.sources && strategyPack.sources.length) {
          const sources = document.createElement("p");
          sources.className = "runtime-detail";
          sources.textContent = "Sources · " + strategyPack.sources
            .map((source) => source.sourceId + ": " + source.status + " · " + source.canonicalUrl)
            .join(" · ");
          details.append(sources);
        }
        const congressional = strategyPack.congressionalSignals;
        if (congressional) {
          const coverage = document.createElement("p");
          coverage.className = "runtime-detail";
          coverage.textContent = congressional.coverage
            ? "House-only extraction coverage · " + congressional.coverage.state + " · " +
              congressional.coverage.consecutiveDays + " consecutive day(s) · through " +
              congressional.coverage.lastCompleteOn
            : "House-only extraction coverage · " + congressional.state;
          const outcomes = document.createElement("p");
          outcomes.className = "runtime-detail";
          outcomes.textContent = congressional.state === "unavailable"
            ? "Signal outcomes · unavailable"
            : "Signal outcomes · " + congressional.outcomeCounts.total + " total · " +
              congressional.outcomeCounts.priority + " priority · " + congressional.outcomeCounts.review +
              " review · " + congressional.outcomeCounts.recordOnly + " record only · " +
              congressional.outcomeCounts.alertEligible + " alert eligible";
          const latest = document.createElement("p");
          latest.className = "runtime-detail";
          latest.textContent = congressional.latestSignal
            ? "Latest signal · " + congressional.latestSignal.band + " · " +
              congressional.latestSignal.createdAt + " · " + congressional.latestSignal.signalRevisionId +
              " · " + congressional.latestSignal.caveat
            : "Latest signal · none";
          details.append(coverage, outcomes, latest);
        }
        const earnings = strategyPack.earningsCallChanges;
        if (earnings) {
          const coverageHeading = document.createElement("p");
          coverageHeading.className = "runtime-detail";
          coverageHeading.textContent = "Company coverage";
          coverageHeading.setAttribute("role", "status");
          details.append(coverageHeading);
          for (const issuer of earnings.coverage || []) {
            const coverage = document.createElement("p");
            coverage.className = "runtime-detail";
            coverage.textContent = issuer.ticker + " · " + issuer.companyName + " · " +
              issuer.state.replaceAll("_", " ") +
              (issuer.reasonCode ? " · " + issuer.reasonCode.replaceAll("_", " ") : "") +
              (issuer.lastSuccessfulEventAt ? " · last success " + issuer.lastSuccessfulEventAt : "");
            coverage.setAttribute("role", "status");
            details.append(coverage);
          }
          if (earnings.state === "unavailable") {
            const unavailable = document.createElement("p");
            unavailable.className = "runtime-detail";
            unavailable.textContent = "Accepted analysis · unavailable";
            details.append(unavailable);
          } else if (!earnings.latestAnalysis) {
            const none = document.createElement("p");
            none.className = "runtime-detail";
            none.textContent = "Accepted analysis · none yet; the baseline and non-alert outcomes remain silent";
            details.append(none);
          } else {
            const analysis = earnings.latestAnalysis;
            const stance = document.createElement("p");
            stance.className = "runtime-detail";
            stance.textContent = "Stance and conditional forecast · " +
              (analysis.recommendation ? analysis.recommendation.stance + " · " + analysis.recommendation.conditionalImplication : "no view") +
              (analysis.forecast ? " · " + analysis.forecast.direction + " · " + analysis.forecast.horizon.replaceAll("_", " ") : "") +
              " · confidence " + analysis.confidence;
            const support = document.createElement("p");
            support.className = "runtime-detail";
            support.textContent = "Supporting changes and metrics · " +
              [...analysis.facts, ...analysis.inferences].map((item) => item.statement).join(" · ") +
              " · deterministic score " + analysis.materiality.deterministicScore + "/100";
            const counter = document.createElement("p");
            counter.className = "runtime-detail";
            counter.textContent = "Counterevidence and invalidation · " +
              (analysis.counterevidence.map((item) => item.statement).join(" · ") || "none stated") +
              (analysis.forecast ? " · " + analysis.forecast.invalidationConditions.join(" · ") : "");
            const analysisCoverage = document.createElement("p");
            analysisCoverage.className = "runtime-detail";
            analysisCoverage.textContent = "Coverage and no-view explanation · outcome " + analysis.outcome +
              (analysis.unknowns.length ? " · " + analysis.unknowns.join(" · ") : " · complete cited comparison");
            const citations = document.createElement("details");
            citations.className = "pack-details";
            const citationsSummary = document.createElement("summary");
            citationsSummary.textContent = "Current and prior citations";
            citations.append(citationsSummary);
            for (const source of analysis.sources) {
              const sourceLine = document.createElement("p");
              sourceLine.className = "runtime-detail";
              sourceLine.textContent = source.role.replaceAll("_", " ") + " · " + source.fiscalPeriod +
                " · " + source.eventRevisionId + " · " + source.canonicalUrl;
              citations.append(sourceLine);
            }
            const locatorLine = document.createElement("p");
            locatorLine.className = "runtime-detail";
            locatorLine.textContent = "Exact spans · " + [...analysis.facts, ...analysis.inferences, ...analysis.counterevidence]
              .flatMap((item) => item.citations)
              .map((citation) => citation.eventRevisionId + ":" + citation.start + "-" + citation.end)
              .join(" · ");
            citations.append(locatorLine);
            details.append(stance, support, counter, analysisCoverage, citations);
          }
        }
        const commentary = strategyPack.publicCommentary;
        if (commentary) {
          const status = document.createElement("p");
          status.className = "runtime-detail";
          status.textContent = commentary.state === "unavailable"
            ? "Public commentary runtime · unavailable"
            : "Public commentary runtime · monitor " + commentary.monitorState +
              " · source " + commentary.sourceStatus + " · credential " + commentary.credentialStatus +
              " · lifecycle " + commentary.lifecycle + " · checkpoint " + (commentary.sourceCheckpoint || "none");
          const cost = document.createElement("p");
          cost.className = "runtime-detail";
          cost.textContent = commentary.state === "unavailable"
            ? "Cost and coverage · unavailable"
            : "Cost and coverage · " + commentary.cost.mode.replaceAll("_", " ") +
              " · estimated $" + commentary.cost.estimatedUsd + " · related coverage " + commentary.coverage;
          const outcomes = document.createElement("p");
          outcomes.className = "runtime-detail";
          outcomes.textContent = commentary.state === "unavailable"
            ? "Analysis outcomes · unavailable"
            : "Analysis outcomes · accepted " + commentary.outcomes.accepted +
              " · no view " + commentary.outcomes.noView + " · abstained " + commentary.outcomes.abstained +
              " · quarantined " + commentary.outcomes.quarantined + " · corrected " + commentary.outcomes.corrected +
              " · retracted " + commentary.outcomes.retracted;
          const latest = document.createElement("p");
          latest.className = "runtime-detail";
          latest.textContent = commentary.state === "unavailable"
            ? "Latest analysis · unavailable"
            : commentary.latestAnalysis
              ? "Latest analysis · " + commentary.latestAnalysis.outcome + " · direction " +
                (commentary.latestAnalysis.direction || "none") + " · confidence " + commentary.latestAnalysis.confidence +
                " · horizon " + commentary.latestAnalysis.horizon + " · " + commentary.latestAnalysis.statementRevisionId +
                " · " + commentary.latestAnalysis.directionDisclosure
              : "Latest analysis · none";
          details.append(status, cost, outcomes, latest);
        }
        row.append(details);
        return row;
      };

      const renderPackCatalog = () => {
        packSelect.replaceChildren();
        const catalog = state && state.strategyPackCatalog || [];
        packSection.hidden = !state;
        packCatalogStatus.textContent = catalog.length === 0
          ? "No reviewed strategy packs are currently available."
          : catalog.length + " reviewed pack(s) available.";
        packForm.hidden = catalog.length === 0 || !state.packMutationIdentity;
        for (const pack of catalog) {
          const option = document.createElement("option");
          option.value = pack.id + "@" + pack.version;
          option.textContent = pack.displayName + " · " + pack.version + " · " + pack.maturity;
          option.disabled = pack.availability !== "available";
          packSelect.append(option);
        }
        renderPackConfiguration();
      };

      const render = () => {
        main.setAttribute("aria-busy", String(busy));
        list.replaceChildren();
        for (const control of document.querySelectorAll("form input, form select, form textarea, form button")) {
          control.disabled = busy;
        }
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
            (monitor) => monitor.lifecycleState !== "enabled" &&
              monitor.lifecycleState !== "retired",
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
          runtime.append(strategyPackRow(workspace));
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
            const publicSourceHealth = (monitor.publicSourceHealth || []).map((health) => {
              const detail = document.createElement("p");
              detail.className = "runtime-detail";
              const lastComplete = health.lastCompleteAcquisition
                ? health.lastCompleteAcquisition.status + " at " + health.lastCompleteAcquisition.observedAt
                : "never";
              const lastOutcome = health.lastOutcome
                ? health.lastOutcome.status + " / " + health.lastOutcome.coverage +
                  (health.lastOutcome.failureStage
                    ? " / " + health.lastOutcome.failureStage + ":" + health.lastOutcome.errorCode
                    : "")
                : "none";
              detail.textContent = "Adapter health · " + health.sourceId + " · " + health.runtimeState +
                " · " + health.healthState + " · cursor " + health.cursor.revision +
                " · last complete " + lastComplete + " · last outcome " + lastOutcome +
                " · extraction " + health.extraction.state + " (" + health.extraction.complete +
                " complete, " + health.extraction.partial + " partial, " + health.extraction.unsupported +
                " unsupported) · subscription " + health.subscription.state +
                " / lag " + health.subscription.lag;
              return detail;
            });
            const monitorActions = document.createElement("div");
            monitorActions.className = "actions";
            monitorActions.append(
              runtimeButton(monitor.lifecycleState === "enabled" ? "Pause" : "Resume",
                monitor.lifecycleState === "enabled" ? "monitor-pause" : "monitor-resume", workspace, monitor),
              runtimeButton("Edit schedule", "monitor-schedule", workspace, monitor),
            );
            row.append(monitorName, monitorMeta, monitorSchedule, monitorSources,
              ...publicSourceHealth, monitorActions);
            runtime.append(row);
          }
          const packSummary = strategyPackSummary(workspace.strategyPack);
          if (packSummary) runtime.append(packSummary);
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
                workspace.budgetUsage.paidDisplayToday + " paid today · " +
                workspace.budgetUsage.paidDisplayThisMonth + " paid this month · " +
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
          main.setAttribute("aria-busy", "false");
          return;
        }
        try {
          status.classList.remove("error");
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/state", {
            managerToken: token,
          });
          renderPackCatalog();
          status.textContent =
            "Active session: " +
            state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId).name;
          render();
        } catch (error) {
          status.classList.add("error");
          status.textContent =
            error instanceof Error ? error.message : "Could not load sessions.";
        } finally {
          main.setAttribute("aria-busy", "false");
        }
      };

      const mutate = async (action) => {
        if (!state || busy) return false;
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
          return true;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Could not update sessions.";
          if (error && error.status === 409) await load();
          status.classList.add("error");
          status.textContent = message;
          return false;
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

      const packMutate = async (action) => {
        if (!state || busy || !state.packMutationIdentity) return;
        busy = true;
        render();
        status.classList.remove("error");
        const operation = action.action === "strategy-pack-configure"
          ? "configuration"
          : action.action === "strategy-pack-remove"
            ? "removal"
            : "creation";
        const pendingWorkspace = state.workspaces.find(
          (workspace) => workspace.id === action.sourceWorkspaceId,
        );
        const affected = (pendingWorkspace?.strategyPack?.managedMonitors || [])
          .map((monitor) => monitor.name).join(", ") || "none";
        const cadence = action.configuration
          ? action.configuration.cadenceMinutes ??
            ((action.configuration.dailyTimes || []).join(", ") + " · " + action.configuration.timezone)
          : "removed";
        status.textContent = "Applying strategy-pack " + operation + "… Affected managed work: " + affected +
          ". Cadence: " + cadence + ". Budget timing follows the configured timezone. Conflicting controls are disabled.";
        try {
          state = await request("${PHOTON_WORKSPACE_APP_PATH}/pack-action", {
            ...action,
            expectedRoutingRevision: state.revision,
            managerToken: token,
            packMutationIdentity: state.packMutationIdentity,
          });
          renderPackCatalog();
          const receipt = state.packMutation && state.packMutation.receipt;
          status.textContent = receipt
            ? "Strategy-pack " + receipt.outcome + ". Receipt " + receipt.mutationId.slice(0, 12) +
              " · binding revision " + receipt.bindingRevision +
              ". Future messages start a fresh conversation generation; durable research remains."
            : "Strategy-pack update completed.";
        } catch (error) {
          status.classList.add("error");
          status.textContent = error instanceof Error
            ? error.message
            : "Could not complete the strategy-pack update.";
          if (error && error.status === 409) await load();
        } finally {
          busy = false;
          render();
        }
      };

      const handlePackLifecycle = async (action, workspace) => {
        const strategyPack = workspace.strategyPack;
        if (!strategyPack || !strategyPack.bindingRevision) return;
        const managed = (strategyPack.managedMonitors || []).map((monitor) => monitor.name).join(", ") || "none";
        if (action === "configure") {
          const current = strategyPack.configuration || {};
          const pack = strategyPack.pack;
          if (!pack || !pack.configuration) return;
          const configuration = promptPackConfiguration(pack, current);
          if (!configuration) return;
          if (!confirm("Configure this pack? Affected managed work: " + managed +
            ". Cadence and budget timing may change. Managed work will pause, future messages will start a fresh conversation generation, and durable research will remain.")) return;
          await packMutate({
            action: "strategy-pack-configure",
            configuration,
            confirmedConsequences: true,
            expectedBindingRevision: strategyPack.bindingRevision,
            sourceWorkspaceGeneration: workspace.generation,
            sourceWorkspaceId: workspace.id,
          });
          return;
        }
        if (!confirm("Remove this pack non-destructively? Pack-managed work will retire: " + managed +
          ". Future messages will start a fresh conversation generation. Durable brief, findings, alerts, checkpoints, and audit history will remain.")) return;
        await packMutate({
          action: "strategy-pack-remove",
          confirmedConsequences: true,
          expectedBindingRevision: strategyPack.bindingRevision,
          sourceWorkspaceGeneration: workspace.generation,
          sourceWorkspaceId: workspace.id,
        });
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
        const created = await mutate({ action: "create", name, select: true });
        if (created) {
          nameInput.value = "";
        } else {
          nameInput.focus();
        }
      });

      packForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!state) return;
        if (!packForm.reportValidity()) {
          status.classList.add("error");
          status.textContent = "Complete the first invalid strategy-pack field before saving.";
          packForm.querySelector(":invalid")?.focus();
          return;
        }
        const selected = selectedPack();
        const sourceWorkspace = state.workspaces.find(
          (workspace) => workspace.id === state.activeWorkspaceId,
        );
        const name = packName.value.trim();
        if (!selected || !sourceWorkspace || !name) return;
        const invalidCatalogControl = selected.configuration
          .filter((field) => field.kind === "catalog_id_list")
          .map((field) => ({
            control: packConfigurationFields.querySelector('[data-configuration-key="' + field.key + '"]'),
            field,
          }))
          .find(({ control, field }) => catalogSelectionIssue(field, control, packActivate.checked));
        if (invalidCatalogControl) {
          invalidCatalogControl.control.setAttribute("aria-invalid", "true");
          status.classList.add("error");
          status.textContent = catalogSelectionIssue(
            invalidCatalogControl.field,
            invalidCatalogControl.control,
            packActivate.checked,
          );
          invalidCatalogControl.control.focus();
          return;
        }
        const invalidTokenControl = selected.configuration
          .filter((field) => field.kind === "bounded_token_list")
          .map((field) => ({
            control: packConfigurationFields.querySelector('[data-configuration-key="' + field.key + '"]'),
            field,
          }))
          .find(({ control, field }) => tokenListIssue(field, control));
        if (invalidTokenControl) {
          invalidTokenControl.control.setAttribute("aria-invalid", "true");
          status.classList.add("error");
          status.textContent = tokenListIssue(invalidTokenControl.field, invalidTokenControl.control);
          invalidTokenControl.control.focus();
          return;
        }
        const unconfirmedIdentity = selected.configuration
          .filter((field) => field.kind === "x_public_identity")
          .map((field) => packConfigurationFields.querySelector('[data-configuration-key="' + field.key + '"]'))
          .find((control) => configurationValue({ kind: "x_public_identity" }, control)[4] !== "confirmed");
        if (unconfirmedIdentity) {
          status.classList.add("error");
          status.textContent = "Resolve and confirm the pinned numeric X identity before saving.";
          return;
        }
        await packMutate({
          action: "strategy-pack-create",
          activateMonitorResourceIds: packActivate.checked
            ? selected.monitors.map((monitor) => monitor.resourceId)
            : [],
          configuration: readPackConfiguration(selected),
          name,
          packId: selected.id,
          packVersion: selected.version,
          sourceWorkspaceGeneration: sourceWorkspace.generation,
          sourceWorkspaceId: sourceWorkspace.id,
          xIdentityResolutionReceipt: (() => {
            const control = packConfigurationFields.querySelector('[data-configuration-key="xIdentity"]');
            return control && control.dataset.resolutionReceipt
              ? JSON.parse(control.dataset.resolutionReceipt)
              : undefined;
          })(),
        });
      });

      packSelect.addEventListener("change", renderPackConfiguration);

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
            ? await publicManagerState(scope.principalId, scope.threadId, state)
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
              ? await publicManagerState(scope.principalId, scope.threadId, result.state)
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
    POST(`${PHOTON_WORKSPACE_APP_PATH}/resolve-x-identity`, async (request) => {
      const body = await readJson(request, xIdentityRequestSchema, 2 * 1_024);
      if (body instanceof Response) return body;
      const managerScope = await getPhotonWorkspaceManagerScope(body.managerToken);
      if (!managerScope) return json({ error: "This session manager link expired." }, 410);
      try {
        requirePhotonOwnerAccess({ principalId: managerScope.principalId, resource: "manager" });
        const requestClaim = await claimPhotonWorkspaceManagerRequest(body.managerToken, body.requestId);
        if (requestClaim === "unavailable") return json({ error: "This session manager link expired." }, 410);
        if (requestClaim === "replayed") return json({ error: "That identity request was already consumed." }, 409);
        const normalized = normalizeXPublicProfile(body.profile);
        const cacheKey = `${managerScope.principalId}\0${normalized.username.toLocaleLowerCase("en-US")}`;
        const now = new Date();
        let identity = xIdentityCache.get(cacheKey)?.expiresAt && xIdentityCache.get(cacheKey)!.expiresAt > now.getTime()
          ? xIdentityCache.get(cacheKey)!.identity
          : null;
        if (!identity) {
          const state = await getPhotonWorkspaceManagerState(body.managerToken);
          if (!state) return json({ error: "This session manager link expired." }, 410);
          const active = state.activeWorkspace;
          const scope = authorizePhotonWorkspaceControlPlaneStore({
            principalId: managerScope.principalId,
            resource: "manager",
            workspaceId: active.id,
          });
          const budget = await readWorkspaceDocument("budget", scope);
          if (!budget) throw new Error("public_commentary_budget_policy_unresolved");
          const runId = `x-identity.${body.requestId}`;
          await reserveWorkspaceRunBudget({
            inputTokens: 0,
            kind: "paid_source_attempt",
            now,
            outputTokens: 0,
            paidCostCeiling: { amount: "0.005000", kind: "known" },
            policy: budget.value,
            policyRevision: budget.revision,
            runId,
            scope,
          });
          try {
            identity = await resolveXPublicIdentity({ profile: body.profile });
            await reconcileWorkspaceRunBudget({
              actualInputTokens: 0,
              actualOutputTokens: 0,
              actualPaidCost: "0.005000",
              now,
              outcome: "reconciled",
              runId,
              scope,
            });
          } catch (error) {
            await reconcileWorkspaceRunBudget({ now, outcome: "uncertain", runId, scope });
            throw error;
          }
          xIdentityCache.set(cacheKey, Object.freeze({ expiresAt: now.getTime() + 15 * 60_000, identity }));
          while (xIdentityCache.size > 64) xIdentityCache.delete(xIdentityCache.keys().next().value!);
        }
        return json({
          ...identity,
          resolutionReceipt: mintXPublicIdentityResolutionReceipt(identity, {
            issuedAt: now,
            principalId: managerScope.principalId,
            threadId: managerScope.threadId,
          }, strategyPackActionSecret()),
        });
      } catch (error) {
        if (error instanceof OwnerIdentityDeniedError) return json({ error: "This identity is not authorized." }, 403);
        return json({ error: error instanceof Error ? error.message : "x_identity_unavailable" }, 422);
      }
    }),
    POST(`${PHOTON_WORKSPACE_APP_PATH}/pack-action`, async (request) => {
      const body = await readJson(request, photonStrategyPackActionRequestSchema, 16 * 1_024);
      if (body instanceof Response) return body;
      const managerScope = await getPhotonWorkspaceManagerScope(body.managerToken);
      if (!managerScope) {
        return json({ error: "This session manager link expired." }, 410);
      }
      try {
        if (resolvePhotonIngressRolloutMode() !== "durable") {
          return json({ error: "Strategy packs require durable session routing." }, 403);
        }
        requirePhotonOwnerAccess({
          principalId: managerScope.principalId,
          resource: "manager",
        });
        const approvalActivity = await getCurrentPhotonApprovalActivity(
          managerScope,
        ).catch(() => "active" as const);
        if (approvalActivity) {
          return json({
            error: "Session changes are temporarily unavailable while another protected action is pending.",
          }, 409);
        }
        const routing = await getPhotonWorkspaceManagerState(body.managerToken);
        if (!routing) {
          return json({ error: "This session manager link expired." }, 410);
        }
        let packMutationIdentity;
        try {
          packMutationIdentity = verifySpectrumStrategyPackMutationIdentity(
            body.packMutationIdentity,
            strategyPackActionSecret(),
          );
        } catch (error) {
          if (
            error instanceof StrategyPackServiceError &&
            error.code === "strategy_pack_invalid_request"
          ) {
            return json({ error: "The strategy-pack action expired. Refresh and try again." }, 409);
          }
          throw error;
        }
        if (
          packMutationIdentity.transport !== "spectrum" ||
          packMutationIdentity.expectedRegistryRevision !== body.expectedRoutingRevision ||
          packMutationIdentity.sourceWorkspaceId !== body.sourceWorkspaceId ||
          packMutationIdentity.sourceWorkspaceGeneration !== body.sourceWorkspaceGeneration
        ) {
          return json({ error: "The strategy-pack action is stale. Refresh and try again." }, 409);
        }
        const sourceWorkspace = routing.workspaces.find((workspace) =>
          workspace.id === body.sourceWorkspaceId &&
          workspace.status === "active",
        );
        if (!sourceWorkspace) {
          return json({ error: "The source session changed. Refresh and try again." }, 409);
        }
        const lifecycleBase = {
          expectedRegistryRevision: body.expectedRoutingRevision,
          principalId: managerScope.principalId,
          requestIdentity: packMutationIdentity,
          sourceAssignment: {
            generation: body.sourceWorkspaceGeneration,
            workspaceId: sourceWorkspace.id,
          },
          threadId: managerScope.threadId,
        };
        const dependencies = {
          capabilityInventory: STRATEGY_PACK_CAPABILITY_INVENTORY,
        };
        const result = body.action === "strategy-pack-create"
          ? await createStrategyPackWorkspaceFromSelection({
              ...lifecycleBase,
              activateMonitorResourceIds: body.activateMonitorResourceIds,
              configuration: body.configuration,
              name: body.name,
              packId: body.packId,
              packVersion: body.packVersion,
            }, dependencies)
          : body.action === "strategy-pack-configure"
            ? await configureStrategyPackWorkspaceFromSelection({
                ...lifecycleBase,
                confirmedConsequences: body.confirmedConsequences,
                configuration: body.configuration,
                expectedBindingRevision: body.expectedBindingRevision,
              }, dependencies)
            : await removeStrategyPackWorkspaceFromSelection({
                ...lifecycleBase,
                confirmedConsequences: body.confirmedConsequences,
                expectedBindingRevision: body.expectedBindingRevision,
              }, dependencies);
        const refreshed = await getPhotonWorkspaceManagerState(body.managerToken);
        if (!refreshed) {
          return json({ error: "This session manager link expired." }, 410);
        }
        return json({
          ...(await publicManagerState(managerScope.principalId, managerScope.threadId, refreshed)),
          packMutation: result,
        });
      } catch (error) {
        if (error instanceof OwnerIdentityDeniedError) {
          return json({ error: "This identity is not authorized." }, 403);
        }
        if (error instanceof PhotonIngressRolloutError) {
          return json({ error: "Eve's iMessage rollout configuration is incomplete." }, 503);
        }
        if (error instanceof StrategyPackServiceError) {
          const status = error.code === "strategy_pack_mutation_conflict" ||
              error.code === "strategy_pack_mutation_payload_conflict" ||
              error.code === "strategy_pack_source_assignment_stale"
            ? 409
            : error.code === "strategy_pack_invalid_request"
              ? 400
              : error.code === "strategy_pack_unavailable"
                ? 422
                : 403;
          return json({ error: error.code }, status);
        }
        console.error("[photon.workspace] Strategy pack action failed", {
          action: body.action,
          error_type: "storage_failure",
        });
        return json({
          error: "Eve could not confirm the strategy-pack session. Refresh before trying again.",
        }, 503);
      }
    }),
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
                nextOccurrenceAt: resolveStrategyPackInitialMonitorDueAt({
                  activate: monitor.sourceCheckpoint.contentDigest === null,
                  now,
                  packId: monitor.managedBy?.packId ?? "",
                  scheduledAt: next.scheduledAt,
                }),
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
          ? json(await publicManagerState(managerScope.principalId, managerScope.threadId, refreshed))
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
