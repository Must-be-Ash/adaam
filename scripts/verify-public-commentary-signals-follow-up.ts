import assert from "node:assert/strict";

import {
  listLatestStrategyPacks,
  resolveStrategyPackIntervalMinutes,
  resolveStrategyPackConfiguration,
  resolveStrategyPackInitialMonitorDueAt,
} from "../agent/lib/strategy-pack-service";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { createXTimelineRequest } from "../agent/lib/x-public-statement-adapter";
import {
  resolveHybridEvidenceWorkerAuthEnvironment,
  resolveHybridEvidenceWorkerIssuedAt,
} from "../agent/lib/hybrid-evidence-worker";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import {
  commentarySemanticWorkerCandidateSchema,
  createCommentarySemanticDefinition,
  extractCommentaryMetadata,
  recoverNamedAssetCommentaryMetadata,
} from "../agent/lib/public-commentary-semantics";
import {
  partitionPublicCommentaryStatements,
  INVERSE_CRAMER_POLICY,
} from "../agent/lib/public-commentary-vertical";
import { decideCommentaryPolicy } from "../agent/lib/commentary-policy";
import {
  drainPublicCommentaryHybridWorker,
  resolvePublicCommentaryCommitInitialBaseline,
  resolvePublicCommentaryFirstRunStart,
} from "../agent/lib/public-commentary-workspace-worker";
import {
  digestPublicCommentaryValue,
  publicStatementSchema,
} from "../agent/lib/public-commentary-schema";
import { resolveWorkspaceWorkerEvaluationWindow } from "../agent/lib/workspace-worker-runner";

const versions = strategyPackCatalog.entries
  .filter(({ id }) => id === "inverse-cramer")
  .map(({ version }) => version);
