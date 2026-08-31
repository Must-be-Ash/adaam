import { CONGRESSIONAL_RESEARCH_DEFINITION_ID, CONGRESSIONAL_RESEARCH_PACK_VERSION } from "./congressional-research";
import { congressionalBriefPresentation, publishCongressionalResearchReport, researchCongressionalFiling,
  resolveCongressionalResearchRuntime, type CongressionalResearchClients } from "./congressional-research-worker";
import type { WorkspaceExecutiveBrief } from "./workspace-executive-brief";
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
  snapshotCongressionalHistoryForOccurrence,
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
type CongressionalPackVersion = "1.0.0" | "1.1.0" | "1.2.0" | "1.3.0" | "1.4.0" | "1.5.0";

const CONGRESSIONAL_PACK_VERSIONS = new Set<CongressionalPackVersion>([
  "1.0.0",
  "1.1.0",
  "1.2.0",
  "1.3.0",
  "1.4.0",
  "1.5.0",
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
  readonly research?: CongressionalResearchClients;
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

type CongressionalAlertArtifact = Pick<CongressionalFilingEvaluation, "alertPresentation" | "finding"> & { brief?: WorkspaceExecutiveBrief };

function combinedFinding(evaluations: readonly CongressionalAlertArtifact[]): WorkspaceFindingCandidate | null {
  const findings = evaluations.flatMap(({ finding }) => finding ? [finding] : []);
  if (findings.length === 0) return null;
  return {
    accessClassification: "public",
    artifactRefs: [],
    asOf: findings.reduce((latest, finding) => finding.asOf > latest ? finding.asOf : latest, findings[0]!.asOf),
    factIdentities: findings.flatMap(({ factIdentities }) => factIdentities ?? []).sort(),
    facts: findings.flatMap(({ facts }) => facts ?? []),
    provenance: [{ accessClassification: "public", canonicalUrl: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
      origin: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID }],
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
    whyMatched: evaluations.some(({ brief }) => brief)
      ? "New House disclosure signals and corrections are explained separately in the attached report. These delayed disclosures are not trade instructions."
      : "Official House PTR filing signals met the configured deterministic band. Delayed public disclosures are not evidence of wrongdoing or trade instructions.",
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
    JSON.stringify((pack.evidenceContracts ?? []).filter(({ id }) =>
      packVersion !== CONGRESSIONAL_RESEARCH_PACK_VERSION || id !== CONGRESSIONAL_RESEARCH_DEFINITION_ID)) !== JSON.stringify(runtime.evidenceContracts)
  ) {
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const snapshot = strategy.value.pendingSnapshot ?? strategy.value.lastActiveSnapshot;
  if (packVersion === CONGRESSIONAL_RESEARCH_PACK_VERSION &&
      (strategy.value.lifecycleState !== "active" || snapshot?.workspaceGeneration === undefined)) {
    throw new CongressionalWorkspaceWorkerError("congressional_strategy_invalid");
  }
  const researchRuntime = packVersion === CONGRESSIONAL_RESEARCH_PACK_VERSION
    ? resolveCongressionalResearchRuntime({ pack, modelIds: capabilities.resolved.workerModelIds,
        environment, workspaceGeneration: snapshot!.workspaceGeneration! }) : null;
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
  const priorDelivery = (await sourceLifecycle.listAcknowledgements({ occurrenceKey: envelope.occurrenceKey, scope }))
    .find((acknowledgement) => acknowledgement.sourceId === source.sourceId);
  const coordinated = await coordinatePublicSourceOccurrence({
    houseDeliveryAcquisitionId: priorDelivery?.deliveryThroughRevision === undefined ? undefined : priorDelivery.acquisitionId,
    houseDeliveryThroughRevision: priorDelivery?.deliveryThroughRevision,
    continueIncompleteHouse: true,
    initialHouseBaseline: monitor.sourceCheckpoint.contentDigest === null && monitor.sourceCheckpoint.watermark === null,
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
    coordinated.acquisition.status !== "no_change")
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
  // Pin delivery before history or research can commit. Another workspace may
  // advance the shared source between attempts; this occurrence must not move.
  await sourceLifecycle.recordAcknowledgement({
    acquisitionId: coordinated.deliveryAcquisitionId ?? coordinated.acquisition.acquisitionId,
    ...(priorDelivery && priorDelivery.deliveryThroughRevision === undefined ? {} : { deliveryThroughRevision: coordinated.deliveryThroughRevision }),
    expectedDeliveryRevision: coordinated.projection.subscription.deliveryCursor.revision,
    monitorId: monitor.monitorId, occurrenceKey: envelope.occurrenceKey, sourceId: source.sourceId,
    scope, subscriptionId: coordinated.projection.subscription.subscriptionId,
  });
  const observedAt = coordinated.acquisition.observedAt;
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
  const priorHistory = await snapshotCongressionalHistoryForOccurrence({ scope, occurrenceKey: envelope.occurrenceKey }, input.clients?.signal);
  const priorEntriesByFiling = new Map<string, CongressionalHistoryEntry[]>();
  for (const entry of priorHistory?.activeEntries ?? []) {
    const key = entry.transaction.source.filingLogicalKey;
    priorEntriesByFiling.set(key, [...(priorEntriesByFiling.get(key) ?? []), entry]);
  }
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
  const processingModeFor = (filing: AuthorizedPublicSourceProjection) => {
    // Legacy canonical revisions lack observation metadata. The workspace's
    // proven live history remains authoritative for subsequent corrections.
    if (priorEntriesByFiling.get(filing.fact.logicalKey)?.some(({ transaction, alertEligible }) =>
      transaction.processingMode === "live" || alertEligible)) return "live" as const;
    return filing.fact.firstObservedCursorRevision === undefined ||
      filing.fact.firstObservedCursorRevision <= coordinated.subscription.initialBaselineThroughRevision!
      ? "baseline" as const : "live" as const;
  };
  const initialBaseline = monitor.sourceCheckpoint.contentDigest === null &&
    monitor.sourceCheckpoint.watermark === null && filingGroups.every(({ filing }) => processingModeFor(filing) === "baseline");
  const baseEvaluationInput = {
    catalogs,
    minimumAlertBand,
    observedAt,
    packBinding,
    policy: runtime.policy,
    selectedMemberBioguideIds,
  };
  const normalized = filingGroups.flatMap((group) =>
    normalizeCongressionalFilingTransactions({
      ...baseEvaluationInput,
      processingMode: processingModeFor(group.filing),
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
      processingMode: processingModeFor(group.filing),
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
  const researchDecisions = new Map<string, Awaited<ReturnType<typeof researchCongressionalFiling>>>();
  if (researchRuntime) {
    for (const evaluation of evaluations) {
      if (processingModeFor(evaluation.filing) !== "live") continue;
      // Only source validity and the owner's member selection gate research.
      // In particular, a catalog miss must not suppress a legacy PDF's signal.
      if (!evaluation.transactions.some((row) => row.memberResolution.state === "resolved" &&
        !row.eligibility.reasonCodes.some((reason) => ["unsupported_source", "unresolved_member", "member_not_selected", "invalid_date"].includes(reason)))) continue;
      const previousEntries = priorEntriesByFiling.get(evaluation.filing.fact.logicalKey) ?? [];
      const decision = await researchCongressionalFiling({ evaluation, minimumAlertBand,
        historyCoverage: coverage.state,
        previousAlert: previousEntries.some(({ alertEligible }) => alertEligible),
        previousTransactions: previousEntries.map(({ transaction }) => transaction),
        runtime: researchRuntime, environment, now, parentBudgetRunId: envelope.runId, scope,
        clients: { ...input.clients?.research, semantic: {
          acquisition: input.clients?.acquisition, state: input.clients?.state, budget: input.clients?.budget,
          subscription: input.clients?.subscription, monitor: input.clients?.monitor,
          ...input.clients?.research?.semantic,
        } },
      });
      researchDecisions.set(evaluation.signal.signalRevisionId, decision);
    }
  }
  const decisionAlerts = (decision: Awaited<ReturnType<typeof researchCongressionalFiling>> | undefined) =>
    decision?.band === "priority" || (decision?.band === "review" && minimumAlertBand === "review");
  const evaluatedEntries = evaluations.flatMap((evaluation) => {
    const signalEvaluations = completeEvaluations(evaluation.signal);
    return evaluation.transactions.flatMap((transaction, index) => {
      const party = partyFor(transaction);
      if (party === null) return [];
      const transactionEvaluation = signalEvaluations[index]!;
      return [{
        alertEligible: researchRuntime ? decisionAlerts(researchDecisions.get(evaluation.signal.signalRevisionId)) : evaluation.signal.alertEligible,
        band: researchRuntime ? researchDecisions.get(evaluation.signal.signalRevisionId)?.band ?? "record_only" : transactionEvaluation.band,
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
  const correctionArtifacts: CongressionalAlertArtifact[] = evaluations.flatMap((evaluation) => {
    const signalEvaluations = completeEvaluations(evaluation.signal);
    const decision = researchDecisions.get(evaluation.signal.signalRevisionId);
    const corrected = evaluation.transactions.filter((transaction) => {
      const priorEntry = historyChanges.priorEntriesByTransactionId.get(transaction.transactionId);
      const currentEvaluation = signalEvaluations.find(({ transactionRevisionId }) => transactionRevisionId === transaction.transactionRevisionId);
      return transaction.lineage.correctionId !== null && priorEntry && currentEvaluation &&
        shouldCreateCongressionalCorrectionAlert({ currentBand: decision?.band ?? currentEvaluation.band, currentTransaction: transaction, priorEntry });
    });
    if (!corrected.length) return [];
    const artifact = congressionalFindingForSignal({ evaluations: signalEvaluations, signal: evaluation.signal, transactions: evaluation.transactions });
    // One correction per filing revision, even if several rows changed. Its
    // finding fact and deduplication identity must refer to the same revision.
    const identity = evaluation.signal.signalRevisionId;
    return [{
      ...(decision ? { brief: decision.brief } : {}),
      alertPresentation: decision ? { ...congressionalBriefPresentation(decision.brief), title: "Congressional Signals · correction" } : {
        title: "Congressional Signals · correction", whyMatched: `A previously alerted House PTR signal changed. ${artifact.presentation.whyMatched}` },
      finding: { ...artifact.finding, factIdentities: [identity],
        ...(decision ? { facts: artifact.finding.facts!.map((fact) => ({ ...fact, band: decision.band })) } : {}),
        summary: decision?.brief.interpretation ?? `A previously alerted House PTR signal changed after an official correction; ${artifact.finding.summary}` },
    }];
  });
  const retractedByFiling = new Map<string, typeof retractionRecords>();
  for (const record of retractionRecords) {
    if (!shouldCreateCongressionalCorrectionAlert({ currentBand: "record_only", currentTransaction: record.transaction, priorEntry: record.priorEntry })) continue;
    const key = record.transaction.source.filingLogicalKey;
    retractedByFiling.set(key, [...(retractedByFiling.get(key) ?? []), record]);
  }
  for (const records of retractedByFiling.values()) {
    const artifacts = records.map(({ signal, transaction }) => congressionalFindingForSignal({
      evaluations: completeEvaluations(signal), signal, transactions: [transaction],
    }));
    const artifact = artifacts[0]!;
    const identity = records[0]!.signal.signalRevisionId;
    const fact = artifact.finding.facts![0] as CongressionalFilingSignalFact;
    const summary = `${records.length} previously alerted House PTR transaction(s) were retracted by an official amendment. The earlier interpretation of those transactions should be withdrawn.`;
    correctionArtifacts.push({
      alertPresentation: { title: "Congressional Signals · correction", whyMatched: `${summary} ${artifact.presentation.whyMatched}`.slice(0, 1_000) },
      finding: { ...artifact.finding, factIdentities: [identity], summary,
        facts: [{ ...fact, filingIdentity: identity, transactions: artifacts.flatMap(({ finding }) =>
          (finding.facts![0] as CongressionalFilingSignalFact).transactions).slice(0, 50) }] },
    });
  }
  const correctionAlertKeys = [...new Set([
    ...(priorHistory?.correctionAlertKeys ?? []),
    ...correctionArtifacts.flatMap(({ finding }) => finding?.factIdentities ?? []),
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
    .filter((evaluation) => !evaluation.transactions.some(({ lineage }) => lineage.correctionId !== null) ||
      (researchRuntime !== null && !evaluation.transactions.some(({ transactionId }) =>
        historyChanges.priorEntriesByTransactionId.get(transactionId)?.alertEligible)))
    .map((evaluation): CongressionalAlertArtifact => {
      if (!researchRuntime) return evaluation;
      const decision = researchDecisions.get(evaluation.signal.signalRevisionId);
      if (!decision || !decisionAlerts(decision)) return { alertPresentation: null, finding: null };
      const artifact = congressionalFindingForSignal({ evaluations: completeEvaluations(evaluation.signal), signal: evaluation.signal, transactions: evaluation.transactions });
      return { brief: decision.brief, alertPresentation: congressionalBriefPresentation(decision.brief),
        finding: { ...artifact.finding, summary: decision.brief.interpretation,
          facts: artifact.finding.facts!.map((fact) => ({ ...fact, band: decision.band })) } };
    });
  const alertArtifacts = [...normalAlertArtifacts, ...correctionArtifacts];
  const unseen = new Set(await selectUnseenWorkspaceFindingIdentities({
    factIdentities: alertArtifacts.flatMap(({ finding }) => finding?.factIdentities ?? []),
    monitorId: envelope.monitorId,
    scope,
  }, input.clients?.finding));
  const alertEvaluations = alertArtifacts.filter(({ finding }) =>
    finding?.factIdentities?.some((identity) => unseen.has(identity)));
  const researchArtifact = await publishCongressionalResearchReport({
    briefs: alertEvaluations.flatMap(({ brief }) => brief ? [brief] : []),
    identities: alertEvaluations.flatMap(({ finding }) => finding?.factIdentities ?? []),
    scope, asOf: observedAt, publishReport: input.clients?.research?.publishReport,
  });
  const combined = combinedFinding(alertEvaluations);
  if (combined && researchArtifact) combined.artifactRefs = [researchArtifact];
  const checkpoint = {
    contentDigest: cursor.contentDigest,
    // Acquisition keeps its physical observation time as provenance. The
    // workspace checkpoint advances the logical occurrence window so a normal
    // cron delay cannot move the result outside its authorized source fence.
    watermark: envelope.window.endAt,
  };
  await markWorkspaceSourceSuccess({
    acquisitionCoverage: coordinated.acquisition.coverage,
    unresolvedItemCount: coordinated.unresolvedFilingCount,
    contentDigest: cursor.contentDigest,
    now,
    runId: envelope.runId,
    scope,
    sourceId: source.sourceId,
  }, input.clients?.sourceCoverage);
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    sourcePending: coordinated.deliveryPending,
    alertPresentation: alertPresentation(alertEvaluations),
    checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment,
    finding: combined,
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
          whyMatched: outcome.finding!.summary.slice(0, 1_000),
        }
      : {
          title: `${facts.length} Congressional Signals filings`,
          whyMatched: outcome.finding!.summary.slice(0, 1_000),
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
