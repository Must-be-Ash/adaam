import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../agent/channels/photon-workspace-app.ts", import.meta.url), "utf8");
for (const required of [
  "listWorkspaceMonitors",
  'readWorkspaceDocument("budget"',
  "readWorkspaceBudgetLedger",
  "summarizeWorkspaceBudgetUsage",
  "formatWorkspacePaidMicros",
  'action: z.enum(["monitor-pause", "monitor-resume"])',
  'action: z.literal("monitor-schedule")',
  'action: z.literal("workspace-budget")',
  "expectedMonitorRevision",
  "expectedBudgetRevision",
  "expectedRoutingRevision",
  "claimPhotonWorkspaceManagerRequest",
  "listStrategyPacks",
  "inspectStrategyPackWorkspace",
  "createStrategyPackWorkspaceFromSelection",
  "configureStrategyPackWorkspaceFromSelection",
  "removeStrategyPackWorkspaceFromSelection",
  "verifySpectrumStrategyPackMutationIdentity",
  'POST(`${PHOTON_WORKSPACE_APP_PATH}/pack-action`',
  "strategyPack",
  "strategyPackCatalog",
  "Strategy pack",
  "Create pack session",
  "packMutationIdentity",
  'document.querySelectorAll("form input, form select, form button")',
  "Applying strategy-pack ",
  'action: z.literal("strategy-pack-configure")',
  'action: z.literal("strategy-pack-remove")',
  "confirmedConsequences: z.literal(true)",
  "Affected managed work:",
  "future messages will start a fresh conversation generation",
  "durable research will remain",
  "Pack summary",
  "No reviewed strategy packs are currently available.",
  "Strategy-pack update completed.",
  '". Receipt " + receipt.mutationId.slice(0, 12)',
  '" · binding revision " + receipt.bindingRevision',
  "crypto.randomUUID()",
  "monitor.nextOccurrenceAt",
  "monitor.lastRunAt",
  "monitor.lastErrorCode",
  "formatSchedule(monitor.schedule)",
  "source.canonicalUrl",
  "maximumInputTokensPerRun",
  "maximumOutputTokensPerDay",
  "maximumPaidPerMonth",
  "paidMicrosThisMonth",
  "paidDisplayThisMonth",
  "activeWorkers",
  "enabledMonitors",
  "pausedMonitors",
  "errorMonitors",
  "ownerTimezone",
  "unknownPriceFallbackCeiling",
  "Edit schedule",
  "Edit budget",
  "ask Eve in chat to list, pause, resume, reschedule, retire, or update the budget for a monitor",
  "suspendWorkspaceMonitorsForArchive",
  "pauseWorkspaceMonitorsAfterRestore",
]) assert.ok(source.includes(required), `Missing manager runtime contract: ${required}`);
assert.equal(/action\.action === "start-fresh"[\s\S]{0,160}suspendWorkspaceMonitorsForArchive/u.test(source), false);
assert.match(
  source,
  /readWorkspaceBudgetLedger\(scope\)\.catch\(\(\) => null\)/u,
  "A ledger read failure should degrade only that workspace's usage projection.",
);
assert.match(
  source,
  /budget && budgetLedger/u,
  "Budget usage should be unavailable when its ledger could not be read.",
);
assert.match(
  source,
  /const pausedMonitors = workspaceMonitors\.filter\(\s*\(monitor\) => monitor\.lifecycleState !== "enabled" &&\s*monitor\.lifecycleState !== "retired",\s*\)\.length;/u,
  "Every non-enabled, non-retired lifecycle state should count as paused.",
);
assert.match(
  source,
  /const errorMonitors = workspaceMonitors\.filter\(\s*\(monitor\) => monitor\.lastErrorCode !== null,\s*\)\.length;/u,
  "Error count should remain independent from lifecycle counts.",
);
assert.match(source, /authorizePhotonWorkspaceControlPlaneStore/u);
assert.match(source, /nextWorkspaceMonitorOccurrence/u);
assert.equal(source.includes("innerHTML"), false);
const packActionStart = source.indexOf(
  'POST(`${PHOTON_WORKSPACE_APP_PATH}/pack-action`',
);
const runtimeActionStart = source.indexOf(
  'POST(`${PHOTON_WORKSPACE_APP_PATH}/runtime-action`',
);
assert.ok(packActionStart >= 0 && runtimeActionStart > packActionStart);
assert.equal(
  source.slice(packActionStart, runtimeActionStart)
    .includes("claimPhotonWorkspaceManagerRequest"),
  false,
  "Pack create must use its durable mutation identity, not consume the manager claim.",
);
assert.match(
  source,
  /runtime\.append\(strategyPackRow\(workspace\)\);\s*for \(const monitor/u,
  "Pack identity and health should render before the managed monitor controls.",
);
assert.match(
  source,
  /for \(const monitor[\s\S]+const packSummary = strategyPackSummary/u,
  "Managed monitor controls should render before the collapsed pack summary.",
);
assert.match(source, /className = "pack-danger"/u);
assert.match(source, /element\.disabled = busy/u);
assert.match(source, /if \(error && error\.status === 409\) await load\(\)/u);

console.info("Photon workspace runtime manager verification passed.");
