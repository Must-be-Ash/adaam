import { createHash } from "node:crypto";

import { z } from "zod";

export const PUBLIC_COMMENTARY_LIMITS = Object.freeze({
  maximumAssumptions: 12,
  maximumCanonicalUrlCharacters: 2_048,
  maximumCitations: 12,
  maximumContextResults: 5,
  maximumCounterevidenceItems: 12,
  maximumEditChainIds: 6,
  maximumEncryptedPayloadBytes: 64 * 1024,
  maximumEntityItemsPerKind: 32,
  maximumEvidenceSpans: 16,
  maximumImplications: 12,
  maximumInvalidationConditions: 12,
  maximumLifecycleEvents: 32,
  maximumRationaleCodes: 16,
  maximumRelatedPostIds: 16,
  maximumRisks: 12,
  maximumScenarios: 6,
  maximumStatementCharacters: 25_000,
  maximumSummaryCharacters: 2_000,
  maximumTargets: 8,
  maximumTextItemCharacters: 1_000,
});

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const numericProviderIdSchema = z.string().regex(/^\d{1,20}$/u);
const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const timestampSchema = z.string().datetime({ offset: true });
const shortTextSchema = z.string().trim().min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumTextItemCharacters);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function digestPublicCommentaryValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function safePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.hash === "" && url.toString() === value &&
      [...url.searchParams.keys()].every((key) => !/(?:api[-_]?key|secret|signature|token)/iu.test(key));
  } catch {
    return false;
  }
}

const publicUrlSchema = z.string().max(PUBLIC_COMMENTARY_LIMITS.maximumCanonicalUrlCharacters).refine(safePublicUrl);
const textSpanSchema = z.object({
  end: z.number().int().positive().max(PUBLIC_COMMENTARY_LIMITS.maximumStatementCharacters),
  spanDigest: digestSchema,
  start: z.number().int().nonnegative().max(PUBLIC_COMMENTARY_LIMITS.maximumStatementCharacters - 1),
}).strict().superRefine((span, context) => {
  if (span.start >= span.end) context.addIssue({ code: "custom", message: "text_span_invalid" });
});

export const revocableEvidenceLifecycleSchema = z.enum([
  "provisional",
  "final",
  "edited",
  "deleted",
  "protected",
  "withheld",
  "unavailable",
  "purged",
  "tombstoned",
]);

export const revocableEvidencePayloadReferenceSchema = z.object({
  cipher: z.literal("aes-256-gcm"),
  encryptedByteCount: z.number().int().positive().max(PUBLIC_COMMENTARY_LIMITS.maximumEncryptedPayloadBytes),
  keyReference: z.string().min(10).max(500).regex(/^kms:\/\/[A-Za-z0-9/._-]+$/u),
  payloadDigest: digestSchema,
  storageKey: z.string().min(10).max(500).regex(/^revocable-evidence\/[A-Za-z0-9/._-]+$/u),
}).strict();

const revocableEvidenceLifecycleEventSchema = z.object({
  eventId: identifierSchema,
  lifecycle: revocableEvidenceLifecycleSchema,
  observedAt: timestampSchema,
  reasonCode: identifierSchema,
}).strict();

export const revocableEvidenceEnvelopeSchema = z.object({
  currentLifecycle: revocableEvidenceLifecycleSchema,
  envelopeId: identifierSchema,
  lifecycleEvents: z.array(revocableEvidenceLifecycleEventSchema).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumLifecycleEvents),
  payloadReference: revocableEvidencePayloadReferenceSchema.nullable(),
  provider: z.enum(["x"]),
  providerObjectId: numericProviderIdSchema,
  recordType: z.literal("revocable_evidence_envelope"),
  revision: z.number().int().positive().max(1_000),
  schemaVersion: z.literal(1),
  sourceDigest: digestSchema,
}).strict().superRefine((envelope, context) => {
  const last = envelope.lifecycleEvents.at(-1);
  const requiresNoPayload = ["deleted", "protected", "withheld", "purged", "tombstoned"].includes(envelope.currentLifecycle);
  if (last?.lifecycle !== envelope.currentLifecycle || requiresNoPayload === (envelope.payloadReference !== null)) {
    context.addIssue({ code: "custom", message: "revocable_evidence_state_invalid" });
  }
});

