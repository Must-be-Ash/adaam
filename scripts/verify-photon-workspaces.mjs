import assert from "node:assert/strict";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import {
  applyPhotonWorkspaceManagerAction,
  claimPhotonWorkspaceManagerRequest,
  archivePhotonWorkspace,
  createPhotonWorkspace,
  findPhotonWorkspaceByName,
  getPhotonWorkspaceManagerState,
  getPhotonWorkspaceState,
  mintPhotonWorkspaceManager,
  PHOTON_WORKSPACE_LIMIT,
  PHOTON_WORKSPACE_RETAINED_LIMIT,
  PhotonWorkspaceApprovalBlockedError,
  PhotonWorkspaceConflictError,
  PhotonWorkspaceValidationError,
  photonWorkspaceRegistryStorageKey,
  renamePhotonWorkspace,
  restorePhotonWorkspace,
  savePhotonWorkspaceSession,
  selectPhotonWorkspace,
  startFreshPhotonWorkspace,
} from "../agent/lib/photon-workspace-store.ts";
import {
  isPhotonSessionManagerRequest,
  photonWorkspaceThread,
  photonWorkspaceThreadId,
  parsePhotonWorkspaceThreadId,
  physicalPhotonThreadId,
  workspaceAwarePhotonAdapter,
} from "../agent/lib/photon-workspace.ts";

for (const request of [
  "manage sessions",
  "show my sessions",
  "create a new session for images",
  "I want to create a new workspace for image generation",
  "I want to create a new workspace saying I want to create images",
  "Can I have another session for image work?",
  "Where is the active session?",
  "switch to another session",
  "change workspace to Images",
  "what session am I in?",
  "which workspace are we using?",
  "rename my session",
  "Open the workspace manager in the current workspace",
  "reset session",
  "start fresh",
]) {
  assert.equal(
    isPhotonSessionManagerRequest(request),
    true,
    `Expected session-manager intent: ${request}`,
  );
}

for (const request of [
  "Create an IPO-filings session at 9 AM and 4 PM",
  "Create a session with the IPO Filings strategy pack",
  "Start a workspace from ipo-filings@1.0.0",
]) {
  assert.equal(
    isPhotonSessionManagerRequest(request),
    false,
    `Expected concrete pack creation to reach Eve: ${request}`,
  );
}

for (const request of [
  "create images of a sunset",
  "Create a durable daily monitor named Spec 1 Acceptance Replay Monitor in the current workspace. Run it at 23:59 America/Vancouver. Watch the exact public SEC latest S-1 filings source for new registration filings. Use no paid research and the default token limits.",
  "Create a report in the current workspace",
  "List monitors within my active workspace",
  "show my Coinbase balance",
  "explain browser session cookies",
  "summarize the earnings call",
]) {
  assert.equal(
    isPhotonSessionManagerRequest(request),
    false,
    `Unexpected session-manager intent: ${request}`,
  );
}

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
const managerRequestId = "123e4567-e89b-42d3-a456-426614174999";
assert.equal(await claimPhotonWorkspaceManagerRequest("expired", managerRequestId, client), "unavailable");
assert.equal(await claimPhotonWorkspaceManagerRequest(manager.managerToken, "not-a-uuid", client), "unavailable");
assert.equal(await claimPhotonWorkspaceManagerRequest(manager.managerToken, managerRequestId, client), "claimed");
assert.equal(await claimPhotonWorkspaceManagerRequest(manager.managerToken, managerRequestId, client), "replayed");
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

function seededWorkspace(index, status) {
  const now = 1_700_000_000_000 + index;
  return {
    ...(status === "archived" ? { archivedAtMs: now } : {}),
    continuation: index === 0 ? "physical" : "isolated",
    createdAtMs: now,
    generation: 1,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: index === 0 ? "Main" : `Session ${index + 1}`,
    normalizedName: index === 0 ? "main" : `session ${index + 1}`,
    status,
    updatedAtMs: now,
  };
}

function seedRegistry(client, scope, workspaces) {
  client.values.set(
    photonWorkspaceRegistryStorageKey(scope.principalId, scope.threadId),
    JSON.stringify({
      activeWorkspaceId: workspaces.find(({ status }) => status === "active").id,
      revision: 0,
      schemaVersion: 1,
      workspaces,
    }),
  );
}

