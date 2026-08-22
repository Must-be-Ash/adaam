import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyPublicCommentaryImpact,
  parsePublicCommentaryImpactHypotheses,
  resolvePublicCommentaryTrackerSourcePolicy,
} from "../agent/lib/public-commentary-tracker";
import {
  createPublicCommentaryImpactDefinition,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  PUBLIC_COMMENTARY_COMPACT_EVALUATION_DEFINITION_IDS,
  PUBLIC_COMMENTARY_DIRECT_MODEL_DEFINITION_IDS,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
} from "../agent/lib/public-commentary-semantics";
import { resolvePublicCommentarySemanticReasoning } from "../agent/lib/public-commentary-workspace-worker";
import { resolveHybridEvidenceWorkerContract } from "../agent/lib/hybrid-evidence-worker-contract-registry";
import { workspaceSemanticValidationRegistry } from "../agent/lib/hybrid-evidence-definition-registry";
import {
  monitorPreparations,
  resolveStrategyPackInitialBudgetPolicy,
} from "../agent/lib/strategy-pack-service";

import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
  COMMENTARY_DIRECTION_INVERSION_CONTRACT_ID,
  INVERSE_CRAMER_POLICY,
  PUBLIC_COMMENTARY_TRACKER_POLICY,
  resolvePublicCommentaryInterpretationContract,
} from "../agent/lib/public-commentary-interpretation-contract";
import { decideCommentaryPolicy } from "../agent/lib/commentary-policy";
import { commentaryExtractionSchema } from "../agent/lib/public-commentary-schema";
import { resolveManagedMonitorLifecycleContract } from "../agent/lib/workspace-monitor-lifecycle-contract";
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

