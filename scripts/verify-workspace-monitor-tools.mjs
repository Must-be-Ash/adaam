import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { manageWorkspaceMonitorInputSchema } from "../agent/tools/manage_workspace_monitor.ts";
import {
  mergeWorkspaceMonitorDailyTimes,
  mergeWorkspaceMonitorSources,
  updateWorkspaceMonitorInputSchema,
} from "../agent/tools/update_workspace_monitor.ts";
import { updateWorkspaceBudgetInputSchema } from "../agent/tools/update_workspace_budget.ts";

for (const action of ["pause", "resume", "retire"]) {
  assert.equal(manageWorkspaceMonitorInputSchema.safeParse({
    action,
    expectedRevision: 1,
    monitorId: "123e4567-e89b-42d3-a456-426614174000",
  }).success, true);
}
assert.equal(manageWorkspaceMonitorInputSchema.safeParse({
  action: "delete",
  expectedRevision: 1,
  monitorId: "123e4567-e89b-42d3-a456-426614174000",
}).success, false);

const files = await Promise.all([
  "../agent/tools/create_workspace_monitor.ts",
  "../agent/tools/update_workspace_monitor.ts",
  "../agent/tools/list_workspace_monitors.ts",
  "../agent/tools/manage_workspace_monitor.ts",
  "../agent/tools/create_event_trigger.ts",
  "../agent/tools/update_event_trigger.ts",
  "../agent/tools/list_event_triggers.ts",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
for (const source of files.slice(0, 4)) {
  assert.match(source, /authorizePhotonWorkspaceToolStore/u);
}
assert.equal(files.slice(4).every((source) => source.includes("eventTriggerStore")), true);
assert.match(files[2], /never guess by nearest name/u);
assert.match(files[3], /recoverably retire/u);

assert.deepEqual(mergeWorkspaceMonitorDailyTimes({
  kind: "daily_local",
  times: ["09:00"],
  timezone: "America/Vancouver",
}, ["16:00"]), {
  kind: "daily_local",
  times: ["09:00", "16:00"],
  timezone: "America/Vancouver",
});
assert.equal(updateWorkspaceMonitorInputSchema.safeParse({
  addDailyTimes: ["16:00"],
  expectedRevision: 1,
  monitorId: "123e4567-e89b-42d3-a456-426614174000",
}).success, true);
const sources = Array.from({ length: 9 }, (_, index) => ({
  accessClassification: "public",
  canonicalUrl: `https://www.sec.gov/fixture-${index}`,
  origin: "https://www.sec.gov",
  sourceId: `source-${index}`,
}));
assert.throws(() => mergeWorkspaceMonitorSources(sources.slice(0, 8), [sources[8]]), (error) =>
  error instanceof Error && error.message.includes("monitor_source_limit_exceeded"));
assert.equal(updateWorkspaceBudgetInputSchema.safeParse({
  expectedRevision: 1,
  maximumScheduledRunsPerDay: 16,
  ownerTimezone: "America/Vancouver",
}).success, true);
assert.equal(updateWorkspaceBudgetInputSchema.safeParse({ expectedRevision: 1 }).success, false);
for (const runs of [1, 32, 50, 144]) {
  assert.equal(updateWorkspaceBudgetInputSchema.safeParse({
    expectedRevision: 1, maximumScheduledRunsPerDay: runs,
  }).success, true, `The budget editor must accept the existing policy limit: ${runs}`);
}
for (const runs of [0, -1, 1.5, 145]) {
  assert.equal(updateWorkspaceBudgetInputSchema.safeParse({
    expectedRevision: 1, maximumScheduledRunsPerDay: runs,
  }).success, false);
}
const instructions = await readFile(new URL("../agent/instructions/00-shared.md", import.meta.url), "utf8");
assert.match(instructions, /preserve existing daily times when the owner says/u);
assert.match(instructions, /compatibility-only/u);

console.info("Workspace monitor CRUD tool and compatibility verification passed.");
