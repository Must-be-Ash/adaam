import { z } from "zod";

import { digestPublicSourceValue } from "./public-source-adapter-schema";
import type { AuthorizedPublicSourceProjection } from "./public-source-subscription-store";

export const CONGRESSIONAL_SIGNAL_REASON_CODES = Object.freeze([
  "baseline",
  "broad_fund",
  "committee_cluster",
  "committee_relevant",
  "duplicate",
  "eligible",
  "invalid_date",
  "material_range",
  "member_not_selected",
  "non_security_asset",
  "pattern_break",
  "same_member_cluster",
  "stale_disclosure",
  "superseded",
  "timely",
  "unclassified_direction",
  "unresolved_member",
  "unresolved_security",
  "unsupported_source",
] as const);

export const CONGRESSIONAL_SIGNAL_BANDS = Object.freeze([
  "record_only",
  "review",
  "priority",
] as const);

export const CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES = Object.freeze([
  "committee_cluster",
  "committee_relevant",
  "material_range",
  "pattern_break",
  "same_member_cluster",
  "timely",
] as const);

export const CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT =
  "Delayed public disclosure; research signal only, not evidence of wrongdoing or a trade instruction." as const;

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const timestampSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().date();
const identifierSchema = z.string().trim().min(2).max(240);
const reasonCodeSchema = z.enum(CONGRESSIONAL_SIGNAL_REASON_CODES);
const bandSchema = z.enum(CONGRESSIONAL_SIGNAL_BANDS);

function sortedUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export function congressionalSignalContractDigest(value: unknown): string {
  return digestPublicSourceValue(value);
}

function withoutField<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const { [field]: _field, ...core } = value;
  return core;
}

export const congressionalPolicySchema = z.object({
  alertThresholds: z.tuple([z.literal("priority"), z.literal("review")]),
  bands: z.tuple(CONGRESSIONAL_SIGNAL_BANDS.map((band) => z.literal(band)) as [
    z.ZodLiteral<(typeof CONGRESSIONAL_SIGNAL_BANDS)[0]>,
    ...z.ZodLiteral<(typeof CONGRESSIONAL_SIGNAL_BANDS)[number]>[],
  ]),
  catalogMaximumAgeDays: z.literal(90).optional(),
  clusterMinimumFacts: z.literal(3).optional(),
  clusterWindowDays: z.literal(30).optional(),
  coverage: z.literal("house_only"),
  coverageMaximumGapDays: z.literal(2).optional(),
  defaultAlertThreshold: z.literal("priority"),
  eligibleTransactionTypes: z.tuple([z.literal("P"), z.literal("S")]),
  materialLowerBound: z.literal("50001"),
  maximumDisclosureLagDays: z.literal(45),
  historyCoverageDays: z.literal(90).optional(),
  historyMinimumTransactions: z.literal(5).optional(),
  policyDigest: digestSchema,
  policyId: z.literal("congressional-signals-policy"),
  policyVersion: z.enum(["1.0.0", "1.1.0", "1.2.0"]),
  reasonCodes: z.tuple(CONGRESSIONAL_SIGNAL_REASON_CODES.map((code) => z.literal(code)) as [
    z.ZodLiteral<(typeof CONGRESSIONAL_SIGNAL_REASON_CODES)[0]>,
    ...z.ZodLiteral<(typeof CONGRESSIONAL_SIGNAL_REASON_CODES)[number]>[],
  ]),
  recordType: z.literal("congressional_signal_policy"),
  schemaVersion: z.literal(1),
  timelyMaximumLagDays: z.literal(15),
}).strict().superRefine((policy, context) => {
  if (
    policy.policyDigest !== congressionalSignalContractDigest(withoutField(policy, "policyDigest")) ||
    !sortedUnique(policy.reasonCodes) ||
    (policy.policyVersion !== "1.0.0") !== (policy.catalogMaximumAgeDays === 90) ||
    (policy.policyVersion === "1.2.0") !== (
      policy.clusterMinimumFacts === 3 &&
      policy.clusterWindowDays === 30 &&
      policy.coverageMaximumGapDays === 2 &&
      policy.historyCoverageDays === 90 &&
      policy.historyMinimumTransactions === 5
    )
  ) {
    context.addIssue({ code: "custom", message: "congressional_policy_invalid" });
  }
});

