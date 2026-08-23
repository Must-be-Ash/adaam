import { z } from "zod";

import {
  congressionalSignalContractDigest,
  congressionalFilingSignalSchema,
  deriveCongressionalSignalRevisionId,
  deriveHouseStrategyTransactionRevisionId,
  houseStrategyTransactionSchema,
  type HouseStrategyTransaction,
  type CongressionalFilingSignal,
} from "./congressional-signal-schema";

const DAY_MS = 86_400_000;

export interface CongressionalCoverage {
  readonly consecutiveDays: number;
  readonly lastCompleteOn: string;
  readonly startedOn: string;
  readonly state: "complete" | "incomplete";
}

export interface CongressionalHistoryEntry {
  readonly alertEligible: boolean;
  readonly band: "priority" | "record_only" | "review";
  readonly committeeKeys: readonly string[];
  readonly party: "Democratic" | "Independent" | "Republican";
  readonly signalRevisionId: string;
  readonly transaction: HouseStrategyTransaction;
}

export interface CongressionalClusterCandidate {
  readonly committeeKeys: readonly string[];
  readonly party: CongressionalHistoryEntry["party"];
  readonly transaction: HouseStrategyTransaction;
}

export interface CongressionalCluster {
  readonly clusterId: string;
  readonly clusterRevisionId: string;
  readonly descriptiveParties: readonly CongressionalHistoryEntry["party"][];
  readonly direction: "P" | "S";
  readonly evidenceStrength: "qualifying";
  readonly factLogicalKeys: readonly string[];
  readonly industryId: string;
  readonly kind: "committee" | "same_member";
  readonly memberBioguideIds: readonly string[];
  readonly securityId: string | null;
  readonly sharedCommitteeKey: string | null;
  readonly transactionRevisionIds: readonly string[];
  readonly windowEnd: string;
  readonly windowStart: string;
  readonly workspaceId: string;
}

export interface CongressionalRetractionInput {
  readonly fromRevisionId: string;
  readonly logicalKey: string;
  readonly retractionId: string;
}

const identifierSchema = z.string().trim().min(2).max(240);
const dateSchema = z.string().date();
const timestampSchema = z.string().datetime({ offset: true });

export const congressionalCoverageSchema = z.object({
  consecutiveDays: z.number().int().min(0).max(10_000),
  lastCompleteOn: dateSchema,
  startedOn: dateSchema,
  state: z.enum(["complete", "incomplete"]),
}).strict();

