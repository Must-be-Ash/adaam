import { z } from "zod";

export const PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES = [
  "authorized",
  "denied",
  "pending_review",
  "unavailable",
] as const;

export const PUBLIC_STATEMENT_ATTRIBUTION_STATES = [
  "direct",
  "quoted",
  "alleged",
  "conflicting",
] as const;

export const PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES = [
  "not_applicable",
  "candidates_found",
  "no_established_source_found",
  "not_found",
  "not_run",
  "unavailable",
  "conflicting",
] as const;

export const PUBLIC_COMMENTARY_COPY = Object.freeze({
  relatedCoverage: {
    candidates_found: "Related public links were found. They are discovery candidates, not confirmation of the statement.",
    conflicting: "Permitted related evidence materially conflicts with the statement or with another cited source.",
    no_established_source_found: "The bounded search found no official or established-newsroom candidate under the recorded classification policy.",
    not_applicable: "No external factual claim required a related-source search for this opinion statement.",
    not_found: "The completed bounded search returned no related public candidate.",
    not_run: "Related-source corroboration was not run because it was disabled, unconfigured, or not required.",
    unavailable: "Related-source corroboration is unavailable because the provider failed, timed out, was rate-limited, or exhausted its budget.",
  },
  sourceQuality: {
    conflicting: "Conflicting evidence remains visible and cited; Eve lowers confidence or abstains rather than hiding it.",
    missing: "No related candidate was found within the bounded search; this is not proof that supporting or conflicting coverage does not exist.",
    unavailable: "The related-source provider was unavailable, so the direct statement remains visible without a corroboration claim.",
    unrun: "Corroboration was not run, so Eve makes no claim about related coverage.",
    weak: "A weak or unfamiliar source remains visible and cited with its classification; it is not treated as verified truth.",
  },
});

const sourceAuthorizationSchema = z.enum(PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES);
const attributionSchema = z.enum(PUBLIC_STATEMENT_ATTRIBUTION_STATES);
const relatedCoverageSchema = z.enum(PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES);

export const publicCommentaryProductContractSchema = z.object({
  activation: z.object({
    baselineRule: z.literal("first_successful_fetch_establishes_baseline"),
    defaultMonitorState: z.literal("paused"),
    retroactiveAlerts: z.literal(false),
    watermarkRule: z.literal("record_before_first_acquisition"),
  }).strict(),
  decisionBoundaries: z.object({
    attributionIndependentFromTruth: z.literal(true),
    corroborationMetadataIsNotClaimProof: z.literal(true),
    sourceAuthorizationIndependentFromAttribution: z.literal(true),
    weakAndConflictingSourcesRemainVisible: z.literal(true),
  }).strict(),
  flags: z.object({
    defaultsOff: z.literal(true),
    optionalCorroboration: z.literal("EVE_EXA_CORROBORATION_ENABLED"),
    source: z.literal("EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED"),
  }).strict(),
  providerNeutralVocabulary: z.object({
    attribution: z.array(attributionSchema).length(PUBLIC_STATEMENT_ATTRIBUTION_STATES.length),
    relatedCoverage: z.array(relatedCoverageSchema).length(PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES.length),
    sourceAuthorization: z.array(sourceAuthorizationSchema).length(PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES.length),
  }).strict(),
  recordType: z.literal("public_commentary_product_contract"),
  reposts: z.object({
    defaultIncluded: z.literal(false),
    runtimeArbitraryOverride: z.literal(false),
  }).strict(),
  schemaVersion: z.literal(1),
  userFacingCopy: z.object({
    relatedCoverage: z.record(relatedCoverageSchema, z.string().min(20).max(500)),
    sourceQuality: z.object({
      conflicting: z.string().min(20).max(500),
      missing: z.string().min(20).max(500),
      unavailable: z.string().min(20).max(500),
      unrun: z.string().min(20).max(500),
      weak: z.string().min(20).max(500),
    }).strict(),
  }).strict(),
}).strict();

export const PUBLIC_COMMENTARY_PRODUCT_CONTRACT = publicCommentaryProductContractSchema.parse({
  activation: {
    baselineRule: "first_successful_fetch_establishes_baseline",
    defaultMonitorState: "paused",
    retroactiveAlerts: false,
    watermarkRule: "record_before_first_acquisition",
  },
  decisionBoundaries: {
    attributionIndependentFromTruth: true,
    corroborationMetadataIsNotClaimProof: true,
    sourceAuthorizationIndependentFromAttribution: true,
    weakAndConflictingSourcesRemainVisible: true,
  },
  flags: {
    defaultsOff: true,
    optionalCorroboration: "EVE_EXA_CORROBORATION_ENABLED",
    source: "EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED",
  },
  providerNeutralVocabulary: {
    attribution: [...PUBLIC_STATEMENT_ATTRIBUTION_STATES],
    relatedCoverage: [...PUBLIC_COMMENTARY_RELATED_COVERAGE_STATES],
    sourceAuthorization: [...PUBLIC_COMMENTARY_SOURCE_AUTHORIZATION_STATES],
  },
  recordType: "public_commentary_product_contract",
  reposts: {
    defaultIncluded: false,
    runtimeArbitraryOverride: false,
  },
  schemaVersion: 1,
  userFacingCopy: PUBLIC_COMMENTARY_COPY,
});
