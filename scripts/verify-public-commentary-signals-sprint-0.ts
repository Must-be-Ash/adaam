import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  PUBLIC_COMMENTARY_LIMITS,
  commentaryCorrectionSchema,
  commentaryExtractionSchema,
  commentaryFindingSchema,
  commentaryFlagConfigurationSchema,
  commentaryInterpretationSchema,
  commentaryMaterialitySchema,
  commentaryPolicyDecisionSchema,
  publicStatementSchema,
  revocableEvidenceEnvelopeSchema,
  revocableEvidencePurgeReceiptSchema,
  webCorroborationSearchSchema,
} from "../agent/lib/public-commentary-schema";
import {
  PUBLIC_COMMENTARY_COPY,
  PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES,
  PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES,
  PUBLIC_STATEMENT_ATTRIBUTION_STATES,
  publicCommentaryProductContractSchema,
  PUBLIC_COMMENTARY_PRODUCT_CONTRACT,
} from "../agent/lib/public-commentary-product-contract";
import {
  PUBLIC_COMMENTARY_SOURCE_CONTRACT,
  publicCommentarySourceContractSchema,
} from "../agent/lib/public-commentary-source-contract";
import {
  PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS,
  PublicCommentaryMissingProductionSeamError,
  assertPublicCommentaryProductionSeams,
} from "../evals/public-commentary-signals/contract-harness";
import {
  INVERSE_CRAMER_SPRINT_0_CONTRACT,
  inverseCramerSprint0ContractSchema,
} from "../evals/public-commentary-signals/inverse-cramer-sprint-0-contract";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const now = "2026-08-17T20:00:00.000Z";
const corpus = z.object({
  cases: z.array(z.object({
    expected: z.object({ outcome: z.string(), stance: z.string() }).strict(),
    id: z.string(),
    tags: z.array(z.string()).min(1).max(8),
  }).strict()).length(24),
  missingProductionSeams: z.array(z.enum(PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS)).length(6),
  recordType: z.literal("public_commentary_sprint_0_corpus"),
  reviewedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.literal(1),
}).strict().parse(JSON.parse(await readFile(
  new URL("./fixtures/public-commentary-signals/sprint-0-corpus.json", import.meta.url),
  "utf8",
)));

const liveValidation = z.object({
  authorization: z.object({
    maximumAuthorizedCostUsd: z.literal("0.040000"),
    maximumOperationCostUsd: z.literal("0.035000"),
  }).strict(),
  identity: z.object({
    displayName: z.literal("Jim Cramer"),
    isIdentityVerified: z.boolean(),
    numericUserId: z.string().regex(/^\d{1,20}$/u),
    parody: z.literal(false),
    protected: z.literal(false),
    rateLimit: z.literal(300),
    rateRemaining: z.number().int().nonnegative().max(300),
    status: z.literal(200),
    username: z.literal("jimcramer"),
    verified: z.boolean(),
    withheld: z.literal(false),
  }).strict(),
  performedAt: z.string().datetime({ offset: true }),
  privacy: z.object({
    credentialValuesLogged: z.literal(false),
    postIdsLogged: z.literal(false),
    postTextLogged: z.literal(false),
  }).strict(),
  recordType: z.literal("public_commentary_x_live_validation"),
  schemaVersion: z.literal(1),
  timeline: z.object({
    allAuthorsMatchPinnedUser: z.literal(true),
    fieldCoverage: z.object({
      authorId: z.literal(5),
      conversationId: z.literal(5),
      createdAt: z.literal(5),
      editControls: z.literal(5),
      editHistoryPostIds: z.literal(5),
      entities: z.number().int().nonnegative().max(5),
      inReplyToUserId: z.number().int().nonnegative().max(5),
      referencedPosts: z.number().int().nonnegative().max(5),
      text: z.literal(5),
      withheld: z.number().int().nonnegative().max(5),
    }).strict(),
    hasNextToken: z.boolean(),
    rateLimit: z.literal(10_000),
    rateRemaining: z.number().int().nonnegative().max(10_000),
    returnedPosts: z.literal(5),
    status: z.literal(200),
  }).strict(),
}).strict().parse(JSON.parse(await readFile(
  new URL("./fixtures/public-commentary-signals/x-live-validation-2026-08-18.json", import.meta.url),
  "utf8",
)));

