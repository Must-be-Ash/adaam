import assert from "node:assert/strict";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import {
  applyPhotonWorkspaceManagerAction,
  archivePhotonWorkspace,
  createPhotonWorkspace,
  findPhotonWorkspaceByName,
  getPhotonWorkspaceManagerState,
  getPhotonWorkspaceState,
  mintPhotonWorkspaceManager,
  PhotonWorkspaceApprovalBlockedError,
  PhotonWorkspaceConflictError,
  renamePhotonWorkspace,
  restorePhotonWorkspace,
  savePhotonWorkspaceSession,
  selectPhotonWorkspace,
  startFreshPhotonWorkspace,
} from "../agent/lib/photon-workspace-store.ts";
import {
  photonWorkspaceThread,
  photonWorkspaceThreadId,
  parsePhotonWorkspaceThreadId,
  physicalPhotonThreadId,
  workspaceAwarePhotonAdapter,
} from "../agent/lib/photon-workspace.ts";

class MemoryStore {
  values = new Map();

  async compareAndSet(key, expected, next, approvalGuardKey) {
    if (approvalGuardKey && this.values.has(approvalGuardKey)) {
      return "blocked";
    }
    if (this.values.get(key) !== expected) return "conflict";
    this.values.set(key, next);
    return "swapped";
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value, options) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
}

class SameRevisionRaceStore extends MemoryStore {
  injectRace = false;

  async compareAndSet(key, expected, next, approvalGuardKey) {
    if (this.injectRace) {
      this.injectRace = false;
      const current = JSON.parse(expected);
      current.workspaces[0].updatedAtMs += 1;
      this.values.set(key, JSON.stringify(current));
      return "conflict";
    }
    return super.compareAndSet(key, expected, next, approvalGuardKey);
  }
}

class LostResponseStore extends MemoryStore {
  loseNextResponse = false;

  async compareAndSet(key, expected, next, approvalGuardKey) {
    const result = await super.compareAndSet(
      key,
      expected,
      next,
      approvalGuardKey,
    );
    if (result === "swapped" && this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("Simulated lost Redis response.");
    }
    return result;
  }
}

const client = new MemoryStore();
const scope = {
  principalId: "imessage:test-owner",
  threadId: "imessage:thread-1",
};

const initial = await getPhotonWorkspaceState(scope, client);
assert.equal(initial.revision, 0);
assert.equal(initial.workspaces.length, 1);
assert.equal(initial.activeWorkspace.name, "Main");
assert.equal(initial.activeWorkspace.continuation, "physical");
assert.equal(
  photonWorkspaceThreadId(scope.threadId, initial.activeWorkspace),
  scope.threadId,
);

await savePhotonWorkspaceSession(
  {
    ...scope,
    generation: initial.activeWorkspace.generation,
    sessionId: "session-main-1",
    workspaceId: initial.activeWorkspace.id,
  },
  client,
);

const withResearch = await createPhotonWorkspace(
  { ...scope, name: "Earnings Research", select: true },
  client,
);
assert.equal(withResearch.activeWorkspace.name, "Earnings Research");
assert.equal(withResearch.activeWorkspace.continuation, "isolated");
const researchThreadId = photonWorkspaceThreadId(
  scope.threadId,
  withResearch.activeWorkspace,
);
assert.notEqual(researchThreadId, scope.threadId);
assert.equal(physicalPhotonThreadId(researchThreadId), scope.threadId);
assert.deepEqual(parsePhotonWorkspaceThreadId(researchThreadId), {
  generation: withResearch.activeWorkspace.generation,
  workspaceId: withResearch.activeWorkspace.id,
});
assert.equal(parsePhotonWorkspaceThreadId(scope.threadId), null);
const routedThread = photonWorkspaceThread(
  {
    id: scope.threadId,
    toJSON() {
      return {
        _type: "chat:Thread",
        adapterName: "imessage",
        channelId: "imessage:channel",
        currentMessage: {
          _type: "chat:Message",
          id: "message-1",
          threadId: scope.threadId,
        },
        id: scope.threadId,
        isDM: true,
      };
    },
  },
  withResearch.activeWorkspace,
);
assert.equal(routedThread.id, researchThreadId);
assert.equal(routedThread.currentMessage?.threadId, researchThreadId);

const adapterCalls = [];
const adapter = workspaceAwarePhotonAdapter({
  name: "imessage",
  postMessage(threadId, message) {
    adapterCalls.push({ message, threadId });
    return Promise.resolve({ id: "sent-1", threadId });
  },
});
await adapter.postMessage(researchThreadId, "hello");
assert.deepEqual(adapterCalls, [
  { message: "hello", threadId: scope.threadId },
]);

await savePhotonWorkspaceSession(
  {
    ...scope,
    generation: withResearch.activeWorkspace.generation,
    sessionId: "session-research-1",
    workspaceId: withResearch.activeWorkspace.id,
  },
  client,
);

const main = findPhotonWorkspaceByName(withResearch, "main");
assert.ok(main);
const selectedMain = await selectPhotonWorkspace(
  { ...scope, workspaceId: main.id },
  client,
);
assert.equal(selectedMain.activeWorkspace.id, main.id);
assert.equal(
  findPhotonWorkspaceByName(selectedMain, "earnings research")?.sessionId,
  "session-research-1",
);

