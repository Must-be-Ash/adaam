import { createHash } from "node:crypto";

import { z } from "zod";

export const EARNINGS_CALL_SCHEMA_VERSION = 1;

export const EARNINGS_CALL_LIMITS = Object.freeze({
  maximumArtifactBytes: 8 * 1_024 * 1_024,
  maximumCatalogEntries: 5_000,
  maximumCitationsPerAssertion: 8,
  maximumComparisonMetrics: 64,
  maximumEvidenceAssertions: 16,
  maximumEventsPerBaseline: 4,
  maximumFindingBytes: 64 * 1_024,
  maximumFindingTextCharacters: 1_500,
  maximumQaPairs: 128,
  maximumScenarios: 3,
  maximumSections: 8,
  maximumSelectedIssuers: 8,
  maximumSourceFamilies: 12,
  maximumSpeakerTurns: 512,
  maximumTranscriptCharacters: 200_000,
});

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(3).max(200).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u,
);
const semverSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
);
const timestampSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().date();
const cikSchema = z.string().regex(/^\d{10}$/u);
const fiscalPeriodSchema = z.string().regex(/^FY\d{4}-Q[1-4]$/u);
const boundedTextSchema = z.string().trim().min(1).max(EARNINGS_CALL_LIMITS.maximumFindingTextCharacters);
const exactOriginSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) context.addIssue({ code: "custom", message: "invalid_exact_origin" });
});
const publicUrlSchema = z.string().url().max(2_048).superRefine((value, context) => {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.toString() !== value
  ) context.addIssue({ code: "custom", message: "unsafe_public_url" });
  for (const key of url.searchParams.keys()) {
    if (/(?:api[-_]?key|credential|password|secret|signature|token)/iu.test(key)) {
      context.addIssue({ code: "custom", message: "secret_bearing_public_url" });
    }
  }
});

export function digestEarningsCallValue(value: unknown): string {
  function canonicalize(candidate: unknown): unknown {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]));
    }
    return candidate;
  }
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const earningsIssuerCoverageSchema = z.object({
  lastSuccessfulEventAt: timestampSchema.nullable(),
  reasonCode: z.enum([
    "artifact_oversized",
    "awaiting_comparable_call",
    "coverage_not_reviewed",
    "missing_qa",
    "no_reviewed_source_family",
    "release_only",
    "source_failed",
    "transcript_ambiguous",
  ]).nullable(),
  state: z.enum([
    "awaiting_comparable_call",
    "baseline_ready",
    "coverage_unavailable",
    "current",
    "degraded",
    "paused_failure",
  ]),
}).strict().superRefine((coverage, context) => {
  const healthy = ["baseline_ready", "current"].includes(coverage.state);
  if ((healthy && coverage.reasonCode !== null) || (!healthy && coverage.reasonCode === null)) {
    context.addIssue({ code: "custom", message: "issuer_coverage_reason_inconsistent" });
  }
  if (healthy && coverage.lastSuccessfulEventAt === null) {
    context.addIssue({ code: "custom", message: "issuer_coverage_success_time_missing" });
  }
  if (coverage.state === "awaiting_comparable_call" &&
      coverage.reasonCode !== "awaiting_comparable_call") {
    context.addIssue({ code: "custom", message: "issuer_coverage_reason_inconsistent" });
  }
});

export const earningsIssuerCatalogEntrySchema = z.object({
  cik: cikSchema,
  companyName: z.string().trim().min(1).max(200),
  coverage: earningsIssuerCoverageSchema,
  exchange: z.enum(["Nasdaq", "NYSE"]),
  sector: z.enum([
    "communication_services",
    "consumer",
    "energy",
    "financials",
    "healthcare",
    "industrials",
    "technology",
    "utilities",
  ]),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u),
}).strict();

export const earningsIssuerCatalogRevisionSchema = z.object({
  catalogDigest: digestSchema,
  catalogId: z.literal("sec-issuers"),
  entries: z.array(earningsIssuerCatalogEntrySchema)
    .min(1)
    .max(EARNINGS_CALL_LIMITS.maximumCatalogEntries),
  recordType: z.literal("earnings_issuer_catalog_revision"),
  revision: z.number().int().positive(),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
}).strict().superRefine((catalog, context) => {
  const { catalogDigest, ...core } = catalog;
  if (digestEarningsCallValue(core) !== catalogDigest) {
    context.addIssue({ code: "custom", message: "catalog_digest_mismatch" });
  }
  if (!unique(catalog.entries.map(({ cik }) => cik))) {
    context.addIssue({ code: "custom", message: "duplicate_catalog_cik" });
  }
});

