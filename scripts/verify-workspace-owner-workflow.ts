import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ensureIpoFilingsWorkspaceRuntime } from "../agent/lib/ipo-filings-workspace-runtime";
import { SEC_IPO_SOURCE_ID } from "../agent/lib/sec-ipo-reference";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStateStore implements WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const now = new Date("2026-08-14T16:00:00.000Z");
const client = new MemoryStateStore();
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });

const initialized = await ensureIpoFilingsWorkspaceRuntime({
  client,
  now,
  ownerTimezone: "America/Vancouver",
  scope,
});
assert.equal(initialized.brief.value.sourcePolicy.allowedSourceIds[0], SEC_IPO_SOURCE_ID);
assert.equal(initialized.strategy.value.strategyPack, null);
assert.equal(initialized.capabilities.value.paidResearchAllowed, false);
assert.deepEqual(initialized.capabilities.value.financialToolIds, []);
assert.equal(initialized.budget.value.ownerTimezone, "America/Vancouver");
assert.equal(initialized.budget.value.maximumScheduledRunsPerDay, 4);
assert.equal(initialized.budget.value.maximumPaidPerDay, null);

const retried = await ensureIpoFilingsWorkspaceRuntime({
  client,
  now: new Date("2026-08-14T16:01:00.000Z"),
  ownerTimezone: "UTC",
  scope,
});
assert.equal(retried.budget.revision, 1);
assert.equal(retried.budget.value.ownerTimezone, "America/Vancouver");
for (const kind of ["brief", "strategy", "capabilities", "budget"] as const) {
  assert.equal((await readWorkspaceDocument(kind, scope, client))?.revision, 1);
}

const toolSource = await readFile(
  new URL("../agent/tools/create_workspace_monitor.ts", import.meta.url),
  "utf8",
);
assert.match(toolSource, /ensureIpoFilingsWorkspaceRuntime/u);
assert.match(toolSource, /idempotencyKey: ctx\.callId/u);
assert.match(toolSource, /workspace_runtime_not_configured/u);
const skillSource = await readFile(
  new URL("../agent/skills/public-event-monitoring.md", import.meta.url),
  "utf8",
);
for (const contract of [
  "create_workspace_monitor",
  "list_workspace_monitors",
  "update_workspace_monitor",
  "manage_workspace_monitor",
  "complete_workspace_run",
  "write_workspace_finding",
]) assert.match(skillSource, new RegExp(`\\b${contract}\\b`, "u"));
assert.doesNotMatch(skillSource, /call `(?:complete_event_check|send_event_alert)`/u);

console.info("Workspace owner workflow verification passed.");