const catalogBase = {
  catalogDigest: digestSchema,
  catalogId: z.string().regex(/^congressional-[a-z0-9-]+$/u),
  catalogVersion: semverSchema,
  recordType: z.literal("congressional_reference_catalog"),
  schemaVersion: z.literal(1),
};

const houseMemberEntrySchema = z.object({
  bioguideId: z.string().regex(/^[A-Z]\d{6}$/u),
  district: z.string().regex(/^(?:\d{2}|AL)$/u),
  effectiveFrom: dateSchema,
  effectiveThrough: dateSchema.nullable(),
  officialName: z.string().trim().min(1).max(240),
  party: z.enum(["Democratic", "Independent", "Republican"]),
  provenanceUrl: z.string().url().refine((value) => value.startsWith("https://")),
  sourceStateDistrict: z.string().regex(/^[A-Z]{2}(?:\d{2}|AL)$/u).optional(),
  state: z.string().regex(/^[A-Z]{2}$/u),
}).strict();

const securityClassificationEntrySchema = z.object({
  canonicalSecurityId: identifierSchema,
  classification: z.enum(["broad_fund", "non_security_asset", "security"]),
  industryId: identifierSchema.nullable(),
  reportedTicker: z.string().regex(/^[A-Z0-9.-]{1,20}$/u),
  reviewedAt: dateSchema,
  sourceUrl: z.string().url().refine((value) => value.startsWith("https://")),
}).strict();

const committeeAssignmentEntrySchema = z.object({
  assignmentId: identifierSchema,
  bioguideId: z.string().regex(/^[A-Z]\d{6}$/u),
  committeeId: identifierSchema,
  effectiveFrom: dateSchema,
  effectiveThrough: dateSchema.nullable(),
  provenanceUrl: z.string().url().refine((value) => value.startsWith("https://")),
  subcommitteeId: identifierSchema.nullable(),
}).strict();

const committeeJurisdictionEntrySchema = z.object({
  committeeId: identifierSchema,
  effectiveFrom: dateSchema,
  effectiveThrough: dateSchema.nullable(),
  industryId: identifierSchema.nullable(),
  jurisdictionId: identifierSchema,
  provenanceUrl: z.string().url().refine((value) => value.startsWith("https://")),
  relevance: z.enum(["broad", "no", "yes"]),
  subcommitteeId: identifierSchema.nullable(),
}).strict().superRefine((entry, context) => {
  if ((entry.relevance === "broad") !== (entry.industryId === null)) {
    context.addIssue({ code: "custom", message: "congressional_jurisdiction_invalid" });
  }
});

export const congressionalReferenceCatalogSchema = z.discriminatedUnion("kind", [
  z.object({
    ...catalogBase,
    entries: z.array(houseMemberEntrySchema).max(600),
    kind: z.literal("house_members"),
  }).strict(),
  z.object({
    ...catalogBase,
    entries: z.array(securityClassificationEntrySchema).max(256),
    kind: z.literal("security_classifications"),
  }).strict(),
  z.object({
    ...catalogBase,
    entries: z.array(committeeAssignmentEntrySchema).max(2_000),
    kind: z.literal("committee_assignments"),
    reviewedAt: dateSchema,
  }).strict(),
  z.object({
    ...catalogBase,
    entries: z.array(committeeJurisdictionEntrySchema).max(256),
    kind: z.literal("committee_jurisdictions"),
    reviewedAt: dateSchema,
  }).strict(),
]).superRefine((catalog, context) => {
  const core = withoutField(catalog, "catalogDigest");
  let entryIds: string[];
  if (catalog.kind === "house_members") {
    entryIds = catalog.entries.map((entry) => `${entry.bioguideId}:${entry.effectiveFrom}`);
  } else if (catalog.kind === "security_classifications") {
    entryIds = catalog.entries.map((entry) => `${entry.reportedTicker}:${entry.canonicalSecurityId}`);
  } else if (catalog.kind === "committee_assignments") {
    entryIds = catalog.entries.map((entry) => entry.assignmentId);
  } else {
    entryIds = catalog.entries.map((entry) => entry.jurisdictionId);
  }
  if (
    catalog.catalogDigest !== congressionalSignalContractDigest(core) ||
    !sortedUnique(entryIds)
  ) {
    context.addIssue({ code: "custom", message: "congressional_catalog_invalid" });
  }
});