const reviewedEndpointSchema = z.object({
  mediaTypes: z.array(z.enum(["application/pdf", "text/html"]))
    .min(1)
    .max(2),
  origin: exactOriginSchema,
  pathPattern: z.string().min(1).max(500),
}).strict();

export const earningsSourceFamilySchema = z.object({
  artifact: reviewedEndpointSchema,
  cik: cikSchema,
  discovery: reviewedEndpointSchema,
  familyDigest: digestSchema,
  familyId: identifierSchema,
  maximumArtifactBytes: z.number().int().positive()
    .max(EARNINGS_CALL_LIMITS.maximumArtifactBytes),
  maximumRedirects: z.number().int().min(0).max(3),
  recordType: z.literal("earnings_call_source_family"),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
}).strict().superRefine((family, context) => {
  const { familyDigest, ...core } = family;
  if (digestEarningsCallValue(core) !== familyDigest) {
    context.addIssue({ code: "custom", message: "source_family_digest_mismatch" });
  }
  for (const endpoint of [family.discovery, family.artifact]) {
    try {
      void new RegExp(endpoint.pathPattern, "u");
    } catch {
      context.addIssue({ code: "custom", message: "invalid_source_path_pattern" });
    }
  }
  if (family.discovery.mediaTypes.some((mediaType) => mediaType !== "text/html")) {
    context.addIssue({ code: "custom", message: "discovery_media_type_invalid" });
  }
});

export const earningsSourceInstanceSchema = z.object({
  artifactUrl: publicUrlSchema,
  cik: cikSchema,
  discoveryUrl: publicUrlSchema,
  familyDigest: digestSchema,
  familyId: identifierSchema,
  fiscalPeriod: fiscalPeriodSchema,
  instanceId: identifierSchema,
  recordType: z.literal("earnings_call_source_instance"),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
}).strict();

export const earningsEventSchema = z.object({
  artifactByteCount: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumArtifactBytes),
  artifactDigest: digestSchema,
  callDate: dateSchema,
  cik: cikSchema,
  eventId: identifierSchema,
  fiscalPeriod: fiscalPeriodSchema,
  observedAt: timestampSchema,
  publishedAt: timestampSchema,
  recordType: z.literal("earnings_call_event"),
  revision: z.number().int().positive(),
  revisionId: identifierSchema,
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
  secAccession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/u).nullable(),
  sourceInstanceId: identifierSchema,
}).strict().refine(
  ({ callDate, observedAt, publishedAt }) =>
    Date.parse(observedAt) >= Date.parse(publishedAt) && publishedAt.slice(0, 10) >= callDate,
  "event_chronology_invalid",
);

export const earningsTranscriptSectionKindSchema = z.enum([
  "prepared_remarks",
  "questions_and_answers",
  "source_notice",
]);

export const earningsTranscriptSectionSchema = z.object({
  characterCount: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters),
  end: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters),
  sectionDigest: digestSchema,
  sectionId: identifierSchema,
  sectionKind: earningsTranscriptSectionKindSchema,
  start: z.number().int().min(0).max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters - 1),
}).strict().refine(({ end, start }) => end > start, "invalid_section_range");

export const earningsSpeakerTurnSchema = z.object({
  end: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters),
  role: z.enum(["analyst", "executive", "investor_relations", "operator", "unknown"]),
  sectionId: identifierSchema,
  speakerName: z.string().trim().min(1).max(120),
  start: z.number().int().min(0).max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters - 1),
  turnDigest: digestSchema,
  turnId: identifierSchema,
}).strict().refine(({ end, start }) => end > start, "invalid_turn_range");

export const earningsQaPairSchema = z.object({
  answerTurnIds: z.array(identifierSchema).min(1).max(8),
  pairId: identifierSchema,
  questionTurnIds: z.array(identifierSchema).min(1).max(4),
}).strict();