export const revocableEvidencePurgeReceiptSchema = z.object({
  envelopeId: identifierSchema,
  payloadDigest: digestSchema,
  purgedAt: timestampSchema,
  reason: z.enum([
    "account_protected",
    "credential_removed",
    "provider_deleted",
    "provider_termination",
    "provider_withheld",
    "retention_expired",
  ]),
  receiptDigest: digestSchema,
  recordType: z.literal("revocable_evidence_purge_receipt"),
  schemaVersion: z.literal(1),
}).strict();

export const publicStatementSchema = z.object({
  attribution: z.enum(["direct", "quoted", "alleged", "conflicting"]),
  canonicalUrl: publicUrlSchema,
  contentDigest: digestSchema,
  contentReference: z.object({
    envelopeId: identifierSchema,
    revision: z.number().int().positive().max(1_000),
  }).strict().nullable(),
  editChainIds: z.array(numericProviderIdSchema).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumEditChainIds),
  editableUntil: timestampSchema.nullable(),
  entities: z.object({
    cashtags: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u)).max(PUBLIC_COMMENTARY_LIMITS.maximumEntityItemsPerKind),
    mentions: z.array(z.string().regex(/^[A-Za-z0-9_]{1,15}$/u)).max(PUBLIC_COMMENTARY_LIMITS.maximumEntityItemsPerKind),
    urls: z.array(publicUrlSchema).max(PUBLIC_COMMENTARY_LIMITS.maximumEntityItemsPerKind),
  }).strict(),
  lifecycle: revocableEvidenceLifecycleSchema,
  observedAt: timestampSchema,
  provider: z.literal("x"),
  publishedAt: timestampSchema,
  recordType: z.literal("public_statement"),
  references: z.object({
    conversationId: numericProviderIdSchema,
    referencedPostIds: z.array(numericProviderIdSchema).max(PUBLIC_COMMENTARY_LIMITS.maximumRelatedPostIds),
  }).strict(),
  revision: z.number().int().positive().max(1_000),
  role: z.enum(["original", "reply", "quote", "repost"]),
  schemaVersion: z.literal(1),
  speaker: z.object({
    displayLabel: z.string().trim().min(1).max(160),
    stableId: numericProviderIdSchema,
    username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/u),
  }).strict(),
  stablePostId: numericProviderIdSchema,
  textLocators: z.array(textSpanSchema).max(PUBLIC_COMMENTARY_LIMITS.maximumEvidenceSpans),
}).strict().superRefine((statement, context) => {
  const contentUnavailable = ["deleted", "protected", "withheld", "purged", "tombstoned"].includes(statement.lifecycle);
  if (
    contentUnavailable === (statement.contentReference !== null) ||
    contentUnavailable === (statement.textLocators.length > 0) ||
    statement.publishedAt > statement.observedAt ||
    (statement.lifecycle === "provisional" && statement.editableUntil === null)
  ) context.addIssue({ code: "custom", message: "public_statement_invalid" });
});

export const commentaryExtractionSchema = z.object({
  attribution: z.enum(["direct", "quoted", "alleged", "conflicting"]),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.array(textSpanSchema).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumEvidenceSpans),
  extractionId: identifierSchema,
  horizon: z.enum(["intraday", "days", "weeks", "months", "long_term", "unspecified"]),
  recordType: z.literal("commentary_extraction"),
  schemaVersion: z.literal(1),
  stance: z.enum(["bullish", "bearish", "mixed", "neutral", "no_view", "unclear"]),
  targets: z.array(z.object({
    displayName: z.string().trim().min(1).max(160),
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/u).nullable(),
    type: z.enum(["commodity", "company", "crypto_asset", "equity", "fund", "index", "macro_theme", "other"]),
  }).strict()).max(PUBLIC_COMMENTARY_LIMITS.maximumTargets),
  topic: z.enum(["factual_claim", "investment_view", "market_commentary", "other"]),
  voiceOwnership: z.enum(["speaker", "quoted_party", "mixed", "unclear"]),
}).strict().superRefine((extraction, context) => {
  if (["bullish", "bearish", "mixed"].includes(extraction.stance) && extraction.targets.length === 0) {
    context.addIssue({ code: "custom", message: "commentary_target_required" });
  }
});

