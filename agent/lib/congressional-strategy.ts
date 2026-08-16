import type { WorkspaceFindingCandidate } from "./workspace-finding-store";
import type { AuthorizedPublicSourceProjection } from "./public-source-subscription-store";
import {
  CONGRESSIONAL_SIGNAL_BANDS,
  CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES,
  CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
  CONGRESSIONAL_SIGNAL_REASON_CODES,
  congressionalFilingSignalSchema,
  deriveCongressionalSignalId,
  deriveCongressionalSignalRevisionId,
  normalizeProjectedHouseTransaction,
  type CongressionalFilingSignal,
  type CongressionalPolicy,
  type CongressionalReferenceCatalog,
  type HouseStrategyTransaction,
} from "./congressional-signal-schema";
import {
  HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "./strategy-pack-reference-catalog";

type EvidenceReasonCode = (typeof CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES)[number];
type EvidenceState = "applied" | "not_applicable" | "unavailable";
type ReasonCode = (typeof CONGRESSIONAL_SIGNAL_REASON_CODES)[number];

export interface CongressionalTransactionEvaluation {
  readonly band: (typeof CONGRESSIONAL_SIGNAL_BANDS)[number];
  readonly evidence: {
    reasonCode: EvidenceReasonCode;
    state: EvidenceState;
  }[];
  readonly reasonCodes: ReasonCode[];
  readonly transactionRevisionId: string;
}

export interface CongressionalFilingEvaluation {
  readonly alertPresentation: { readonly title: string; readonly whyMatched: string } | null;
  readonly filing: AuthorizedPublicSourceProjection;
  readonly finding: WorkspaceFindingCandidate | null;
  readonly signal: CongressionalFilingSignal;
  readonly transactions: readonly HouseStrategyTransaction[];
}

function lowerBoundIsMaterial(value: string | null, threshold: string): boolean {
  return value !== null && BigInt(value) >= BigInt(threshold);
}

export function evaluateCongressionalTransaction(
  transaction: HouseStrategyTransaction,
  policy: CongressionalPolicy,
): CongressionalTransactionEvaluation {
  const eligible = transaction.eligibility.state === "eligible";
  const timely = eligible && transaction.disclosureLagDays !== null &&
    transaction.disclosureLagDays <= policy.timelyMaximumLagDays;
  const material = eligible && lowerBoundIsMaterial(
    transaction.amountRange.lower,
    policy.materialLowerBound,
  );
  const evidence = CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES.map((reasonCode) => {
    let state: EvidenceState;
    if (!eligible) state = "not_applicable";
    else if (reasonCode === "timely") state = timely ? "applied" : "not_applicable";
    else if (reasonCode === "material_range") state = material ? "applied" : "not_applicable";
    else state = "unavailable";
    return Object.freeze({ reasonCode, state });
  });
  const band = !eligible
    ? "record_only" as const
    : timely && material
      ? "priority" as const
      : timely || material
        ? "review" as const
        : "record_only" as const;
  const reasonCodes = [...new Set([
    ...transaction.eligibility.reasonCodes,
    ...evidence.filter(({ state }) => state === "applied").map(({ reasonCode }) => reasonCode),
  ])].sort();
  return Object.freeze({
    band,
    evidence,
    reasonCodes,
    transactionRevisionId: transaction.transactionRevisionId,
  });
}

function highestBand(evaluations: readonly CongressionalTransactionEvaluation[]) {
  const rank = new Map(CONGRESSIONAL_SIGNAL_BANDS.map((band, index) => [band, index]));
  return evaluations.reduce(
    (highest, evaluation) =>
      rank.get(evaluation.band)! > rank.get(highest)! ? evaluation.band : highest,
    "record_only" as (typeof CONGRESSIONAL_SIGNAL_BANDS)[number],
  );
}

function thresholdAllows(
  band: (typeof CONGRESSIONAL_SIGNAL_BANDS)[number],
  threshold: "priority" | "review",
): boolean {
  return band === "priority" || (threshold === "review" && band === "review");
}

function transactionDescription(
  transaction: HouseStrategyTransaction,
  evaluation: CongressionalTransactionEvaluation,
): string {
  const direction = transaction.transactionType === "P" ? "purchase" : "sale";
  return [
    `${transaction.asset.description ?? "Unresolved asset"} — ${direction}`,
    transaction.amountRange.label,
    `transaction ${transaction.transactionDate ?? "unknown"}`,
    `filed ${transaction.filingDate}`,
    `lag ${transaction.disclosureLagDays ?? "unknown"} days`,
    `owner ${transaction.owner.relationship}`,
    `band ${evaluation.band}`,
  ].join(", ");
}

function findingForSignal(input: {
  evaluations: readonly CongressionalTransactionEvaluation[];
  filing: AuthorizedPublicSourceProjection;
  signal: CongressionalFilingSignal;
  transactions: readonly HouseStrategyTransaction[];
}): { finding: WorkspaceFindingCandidate; presentation: { title: string; whyMatched: string } } {
  const filing = input.filing.fact.payload;
  if (filing.schemaVersion !== "house-ptr-filing/v1") throw new Error("congressional_filing_invalid");
  const resolvedMember = input.transactions.find(({ memberResolution }) =>
    memberResolution.bioguideId !== null)?.memberResolution.bioguideId;
  if (!resolvedMember) throw new Error("congressional_member_unresolved");
  const disclosedName = `${filing.filer.firstName} ${filing.filer.lastName}`
    .replace(/\s+/gu, " ")
    .trim();
  const publicDocumentUrl = input.transactions[0]!.source.publicDocumentUrl;
  const fact = {
    band: input.signal.band,
    delayedDisclosureCaveat: CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
    filingDate: filing.filingDate,
    filingIdentity: input.signal.signalRevisionId,
    kind: "congressional_filing_signal" as const,
    member: { bioguideId: resolvedMember, disclosedName },
    observedAt: input.signal.createdAt,
    publicDocumentUrl,
    schemaVersion: 1 as const,
    signalId: input.signal.signalId,
    signalRevisionId: input.signal.signalRevisionId,
    source: {
      accessClassification: "public" as const,
      canonicalUrl: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL as typeof HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
      origin: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID as typeof HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    },
    transactions: input.transactions.slice(0, 50).flatMap((transaction, index) => {
      if (transaction.transactionDate === null ||
        (transaction.transactionType !== "P" && transaction.transactionType !== "S") ||
        transaction.asset.description === null) return [];
      return [{
        amountRange: transaction.amountRange,
        assetDescription: transaction.asset.description,
        band: input.evaluations[index]!.band,
        disclosureLagDays: transaction.disclosureLagDays,
        ownerRelationship: transaction.owner.relationship,
        reasonCodes: input.evaluations[index]!.reasonCodes,
        transactionDate: transaction.transactionDate,
        transactionType: transaction.transactionType,
      }];
    }),
  };
  const summary = `${disclosedName}'s House PTR produced one ${input.signal.band} filing signal from ${input.transactions.length} disclosed transaction${input.transactions.length === 1 ? "" : "s"}; this delayed public disclosure is not evidence of wrongdoing or a trade instruction.`;
  const whyMatched = [
    `Band: ${input.signal.band}.`,
    ...input.transactions.slice(0, 3).map((transaction, index) =>
      transactionDescription(transaction, input.evaluations[index]!)),
    fact.delayedDisclosureCaveat,
  ].join(" ").slice(0, 1_000);
  return {
    finding: {
      accessClassification: "public",
      artifactRefs: [],
      asOf: input.signal.createdAt,
      factIdentities: [input.signal.signalRevisionId],
      facts: [fact],
      provenance: [{
        accessClassification: "public",
        canonicalUrl: publicDocumentUrl,
        origin: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
        sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      }],
      summary,
    },
    presentation: {
      title: `Congressional Signals · ${input.signal.band}`,
      whyMatched,
    },
  };
}

export function evaluateCongressionalFiling(input: {
  readonly catalogs: {
    readonly member: CongressionalReferenceCatalog;
    readonly security: CongressionalReferenceCatalog;
  };
  readonly filing: AuthorizedPublicSourceProjection;
  readonly minimumAlertBand: "priority" | "review";
  readonly observedAt: string;
  readonly packBinding: HouseStrategyTransaction["packBinding"];
  readonly policy: CongressionalPolicy;
  readonly processingMode: "baseline" | "live";
  readonly selectedMemberBioguideIds: readonly string[];
  readonly transactions: readonly AuthorizedPublicSourceProjection[];
}): CongressionalFilingEvaluation {
  if (input.filing.fact.payload.schemaVersion !== "house-ptr-filing/v1" || input.transactions.length === 0) {
    throw new Error("congressional_filing_invalid");
  }
  const transactions = input.transactions.map((transaction) =>
    normalizeProjectedHouseTransaction({
      catalogs: input.catalogs,
      filing: input.filing,
      observedAt: input.observedAt,
      packBinding: input.packBinding,
      policy: input.policy,
      processingMode: input.processingMode,
      selectedMemberBioguideIds: input.selectedMemberBioguideIds,
      transaction,
    })).sort((left, right) => left.transactionRevisionId.localeCompare(right.transactionRevisionId));
  const evaluations = transactions.map((transaction) =>
    evaluateCongressionalTransaction(transaction, input.policy));
  const band = highestBand(evaluations);
  const signalId = deriveCongressionalSignalId({
    filingLogicalKey: input.filing.fact.logicalKey,
    packBinding: input.packBinding,
    workspaceId: input.filing.projection.workspaceId,
  });
  const reasonTrace = evaluations.flatMap((evaluation) => [
    ...evaluation.reasonCodes.map((reasonCode) => ({
      reasonCode,
      sourceRevisionId: evaluation.transactionRevisionId,
      state: "applied" as const,
    })),
    ...evaluation.evidence
      .filter(({ reasonCode }) => !evaluation.reasonCodes.includes(reasonCode))
      .map(({ reasonCode, state }) => ({
        reasonCode,
        sourceRevisionId: evaluation.transactionRevisionId,
        state,
      })),
  ]);
  const alertEligible = input.processingMode === "live" &&
    thresholdAllows(band, input.minimumAlertBand);
  const core = {
    alertEligible,
    band,
    catalogReferences: transactions[0]!.catalogReferences,
    createdAt: input.observedAt,
    filingLogicalKey: input.filing.fact.logicalKey,
    lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" as const },
    packBinding: input.packBinding,
    policyReference: transactions[0]!.policyReference,
    reasonTrace,
    recordType: "congressional_filing_signal" as const,
    schemaVersion: 1 as const,
    signalId,
    transactionEvaluations: evaluations,
    transactionRevisionIds: transactions.map(({ transactionRevisionId }) => transactionRevisionId),
    workspaceId: input.filing.projection.workspaceId,
  };
  const signal = congressionalFilingSignalSchema.parse({
    ...core,
    signalRevisionId: deriveCongressionalSignalRevisionId(core),
  });
  if (!alertEligible) {
    return Object.freeze({
      alertPresentation: null,
      filing: input.filing,
      finding: null,
      signal,
      transactions: Object.freeze(transactions),
    });
  }
  const alert = findingForSignal({ evaluations, filing: input.filing, signal, transactions });
  return Object.freeze({
    alertPresentation: Object.freeze(alert.presentation),
    filing: input.filing,
    finding: Object.freeze(alert.finding),
    signal,
    transactions: Object.freeze(transactions),
  });
}
