import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { photonWorkspaceMonitorSourcesSchema } from "../agent/channels/photon-workspace-app";
import {
  WORKSPACE_MONITOR_SOURCE_LIMIT_CODE,
  workspaceMonitorCreateSourcesSchema,
  workspaceMonitorManagerSourcesSchema,
  workspaceMonitorUpdateSourcesSchema,
} from "../agent/lib/workspace-monitor-input";
import { createEventTriggerInputSchema } from "../agent/tools/create_event_trigger";
import { createWorkspaceMonitorInputSchema } from "../agent/tools/create_workspace_monitor";
import { updateEventTriggerInputSchema } from "../agent/tools/update_event_trigger";
import { updateWorkspaceMonitorInputSchema } from "../agent/tools/update_workspace_monitor";

const source = (index: number) => ({
  accessClassification: "public" as const,
  canonicalUrl: `https://example.gov/feed/${index}`,
  origin: "https://example.gov",
  sourceId: `source.${index}`,
});
const eightSources = Array.from({ length: 8 }, (_, index) => source(index));
const nineSources = Array.from({ length: 9 }, (_, index) => source(index));

assert.equal(workspaceMonitorCreateSourcesSchema, workspaceMonitorUpdateSourcesSchema);
assert.equal(workspaceMonitorCreateSourcesSchema, workspaceMonitorManagerSourcesSchema);
assert.equal(workspaceMonitorManagerSourcesSchema, photonWorkspaceMonitorSourcesSchema);
for (const schema of [
  workspaceMonitorCreateSourcesSchema,
  workspaceMonitorUpdateSourcesSchema,
  photonWorkspaceMonitorSourcesSchema,
]) {
  assert.equal(schema.safeParse(eightSources).success, true);
  const rejected = schema.safeParse(nineSources);
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.ok(rejected.error.issues.some((issue) => issue.message === WORKSPACE_MONITOR_SOURCE_LIMIT_CODE));
  }
}

const createInput = {
  instruction: "Check all configured sources.",
  name: "Eight source monitor",
  schedule: {
    kind: "daily_local" as const,
    times: ["09:00"],
    timezone: "America/Vancouver",
  },
};
assert.equal(
  createWorkspaceMonitorInputSchema.safeParse({ ...createInput, sources: eightSources }).success,
  true,
);
assert.equal(
  createWorkspaceMonitorInputSchema.safeParse({ ...createInput, sources: nineSources }).success,
  false,
);
assert.equal(
  updateWorkspaceMonitorInputSchema.safeParse({
    expectedRevision: 1,
    monitorId: "123e4567-e89b-42d3-a456-426614174000",
    sources: nineSources,
  }).success,
  false,
);

const legacyBase = {
  everyMinutes: 30,
  firstRunAt: "2026-08-15T17:00:00.000Z",
  instruction: "Check sources.",
  name: "Compatibility monitor",
  timezone: "America/Vancouver",
};
assert.equal(
  createEventTriggerInputSchema.safeParse({
    ...legacyBase,
    sourceIds: Array.from({ length: 5 }, (_, index) => `source.${index}`),
    sourceUrls: Array.from({ length: 4 }, (_, index) => `https://example.gov/${index}`),
  }).success,
  false,
);
assert.equal(
  updateEventTriggerInputSchema.safeParse({
    id: "123e4567-e89b-42d3-a456-426614174000",
    sourceIds: Array.from({ length: 5 }, (_, index) => `source.${index}`),
    sourceUrls: Array.from({ length: 4 }, (_, index) => `https://example.gov/${index}`),
  }).success,
  false,
);

for (const path of [
  "../agent/tools/create_workspace_monitor.ts",
  "../agent/tools/update_workspace_monitor.ts",
]) {
  const sourceText = await readFile(new URL(path, import.meta.url), "utf8");
  assert.doesNotMatch(sourceText, /workspaceId\s*:/u);
  assert.match(sourceText, /authorizePhotonWorkspaceToolStore/u);
}

console.info("Workspace monitor input verification passed.");