const boundedTextList = (maximum: number) => z.array(shortTextSchema).max(maximum);

export const commentaryInterpretationSchema = z.object({
  assumptions: boundedTextList(PUBLIC_COMMENTARY_LIMITS.maximumAssumptions),
  confidence: z.enum(["low", "medium", "high"]),
  counterevidence: boundedTextList(PUBLIC_COMMENTARY_LIMITS.maximumCounterevidenceItems),
  horizon: z.enum(["intraday", "days", "weeks", "months", "long_term", "unspecified"]),
  implications: boundedTextList(PUBLIC_COMMENTARY_LIMITS.maximumImplications),
  interpretationId: identifierSchema,
  invalidationConditions: boundedTextList(PUBLIC_COMMENTARY_LIMITS.maximumInvalidationConditions),
  recordType: z.literal("commentary_interpretation"),
  risks: boundedTextList(PUBLIC_COMMENTARY_LIMITS.maximumRisks),
  scenarios: z.array(z.object({
    condition: shortTextSchema,
    direction: z.enum(["positive", "negative", "neutral", "uncertain"]),
    label: z.enum(["bull", "base", "bear", "alternative"]),
    rationale: shortTextSchema,
  }).strict()).max(PUBLIC_COMMENTARY_LIMITS.maximumScenarios),
  schemaVersion: z.literal(1),
}).strict();

export const providerCostReceiptSchema = z.object({
  amountUsd: z.string().regex(/^(?:0|[1-9]\d*)\.\d{6}$/u),
  billableUnits: z.number().int().nonnegative().max(10_000),
  currency: z.literal("USD"),
}).strict();

export const webCorroborationSearchSchema = z.object({
  completeness: z.enum(["complete", "partial", "unknown"]),
  cost: providerCostReceiptSchema,
  provider: z.literal("exa"),
  queriedAt: timestampSchema,
  queryDigest: digestSchema,
  recordType: z.literal("web_corroboration_search"),
  requestId: identifierSchema,
  results: z.array(z.object({
    author: z.string().trim().min(1).max(200).nullable(),
    publishedAt: timestampSchema.nullable(),
    resultId: identifierSchema,
    title: z.string().trim().min(1).max(500),
    url: publicUrlSchema,
  }).strict()).max(PUBLIC_COMMENTARY_LIMITS.maximumContextResults),
  schemaVersion: z.literal(1),
  status: z.enum([
    "not_applicable",
    "candidates_found",
    "no_established_source_found",
    "not_found",
    "not_run",
    "unavailable",
    "conflicting",
  ]),
}).strict().superRefine((search, context) => {
  if ((search.status === "candidates_found" || search.status === "conflicting") !== (search.results.length > 0)) {
    context.addIssue({ code: "custom", message: "corroboration_result_status_invalid" });
  }
});

export const commentaryPolicyDefinitionSchema = z.object({
  definitionDigest: digestSchema,
  policyId: identifierSchema,
  policyVersion: semverSchema,
  recordType: z.literal("commentary_policy_definition"),
  schemaVersion: z.literal(1),
  supportedAttributions: z.array(z.enum(["direct", "quoted", "alleged", "conflicting"])).min(1).max(4),
  supportedStances: z.array(z.enum(["bullish", "bearish", "mixed", "neutral", "no_view", "unclear"])).min(1).max(6),
}).strict();

