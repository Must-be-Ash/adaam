import assert from "node:assert/strict";

import {
  completePhotonSessionMigration,
  releasePhotonSessionMigration,
  reservePhotonSessionMigration,
} from "../agent/lib/photon-session-store.ts";

class MemoryStore {
  #values = new Map();

  async del(key) {
    return this.#values.delete(key) ? 1 : 0;
  }

  async get(key) {
    return this.#values.get(key) ?? null;
  }

  async set(key, value, options) {
    if (options.nx && this.#values.has(key)) return null;
    this.#values.set(key, value);
    return "OK";
  }
}

const client = new MemoryStore();
const route = {
  generation: 1,
  principalId: "imessage:test-principal",
  threadId: "test-thread",
};

const first = await reservePhotonSessionMigration(route, client);
assert.equal(first.status, "acquired");
if (first.status !== "acquired") throw new Error("Expected a reservation.");

assert.deepEqual(await reservePhotonSessionMigration(route, client), {
  status: "busy",
});
assert.equal(
  await completePhotonSessionMigration(
    {
      ...route,
      migrationToken: "wrong-token",
      sessionId: "wrong-session",
    },
    client,
  ),
  false,
);
assert.equal(
  await completePhotonSessionMigration(
    {
      ...route,
      migrationToken: first.migrationToken,
      sessionId: "current-session",
    },
    client,
  ),
  true,
);

const current = await reservePhotonSessionMigration(route, client);
assert.equal(current.status, "current");
if (current.status !== "current") throw new Error("Expected current binding.");
assert.equal(current.binding.sessionId, "current-session");

const retryRoute = { ...route, threadId: "retry-thread" };
const retryReservation = await reservePhotonSessionMigration(retryRoute, client);
assert.equal(retryReservation.status, "acquired");
if (retryReservation.status !== "acquired") {
  throw new Error("Expected a retry reservation.");
}
await releasePhotonSessionMigration(
  {
    ...retryRoute,
    migrationToken: retryReservation.migrationToken,
  },
  client,
);
assert.equal(
  (await reservePhotonSessionMigration(retryRoute, client)).status,
  "acquired",
);

console.log("Photon session migration verification passed.");
