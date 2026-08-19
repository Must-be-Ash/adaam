import assert from "node:assert/strict";
import { createHash, randomBytes, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM,
  createCommentaryPolicyDefinition,
} from "../agent/lib/commentary-policy";
import type { PublicCommentaryAttemptStoreClient } from "../agent/lib/public-commentary-attempt-store";
import {
  readPublicCommentaryFindingExplanation,
  readPublicCommentaryWorkspacePresentation,
} from "../agent/lib/public-commentary-presentation";
import {
  readPublicCommentaryFindingByStatementRevision,
  type PublicCommentaryFindingStoreClient,
} from "../agent/lib/public-commentary-finding-store";
import {
  commentaryExtractionSchema,
  digestPublicCommentaryValue,
  publicStatementSchema,
} from "../agent/lib/public-commentary-schema";
import {
  attestValidatedCommentarySemanticResult,
  createCommentarySemanticDefinition,
} from "../agent/lib/public-commentary-semantics";
import {
  createPublicCommentaryPipeline,
  materializePublicCommentaryCorrection,
} from "../agent/lib/public-commentary-vertical";
import {
  digestHybridEvidenceValue,
} from "../agent/lib/hybrid-evidence-schema";
import {
  createRevocableEvidence,
  purgeRevocableEvidence,
  readRevocableEvidencePayload,
  type RevocableEvidenceStoreClient,
} from "../agent/lib/revocable-evidence-store";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

const captureSchema = z.object({
  attestation: z.object({
    algorithm: z.literal("ed25519"),
    captureDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    signatureBase64: z.string().min(80).max(120),
    signer: z.literal("spec-04c-owner-authorized-acceptance/v1"),
  }).strict(),
  capturedAt: z.string().datetime({ offset: true }),
  cases: z.array(z.object({
    canonicalUrl: z.string().url().startsWith("https://www.whitehouse.gov/"),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    excerpt: z.string().min(20).max(400),
    expectedResearchDirection: z.enum(["bearish", "bullish"]).nullable(),
    id: z.enum(["deescalation", "escalation", "uncertainty"]),
    publishedAt: z.string().datetime({ offset: true }),
    sourceContext: z.string().min(50).max(1_000),
  }).strict()).length(3),
  publisher: z.literal("The White House"),
  recordType: z.literal("public_commentary_official_web_capture"),
  schemaVersion: z.literal(1),
}).strict();

const OFFICIAL_WEB_CAPTURE_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAJO+EKRn5LpmQTIs4p1E6XrU/BAOBLG7HL5GQShW5Adg=",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
const OFFICIAL_WEB_CAPTURE_PUBLIC_KEY_FINGERPRINT =
  "202fe94bc4e4a3c7edc6374589dc23a36b12b3cb74e54dbdb07975d796d454b9";

class MemoryStore implements PublicCommentaryFindingStoreClient, PublicCommentaryAttemptStoreClient, RevocableEvidenceStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async compareAndSetMany(operations: readonly Readonly<{ expected: string | null; key: string; next: string }>[]) {
    if (operations.some(({ expected, key }) => (this.values.get(key) ?? null) !== expected)) return false;
    for (const { key, next } of operations) this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing !== undefined) return existing;
    this.values.set(key, value);
    return value;
  }
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
}

const capture = captureSchema.parse(JSON.parse(await readFile(
  new URL("./fixtures/public-commentary-signals/white-house-iran-reuse-2026-08-18.json", import.meta.url),
  "utf8",
)));
const { attestation, ...signedCapture } = capture;
assert.equal(digestPublicCommentaryValue(signedCapture), attestation.captureDigest);
assert.equal(
  createHash("sha256").update(OFFICIAL_WEB_CAPTURE_PUBLIC_KEY_PEM).digest("hex"),
  OFFICIAL_WEB_CAPTURE_PUBLIC_KEY_FINGERPRINT,
);
assert.equal(verify(
  null,
  Buffer.from(attestation.captureDigest),
  OFFICIAL_WEB_CAPTURE_PUBLIC_KEY_PEM,
  Buffer.from(attestation.signatureBase64, "base64"),
), true, "the frozen official-web capture signature must verify");
for (const fixture of capture.cases) {
  assert.equal(createHash("sha256").update(fixture.excerpt).digest("hex"), fixture.contentDigest);
  assert.ok(fixture.sourceContext.includes(fixture.excerpt));
  assert.equal(new URL(fixture.canonicalUrl).origin, "https://www.whitehouse.gov");
}

