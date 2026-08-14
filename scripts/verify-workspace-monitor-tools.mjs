import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { manageWorkspaceMonitorInputSchema } from "../agent/tools/manage_workspace_monitor.ts";

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

console.info("Workspace monitor CRUD tool and compatibility verification passed.");