export class CongressionalSignalContractError extends Error {
  constructor(readonly code: "catalog_identity_conflict" | "projection_invalid") {
    super(code);
    this.name = "CongressionalSignalContractError";
  }
}

export function assertImmutableCongressionalCatalog(
  existing: z.infer<typeof congressionalReferenceCatalogSchema>,
  candidate: unknown,
): void {
  if (typeof candidate !== "object" || candidate === null) {
    throw new CongressionalSignalContractError("catalog_identity_conflict");
  }
  if (
    Reflect.get(candidate, "catalogId") === existing.catalogId &&
    Reflect.get(candidate, "catalogVersion") === existing.catalogVersion &&
    JSON.stringify(candidate) !== JSON.stringify(existing)
  ) {
    throw new CongressionalSignalContractError("catalog_identity_conflict");
  }
}

const packBindingSchema = z.object({
  bindingRevision: z.number().int().positive(),
  packContentDigest: digestSchema,
  packId: z.literal("congressional-signals"),
  packVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]),
}).strict();

const policyReferenceSchema = z.object({
  policyDigest: digestSchema,
  policyId: z.literal("congressional-signals-policy"),
  policyVersion: z.enum(["1.0.0", "1.1.0", "1.2.0"]),
}).strict();

const catalogReferenceSchema = z.object({
  catalogDigest: digestSchema,
  catalogId: identifierSchema,
  catalogVersion: semverSchema,
}).strict();

const lineageSchema = z.object({
  correctionId: identifierSchema.nullable(),
  priorRevisionId: identifierSchema.nullable(),
  retractionId: identifierSchema.nullable(),
  state: z.enum(["active", "retracted"]),
}).strict().superRefine((lineage, context) => {
  if (
    (lineage.state === "retracted") !== (lineage.retractionId !== null) ||
    (lineage.state === "active" &&
      (lineage.correctionId !== null) !== (lineage.priorRevisionId !== null)) ||
    (lineage.state === "retracted" &&
      (lineage.correctionId !== null || lineage.priorRevisionId === null))
  ) {
    context.addIssue({ code: "custom", message: "congressional_lineage_invalid" });
  }
});

const amountRangeSchema = z.object({
  label: z.string().trim().min(1).max(120),
  lower: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
  upper: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
}).strict();

const houseStrategyTransactionCoreSchema = z.object({
  amountRange: amountRangeSchema,
  asset: z.object({
    description: z.string().trim().min(1).max(1_000).nullable(),
    reportedTicker: z.string().regex(/^[A-Z0-9.-]{1,20}$/u).nullable(),
  }).strict(),
  catalogReferences: z.object({
    committeeAssignments: catalogReferenceSchema,
    committeeJurisdictions: catalogReferenceSchema,
    member: catalogReferenceSchema,
    security: catalogReferenceSchema,
  }).strict(),
  createdAt: timestampSchema,
  disclosedMember: z.object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    prefix: z.string().trim().max(40).nullable(),
    stateDistrict: z.string().regex(/^[A-Z]{2}(?:\d{2}|AL)$/u),
    suffix: z.string().trim().max(40).nullable(),
  }).strict(),
  disclosureLagDays: z.number().int().nullable(),
  eligibility: z.object({
    reasonCodes: z.array(reasonCodeSchema).min(1).max(CONGRESSIONAL_SIGNAL_REASON_CODES.length),
    state: z.enum(["eligible", "record_only"]),
  }).strict(),
  filingDate: dateSchema,
  lineage: lineageSchema,
  memberResolution: z.object({
    bioguideId: z.string().regex(/^[A-Z]\d{6}$/u).nullable(),
    state: z.enum(["ambiguous", "resolved", "unknown"]),
  }).strict(),
  notificationDate: dateSchema.nullable(),
  observedAt: timestampSchema,
  owner: z.object({
    disclosedCode: z.string().trim().min(1).max(20).nullable(),
    relationship: z.enum(["dependent_child", "joint", "other_disclosed", "self", "spouse", "unknown"]),
  }).strict(),
  packBinding: packBindingSchema,
  policyReference: policyReferenceSchema,
  processingMode: z.enum(["baseline", "live"]),
  recordType: z.literal("house_strategy_transaction"),
  schemaVersion: z.literal(1),
  securityResolution: z.object({
    canonicalSecurityId: identifierSchema.nullable(),
    classification: z.enum(["broad_fund", "non_security_asset", "security", "unknown"]),
    industryId: identifierSchema.nullable(),
    state: z.enum(["ambiguous", "resolved", "unknown"]),
  }).strict(),
  source: z.object({
    authority: z.literal("House Clerk"),
    factLogicalKey: identifierSchema,
    factRevisionId: identifierSchema,
    filingFactRevisionId: identifierSchema,
    filingLogicalKey: identifierSchema,
    projectionId: identifierSchema,
    publicDocumentUrl: z.string().url().refine((value) =>
      value.startsWith("https://disclosures-clerk.house.gov/")),
    rowIdentity: z.string().regex(/^row:\d+$/u),
    sourceInstanceId: identifierSchema,
    subscriptionId: identifierSchema,
  }).strict(),
  transactionDate: dateSchema.nullable(),
  transactionId: identifierSchema,
  transactionType: z.enum(["E", "P", "S"]).nullable(),
  workspaceId: z.string().uuid(),
}).strict();