export const congressionalClusterSchema = z.object({
  clusterId: identifierSchema,
  clusterRevisionId: identifierSchema,
  descriptiveParties: z.array(z.enum(["Democratic", "Independent", "Republican"])).max(3),
  direction: z.enum(["P", "S"]),
  evidenceStrength: z.literal("qualifying"),
  factLogicalKeys: z.array(identifierSchema).min(3).max(500),
  industryId: identifierSchema,
  kind: z.enum(["committee", "same_member"]),
  memberBioguideIds: z.array(z.string().regex(/^[A-Z]\d{6}$/u)).min(1).max(500),
  securityId: identifierSchema.nullable(),
  sharedCommitteeKey: identifierSchema.nullable(),
  transactionRevisionIds: z.array(identifierSchema).min(3).max(500),
  windowEnd: dateSchema,
  windowStart: dateSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((cluster, context) => {
  const { clusterRevisionId, ...core } = cluster;
  if (
    clusterRevisionId !== `congressional-cluster-revision.${congressionalSignalContractDigest(core)}` ||
    cluster.clusterId !== `congressional-cluster.${congressionalSignalContractDigest([
      cluster.workspaceId,
      cluster.kind,
      cluster.sharedCommitteeKey,
      cluster.securityId,
      cluster.industryId,
      cluster.direction,
      cluster.factLogicalKeys,
    ])}` ||
    JSON.stringify(cluster.factLogicalKeys) !== JSON.stringify(sortedUnique(cluster.factLogicalKeys)) ||
    JSON.stringify(cluster.memberBioguideIds) !== JSON.stringify(sortedUnique(cluster.memberBioguideIds)) ||
    JSON.stringify(cluster.transactionRevisionIds) !== JSON.stringify(sortedUnique(cluster.transactionRevisionIds)) ||
    JSON.stringify(cluster.descriptiveParties) !== JSON.stringify(sortedUnique(cluster.descriptiveParties)) ||
    (cluster.kind === "committee") !== (cluster.sharedCommitteeKey !== null) ||
    (cluster.kind === "committee" && cluster.memberBioguideIds.length < 3)
  ) context.addIssue({ code: "custom", message: "congressional_cluster_invalid" });
});

const congressionalHistoryEntrySchema = z.object({
  alertEligible: z.boolean(),
  band: z.enum(["priority", "record_only", "review"]),
  committeeKeys: z.array(identifierSchema).max(32),
  party: z.enum(["Democratic", "Independent", "Republican"]),
  signalRevisionId: identifierSchema,
  transaction: houseStrategyTransactionSchema,
}).strict();

const congressionalHistoryRevisionCoreSchema = z.object({
  activeEntries: z.array(congressionalHistoryEntrySchema).max(500),
  clusters: z.array(congressionalClusterSchema).max(500),
  correctionAlertKeys: z.array(identifierSchema).max(500),
  coverage: congressionalCoverageSchema,
  createdAt: timestampSchema,
  recordType: z.literal("congressional_history_revision"),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

export function deriveCongressionalHistoryRevisionId(
  core: z.input<typeof congressionalHistoryRevisionCoreSchema>,
): string {
  return `congressional-history-revision.${congressionalSignalContractDigest(core)}`;
}

export const congressionalHistoryRevisionSchema = congressionalHistoryRevisionCoreSchema.extend({
  historyRevisionId: identifierSchema,
}).strict().superRefine((history, context) => {
  const { historyRevisionId, ...core } = history;
  if (
    historyRevisionId !== deriveCongressionalHistoryRevisionId(core) ||
    JSON.stringify(history.correctionAlertKeys) !== JSON.stringify(sortedUnique(history.correctionAlertKeys)) ||
    JSON.stringify(history.activeEntries.map(({ transaction }) => transaction.transactionId)) !==
      JSON.stringify(sortedUnique(history.activeEntries.map(({ transaction }) => transaction.transactionId))) ||
    JSON.stringify(history.clusters.map(({ clusterRevisionId }) => clusterRevisionId)) !==
      JSON.stringify(sortedUnique(history.clusters.map(({ clusterRevisionId }) => clusterRevisionId))
      )
  ) context.addIssue({ code: "custom", message: "congressional_history_invalid" });
});

export type CongressionalHistoryRevision = Readonly<z.infer<typeof congressionalHistoryRevisionSchema>>;

export function createCongressionalHistoryRevision(
  input: z.input<typeof congressionalHistoryRevisionCoreSchema>,
): CongressionalHistoryRevision {
  const core = congressionalHistoryRevisionCoreSchema.parse(input);
  return congressionalHistoryRevisionSchema.parse({
    ...core,
    historyRevisionId: deriveCongressionalHistoryRevisionId(core),
  });
}

function calendarDay(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`) / DAY_MS;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function advanceCongressionalCoverage(
  prior: CongressionalCoverage | null,
  input: {
    readonly maximumGapDays: number;
    readonly observedOn: string;
    readonly requiredDays?: number;
    readonly sourceComplete: boolean;
  },
): CongressionalCoverage {
  const observedDay = calendarDay(input.observedOn);
  if (!Number.isInteger(observedDay) || !input.sourceComplete) {
    return Object.freeze({
      consecutiveDays: 0,
      lastCompleteOn: input.observedOn,
      startedOn: input.observedOn,
      state: "incomplete" as const,
    });
  }
  const priorDay = prior === null ? null : calendarDay(prior.lastCompleteOn);
  if (prior !== null && priorDay === observedDay) return prior;
  const continues = prior !== null && prior.consecutiveDays > 0 && priorDay !== null && observedDay > priorDay &&
    observedDay - priorDay <= input.maximumGapDays;
  const startedOn = continues ? prior.startedOn : input.observedOn;
  const consecutiveDays = continues
    ? observedDay - calendarDay(startedOn) + 1
    : 1;
  return Object.freeze({
    consecutiveDays,
    lastCompleteOn: input.observedOn,
    startedOn,
    state: consecutiveDays >= (input.requiredDays ?? 90) ? "complete" as const : "incomplete" as const,
  });
}

export interface CongressionalPatternResolution {
  readonly priorTransactionRevisionIds: readonly string[];
  readonly ruleCodes: readonly ("amount_above_history" | "new_direction" | "new_industry")[];
  readonly state: "no" | "unavailable" | "yes";
}

export function evaluateCongressionalPatternBreak(input: {
  readonly coverage: CongressionalCoverage;
  readonly current: HouseStrategyTransaction;
  readonly minimumPriorTransactions: number;
  readonly priorEntries: readonly CongressionalHistoryEntry[];
}): CongressionalPatternResolution {
  const memberId = input.current.memberResolution.bioguideId;
  const currentDate = input.current.transactionDate;
  const prior = input.priorEntries
    .filter(({ transaction }) =>
      transaction.lineage.state === "active" &&
      transaction.eligibility.state === "eligible" &&
      transaction.memberResolution.bioguideId === memberId &&
      transaction.observedAt.slice(0, 10) >= input.coverage.startedOn &&
      transaction.transactionDate !== null &&
      (currentDate === null || transaction.transactionDate < currentDate))
    .sort((left, right) =>
      right.transaction.transactionDate!.localeCompare(left.transaction.transactionDate!) ||
      left.transaction.transactionRevisionId.localeCompare(right.transaction.transactionRevisionId));
  if (
    input.coverage.state !== "complete" ||
    memberId === null ||
    currentDate === null ||
    input.current.eligibility.state !== "eligible" ||
    prior.length < input.minimumPriorTransactions
  ) {
    return Object.freeze({ priorTransactionRevisionIds: [], ruleCodes: [], state: "unavailable" });
  }
  const ruleCodes: CongressionalPatternResolution["ruleCodes"][number][] = [];
  const currentLower = input.current.amountRange.lower;
  if (
    currentLower !== null &&
    prior.every(({ transaction }) =>
      transaction.amountRange.upper !== null && BigInt(currentLower) > BigInt(transaction.amountRange.upper))
  ) {
    ruleCodes.push("amount_above_history");
  }
  const currentIndustry = input.current.securityResolution.industryId;
  if (
    currentIndustry !== null &&
    prior.every(({ transaction }) => transaction.securityResolution.industryId !== currentIndustry)
  ) {
    ruleCodes.push("new_industry");
  }
  const currentDirection = input.current.transactionType;
  if (
    (currentDirection === "P" || currentDirection === "S") &&
    prior.slice(0, input.minimumPriorTransactions)
      .every(({ transaction }) => transaction.transactionType !== currentDirection)
  ) {
    ruleCodes.push("new_direction");
  }
  return Object.freeze({
    priorTransactionRevisionIds: Object.freeze(prior.map(({ transaction }) =>
      transaction.transactionRevisionId).sort()),
    ruleCodes: Object.freeze(ruleCodes),
    state: ruleCodes.length === 0 ? "no" as const : "yes" as const,
  });
}

type QualifyingCandidate = CongressionalClusterCandidate & {
  readonly date: string;
  readonly direction: "P" | "S";
  readonly industryId: string;
  readonly memberId: string;
};

function qualifyingCandidates(
  candidates: readonly CongressionalClusterCandidate[],
): QualifyingCandidate[] {
  const byFact = new Map<string, CongressionalClusterCandidate>();
  for (const candidate of candidates) {
    const current = byFact.get(candidate.transaction.source.factLogicalKey);
    if (
      !current ||
      current.transaction.observedAt < candidate.transaction.observedAt ||
      (current.transaction.observedAt === candidate.transaction.observedAt &&
        current.transaction.source.factRevisionId < candidate.transaction.source.factRevisionId)
    ) {
      byFact.set(candidate.transaction.source.factLogicalKey, candidate);
    }
  }
  return [...byFact.values()].flatMap((candidate) => {
    const transaction = candidate.transaction;
    const memberId = transaction.memberResolution.bioguideId;
    const industryId = transaction.securityResolution.industryId;
    const direction = transaction.transactionType;
    if (
      transaction.lineage.state !== "active" ||
      transaction.eligibility.state !== "eligible" ||
      transaction.transactionDate === null ||
      memberId === null ||
      industryId === null ||
      (direction !== "P" && direction !== "S")
    ) return [];
    return [{ ...candidate, date: transaction.transactionDate, direction, industryId, memberId }];
  }).sort((left, right) =>
    left.date.localeCompare(right.date) ||
    left.transaction.source.factLogicalKey.localeCompare(right.transaction.source.factLogicalKey));
}

function windows(candidates: readonly QualifyingCandidate[], windowDays: number): QualifyingCandidate[][] {
  const result: QualifyingCandidate[][] = [];
  let priorEnd = -1;
  for (let start = 0; start < candidates.length; start += 1) {
    let end = start;
    while (
      end + 1 < candidates.length &&
      calendarDay(candidates[end + 1]!.date) - calendarDay(candidates[start]!.date) <= windowDays
    ) end += 1;
    if (end > priorEnd) result.push(candidates.slice(start, end + 1));
    priorEnd = Math.max(priorEnd, end);
  }
  return result;
}

function clusterRecord(input: {
  readonly candidates: readonly QualifyingCandidate[];
  readonly industryId: string;
  readonly kind: CongressionalCluster["kind"];
  readonly securityId: string | null;
  readonly sharedCommitteeKey: string | null;
  readonly workspaceId: string;
}): CongressionalCluster {
  const factLogicalKeys = sortedUnique(input.candidates.map(({ transaction }) =>
    transaction.source.factLogicalKey));
  const memberBioguideIds = sortedUnique(input.candidates.map(({ memberId }) => memberId));
  const transactionRevisionIds = sortedUnique(input.candidates.map(({ transaction }) =>
    transaction.transactionRevisionId));
  const descriptiveParties = sortedUnique(input.candidates.map(({ party }) => party)) as
    CongressionalHistoryEntry["party"][];
  const windowStart = input.candidates[0]!.date;
  const windowEnd = input.candidates[input.candidates.length - 1]!.date;
  const direction = input.candidates[0]!.direction;
  const clusterId = `congressional-cluster.${congressionalSignalContractDigest([
    input.workspaceId,
    input.kind,
    input.sharedCommitteeKey,
    input.securityId,
    input.industryId,
    direction,
    factLogicalKeys,
  ])}`;
  const core = {
    clusterId,
    descriptiveParties,
    direction,
    evidenceStrength: "qualifying" as const,
    factLogicalKeys,
    industryId: input.industryId,
    kind: input.kind,
    memberBioguideIds,
    securityId: input.securityId,
    sharedCommitteeKey: input.sharedCommitteeKey,
    transactionRevisionIds,
    windowEnd,
    windowStart,
    workspaceId: input.workspaceId,
  };
  return Object.freeze({
    ...core,
    clusterRevisionId: `congressional-cluster-revision.${congressionalSignalContractDigest(core)}`,
  });
}

export function deriveCongressionalClusters(input: {
  readonly candidates: readonly CongressionalClusterCandidate[];
  readonly minimumFacts: number;
  readonly windowDays: number;
  readonly workspaceId: string;
}): readonly CongressionalCluster[] {
  const candidates = qualifyingCandidates(input.candidates);
  const derived = new Map<string, CongressionalCluster>();
  const sameMemberDerived = new Map<string, CongressionalCluster>();
  const sameMemberGroups = new Map<string, QualifyingCandidate[]>();
  for (const candidate of candidates) {
    const securityId = candidate.transaction.securityResolution.canonicalSecurityId;
    for (const mapping of [
      securityId === null ? null : `security:${securityId}`,
      `industry:${candidate.industryId}`,
    ]) {
      if (mapping === null) continue;
      const key = `${candidate.memberId}:${candidate.direction}:${mapping}`;
      sameMemberGroups.set(key, [...(sameMemberGroups.get(key) ?? []), candidate]);
    }
  }
  for (const [key, group] of sameMemberGroups) {
    for (const window of windows(group, input.windowDays)) {
      if (window.length < input.minimumFacts) continue;
      const mapping = key.split(":").slice(2).join(":");
      const cluster = clusterRecord({
        candidates: window,
        industryId: window[0]!.industryId,
        kind: "same_member",
        securityId: mapping.startsWith("security:") ? mapping.slice("security:".length) : null,
        sharedCommitteeKey: null,
        workspaceId: input.workspaceId,
      });
      const signature = JSON.stringify([
        cluster.direction,
        cluster.factLogicalKeys,
        cluster.memberBioguideIds,
      ]);
      const existing = sameMemberDerived.get(signature);
      if (!existing || (existing.securityId === null && cluster.securityId !== null)) {
        sameMemberDerived.set(signature, cluster);
      }
    }
  }
  for (const cluster of sameMemberDerived.values()) {
    derived.set(cluster.clusterRevisionId, cluster);
  }
  const committeeGroups = new Map<string, QualifyingCandidate[]>();
  for (const candidate of candidates) {
    for (const committeeKey of sortedUnique(candidate.committeeKeys)) {
      const key = `${committeeKey}\0${candidate.industryId}\0${candidate.direction}`;
      committeeGroups.set(key, [...(committeeGroups.get(key) ?? []), candidate]);
    }
  }
  for (const [key, group] of committeeGroups) {
    for (const window of windows(group, input.windowDays)) {
      const byMember = new Map<string, QualifyingCandidate>();
      for (const candidate of window) if (!byMember.has(candidate.memberId)) byMember.set(candidate.memberId, candidate);
      const distinctMembers = [...byMember.values()];
      if (distinctMembers.length < input.minimumFacts) continue;
      const [committeeKey] = key.split("\0");
      const cluster = clusterRecord({
        candidates: distinctMembers,
        industryId: distinctMembers[0]!.industryId,
        kind: "committee",
        securityId: null,
        sharedCommitteeKey: committeeKey!,
        workspaceId: input.workspaceId,
      });
      derived.set(cluster.clusterRevisionId, cluster);
    }
  }
  return Object.freeze([...derived.values()].sort((left, right) =>
    left.clusterRevisionId.localeCompare(right.clusterRevisionId)));
}

function revisedTransaction(
  transaction: HouseStrategyTransaction,
  changes: Partial<Pick<HouseStrategyTransaction, "createdAt" | "lineage" | "observedAt">>,
): HouseStrategyTransaction {
  const { transactionRevisionId: _priorRevisionId, ...priorCore } = transaction;
  const core = { ...priorCore, ...changes };
  return houseStrategyTransactionSchema.parse({
    ...core,
    transactionRevisionId: deriveHouseStrategyTransactionRevisionId(core),
  });
}

export function applyCongressionalHistoryChanges(input: {
  readonly currentTransactions: readonly HouseStrategyTransaction[];
  readonly observedAt: string;
  readonly priorEntries: readonly CongressionalHistoryEntry[];
  readonly retractions: readonly CongressionalRetractionInput[];
}): {
  readonly activeEntries: readonly CongressionalHistoryEntry[];
  readonly currentTransactions: readonly HouseStrategyTransaction[];
  readonly priorEntriesByTransactionId: ReadonlyMap<string, CongressionalHistoryEntry>;
  readonly retractedTransactions: readonly HouseStrategyTransaction[];
} {
  const active = new Map(input.priorEntries.map((entry) => [entry.transaction.transactionId, entry]));
  const priorEntriesByTransactionId = new Map<string, CongressionalHistoryEntry>();
  const currentTransactions: HouseStrategyTransaction[] = [];
  const retractedTransactions: HouseStrategyTransaction[] = [];
  for (const transaction of input.currentTransactions) {
    const prior = active.get(transaction.transactionId);
    if (
      prior?.transaction.source.factRevisionId === transaction.source.factRevisionId &&
      prior.transaction.source.filingFactRevisionId === transaction.source.filingFactRevisionId
    ) continue;
    if (prior) {
      priorEntriesByTransactionId.set(transaction.transactionId, prior);
      active.delete(transaction.transactionId);
      const correctionId = `congressional-correction.${congressionalSignalContractDigest([
        transaction.transactionId,
        prior.transaction.transactionRevisionId,
        transaction.transactionRevisionId,
      ])}`;
      currentTransactions.push(revisedTransaction(transaction, {
        lineage: {
          correctionId,
          priorRevisionId: prior.transaction.transactionRevisionId,
          retractionId: null,
          state: "active",
        },
      }));
    } else currentTransactions.push(transaction);
  }
  for (const retraction of input.retractions) {
    const prior = [...active.values()].find(({ transaction }) =>
      transaction.source.factLogicalKey === retraction.logicalKey &&
      transaction.source.factRevisionId === retraction.fromRevisionId);
    if (!prior) continue;
    active.delete(prior.transaction.transactionId);
    priorEntriesByTransactionId.set(prior.transaction.transactionId, prior);
    retractedTransactions.push(revisedTransaction(prior.transaction, {
      createdAt: input.observedAt,
      lineage: {
        correctionId: null,
        priorRevisionId: prior.transaction.transactionRevisionId,
        retractionId: retraction.retractionId,
        state: "retracted",
      },
      observedAt: input.observedAt,
    }));
  }
  return Object.freeze({
    activeEntries: Object.freeze([...active.values()].sort((left, right) =>
      left.transaction.transactionId.localeCompare(right.transaction.transactionId))),
    currentTransactions: Object.freeze(currentTransactions.sort((left, right) =>
      left.transactionRevisionId.localeCompare(right.transactionRevisionId))),
    priorEntriesByTransactionId,
    retractedTransactions: Object.freeze(retractedTransactions.sort((left, right) =>
      left.transactionRevisionId.localeCompare(right.transactionRevisionId))),
  });
}

export function shouldCreateCongressionalCorrectionAlert(input: {
  readonly currentBand: CongressionalHistoryEntry["band"];
  readonly currentTransaction: HouseStrategyTransaction;
  readonly priorEntry: CongressionalHistoryEntry;
}): boolean {
  if (!input.priorEntry.alertEligible) return false;
  const prior = input.priorEntry.transaction;
  const current = input.currentTransaction;
  return prior.memberResolution.bioguideId !== current.memberResolution.bioguideId ||
    prior.securityResolution.canonicalSecurityId !== current.securityResolution.canonicalSecurityId ||
    prior.transactionType !== current.transactionType ||
    prior.eligibility.state !== current.eligibility.state ||
    input.priorEntry.band !== input.currentBand ||
    current.lineage.state === "retracted";
}

export function createCongressionalRetractionSignal(input: {
  readonly observedAt: string;
  readonly priorSignal: CongressionalFilingSignal;
  readonly retractedTransaction: HouseStrategyTransaction;
}): CongressionalFilingSignal {
  const priorEvaluation = input.priorSignal.transactionEvaluations.find(({ transactionRevisionId }) =>
    transactionRevisionId === input.retractedTransaction.lineage.priorRevisionId);
  if (
    !priorEvaluation ||
    (input.priorSignal.packBinding.packVersion !== "1.2.0" &&
      input.priorSignal.packBinding.packVersion !== "1.3.0" &&
      input.priorSignal.packBinding.packVersion !== "1.4.0") ||
    input.retractedTransaction.lineage.retractionId === null
  ) {
    throw new Error("congressional_retraction_signal_invalid");
  }
  const transactionEvaluation = {
    ...priorEvaluation,
    band: "record_only" as const,
    clusterRevisionIds: [],
    evidence: priorEvaluation.evidence.map((evidence) => ({
      ...evidence,
      sourceRecordIds: [input.retractedTransaction.transactionRevisionId],
      state: "not_applicable" as const,
    })),
    patternResolution: {
      priorTransactionRevisionIds: [],
      ruleCodes: [],
      state: "unavailable" as const,
    },
    reasonCodes: ["superseded" as const],
    transactionRevisionId: input.retractedTransaction.transactionRevisionId,
  };
  const core = {
    ...input.priorSignal,
    alertEligible: false,
    band: "record_only" as const,
    createdAt: input.observedAt,
    lineage: {
      correctionId: null,
      priorRevisionId: input.priorSignal.signalRevisionId,
      retractionId: input.retractedTransaction.lineage.retractionId,
      state: "retracted" as const,
    },
    reasonTrace: [{
      reasonCode: "superseded" as const,
      sourceRevisionId: input.retractedTransaction.transactionRevisionId,
      state: "applied" as const,
    }],
    transactionEvaluations: [transactionEvaluation],
  };
  const { signalRevisionId: _priorRevisionId, ...coreWithoutRevision } = core;
  return congressionalFilingSignalSchema.parse({
    ...coreWithoutRevision,
    signalRevisionId: deriveCongressionalSignalRevisionId(coreWithoutRevision),
  });
}