const ownerId = "owner_acceptance";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const environment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, environment);
const store = new MemoryStore();
const trackerPack = strategyPackCatalog.resolve({ id: "public-commentary-tracker", version: "1.0.0" });
assert.ok(trackerPack);
const pack = Object.freeze({
  contentDigest: trackerPack.contentDigest,
  id: trackerPack.id,
  version: trackerPack.version,
});
const now = new Date(capture.capturedAt);
const publisherId = createHash("sha256").update("https://www.whitehouse.gov/").digest("hex");
const speakerId = createHash("sha256").update("official-person:donald-j-trump").digest("hex");
const encryptionKey = randomBytes(32);
const statements = await Promise.all(capture.cases.map(async (fixture) => {
  const spanDigest = createHash("sha256").update(fixture.excerpt).digest("hex");
  const stableStatementId = createHash("sha256")
    .update(`${fixture.canonicalUrl}\0${fixture.id}`)
    .digest("hex");
  const contentDigest = digestPublicCommentaryValue(fixture.excerpt);
  const envelope = await createRevocableEvidence({
    client: store,
    encryptionKey,
    keyReference: "kms://acceptance/official-web-ephemeral",
    lifecycle: "final",
    observedAt: capture.capturedAt,
    plaintext: fixture.excerpt,
    provider: "web",
    providerObjectId: stableStatementId,
  });
  const replayedEnvelope = await createRevocableEvidence({
    client: store,
    encryptionKey,
    keyReference: "kms://acceptance/official-web-ephemeral",
    lifecycle: "final",
    observedAt: capture.capturedAt,
    plaintext: fixture.excerpt,
    provider: "web",
    providerObjectId: stableStatementId,
  });
  assert.deepEqual(replayedEnvelope, envelope);
  assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: envelope.envelopeId }), fixture.excerpt);
  return Object.freeze({
    fixture,
    plaintext: fixture.excerpt,
    source: {
      accessClassification: "public" as const,
      adapterId: "official-web-signed-capture",
      canonicalUrl: fixture.canonicalUrl,
      origin: "https://www.whitehouse.gov",
      sourceId: "acceptance-white-house-official-statements",
      sourceInstanceId: `official-web-capture.${stableStatementId}`,
    },
    statement: publicStatementSchema.parse({
      attribution: "direct",
      canonicalUrl: fixture.canonicalUrl,
      contentDigest,
      contentReference: { envelopeId: envelope.envelopeId, revision: envelope.revision },
      document: {
        publisher: { displayLabel: "The White House", stableId: publisherId },
        revisionIds: [contentDigest],
        stableId: stableStatementId,
      },
      entities: { cashtags: [], mentions: [], urls: [] },
      kind: "official_statement",
      lifecycle: "final",
      observedAt: capture.capturedAt,
      provider: "web",
      publishedAt: fixture.publishedAt,
      recordType: "public_statement",
      references: { relatedStatementIds: [] },
      revision: 1,
      schemaVersion: 1,
      speaker: { displayLabel: "President Donald J. Trump", handle: null, stableId: speakerId },
      textLocators: [{ end: fixture.excerpt.length, spanDigest, start: 0 }],
    }),
    statementRevisionId: `statement.web.${stableStatementId}.1`,
  });
}));

const policy = createCommentaryPolicyDefinition({
  displayName: "Escalation-to-oil research",
  policyId: "commentary-direction-preservation",
  policyVersion: "1.0.0",
  transformId: COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM.transformId,
  transformVersion: COMMENTARY_DIRECTION_PRESERVATION_TRANSFORM.version,
});
const definition = createCommentarySemanticDefinition(["openai/gpt-5.4"], {
  allowedAdapterIds: ["official-web-signed-capture"],
});

function extractionFor(text: string, deterministic: z.infer<typeof commentaryExtractionSchema>) {
  const stance = /maximum pressure/iu.test(text) ? "bullish" as const
    : /\bhave a deal\b/iu.test(text) ? "bearish" as const
    : "unclear" as const;
  return commentaryExtractionSchema.parse({
    ...deterministic,
    confidence: stance === "unclear" ? "low" : "high",
    extractionId: `commentary-extraction.${digestPublicCommentaryValue([text, stance])}`,
    stance,
    targets: stance === "unclear" ? [] : [{ displayName: "Oil", symbol: "OIL", type: "commodity" }],
    topic: stance === "unclear" ? "factual_claim" : "investment_view",
    voiceOwnership: "speaker",
  });
}