export function deriveHouseStrategyTransactionRevisionId(
  core: z.input<typeof houseStrategyTransactionCoreSchema>,
): string {
  return `congressional-transaction-revision.${congressionalSignalContractDigest(core)}`;
}

export function deriveHouseStrategyTransactionId(input: {
  readonly factLogicalKey: string;
  readonly subscriptionId: string;
  readonly workspaceId: string;
}): string {
  return `congressional-transaction.${congressionalSignalContractDigest([
    input.workspaceId,
    input.subscriptionId,
    input.factLogicalKey,
  ])}`;
}

export const houseStrategyTransactionSchema = houseStrategyTransactionCoreSchema.extend({
  transactionRevisionId: identifierSchema,
}).strict().superRefine((transaction, context) => {
  const core = withoutField(transaction, "transactionRevisionId");
  if (
    transaction.transactionRevisionId !== deriveHouseStrategyTransactionRevisionId(
      core as z.input<typeof houseStrategyTransactionCoreSchema>,
    ) ||
    transaction.transactionId !== deriveHouseStrategyTransactionId({
      factLogicalKey: transaction.source.factLogicalKey,
      subscriptionId: transaction.source.subscriptionId,
      workspaceId: transaction.workspaceId,
    }) ||
    !sortedUnique(transaction.eligibility.reasonCodes) ||
    (transaction.eligibility.state === "eligible") !==
      (JSON.stringify(transaction.eligibility.reasonCodes) === JSON.stringify(["eligible"])) ||
    (transaction.memberResolution.state === "resolved") !==
      (transaction.memberResolution.bioguideId !== null) ||
    (transaction.securityResolution.state === "resolved") !==
      (transaction.securityResolution.canonicalSecurityId !== null)
  ) {
    context.addIssue({ code: "custom", message: "house_strategy_transaction_invalid" });
  }
});

const filingSignalCoreSchema = z.object({
  alertEligible: z.boolean(),
  band: bandSchema,
  catalogReferences: z.object({
    committeeAssignments: catalogReferenceSchema,
    committeeJurisdictions: catalogReferenceSchema,
    member: catalogReferenceSchema,
    security: catalogReferenceSchema,
  }).strict(),
  createdAt: timestampSchema,
  filingLogicalKey: identifierSchema,
  lineage: lineageSchema,
  packBinding: packBindingSchema,
  policyReference: policyReferenceSchema,
  reasonTrace: z.array(z.object({
    reasonCode: reasonCodeSchema,
    sourceRevisionId: identifierSchema,
    state: z.enum(["applied", "not_applicable", "unavailable"]),
  }).strict()).min(1).max(10_000),
  recordType: z.literal("congressional_filing_signal"),
  schemaVersion: z.literal(1),
  signalId: identifierSchema,
  transactionEvaluations: z.array(z.object({
    band: bandSchema,
    committeeResolution: z.object({
      assignmentIds: z.array(identifierSchema).max(32),
      committeeKeys: z.array(identifierSchema).max(32).optional(),
      jurisdictionIds: z.array(identifierSchema).max(32),
      state: z.enum(["ambiguous", "no", "stale", "unknown", "yes"]),
    }).strict(),
    clusterRevisionIds: z.array(identifierSchema).max(64).optional(),
    evidence: z.array(z.object({
      reasonCode: z.enum(CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES),
      sourceRecordIds: z.array(identifierSchema).max(500),
      state: z.enum(["applied", "not_applicable", "unavailable"]),
    }).strict().superRefine((evidence, context) => {
      if (!sortedUnique(evidence.sourceRecordIds)) {
        context.addIssue({ code: "custom", message: "congressional_evidence_invalid" });
      }
    })).length(6),
    reasonCodes: z.array(reasonCodeSchema).min(1).max(CONGRESSIONAL_SIGNAL_REASON_CODES.length),
    patternResolution: z.object({
      priorTransactionRevisionIds: z.array(identifierSchema).max(500),
      ruleCodes: z.array(z.enum(["amount_above_history", "new_direction", "new_industry"])).max(3),
      state: z.enum(["no", "unavailable", "yes"]),
    }).strict().optional(),
    transactionRevisionId: identifierSchema,
  }).strict()).min(1).max(500),
  workspaceId: z.string().uuid(),
}).strict();

