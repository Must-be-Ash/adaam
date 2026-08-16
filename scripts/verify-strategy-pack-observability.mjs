import assert from "node:assert/strict";

import {
  emitStrategyPackObservation,
  safeStrategyPackReasonCode,
} from "../agent/lib/strategy-pack-observability.ts";

const captured = [];
const sink = (observation) => captured.push(observation);
emitStrategyPackObservation({
  counter: "strategy_pack_configuration_total",
  outcome: "committed",
  packId: "ipo-filings",
}, sink);
emitStrategyPackObservation({
  counter: "strategy_pack_mutation_conflict_total",
  reasonCode: safeStrategyPackReasonCode({ code: "strategy_pack_mutation_conflict" }),
}, sink);
assert.deepEqual(captured, [
  {
    counter: "strategy_pack_configuration_total",
    outcome: "committed",
    packId: "ipo-filings",
    value: 1,
  },
  {
    counter: "strategy_pack_mutation_conflict_total",
    reasonCode: "conflict",
    value: 1,
  },
]);
const privateValues = {
  configuration: { dailyTimes: ["09:00"] },
  digest: "f".repeat(64),
  instruction: "private instruction",
  ownerId: "owner_private",
  sourceUrl: "https://private.example.test/path",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
};
for (const [key, value] of Object.entries(privateValues)) {
  assert.throws(() => emitStrategyPackObservation({
    counter: "strategy_pack_mutation_failure_total",
    [key]: value,
  }, sink));
}
assert.equal(
  JSON.stringify(captured).includes("private") ||
    JSON.stringify(captured).includes("123e4567") ||
    JSON.stringify(captured).includes("09:00"),
  false,
);
assert.equal(safeStrategyPackReasonCode(new Error("owner_private 09:00")), "storage_failure");

console.info("Strategy-pack observability privacy verification passed.");
