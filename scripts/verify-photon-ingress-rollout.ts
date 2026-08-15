import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { photonAuth } from "../agent/lib/photon-auth";
import {
  PhotonIngressRolloutError,
  resolvePhotonIngressRolloutMode,
} from "../agent/lib/photon-ingress-rollout";

const off = {
  EVE_PHOTON_WORKSPACE_ALERTS_ENABLED: "0",
  EVE_WORKSPACE_DISPATCH_ENABLED: "0",
  EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "0",
  EVE_WORKSPACE_PAID_RESEARCH_ENABLED: "0",
  EVE_WORKSPACE_SOURCE_EVENTS_ENABLED: "0",
  EVE_WORKSPACE_STATE_ENABLED: "0",
};
const owner = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: Buffer.alloc(32, 4).toString("base64url"),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
};
const redis = {
  KV_REST_API_TOKEN: "fixture-token",
  KV_REST_API_URL: "https://redis.example.test",
};

assert.equal(resolvePhotonIngressRolloutMode({}), "legacy");
assert.equal(resolvePhotonIngressRolloutMode(off), "legacy");
assert.equal(resolvePhotonIngressRolloutMode({ ...off, ...owner, ...redis }), "durable");
assert.equal(resolvePhotonIngressRolloutMode({
  ...off,
  ...owner,
  ...redis,
  EVE_WORKSPACE_STATE_ENABLED: "1",
}), "durable");

for (const invalid of [
  { ...off, EVE_DEPLOYMENT_OWNER_ID: owner.EVE_DEPLOYMENT_OWNER_ID },
  { ...off, ...owner },
  { ...off, ...owner, KV_REST_API_URL: redis.KV_REST_API_URL },
  { ...off, EVE_WORKSPACE_STATE_ENABLED: "true" },
  { ...off, EVE_WORKSPACE_STATE_ENABLED: "1 " },
  { ...off, EVE_WORKSPACE_DISPATCH_ENABLED: "1" },
  { ...off, EVE_WORKSPACE_STATE_ENABLED: "1" },
]) {
  assert.throws(
    () => resolvePhotonIngressRolloutMode(invalid),
    (error) => error instanceof PhotonIngressRolloutError,
  );
}

const legacyAuth = photonAuth("fixture-owner", "fixture-thread");
assert.equal(legacyAuth.attributes.channel, "photon");
assert.equal(legacyAuth.attributes.thread_id, "fixture-thread");
assert.equal("workspace_id" in legacyAuth.attributes, false);
assert.equal("owner_id" in legacyAuth.attributes, false);

const photonSource = await readFile(
  new URL("../agent/channels/photon.ts", import.meta.url),
  "utf8",
);
assert.match(photonSource, /resolvePhotonIngressRolloutMode\(\)/u);
assert.match(photonSource, /rolloutMode === "legacy"[\s\S]*auth: photonAuth\(senderId, thread\.id\)/u);
assert.match(photonSource, /rolloutMode === "durable"[\s\S]*requirePhotonOwnerAccess/u);
assert.match(photonSource, /resolvePhotonIngressRolloutMode\(\) === "durable"[\s\S]*projectPhotonWorkspaceRuntimeScope/u);
const managerSource = await readFile(
  new URL("../agent/channels/photon-workspace-app.ts", import.meta.url),
  "utf8",
);
assert.match(managerSource, /rolloutMode === "durable"[\s\S]*publicManagerState/u);
assert.match(managerSource, /Workspace runtime controls are not enabled/u);
const approvalSource = await readFile(
  new URL("../agent/channels/photon-approval-app.ts", import.meta.url),
  "utf8",
);
assert.match(approvalSource, /resolvePhotonIngressRolloutMode\(\) === "durable"[\s\S]*projectPhotonWorkspaceRuntimeScope/u);

console.info("Photon ingress rollout verification passed.");
