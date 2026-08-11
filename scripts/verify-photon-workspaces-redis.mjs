import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import {
  createPhotonWorkspace,
  getPhotonWorkspaceState,
  PhotonWorkspaceApprovalBlockedError,
  savePhotonWorkspaceSession,
  startFreshPhotonWorkspace,
} from "../agent/lib/photon-workspace-store.ts";

const url =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  throw new Error("Photon workspace Redis verification is not configured.");
}

const nonce = randomUUID();
const scope = {
  principalId: `imessage:workspace-verification-${nonce}`,
  threadId: `imessage:workspace-verification-${nonce}`,
};
const scopeHash = createHash("sha256")
  .update(`photon-workspaces\u0000${scope.principalId}\u0000${scope.threadId}`)
  .digest("hex");
const registryKey = `eve:photon:v1:workspace-registry:${scopeHash}`;
const approvalGuardKey = photonApprovalGuardKey(scope);
const client = new Redis({ automaticDeserialization: false, token, url });

try {
  const initial = await getPhotonWorkspaceState(scope);
  assert.equal(initial.activeWorkspace.name, "Main");

  const created = await createPhotonWorkspace({
    ...scope,
    approvalGuardKey,
    expectedRevision: initial.revision,
    name: "Redis Verification",
    select: true,
  });
  assert.equal(created.activeWorkspace.name, "Redis Verification");

  assert.equal(
    await savePhotonWorkspaceSession({
      ...scope,
      generation: created.activeWorkspace.generation,
      sessionId: `session-${nonce}`,
      workspaceId: created.activeWorkspace.id,
    }),
    true,
  );

  const refreshed = await startFreshPhotonWorkspace({
    ...scope,
    approvalGuardKey,
    expectedRevision: created.revision,
    workspaceId: created.activeWorkspace.id,
  });
  assert.equal(refreshed.retiredSessionId, `session-${nonce}`);
  assert.equal(refreshed.state.activeWorkspace.generation, 2);

  await client.set(approvalGuardKey, "verification-approval", { ex: 60 });
  await assert.rejects(
    () =>
      createPhotonWorkspace({
        ...scope,
        approvalGuardKey,
        expectedRevision: refreshed.state.revision,
        name: "Must Be Blocked",
      }),
    PhotonWorkspaceApprovalBlockedError,
  );

  console.log("Photon Redis workspace lifecycle verification passed.");
} finally {
  await Promise.all([
    client.del(approvalGuardKey),
    client.del(registryKey),
  ]);
}