export function deriveCongressionalSignalRevisionId(
  core: z.input<typeof filingSignalCoreSchema>,
): string {
  return `congressional-signal-revision.${congressionalSignalContractDigest(core)}`;
}

export function deriveCongressionalSignalId(input: {
  readonly filingLogicalKey: string;
  readonly packBinding: z.infer<typeof packBindingSchema>;
  readonly workspaceId: string;
}): string {
  return `congressional-signal.${congressionalSignalContractDigest([
    input.workspaceId,
    input.filingLogicalKey,
    input.packBinding,
  ])}`;
}

export const congressionalFilingSignalSchema = filingSignalCoreSchema.extend({
  signalRevisionId: identifierSchema,
}).strict().superRefine((signal, context) => {
  const core = withoutField(signal, "signalRevisionId");
  if (
    signal.signalRevisionId !== deriveCongressionalSignalRevisionId(
      core as z.input<typeof filingSignalCoreSchema>,
    ) ||
    signal.signalId !== deriveCongressionalSignalId(signal) ||
    !sortedUnique(signal.transactionEvaluations.map(({ transactionRevisionId }) =>
      transactionRevisionId)) ||
    signal.transactionEvaluations.some((evaluation) => !sortedUnique(evaluation.reasonCodes)) ||
    signal.transactionEvaluations.some((evaluation) =>
      (signal.packBinding.packVersion === "1.2.0" || signal.packBinding.packVersion === "1.3.0") && (
        evaluation.committeeResolution.committeeKeys === undefined ||
        evaluation.clusterRevisionIds === undefined ||
        evaluation.patternResolution === undefined
      )) ||
    signal.transactionEvaluations.some((evaluation) =>
      signal.packBinding.packVersion !== "1.2.0" && signal.packBinding.packVersion !== "1.3.0" && (
        evaluation.committeeResolution.committeeKeys !== undefined ||
        evaluation.clusterRevisionIds !== undefined ||
        evaluation.patternResolution !== undefined
      )) ||
    (signal.band === "record_only" && signal.alertEligible)
  ) {
    context.addIssue({ code: "custom", message: "congressional_signal_invalid" });
  }
});

function catalogReference(catalog: z.infer<typeof congressionalReferenceCatalogSchema>) {
  return Object.freeze({
    catalogDigest: catalog.catalogDigest,
    catalogId: catalog.catalogId,
    catalogVersion: catalog.catalogVersion,
  });
}

function ownerRelationship(code: string | null) {
  if (code === "SP") return "spouse" as const;
  if (code === "JT") return "joint" as const;
  if (code === "DC") return "dependent_child" as const;
  if (code === "SELF") return "self" as const;
  return code === null ? "unknown" as const : "other_disclosed" as const;
}

