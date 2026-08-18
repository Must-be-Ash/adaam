import assert from "node:assert/strict";

import {
  listLatestStrategyPacks,
  resolveStrategyPackIntervalMinutes,
  resolveStrategyPackConfiguration,
} from "../agent/lib/strategy-pack-service";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { createXTimelineRequest } from "../agent/lib/x-public-statement-adapter";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import {
  extractCommentaryMetadata,
  recoverNamedAssetCommentaryMetadata,
} from "../agent/lib/public-commentary-semantics";
import {
  partitionPublicCommentaryStatements,
  INVERSE_CRAMER_POLICY,
} from "../agent/lib/public-commentary-vertical";
import { decideCommentaryPolicy } from "../agent/lib/commentary-policy";
import {
  resolvePublicCommentaryCommitInitialBaseline,
  resolvePublicCommentaryFirstRunLookbackStart,
} from "../agent/lib/public-commentary-workspace-worker";
import {
  digestPublicCommentaryValue,
  publicStatementSchema,
} from "../agent/lib/public-commentary-schema";

const versions = strategyPackCatalog.entries
  .filter(({ id }) => id === "inverse-cramer")
  .map(({ version }) => version);
assert.deepEqual(versions, ["1.0.0", "1.1.0"]);
assert.equal(
  strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.0.0" })?.contentDigest,
  "c84defe79be9b72da6deaa7e7c3bc9254fa27f1286a79073b260ee4b90bcb434",
);
const latestPack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.1.0" });
assert.ok(latestPack);
assert.deepEqual(
  listLatestStrategyPacks({ environment: {
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  } }).packs.filter(({ id }) => id === "inverse-cramer").map(({ version }) => version),
  ["1.1.0"],
);

for (const [value, minutes] of [
  ["minutes_10", 10], ["minutes_15", 15], ["minutes_30", 30], ["minutes_60", 60],
  ["hours_1", 60], ["hours_6", 360], ["hours_12", 720], ["hours_24", 1_440],
] as const) assert.equal(resolveStrategyPackIntervalMinutes(value), minutes);

const source = resolveReviewedPublicSource("x-jim-cramer-public-statements").sourceInstance;
const firstRun = new URL(createXTimelineRequest({
  firstRunStartAt: "2026-08-18T00:00:00.000Z",
  sourceInstance: { ...source, cursor: { contentDigest: null, revision: 0, watermark: null } },
}).url);
assert.equal(firstRun.searchParams.get("start_time"), "2026-08-18T00:00:00.000Z");
assert.equal(firstRun.searchParams.has("since_id"), false);
const subsequent = new URL(createXTimelineRequest({
  sourceInstance: { ...source, cursor: { contentDigest: "a".repeat(64), revision: 1, watermark: "123" } },
}).url);
assert.equal(subsequent.searchParams.get("since_id"), "123");
assert.equal(subsequent.searchParams.has("start_time"), false);

assert.deepEqual(partitionPublicCommentaryStatements(
  Array.from({ length: 19 }, (_, index) => index),
).map((batch) => batch.length), [8, 8, 3]);
const fullContinuationBacklog = Array.from({ length: 508 }, (_, index) => index);
const fullContinuationBatches = partitionPublicCommentaryStatements(fullContinuationBacklog);
assert.deepEqual(fullContinuationBatches.flat(), fullContinuationBacklog);
assert.equal(fullContinuationBatches.length, 64);
assert.deepEqual(fullContinuationBatches.map((batch) => batch.length).slice(-2), [8, 4]);

