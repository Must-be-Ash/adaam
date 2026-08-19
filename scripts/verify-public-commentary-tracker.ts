import assert from "node:assert/strict";

import {
  classifyPublicCommentaryImpact,
  parsePublicCommentaryImpactHypotheses,
  resolvePublicCommentaryTrackerSourcePolicy,
} from "../agent/lib/public-commentary-tracker";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveStrategyPackConfiguration } from "../agent/lib/strategy-pack-service";
import { resolveStrategyPackSourceInstances } from "../agent/lib/strategy-pack-service";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import {
  mintXPublicIdentityResolutionReceipt,
  normalizeXPublicProfile,
  resolveXPublicIdentity,
  verifyXPublicIdentityResolutionReceipt,
} from "../agent/lib/x-public-identity";

const pack = strategyPackCatalog.resolve({ id: "public-commentary-tracker", version: "1.0.0" });
assert.ok(pack);
assert.equal(pack.displayName, "Public Commentary Tracker");
assert.equal(pack.capabilities.required.includes("evaluate_public_commentary_signals"), true);
assert.equal(pack.capabilities.hardDenied.includes("financial.mutation"), true);

const configured = resolveStrategyPackConfiguration(pack, {});
assert.equal(configured.configuration.trackerName, "Trump–Iran Oil Tracker");
assert.equal(configured.configuration.monitoringObjective,
  "Detect statements suggesting escalation, de-escalation, war, negotiations, ceasefire, or peace involving Iran.");
assert.deepEqual(configured.configuration.xIdentity, [
  "https://x.com/realDonaldTrump",
  "realDonaldTrump",
  "Donald J. Trump",
  "25073877",
  "confirmed",
]);
assert.deepEqual(configured.configuration.impactHypotheses, [
  "de-escalation, ceasefire, or peace|OIL|down",
  "escalation or worsening conflict|OIL|up",
]);

const sensitivePreset = resolvePublicCommentaryTrackerSourcePolicy(configured.configuration);
assert.equal(sensitivePreset.sourceKind, "official_white_house");
assert.equal(sensitivePreset.xEnabled, false);
assert.match(sensitivePreset.reason, /sensitive.event/iu);
assert.throws(() => resolvePublicCommentaryTrackerSourcePolicy({
  ...configured.configuration,
  trackerName: "Custom Iran tracker",
}), /sensitive_source_unavailable/u);

const ordinary = resolvePublicCommentaryTrackerSourcePolicy({
  ...configured.configuration,
  monitoringObjective: "Detect public comments about semiconductor demand and product launches.",
  topics: ["semiconductors", "product launches"],
});
assert.equal(ordinary.sourceKind, "x_user_timeline");
assert.equal(ordinary.xEnabled, true);
assert.equal(ordinary.numericUserId, "25073877");

const firstPartySource = resolveStrategyPackSourceInstances(pack, configured.configuration);
assert.equal(firstPartySource.length, 1);
assert.equal(firstPartySource[0]?.canonicalUrl, "https://www.whitehouse.gov/briefings-statements/feed/");
assert.equal(resolveReviewedPublicSource(firstPartySource[0]!.sourceId).adapterDefinition.adapterId, "official-web-statements");
const ordinarySource = resolveStrategyPackSourceInstances(pack, {
  ...configured.configuration,
  monitoringObjective: "Detect public comments about semiconductor demand and product launches.",
  topics: ["product launches", "semiconductors"],
});
assert.equal(ordinarySource.length, 1);
assert.equal(ordinarySource[0]?.canonicalUrl, "https://api.x.com/2/users/25073877/tweets");
assert.equal(resolveReviewedPublicSource(ordinarySource[0]!.sourceId).sourceInstance.configuration.kind, "x_public_statements_user");
assert.deepEqual(normalizeXPublicProfile("@realDonaldTrump"), {
  profileUrl: "https://x.com/realDonaldTrump",
  username: "realDonaldTrump",
});
const resolvedIdentity = await resolveXPublicIdentity({
  environment: { X_BEARER_TOKEN: "fixture" },
  fetchImpl: async (url) => new Response(JSON.stringify({
    data: { id: "25073877", name: "Donald J. Trump", username: "realDonaldTrump" },
  }), { status: 200, headers: { "content-type": "application/json" } }),
  profile: "https://x.com/realDonaldTrump",
});
assert.deepEqual(resolvedIdentity, {
  displayName: "Donald J. Trump",
  numericUserId: "25073877",
  profileUrl: "https://x.com/realDonaldTrump",
  username: "realDonaldTrump",
});
const receiptSecret = "identity-receipt-secret-that-is-at-least-32-bytes";
const receiptScope = { issuedAt: new Date("2026-08-18T12:00:00.000Z"), principalId: "owner_acceptance", threadId: "thread_acceptance" };
const receipt = mintXPublicIdentityResolutionReceipt(resolvedIdentity, receiptScope, receiptSecret);
assert.doesNotThrow(() => verifyXPublicIdentityResolutionReceipt(receipt, resolvedIdentity, {
  now: new Date("2026-08-18T12:14:59.000Z"),
  principalId: receiptScope.principalId,
  threadId: receiptScope.threadId,
}, receiptSecret));
assert.throws(() => verifyXPublicIdentityResolutionReceipt(receipt, resolvedIdentity, {
  now: new Date("2026-08-18T12:15:01.000Z"),
  principalId: receiptScope.principalId,
  threadId: receiptScope.threadId,
}, receiptSecret), /receipt_invalid/u);
assert.throws(() => verifyXPublicIdentityResolutionReceipt(receipt, resolvedIdentity, {
  now: new Date("2026-08-18T12:01:00.000Z"),
  principalId: receiptScope.principalId,
  threadId: "other_thread",
}, receiptSecret), /receipt_invalid/u);

const hypotheses = parsePublicCommentaryImpactHypotheses(configured.configuration.impactHypotheses);
assert.deepEqual(hypotheses.map(({ asset, pressure }) => [asset, pressure]), [["OIL", "down"], ["OIL", "up"]]);
assert.deepEqual(
  classifyPublicCommentaryImpact("We have agreed to a ceasefire and negotiations with Iran.", hypotheses),
  { asset: "OIL", classification: "de_escalation", pressure: "down" },
);
assert.deepEqual(
  classifyPublicCommentaryImpact("The conflict is worsening and further escalation is possible.", hypotheses),
  { asset: "OIL", classification: "escalation", pressure: "up" },
);
assert.equal(
  classifyPublicCommentaryImpact("We discussed several unrelated matters.", hypotheses).classification,
  "unclear",
);
assert.equal(
  classifyPublicCommentaryImpact("A ceasefire was announced in Gaza.", hypotheses, ["Iran", "ceasefire"]).classification,
  "unclear",
);
assert.equal(
  classifyPublicCommentaryImpact("There may be escalation, but a ceasefire is also possible.", hypotheses).classification,
  "mixed",
);

console.info("Configurable Public Commentary Tracker verification passed.");
