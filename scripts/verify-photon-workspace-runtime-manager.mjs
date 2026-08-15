import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../agent/channels/photon-workspace-app.ts", import.meta.url), "utf8");
for (const required of [
  "listWorkspaceMonitors",
  'readWorkspaceDocument("budget"',
  'action: z.enum(["monitor-pause", "monitor-resume"])',
  'action: z.literal("monitor-schedule")',
  'action: z.literal("workspace-budget")',
  "expectedMonitorRevision",
  "expectedBudgetRevision",
  "expectedRoutingRevision",
  "claimPhotonWorkspaceManagerRequest",
  "crypto.randomUUID()",
  "monitor.nextOccurrenceAt",
  "monitor.lastRunAt",
  "monitor.lastErrorCode",
  "monitor.sources.length",
  "Edit schedule",
  "Edit budget",
  "ask Eve in chat to list, pause, resume, reschedule, retire, or update the budget for a monitor",
  "suspendWorkspaceMonitorsForArchive",
  "pauseWorkspaceMonitorsAfterRestore",
]) assert.ok(source.includes(required), `Missing manager runtime contract: ${required}`);
assert.equal(/action\.action === "start-fresh"[\s\S]{0,160}suspendWorkspaceMonitorsForArchive/u.test(source), false);
assert.match(source, /authorizePhotonWorkspaceControlPlaneStore/u);
assert.match(source, /nextWorkspaceMonitorOccurrence/u);
assert.equal(source.includes("innerHTML"), false);

console.info("Photon workspace runtime manager verification passed.");