const text = "Intel looks bullish over the coming months.";
const extractionEnvironment = {
  EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
  EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
};
const statement = publicStatementSchema.parse({
  attribution: "direct",
  canonicalUrl: "https://x.com/jimcramer/status/123",
  contentDigest: digestPublicCommentaryValue(text),
  contentReference: { envelopeId: "revocable-evidence.x.123", revision: 1 },
  editChainIds: ["123"],
  editableUntil: "2026-08-17T23:00:00.000Z",
  entities: { cashtags: [], mentions: [], urls: [] },
  lifecycle: "final",
  observedAt: "2026-08-18T01:00:00.000Z",
  provider: "x",
  publishedAt: "2026-08-17T22:00:00.000Z",
  recordType: "public_statement",
  references: { conversationId: "123", referencedPostIds: [] },
  revision: 1,
  role: "original",
  schemaVersion: 1,
  speaker: { displayLabel: "Jim Cramer", stableId: "14216123", username: "jimcramer" },
  stablePostId: "123",
  textLocators: [{ end: text.length, spanDigest: digestPublicCommentaryValue(text), start: 0 }],
});
const intel = await extractCommentaryMetadata({
  environment: extractionEnvironment,
  recover: recoverNamedAssetCommentaryMetadata,
  statement,
  text,
});
assert.deepEqual(intel.extraction.targets, [{ displayName: "Intel", symbol: "INTC", type: "equity" }]);
assert.equal(intel.extraction.stance, "bullish");
assert.equal(intel.recovery.attempted, true);
assert.equal(intel.recovery.route.executionClass, "fast");
const intelDecision = decideCommentaryPolicy({
  extraction: intel.extraction,
  policy: INVERSE_CRAMER_POLICY,
}).decision;
assert.equal(intelDecision.decision, "research_candidate");
assert.equal(intelDecision.researchDirection, "bearish");
const lowercaseIntelText = "We gathered intel on supply chains.";
const lowercaseIntel = await extractCommentaryMetadata({
  environment: extractionEnvironment,
  recover: recoverNamedAssetCommentaryMetadata,
  statement: publicStatementSchema.parse({
    ...statement,
    contentDigest: digestPublicCommentaryValue(lowercaseIntelText),
    textLocators: [{
      end: lowercaseIntelText.length,
      spanDigest: digestPublicCommentaryValue(lowercaseIntelText),
      start: 0,
    }],
  }),
  text: lowercaseIntelText,
});
assert.deepEqual(lowercaseIntel.extraction.targets, []);
for (const [assetName, symbol] of [["Bitcoin", "BTC"], ["Ethereum", "ETH"]] as const) {
  const assetText = `${assetName} looks bullish.`;
  const recovered = await recoverNamedAssetCommentaryMetadata({
    deterministic: (await extractCommentaryMetadata({
      environment: extractionEnvironment,
      statement: publicStatementSchema.parse({
        ...statement,
        contentDigest: digestPublicCommentaryValue(assetText),
        textLocators: [{ end: assetText.length, spanDigest: digestPublicCommentaryValue(assetText), start: 0 }],
      }),
      text: assetText,
    })).extraction,
    text: assetText,
  });
  assert.deepEqual(recovered.targets, [{ displayName: assetName, symbol, type: "crypto_asset" }]);
}
const ambiguousText = "Intel and Nvidia both look bullish.";
const ambiguous = await extractCommentaryMetadata({
  environment: extractionEnvironment,
  statement: publicStatementSchema.parse({
    ...statement,
    contentDigest: digestPublicCommentaryValue(ambiguousText),
    textLocators: [{ end: ambiguousText.length, spanDigest: digestPublicCommentaryValue(ambiguousText), start: 0 }],
  }),
  text: ambiguousText,
});
assert.deepEqual(ambiguous.extraction.targets, []);
assert.equal(decideCommentaryPolicy({
  extraction: ambiguous.extraction,
  policy: INVERSE_CRAMER_POLICY,
}).decision.decision, "no_view");

assert.equal(resolvePublicCommentaryFirstRunLookbackStart({
  activationWatermark: "2026-08-18T00:30:00.000Z",
  firstRunLookback: "hours_6",
  initialBaseline: true,
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), "2026-08-18T00:30:00.000Z");
assert.equal(resolvePublicCommentaryFirstRunLookbackStart({
  activationWatermark: "2026-08-17T00:00:00.000Z",
  firstRunLookback: "hours_1",
  initialBaseline: true,
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), "2026-08-18T01:00:00.000Z");
assert.equal(resolvePublicCommentaryFirstRunLookbackStart({
  activationWatermark: "2026-08-17T00:00:00.000Z",
  firstRunLookback: "off",
  initialBaseline: true,
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), null);
assert.equal(resolvePublicCommentaryCommitInitialBaseline({
  checkpointOnlyBaseline: true,
  firstRunLookback: "off",
}), true);
assert.equal(resolvePublicCommentaryCommitInitialBaseline({
  checkpointOnlyBaseline: true,
  firstRunLookback: "hours_1",
}), false);

const watchlist = latestPack.configuration.find(({ key }) => key === "selectedSymbols");
assert.equal(watchlist?.kind, "bounded_token_list");
assert.deepEqual(watchlist?.default, []);
assert.match(watchlist?.description ?? "", /empty.*all resolved assets/iu);
const configured = resolveStrategyPackConfiguration(latestPack, {
  selectedSymbols: ["intc", "BTC"],
});
assert.deepEqual(configured.configuration.selectedSymbols, ["BTC", "INTC"]);
assert.throws(() => resolveStrategyPackConfiguration(latestPack, {
  selectedSymbols: Array.from({ length: 33 }, (_, index) => `T${index}`),
}));

console.info("Spec 4C narrow follow-up verification passed.");