const rehydrationValidation = z.object({
  access: z.object({
    billingModel: z.literal("pay_per_use"),
    enterpriseComplianceStreamAssumed: z.literal(false),
    selectedLifecycleMechanism: z.literal("bounded_exact_post_rehydration"),
  }).strict(),
  authorization: z.object({
    maximumAuthorizedCostUsd: z.literal("0.030000"),
    maximumOperationCostUsd: z.literal("0.030000"),
  }).strict(),
  exactLookup: z.object({
    authorMatchesPinnedUser: z.literal(true),
    createdAtPresent: z.literal(true),
    editControlsPresent: z.literal(true),
    editHistoryPresent: z.literal(true),
    idMatchesRequested: z.literal(true),
    rateLimit: z.literal(450),
    rateRemaining: z.number().int().nonnegative().max(450),
    status: z.literal(200),
    textPresent: z.literal(true),
    withheldPresent: z.boolean(),
  }).strict(),
  privacy: z.object({
    credentialValuesLogged: z.literal(false),
    postIdsLogged: z.literal(false),
    postTextLogged: z.literal(false),
  }).strict(),
  recordType: z.literal("public_commentary_x_rehydration_validation"),
  recordedAt: z.string().datetime({ offset: true }),
  schemaVersion: z.literal(1),
  timeline: z.object({
    allAuthorsMatchPinnedUser: z.literal(true),
    rateLimit: z.literal(10_000),
    rateRemaining: z.number().int().nonnegative().max(10_000),
    returnedPosts: z.literal(5),
    status: z.literal(200),
  }).strict(),
}).strict().parse(JSON.parse(await readFile(
  new URL("./fixtures/public-commentary-signals/x-rehydration-validation-2026-08-18.json", import.meta.url),
  "utf8",
)));

const requiredTags = [
  "explicit_bullish", "explicit_bearish", "no_view", "cashtag", "implicit_entity",
  "quote_post", "quotation_only", "reply", "repost", "sarcasm", "mixed_stance",
  "multiple_targets", "external_allegation", "unknown_source", "conflicting_links",
  "edited", "deleted", "protected", "withheld", "duplicate", "pagination_gap",
  "oversized", "hostile_content", "budget_failure", "non_cramer_reuse",
] as const;
const fixtureTags = new Set(corpus.cases.flatMap(({ tags }) => tags));
for (const tag of requiredTags) assert.ok(fixtureTags.has(tag), `missing fixture tag: ${tag}`);
assert.deepEqual(corpus.missingProductionSeams, [...PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS]);

assert.deepEqual(
  publicCommentarySourceContractSchema.parse(PUBLIC_COMMENTARY_SOURCE_CONTRACT),
  PUBLIC_COMMENTARY_SOURCE_CONTRACT,
);
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.timeline.maximumResultsPerPage, 100);
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.editFinalizationDelayMinutes, 30);
assert.deepEqual(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.timeline.expansions, [
  "author_id", "edit_history_post_ids", "in_reply_to_user_id", "referenced_posts",
]);
assert.deepEqual(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.timeline.postFields, [
  "conversation_id", "created_at", "edit_controls", "entities", "text", "withheld",
]);
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.authorization.approvalState, "approved");
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.authorization.blockingReason, null);
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.billing.accessModel, "pay_per_use");
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.lifecycle.complianceEndpointAvailability, "unavailable");
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.lifecycle.selectedMechanismAccessState, "available");
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.rateLimits.exactPostLookupPerAppPerWindow, rehydrationValidation.exactLookup.rateLimit);
assert.equal(PUBLIC_COMMENTARY_SOURCE_CONTRACT.x.timeline.exactPostLookupEndpoint, "https://api.x.com/2/tweets/{id}");
assert.deepEqual(
  inverseCramerSprint0ContractSchema.parse(INVERSE_CRAMER_SPRINT_0_CONTRACT),
  INVERSE_CRAMER_SPRINT_0_CONTRACT,
);
assert.equal(INVERSE_CRAMER_SPRINT_0_CONTRACT.identity.approvalState, "verified");
assert.equal(INVERSE_CRAMER_SPRINT_0_CONTRACT.identity.numericUserId, liveValidation.identity.numericUserId);
assert.equal(INVERSE_CRAMER_SPRINT_0_CONTRACT.identity.verifiedAt, liveValidation.performedAt);
assert.equal(INVERSE_CRAMER_SPRINT_0_CONTRACT.referenceCadenceMinutes, 10);
assert.equal(INVERSE_CRAMER_SPRINT_0_CONTRACT.allowedPostRoles.repost, false);
assert.deepEqual(
  publicCommentaryProductContractSchema.parse(PUBLIC_COMMENTARY_PRODUCT_CONTRACT),
  PUBLIC_COMMENTARY_PRODUCT_CONTRACT,
);
assert.equal(PUBLIC_COMMENTARY_PRODUCT_CONTRACT.reposts.defaultIncluded, false);
assert.equal(PUBLIC_COMMENTARY_PRODUCT_CONTRACT.activation.retroactiveAlerts, false);