// The tracker reuses the shared commentary vertical through the interpretation
// contract its pack declares. Generic plumbing must select that behavior from
// the declaration alone, so a differently configured commentary strategy needs
// no branch in shared code.
const currentPack = strategyPackCatalog.resolve({ id: "public-commentary-tracker", version: "1.2.0" });
assert.ok(currentPack);
assert.deepEqual(
  currentPack.evidenceContracts?.find(({ id }) => id === COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID),
  {
    digest: PUBLIC_COMMENTARY_TRACKER_POLICY.policy.definitionDigest,
    id: COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
    version: "1.0.0",
  },
);
assert.equal(
  resolvePublicCommentaryInterpretationContract(currentPack)?.actionability,
  "configured_impact_hypothesis",
);
// Published versions cannot declare the contract; their exact bindings keep the
// behavior they shipped with.
for (const version of ["1.0.0", "1.1.0"]) {
  const historical = strategyPackCatalog.resolve({ id: "public-commentary-tracker", version });
  assert.ok(historical);
  assert.equal(historical.evidenceContracts?.some(({ id }) =>
    id === COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID), false);
  assert.equal(
    resolvePublicCommentaryInterpretationContract(historical)?.id,
    COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
  );
}
// Every published commentary version must resolve a contract: the shared worker
// terminalizes an occurrence it cannot resolve, so a missing binding would take
// a live monitor down rather than degrade it.
for (const entry of strategyPackCatalog.entries) {
  if (entry.id !== "inverse-cramer" && entry.id !== "public-commentary-tracker") continue;
  assert.equal(
    resolvePublicCommentaryInterpretationContract(entry)?.id,
    entry.id === "inverse-cramer"
      ? COMMENTARY_DIRECTION_INVERSION_CONTRACT_ID
      : COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
    `${entry.id}@${entry.version} must resolve an interpretation contract`,
  );
}
// Resolution reads the declaration, not the identity: an unrelated pack id that
// declares the tracker's contract resolves to it, and one that declares nothing
// resolves to nothing.
assert.equal(
  resolvePublicCommentaryInterpretationContract({
    evidenceContracts: [{ id: COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID, version: "1.0.0" }],
    id: "some-other-commentary-strategy",
    version: "9.9.9",
  })?.actionability,
  "configured_impact_hypothesis",
);
assert.equal(
  resolvePublicCommentaryInterpretationContract({
    evidenceContracts: [{ id: COMMENTARY_DIRECTION_INVERSION_CONTRACT_ID, version: "1.0.0" }],
    id: "some-other-commentary-strategy",
    version: "9.9.9",
  })?.actionability,
  "deterministic_market_view",
);
assert.equal(
  resolvePublicCommentaryInterpretationContract({
    evidenceContracts: [],
    id: "some-other-commentary-strategy",
    version: "9.9.9",
  }),
  null,
);
// Two commentary strategies reach opposite conclusions on the same normalized
// extraction because their declared contracts carry different registered
// transforms, not because shared plumbing knows either of them.
const bullishExtraction = commentaryExtractionSchema.parse({
  attribution: "direct",
  confidence: "high",
  evidence: [{ end: 12, spanDigest: "a".repeat(64), start: 0 }],
  extractionId: "commentary-extraction.contract-contrast",
  horizon: "unspecified",
  recordType: "commentary_extraction",
  schemaVersion: 1,
  stance: "bullish",
  targets: [{ displayName: "Oil", symbol: "OIL", type: "commodity" }],
  topic: "investment_view",
  voiceOwnership: "speaker",
});
assert.equal(
  decideCommentaryPolicy({ extraction: bullishExtraction, policy: PUBLIC_COMMENTARY_TRACKER_POLICY })
    .decision.researchDirection,
  "bullish",
);
assert.equal(
  decideCommentaryPolicy({ extraction: bullishExtraction, policy: INVERSE_CRAMER_POLICY })
    .decision.researchDirection,
  "bearish",
);
// The migrated version declares its monitor lifecycle instead of relying on the
// legacy pack-version binding, and keeps the cadence behavior it shipped with.
assert.equal(currentPack.monitors[0]?.lifecycleContractId, "monitor.public-commentary-cadence/v1");
assert.equal(
  resolveManagedMonitorLifecycleContract({
    lifecycleContractId: currentPack.monitors[0]?.lifecycleContractId,
  })?.initialEvaluationWindow,
  resolveManagedMonitorLifecycleContract({
    managedBy: {
      packId: "public-commentary-tracker",
      packVersion: "1.1.0",
      resourceId: "evaluate-public-commentary",
    },
  })?.initialEvaluationWindow,
);
// One occurrence runs the shared worker session plus bounded interpretation
// children. Versions 1.0.0-1.1.0 reserved less per run than the worker session
// alone declares, so the session could never commit an outcome.
assert.deepEqual(currentPack.monitors[0]?.suggestedBudget, {
  maximumInputTokensPerRun: 160_000,
  maximumOutputTokensPerRun: 32_000,
  maximumRunsPerDay: 144,
});
const workerAgent = readFileSync(
  new URL("../agent/subagents/workspace-worker/agent.ts", import.meta.url),
  "utf8",
);
const declaredSessionOutput = Number(
  /maxOutputTokensPerSession:\s*([\d_]+)/u.exec(workerAgent)?.[1]?.replaceAll("_", "") ?? "0",
);
const declaredSessionInput = Number(
  /maxInputTokensPerSession:\s*([\d_]+)/u.exec(workerAgent)?.[1]?.replaceAll("_", "") ?? "0",
);
assert.ok(declaredSessionOutput > 0 && declaredSessionInput > 0);
assert.ok(currentPack.monitors[0]!.suggestedBudget.maximumOutputTokensPerRun >= declaredSessionOutput);
assert.ok(currentPack.monitors[0]!.suggestedBudget.maximumInputTokensPerRun >= declaredSessionInput);