export const earningsTranscriptSchema = z.object({
  artifactDigest: digestSchema,
  characterCount: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters),
  coverage: z.object({
    liveCallCompleteness: z.enum(["attested_complete", "not_attested"]),
    omissionNotice: z.string().trim().min(1).max(500).nullable(),
    preparedRemarks: z.literal("document_complete"),
    questionsAndAnswers: z.literal("document_complete"),
  }).strict(),
  eventRevisionId: identifierSchema,
  normalizedTextDigest: digestSchema,
  parserVersion: semverSchema,
  qaPairs: z.array(earningsQaPairSchema).min(1).max(EARNINGS_CALL_LIMITS.maximumQaPairs),
  recordType: z.literal("earnings_call_transcript"),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
  sections: z.array(earningsTranscriptSectionSchema)
    .min(2)
    .max(EARNINGS_CALL_LIMITS.maximumSections),
  speakerTurns: z.array(earningsSpeakerTurnSchema)
    .min(1)
    .max(EARNINGS_CALL_LIMITS.maximumSpeakerTurns),
  transcriptId: identifierSchema,
}).strict().superRefine((transcript, context) => {
  const sectionIds = transcript.sections.map(({ sectionId }) => sectionId);
  const turnIds = transcript.speakerTurns.map(({ turnId }) => turnId);
  if (!unique(sectionIds) || !unique(turnIds) || !unique(transcript.qaPairs.map(({ pairId }) => pairId))) {
    context.addIssue({ code: "custom", message: "duplicate_transcript_identity" });
  }
  if (!transcript.sections.some(({ sectionKind }) => sectionKind === "prepared_remarks") ||
      !transcript.sections.some(({ sectionKind }) => sectionKind === "questions_and_answers")) {
    context.addIssue({ code: "custom", message: "required_transcript_sections_missing" });
  }
  const sectionSet = new Set(sectionIds);
  const turnSet = new Set(turnIds);
  if (transcript.sections.some(({ characterCount, end, start }) =>
    end > transcript.characterCount || characterCount !== end - start) ||
      transcript.speakerTurns.some(({ end }) => end > transcript.characterCount)) {
    context.addIssue({ code: "custom", message: "transcript_range_out_of_bounds" });
  }
  if (transcript.sections.some((section, index) =>
    index > 0 && transcript.sections[index - 1]!.end > section.start)) {
    context.addIssue({ code: "custom", message: "transcript_sections_overlap_or_unsorted" });
  }
  if (transcript.speakerTurns.some(({ sectionId }) => !sectionSet.has(sectionId)) ||
      transcript.qaPairs.some(({ answerTurnIds, questionTurnIds }) =>
        [...answerTurnIds, ...questionTurnIds].some((turnId) => !turnSet.has(turnId)))) {
    context.addIssue({ code: "custom", message: "transcript_reference_invalid" });
  }
});

export const earningsCitationSchema = z.object({
  artifactDigest: digestSchema,
  end: z.number().int().positive().max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters),
  eventRevisionId: identifierSchema,
  sectionId: identifierSchema,
  spanDigest: digestSchema,
  start: z.number().int().min(0).max(EARNINGS_CALL_LIMITS.maximumTranscriptCharacters - 1),
  transcriptId: identifierSchema,
}).strict().refine(({ end, start }) => end > start, "invalid_citation_range");

export const earningsMetricSchema = z.object({
  currentValue: z.number().finite(),
  delta: z.number().finite(),
  metricId: z.enum([
    "commitment_language_rate",
    "external_attribution_rate",
    "forward_looking_rate",
    "hedging_language_rate",
    "qa_answer_length_median",
    "qa_directness_rate",
    "risk_language_rate",
    "specificity_rate",
  ]),
  priorValue: z.number().finite(),
  sectionKind: z.enum(["prepared_remarks", "questions_and_answers"]),
  unit: z.enum(["ratio", "tokens"]),
}).strict();

