import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { photonAuth } from "../agent/lib/photon-auth";
import {
  projectPhotonWorkspaceRuntimeScope,
  requirePhotonWorkspaceToolScope,
  WorkspaceRuntimeScopeError,
} from "../agent/lib/workspace-runtime-scope";

const principalId = "imessage:fixture-owner";
const senderId = "fixture-owner";
const threadId = "imessage:fixture-conversation";
const workspaceId = "123e4567-e89b-42d3-a456-426614174000";
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: principalId,
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};

const scope = projectPhotonWorkspaceRuntimeScope(
  { generation: 3, principalId, threadId, workspaceId },
  environment,
);
assert.equal(scope.schemaVersion, 1);
assert.equal(scope.ownerId, "owner_fixture");
assert.equal(scope.workspaceId, workspaceId);
assert.equal(scope.generation, 3);
assert.match(scope.conversationId, /^conversation_[a-f0-9]{64}$/u);
assert.equal(Object.isFrozen(scope), true);
assert.equal(JSON.stringify(scope).includes(principalId), false);
assert.equal(JSON.stringify(scope).includes(threadId), false);

const replay = projectPhotonWorkspaceRuntimeScope(
  { generation: 3, principalId, threadId, workspaceId },
  { ...environment },
);
assert.deepEqual(replay, scope);
assert.notEqual(
  projectPhotonWorkspaceRuntimeScope(
    {
      generation: 3,
      principalId,
      threadId: "imessage:another-conversation",
      workspaceId,
    },
    environment,
  ).conversationId,
  scope.conversationId,
);

const auth = photonAuth(senderId, threadId, scope);
const context = { session: { auth: { current: auth } } };
assert.deepEqual(
  requirePhotonWorkspaceToolScope(context, {}, environment),
  scope,
);
assert.deepEqual(
  requirePhotonWorkspaceToolScope(
    context,
    {
      conversationId: scope.conversationId,
      generation: scope.generation,
      ownerId: scope.ownerId,
      workspaceId: scope.workspaceId,
    },
    environment,
  ),
  scope,
);

function contextWithAttributes(attributes: Record<string, string>) {
  return {
    session: {
      auth: {
        current: {
          ...auth,
          attributes,
        },
      },
    },
  };
}

const attributes = auth.attributes as Record<string, string>;
for (const [field, value] of [
  ["owner_id", "owner_other"],
  ["conversation_id", `conversation_${"b".repeat(64)}`],
  ["workspace_id", "223e4567-e89b-42d3-a456-426614174000"],
  ["workspace_generation", "4"],
  ["scope_version", "2"],
] as const) {
  assert.throws(
    () =>
      requirePhotonWorkspaceToolScope(
        contextWithAttributes({ ...attributes, [field]: value }),
        scope,
        environment,
      ),
    (error) =>
      error instanceof WorkspaceRuntimeScopeError &&
      error.code === "workspace_scope_invalid",
  );
}

for (const invalidContext of [
  { session: { auth: { current: null } } },
  contextWithAttributes({ channel: "photon", thread_id: threadId }),
  contextWithAttributes({ ...attributes, thread_id: "imessage:other" }),
  {
    session: {
      auth: {
        current: {
          ...auth,
          principalId: "imessage:authenticated-but-unmapped",
        },
      },
    },
  },
]) {
  assert.throws(
    () => requirePhotonWorkspaceToolScope(invalidContext, {}, environment),
    WorkspaceRuntimeScopeError,
  );
}

const photonRouter = await readFile(
  new URL("../agent/channels/photon.ts", import.meta.url),
  "utf8",
);
const ordinaryProjection = photonRouter.lastIndexOf(
  "const runtimeScope = projectPhotonWorkspaceRuntimeScope({",
);
const ordinaryDispatch = photonRouter.indexOf(
  "const session = await bridge.send(",
  ordinaryProjection,
);
const ordinaryAuth = photonRouter.indexOf(
  "auth: photonAuth(senderId, thread.id, runtimeScope)",
  ordinaryDispatch,
);
assert.ok(ordinaryProjection >= 0 && ordinaryProjection < ordinaryDispatch);
assert.ok(ordinaryDispatch < ordinaryAuth);
assert.equal(photonRouter.includes("parsePhotonWorkspaceThreadId(ctx"), false);

console.log("Typed Photon workspace runtime scope verification passed.");