// The keyword classifier is exactly why 1.3.0 exists. These cases are the ones
// it silently drops or misattributes, and they must stay dropped only for the
// historical versions that shipped that behavior.
const missedByKeywords = [
  "Oil just ripped on the Strait headlines. Positioning is getting violent.",
  "Tehran signalled it wants the talks restarted. Crude should feel that.",
];
for (const text of missedByKeywords) {
  assert.equal(
    classifyPublicCommentaryImpact(text, hypotheses, ["Iran"]).classification,
    "unclear",
    "the literal matcher drops plain-language signals, which is the defect 1.3.0 removes",
  );
}
// The matcher also attributes any match to the configured asset, whatever the
// statement is actually about.
const goldHypotheses = parsePublicCommentaryImpactHypotheses([
  "escalation or worsening conflict|GOLD|up",
]);
assert.equal(
  classifyPublicCommentaryImpact(
    "Escalation in the region; copper and shipping rates are the story here.",
    goldHypotheses,
  ).asset,
  "GOLD",
  "the literal matcher pins the configured asset regardless of the statement",
);

const directModelPack = strategyPackCatalog.resolve({
  id: "public-commentary-tracker",
  version: "1.3.0",
});
assert.ok(directModelPack);
// 1.3.0 declares the compact evaluation contract, so the shared worker sends
// every statement to the model instead of pre-filtering by keyword.
assert.deepEqual(
  directModelPack.evidenceContracts?.find(({ id }) => id === PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID),
  {
    digest: createPublicCommentaryImpactDefinition(["openai/gpt-5.4"]).definitionDigest,
    id: PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
    version: "1.0.0",
  },
);
assert.equal(
  PUBLIC_COMMENTARY_DIRECT_MODEL_DEFINITION_IDS.includes(PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID),
  true,
);
assert.equal(
  PUBLIC_COMMENTARY_COMPACT_EVALUATION_DEFINITION_IDS.includes(PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID),
  true,
);
assert.equal(resolvePublicCommentarySemanticReasoning(directModelPack, { reasoning: "high" }), "low");
// Published versions keep the deterministic path they shipped with.
for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
  const historical = strategyPackCatalog.resolve({ id: "public-commentary-tracker", version })!;
  assert.equal(
    historical.evidenceContracts?.some(({ id }) =>
      PUBLIC_COMMENTARY_DIRECT_MODEL_DEFINITION_IDS.includes(id)),
    false,
  );
  assert.equal(resolvePublicCommentarySemanticReasoning(historical, { reasoning: "high" }), "high");
}
// The direction policy is unchanged: the tracker preserves what the model read,
// where Inverse Cramer inverts it.
assert.equal(
  resolvePublicCommentaryInterpretationContract(directModelPack)?.id,
  COMMENTARY_CONFIGURED_IMPACT_CONTRACT_ID,
);
// The compact contract is registered for the worker's completion tool and for
// validation, or an accepted classification could never commit.
assert.equal(
  resolveHybridEvidenceWorkerContract(PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID)?.research,
  null,
);
assert.ok(resolveHybridEvidenceWorkerContract(PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID));
const impactDefinition = createPublicCommentaryImpactDefinition(["openai/gpt-5.4"]);
assert.equal(
  workspaceSemanticValidationRegistry.resolve(impactDefinition)?.outputSchema.schemaId,
  "public-commentary-impact-result",
);
// The instruction must forbid the keyword gate in the model's own contract.
assert.match(impactDefinition.instructionTemplate.content, /do not require a cashtag/iu);
assert.match(impactDefinition.instructionTemplate.content, /read from the statement/iu);
assert.match(impactDefinition.instructionTemplate.content, /never override the statement/iu);
assert.match(impactDefinition.instructionTemplate.content, /abstained when/iu);
assert.equal(impactDefinition.definitionId !== INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID, true);

