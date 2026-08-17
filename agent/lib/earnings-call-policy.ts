import { z } from "zod";

import { digestEarningsCallValue } from "./earnings-call-schema";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import { resolveStrategyPackFlags } from "./strategy-pack-flags";
import { resolveWorkspaceRuntimeFlags } from "./workspace-runtime-flags";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const semverSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
);

const policyCoreSchema = z.object({
  abstention: z.object({
    acceptedOutcomes: z.tuple([
      z.literal("accepted"),
      z.literal("abstained"),
      z.literal("no_change"),
      z.literal("quarantined"),
    ]),
    blockers: z.array(z.enum([
      "ambiguous_period",
      "citation_invalid",
      "contradictory_evidence_unresolved",
      "evidence_incomplete",
      "hostile_source_instruction",
      "live_call_completeness_required_for_absence_claim",
      "missing_qa",
      "seasonal_context_required",
      "token_or_budget_overflow",
      "unsupported_numeric_precision",
    ])).length(10),
    nonAcceptedRecommendation: z.literal("no_view"),
  }).strict(),
  activation: z.object({
    alertEligiblePublicationRelation: z.literal("strictly_after_watermark"),
    baselineBackfillAlerts: z.literal(false),
    defaultMonitorState: z.literal("paused"),
    maximumBackfillEventsPerIssuer: z.literal(4),
    minimumVerifiedIssuers: z.literal(1),
    watermarkRecordedBeforeAcquisition: z.literal(true),
  }).strict(),
  citationsAndCoverage: z.object({
    absenceClaimPolicy: z.literal("abstain_or_downgrade_without_live_call_attestation"),
    acceptedAssertionCitationMinimum: z.literal(1),
    artifactDigestRequired: z.literal(true),
    currentPriorAuthorizationIndependent: z.literal(true),
    documentCoverageRequired: z.tuple([
      z.literal("prepared_remarks"),
      z.literal("questions_and_answers"),
    ]),
    liveCallCompletenessDefault: z.literal("not_attested"),
    maximumCitationsPerAssertion: z.literal(8),
    signedSpanBoundsRequired: z.literal(true),
  }).strict(),
  comparablePeriods: z.object({
    ambiguousPeriodOutcome: z.literal("abstained"),
    chronologicalCatchUp: z.literal(true),
    likeForLikeSections: z.literal(true),
    primary: z.literal("immediately_prior_fiscal_quarter_same_cik"),
    secondary: z.literal("year_ago_context_only"),
    seasonalPolicy: z.literal("consider_available_year_ago_or_lower_confidence_or_no_view"),
    yearAgoCanReplacePrimary: z.literal(false),
  }).strict(),
  correctionSemantics: z.object({
    analyticalChange: z.literal("new_analysis_lineage_not_source_correction"),
    analyticalInputs: z.tuple([
      z.literal("model"),
      z.literal("prompt"),
      z.literal("validator"),
      z.literal("pack_version"),
    ]),
    correctiveAlert: z.literal("only_if_previously_alerted_conclusion_changes_materially"),
    sourceArtifactChange: z.literal("new_source_revision_same_logical_event"),
  }).strict(),
  deterministicOwnership: z.array(z.enum([
    "alert_delivery",
    "authorization",
    "budgets",
    "chronology",
    "citations",
    "deduplication",
    "event_identity",
    "materiality",
    "metrics",
    "replay",
    "section_boundaries",
    "source_trust",
  ])).length(12),
  flagMatrix: z.object({
    executionFlag: z.literal("EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED"),
    executionParents: z.tuple([
      z.literal("EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED"),
      z.literal("EVE_STRATEGY_PACK_CATALOG_ENABLED"),
      z.literal("EVE_STRATEGY_PACK_RUNTIME_ENABLED"),
      z.literal("EVE_HYBRID_EVIDENCE_ENABLED"),
      z.literal("EVE_HYBRID_SEMANTIC_REASONING_ENABLED"),
      z.literal("EVE_WORKSPACE_STATE_ENABLED"),
      z.literal("EVE_WORKSPACE_DISPATCH_ENABLED"),
    ]),
    flagsDefaultOff: z.literal(true),
    invalidCombination: z.literal("fail_closed"),
    sourceFlag: z.literal("EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED"),
    sourceParents: z.tuple([
      z.literal("EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED"),
      z.literal("EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED"),
    ]),
  }).strict(),
  modelOwnership: z.array(z.enum([
    "confidence_judgment",
    "evasiveness_interpretation",
    "forecast_scenarios",
    "guidance_interpretation",
    "implications",
    "likely_market_interpretation",
    "priority_interpretation",
    "recommendation",
    "risk_interpretation",
    "stance_change_interpretation",
  ])).length(10),
  policyId: z.literal("earnings-call-changes"),
  policyVersion: semverSchema,
  semanticEnvelope: z.object({
    chargeableAttemptOutcomes: z.tuple([
      z.literal("accepted"),
      z.literal("failed"),
      z.literal("invalid"),
      z.literal("quarantined"),
      z.literal("uncertain"),
    ]),
    maximumAggregateInputTokens: z.literal(24_000),
    maximumAggregateOutputTokens: z.literal(4_000),
    maximumAttemptsPerJob: z.literal(1),
    maximumSectionInputTokens: z.literal(5_000),
    maximumSectionJobs: z.literal(4),
    maximumSectionOutputTokens: z.literal(750),
    maximumSingleJobInputTokens: z.literal(12_000),
    maximumSingleJobOutputTokens: z.literal(2_000),
    maximumSynthesisInputTokens: z.literal(4_000),
    maximumSynthesisJobs: z.literal(1),
    maximumSynthesisOutputTokens: z.literal(1_000),
    overflowOutcome: z.literal("abstained"),
  }).strict(),
  stanceVocabulary: z.tuple([
    z.literal("constructive"),
    z.literal("watch"),
    z.literal("cautious"),
    z.literal("no_view"),
  ]),
}).strict();

