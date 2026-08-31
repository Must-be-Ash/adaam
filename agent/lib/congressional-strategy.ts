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
  houseStrategyTransactionSchema,
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
import {
  evaluateCongressionalPatternBreak,
  type CongressionalCluster,
  type CongressionalCoverage,
  type CongressionalHistoryEntry,
  type CongressionalPatternResolution,
} from "./congressional-history";

type EvidenceReasonCode = (typeof CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES)[number];
type EvidenceState = "applied" | "not_applicable" | "unavailable";
type ReasonCode = (typeof CONGRESSIONAL_SIGNAL_REASON_CODES)[number];

export interface CongressionalTransactionEvaluation {
  readonly band: (typeof CONGRESSIONAL_SIGNAL_BANDS)[number];
  readonly committeeResolution: CongressionalCommitteeResolution;
  readonly clusterRevisionIds: readonly string[];
  readonly evidence: {
    reasonCode: EvidenceReasonCode;
    sourceRecordIds: string[];
    state: EvidenceState;
  }[];
  readonly reasonCodes: ReasonCode[];
  readonly patternResolution: CongressionalPatternResolution;
  readonly transactionRevisionId: string;
}

type CommitteeCatalog = Extract<CongressionalReferenceCatalog, {
  kind: "committee_assignments" | "committee_jurisdictions";
}>;

export interface CongressionalCommitteeResolution {
  readonly assignmentIds: string[];
  readonly committeeKeys: string[];
  readonly jurisdictionIds: string[];
  readonly state: "ambiguous" | "no" | "stale" | "unknown" | "yes";
}

function dateIsEffective(date: string, from: string, through: string | null): boolean {
  return from <= date && (through === null || through >= date);
}

function catalogAgeDays(reviewedAt: string, observedAt: string): number {
  return (
    Date.parse(`${observedAt.slice(0, 10)}T00:00:00.000Z`) -
    Date.parse(`${reviewedAt}T00:00:00.000Z`)
  ) / 86_400_000;
}

function committeeCatalogRevisionId(catalog: CommitteeCatalog): string {
  return `${catalog.catalogId}.${catalog.catalogVersion}.${catalog.catalogDigest}`;
}