export const earningsComparisonSchema = z.object({
  cik: cikSchema,
  comparisonDigest: digestSchema,
  comparisonId: identifierSchema,
  current: z.object({ artifactDigest: digestSchema, eventRevisionId: identifierSchema, fiscalPeriod: fiscalPeriodSchema, transcriptId: identifierSchema }).strict(),
  metricVersion: semverSchema,
  metrics: z.array(earningsMetricSchema).max(EARNINGS_CALL_LIMITS.maximumComparisonMetrics),
  prior: z.object({ artifactDigest: digestSchema, eventRevisionId: identifierSchema, fiscalPeriod: fiscalPeriodSchema, transcriptId: identifierSchema }).strict(),
  recordType: z.literal("earnings_call_comparison"),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
  secondaryYearAgo: z.object({ artifactDigest: digestSchema, eventRevisionId: identifierSchema, fiscalPeriod: fiscalPeriodSchema, transcriptId: identifierSchema }).strict().nullable(),
}).strict().superRefine((comparison, context) => {
  const { comparisonDigest, ...core } = comparison;
  if (digestEarningsCallValue(core) !== comparisonDigest) {
    context.addIssue({ code: "custom", message: "comparison_digest_mismatch" });
  }
  if (comparison.current.eventRevisionId === comparison.prior.eventRevisionId ||
      comparison.current.artifactDigest === comparison.prior.artifactDigest) {
    context.addIssue({ code: "custom", message: "comparison_requires_distinct_events" });
  }
  const match = /^FY(\d{4})-Q([1-4])$/u.exec(comparison.current.fiscalPeriod)!;
  const currentYear = Number(match[1]);
  const currentQuarter = Number(match[2]);
  const expectedPrior = currentQuarter === 1
    ? `FY${currentYear - 1}-Q4`
    : `FY${currentYear}-Q${currentQuarter - 1}`;
  if (comparison.prior.fiscalPeriod !== expectedPrior) {
    context.addIssue({ code: "custom", message: "comparison_period_not_immediately_prior" });
  }
  if (comparison.secondaryYearAgo &&
      comparison.secondaryYearAgo.fiscalPeriod !== `FY${currentYear - 1}-Q${currentQuarter}`) {
    context.addIssue({ code: "custom", message: "comparison_year_ago_period_invalid" });
  }
});

const assertionSchema = z.object({
  citations: z.array(earningsCitationSchema).min(1).max(EARNINGS_CALL_LIMITS.maximumCitationsPerAssertion),
  statement: boundedTextSchema,
}).strict();

export const earningsForecastSchema = z.object({
  catalysts: z.array(assertionSchema).max(8),
  citations: z.array(earningsCitationSchema).min(1).max(EARNINGS_CALL_LIMITS.maximumCitationsPerAssertion),
  direction: z.enum(["negative", "neutral", "positive", "uncertain"]),
  horizon: z.enum(["next_quarter", "two_to_four_quarters", "longer_term"]),
  invalidationConditions: z.array(boundedTextSchema).min(1).max(8),
  likelyMarketInterpretation: boundedTextSchema,
  risks: z.array(assertionSchema).max(8),
  scenarios: z.array(z.object({
    condition: boundedTextSchema,
    direction: z.enum(["negative", "neutral", "positive"]),
    label: z.enum(["base", "bear", "bull"]),
    rationale: boundedTextSchema,
  }).strict()).min(1).max(EARNINGS_CALL_LIMITS.maximumScenarios),
}).strict();

export const earningsRecommendationSchema = z.object({
  assumptions: z.array(boundedTextSchema).min(1).max(8),
  citations: z.array(earningsCitationSchema).min(1).max(EARNINGS_CALL_LIMITS.maximumCitationsPerAssertion),
  conditionalImplication: boundedTextSchema,
  rationale: boundedTextSchema,
  stance: z.enum(["cautious", "constructive", "no_view", "watch"]),
  valuationAssessment: z.literal("not_assessed"),
}).strict();

export const earningsMaterialityDecisionSchema = z.object({
  alertEligible: z.boolean(),
  configuredThreshold: z.number().int().min(0).max(100),
  decisionReasons: z.array(z.enum([
    "abstained",
    "below_threshold",
    "material_change",
    "no_change",
    "not_after_activation_watermark",
    "source_correction",
  ])).min(1).max(4),
  deterministicScore: z.number().int().min(0).max(100),
  policyVersion: semverSchema,
}).strict().superRefine((decision, context) => {
  const disqualifyingReasons = [
    "abstained",
    "below_threshold",
    "no_change",
    "not_after_activation_watermark",
  ] as const;
  if (!unique(decision.decisionReasons)) {
    context.addIssue({ code: "custom", message: "materiality_decision_reasons_duplicate" });
  }
  if (decision.alertEligible !== (
    decision.deterministicScore >= decision.configuredThreshold &&
    decision.decisionReasons.includes("material_change") &&
    !disqualifyingReasons.some((reason) => decision.decisionReasons.includes(reason))
  )) context.addIssue({ code: "custom", message: "materiality_decision_inconsistent" });
});