export const commentaryPolicyDecisionSchema = z.object({
  decision: z.enum(["research_candidate", "no_view", "abstained", "quarantined"]),
  decisionId: identifierSchema,
  inputDigest: digestSchema,
  policyDigest: digestSchema,
  policyId: identifierSchema,
  policyVersion: semverSchema,
  rationaleCodes: z.array(identifierSchema).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumRationaleCodes),
  recordType: z.literal("commentary_policy_decision"),
  researchDirection: z.enum(["bullish", "bearish", "neutral", "uncertain"]).nullable(),
  schemaVersion: z.literal(1),
}).strict().superRefine((decision, context) => {
  if ((decision.decision === "research_candidate") !== (decision.researchDirection !== null)) {
    context.addIssue({ code: "custom", message: "commentary_policy_direction_invalid" });
  }
});

export const commentaryMaterialitySchema = z.object({
  alertEligible: z.boolean(),
  decisionReasons: z.array(identifierSchema).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumRationaleCodes),
  deterministicScore: z.number().int().min(0).max(100),
  materialityId: identifierSchema,
  recordType: z.literal("commentary_materiality"),
  schemaVersion: z.literal(1),
}).strict();

export const commentaryAnalysisIdentitySchema = z.object({
  budgetAttempt: z.number().int().positive().max(10),
  configurationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contextSearchRevisionId: identifierSchema.nullable(),
  evidenceRoleBindingDigests: z.array(digestSchema).min(1).max(8),
  extractionDefinitionDigest: digestSchema,
  fastModelId: identifierSchema,
  frontierModelId: identifierSchema,
  interpretationDefinitionDigest: digestSchema,
  monitorId: identifierSchema,
  ownerId: identifierSchema,
  pack: z.object({
    contentDigest: digestSchema,
    id: identifierSchema,
    version: semverSchema,
  }).strict(),
  policyDigest: digestSchema,
  statementRevisionId: identifierSchema,
  workspaceId: identifierSchema,
}).strict();

export const commentaryFindingSchema = z.object({
  analysisIdentity: commentaryAnalysisIdentitySchema,
  citations: z.array(z.object({
    canonicalUrl: publicUrlSchema,
    contentRevision: z.number().int().positive().max(1_000),
    stablePostId: numericProviderIdSchema,
  }).strict()).min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumCitations),
  confidence: z.enum(["low", "medium", "high"]),
  findingId: identifierSchema,
  interpretationId: identifierSchema,
  materiality: commentaryMaterialitySchema,
  outcome: z.enum(["accepted", "no_view", "abstained", "quarantined", "corrected", "retracted"]),
  policyDecision: commentaryPolicyDecisionSchema,
  recordType: z.literal("public_commentary_finding"),
  schemaVersion: z.literal(1),
  statementRevisionId: identifierSchema,
  summary: z.string().trim().min(1).max(PUBLIC_COMMENTARY_LIMITS.maximumSummaryCharacters),
}).strict().superRefine((finding, context) => {
  if (
    (finding.materiality.alertEligible && finding.outcome !== "accepted") ||
    finding.analysisIdentity.statementRevisionId !== finding.statementRevisionId ||
    finding.analysisIdentity.policyDigest !== finding.policyDecision.policyDigest
  ) {
    context.addIssue({ code: "custom", message: "commentary_finding_alert_invalid" });
  }
});

export const commentaryCorrectionSchema = z.object({
  correctionId: identifierSchema,
  deduplicationKey: digestSchema,
  findingId: identifierSchema,
  invalidatesRecommendation: z.literal(true),
  reason: z.enum(["source_deleted", "source_edited", "source_protected", "source_withheld"]),
  recordType: z.literal("public_commentary_correction"),
  schemaVersion: z.literal(1),
  sourceRevision: z.number().int().positive().max(1_000),
}).strict();

export const commentaryFlagConfigurationSchema = z.object({
  corroborationEnabled: z.boolean(),
  sourceEnabled: z.boolean(),
  strategyExecutionEnabled: z.boolean(),
}).strict();

export type PublicStatement = z.infer<typeof publicStatementSchema>;
export type RevocableEvidenceEnvelope = z.infer<typeof revocableEvidenceEnvelopeSchema>;
export type WebCorroborationSearch = z.infer<typeof webCorroborationSearchSchema>;
export type CommentaryFinding = z.infer<typeof commentaryFindingSchema>;