export const earningsCallPolicySchema = policyCoreSchema.extend({
  policyDigest: digestSchema,
}).strict().superRefine((policy, context) => {
  const { policyDigest, ...core } = policy;
  if (digestEarningsCallValue(core) !== policyDigest) {
    context.addIssue({ code: "custom", message: "earnings_policy_digest_mismatch" });
  }
});

const policyCore = policyCoreSchema.parse({
  abstention: {
    acceptedOutcomes: ["accepted", "abstained", "no_change", "quarantined"],
    blockers: [
      "ambiguous_period",
      "citation_invalid",
      "contradictory_evidence_unresolved",
      "evidence_incomplete",
      "hostile_source_instruction",
      "live_call_completeness_required_for_absence_claim",
      "missing_qa",
      "seasonal_context_required",
      "token_or_budget_overflow",
      "unsupported_numeric_precision",
    ],
    nonAcceptedRecommendation: "no_view",
  },
  activation: {
    alertEligiblePublicationRelation: "strictly_after_watermark",
    baselineBackfillAlerts: false,
    defaultMonitorState: "paused",
    maximumBackfillEventsPerIssuer: 4,
    minimumVerifiedIssuers: 1,
    watermarkRecordedBeforeAcquisition: true,
  },
  citationsAndCoverage: {
    absenceClaimPolicy: "abstain_or_downgrade_without_live_call_attestation",
    acceptedAssertionCitationMinimum: 1,
    artifactDigestRequired: true,
    currentPriorAuthorizationIndependent: true,
    documentCoverageRequired: ["prepared_remarks", "questions_and_answers"],
    liveCallCompletenessDefault: "not_attested",
    maximumCitationsPerAssertion: 8,
    signedSpanBoundsRequired: true,
  },
  comparablePeriods: {
    ambiguousPeriodOutcome: "abstained",
    chronologicalCatchUp: true,
    likeForLikeSections: true,
    primary: "immediately_prior_fiscal_quarter_same_cik",
    secondary: "year_ago_context_only",
    seasonalPolicy: "consider_available_year_ago_or_lower_confidence_or_no_view",
    yearAgoCanReplacePrimary: false,
  },
  correctionSemantics: {
    analyticalChange: "new_analysis_lineage_not_source_correction",
    analyticalInputs: ["model", "prompt", "validator", "pack_version"],
    correctiveAlert: "only_if_previously_alerted_conclusion_changes_materially",
    sourceArtifactChange: "new_source_revision_same_logical_event",
  },
  deterministicOwnership: [
    "alert_delivery",
    "authorization",
    "budgets",
    "chronology",
    "citations",
    "deduplication",
    "event_identity",
    "materiality",
    "metrics",
    "replay",
    "section_boundaries",
    "source_trust",
  ],
  flagMatrix: {
    executionFlag: "EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED",
    executionParents: [
      "EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED",
      "EVE_STRATEGY_PACK_CATALOG_ENABLED",
      "EVE_STRATEGY_PACK_RUNTIME_ENABLED",
      "EVE_HYBRID_EVIDENCE_ENABLED",
      "EVE_HYBRID_SEMANTIC_REASONING_ENABLED",
      "EVE_WORKSPACE_STATE_ENABLED",
      "EVE_WORKSPACE_DISPATCH_ENABLED",
    ],
    flagsDefaultOff: true,
    invalidCombination: "fail_closed",
    sourceFlag: "EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED",
    sourceParents: [
      "EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED",
      "EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED",
    ],
  },
  modelOwnership: [
    "confidence_judgment",
    "evasiveness_interpretation",
    "forecast_scenarios",
    "guidance_interpretation",
    "implications",
    "likely_market_interpretation",
    "priority_interpretation",
    "recommendation",
    "risk_interpretation",
    "stance_change_interpretation",
  ],
  policyId: "earnings-call-changes",
  policyVersion: "1.0.0",
  semanticEnvelope: {
    chargeableAttemptOutcomes: ["accepted", "failed", "invalid", "quarantined", "uncertain"],
    maximumAggregateInputTokens: 24_000,
    maximumAggregateOutputTokens: 4_000,
    maximumAttemptsPerJob: 1,
    maximumSectionInputTokens: 5_000,
    maximumSectionJobs: 4,
    maximumSectionOutputTokens: 750,
    maximumSingleJobInputTokens: 12_000,
    maximumSingleJobOutputTokens: 2_000,
    maximumSynthesisInputTokens: 4_000,
    maximumSynthesisJobs: 1,
    maximumSynthesisOutputTokens: 1_000,
    overflowOutcome: "abstained",
  },
  stanceVocabulary: ["constructive", "watch", "cautious", "no_view"],
});

