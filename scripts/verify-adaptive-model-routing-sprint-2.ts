import assert from "node:assert/strict";

import {
  createEarningsCallComparisonDefinitions,
  EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
  EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
} from "../agent/lib/hybrid-evidence-definition-registry";
import { resolveHybridTaskModelRoute } from "../agent/lib/hybrid-evidence-model-routing";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  resolveStrategyPackConfiguration,
  resolveStrategyPackInitialBudgetPolicy,
  resolveStrategyPackWorkerModelPolicy,
} from "../agent/lib/strategy-pack-service";
import { resolveEarningsCallSemanticRoute } from "../agent/lib/earnings-call-workspace-worker";

const environment: NodeJS.ProcessEnv = {
  EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
  EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
};
assert.deepEqual(resolveHybridTaskModelRoute("extraction_recovery", environment), {
  executionClass: "fast",
  modelId: "anthropic/claude-haiku-4.5",
  purpose: "extraction_recovery",
  reasoning: "provider-default",
});
const oldPack = strategyPackCatalog.resolve({
  contentDigest: "c9b0550cfa6c687e7e98949f882955971f4fcf5f1ac18a94d3293ed6bbca93b8",
  id: "earnings-call-changes",
  version: "1.0.0",
});
assert.ok(oldPack);
assert.deepEqual(oldPack.evidenceContracts, [
  {
    digest: "05369d435299b6e8c0ac3a2406f43bb1855ccd1dd71b16dec07f19421966c657",
    id: "earnings-call-semantic-comparison",
    version: "1.0.0",
  },
  {
    digest: "8622aab858c7775610c1f52a05f2a256a3448b5ea9ad5905a34f8442bfb4fc5d",
    id: "earnings-call-semantic-comparison-section",
    version: "1.0.0",
  },
  {
    digest: "a03926b5db686fe2560702f070841855297c83f0cfa10b79e74642fa9aa61344",
    id: "earnings-call-semantic-comparison-synthesis",
    version: "1.0.0",
  },
]);

const frontierRoute = resolveHybridTaskModelRoute(
  "semantic_interpretation",
  environment,
);
const frontierContracts = createEarningsCallComparisonDefinitions([
  frontierRoute.modelId,
], {
  maximumRuntimeMs: EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
  maximumSessionInputTokens: 24_000,
  maximumSessionOutputTokens: EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
}).map(({ definitionDigest, definitionId, definitionVersion }) => ({
  digest: definitionDigest,
  id: definitionId,
  version: definitionVersion,
}));
const frontierPack = strategyPackCatalog.resolve({
  id: "earnings-call-changes",
  version: "1.0.1",
});
assert.ok(frontierPack);
assert.notEqual(frontierPack.contentDigest, oldPack.contentDigest);
assert.deepEqual(frontierPack.evidenceContracts, frontierContracts);
assert.deepEqual(frontierRoute, {
  executionClass: "frontier",
  modelId: "openai/gpt-5.4",
  purpose: "semantic_interpretation",
  reasoning: "high",
});
const commentaryPack = strategyPackCatalog.resolve({
  id: "inverse-cramer",
  version: "1.2.0",
});
assert.ok(commentaryPack);
assert.deepEqual(resolveStrategyPackWorkerModelPolicy({
  environment,
  pack: commentaryPack,
}), {
  allowedModelIds: ["google/gemini-3.6-flash", frontierRoute.modelId],
  maximumOutputTokens: 12_000,
});
const commentaryBudget = resolveStrategyPackInitialBudgetPolicy(
  commentaryPack,
  resolveStrategyPackConfiguration(commentaryPack, {}).configuration,
  "2026-08-19T00:00:00.000Z",
);
assert.deepEqual(
  {
    call: commentaryBudget.maximumPaidPerCall,
    concurrent: commentaryBudget.maximumConcurrentWorkers,
    day: commentaryBudget.maximumPaidPerDay,
    month: commentaryBudget.maximumPaidPerMonth,
  },
  { call: "1.000000", concurrent: 2, day: "2.000000", month: "10.000000" },
);
const ipoPack = strategyPackCatalog.resolve({ id: "ipo-filings", version: "1.0.0" });
assert.ok(ipoPack);
const ipoBudget = resolveStrategyPackInitialBudgetPolicy(
  ipoPack,
  resolveStrategyPackConfiguration(ipoPack, {}).configuration,
  "2026-08-19T00:00:00.000Z",
);
assert.deepEqual({
  call: ipoBudget.maximumPaidPerCall,
  concurrent: ipoBudget.maximumConcurrentWorkers,
  day: ipoBudget.maximumPaidPerDay,
  month: ipoBudget.maximumPaidPerMonth,
}, { call: null, concurrent: 1, day: null, month: null });
const legacyModelId = "google/gemini-3.6-flash";
assert.deepEqual(
  resolveEarningsCallSemanticRoute({
    allowedModelIds: [legacyModelId, frontierRoute.modelId],
    environment,
    pack: oldPack,
  }),
  {
    executionClass: "frontier",
    modelId: legacyModelId,
    purpose: "semantic_interpretation",
    reasoning: "high",
  },
);
assert.deepEqual(
  resolveEarningsCallSemanticRoute({
    allowedModelIds: [legacyModelId, frontierRoute.modelId],
    environment,
    pack: frontierPack,
  }),
  frontierRoute,
);
assert.throws(
  () => resolveEarningsCallSemanticRoute({
    allowedModelIds: [frontierRoute.modelId],
    environment,
    pack: oldPack,
  }),
  /earnings_call_strategy_invalid/u,
);
assert.throws(
  () => resolveEarningsCallSemanticRoute({
    allowedModelIds: [legacyModelId, frontierRoute.modelId],
    environment,
    pack: {
      evidenceContracts: [
        ...createEarningsCallComparisonDefinitions([legacyModelId], {
          maximumRuntimeMs: EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
          maximumSessionInputTokens: 24_000,
          maximumSessionOutputTokens: EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
        }).map(({ definitionDigest, definitionId, definitionVersion }) => ({
          digest: definitionDigest,
          id: definitionId,
          version: definitionVersion,
        })),
        ...frontierPack.evidenceContracts!,
      ],
      version: frontierPack.version,
    },
  }),
  /earnings_call_strategy_invalid/u,
);

const configuration = {
  dailyTimes: ["09:00", "16:00"],
  materialityThreshold: "threshold_65",
  selectedIssuerCiks: ["0000789019"],
  timezone: "UTC",
};
assert.deepEqual(
  resolveStrategyPackConfiguration(oldPack, configuration).configuration,
  resolveStrategyPackConfiguration(frontierPack, configuration).configuration,
);
assert.equal(
  strategyPackCatalog.resolve({
    contentDigest: oldPack.contentDigest,
    id: oldPack.id,
    version: oldPack.version,
  }),
  oldPack,
);
assert.equal(
  strategyPackCatalog.resolve({
    contentDigest: frontierPack.contentDigest,
    id: frontierPack.id,
    version: frontierPack.version,
  }),
  frontierPack,
);

console.log("adaptive model routing Sprint 2 pack coexistence verification passed");