// The sensitive-event gate is untouched by the new version.
const trackerConfiguration = resolveStrategyPackConfiguration(directModelPack, {}).configuration;
assert.equal(
  resolvePublicCommentaryTrackerSourcePolicy(trackerConfiguration).sourceKind,
  "official_white_house",
);
assert.throws(() => resolvePublicCommentaryTrackerSourcePolicy({
  ...trackerConfiguration,
  trackerName: "Custom Iran tracker",
}), /sensitive_source_unavailable/u);
// A non-sensitive tracker resolves to a paid X timeline, and its initial budget
// must carry paid ceilings or the first timeline read cannot be reserved.
const marketConfiguration = {
  ...trackerConfiguration,
  monitoringObjective: "Detect posts reporting material moves across crypto, equities, rates, and commodities.",
  topics: ["commodities", "crypto", "equities", "rates"],
};
assert.equal(
  resolveStrategyPackSourceInstances(directModelPack, marketConfiguration)[0]?.allowedOrigins.includes(
    "https://api.x.com"),
  true,
);
const marketBudget = resolveStrategyPackInitialBudgetPolicy(
  directModelPack,
  marketConfiguration as Record<string, string | string[]>,
  "2026-08-22T00:00:00.000Z",
);
assert.notEqual(marketBudget.maximumPaidPerCall, null);
assert.notEqual(marketBudget.maximumPaidPerDay, null);
assert.equal(marketBudget.maximumInputTokensPerRun, 160_000);
assert.equal(marketBudget.maximumOutputTokensPerRun, 32_000);

// A monitor reading a paid source reserves that read as a child of the run's
// paid envelope. Production terminalized the first Tracker Live occurrence as
// budget_exhausted because that envelope was derived only from a research
// contract, which this pack does not declare, leaving the parent ceiling at
// zero. The run envelope must cover the per-call allowance the worker reserves.
const marketMonitors = monitorPreparations({
  activate: new Set<string>(),
  budget: marketBudget,
  configuration: marketConfiguration as Record<string, string | string[]>,
  deliverySubscriptionId: "delivery.tracker-live",
  now: new Date("2026-08-22T21:00:00.000Z"),
  pack: directModelPack,
  scope: authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: "88888888-8888-4888-8888-888888888888" },
    { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
  ),
});
assert.equal(marketMonitors.length, 1);
assert.equal(
  marketMonitors[0]?.monitor.sources.some(({ origin }) => origin === "https://api.x.com"),
  true,
);
assert.equal(
  marketMonitors[0]?.monitor.tighteningLimits.paidPerRun,
  marketBudget.maximumPaidPerCall,
  "a paid-source monitor's run envelope must cover the read the worker reserves",
);
// The first-party preset reads a free source and needs no paid envelope.
const firstPartyMonitors = monitorPreparations({
  activate: new Set<string>(),
  budget: resolveStrategyPackInitialBudgetPolicy(
    directModelPack,
    trackerConfiguration as Record<string, string | string[]>,
    "2026-08-22T00:00:00.000Z",
  ),
  configuration: trackerConfiguration as Record<string, string | string[]>,
  deliverySubscriptionId: "delivery.first-party",
  now: new Date("2026-08-22T21:00:00.000Z"),
  pack: directModelPack,
  scope: authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: "99999999-9999-4999-8999-999999999999" },
    { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
  ),
});
assert.equal(firstPartyMonitors[0]?.monitor.tighteningLimits.paidPerRun, null);
// A research-backed pack keeps the envelope its research lane declares.
const cramerPack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.7" })!;
const cramerConfiguration = resolveStrategyPackConfiguration(cramerPack, {})
  .configuration as Record<string, string | string[]>;
const cramerMonitors = monitorPreparations({
  activate: new Set<string>(),
  budget: resolveStrategyPackInitialBudgetPolicy(
    cramerPack,
    cramerConfiguration,
    "2026-08-22T00:00:00.000Z",
  ),
  configuration: cramerConfiguration,
  deliverySubscriptionId: "delivery.cramer",
  now: new Date("2026-08-22T21:00:00.000Z"),
  pack: cramerPack,
  scope: authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
  ),
});
assert.equal(cramerMonitors[0]?.monitor.tighteningLimits.paidPerRun, "3.500000");

console.info("Configurable Public Commentary Tracker verification passed.");