const mixedCapacityClient = new MemoryStore();
const mixedCapacityScope = {
  principalId: "imessage:mixed-capacity-owner",
  threadId: "imessage:mixed-capacity-thread",
};
const mixedCapacityWorkspaces = Array.from(
  { length: PHOTON_WORKSPACE_LIMIT },
  (_, index) => seededWorkspace(index, index < 4 ? "active" : "archived"),
);
seedRegistry(mixedCapacityClient, mixedCapacityScope, mixedCapacityWorkspaces);
const createdBelowActiveLimit = await createPhotonWorkspace(
  { ...mixedCapacityScope, name: "demo", select: true },
  mixedCapacityClient,
);
assert.equal(createdBelowActiveLimit.workspaces.length, 13);
assert.equal(
  createdBelowActiveLimit.workspaces.filter(({ status }) => status === "active").length,
  5,
  "eight archived sessions must not consume the 12 active-session capacity",
);
assert.equal(createdBelowActiveLimit.activeWorkspace.name, "demo");

const fullActiveClient = new MemoryStore();
const fullActiveScope = {
  principalId: "imessage:full-active-owner",
  threadId: "imessage:full-active-thread",
};
const fullActiveWorkspaces = Array.from(
  { length: PHOTON_WORKSPACE_LIMIT },
  (_, index) => seededWorkspace(index, "active"),
);
seedRegistry(fullActiveClient, fullActiveScope, fullActiveWorkspaces);
await assert.rejects(
  createPhotonWorkspace(
    { ...fullActiveScope, name: "Over capacity" },
    fullActiveClient,
  ),
  (error) =>
    error instanceof PhotonWorkspaceValidationError &&
    /at most 12 active sessions/u.test(error.message),
  "creation must fail when 12 non-archived sessions already exist",
);

const restoreAtCapacityClient = new MemoryStore();
const restoreAtCapacityScope = {
  principalId: "imessage:restore-capacity-owner",
  threadId: "imessage:restore-capacity-thread",
};
const restoreAtCapacityWorkspaces = [
  ...fullActiveWorkspaces,
  seededWorkspace(PHOTON_WORKSPACE_LIMIT, "archived"),
];
seedRegistry(
  restoreAtCapacityClient,
  restoreAtCapacityScope,
  restoreAtCapacityWorkspaces,
);
await assert.rejects(
  restorePhotonWorkspace(
    {
      ...restoreAtCapacityScope,
      workspaceId: restoreAtCapacityWorkspaces.at(-1).id,
    },
    restoreAtCapacityClient,
  ),
  (error) =>
    error instanceof PhotonWorkspaceValidationError &&
    /at most 12 active sessions/u.test(error.message),
  "restoring an archived session must fail when active capacity is full",
);

const retainedCapacityClient = new MemoryStore();
const retainedCapacityScope = {
  principalId: "imessage:retained-capacity-owner",
  threadId: "imessage:retained-capacity-thread",
};
const retainedCapacityWorkspaces = Array.from(
  { length: PHOTON_WORKSPACE_RETAINED_LIMIT },
  (_, index) => seededWorkspace(index, index < 4 ? "active" : "archived"),
);
seedRegistry(
  retainedCapacityClient,
  retainedCapacityScope,
  retainedCapacityWorkspaces,
);
await assert.rejects(
  createPhotonWorkspace(
    { ...retainedCapacityScope, name: "No pruning" },
    retainedCapacityClient,
  ),
  (error) =>
    error instanceof PhotonWorkspaceValidationError &&
    /48-record retained session history limit/u.test(error.message),
  "retained history must remain separately bounded without consuming active capacity",
);
const retainedCapacityState = await getPhotonWorkspaceState(
  retainedCapacityScope,
  retainedCapacityClient,
);
assert.equal(retainedCapacityState.workspaces.length, PHOTON_WORKSPACE_RETAINED_LIMIT);
assert.equal(
  retainedCapacityState.workspaces.filter(({ status }) => status === "archived").length,
  PHOTON_WORKSPACE_RETAINED_LIMIT - 4,
  "rejecting creation at the retained-history bound must not delete archived records",
);

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
