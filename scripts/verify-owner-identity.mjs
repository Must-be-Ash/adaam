import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  OWNER_RESOURCE_KINDS,
  OwnerIdentityDeniedError,
  requirePhotonOwnerAccess,
  resolvePhotonOwnerIdentity,
} from "../agent/lib/owner-identity.ts";

const aliasA = "imessage:fixture-owner-alias-a";
const aliasB = "imessage:fixture-owner-alias-b";
const secret = "A".repeat(43);
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: `${aliasA},${aliasB}`,
  EVE_OWNER_ALIAS_HMAC_SECRET: secret,
};

const first = resolvePhotonOwnerIdentity(aliasA, environment);
const replay = resolvePhotonOwnerIdentity(aliasA, { ...environment });
const secondAlias = resolvePhotonOwnerIdentity(aliasB, environment);
assert.deepEqual(first, replay);
assert.equal(first.ownerId, "owner_fixture");
assert.equal(secondAlias.ownerId, first.ownerId);
assert.match(first.principalAlias, /^[a-f0-9]{64}$/u);
assert.match(secondAlias.principalAlias, /^[a-f0-9]{64}$/u);
assert.notEqual(first.principalAlias, secondAlias.principalAlias);
assert.equal(Object.isFrozen(first), true);
assert.equal(JSON.stringify(first).includes(aliasA), false);

for (const resource of OWNER_RESOURCE_KINDS) {
  assert.deepEqual(
    requirePhotonOwnerAccess({ principalId: aliasA, resource }, environment),
    first,
  );
  let stateAccessed = false;
  assert.throws(
    () => {
      requirePhotonOwnerAccess(
        { principalId: "imessage:authenticated-but-unmapped", resource },
        environment,
      );
      stateAccessed = true;
    },
    OwnerIdentityDeniedError,
  );
  assert.equal(stateAccessed, false, `${resource} state must remain untouched`);
}

const rotatedSecret = resolvePhotonOwnerIdentity(aliasA, {
  ...environment,
  EVE_OWNER_ALIAS_HMAC_SECRET: "B".repeat(43),
});
assert.notEqual(rotatedSecret.principalAlias, first.principalAlias);

for (const [principalId, candidateEnvironment] of [
  ["imessage:authenticated-but-unmapped", environment],
  [aliasA, {}],
  [aliasA, { ...environment, EVE_DEPLOYMENT_OWNER_ID: "owner@example.com" }],
  [aliasA, { ...environment, EVE_PHOTON_OWNER_PRINCIPALS: "" }],
  [aliasA, { ...environment, EVE_OWNER_ALIAS_HMAC_SECRET: "short" }],
  ["telegram:fixture-owner", environment],
  [
    "imessage:coinbase-only-fixture",
    {
      ...environment,
      COINBASE_ALLOWED_PRINCIPALS: "imessage:coinbase-only-fixture",
    },
  ],
]) {
  assert.throws(
    () => resolvePhotonOwnerIdentity(principalId, candidateEnvironment),
    (error) =>
      error instanceof OwnerIdentityDeniedError &&
      error.code === "owner_unmapped",
  );
}

const environmentExample = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
for (const variable of [
  "EVE_DEPLOYMENT_OWNER_ID",
  "EVE_PHOTON_OWNER_PRINCIPALS",
  "EVE_OWNER_ALIAS_HMAC_SECRET",
]) {
  assert.match(environmentExample, new RegExp(`^${variable}=$`, "mu"));
}
assert.equal(environmentExample.includes(aliasA), false);
assert.equal(environmentExample.includes(secret), false);

const photonChannel = await readFile(
  new URL("../agent/channels/photon.ts", import.meta.url),
  "utf8",
);
const dispatchStart = photonChannel.indexOf("async function dispatch(");
const dispatchOwnerGuard = photonChannel.indexOf(
  'requirePhotonOwnerAccess({ principalId, resource: "session" })',
  dispatchStart,
);
const dispatchFirstStateRead = photonChannel.indexOf(
  "isFirstApprovalEvent({",
  dispatchStart,
);
assert.ok(dispatchStart >= 0 && dispatchOwnerGuard > dispatchStart);
assert.ok(dispatchOwnerGuard < dispatchFirstStateRead);

const managerChannel = await readFile(
  new URL("../agent/channels/photon-workspace-app.ts", import.meta.url),
  "utf8",
);
for (const route of ["/state`, async", "/action`,\n      async"]) {
  const routeStart = managerChannel.indexOf(route);
  const nextRoute = managerChannel.indexOf("POST(", routeStart + route.length);
  const routeSource = managerChannel.slice(
    routeStart,
    nextRoute < 0 ? undefined : nextRoute,
  );
  assert.ok(routeStart >= 0);
  assert.match(routeSource, /requirePhotonOwnerAccess\(\{/u);
}

const monitorOwner = await readFile(
  new URL("../agent/lib/event-trigger-owner.ts", import.meta.url),
  "utf8",
);
const monitorDestination = monitorOwner.indexOf(
  'if (destination.kind === "photon")',
);
const monitorOwnerGuard = monitorOwner.indexOf(
  'resource: "monitor"',
  monitorDestination,
);
const monitorStateScope = monitorOwner.indexOf(
  "const userId = stableUserId(auth)",
  monitorDestination,
);
assert.ok(monitorDestination >= 0 && monitorOwnerGuard > monitorDestination);
assert.ok(monitorOwnerGuard < monitorStateScope);

console.log("Stable deployment-owner mapping verification passed.");