function semanticResult(projected: typeof statements[number]) {
  const fixture = projected.fixture;
  const extracted = extractionFor(projected.plaintext, commentaryExtractionSchema.parse({
    attribution: "direct",
    confidence: "low",
    evidence: [{ end: projected.plaintext.length, spanDigest: fixture.contentDigest, start: 0 }],
    extractionId: `commentary-extraction.deterministic.${fixture.contentDigest}`,
    horizon: "unspecified",
    recordType: "commentary_extraction",
    schemaVersion: 1,
    stance: "unclear",
    targets: [],
    topic: "other",
    voiceOwnership: "speaker",
  }));
  const locator = {
    artifactDigest: fixture.contentDigest,
    end: fixture.excerpt.length,
    kind: "text_span" as const,
    spanDigest: fixture.contentDigest,
    start: 0,
  };
  const assertion = (statement: string) => ({ citations: [locator], statement });
  const accepted = extracted.stance === "bullish" || extracted.stance === "bearish";
  const payload = {
    assumptions: [],
    confidence: accepted ? "medium" as const : "low" as const,
    counterevidence: [],
    facts: [assertion("The signed official statement contains the captured policy signal.")],
    forecast: accepted ? {
      catalysts: [],
      invalidationConditions: [assertion("A source correction invalidates this capture.")],
      likelyImplication: assertion("The injected policy may produce a research candidate."),
      risks: [assertion("Geopolitical statements may not predict oil prices.")],
      scenarios: [{ citations: [locator], condition: "The official statement remains current.", direction: "uncertain" as const, label: "base" as const, rationale: "Only the injected policy assigns direction." }],
    } : null,
    horizon: "unspecified" as const,
    inferences: accepted ? [assertion("The signed capture expresses the configured escalation state.")] : [],
    outcome: accepted ? "accepted" as const : "no_view" as const,
    rationale: accepted ? "The signed official capture matches a configured policy state." : "The capture is explicitly uncertain.",
    recommendation: accepted ? {
      action: "research_candidate" as const,
      assumptions: [],
      citations: [locator],
      rationale: "Research only; never trade automatically.",
    } : {
      action: "no_view" as const,
      assumptions: [],
      citations: [locator],
      rationale: "Uncertainty produces no view.",
    },
  };
  const projection = {
    members: [{
      artifactDigest: fixture.contentDigest,
      factPayloadDigest: digestHybridEvidenceValue(projected.statement),
      factRevisionId: projected.statementRevisionId,
      locatorDigests: [digestHybridEvidenceValue(locator)],
      memberId: `member.${fixture.contentDigest}`,
      projectionId: `projection.${fixture.contentDigest}`,
      role: "subject_statement" as const,
      semanticContext: { metadataOnly: false },
      sourceId: projected.source.adapterId,
      sourceInstanceId: projected.source.sourceInstanceId,
      subscriptionId: `subscription.${fixture.contentDigest}`,
      subscriptionRevision: 1,
    }],
    recordType: "workspace_semantic_role_bound_projection" as const,
    schemaVersion: 2 as const,
  };
  return attestValidatedCommentarySemanticResult({
    allowedAdapterIds: [projected.source.adapterId],
    bindingRevision: 1,
    disposition: "accepted",
    evidenceTexts: [{ content: fixture.excerpt, locator }],
    fields: payload,
    inputProjection: projection,
    modelId: "openai/gpt-5.4",
    now,
    ownerId,
    pack,
    unknowns: [],
    usage: { inputTokens: 0, outputTokens: 0, paidCostUsd: "0.0000" },
    workspaceId,
  });
}

const pipeline = createPublicCommentaryPipeline({
  acquireAndProject: async () => ({
    checkpoint: { contentDigest: digestPublicCommentaryValue(capture), watermark: capture.capturedAt },
    statements,
  }),
  attempts: store,
  corroboration: { async search() { throw new Error("corroboration_must_remain_disabled"); } },
  findings: store,
  interpret: async ({ statementRevisionId }) => {
    const projected = statements.find((candidate) => candidate.statementRevisionId === statementRevisionId)!;
    const result = semanticResult(projected);
    return { evidence: { result }, record: { job: { state: "accepted" } }, strategyEvidence: { result } } as never;
  },
  policy,
  recoverExtraction: async ({ deterministic, text }) => extractionFor(text, deterministic),
});
const configuration = {
  alerts: "enabled" as const,
  cadenceMinutes: "hours_12" as const,
  impactHypotheses: [
    "de-escalation, ceasefire, or peace|OIL|down",
    "escalation or worsening conflict|OIL|up",
  ],
  includeQuotePosts: "exclude" as const,
  includeReplies: "exclude" as const,
  minimumConfidence: "medium" as const,
  minimumMateriality: "threshold_65" as const,
  relatedSourceSearch: "disabled" as const,
  selectedSymbols: ["OIL"],
  timezone: "UTC",
};
const request = {
  configuration,
  configurationGeneration: 1,
  environment: {
    EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5",
    EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
    EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  },
  initialBackfill: true,
  monitorId: "monitor.acceptance.official-web",
  ownerId,
  pack,
  scope,
  window: { endAt: capture.capturedAt, startAt: "2026-06-01T00:00:00.000Z" },
};
const result = await pipeline.run(request);
assert.equal(result.analyzedStatements, 3);
assert.ok(result.finding);
assert.equal(result.finding.factIdentities.length, 2);
assert.ok(result.alertPresentation);
assert.equal(result.alertPresentations?.length, 1);
assert.match(result.alertPresentation.title, /initial hours 12 summary/iu);
assert.match(result.alertPresentation.whyMatched, /one summary alert was emitted/iu);
assert.match(result.alertPresentation.whyMatched, /Exact cited statement:/u);
assert.doesNotMatch(result.alertPresentation.whyMatched, /maximum pressure against Iran/u);
const replay = await pipeline.run(request);
assert.equal(replay.finding?.summary, result.finding.summary);
const laterOccurrence = await pipeline.run({ ...request, initialBackfill: false });
assert.equal(laterOccurrence.alertPresentations?.length, 2, "post-backfill qualifying statements receive normal per-statement alerts");