const refreshedMain = await startFreshPhotonWorkspace(
  { ...scope, workspaceId: main.id },
  client,
);
assert.equal(refreshedMain.retiredSessionId, "session-main-1");
assert.equal(refreshedMain.state.activeWorkspace.generation, 2);
assert.equal(refreshedMain.state.activeWorkspace.continuation, "isolated");
assert.notEqual(
  photonWorkspaceThreadId(
    scope.threadId,
    refreshedMain.state.activeWorkspace,
  ),
  scope.threadId,
);

const research = findPhotonWorkspaceByName(
  refreshedMain.state,
  "Earnings Research",
);
assert.ok(research);
const renamed = await renamePhotonWorkspace(
  {
    ...scope,
    name: "Call Language",
    workspaceId: research.id,
  },
  client,
);
assert.ok(findPhotonWorkspaceByName(renamed, "call language"));

const archived = await archivePhotonWorkspace(
  { ...scope, workspaceId: research.id },
  client,
);
assert.equal(
  findPhotonWorkspaceByName(archived, "Call Language")?.status,
  "archived",
);
const restored = await restorePhotonWorkspace(
  { ...scope, workspaceId: research.id },
  client,
);
assert.equal(
  findPhotonWorkspaceByName(restored, "Call Language")?.status,
  "active",
);

const activeArchiveScope = {
  principalId: "imessage:test-owner",
  threadId: "imessage:thread-2",
};
const first = await getPhotonWorkspaceState(activeArchiveScope, client);
const second = await createPhotonWorkspace(
  { ...activeArchiveScope, name: "Second", select: false },
  client,
);
const replacement = findPhotonWorkspaceByName(second, "Second");
assert.ok(replacement);
const atomicallyReplaced = await archivePhotonWorkspace(
  {
    ...activeArchiveScope,
    replacementWorkspaceId: replacement.id,
    workspaceId: first.activeWorkspace.id,
  },
  client,
);
assert.equal(atomicallyReplaced.activeWorkspace.id, replacement.id);

const manager = await mintPhotonWorkspaceManager(scope, client);
const managerState = await getPhotonWorkspaceManagerState(
  manager.managerToken,
  client,
);
assert.ok(managerState);
const managerRevision = managerState.revision;
const managed = await applyPhotonWorkspaceManagerAction(
  manager.managerToken,
  {
    action: "create",
    expectedRevision: managerRevision,
    name: "Portfolio",
    select: true,
  },
  client,
);
assert.equal(managed?.state.activeWorkspace.name, "Portfolio");
await assert.rejects(
  () =>
    applyPhotonWorkspaceManagerAction(
      manager.managerToken,
      {
        action: "create",
        expectedRevision: managerRevision,
        name: "Stale Replay",
      },
      client,
    ),
  PhotonWorkspaceConflictError,
);

const guardedManager = await mintPhotonWorkspaceManager(scope, client);
const guardedState = await getPhotonWorkspaceManagerState(
  guardedManager.managerToken,
  client,
);
assert.ok(guardedState);
const approvalGuard = photonApprovalGuardKey(scope);
await client.set(approvalGuard, "approval-record");
await assert.rejects(
  () =>
    applyPhotonWorkspaceManagerAction(
      guardedManager.managerToken,
      {
        action: "create",
        expectedRevision: guardedState.revision,
        name: "Blocked While Approving",
      },
      client,
    ),
  PhotonWorkspaceApprovalBlockedError,
);
client.values.delete(approvalGuard);

const sameRevisionClient = new SameRevisionRaceStore();
const sameRevisionScope = {
  principalId: "imessage:race-owner",
  threadId: "imessage:race-thread",
};
const beforeRace = await getPhotonWorkspaceState(
  sameRevisionScope,
  sameRevisionClient,
);
sameRevisionClient.injectRace = true;
const afterRace = await createPhotonWorkspace(
  {
    ...sameRevisionScope,
    expectedRevision: beforeRace.revision,
    name: "CAS Retry",
  },
  sameRevisionClient,
);
assert.ok(findPhotonWorkspaceByName(afterRace, "CAS Retry"));

const lostResponseClient = new LostResponseStore();
const lostResponseScope = {
  principalId: "imessage:lost-response-owner",
  threadId: "imessage:lost-response-thread",
};
await getPhotonWorkspaceState(lostResponseScope, lostResponseClient);
lostResponseClient.loseNextResponse = true;
const reconciled = await createPhotonWorkspace(
  { ...lostResponseScope, name: "Reconciled" },
  lostResponseClient,
);
assert.ok(findPhotonWorkspaceByName(reconciled, "Reconciled"));

const isolatedScope = {
  principalId: "imessage:another-owner",
  threadId: scope.threadId,
};
const isolated = await getPhotonWorkspaceState(isolatedScope, client);
assert.deepEqual(
  isolated.workspaces.map((workspace) => workspace.name),
  ["Main"],
);

console.log("Photon workspace routing verification passed.");
