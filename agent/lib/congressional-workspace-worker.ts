import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_1,
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_2,
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2,
  CONGRESSIONAL_POLICY_V1,
  CONGRESSIONAL_POLICY_V1_1,
  CONGRESSIONAL_POLICY_V1_2,
  CONGRESSIONAL_SECURITY_CATALOG_V1,
  CONGRESSIONAL_SECURITY_CATALOG_V1_1,
} from "./congressional-reference-catalog";
import { congressionalSignalsExecutionEnabled } from "./congressional-signal-flags";
import { strategyPackCatalog } from "./strategy-pack-catalog";
import {
  persistCongressionalFilingEvaluation,
  persistCongressionalHistory,
  persistCongressionalSignalRecords,
  readCongressionalFilingSignal,
  readCongressionalHistory,
  type CongressionalSignalStoreClient,
} from "./congressional-signal-store";
import {
  congressionalFindingForSignal,
  evaluateCongressionalFiling,
  normalizeCongressionalFilingTransactions,
  resolveCongressionalCommitteeRelevance,
  type CongressionalFilingEvaluation,
  type CongressionalTransactionEvaluation,
} from "./congressional-strategy";
import type { CongressionalFilingSignal } from "./congressional-signal-schema";
import {
  advanceCongressionalCoverage,
  applyCongressionalHistoryChanges,
  createCongressionalHistoryRevision,
  createCongressionalRetractionSignal,
  deriveCongressionalClusters,
  shouldCreateCongressionalCorrectionAlert,
  type CongressionalClusterCandidate,
  type CongressionalHistoryEntry,
} from "./congressional-history";
import type { HousePublicSourceBinaryResponse } from "./house-public-source-adapter";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import { createEarningsCallSourceLifecycleStore, type EarningsCallSourceLifecycleStore } from "./earnings-call-source-lifecycle-store";
import { coordinatePublicSourceOccurrence, PublicSourceCoordinatorError } from "./public-source-coordinator";
import {
  acknowledgePublicSourceProjection,
  readAuthorizedPublicSourceProjection,
  type AuthorizedPublicSourceProjection,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "./strategy-pack-reference-catalog";
import {
  readWorkspaceRunOutcome,
  selectUnseenWorkspaceFindingIdentities,
  type WorkspaceFindingCandidate,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import {
  getWorkspaceMonitor,
  recordWorkspaceMonitorFailure,
  type WorkspaceMonitor,
} from "./workspace-monitor-store";
import {
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  readWorkspaceSourceCoverage,
  reserveWorkspaceSourceAttempt,
} from "./workspace-source-coverage";
import { readWorkspaceDocument } from "./workspace-state-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  finalizePriorWorkspaceRunOutcomeForControlPlane,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import type { CongressionalFilingSignalFact } from "./workspace-finding-facts";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";
import { fetchOfficialPublicSourceBytes } from "../tools/fetch_public_source";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];
type CongressionalPackVersion = "1.0.0" | "1.1.0" | "1.2.0" | "1.3.0" | "1.4.0";

const CONGRESSIONAL_PACK_VERSIONS = new Set<CongressionalPackVersion>([
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
]);

function congressionalRuntime(version: CongressionalPackVersion) {
  if (version === "1.0.0") return Object.freeze({
    evidenceContracts: Object.freeze([]),
    historyFeatures: false,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1,
    policy: CONGRESSIONAL_POLICY_V1,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1,
  });
  if (version === "1.1.0") return Object.freeze({
    evidenceContracts: CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_1,
    historyFeatures: false,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
    policy: CONGRESSIONAL_POLICY_V1_1,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1_1,
  });
  if (version === "1.2.0") return Object.freeze({
    evidenceContracts: CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_2,
    historyFeatures: true,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
    policy: CONGRESSIONAL_POLICY_V1_2,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1_1,
  });
  return Object.freeze({
    evidenceContracts: CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3,
    historyFeatures: true,
    member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2,
    policy: CONGRESSIONAL_POLICY_V1_2,
    security: CONGRESSIONAL_SECURITY_CATALOG_V1_1,
  });
}

export { CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";

export interface CongressionalWorkspaceWorkerClients extends WorkspaceWorkerControlPlaneClients {
  readonly hybridRecoveryExtensions?: Parameters<typeof coordinatePublicSourceOccurrence>[0]["hybridRecoveryExtensions"];
  readonly sourceLifecycle?: EarningsCallSourceLifecycleStore;
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly budget?: WorkspaceBudgetLedgerClient;
  readonly fetchDocument?: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly fetchIndex?: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly signal?: CongressionalSignalStoreClient;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
}

export interface CongressionalWorkspaceWorkerResult {
  readonly baselineEstablished: boolean;
  readonly checkpoint: { readonly contentDigest: string; readonly watermark: string };
  readonly filingCount: number;
  readonly outcome: WorkspaceRunOutcome;
  readonly replayed: boolean;
  readonly signalCount: number;
}

export class CongressionalWorkspaceWorkerError extends Error {
  constructor(readonly code:
    | "congressional_capability_denied"
    | "congressional_execution_disabled"
    | "congressional_monitor_invalid"
    | "congressional_monitor_not_found"
    | "congressional_projection_invalid"
    | "congressional_source_unavailable"
    | "congressional_strategy_invalid"
  ) {
    super(code);
    this.name = "CongressionalWorkspaceWorkerError";
  }
}

function assertMonitor(
  monitor: WorkspaceMonitor | null,
  envelope: ReturnType<typeof requireWorkspaceWorkerAuth>,
): asserts monitor is WorkspaceMonitor {
  if (!monitor) throw new CongressionalWorkspaceWorkerError("congressional_monitor_not_found");
  if (
    monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    monitor.managedBy?.packId !== "congressional-signals" ||
    !CONGRESSIONAL_PACK_VERSIONS.has(monitor.managedBy.packVersion as CongressionalPackVersion) ||
    monitor.sources.length !== 1 ||
    monitor.sources[0]?.accessClassification !== "public" ||
    monitor.sources[0].canonicalUrl !== HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL ||
    monitor.sources[0].origin !==
      HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin ||
    monitor.sources[0].sourceId !== HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID
  ) {
    throw new CongressionalWorkspaceWorkerError("congressional_monitor_invalid");
  }
}

function groupProjections(projections: readonly AuthorizedPublicSourceProjection[]) {
  const filings = new Map<string, AuthorizedPublicSourceProjection>();
  const transactions = new Map<string, AuthorizedPublicSourceProjection[]>();
  for (const projection of projections) {
    const payload = projection.fact.payload;
    if (payload.schemaVersion === "house-ptr-filing/v1") {
      filings.set(projection.fact.logicalKey, projection);
    } else if (payload.schemaVersion === "house-ptr-transaction/v1") {
      const current = transactions.get(payload.filingLogicalKey) ?? [];
      current.push(projection);
      transactions.set(payload.filingLogicalKey, current);
    }
  }
  if ([...transactions.keys()].some((filingLogicalKey) => !filings.has(filingLogicalKey))) {
    throw new CongressionalWorkspaceWorkerError("congressional_projection_invalid");
  }
  return [...filings.entries()].flatMap(([filingLogicalKey, filing]) => {
    const rows = transactions.get(filingLogicalKey) ?? [];
    if (rows.length === 0) return [];
    return [{ filing, transactions: rows }];
  });
}

type CongressionalAlertArtifact = Pick<CongressionalFilingEvaluation, "alertPresentation" | "finding">;

function combinedFinding(evaluations: readonly CongressionalAlertArtifact[]): WorkspaceFindingCandidate | null {
  const findings = evaluations.flatMap(({ finding }) => finding ? [finding] : []);
  if (findings.length === 0) return null;
  return {
    accessClassification: "public",
    artifactRefs: [],
    asOf: findings.reduce((latest, finding) => finding.asOf > latest ? finding.asOf : latest, findings[0]!.asOf),
    factIdentities: findings.flatMap(({ factIdentities }) => factIdentities ?? []).sort(),
    facts: findings.flatMap(({ facts }) => facts ?? []),
    provenance: findings.flatMap(({ provenance }) => provenance),
    summary: findings.length === 1
      ? findings[0]!.summary
      : `${findings.length} official House PTR filing signals matched the configured band; delayed public disclosures are not evidence of wrongdoing or trade instructions.`,
  };
}

function alertPresentation(evaluations: readonly CongressionalAlertArtifact[]) {
  const presentations = evaluations.flatMap(({ alertPresentation }) =>
    alertPresentation ? [alertPresentation] : []);
  if (presentations.length === 0) return undefined;
  if (presentations.length === 1) return presentations[0];
  return {
    title: `${presentations.length} Congressional Signals filings`,
    whyMatched: "Official House PTR filing signals met the configured deterministic band. Delayed public disclosures are not evidence of wrongdoing or trade instructions.",
  };
}

function completeEvaluations(
  signal: CongressionalFilingSignal,
): CongressionalTransactionEvaluation[] {
  return signal.transactionEvaluations.map((evaluation) => ({
      ...evaluation,
      committeeResolution: {
        ...evaluation.committeeResolution,
        committeeKeys: evaluation.committeeResolution.committeeKeys ?? [],
      },
      clusterRevisionIds: evaluation.clusterRevisionIds ?? [],
      patternResolution: evaluation.patternResolution ?? {
        priorTransactionRevisionIds: [],
        ruleCodes: [],
        state: "unavailable",
      },
    }));
}

function responseWithObservedAt(
  response: Awaited<ReturnType<typeof fetchOfficialPublicSourceBytes>>,
  observedAt: string,
): HousePublicSourceBinaryResponse {
  return Object.freeze({ ...response, observedAt });
}

export async function evaluateCongressionalSignalsForWorker(input: {
  readonly clients?: CongressionalWorkspaceWorkerClients;
  readonly ctx: WorkerContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): Promise<CongressionalWorkspaceWorkerResult> {
  const now = input.now ?? new Date();
  const environment = input.environment ?? process.env;
  const envelope = requireWorkspaceWorkerAuth(input.ctx, {}, environment);
  const scope = authorizeWorkspaceWorkerStore(input.ctx, environment);
  const existing = await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, input.clients?.finding);
  const sourceLifecycle = input.clients?.sourceLifecycle ?? createEarningsCallSourceLifecycleStore(input.clients?.subscription);
  const acknowledgeDelivered = async () => {
    for (const acknowledgement of await sourceLifecycle.listAcknowledgements({ occurrenceKey: envelope.occurrenceKey, scope })) {
      await acknowledgePublicSourceProjection({ ...acknowledgement, scope }, input.clients?.subscription);
      await sourceLifecycle.completeAcknowledgement({ ...acknowledgement, occurrenceKey: envelope.occurrenceKey, scope });
    }
    await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
  };
  if (existing) {
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
    });
    await acknowledgeDelivered();
    return Object.freeze({
      baselineEstablished: false,
      checkpoint: outcome.checkpoint,
      filingCount: existing.finding?.facts?.length ?? 0,
      outcome,
      replayed: true,
      signalCount: existing.finding?.facts?.length ?? 0,
    });
  }
  if (!congressionalSignalsExecutionEnabled(environment)) {
    throw new CongressionalWorkspaceWorkerError("congressional_execution_disabled");
  }
  const [capabilitiesResult, monitorResult, strategyResult] = await Promise.allSettled([
    resolveWorkspaceWorkerCapabilitySnapshot({
      envelope,
      registry: [{
        definition: true,
        metadata: { category: "control_plane", id: CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID },
      }],
      scope,
      stateClient: input.clients?.state,
    }),
    getWorkspaceMonitor(scope, envelope.monitorId, input.clients?.monitor),
    readWorkspaceDocument("strategy", scope, input.clients?.state),
  ]);
  if (capabilitiesResult.status === "rejected") throw capabilitiesResult.reason;
  const capabilities = capabilitiesResult.value;
  if (!(CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID in capabilities.tools)) {
    throw new CongressionalWorkspaceWorkerError("congressional_capability_denied");
  }
  if (monitorResult.status === "rejected") throw monitorResult.reason;
  const monitor = monitorResult.value;
  assertMonitor(monitor, envelope);
  const managedBy = monitor.managedBy;
  if (!managedBy) throw new CongressionalWorkspaceWorkerError("congressional_monitor_invalid");
  const packVersion = managedBy.packVersion as CongressionalPackVersion;
  const runtime = congressionalRuntime(packVersion);
  if (strategyResult.status === "rejected") throw strategyResult.reason;
  const strategy = strategyResult.value;
  if (
    strategy?.schemaVersion !== 2 ||
    strategy.value.pack?.id !== "congressional-signals" ||
    strategy.value.pack.version !== packVersion ||
    strategy.value.pack.contentDigest !== managedBy.packContentDigest
  ) {
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const pack = strategyPackCatalog.resolve({
    contentDigest: managedBy.packContentDigest,
    id: "congressional-signals",
    version: packVersion,
  });
  if (
    !pack ||
    JSON.stringify(pack.evidenceContracts ?? []) !== JSON.stringify(runtime.evidenceContracts)
  ) {
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const minimumAlertBandValue = strategy.value.configuration.minimumAlertBand;
  const selectedMemberBioguideIds = strategy.value.configuration.selectedMemberBioguideIds;
  if (
    (minimumAlertBandValue !== "priority" && minimumAlertBandValue !== "review") ||
    !Array.isArray(selectedMemberBioguideIds) ||
    !selectedMemberBioguideIds.every((value): value is string => typeof value === "string")
  ) {
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const minimumAlertBand = minimumAlertBandValue as "priority" | "review";
  const runCoverage = await readWorkspaceSourceCoverage(
    scope,
    envelope.runId,
    input.clients?.sourceCoverage,
  );
  const completedSource = runCoverage?.state === "complete"
    ? runCoverage.sources.find(({ canonicalUrl, sourceId }) =>
        canonicalUrl === HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL &&
        sourceId === HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID) ?? null
    : null;
  const source = completedSource ?? await authorizeWorkspaceSourceFetch({
      runId: envelope.runId,
      scope,
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      url: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
    }, input.clients?.sourceCoverage);
  if (!runCoverage?.attempts.includes(source.sourceId)) {
    await reserveWorkspaceSourceAttempt({
      now,
      runId: envelope.runId,
      scope,
      sourceId: source.sourceId,
    }, input.clients?.sourceCoverage);
  }
  const requestObservedAt = now.toISOString();
  // A process can disappear inside a multi-document acquisition. Persist the
  // continuation before any source I/O so recovery never mistakes missing
  // output for a completed (and therefore non-repeatable) paid attempt.
  await sourceLifecycle.recordRetry({ acquisitionId: `pending.${envelope.occurrenceKey}`,
    monitorId: monitor.monitorId, occurrenceKey: envelope.occurrenceKey, runId: envelope.runId,
    scope, sourceId: source.sourceId, now, retryAfterSeconds: 60 });
  const coordinated = await coordinatePublicSourceOccurrence({
    continueIncompleteHouse: true,
    hybridRecoveryExtensions: input.clients?.hybridRecoveryExtensions,
    clients: {
      acquisition: input.clients?.acquisition,
      hybridState: input.clients?.state,
      hybridWorkspaceBudget: input.clients?.budget,
      subscription: input.clients?.subscription,
    },
    deferProjectionAcknowledgement: true,
    environment,
    fetch: {
      adapterId: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.adapterId,
      fetchDocument: input.clients?.fetchDocument ?? (async (url) => responseWithObservedAt(
        await fetchOfficialPublicSourceBytes(
          url,
          HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.limits.maximumPdfBytes,
          source,
        ),
        requestObservedAt,
      )),
      fetchIndex: input.clients?.fetchIndex ?? (async (url) => responseWithObservedAt(
        await fetchOfficialPublicSourceBytes(
          url,
          HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.limits.maximumArchiveBytes,
          source,
        ),
        requestObservedAt,
      )),
    },
    monitor,
    observedAt: now,
    parentBudgetRunId: envelope.runId,
    scope,
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: envelope.window,
  }).catch(async (error: unknown) => {
    if (error instanceof PublicSourceCoordinatorError) {
      await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
    }
    throw error;
  });
  const cursor = coordinated.acquisition.proposedNextCursor;
  if (
    (coordinated.acquisition.status !== "complete" &&
    coordinated.acquisition.status !== "no_change") ||
    coordinated.acquisition.coverage !== "complete" ||
    coordinated.acquisition.stageReceipts.some(({ status }) => status !== "complete")
  ) {
    if (coordinated.acquisition.status === "partial") {
      await sourceLifecycle.recordRetry({ acquisitionId: coordinated.acquisition.acquisitionId,
        monitorId: monitor.monitorId, occurrenceKey: envelope.occurrenceKey, runId: envelope.runId,
        scope, sourceId: source.sourceId, now, retryAfterSeconds: coordinated.sourceRetryAfterSeconds ?? 60 });
    }
    if (coordinated.acquisition.status === "terminal_failure") {
      await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
      /*
       * A deterministic House acquisition failure (malformed archive, forbidden
       * origin, oversized response) will recur identically on retry, so letting
       * the scheduler's default five-attempt bounded recovery run its course
       * just repeats the same failure five times over
       * (docs/congressional-monitor-retry-defect.md). Pause the monitor here,
       * on this first attempt, so the occurrence terminalizes exactly once. An
       * "uncertain" status (transport/network ambiguity, no HTTP response to
       * classify) retains the armed continuation below; source-global claims
       * and the existing scheduler budget limits fence the resumed attempt.
       */
      await recordWorkspaceMonitorFailure({
        errorCode: "congressional_source_unavailable",
        expectedRevision: monitor.configurationRevision,
        failureThreshold: 1,
        monitorId: monitor.monitorId,
        now,
        scope,
      }, input.clients?.monitor).catch(() => {
        // A concurrent lifecycle/configuration edit is authoritative; the
        // scheduler's own fallback failure accounting remains a safe backstop
        // either way.
      });
    }
    throw new CongressionalWorkspaceWorkerError("congressional_source_unavailable");
  }
  if (!cursor || !coordinated.projection) {
    await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
    throw new CongressionalWorkspaceWorkerError("congressional_projection_invalid");
  }
  const observedAt = coordinated.acquisition.observedAt;
  const initialBaseline = monitor.sourceCheckpoint.contentDigest === null &&
    monitor.sourceCheckpoint.watermark === null;
  const packBinding = {
    bindingRevision: managedBy.bindingRevision,
    packContentDigest: managedBy.packContentDigest,
    packId: "congressional-signals" as const,
    packVersion,
  };
  const catalogs = {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
    member: runtime.member,
    security: runtime.security,
  } as const;
  const priorHistory = await readCongressionalHistory(scope, input.clients?.signal);
  const incomingTransactionFilings = new Set(coordinated.projection.projections.flatMap(({ fact }) =>
    fact.payload.schemaVersion === "house-ptr-transaction/v1"
      ? [fact.payload.filingLogicalKey]
      : []));
  const filingOnlyKeys = new Set(coordinated.projection.projections.flatMap(({ fact }) =>
    fact.payload.schemaVersion === "house-ptr-filing/v1" &&
      !incomingTransactionFilings.has(fact.logicalKey)
      ? [fact.logicalKey]
      : []));
  const hydrated = (await Promise.all((priorHistory?.activeEntries ?? []).flatMap(({ transaction }) =>
    filingOnlyKeys.has(transaction.source.filingLogicalKey)
      ? [readAuthorizedPublicSourceProjection({
          factRevisionId: transaction.source.factRevisionId,
          scope,
          subscriptionId: transaction.source.subscriptionId,
        }, {
          acquisition: input.clients?.acquisition,
          subscription: input.clients?.subscription,
        })]
      : []))).filter((projection): projection is AuthorizedPublicSourceProjection => projection !== null);
  const filingGroups = groupProjections([
    ...coordinated.projection.projections,
    ...hydrated,
  ]);
  const baseEvaluationInput = {
    catalogs,
    minimumAlertBand,
    observedAt,
    packBinding,
    policy: runtime.policy,
    processingMode: initialBaseline || coordinated.baselineEstablished ? "baseline" as const : "live" as const,
    selectedMemberBioguideIds,
  };
  const normalized = filingGroups.flatMap((group) =>
    normalizeCongressionalFilingTransactions({
      ...baseEvaluationInput,
      filing: group.filing,
      transactions: group.transactions,
    }));
  const coverage = advanceCongressionalCoverage(priorHistory?.coverage ?? null, {
    maximumGapDays: CONGRESSIONAL_POLICY_V1_2.coverageMaximumGapDays!,
    observedOn: observedAt.slice(0, 10),
    requiredDays: CONGRESSIONAL_POLICY_V1_2.historyCoverageDays!,
    sourceComplete: coordinated.deliveryPending !== true && coordinated.acquisition.coverage === "complete" &&
      coordinated.acquisition.stageReceipts.every(({ status }) => status === "complete"),
  });
  const historyChanges = applyCongressionalHistoryChanges({
    currentTransactions: normalized,
    observedAt,
    priorEntries: priorHistory?.activeEntries ?? [],
    retractions: coordinated.projection.retractions.map(({ retraction }) => ({
      fromRevisionId: retraction.fromRevisionId,
      logicalKey: retraction.logicalKey,
      retractionId: retraction.retractionId,
    })),
  });
  const memberCatalog = runtime.member;
  if (memberCatalog.kind !== "house_members") {
    await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const partyFor = (transaction: (typeof historyChanges.currentTransactions)[number]) =>
    memberCatalog.entries.find(({ bioguideId }) =>
      bioguideId === transaction.memberResolution.bioguideId)?.party ?? null;
  const currentCandidates = runtime.historyFeatures
    ? historyChanges.currentTransactions.flatMap((transaction): CongressionalClusterCandidate[] => {
    const party = partyFor(transaction);
    if (party === null) return [];
    const committee = resolveCongressionalCommitteeRelevance({
      assignments: catalogs.committeeAssignments,
      industryId: transaction.securityResolution.industryId,
      jurisdictions: catalogs.committeeJurisdictions,
      maximumCatalogAgeDays: CONGRESSIONAL_POLICY_V1_2.catalogMaximumAgeDays!,
      memberBioguideId: transaction.memberResolution.bioguideId,
      observedAt,
      transactionDate: transaction.transactionDate,
    });
      return [{ committeeKeys: committee.committeeKeys, party, transaction }];
    })
    : [];
  const clusters = runtime.historyFeatures ? deriveCongressionalClusters({
    candidates: [
      ...historyChanges.activeEntries.map(({ committeeKeys, party, transaction }) => ({
        committeeKeys,
        party,
        transaction,
      })),
      ...currentCandidates,
    ],
    minimumFacts: CONGRESSIONAL_POLICY_V1_2.clusterMinimumFacts!,
    windowDays: CONGRESSIONAL_POLICY_V1_2.clusterWindowDays!,
    workspaceId: scope.workspaceId,
  }) : [];
  const changedTransactions = new Map(historyChanges.currentTransactions.map((transaction) =>
    [transaction.transactionId, transaction]));
  const unchangedTransactions = new Map(historyChanges.activeEntries.map(({ transaction }) =>
    [transaction.transactionId, transaction]));
  const evaluations = filingGroups.flatMap((group) => {
    const currentTransactions = normalized
      .filter(({ source }) => source.filingLogicalKey === group.filing.fact.logicalKey)
      .map((transaction) => changedTransactions.get(transaction.transactionId) ??
        unchangedTransactions.get(transaction.transactionId) ?? transaction);
    if (currentTransactions.length === 0) return [];
    const currentTransactionIds = new Set(currentTransactions.map(({ transactionId }) => transactionId));
    const retainedTransactions = historyChanges.activeEntries.flatMap(({ transaction }) =>
      transaction.source.filingLogicalKey === group.filing.fact.logicalKey &&
        !currentTransactionIds.has(transaction.transactionId)
        ? [transaction]
        : []);
    return [evaluateCongressionalFiling({
      ...baseEvaluationInput,
      filing: group.filing,
      history: {
        clusters,
        coverage,
        lineageEntries: priorHistory?.activeEntries ?? [],
        priorEntries: historyChanges.activeEntries,
      },
      normalizedTransactions: [...retainedTransactions, ...currentTransactions],
      transactions: group.transactions,
    })];
  });
  for (let offset = 0; offset < evaluations.length; offset += 8) {
    await Promise.all(evaluations.slice(offset, offset + 8).map((evaluation) =>
      persistCongressionalFilingEvaluation({ evaluation, scope }, input.clients?.signal)));
  }
  const retractionRecords = [];
  for (const transaction of historyChanges.retractedTransactions) {
    const priorEntry = historyChanges.priorEntriesByTransactionId.get(transaction.transactionId);
    if (!priorEntry) continue;
    const priorSignal = await readCongressionalFilingSignal(
      scope,
      priorEntry.signalRevisionId,
      input.clients?.signal,
    );
    if (!priorSignal) throw new CongressionalWorkspaceWorkerError("congressional_projection_invalid");
    const signal = createCongressionalRetractionSignal({ observedAt, priorSignal, retractedTransaction: transaction });
    await persistCongressionalSignalRecords({ scope, signal, transactions: [transaction] }, input.clients?.signal);
    retractionRecords.push({ priorEntry, signal, transaction });
  }
  const evaluatedEntries = evaluations.flatMap((evaluation) => {
    const signalEvaluations = completeEvaluations(evaluation.signal);
    return evaluation.transactions.flatMap((transaction, index) => {
      const party = partyFor(transaction);
      if (party === null) return [];
      const transactionEvaluation = signalEvaluations[index]!;
      return [{
        alertEligible: evaluation.signal.alertEligible,
        band: transactionEvaluation.band,
        committeeKeys: transactionEvaluation.committeeResolution.committeeKeys,
        party,
        signalRevisionId: evaluation.signal.signalRevisionId,
        transaction,
      }];
    });
  });
  const activeByTransactionId = new Map(historyChanges.activeEntries.map((entry) =>
    [entry.transaction.transactionId, entry]));
  for (const entry of evaluatedEntries) {
    activeByTransactionId.set(entry.transaction.transactionId, entry);
  }
  const activeEntries: CongressionalHistoryEntry[] = [...activeByTransactionId.values()]
    .sort((left, right) => left.transaction.transactionId.localeCompare(right.transaction.transactionId));
  const correctionArtifacts = evaluations.flatMap((evaluation) => {
    const corrected = evaluation.transactions.find(({ lineage }) => lineage.correctionId !== null);
    if (!corrected) return [];
    const priorEntry = historyChanges.priorEntriesByTransactionId.get(corrected.transactionId);
    const signalEvaluations = completeEvaluations(evaluation.signal);
    const currentEvaluation = signalEvaluations.find(({ transactionRevisionId }) =>
      transactionRevisionId === corrected.transactionRevisionId);
    if (!priorEntry || !currentEvaluation || !shouldCreateCongressionalCorrectionAlert({
      currentBand: currentEvaluation.band,
      currentTransaction: corrected,
      priorEntry,
    })) return [];
    const artifact = congressionalFindingForSignal({
      evaluations: signalEvaluations,
      signal: evaluation.signal,
      transactions: evaluation.transactions,
    });
    return [{
      alertPresentation: {
        title: "Congressional Signals · correction",
        whyMatched: `A previously alerted House PTR signal changed. ${artifact.presentation.whyMatched}`,
      },
      finding: {
        ...artifact.finding,
        factIdentities: [corrected.lineage.correctionId!],
        summary: `A previously alerted House PTR signal changed after an official correction; ${artifact.finding.summary}`,
      },
    }];
  });
  for (const { priorEntry, signal, transaction } of retractionRecords) {
    if (!shouldCreateCongressionalCorrectionAlert({
      currentBand: "record_only",
      currentTransaction: transaction,
      priorEntry,
    })) continue;
    const artifact = congressionalFindingForSignal({
      evaluations: completeEvaluations(signal),
      signal,
      transactions: [transaction],
    });
    correctionArtifacts.push({
      alertPresentation: {
        title: "Congressional Signals · correction",
        whyMatched: `A previously alerted House PTR transaction was retracted. ${artifact.presentation.whyMatched}`,
      },
      finding: {
        ...artifact.finding,
        factIdentities: [transaction.lineage.retractionId!],
        summary: `A previously alerted House PTR transaction was retracted by an official amendment; ${artifact.finding.summary}`,
      },
    });
  }
  const correctionAlertKeys = [...new Set([
    ...(priorHistory?.correctionAlertKeys ?? []),
    ...correctionArtifacts.flatMap(({ finding }) => finding.factIdentities ?? []),
  ])].sort().slice(-500);
  const retainedActiveEntries = [...activeEntries]
    .sort((left, right) =>
      right.transaction.observedAt.localeCompare(left.transaction.observedAt) ||
      left.transaction.transactionId.localeCompare(right.transaction.transactionId))
    .slice(0, 500)
    .sort((left, right) => left.transaction.transactionId.localeCompare(right.transaction.transactionId));
  const retainedClusters = [...clusters]
    .sort((left, right) =>
      right.windowEnd.localeCompare(left.windowEnd) ||
      left.clusterRevisionId.localeCompare(right.clusterRevisionId))
    .slice(0, 500)
    .sort((left, right) => left.clusterRevisionId.localeCompare(right.clusterRevisionId));
  const history = createCongressionalHistoryRevision({
    activeEntries: retainedActiveEntries.map((entry) => ({
      ...entry,
      committeeKeys: [...entry.committeeKeys],
    })),
    clusters: retainedClusters.map((cluster) => ({
      ...cluster,
      descriptiveParties: [...cluster.descriptiveParties],
      factLogicalKeys: [...cluster.factLogicalKeys],
      memberBioguideIds: [...cluster.memberBioguideIds],
      transactionRevisionIds: [...cluster.transactionRevisionIds],
    })),
    correctionAlertKeys,
    coverage,
    createdAt: observedAt,
    recordType: "congressional_history_revision",
    schemaVersion: 1,
    workspaceId: scope.workspaceId,
  });
  await persistCongressionalHistory({
    expectedHistoryRevisionId: priorHistory?.historyRevisionId ?? null,
    history,
    scope,
  }, input.clients?.signal);
  const normalAlertArtifacts = evaluations
    .filter((evaluation) => !evaluation.transactions.some(({ lineage }) => lineage.correctionId !== null))
    .map(({ alertPresentation, finding }) => ({ alertPresentation, finding }));
  const alertArtifacts = [...normalAlertArtifacts, ...correctionArtifacts];
  const unseen = new Set(await selectUnseenWorkspaceFindingIdentities({
    factIdentities: alertArtifacts.flatMap(({ finding }) => finding?.factIdentities ?? []),
    monitorId: envelope.monitorId,
    scope,
  }, input.clients?.finding));
  const alertEvaluations = alertArtifacts.filter(({ finding }) =>
    finding?.factIdentities?.some((identity) => unseen.has(identity)));
  const checkpoint = {
    contentDigest: cursor.contentDigest,
    // Acquisition keeps its physical observation time as provenance. The
    // workspace checkpoint advances the logical occurrence window so a normal
    // cron delay cannot move the result outside its authorized source fence.
    watermark: envelope.window.endAt,
  };
  await markWorkspaceSourceSuccess({
    contentDigest: cursor.contentDigest,
    now,
    runId: envelope.runId,
    scope,
    sourceId: source.sourceId,
  }, input.clients?.sourceCoverage);
  await sourceLifecycle.recordAcknowledgement({
    acquisitionId: coordinated.deliveryAcquisitionId ?? coordinated.acquisition.acquisitionId,
    expectedDeliveryRevision: coordinated.projection.subscription.deliveryCursor.revision,
    monitorId: monitor.monitorId, occurrenceKey: envelope.occurrenceKey, sourceId: source.sourceId,
    scope, subscriptionId: coordinated.projection.subscription.subscriptionId,
  });
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    sourcePending: coordinated.deliveryPending,
    alertPresentation: alertPresentation(alertEvaluations),
    checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment,
    finding: combinedFinding(alertEvaluations),
    initialBaseline,
    now,
    toolId: CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  });
  await acknowledgeDelivered();
  return Object.freeze({
    baselineEstablished: coordinated.baselineEstablished,
    checkpoint,
    filingCount: evaluations.length,
    outcome,
    replayed: false,
    signalCount: evaluations.length + retractionRecords.length,
  });
}

export const congressionalWorkspaceWorkerOutputSchema = z.object({
  baselineEstablished: z.boolean(),
  checkpoint: z.object({
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    watermark: z.string().datetime({ offset: true }),
  }).strict(),
  filingCount: z.number().int().min(0).max(500),
  outcome: z.enum(["finding_staged", "no_match", "source_pending"]),
  replayed: z.boolean(),
  runId: z.string().min(1).max(160),
  signalCount: z.number().int().min(0).max(500),
}).strict();

export const evaluateCongressionalSignalsTool = defineTool({
  description: "Evaluate authorized official House PTR projections exactly once using the pinned Congressional Signals policy, persist filing signals, and stage neutral at-most-once alerts.",
  inputSchema: z.object({}).strict(),
  outputSchema: congressionalWorkspaceWorkerOutputSchema,
  async execute(_input, ctx) {
    const result = await evaluateCongressionalSignalsForWorker({ ctx });
    return {
      baselineEstablished: result.baselineEstablished,
      checkpoint: result.checkpoint,
      filingCount: result.filingCount,
      outcome: result.outcome.outcome,
      replayed: result.replayed,
      runId: result.outcome.runId,
      signalCount: result.signalCount,
    };
  },
});

export type CongressionalWorkspaceRunRecoveryResult =
  | { readonly outcome: WorkspaceRunOutcome; readonly status: "already_completed" | "recovered" }
  | { readonly status: "missing" | "not_applicable" };

export async function recoverCongressionalWorkspaceRunForControlPlane(input: {
  readonly clients?: WorkspaceWorkerControlPlaneClients;
  readonly now?: Date;
  readonly prepared: PreparedWorkspaceWorkerRecovery;
}): Promise<CongressionalWorkspaceRunRecoveryResult> {
  const sources = input.prepared.monitor.sources;
  if (
    sources.length !== 1 ||
    sources[0]?.sourceId !== HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID ||
    sources[0].canonicalUrl !== HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL
  ) {
    return Object.freeze({ status: "not_applicable" });
  }
  const outcome = await readWorkspaceRunOutcome(
    input.prepared.scope,
    input.prepared.claimed.occurrence.occurrenceKey,
    input.clients?.finding,
  );
  if (!outcome) return Object.freeze({ status: "missing" });
  const facts = (outcome.finding?.facts ?? []).filter(
    (fact): fact is CongressionalFilingSignalFact => fact.kind === "congressional_filing_signal",
  );
  const presentation = facts.length === 0
    ? undefined
    : facts.length === 1
      ? {
          title: `Congressional Signals · ${facts[0]!.band}`,
          whyMatched: "An official House PTR filing met the configured deterministic band. Delayed public disclosure is not evidence of wrongdoing or a trade instruction.",
        }
      : {
          title: `${facts.length} Congressional Signals filings`,
          whyMatched: "Official House PTR filing signals met the configured deterministic band. Delayed public disclosures are not evidence of wrongdoing or trade instructions.",
        };
  return finalizePriorWorkspaceRunOutcomeForControlPlane({
    alertPresentation: presentation,
    clients: input.clients,
    now: input.now,
    outcome,
    prepared: input.prepared,
    toolId: CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  });
}