assert.deepEqual(new Set(PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES), new Set(["authorized", "denied", "pending_review", "unavailable"]));
assert.deepEqual(new Set(PUBLIC_STATEMENT_ATTRIBUTION_STATES), new Set(["direct", "quoted", "alleged", "conflicting"]));
assert.equal(PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES.length, 7);
for (const state of PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES) {
  assert.ok(PUBLIC_COMMENTARY_COPY.relatedCoverage[state].length > 20);
}
assert.ok(PUBLIC_COMMENTARY_COPY.sourceQuality.weak.includes("remains visible"));
assert.ok(PUBLIC_COMMENTARY_COPY.sourceQuality.conflicting.includes("Conflicting evidence"));

const payloadReference = {
  cipher: "aes-256-gcm" as const,
  encryptedByteCount: 128,
  keyReference: "kms://revocable-evidence/x/post-1",
  payloadDigest: digestA,
  storageKey: "revocable-evidence/x/post-1/revision-1",
};
const envelope = revocableEvidenceEnvelopeSchema.parse({
  currentLifecycle: "provisional",
  envelopeId: "revocable-evidence.x.post-1",
  lifecycleEvents: [{ eventId: "event.post-1.observed", lifecycle: "provisional", observedAt: now, reasonCode: "provider_observed" }],
  payloadReference,
  provider: "x",
  providerObjectId: "1",
  recordType: "revocable_evidence_envelope",
  revision: 1,
  schemaVersion: 1,
  sourceDigest: digestA,
});
assert.equal(envelope.payloadReference?.cipher, "aes-256-gcm");
assert.throws(() => revocableEvidenceEnvelopeSchema.parse({ ...envelope, lifecycleEvents: [] }));
const purged = revocableEvidencePurgeReceiptSchema.parse({
  envelopeId: envelope.envelopeId,
  payloadDigest: digestA,
  purgedAt: now,
  reason: "provider_deleted",
  receiptDigest: digestB,
  recordType: "revocable_evidence_purge_receipt",
  schemaVersion: 1,
});
assert.equal(purged.reason, "provider_deleted");

const statement = publicStatementSchema.parse({
  attribution: "direct",
  canonicalUrl: "https://x.com/fixture/status/1",
  contentDigest: digestA,
  contentReference: { envelopeId: envelope.envelopeId, revision: 1 },
  editChainIds: ["1"],
  editableUntil: "2026-08-17T20:30:00.000Z",
  entities: { cashtags: ["AAPL"], mentions: [], urls: [] },
  lifecycle: "provisional",
  observedAt: now,
  provider: "x",
  publishedAt: now,
  recordType: "public_statement",
  references: { conversationId: "1", referencedPostIds: [] },
  revision: 1,
  role: "original",
  schemaVersion: 1,
  speaker: { displayLabel: "Fixture Speaker", stableId: "123456", username: "fixture" },
  stablePostId: "1",
  textLocators: [{ end: 14, spanDigest: digestB, start: 0 }],
});
assert.equal(statement.recordType, "public_statement");
assert.throws(() => publicStatementSchema.parse({ ...statement, stablePostId: "not-numeric" }));

const extraction = commentaryExtractionSchema.parse({
  attribution: "direct",
  confidence: "high",
  evidence: [{ end: 14, spanDigest: digestB, start: 0 }],
  extractionId: "extraction.fixture.1",
  horizon: "unspecified",
  recordType: "commentary_extraction",
  schemaVersion: 1,
  stance: "bullish",
  targets: [{ displayName: "Apple", symbol: "AAPL", type: "equity" }],
  topic: "investment_view",
  voiceOwnership: "speaker",
});
assert.equal(extraction.targets.length, 1);
assert.throws(() => commentaryExtractionSchema.parse({ ...extraction, targets: Array(9).fill(extraction.targets[0]) }));

const interpretation = commentaryInterpretationSchema.parse({
  assumptions: ["The statement is interpreted as an opinion."],
  confidence: "medium",
  counterevidence: [],
  horizon: "unspecified",
  implications: ["The configured policy may evaluate the opposite direction."],
  interpretationId: "interpretation.fixture.1",
  invalidationConditions: ["The extracted stance is revised."],
  recordType: "commentary_interpretation",
  risks: ["The strategy thesis may not have predictive value."],
  scenarios: [{ condition: "The statement remains final.", direction: "negative", label: "base", rationale: "Policy inversion applies." }],
  schemaVersion: 1,
});
assert.equal(interpretation.scenarios.length, 1);