export function resolveCongressionalCommitteeRelevance(input: {
  readonly assignments: Extract<CommitteeCatalog, { kind: "committee_assignments" }>;
  readonly industryId: string | null;
  readonly jurisdictions: Extract<CommitteeCatalog, { kind: "committee_jurisdictions" }>;
  readonly maximumCatalogAgeDays: number;
  readonly memberBioguideId: string | null;
  readonly observedAt: string;
  readonly transactionDate: string | null;
}): CongressionalCommitteeResolution {
  const assignmentCatalogRevisionId = committeeCatalogRevisionId(input.assignments);
  const jurisdictionCatalogRevisionId = committeeCatalogRevisionId(input.jurisdictions);
  const assignmentAge = catalogAgeDays(input.assignments.reviewedAt, input.observedAt);
  const jurisdictionAge = catalogAgeDays(input.jurisdictions.reviewedAt, input.observedAt);
  if (
    !Number.isFinite(assignmentAge) ||
    !Number.isFinite(jurisdictionAge) ||
    assignmentAge < 0 ||
    jurisdictionAge < 0 ||
    assignmentAge > input.maximumCatalogAgeDays ||
    jurisdictionAge > input.maximumCatalogAgeDays
  ) {
    return Object.freeze({
      assignmentIds: [assignmentCatalogRevisionId],
      committeeKeys: [],
      jurisdictionIds: [jurisdictionCatalogRevisionId],
      state: "stale",
    });
  }
  if (input.memberBioguideId === null || input.industryId === null || input.transactionDate === null) {
    return Object.freeze({
      assignmentIds: [assignmentCatalogRevisionId],
      committeeKeys: [],
      jurisdictionIds: [jurisdictionCatalogRevisionId],
      state: "unknown",
    });
  }
  const assignments = input.assignments.entries.filter((assignment) =>
    assignment.bioguideId === input.memberBioguideId &&
    dateIsEffective(input.transactionDate!, assignment.effectiveFrom, assignment.effectiveThrough)
  );
  const assignmentIds = assignments.map(({ assignmentId }) => assignmentId).sort();
  const committeeKeys = [...new Set(assignments.map((assignment) =>
    assignment.subcommitteeId ?? assignment.committeeId))].sort();
  const targets = assignments.map((assignment) =>
    `${assignment.committeeId}:${assignment.subcommitteeId ?? ""}`);
  if (new Set(targets).size !== targets.length) {
    return Object.freeze({ assignmentIds, committeeKeys, jurisdictionIds: [], state: "ambiguous" });
  }

  const matched = assignments.flatMap((assignment) => input.jurisdictions.entries.filter((rule) =>
    rule.committeeId === assignment.committeeId &&
    rule.subcommitteeId === assignment.subcommitteeId &&
    dateIsEffective(input.transactionDate!, rule.effectiveFrom, rule.effectiveThrough) &&
    (rule.industryId === input.industryId || rule.relevance === "broad")
  ).map((rule) => ({
    assignmentId: assignment.assignmentId,
    rule,
    target: `${assignment.committeeId}:${assignment.subcommitteeId ?? ""}`,
  })));
  let jurisdictionIds = matched.map(({ rule }) => rule.jurisdictionId).sort();
  for (const target of new Set(matched.map(({ target }) => target))) {
    const exactStates = new Set(matched
      .filter((match) => match.target === target && match.rule.industryId === input.industryId)
      .map(({ rule }) => rule.relevance));
    if (exactStates.size > 1) {
      return Object.freeze({ assignmentIds, committeeKeys, jurisdictionIds, state: "ambiguous" });
    }
  }
  const exact = matched.filter(({ rule }) => rule.industryId === input.industryId);
  const supportingAssignmentIds = exact.length > 0
    ? [...new Set(exact.map(({ assignmentId }) => assignmentId))].sort()
    : assignmentIds;
  if (exact.length > 0) {
    jurisdictionIds = exact.map(({ rule }) => rule.jurisdictionId).sort();
  }
  const state = exact.some(({ rule }) => rule.relevance === "yes")
    ? "yes" as const
    : exact.some(({ rule }) => rule.relevance === "no")
      ? "no" as const
      : "unknown" as const;
  return Object.freeze({ assignmentIds: supportingAssignmentIds, committeeKeys, jurisdictionIds, state });
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
  catalogs: {
    readonly committeeAssignments: Extract<CongressionalReferenceCatalog, { kind: "committee_assignments" }>;
    readonly committeeJurisdictions: Extract<CongressionalReferenceCatalog, { kind: "committee_jurisdictions" }>;
  },
  history?: {
    readonly clusters: readonly CongressionalCluster[];
    readonly coverage: CongressionalCoverage;
    readonly priorEntries: readonly CongressionalHistoryEntry[];
  },
): CongressionalTransactionEvaluation {
  const eligible = transaction.eligibility.state === "eligible";
  const timely = eligible && transaction.disclosureLagDays !== null &&
    transaction.disclosureLagDays <= policy.timelyMaximumLagDays;
  const material = eligible && lowerBoundIsMaterial(
    transaction.amountRange.lower,
    policy.materialLowerBound,
  );
  const committeeResolution = policy.policyVersion !== "1.0.0"
    ? resolveCongressionalCommitteeRelevance({
        assignments: catalogs.committeeAssignments,
        industryId: transaction.securityResolution.industryId,
        jurisdictions: catalogs.committeeJurisdictions,
        maximumCatalogAgeDays: policy.catalogMaximumAgeDays!,
        memberBioguideId: transaction.memberResolution.bioguideId,
        observedAt: transaction.observedAt,
        transactionDate: transaction.transactionDate,
      })
    : Object.freeze({ assignmentIds: [], committeeKeys: [], jurisdictionIds: [], state: "unknown" as const });
  const committeeRelevant = eligible && committeeResolution.state === "yes";
  const patternResolution = policy.policyVersion === "1.2.0" && history
    ? evaluateCongressionalPatternBreak({
        coverage: history.coverage,
        current: transaction,
        minimumPriorTransactions: policy.historyMinimumTransactions!,
        priorEntries: history.priorEntries,
      })
    : Object.freeze({ priorTransactionRevisionIds: [], ruleCodes: [], state: "unavailable" as const });
  const matchingClusters = history?.clusters.filter(({ factLogicalKeys }) =>
    factLogicalKeys.includes(transaction.source.factLogicalKey)).slice(0, 64) ?? [];
  const sameMemberCluster = eligible && matchingClusters.some(({ kind }) => kind === "same_member");
  const committeeCluster = eligible && matchingClusters.some(({ kind }) => kind === "committee");
  const patternBreak = eligible && patternResolution.state === "yes";
  const evidence = CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES.map((reasonCode) => {
    let state: EvidenceState;
    if (!eligible) state = "not_applicable";
    else if (reasonCode === "timely") state = timely ? "applied" : "not_applicable";
    else if (reasonCode === "material_range") state = material ? "applied" : "not_applicable";
    else if (reasonCode === "committee_relevant") {
      state = committeeRelevant
        ? "applied"
        : committeeResolution.state === "no"
          ? "not_applicable"
          : "unavailable";
    }
    else if (reasonCode === "pattern_break") {
      state = patternBreak
        ? "applied"
        : patternResolution.state === "no"
          ? "not_applicable"
          : "unavailable";
    }
    else if (reasonCode === "same_member_cluster") {
      state = policy.policyVersion === "1.2.0"
        ? sameMemberCluster ? "applied" : "not_applicable"
        : "unavailable";
    }
    else if (reasonCode === "committee_cluster") {
      state = policy.policyVersion === "1.2.0"
        ? committeeCluster ? "applied" : "not_applicable"
        : "unavailable";
    }
    else state = "unavailable";
    const sourceRecordIds = reasonCode === "committee_relevant"
      ? [...committeeResolution.assignmentIds, ...committeeResolution.jurisdictionIds].sort()
      : reasonCode === "pattern_break"
        ? patternResolution.priorTransactionRevisionIds.length > 0
          ? [...patternResolution.priorTransactionRevisionIds]
          : [transaction.transactionRevisionId]
        : reasonCode === "same_member_cluster" || reasonCode === "committee_cluster"
          ? matchingClusters.filter(({ kind }) => kind === (
              reasonCode === "same_member_cluster" ? "same_member" : "committee"
            )).map(({ clusterRevisionId }) => clusterRevisionId).sort()
          : [transaction.transactionRevisionId];
    return Object.freeze({ reasonCode, sourceRecordIds, state });
  });
  const band = !eligible
    ? "record_only" as const
    : committeeCluster ||
      (committeeRelevant && (material || patternBreak || sameMemberCluster)) ||
      (timely && material)
      ? "priority" as const
      : timely || material || committeeRelevant || patternBreak || sameMemberCluster
        ? "review" as const
        : "record_only" as const;
  const reasonCodes = [...new Set([
    ...transaction.eligibility.reasonCodes,
    ...evidence.filter(({ state }) => state === "applied").map(({ reasonCode }) => reasonCode),
  ])].sort();
  return Object.freeze({
    band,
    committeeResolution,
    clusterRevisionIds: Object.freeze(matchingClusters.map(({ clusterRevisionId }) =>
      clusterRevisionId).sort()),
    evidence,
    reasonCodes,
    patternResolution,
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

export function congressionalFindingForSignal(input: {
  evaluations: readonly CongressionalTransactionEvaluation[];
  signal: CongressionalFilingSignal;
  transactions: readonly HouseStrategyTransaction[];
}): { finding: WorkspaceFindingCandidate; presentation: { title: string; whyMatched: string } } {
  const resolvedMember = input.transactions.find(({ memberResolution }) =>
    memberResolution.bioguideId !== null)?.memberResolution.bioguideId;
  if (!resolvedMember) throw new Error("congressional_member_unresolved");
  const disclosedMember = input.transactions[0]!.disclosedMember;
  const disclosedName = `${disclosedMember.firstName} ${disclosedMember.lastName}`
    .replace(/\s+/gu, " ")
    .trim();
  const publicDocumentUrl = input.transactions[0]!.source.publicDocumentUrl;
  const fact = {
    band: input.signal.band,
    delayedDisclosureCaveat: CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
    filingDate: input.transactions[0]!.filingDate,
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
    transactions: input.transactions.slice(0, 3).flatMap((transaction, index) => {
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

export interface CongressionalFilingEvaluationInput {
  readonly catalogs: {
    readonly committeeAssignments: Extract<CongressionalReferenceCatalog, { kind: "committee_assignments" }>;
    readonly committeeJurisdictions: Extract<CongressionalReferenceCatalog, { kind: "committee_jurisdictions" }>;
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
  readonly normalizedTransactions?: readonly HouseStrategyTransaction[];
  readonly history?: {
    readonly clusters: readonly CongressionalCluster[];
    readonly coverage: CongressionalCoverage;
    readonly lineageEntries?: readonly CongressionalHistoryEntry[];
    readonly priorEntries: readonly CongressionalHistoryEntry[];
  };
}

export function normalizeCongressionalFilingTransactions(
  input: Omit<CongressionalFilingEvaluationInput, "history" | "normalizedTransactions">,
): readonly HouseStrategyTransaction[] {
  if (input.filing.fact.payload.schemaVersion !== "house-ptr-filing/v1" || input.transactions.length === 0) {
    throw new Error("congressional_filing_invalid");
  }
  if (
    input.catalogs.committeeAssignments.kind !== "committee_assignments" ||
    input.catalogs.committeeJurisdictions.kind !== "committee_jurisdictions"
  ) {
    throw new Error("congressional_catalog_invalid");
  }
  return Object.freeze(input.transactions.map((transaction) =>
    normalizeProjectedHouseTransaction({
      catalogs: input.catalogs,
      filing: input.filing,
      observedAt: input.observedAt,
      packBinding: input.packBinding,
      policy: input.policy,
      processingMode: input.processingMode,
      selectedMemberBioguideIds: input.selectedMemberBioguideIds,
      transaction,
    })).sort((left, right) => left.transactionRevisionId.localeCompare(right.transactionRevisionId)));
}

export function evaluateCongressionalFiling(
  input: CongressionalFilingEvaluationInput,
): CongressionalFilingEvaluation {
  if (input.filing.fact.payload.schemaVersion !== "house-ptr-filing/v1" || input.transactions.length === 0) {
    throw new Error("congressional_filing_invalid");
  }
  if (
    input.catalogs.committeeAssignments.kind !== "committee_assignments" ||
    input.catalogs.committeeJurisdictions.kind !== "committee_jurisdictions"
  ) {
    throw new Error("congressional_catalog_invalid");
  }
  const transactions = input.normalizedTransactions === undefined
    ? normalizeCongressionalFilingTransactions(input)
    : [...input.normalizedTransactions].map((transaction) =>
        houseStrategyTransactionSchema.parse(transaction))
      .sort((left, right) => left.transactionRevisionId.localeCompare(right.transactionRevisionId));
  const evaluations = transactions.map((transaction) =>
    evaluateCongressionalTransaction(transaction, input.policy, {
      committeeAssignments: input.catalogs.committeeAssignments,
      committeeJurisdictions: input.catalogs.committeeJurisdictions,
    }, input.history));
  const band = highestBand(evaluations);
  const signalId = deriveCongressionalSignalId({
    filingLogicalKey: input.filing.fact.logicalKey,
    packBinding: input.packBinding,
    workspaceId: input.filing.projection.workspaceId,
  });
  const reasonTrace = evaluations.flatMap((evaluation) => [
    ...evaluation.reasonCodes.filter((reasonCode) =>
      !CONGRESSIONAL_SIGNAL_EVIDENCE_REASON_CODES.includes(reasonCode as EvidenceReasonCode)
    ).map((reasonCode) => ({
      reasonCode,
      sourceRevisionId: evaluation.transactionRevisionId,
      state: "applied" as const,
    })),
    ...evaluation.evidence.map(({ reasonCode, sourceRecordIds, state }) => ({
      reasonCode,
      sourceRevisionId: sourceRecordIds[0] ?? evaluation.transactionRevisionId,
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
    lineage: (() => {
      const corrected = transactions.find(({ lineage }) => lineage.correctionId !== null);
      if (!corrected) return { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" as const };
      const priorRevisionId = [
        ...(input.history?.priorEntries ?? []),
        ...(input.history?.lineageEntries ?? []),
      ].find(({ transaction }) =>
        transaction.transactionId === corrected.transactionId)?.signalRevisionId ?? null;
      return {
        correctionId: corrected.lineage.correctionId,
        priorRevisionId,
        retractionId: null,
        state: "active" as const,
      };
    })(),
    packBinding: input.packBinding,
    policyReference: transactions[0]!.policyReference,
    reasonTrace,
    recordType: "congressional_filing_signal" as const,
    schemaVersion: 1 as const,
    signalId,
    transactionEvaluations: evaluations.map((evaluation) => {
      if (input.policy.policyVersion !== "1.2.0") {
        const {
          clusterRevisionIds: _clusterRevisionIds,
          patternResolution: _patternResolution,
          ...legacyEvaluation
        } = evaluation;
        const {
          committeeKeys: _committeeKeys,
          ...legacyCommitteeResolution
        } = legacyEvaluation.committeeResolution;
        return { ...legacyEvaluation, committeeResolution: legacyCommitteeResolution };
      }
      return {
        ...evaluation,
        clusterRevisionIds: [...evaluation.clusterRevisionIds],
        patternResolution: {
          ...evaluation.patternResolution,
          priorTransactionRevisionIds: [...evaluation.patternResolution.priorTransactionRevisionIds],
          ruleCodes: [...evaluation.patternResolution.ruleCodes],
        },
      };
    }),
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
  const alert = congressionalFindingForSignal({ evaluations, signal, transactions });
  return Object.freeze({
    alertPresentation: Object.freeze(alert.presentation),
    filing: input.filing,
    finding: Object.freeze(alert.finding),
    signal,
    transactions: Object.freeze(transactions),
  });
}