export const earningsFindingSchema = z.object({
  activationWatermark: timestampSchema,
  analysisLineage: z.object({
    budgetAttempt: z.number().int().positive(),
    configurationRevision: z.number().int().positive(),
    definitionDigest: digestSchema,
    definitionId: identifierSchema,
    definitionVersion: semverSchema,
    modelId: identifierSchema,
    promptDigest: digestSchema,
    validatorVersion: semverSchema,
  }).strict(),
  comparisonDigest: digestSchema,
  comparisonId: identifierSchema,
  confidence: z.enum(["high", "low", "medium"]),
  counterevidence: z.array(assertionSchema).max(EARNINGS_CALL_LIMITS.maximumEvidenceAssertions),
  facts: z.array(assertionSchema).min(1).max(EARNINGS_CALL_LIMITS.maximumEvidenceAssertions),
  findingDigest: digestSchema,
  findingId: identifierSchema,
  forecast: earningsForecastSchema.nullable(),
  inferences: z.array(assertionSchema).max(EARNINGS_CALL_LIMITS.maximumEvidenceAssertions),
  materiality: earningsMaterialityDecisionSchema,
  monitorId: identifierSchema,
  outcome: z.enum(["accepted", "abstained", "no_change", "quarantined"]),
  ownerId: identifierSchema,
  pack: z.object({ contentDigest: digestSchema, id: z.literal("earnings-call-changes"), version: semverSchema }).strict(),
  recordType: z.literal("earnings_call_finding"),
  recommendation: earningsRecommendationSchema.nullable(),
  schemaVersion: z.literal(EARNINGS_CALL_SCHEMA_VERSION),
  unknowns: z.array(boundedTextSchema).max(32),
  workspaceId: identifierSchema,
}).strict().superRefine((finding, context) => {
  const { findingDigest, ...core } = finding;
  if (digestEarningsCallValue(core) !== findingDigest) {
    context.addIssue({ code: "custom", message: "finding_digest_mismatch" });
  }
  const accepted = finding.outcome === "accepted";
  if (accepted && (!finding.forecast || !finding.recommendation || finding.inferences.length === 0)) {
    context.addIssue({ code: "custom", message: "accepted_finding_incomplete" });
  }
  if (!accepted && (finding.materiality.alertEligible || finding.recommendation?.stance !== "no_view")) {
    context.addIssue({ code: "custom", message: "nonaccepted_finding_cannot_alert" });
  }
  if (["abstained", "quarantined"].includes(finding.outcome) && finding.unknowns.length === 0) {
    context.addIssue({ code: "custom", message: "nonaccepted_finding_requires_unknowns" });
  }
  if (finding.materiality.alertEligible &&
      (finding.forecast?.direction === "uncertain" || finding.recommendation?.stance === "no_view")) {
    context.addIssue({ code: "custom", message: "alert_requires_directional_view" });
  }
  try {
    if (Buffer.byteLength(JSON.stringify(finding), "utf8") > EARNINGS_CALL_LIMITS.maximumFindingBytes) {
      context.addIssue({ code: "custom", message: "finding_payload_oversized" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "finding_payload_invalid" });
  }
});

export type EarningsIssuerCatalogRevision = z.infer<typeof earningsIssuerCatalogRevisionSchema>;
export type EarningsSourceFamily = z.infer<typeof earningsSourceFamilySchema>;
export type EarningsSourceInstance = z.infer<typeof earningsSourceInstanceSchema>;
export type EarningsEvent = z.infer<typeof earningsEventSchema>;
export type EarningsTranscript = z.infer<typeof earningsTranscriptSchema>;
export type EarningsComparison = z.infer<typeof earningsComparisonSchema>;
export type EarningsFinding = z.infer<typeof earningsFindingSchema>;