const search = webCorroborationSearchSchema.parse({
  completeness: "complete",
  cost: { amountUsd: "0.007000", billableUnits: 1, currency: "USD" },
  provider: "exa",
  queriedAt: now,
  queryDigest: digestA,
  recordType: "web_corroboration_search",
  requestId: "request.fixture.1",
  results: [{ author: "Fixture Desk", publishedAt: now, resultId: "result.1", title: "Fixture related report", url: "https://example.com/report" }],
  schemaVersion: 1,
  status: "candidates_found",
});
assert.equal(search.results.length, 1);
assert.throws(() => webCorroborationSearchSchema.parse({ ...search, results: Array(6).fill(search.results[0]) }));

const policyDecision = commentaryPolicyDecisionSchema.parse({
  decision: "research_candidate",
  decisionId: "policy-decision.fixture.1",
  inputDigest: digestA,
  policyDigest: digestB,
  policyId: "fixture-policy",
  policyVersion: "1.0.0",
  rationaleCodes: ["clear_direct_view"],
  recordType: "commentary_policy_decision",
  researchDirection: "bearish",
  schemaVersion: 1,
});
const materiality = commentaryMaterialitySchema.parse({
  alertEligible: true,
  decisionReasons: ["final_direct_view", "after_activation_watermark"],
  deterministicScore: 80,
  materialityId: "materiality.fixture.1",
  recordType: "commentary_materiality",
  schemaVersion: 1,
});
const finding = commentaryFindingSchema.parse({
  analysisIdentity: {
    budgetAttempt: 1,
    configurationGeneration: 1,
    contextSearchRevisionId: "context-search.fixture.1",
    evidenceRoleBindingDigests: [digestA],
    extractionDefinitionDigest: digestA,
    fastModelId: "anthropic/claude-haiku-4.5",
    frontierModelId: "openai/gpt-5.4",
    interpretationDefinitionDigest: digestB,
    monitorId: "monitor.fixture.1",
    ownerId: "owner.fixture",
    pack: { contentDigest: digestA, id: "fixture-commentary-policy", version: "1.0.0" },
    policyDigest: digestB,
    statementRevisionId: "statement.x.1.1",
    workspaceId: "workspace.fixture",
  },
  citations: [{ canonicalUrl: statement.canonicalUrl, contentRevision: 1, stableStatementId: "1" }],
  confidence: "medium",
  findingId: "finding.fixture.1",
  interpretationId: interpretation.interpretationId,
  materiality,
  outcome: "accepted",
  policyDecision,
  recordType: "public_commentary_finding",
  schemaVersion: 1,
  statementRevisionId: "statement.x.1.1",
  summary: "A direct public view produced a policy-derived research candidate.",
});
assert.equal(finding.materiality.alertEligible, true);
const correction = commentaryCorrectionSchema.parse({
  correctionId: "correction.fixture.1",
  deduplicationKey: digestA,
  findingId: finding.findingId,
  invalidatesRecommendation: true,
  reason: "source_deleted",
  recordType: "public_commentary_correction",
  rootFindingId: finding.findingId,
  rootStatementRevisionId: finding.statementRevisionId,
  schemaVersion: 1,
  sourceRevision: 2,
  supersedesStatementRevisionId: finding.statementRevisionId,
});
assert.equal(correction.invalidatesRecommendation, true);

assert.deepEqual(commentaryFlagConfigurationSchema.parse({
  corroborationEnabled: false,
  sourceEnabled: false,
  strategyExecutionEnabled: false,
}), {
  corroborationEnabled: false,
  sourceEnabled: false,
  strategyExecutionEnabled: false,
});
assert.ok(PUBLIC_COMMENTARY_LIMITS.maximumStatementCharacters <= 25_000);

for (let index = 0; index < PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS.length; index += 1) {
  const registered = Object.fromEntries(PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS.slice(0, index).map((seam) => [seam, true]));
  assert.throws(
    () => assertPublicCommentaryProductionSeams(registered),
    (error: unknown) => error instanceof PublicCommentaryMissingProductionSeamError && error.seam === PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS[index],
  );
}
assert.doesNotThrow(() => assertPublicCommentaryProductionSeams(Object.fromEntries(
  PUBLIC_COMMENTARY_MISSING_PRODUCTION_SEAMS.map((seam) => [seam, true]),
)));

process.stdout.write(JSON.stringify({
  fixtureCases: corpus.cases.length,
  missingProductionSeams: corpus.missingProductionSeams,
  sourceApprovalState: PUBLIC_COMMENTARY_SOURCE_CONTRACT.authorization.approvalState,
  identityApprovalState: INVERSE_CRAMER_SPRINT_0_CONTRACT.identity.approvalState,
  pinnedNumericUserId: liveValidation.identity.numericUserId,
  status: "contracts_green_production_seams_intentionally_missing",
}, null, 2) + "\n");