assert.deepEqual(versions, ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);
assert.equal(
  strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.0.0" })?.contentDigest,
  "c84defe79be9b72da6deaa7e7c3bc9254fa27f1286a79073b260ee4b90bcb434",
);
const latestPack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.3.0" });
assert.ok(latestPack);
const semanticDefinition = createCommentarySemanticDefinition(["openai/gpt-5.4"]);
const scheduledAt = new Date("2026-08-19T18:23:12.551Z");
const dispatchedAt = new Date("2026-08-19T18:24:31.000Z");
assert.equal(resolveHybridEvidenceWorkerIssuedAt({
  issuedAt: dispatchedAt,
  now: scheduledAt,
}).toISOString(), dispatchedAt.toISOString());
const injectedAuthEnvironment = { EVE_HYBRID_EVIDENCE_AUTH_SECRET: "injected" };
const liveProductionEnvironment = { EVE_HYBRID_EVIDENCE_AUTH_SECRET: "live", VERCEL: "1" };
assert.equal(
  resolveHybridEvidenceWorkerAuthEnvironment(injectedAuthEnvironment, liveProductionEnvironment),
  liveProductionEnvironment,
);
assert.equal(
  resolveHybridEvidenceWorkerAuthEnvironment(injectedAuthEnvironment, {}),
  injectedAuthEnvironment,
);
assert.equal(semanticDefinition.definitionVersion, "1.1.0");
assert.equal(semanticDefinition.limits.maximumInputTokens, 12_000);
const semanticCitation = {
  artifactDigest: "a".repeat(64),
  end: 4,
  kind: "text_span" as const,
  spanDigest: "b".repeat(64),
  start: 0,
};
assert.equal(commentarySemanticWorkerCandidateSchema.safeParse({
  citations: [semanticCitation],
  disposition: "accepted",
  fields: { facts: ["not the registered assertion shape"] },
  unknowns: [],
}).success, false);
assert.equal(commentarySemanticWorkerCandidateSchema.safeParse({
  citations: [semanticCitation],
  disposition: "accepted",
  fields: {
    assumptions: [],
    confidence: "low",
    counterevidence: [],
    facts: [{ citations: [semanticCitation], statement: "Exact cited statement." }],
    forecast: null,
    horizon: "unspecified",
    inferences: [],
    outcome: "no_view",
    rationale: "The evidence is insufficient for a directional view.",
    recommendation: {
      action: "no_view",
      assumptions: [],
      citations: [semanticCitation],
      rationale: "Keep the statement visible without a research candidate.",
    },
  },
  unknowns: [],
}).success, true);
assert.equal(commentarySemanticWorkerCandidateSchema.safeParse({
  citations: [semanticCitation],
  disposition: "accepted",
  fields: {
    assumptions: [],
    confidence: "low",
    counterevidence: [],
    facts: [{ citations: [semanticCitation], statement: "Exact cited statement." }],
    forecast: {
      catalysts: [],
      invalidationConditions: [],
      likelyImplication: { citations: [semanticCitation], statement: "Possible implication." },
      risks: [],
      scenarios: [{
        citations: [semanticCitation],
        condition: "If the statement remains relevant.",
        direction: "uncertain",
        label: "base",
        rationale: "The evidence is bounded.",
      }],
    },
    horizon: "unspecified",
    inferences: [{ citations: [semanticCitation], statement: "Bounded inference." }],
    outcome: "no_view",
    rationale: "The evidence is insufficient.",
    recommendation: { action: "no_view", assumptions: [], citations: [], rationale: "No view." },
  },
  unknowns: ["Material context is absent."],
}).success, false);
assert.deepEqual(latestPack.evidenceContracts.find(({ id }) =>
  id === "public-commentary-semantic-interpretation"), {
  digest: semanticDefinition.definitionDigest,
  id: "public-commentary-semantic-interpretation",
  version: "1.1.0",
});
assert.equal(latestPack.monitors[0]?.suggestedBudget.maximumInputTokensPerRun, 12_000);
const workerRequest = {} as Parameters<typeof drainPublicCommentaryHybridWorker>[0];
await assert.rejects(
  drainPublicCommentaryHybridWorker(workerRequest, async () => ({
    events: new ReadableStream({ start(controller) {
      controller.enqueue({
        data: {
          code: "SESSION_TOKEN_LIMIT_REACHED",
          message: "The session reached its configured input token limit.",
          sequence: 1,
          stepIndex: 1,
          turnId: "turn.token-limit",
        },
        type: "step.failed",
      });
      controller.close();
    } }),
    sessionId: "session.token-limit",
  }) as never),
  /hybrid_evidence_worker_failed:SESSION_TOKEN_LIMIT_REACHED/u,
);
await drainPublicCommentaryHybridWorker(workerRequest, async () => ({
  events: new ReadableStream({ start(controller) {
    controller.enqueue({
      data: {
        result: {
          isError: false,
          kind: "tool-result",
          toolName: "complete_hybrid_evidence_job",
        },
        status: "completed",
        turnId: "turn.completed",
      },
      type: "action.result",
    });
    // Production Eve streams can remain open while the child session settles.
    // The durable completion result must release the parent immediately.
  } }),
  sessionId: "session.completed",
}) as never);
assert.deepEqual(
  listLatestStrategyPacks({ environment: {
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  } }).packs.filter(({ id }) => id === "inverse-cramer").map(({ version }) => version),
  ["1.3.0"],
);
assert.equal(latestPack.configuration.some(({ key }) => key === "firstRunLookback"), false);
assert.equal(resolveStrategyPackInitialMonitorDueAt({
  activate: true,
  now: new Date("2026-08-18T02:00:00.000Z"),
  packId: "inverse-cramer",
  scheduledAt: "2026-08-18T14:00:00.000Z",
}), "2026-08-18T02:00:00.000Z");
assert.deepEqual(resolveWorkspaceWorkerEvaluationWindow({
  monitor: {
    createdAt: "2026-08-18T02:00:00.000Z",
    managedBy: { packId: "inverse-cramer", packVersion: "1.3.0" },
    schedule: { anchor: "2026-08-18T02:00:00.000Z", everyMinutes: 720, kind: "interval" },
    sourceCheckpoint: { contentDigest: null, watermark: null },
  },
  occurrence: { scheduledFor: "2026-08-18T02:00:00.000Z" },
} as never), {
  endAt: "2026-08-18T02:00:00.000Z",
  startAt: "2026-08-17T14:00:00.000Z",
});
assert.equal(resolveStrategyPackInitialMonitorDueAt({
  activate: true,
  now: new Date("2026-08-18T02:00:00.000Z"),
  packId: "public-commentary-tracker",
  scheduledAt: "2026-08-18T14:00:00.000Z",
}), "2026-08-18T02:00:00.000Z");

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

assert.equal(resolvePublicCommentaryFirstRunStart({
  activationWatermark: "2026-08-18T00:30:00.000Z",
  cadence: "hours_6",
  initialBaseline: true,
  firstRunLookback: undefined,
  pack: { id: "inverse-cramer", version: "1.3.0" },
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), "2026-08-17T20:00:00.000Z");
assert.equal(resolvePublicCommentaryFirstRunStart({
  activationWatermark: "2026-08-17T00:00:00.000Z",
  cadence: "hours_12",
  initialBaseline: true,
  firstRunLookback: undefined,
  pack: { id: "inverse-cramer", version: "1.3.0" },
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), "2026-08-17T14:00:00.000Z");
assert.equal(resolvePublicCommentaryFirstRunStart({
  activationWatermark: "2026-08-17T00:00:00.000Z",
  cadence: "hours_1",
  initialBaseline: true,
  firstRunLookback: "off",
  pack: { id: "inverse-cramer", version: "1.1.0" },
  windowEndAt: "2026-08-18T02:00:00.000Z",
}), null);
assert.equal(resolvePublicCommentaryCommitInitialBaseline({
  checkpointOnlyBaseline: true,
  cadenceDerivedBackfill: false,
  firstRunLookback: "off",
}), true);
assert.equal(resolvePublicCommentaryCommitInitialBaseline({
  checkpointOnlyBaseline: true,
  cadenceDerivedBackfill: true,
  firstRunLookback: undefined,
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