function calendarDayDifference(from: string, through: string): number | null {
  const difference = Date.parse(`${through}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Number.isFinite(difference) ? difference / 86_400_000 : null;
}

export function resolveCongressionalMember(input: {
  catalog: Extract<z.infer<typeof congressionalReferenceCatalogSchema>, { kind: "house_members" }>;
  filingDate: string;
  filer: {
    firstName: string;
    lastName: string;
    stateDistrict: string;
  };
  transactionDate: string | null;
}) {
  const effectiveDate = input.transactionDate ?? input.filingDate;
  const state = input.filer.stateDistrict.slice(0, 2);
  const district = input.filer.stateDistrict.slice(2);
  const disclosedName = `${input.filer.firstName} ${input.filer.lastName}`
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  const matches = input.catalog.entries.filter((entry) =>
    (entry.sourceStateDistrict ?? `${entry.state}${entry.district}`) === `${state}${district}` &&
    entry.officialName.toLocaleLowerCase("en-US") === disclosedName &&
    entry.effectiveFrom <= effectiveDate &&
    (entry.effectiveThrough === null || entry.effectiveThrough >= effectiveDate)
  );
  return matches.length === 1
    ? { bioguideId: matches[0]!.bioguideId, state: "resolved" as const }
    : { bioguideId: null, state: matches.length > 1 ? "ambiguous" as const : "unknown" as const };
}

export function resolveCongressionalSecurity(input: {
  catalog: Extract<z.infer<typeof congressionalReferenceCatalogSchema>, { kind: "security_classifications" }>;
  reportedTicker: string | null;
}) {
  const matches = input.reportedTicker === null
    ? []
    : input.catalog.entries.filter((entry) => entry.reportedTicker === input.reportedTicker);
  return matches.length === 1
    ? {
        canonicalSecurityId: matches[0]!.canonicalSecurityId,
        classification: matches[0]!.classification,
        industryId: matches[0]!.industryId,
        state: "resolved" as const,
      }
    : {
        canonicalSecurityId: null,
        classification: "unknown" as const,
        industryId: null,
        state: matches.length > 1 ? "ambiguous" as const : "unknown" as const,
      };
}

export function normalizeProjectedHouseTransaction(input: {
  readonly catalogs: {
    readonly committeeAssignments: z.infer<typeof congressionalReferenceCatalogSchema>;
    readonly committeeJurisdictions: z.infer<typeof congressionalReferenceCatalogSchema>;
    readonly member: z.infer<typeof congressionalReferenceCatalogSchema>;
    readonly security: z.infer<typeof congressionalReferenceCatalogSchema>;
  };
  readonly filing: AuthorizedPublicSourceProjection;
  readonly observedAt: string;
  readonly packBinding: z.infer<typeof packBindingSchema>;
  readonly policy: z.infer<typeof congressionalPolicySchema>;
  readonly processingMode: "baseline" | "live";
  readonly selectedMemberBioguideIds?: readonly string[];
  readonly transaction: AuthorizedPublicSourceProjection;
}): z.infer<typeof houseStrategyTransactionSchema> {
  const filing = input.filing.fact.payload;
  const transaction = input.transaction.fact.payload;
  if (
    filing.schemaVersion !== "house-ptr-filing/v1" ||
    transaction.schemaVersion !== "house-ptr-transaction/v1" ||
    input.filing.projection.workspaceId !== input.transaction.projection.workspaceId ||
    input.filing.projection.subscriptionId !== input.transaction.projection.subscriptionId ||
    input.filing.fact.logicalKey !== transaction.filingLogicalKey ||
    input.filing.fact.sourceInstanceId !== input.transaction.fact.sourceInstanceId ||
    input.catalogs.committeeAssignments.kind !== "committee_assignments" ||
    input.catalogs.committeeJurisdictions.kind !== "committee_jurisdictions" ||
    input.catalogs.member.kind !== "house_members" ||
    input.catalogs.security.kind !== "security_classifications"
  ) {
    throw new CongressionalSignalContractError("projection_invalid");
  }

  const disclosureLagDays = transaction.transactionDate === null
    ? null
    : calendarDayDifference(transaction.transactionDate, filing.filingDate);
  const resolvedMember = resolveCongressionalMember({
    catalog: input.catalogs.member,
    filingDate: filing.filingDate,
    filer: filing.filer,
    transactionDate: transaction.transactionDate,
  });
  const resolvedSecurity = resolveCongressionalSecurity({
    catalog: input.catalogs.security,
    reportedTicker: transaction.reportedTicker,
  });
  const reasons: (typeof CONGRESSIONAL_SIGNAL_REASON_CODES)[number][] = [];
  if (input.processingMode === "baseline") reasons.push("baseline");
  if (input.transaction.fact.extraction.state !== "complete") reasons.push("unsupported_source");
  if (resolvedMember.state !== "resolved") reasons.push("unresolved_member");
  if (resolvedSecurity.state !== "resolved") reasons.push("unresolved_security");
  if (
    resolvedMember.bioguideId !== null &&
    (input.selectedMemberBioguideIds?.length ?? 0) > 0 &&
    !input.selectedMemberBioguideIds!.includes(resolvedMember.bioguideId)
  ) {
    reasons.push("member_not_selected");
  }
  if (resolvedSecurity.classification === "broad_fund") reasons.push("broad_fund");
  if (resolvedSecurity.classification === "non_security_asset") reasons.push("non_security_asset");
  if (transaction.transactionType !== "P" && transaction.transactionType !== "S") {
    reasons.push("unclassified_direction");
  }
  if (disclosureLagDays === null || !Number.isInteger(disclosureLagDays) || disclosureLagDays < 0) {
    reasons.push("invalid_date");
  } else if (disclosureLagDays > input.policy.maximumDisclosureLagDays) {
    reasons.push("stale_disclosure");
  }
  const reasonCodes = [...new Set(reasons)].sort();
  const eligibility = reasonCodes.length === 0
    ? { reasonCodes: ["eligible" as const], state: "eligible" as const }
    : { reasonCodes, state: "record_only" as const };
  const transactionId = deriveHouseStrategyTransactionId({
    factLogicalKey: input.transaction.fact.logicalKey,
    subscriptionId: input.transaction.projection.subscriptionId,
    workspaceId: input.transaction.projection.workspaceId,
  });
  const core = houseStrategyTransactionCoreSchema.parse({
    amountRange: transaction.amountRange,
    asset: {
      description: transaction.assetDescription,
      reportedTicker: transaction.reportedTicker,
    },
    catalogReferences: {
      committeeAssignments: catalogReference(input.catalogs.committeeAssignments),
      committeeJurisdictions: catalogReference(input.catalogs.committeeJurisdictions),
      member: catalogReference(input.catalogs.member),
      security: catalogReference(input.catalogs.security),
    },
    createdAt: input.observedAt,
    disclosedMember: filing.filer,
    disclosureLagDays,
    eligibility,
    filingDate: filing.filingDate,
    lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" },
    memberResolution: resolvedMember,
    notificationDate: transaction.notificationDate,
    observedAt: input.observedAt,
    owner: {
      disclosedCode: transaction.ownerCode,
      relationship: ownerRelationship(transaction.ownerCode),
    },
    packBinding: input.packBinding,
    policyReference: {
      policyDigest: input.policy.policyDigest,
      policyId: input.policy.policyId,
      policyVersion: input.policy.policyVersion,
    },
    processingMode: input.processingMode,
    recordType: "house_strategy_transaction",
    schemaVersion: 1,
    securityResolution: resolvedSecurity,
    source: {
      authority: input.transaction.fact.provenance.authority,
      factLogicalKey: input.transaction.fact.logicalKey,
      factRevisionId: input.transaction.fact.revisionId,
      filingFactRevisionId: input.filing.fact.revisionId,
      filingLogicalKey: input.filing.fact.logicalKey,
      projectionId: input.transaction.projection.projectionId,
      publicDocumentUrl: transaction.publicDocumentUrl,
      rowIdentity: transaction.rowIdentity,
      sourceInstanceId: input.transaction.fact.sourceInstanceId,
      subscriptionId: input.transaction.projection.subscriptionId,
    },
    transactionDate: transaction.transactionDate,
    transactionId,
    transactionType: transaction.transactionType,
    workspaceId: input.transaction.projection.workspaceId,
  });
  return houseStrategyTransactionSchema.parse({
    ...core,
    transactionRevisionId: deriveHouseStrategyTransactionRevisionId(core),
  });
}

export type CongressionalPolicy = Readonly<z.infer<typeof congressionalPolicySchema>>;
export type CongressionalReferenceCatalog = Readonly<z.infer<typeof congressionalReferenceCatalogSchema>>;
export type CongressionalFilingSignal = Readonly<z.infer<typeof congressionalFilingSignalSchema>>;
export type HouseStrategyTransaction = Readonly<z.infer<typeof houseStrategyTransactionSchema>>;
