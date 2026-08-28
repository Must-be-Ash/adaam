import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createSecIpoResearchDefinition,
  isSecIpoAgenticResearchPack,
  secIpoResearchValidationContract,
  SEC_IPO_RESEARCH_DEFINITION_ID,
} from "../agent/lib/sec-ipo-semantics";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  resolveStrategyPackInitialBudgetPolicy,
  resolveStrategyPackWorkerModelPolicy,
} from "../agent/lib/strategy-pack-service";

const environment = {
  EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
  EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  EVE_STRATEGY_PACK_WORKER_MODEL_ID: "zai/glm-5.3-flash",
};

const historical = strategyPackCatalog.resolve({
  contentDigest: "509e1a06a7bf2d8de6cd216ff894f9353870cc8062fff0945cde4ba7ad2a0fce",
  id: "ipo-filings",
  version: "1.0.0",
});
assert.ok(historical, "the immutable IPO 1.0.0 digest must remain available");
assert.equal(isSecIpoAgenticResearchPack(historical), false);
assert.equal(historical.evidenceContracts?.length ?? 0, 0);

const adopted = strategyPackCatalog.resolve({ id: "ipo-filings", version: "1.1.0" });
assert.ok(adopted, "the new immutable IPO research version must be available");
assert.equal(isSecIpoAgenticResearchPack(adopted), true);
assert.equal(adopted.capabilities.required.includes("evaluate_sec_ipo_source"), true);
assert.equal(adopted.capabilities.required.includes("web.search"), false);
assert.equal(adopted.capabilities.hardDenied.includes("coinbase_create_order"), true);
assert.equal(adopted.capabilities.hardDenied.includes("interactive.approval"), true);

const policy = resolveStrategyPackWorkerModelPolicy({
  environment,
  pack: adopted,
});
assert.deepEqual(policy.allowedModelIds, [
  "zai/glm-5.3-flash",
  "openai/gpt-5.4",
]);
const definition = createSecIpoResearchDefinition(["openai/gpt-5.4"], "1.0.0");
assert.equal(definition.definitionId, SEC_IPO_RESEARCH_DEFINITION_ID);
assert.deepEqual(adopted.evidenceContracts, [{
  digest: definition.definitionDigest,
  id: definition.definitionId,
  version: definition.definitionVersion,
}]);

const tokenLimitPatch = strategyPackCatalog.resolve({ id: "ipo-filings", version: "1.1.1" });
assert.ok(tokenLimitPatch, "the immutable IPO token-limit patch must be available");
assert.equal(isSecIpoAgenticResearchPack(tokenLimitPatch), true);
const tokenLimitDefinition = createSecIpoResearchDefinition(["openai/gpt-5.4"], "1.0.1");
assert.equal(tokenLimitDefinition.limits.maximumInputTokens, 40_000);
assert.deepEqual(tokenLimitPatch.evidenceContracts, [{
  digest: tokenLimitDefinition.definitionDigest,
  id: tokenLimitDefinition.definitionId,
  version: tokenLimitDefinition.definitionVersion,
}]);
assert.equal(tokenLimitPatch.monitors[0]?.suggestedBudget.maximumInputTokensPerRun, 40_000);
assert.equal(tokenLimitPatch.capabilities.hardDenied.includes("coinbase_create_order"), true);
assert.equal(tokenLimitPatch.capabilities.hardDenied.includes("interactive.approval"), true);

const officialText = JSON.stringify({
  accessionNumber: "0000123456-26-000001",
  canonicalFilingUrl: "https://www.sec.gov/Archives/edgar/data/123456/filing.htm",
  classification: "new_registration",
  companyName: "Example Holdings",
  formType: "S-1",
});
const locator = {
  artifactDigest: createHash("sha256").update(officialText).digest("hex"),
  end: officialText.length,
  kind: "text_span" as const,
  spanDigest: createHash("sha256").update(officialText).digest("hex"),
  start: 0,
};
const executiveBrief = {
  confidence: "medium" as const,
  implications: ["The registration starts a review process but does not guarantee an offering."],
  interpretation: "Example Holdings filed a potential IPO registration with the SEC.",
  materialFacts: [{
    sourceUrls: ["https://www.sec.gov/Archives/edgar/data/123456/filing.htm"],
    statement: "Example Holdings filed Form S-1.",
  }],
  research: { status: "not_needed" as const },
  sources: [{
    label: "Example Holdings Form S-1",
    publisher: "SEC",
    role: "official" as const,
    url: "https://www.sec.gov/Archives/edgar/data/123456/filing.htm",
  }],
  title: "Example Holdings filed an S-1 registration",
  uncertainty: ["The timing, terms, and completion of any IPO remain unknown."],
};
assert.deepEqual(secIpoResearchValidationContract.validate({
  disposition: "accepted",
  evidenceTexts: [{ content: officialText, locator }],
  fields: executiveBrief,
  inputProjection: {
    members: [{ role: "section" }],
    recordType: "workspace_semantic_role_bound_projection",
    schemaVersion: 2,
  },
  unknowns: [],
}), {
  assertionCitations: [locator],
  payload: executiveBrief,
  requireExactCitations: true,
});
assert.throws(() => secIpoResearchValidationContract.validate({
  disposition: "accepted",
  evidenceTexts: [{ content: officialText, locator }],
  fields: {
    ...executiveBrief,
    sources: [{
      label: "Unapproved source",
      role: "official",
      url: "https://example.com/not-the-sec-filing",
    }],
  },
  inputProjection: {
    members: [{ role: "section" }],
    recordType: "workspace_semantic_role_bound_projection",
    schemaVersion: 2,
  },
  unknowns: [],
}));

const budget = resolveStrategyPackInitialBudgetPolicy(
  tokenLimitPatch,
  { dailyTimes: ["09:00"], timezone: "UTC" },
  "2026-08-20T19:00:00.000Z",
);
assert.equal(budget.maximumPaidPerCall, "0.250000");
assert.equal(budget.maximumPaidPerDay, "1.000000");
assert.equal(budget.maximumPaidPerMonth, "5.000000");
assert.equal(budget.unknownPriceFallbackCeiling, "0.250000");

/*
 * U4's receipt covers ipo-filings through 1.1.1, the model-safe head it adopted.
 * Later revisions add funding only - 1.1.2 raised the research session's token
 * ceilings while keeping 1.0.0-1.1.1's exact limits and digests - so they
 * advance listLatestModelSafe() without changing what U4 validated. Pin the
 * covered version here rather than tracking a moving head; asserting "latest"
 * is what broke this receipt when 1.1.2 shipped.
 */
const u4CoveredModelSafeHead = strategyPackCatalog.resolve({
  id: "ipo-filings",
  version: "1.1.1",
});
assert.ok(u4CoveredModelSafeHead, "the ipo-filings version U4 covered must remain resolvable");
assert.equal(isSecIpoAgenticResearchPack(u4CoveredModelSafeHead), true);

console.info("Agentic durable research U4 IPO adoption verification passed.");
