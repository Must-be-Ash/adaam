import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  requireLegacyTriggerCreation,
  requireWorkspaceMonitorWrites,
  resolveWorkspaceRuntimeFlags,
  WorkspaceRuntimeFlagError,
} from "../agent/lib/workspace-runtime-flags.ts";

const defaults = resolveWorkspaceRuntimeFlags({});
assert.deepEqual(defaults, {
  state: false,
  monitorWrites: false,
  dispatch: false,
  paidResearch: false,
  photonAlerts: false,
  sourceEvents: false,
  legacyTriggerCreation: true,
});
assert.equal(Object.isFrozen(defaults), true);
requireLegacyTriggerCreation({});
assert.throws(
  () => requireWorkspaceMonitorWrites({}),
  (error) =>
    error instanceof WorkspaceRuntimeFlagError &&
    error.code === "workspace_monitor_writes_disabled",
);

assert.deepEqual(
  resolveWorkspaceRuntimeFlags({
    EVE_WORKSPACE_STATE_ENABLED: "1",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_PAID_RESEARCH_ENABLED: "1",
    EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: "1",
    EVE_WORKSPACE_SOURCE_EVENTS_ENABLED: "1",
    EVE_LEGACY_TRIGGER_CREATION_ENABLED: "1",
  }),
  {
    state: true,
    monitorWrites: true,
    dispatch: true,
    paidResearch: true,
    photonAlerts: true,
    sourceEvents: true,
    legacyTriggerCreation: false,
  },
);
requireWorkspaceMonitorWrites({
  EVE_WORKSPACE_STATE_ENABLED: "1",
  EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
});
assert.throws(
  () =>
    requireLegacyTriggerCreation({
      EVE_WORKSPACE_STATE_ENABLED: "1",
      EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
    }),
  (error) =>
    error instanceof WorkspaceRuntimeFlagError &&
    error.code === "legacy_trigger_creation_disabled",
);

assert.deepEqual(
  resolveWorkspaceRuntimeFlags({
    EVE_WORKSPACE_STATE_ENABLED: "true",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "yes",
    EVE_WORKSPACE_DISPATCH_ENABLED: "enabled",
    EVE_WORKSPACE_PAID_RESEARCH_ENABLED: "1",
    EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: "1 ",
    EVE_WORKSPACE_SOURCE_EVENTS_ENABLED: "01",
    EVE_LEGACY_TRIGGER_CREATION_ENABLED: "0",
  }),
  {
    state: false,
    monitorWrites: false,
    dispatch: false,
    paidResearch: false,
    photonAlerts: false,
    sourceEvents: false,
    legacyTriggerCreation: false,
  },
);

const dispatchOff = resolveWorkspaceRuntimeFlags({
  EVE_WORKSPACE_STATE_ENABLED: "1",
  EVE_WORKSPACE_PAID_RESEARCH_ENABLED: "1",
});
assert.equal(dispatchOff.paidResearch, false);
assert.equal(
  resolveWorkspaceRuntimeFlags({
    EVE_WORKSPACE_STATE_ENABLED: "1",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1 ",
  }).dispatch,
  false,
);

const [documentation, environmentExample] = await Promise.all([
  readFile(
    new URL(
      "../specs/fixtures/01-independent-workspace-runtimes/feature-flags.md",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(new URL("../.env.example", import.meta.url), "utf8"),
]);

for (const flag of [
  "EVE_WORKSPACE_STATE_ENABLED",
  "EVE_WORKSPACE_MONITOR_WRITES_ENABLED",
  "EVE_WORKSPACE_DISPATCH_ENABLED",
  "EVE_WORKSPACE_PAID_RESEARCH_ENABLED",
  "EVE_PHOTON_WORKSPACE_ALERTS_ENABLED",
  "EVE_WORKSPACE_SOURCE_EVENTS_ENABLED",
  "EVE_LEGACY_TRIGGER_CREATION_ENABLED",
]) {
  assert.equal(documentation.includes(`\`${flag}\``), true);
  assert.match(environmentExample, new RegExp(`^${flag}=`, "mu"));
}

for (const rollbackInvariant of [
  "not deleted",
  "never blindly replayed",
  "remain versioned and recoverable",
  "background financial mutations",
]) {
  assert.equal(documentation.includes(rollbackInvariant), true);
}

console.log("Workspace runtime feature-flag and rollback contract passed.");
