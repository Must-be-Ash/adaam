import assert from "node:assert/strict";

import { photonAlertAppUrl } from "../agent/lib/photon-mini-app";
import {
  applyPhotonAlertDiscussAction,
  consumePhotonPendingAlertContext,
  createPhotonWorkspace,
  getPhotonWorkspaceState,
  mintPhotonAlertDiscussCapability,
} from "../agent/lib/photon-workspace-store";

class MemoryStore {
  values = new Map<string, string>();

  async compareAndSet(
    key: string,
    expected: string,
    next: string,
  ): Promise<"conflict" | "swapped"> {
    if (this.values.get(key) !== expected) return "conflict";
    this.values.set(key, next);
    return "swapped";
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(
    key: string,
    value: string,
    options?: { nx?: true },
  ): Promise<"OK" | null> {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
}

const client = new MemoryStore();
process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example.test";
const scope = {
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread",
};
const initial = await getPhotonWorkspaceState(scope, client);
const withResearch = await createPhotonWorkspace(
  { ...scope, name: "IPO Filings", select: false },
  client,
);
const ipoWorkspace = withResearch.workspaces.find(
  (workspace) => workspace.name === "IPO Filings",
);
assert.ok(ipoWorkspace);

const capability = await mintPhotonAlertDiscussCapability(
  {
    ...scope,
    alertId: `alert_${"a".repeat(64)}`,
    conversationId: `conversation_${"b".repeat(64)}`,
    expectedRevision: withResearch.revision,
    findingId: `finding_${"d".repeat(64)}`,
    ownerId: "owner_fixture",
    workspaceId: ipoWorkspace.id,
  },
  client,
);
const actionUrl = new URL(photonAlertAppUrl(capability.alertToken));
assert.equal(actionUrl.pathname, "/eve/v1/photon-alert");
assert.equal(actionUrl.search, "");
assert.equal(actionUrl.hash, `#${capability.alertToken}`);

const applied = await applyPhotonAlertDiscussAction(capability.alertToken, client);
assert.equal(applied.status, "applied");
if (applied.status !== "applied") throw new Error("Expected applied action.");
assert.equal(applied.state.activeWorkspace.id, ipoWorkspace.id);

const repeated = await applyPhotonAlertDiscussAction(capability.alertToken, client);
assert.equal(repeated.status, "stale");
const afterRepeat = await getPhotonWorkspaceState(scope, client);
assert.equal(afterRepeat.revision, applied.state.revision);

const consumed = await consumePhotonPendingAlertContext(
  { ...scope, workspaceId: ipoWorkspace.id },
  client,
);
assert.equal(consumed.context?.alertId, `alert_${"a".repeat(64)}`);
assert.equal(consumed.context?.findingId, `finding_${"d".repeat(64)}`);
assert.equal(consumed.context?.workspaceId, ipoWorkspace.id);
const consumedAgain = await consumePhotonPendingAlertContext(
  { ...scope, workspaceId: ipoWorkspace.id },
  client,
);
assert.equal(consumedAgain.context, null);

const staleCapability = await mintPhotonAlertDiscussCapability(
  {
    ...scope,
    alertId: `alert_${"c".repeat(64)}`,
    conversationId: `conversation_${"b".repeat(64)}`,
    expectedRevision: consumedAgain.state.revision,
    findingId: `finding_${"e".repeat(64)}`,
    ownerId: "owner_fixture",
    workspaceId: initial.activeWorkspace.id,
  },
  client,
);
await createPhotonWorkspace({ ...scope, name: "Revision Race" }, client);
assert.equal(
  (await applyPhotonAlertDiscussAction(staleCapability.alertToken, client)).status,
  "stale",
);

console.info("Photon alert selection and pending-context verification passed.");