for (const projected of statements) {
  const finding = await readPublicCommentaryFindingByStatementRevision(scope, projected.statementRevisionId, store);
  assert.ok(finding);
  assert.equal(finding.finding.policyDecision.researchDirection, projected.fixture.expectedResearchDirection);
  assert.equal(finding.finding.materiality.alertEligible, projected.fixture.expectedResearchDirection !== null);
  assert.equal(finding.source.adapterId, "official-web-signed-capture");
  assert.equal(finding.source.canonicalUrl, projected.fixture.canonicalUrl);
  assert.equal(finding.policyDisplayName, "Configured public-commentary impact hypothesis");
}

const escalation = statements.find(({ fixture }) => fixture.id === "escalation")!;
const escalationFinding = await readPublicCommentaryFindingByStatementRevision(
  scope,
  escalation.statementRevisionId,
  store,
);
assert.ok(escalationFinding);
const discussed = await readPublicCommentaryFindingExplanation({
  findingId: escalationFinding.finding.findingId,
  scope,
}, store, { client: store, encryptionKey });
assert.equal(discussed.findingId, escalationFinding.finding.findingId);
assert.equal(discussed.exactStatement, escalation.plaintext);
assert.equal(discussed.impactClassification, "escalation");
const isolatedScope = authorizeDeploymentWorkspaceStore({
  ownerId,
  workspaceId: "44444444-4444-4444-8444-555555555555",
}, environment);
await assert.rejects(readPublicCommentaryFindingExplanation({
  findingId: escalationFinding.finding.findingId,
  scope: isolatedScope,
}, store), /public_commentary_finding_not_found/u);
const purge = await purgeRevocableEvidence({
  client: store,
  envelopeId: escalation.statement.contentReference!.envelopeId,
  lifecycle: "deleted",
  observedAt: capture.capturedAt,
  reason: "provider_deleted",
});
assert.equal(purge.envelope.provider, "web");
assert.equal(purge.envelope.currentLifecycle, "deleted");
assert.equal(await readRevocableEvidencePayload({
  client: store,
  encryptionKey,
  envelopeId: purge.envelope.envelopeId,
}), null);
const correction = await materializePublicCommentaryCorrection({
  current: escalationFinding,
  lifecycle: "deleted",
  now,
  scope,
  sourceRevision: 2,
}, store);
assert.equal(correction.record.finding.outcome, "retracted");
assert.equal(correction.alertPresentation.title, "Configured public-commentary impact hypothesis · source correction");
assert.equal(correction.record.source.origin, "https://www.whitehouse.gov");
const manage = await readPublicCommentaryWorkspacePresentation({
  credentialStatus: "configured",
  estimatedCostUsd: "0.000000",
  monitor: { lifecycleState: "enabled", sourceCheckpoint: { watermark: capture.capturedAt } },
  scope,
  sourceStatus: "healthy",
}, store);
assert.equal(manage.outcomes.retracted, 1);
assert.equal(manage.cost.estimatedUsd, "0.000000");

const sharedRuntime = await Promise.all([
  "public-commentary-schema.ts",
  "public-commentary-semantics.ts",
  "public-commentary-vertical.ts",
  "commentary-policy.ts",
].map((filename) => readFile(new URL(`../agent/lib/${filename}`, import.meta.url), "utf8")));
assert.ok(sharedRuntime.every((sourceText) => !/Trump|Iran|White House/iu.test(sourceText)));
assert.equal(strategyPackCatalog.resolve({ id: "trump-iran", version: "1.0.0" }), null);
store.values.clear();
assert.equal(store.values.size, 0);

console.info("public commentary Sprint 4 official-web reuse verification passed");