export const EARNINGS_CALL_POLICY = Object.freeze(earningsCallPolicySchema.parse({
  ...policyCore,
  policyDigest: digestEarningsCallValue(policyCore),
}));

export interface EarningsCallFlags {
  readonly alertDelivery: boolean;
  readonly configuration: "disabled" | "enabled" | "misconfigured";
  readonly execution: boolean;
  readonly sourceAcquisition: boolean;
}

function enabled(value: string | undefined): boolean {
  return value === "1";
}

export function resolveEarningsCallFlags(
  environment: NodeJS.ProcessEnv = process.env,
): EarningsCallFlags {
  const sourceRequested = enabled(environment.EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED);
  const executionRequested = enabled(environment.EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED);
  const anyRequested = sourceRequested || executionRequested;
  const sourceParents =
    enabled(environment.EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED) &&
    enabled(environment.EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED);
  const workspace = resolveWorkspaceRuntimeFlags(environment);
  const strategy = resolveStrategyPackFlags(environment);
  const hybrid = resolveHybridEvidenceFlags(environment);
  const sourceAvailable = sourceRequested && sourceParents;
  const executionParents =
    sourceAvailable &&
    strategy.runtimeComposition &&
    workspace.dispatch &&
    hybrid.enabled &&
    hybrid.semanticReasoning;
  const misconfigured =
    (sourceRequested && !sourceParents) ||
    (executionRequested && !executionParents);
  const execution = executionRequested && executionParents && !misconfigured;
  return Object.freeze({
    alertDelivery: execution && workspace.photonAlerts,
    configuration: !anyRequested ? "disabled" : misconfigured ? "misconfigured" : "enabled",
    execution,
    sourceAcquisition: sourceAvailable && !misconfigured,
  });
}
