import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { publishReportArtifact } from "./artifact-store";
import { artifactReferenceForId } from "./artifact-reference";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactStore,
} from "./hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import {
  runWorkspaceSemanticEvidenceBundleJob,
  type WorkspaceSemanticModelUsage,
} from "./hybrid-evidence-semantic";
import type { WorkspaceSemanticEvidenceStoreClient } from "./hybrid-evidence-semantic-store";
import {
  startHybridEvidenceWorkerTask,
  type PreparedHybridEvidenceWorkerRun,
} from "./hybrid-evidence-worker";
import {
  assertHybridModelRouteAllowed,
  resolveHybridTaskModelRoute,
} from "./hybrid-evidence-model-routing";
import {
  createInverseCramerResearchDefinition,
  INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
  INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS,
  isInverseCramerAgenticResearchPack,
} from "./inverse-cramer-research";
import {
  readPublicSourceAcquisitionResult,
  readPublicSourceCorrection,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import { coordinatePublicSourceOccurrence } from "./public-source-coordinator";
import { resolveReviewedPublicSource } from "./public-source-registry";
import { createOfficialWebStatementFetch } from "./official-web-statement-adapter";
import {
  projectPublicSourceAcquisition,
  type AuthorizedPublicSourceProjection,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import type { PublicCommentaryAttemptStoreClient } from "./public-commentary-attempt-store";
import {
  readPublicCommentaryFindingByStatementRevision,
  type PublicCommentaryFindingStoreClient,
} from "./public-commentary-finding-store";
import { resolvePublicCommentaryRuntimeFlags } from "./public-commentary-flags";
import {
  commentaryFindingSchema,
  digestPublicCommentaryEvidenceSpan,
  publicStatementSchema,
} from "./public-commentary-schema";
import {
  buildPublicCommentarySignalReport,
  publicCommentaryAlertPresentationForBrief,
  publicCommentaryReportArtifactId,
} from "./public-commentary-signal-report";
import {
  createCommentarySemanticDefinition,
  createInverseCramerActionabilityDefinition,
  createInverseCramerSemanticDefinition,
  createPublicCommentaryImpactDefinition,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
  PUBLIC_COMMENTARY_COMPACT_EVALUATION_DEFINITION_IDS,
  PUBLIC_COMMENTARY_DIRECT_MODEL_DEFINITION_IDS,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_VERSIONS,
  recoverNamedAssetCommentaryMetadata,
} from "./public-commentary-semantics";
import {
  createPublicCommentaryPipeline,
  materializePublicCommentaryCorrection,
  type PublicCommentaryResearchSubject,
} from "./public-commentary-vertical";
import {
  resolvePublicCommentaryInterpretationContract,
} from "./public-commentary-interpretation-contract";
import {
  createDefaultRevocableEvidenceStoreClient,
  purgeRevocableEvidence,
  readRevocableEvidencePayload,
} from "./revocable-evidence-store";
import { INVERSE_CRAMER_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";
import { strategyPackCatalog, type StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import { resolveManagedMonitorLifecycleContract } from "./workspace-monitor-lifecycle-contract";
import { strategyPackIntervalMinutes } from "./strategy-pack-schema";
import {
  getWorkspaceMonitor,
  isWorkspaceMonitorCheckpointOnlyBaseline,
  type WorkspaceMonitor,
} from "./workspace-monitor-store";
import {
  authorizeWorkspaceXExactPostFetch,
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "./workspace-source-coverage";
import { readWorkspaceDocument } from "./workspace-state-store";
import {
  readWorkspaceRunOutcome,
  workspaceFindingCandidateSchema,
  type WorkspaceFindingCandidate,
} from "./workspace-finding-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import { createExaWebCorroborationProvider, type WebCorroborationProvider } from "./web-corroboration-search";
import {
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
} from "./workspace-budget-ledger";
import {
  shouldPublishWorkspaceExecutiveArtifact,
  workspaceExecutiveBriefSchema,
  type WorkspaceExecutiveBrief,
} from "./workspace-executive-brief";
import {
  createXPublicStatementFetch,
  createXExactPostRequest,
  rehydrateXPublicStatement,
  resolveXLatestEditPostId,
  type XPublicStatementRequest,
  type XPublicStatementResponse,
  type XRevocableEvidenceOptions,
} from "./x-public-statement-adapter";
import {
  acknowledgeXPublicStatementRehydration,
  claimDueXPublicStatementsForRehydration,
  completeXPublicStatementRehydration,
  deferXPublicStatementRehydration,
  registerWorkspaceXPublicStatementForRehydration,
  type XPublicStatementRehydrationOutcome,
} from "./x-public-statement-rehydration-store";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0] & {
  readonly abortSignal?: AbortSignal;
};

export interface PublicCommentaryPipelineResult {
  readonly acknowledgeDurableCommit?: () => Promise<void>;
  readonly alertPresentation: { readonly title: string; readonly whyMatched: string } | null;
  readonly alertPresentations?: readonly Readonly<{ key: string; title: string; whyMatched: string }>[];
  readonly analyzedStatements: number;
  readonly checkpoint: Readonly<{ readonly contentDigest: string; readonly watermark: string }>;
  readonly finding: WorkspaceFindingCandidate | null;
  readonly researchSubjects?: readonly PublicCommentaryResearchSubject[];
}

export async function commitThenAcknowledgePublicCommentaryResult<T>(input: {
  readonly acknowledge?: () => Promise<void>;
  readonly commit: () => Promise<T>;
}): Promise<T> {
  const committed = await input.commit();
  await input.acknowledge?.();
  return committed;
}

export interface PublicCommentaryWorkspaceWorkerClients extends WorkspaceWorkerControlPlaneClients {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly artifacts?: HybridEvidenceArtifactStore;
  readonly attempts?: PublicCommentaryAttemptStoreClient;
  readonly commentaryFindings?: PublicCommentaryFindingStoreClient;
  readonly corroboration?: WebCorroborationProvider;
  readonly fetchResponse?: (request: XPublicStatementRequest) => Promise<XPublicStatementResponse>;
  readonly semantic?: Readonly<{
    readonly budget?: WorkspaceBudgetLedgerClient;
    readonly catalog?: Pick<typeof strategyPackCatalog, "resolve">;
    readonly execute?: (prepared: PreparedHybridEvidenceWorkerRun) => Promise<WorkspaceSemanticModelUsage | void>;
    readonly jobs?: HybridEvidenceJobStoreClient;
    readonly lineage?: HybridEvidenceLineageStoreClient;
    readonly semantic?: WorkspaceSemanticEvidenceStoreClient;
  }>;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
  readonly xEvidence?: XRevocableEvidenceOptions;
  readonly pipeline?: Readonly<{
    run(input: Readonly<{
      configuration: Readonly<Record<string, unknown>>;
      configurationGeneration: number;
      environment: NodeJS.ProcessEnv;
      initialBackfill?: boolean;
      monitorId: string;
      ownerId: string;
      parentBudgetRunId?: string;
      pack: Readonly<{
        contentDigest: string;
        id: "inverse-cramer" | "public-commentary-tracker";
        lifecycleContractId?: string;
        version: string;
      }>;
      scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
      strategyDisplayName?: string;
      window: Readonly<{ endAt: string; startAt: string }>;
    }>): Promise<PublicCommentaryPipelineResult>;
  }>;
  readonly publishReport?: typeof publishReportArtifact;
  readonly recoverExtraction?: Parameters<typeof createPublicCommentaryPipeline>[0]["recoverExtraction"];
}

export class PublicCommentaryWorkspaceWorkerError extends Error {
  constructor(readonly code:
    | "public_commentary_capability_denied"
    | "public_commentary_execution_disabled"
    | "public_commentary_monitor_invalid"
    | "public_commentary_pipeline_unavailable"
    | "public_commentary_source_unavailable"
    | "public_commentary_strategy_invalid"
  ) {
    super(code);
    this.name = "PublicCommentaryWorkspaceWorkerError";
  }
}

function resolveXEvidence(
  environment: NodeJS.ProcessEnv,
  provided?: XRevocableEvidenceOptions,
): XRevocableEvidenceOptions {
  if (provided) return provided;
  const encoded = environment.EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_BASE64?.trim();
  const keyReference = environment.EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_REFERENCE?.trim();
  if (!encoded || !keyReference) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_pipeline_unavailable");
  }
  const encryptionKey = Buffer.from(encoded, "base64");
  if (encryptionKey.byteLength !== 32 || encryptionKey.toString("base64") !== encoded) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_pipeline_unavailable");
  }
  return Object.freeze({
    client: createDefaultRevocableEvidenceStoreClient(environment),
    encryptionKey,
    keyReference,
  });
}

function usesCadenceDerivedBackfill(pack: Readonly<{
  id: string;
  lifecycleContractId?: string;
  version: string;
}>): boolean {
  return resolveManagedMonitorLifecycleContract({
    lifecycleContractId: pack.lifecycleContractId,
    managedBy: {
      packId: pack.id,
      packVersion: pack.version,
      resourceId: "evaluate-public-commentary",
    },
  })?.initialEvaluationWindow === "preceding_interval";
}

export function resolvePublicCommentaryFirstRunStart(input: {
  readonly activationWatermark?: string | null;
  readonly cadence: string;
  readonly initialBaseline: boolean;
  readonly legacyFirstRunLookback?: "off" | "hours_1" | "hours_6" | "hours_12" | "hours_24";
  readonly pack: Readonly<{ id: string; lifecycleContractId?: string; version: string }>;
  readonly windowEndAt: string;
}): string | null {
  if (!input.initialBaseline) return null;
  const cadenceDerived = usesCadenceDerivedBackfill(input.pack);
  const interval = cadenceDerived ? input.cadence : input.legacyFirstRunLookback;
  if (!interval || interval === "off") return null;
  if (!input.activationWatermark) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  const lookbackMinutes = strategyPackIntervalMinutes(interval);
  const end = Date.parse(input.windowEndAt);
  const activation = Date.parse(input.activationWatermark);
  if (lookbackMinutes === null || !Number.isFinite(end) || !Number.isFinite(activation) || activation > end) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  return new Date(cadenceDerived
    ? end - lookbackMinutes * 60_000
    : Math.max(activation, end - lookbackMinutes * 60_000)).toISOString();
}

/** @deprecated Historical 1.1.0 compatibility wrapper. */
export function resolvePublicCommentaryFirstRunLookbackStart(input: {
  readonly activationWatermark?: string | null;
  readonly firstRunLookback: "off" | "hours_1" | "hours_6" | "hours_12" | "hours_24";
  readonly initialBaseline: boolean;
  readonly windowEndAt: string;
}): string | null {
  return resolvePublicCommentaryFirstRunStart({
    activationWatermark: input.activationWatermark,
    cadence: "minutes_10",
    initialBaseline: input.initialBaseline,
    legacyFirstRunLookback: input.firstRunLookback,
    pack: { id: "inverse-cramer", version: "1.1.0" },
    windowEndAt: input.windowEndAt,
  });
}

export function resolvePublicCommentaryCommitInitialBaseline(input: Readonly<{
  cadenceDerivedBackfill?: boolean;
  checkpointOnlyBaseline: boolean;
  firstRunLookback?: unknown;
}>): boolean {
  return input.checkpointOnlyBaseline &&
    input.cadenceDerivedBackfill !== true &&
    (input.firstRunLookback === undefined || input.firstRunLookback === "off");
}

export async function drainPublicCommentaryHybridWorker(
  request: Parameters<typeof startHybridEvidenceWorkerTask>[0],
  startWorker: typeof startHybridEvidenceWorkerTask = startHybridEvidenceWorkerTask,
): Promise<void> {
  const handle = await startWorker(request);
  const reader = handle.events.getReader();
  let completed = false;
  let terminalFailure: Readonly<{ code: string; message: string }> | null = null;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const event = next.value;
      if (
        event.type === "action.result" &&
        event.data.status === "completed" &&
        event.data.result.kind === "tool-result" &&
        event.data.result.toolName === "complete_hybrid_evidence_job" &&
        event.data.result.isError !== true
      ) {
        completed = true;
        // The completion tool has already durably committed the candidate.
        // Do not wait for Eve's trailing session stream to settle: the parent
        // workspace occurrence must still validate and accept that candidate
        // within its own bounded execution window. Releasing the reader (and
        // deliberately not cancelling it) lets the child session settle on
        // its own without generating a post-completion cancellation failure.
        break;
      }
      if (
        event.type === "step.failed" ||
        event.type === "turn.failed" ||
        event.type === "session.failed"
      ) terminalFailure = Object.freeze({ code: event.data.code, message: event.data.message });
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) {
    const suffix = terminalFailure
      ? `${terminalFailure.code}:${terminalFailure.message}`
      : "completion_missing";
    throw new Error(`hybrid_evidence_worker_failed:${suffix}`);
  }
}

export function createProductionPublicCommentaryPipeline(input: {
  readonly allowedModelIds: readonly string[];
  readonly clients?: PublicCommentaryWorkspaceWorkerClients;
  readonly environment: NodeJS.ProcessEnv;
  readonly monitor: WorkspaceMonitor;
  readonly now: Date;
  readonly runId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly workspaceGeneration: number;
}) {
  const clients = input.clients;
  const source = input.monitor.sources.length === 1 ? input.monitor.sources[0] : null;
  if (!source) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  const reviewedSource = resolveReviewedPublicSource(source.sourceId);
  const xSource = reviewedSource.adapterDefinition.adapterId === "x-public-statements";
  if (!xSource && reviewedSource.adapterDefinition.adapterId !== "official-web-statements") {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  const evidence = resolveXEvidence(input.environment, clients?.xEvidence);
  const artifacts = clients?.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
  const fetchResponse = xSource
    ? clients?.fetchResponse ?? createXPublicStatementFetch({ environment: input.environment })
    : null;
  const officialWebFetch = xSource ? null : createOfficialWebStatementFetch();
  const semanticSubjects = new Map<string, Readonly<{
    acquisitionId: string;
    factPayloadDigest: string;
    sourceInstanceId: string;
    subscriptionId: string;
  }>>();
  const semanticRoute = resolveHybridTaskModelRoute("semantic_interpretation", input.environment);
  assertHybridModelRouteAllowed(semanticRoute, input.allowedModelIds);
  const managed = input.monitor.managedBy;
  const managedPack = managed ? strategyPackCatalog.resolve({
    contentDigest: managed.packContentDigest,
    id: managed.packId,
    version: managed.packVersion,
  }) : null;
  if (!managedPack || managedPack.availability !== "available") {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  // Which declared evaluation contract a pack carries decides whether the model
  // sees every statement or a deterministic rule pre-filters them. No pack
  // identifier is consulted.
  const declares = (ids: readonly string[]) =>
    managedPack.evidenceContracts?.some(({ id }) => ids.includes(id)) ?? false;
  const directModelActionability = declares(PUBLIC_COMMENTARY_DIRECT_MODEL_DEFINITION_IDS);
  const compactActionability = declares(PUBLIC_COMMENTARY_COMPACT_EVALUATION_DEFINITION_IDS);
  const configuredImpactEvaluation = declares([PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID]);
  const interpretation = resolvePublicCommentaryInterpretationContract(managedPack);
  if (!interpretation) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  const definition = configuredImpactEvaluation
    ? createPublicCommentaryImpactDefinition(
        [semanticRoute.modelId],
        { allowedAdapterIds: [reviewedSource.adapterDefinition.adapterId] },
        publicCommentaryImpactDefinitionVersion(managedPack),
      )
    : compactActionability
    ? createInverseCramerActionabilityDefinition([semanticRoute.modelId], {
        allowedAdapterIds: [reviewedSource.adapterDefinition.adapterId],
      })
    : directModelActionability
    ? createInverseCramerSemanticDefinition([semanticRoute.modelId], {
        allowedAdapterIds: [reviewedSource.adapterDefinition.adapterId],
        definitionVersion: managedPack.version === "1.4.1"
          ? "1.0.0"
          : managedPack.version === "1.4.2"
          ? "1.0.1"
          : managedPack.version === "1.4.3"
          ? "1.0.2"
          : "1.0.3",
      })
    : createCommentarySemanticDefinition([semanticRoute.modelId], {
        allowedAdapterIds: [reviewedSource.adapterDefinition.adapterId],
      });
  const semanticReasoning = resolvePublicCommentarySemanticReasoning(managedPack, semanticRoute);
  let occurrenceCorrections: Awaited<ReturnType<typeof materializePublicCommentaryCorrection>>[] = [];
  let pendingRehydrationAcknowledgements: Readonly<{
    outcomeId: string;
    stablePostId: string;
  }>[] = [];

  const pipeline = createPublicCommentaryPipeline({
    acquireAndProject: async ({ cadenceMinutes, firstRunLookback, includeQuotePosts, includeReplies, pack, scope, window }) => {
      occurrenceCorrections = [];
      pendingRehydrationAcknowledgements = [];
      const authorized = await authorizeWorkspaceSourceFetch({
        runId: input.runId,
        scope,
        sourceId: source.sourceId,
        url: source.canonicalUrl,
      }, clients?.sourceCoverage);
      const budget = await readWorkspaceDocument("budget", scope, clients?.state);
      if (!budget) throw new Error("public_commentary_budget_policy_unresolved");
      const timelineReservationId = `x-timeline.${createHash("sha256").update(input.runId).digest("hex")}`;
      const timelineReservation = xSource ? await reserveWorkspaceRunBudget({
        inputTokens: 0,
        kind: "paid_source_attempt",
        now: input.now,
        outputTokens: 0,
        paidCostCeiling: { amount: "1.000000", kind: "known" },
        parentRunId: input.runId,
        policy: budget.value,
        policyRevision: budget.revision,
        runId: timelineReservationId,
        scope,
      }, clients?.semantic?.budget) : null;
      await reserveWorkspaceSourceAttempt({
        now: input.now,
        runId: input.runId,
        scope,
        sourceId: authorized.sourceId,
      }, clients?.sourceCoverage);
      let coordinated: Awaited<ReturnType<typeof coordinatePublicSourceOccurrence>>;
      let firstRunStartAt: string | null = null;
      try {
        firstRunStartAt = resolvePublicCommentaryFirstRunStart({
          activationWatermark: input.monitor.activationWatermark,
          cadence: cadenceMinutes,
          initialBaseline: isWorkspaceMonitorCheckpointOnlyBaseline(input.monitor),
          legacyFirstRunLookback: firstRunLookback,
          pack,
          windowEndAt: window.endAt,
        });
        coordinated = await coordinatePublicSourceOccurrence({
        clients: {
          acquisition: clients?.acquisition,
          subscription: clients?.subscription,
        },
        environment: input.environment,
          fetch: xSource ? {
            adapterId: "x-public-statements" as const,
            evidence,
            excludeReplies: includeReplies === "exclude",
            firstRunStartAt,
            fetchResponse: timelineReservation?.state === "reserved"
              ? fetchResponse!
              : async () => { throw new Error("x_paid_timeline_replay_without_receipt"); },
          } : {
            adapterId: "official-web-statements" as const,
            evidence,
            fetchResponse: officialWebFetch!,
          },
        monitor: input.monitor,
        observedAt: input.now,
        scope,
        sourceId: source.sourceId,
        window: !xSource && firstRunStartAt ? { endAt: window.endAt, startAt: firstRunStartAt } : window,
        });
      } catch (error) {
        if (timelineReservation?.state === "reserved") {
          await reconcileWorkspaceRunBudget({
            now: input.now,
            outcome: "uncertain",
            runId: timelineReservationId,
            scope,
          }, clients?.semantic?.budget);
        }
        throw error;
      }
      if (timelineReservation?.state === "reserved") {
        if (!coordinated.xReceipt) {
          await reconcileWorkspaceRunBudget({
            now: input.now,
            outcome: "uncertain",
            runId: timelineReservationId,
            scope,
          }, clients?.semantic?.budget);
          throw new PublicCommentaryWorkspaceWorkerError("public_commentary_source_unavailable");
        }
        await reconcileWorkspaceRunBudget({
          ...(coordinated.reused ? {} : {
            actualInputTokens: 0,
            actualOutputTokens: 0,
            actualPaidCost: coordinated.xReceipt.amountUsd,
          }),
          now: input.now,
          outcome: coordinated.reused ? "released" : "reconciled",
          runId: timelineReservationId,
          scope,
        }, clients?.semantic?.budget);
      }
      if (!coordinated.projection || !coordinated.workspaceCheckpoint) {
        throw new PublicCommentaryWorkspaceWorkerError("public_commentary_source_unavailable");
      }
      const projections: AuthorizedPublicSourceProjection[] = [
        ...coordinated.projection.projections,
      ];
      for (const { fact } of projections) {
        if (fact.payload.schemaVersion !== "public-statement/v1") continue;
        const statement = publicStatementSchema.parse(fact.payload.statement);
        if (!xSource) {
          if (statement.provider !== "web") throw new Error("official_web_statement_provider_invalid");
          continue;
        }
        if (statement.provider !== "x") throw new Error("x_statement_provider_invalid");
        if (
          (statement.role === "reply" && includeReplies === "exclude") ||
          (statement.role === "quote" && includeQuotePosts === "exclude")
        ) continue;
        await registerWorkspaceXPublicStatementForRehydration({
          scope,
          stablePostId: statement.stablePostId,
        }, evidence.client);
      }
      const reviewed = reviewedSource;
      if (xSource && reviewed.sourceInstance.configuration.kind !== "x_public_statements_user") {
        throw new Error("x_source_configuration_invalid");
      }
      const expectedXAuthorId = reviewed.sourceInstance.configuration.kind === "x_public_statements_user"
        ? reviewed.sourceInstance.configuration.numericUserId
        : null;
      const due = xSource ? await claimDueXPublicStatementsForRehydration({
        limit: 8,
        now: input.now,
        scope,
      }, evidence.client) : [];
      const lifecycleDigests: string[] = [];
      for (const [candidateIndex, candidate] of due.entries()) {
        let outcome: XPublicStatementRehydrationOutcome;
        if (candidate.disposition === "replay") {
          if (!candidate.outcome) throw new Error("x_rehydration_outcome_missing");
          outcome = candidate.outcome;
        } else if (candidate.disposition === "expire") {
          await purgeRevocableEvidence({
            client: evidence.client,
            envelopeId: `revocable-evidence.x.${candidate.stablePostId}`,
            lifecycle: "purged",
            observedAt: input.now.toISOString(),
            reason: "retention_expired",
          });
          outcome = await completeXPublicStatementRehydration({
            amountUsd: "0.000000",
            billablePostReads: 0,
            candidate,
            correctionRequired: true,
            lifecycle: "purged",
            now: input.now,
          }, evidence.client);
        } else {
          let providerPostId = candidate.providerPostId;
          const request = createXExactPostRequest(providerPostId);
          await authorizeWorkspaceXExactPostFetch({
            providerPostId: candidate.providerPostId,
            runId: input.runId,
            scope,
            sourceId: source.sourceId,
            url: request.url,
          }, clients?.sourceCoverage);
          const budget = await readWorkspaceDocument("budget", scope, clients?.state);
          if (!budget) throw new Error("public_commentary_budget_policy_unresolved");
          const reservationId = `x-exact.${createHash("sha256").update(JSON.stringify([
            input.runId,
            candidate.stablePostId,
            candidate.generation,
          ])).digest("hex")}`;
          await reserveWorkspaceRunBudget({
            inputTokens: 0,
            kind: "paid_source_attempt",
            now: input.now,
            outputTokens: 0,
            paidCostCeiling: { amount: "0.010000", kind: "known" },
            parentRunId: input.runId,
            policy: budget.value,
            policyRevision: budget.revision,
            runId: reservationId,
            scope,
          }, clients?.semantic?.budget);
          let response: XPublicStatementResponse;
          let billablePostReads = 0;
          try {
            response = await fetchResponse!(request);
            billablePostReads += response.status === 200 ? 1 : 0;
            const latestPostId = resolveXLatestEditPostId({
              expectedAuthorId: expectedXAuthorId!,
              providerPostId,
              response,
              stablePostId: candidate.stablePostId,
            });
            if (latestPostId !== providerPostId) {
              providerPostId = latestPostId;
              const latestRequest = createXExactPostRequest(providerPostId);
              await authorizeWorkspaceXExactPostFetch({
                providerPostId,
                runId: input.runId,
                scope,
                sourceId: source.sourceId,
                url: latestRequest.url,
              }, clients?.sourceCoverage);
              response = await fetchResponse!(latestRequest);
              billablePostReads += response.status === 200 ? 1 : 0;
            }
          } catch (error) {
            await reconcileWorkspaceRunBudget({
              now: input.now,
              outcome: "uncertain",
              runId: reservationId,
              scope,
            }, clients?.semantic?.budget);
            await deferXPublicStatementRehydration({ candidate, now: input.now }, evidence.client);
            throw error;
          }
          const amountUsd = (billablePostReads * 0.005).toFixed(6);
          await reconcileWorkspaceRunBudget({
            actualInputTokens: 0,
            actualOutputTokens: 0,
            actualPaidCost: amountUsd,
            now: input.now,
            outcome: "reconciled",
            runId: reservationId,
            scope,
          }, clients?.semantic?.budget);
          const lifecycleEndAt = new Date(
            Date.parse(window.endAt) + candidateIndex + 1,
          ).toISOString();
          let lifecycle: Awaited<ReturnType<typeof rehydrateXPublicStatement>>;
          try {
            lifecycle = await rehydrateXPublicStatement({
              client: clients?.acquisition,
              evidence,
              providerPostId,
              response,
              sourceInstance: reviewed.sourceInstance,
              stablePostId: candidate.stablePostId,
              window: {
                endAt: lifecycleEndAt,
                startAt: new Date(Date.parse(lifecycleEndAt) - 1).toISOString(),
              },
            });
          } catch (error) {
            await deferXPublicStatementRehydration({ candidate, now: input.now }, evidence.client);
            throw error;
          }
          if (lifecycle.lifecycle === "unavailable") {
            await deferXPublicStatementRehydration({ candidate, now: input.now }, evidence.client);
            throw new PublicCommentaryWorkspaceWorkerError("public_commentary_source_unavailable");
          }
          const replacementStatement = lifecycle.canonical?.fact.payload.schemaVersion === "public-statement/v1"
            ? publicStatementSchema.parse(lifecycle.canonical.fact.payload.statement)
            : null;
          if (replacementStatement?.provider === "web") {
            throw new Error("x_statement_provider_invalid");
          }
          outcome = await completeXPublicStatementRehydration({
            amountUsd,
            billablePostReads,
            candidate,
            canonicalAcquisitionId: lifecycle.canonical?.acquisition.acquisitionId,
            canonicalFactRevisionId: lifecycle.canonical?.fact.revisionId,
            correctionRequired: lifecycle.correctionRequired,
            lifecycle: lifecycle.lifecycle,
            now: input.now,
            replacementFactRevisionId: lifecycle.canonical?.fact.revisionId,
            replacementProviderPostId: replacementStatement?.editChainIds.at(-1),
          }, evidence.client);
        }
        if (outcome.canonicalAcquisitionId) {
          const acquisition = await readPublicSourceAcquisitionResult(
            outcome.canonicalAcquisitionId,
            clients?.acquisition,
          );
          if (!acquisition) throw new Error("x_rehydration_acquisition_missing");
          const projected = await projectPublicSourceAcquisition({
            acquisition,
            projectedAt: input.now,
            scope,
            subscriptionId: coordinated.subscription.subscriptionId,
          }, {
            acquisition: clients?.acquisition,
            subscription: clients?.subscription,
          });
          projections.push(...projected.projections);
          lifecycleDigests.push(acquisition.proposedNextCursor!.contentDigest);
        }
        const correctionLifecycle = outcome.lifecycle === "purged" || outcome.lifecycle === "tombstoned"
          ? "deleted" as const
          : outcome.lifecycle === "deleted" || outcome.lifecycle === "edited" ||
              outcome.lifecycle === "protected" || outcome.lifecycle === "withheld"
            ? outcome.lifecycle
            : null;
        if (outcome.correctionRequired && correctionLifecycle) {
          const current = await readPublicCommentaryFindingByStatementRevision(
            scope,
            outcome.sourceFactRevisionId,
            clients?.commentaryFindings,
          );
          if (current && current.statement.lifecycle !== correctionLifecycle) {
            occurrenceCorrections.push(await materializePublicCommentaryCorrection({
              current,
              lifecycle: correctionLifecycle,
              now: input.now,
              scope,
              sourceRevision: current.statement.revision + 1,
            }, clients?.commentaryFindings));
          }
        }
        pendingRehydrationAcknowledgements = [...pendingRehydrationAcknowledgements, {
          outcomeId: outcome.outcomeId,
          stablePostId: candidate.stablePostId,
        }];
      }
      for (const correctionId of coordinated.acquisition.correctionIds) {
        const correction = await readPublicSourceCorrection(correctionId, clients?.acquisition);
        if (!correction) throw new Error("x_source_correction_missing");
        const replacement = projections.find(({ fact }) => fact.revisionId === correction.toRevisionId);
        if (!replacement || replacement.fact.payload.schemaVersion !== "public-statement/v1") {
          throw new Error("x_source_correction_projection_missing");
        }
        const replacementStatement = publicStatementSchema.parse(replacement.fact.payload.statement);
        if (replacementStatement.provider === "x" && replacementStatement.lifecycle !== "edited") continue;
        const current = await readPublicCommentaryFindingByStatementRevision(
          scope,
          correction.fromRevisionId,
          clients?.commentaryFindings,
        );
        if (current && current.statement.lifecycle !== "edited") {
          occurrenceCorrections.push(await materializePublicCommentaryCorrection({
            current,
              lifecycle: "edited",
            now: input.now,
            scope,
            sourceRevision: replacementStatement.revision,
          }, clients?.commentaryFindings));
        }
      }
      const checkpoint = Object.freeze({
        contentDigest: lifecycleDigests.length === 0
          ? coordinated.workspaceCheckpoint.contentDigest
          : createHash("sha256").update(JSON.stringify([
              coordinated.workspaceCheckpoint.contentDigest,
              ...lifecycleDigests.sort(),
            ])).digest("hex"),
        // Acquisition keeps its physical observation time as provenance. The
        // workspace checkpoint advances the logical occurrence window so a
        // normal dispatch delay cannot move the result outside its source fence.
        watermark: window.endAt,
      });
      await markWorkspaceSourceSuccess({
        contentDigest: checkpoint.contentDigest,
        now: input.now,
        runId: input.runId,
        scope,
        sourceId: authorized.sourceId,
      }, clients?.sourceCoverage);
      const cadenceDerivedBackfill = firstRunStartAt !== null && usesCadenceDerivedBackfill(pack);
      const lookbackActive = firstRunStartAt !== null && isWorkspaceMonitorCheckpointOnlyBaseline(input.monitor);
      const baseline = !lookbackActive && (coordinated.baselineEstablished ||
        isWorkspaceMonitorCheckpointOnlyBaseline(input.monitor));
      const statements = baseline ? [] : await Promise.all(projections
        .filter((projection, index, values) => values.findIndex(({ fact }) =>
          fact.revisionId === projection.fact.revisionId) === index)
        .filter(({ fact }) => fact.payload.schemaVersion === "public-statement/v1")
        .map(async ({ fact, projection }) => {
          if (fact.payload.schemaVersion !== "public-statement/v1") return null;
          const statement = publicStatementSchema.parse(fact.payload.statement);
          if (
            (!cadenceDerivedBackfill && statement.publishedAt <= input.monitor.activationWatermark!) ||
            (statement.lifecycle !== "final" && statement.lifecycle !== "edited") ||
            statement.contentReference === null
          ) return null;
          if (!xSource) {
            const lowerBound = firstRunStartAt ?? input.monitor.sourceCheckpoint.watermark ?? window.startAt;
            if (statement.publishedAt < lowerBound) {
              const alreadySeen = await readPublicCommentaryFindingByStatementRevision(
                scope,
                fact.revisionId,
                clients?.commentaryFindings,
              );
              if (alreadySeen) return null;
            }
          }
          const plaintext = await readRevocableEvidencePayload({
            client: evidence.client,
            encryptionKey: evidence.encryptionKey,
            envelopeId: statement.contentReference.envelopeId,
          });
          if (plaintext === null || statement.contentReference.revision !== statement.revision) {
            return null;
          }
          semanticSubjects.set(fact.revisionId, Object.freeze({
            acquisitionId: projection.acquisitionId,
            factPayloadDigest: fact.payloadDigest,
            sourceInstanceId: fact.sourceInstanceId,
            subscriptionId: coordinated.subscription.subscriptionId,
          }));
          return Object.freeze({
            plaintext,
            source: {
              accessClassification: "public" as const,
              adapterId: fact.adapterId,
              canonicalUrl: source.canonicalUrl,
              origin: new URL(source.canonicalUrl).origin,
              sourceId: source.sourceId,
              sourceInstanceId: fact.sourceInstanceId,
            },
            statement,
            statementRevisionId: fact.revisionId,
          });
        }));
      return Object.freeze({
        checkpoint,
        statements: Object.freeze(statements.filter((statement): statement is NonNullable<typeof statement> =>
          statement !== null)),
      });
    },
    attempts: clients?.attempts,
    budget: clients?.semantic?.budget,
    corroboration: clients?.corroboration ?? createExaWebCorroborationProvider(),
    findings: clients?.commentaryFindings,
    recoverExtraction: clients?.recoverExtraction ?? recoverNamedAssetCommentaryMetadata,
    state: clients?.state,
    directModelActionability,
    interpretation,
    interpret: async ({ plaintext, selectedSymbols, statement, statementRevisionId, strategyGuidance }) => {
      const subject = semanticSubjects.get(statementRevisionId);
      if (!subject) {
        throw new PublicCommentaryWorkspaceWorkerError("public_commentary_source_unavailable");
      }
      const bytes = Buffer.from(plaintext, "utf8");
      const artifact = await artifacts.persist({
        acquisitionId: subject.acquisitionId,
        authority: xSource ? "X" : "The White House",
        bytes,
        canonicalPublicUrl: statement.canonicalUrl,
        mediaType: "text/plain",
        now: input.now,
        observedAt: statement.observedAt,
        parserEligibility: null,
        sourceInstanceId: subject.sourceInstanceId,
        structure: {
          characterCount: plaintext.length,
          columnCount: null,
          pageCount: null,
          rowCount: null,
          sheetCount: null,
        },
      });
      const textLocator = Object.freeze({
        artifactDigest: artifact.contentDigest,
        end: plaintext.length,
        kind: "text_span" as const,
        spanDigest: digestPublicCommentaryEvidenceSpan(plaintext),
        start: 0,
      });
      try {
        const semantic = await runWorkspaceSemanticEvidenceBundleJob({
          definition,
          environment: input.environment,
          members: [{
            artifact,
            locators: [{
              factRevisionId: statementRevisionId,
              kind: "source_fact" as const,
              payloadDigest: subject.factPayloadDigest,
            }, textLocator],
            memberId: statementRevisionId,
            projectionReference: {
              factRevisionId: statementRevisionId,
              sourceId: source.sourceId,
              subscriptionId: subject.subscriptionId,
            },
            role: "subject_statement",
            semanticContext: Object.freeze({
              metadataOnly: false,
              selectedSymbols: Object.freeze([...selectedSymbols]),
              watchlistMode: selectedSymbols.length === 0 ? "all_resolved_assets" : "selected_symbols",
              ...(strategyGuidance ? { strategyGuidance } : {}),
            }),
          }],
          modelId: semanticRoute.modelId,
          now: input.now,
          pack: {
            contentDigest: input.monitor.managedBy!.packContentDigest,
            id: input.monitor.managedBy!.packId,
            version: input.monitor.managedBy!.packVersion,
          },
          parentBudgetRunId: input.runId,
          reasoning: semanticReasoning,
          scope: input.scope,
          workspaceGeneration: input.workspaceGeneration,
        }, {
          acquisition: clients?.acquisition,
          artifacts,
          budget: clients?.semantic?.budget,
          catalog: clients?.semantic?.catalog,
          execute: async (prepared) => clients?.semantic?.execute
            ? clients.semantic.execute(prepared)
            : drainPublicCommentaryHybridWorker(prepared.request),
          jobs: clients?.semantic?.jobs,
          lineage: clients?.semantic?.lineage,
          monitor: clients?.monitor,
          semantic: clients?.semantic?.semantic,
          state: clients?.state,
          subscription: clients?.subscription,
        });
        return Object.freeze({
          ...semantic,
          researchSubject: Object.freeze({
            acquisitionId: subject.acquisitionId,
            factPayloadDigest: subject.factPayloadDigest,
            plaintext,
            source: {
              accessClassification: "public" as const,
              adapterId: reviewedSource.adapterDefinition.adapterId,
              canonicalUrl: source.canonicalUrl,
              origin: new URL(source.canonicalUrl).origin,
              sourceId: source.sourceId,
              sourceInstanceId: subject.sourceInstanceId,
            },
            sourceInstanceId: subject.sourceInstanceId,
            statement,
            statementRevisionId,
            subscriptionId: subject.subscriptionId,
          }),
        });
      } finally {
        await artifacts.deleteUnreferenced(artifact.contentDigest);
      }
    },
  });
  return Object.freeze({
    async run(request: Parameters<typeof pipeline.run>[0]) {
      const result = await pipeline.run(request);
      const acknowledgements = pendingRehydrationAcknowledgements;
      let acknowledged = false;
      const acknowledgeDurableCommit = async () => {
        if (acknowledged) return;
        for (const acknowledgement of acknowledgements) {
          await acknowledgeXPublicStatementRehydration({
            ...acknowledgement,
            scope: input.scope,
          }, evidence.client);
        }
        acknowledged = true;
      };
      if (occurrenceCorrections.length === 0) {
        return Object.freeze({ ...result, acknowledgeDurableCommit });
      }
      const correctionFacts = occurrenceCorrections.flatMap(({ genericFinding }) =>
        genericFinding.facts ?? []);
      const regularFacts = result.finding?.facts ?? [];
      const correctionIdentities = occurrenceCorrections.flatMap(({ genericFinding }) =>
        genericFinding.factIdentities ?? []);
      const regularIdentities = result.finding?.factIdentities ?? [];
      const facts = [...correctionFacts, ...regularFacts].slice(0, 8);
      const factIdentities = [...correctionIdentities, ...regularIdentities].slice(0, 8);
      const provenance = [
        ...occurrenceCorrections.flatMap(({ genericFinding }) => genericFinding.provenance),
        ...(result.finding?.provenance ?? []),
      ].filter((candidate, index, values) => values.findIndex((value) =>
        value.sourceId === candidate.sourceId && value.canonicalUrl === candidate.canonicalUrl) === index);
      const combined = Object.freeze({
        ...result,
        acknowledgeDurableCommit,
        alertPresentation: occurrenceCorrections[0]!.alertPresentation,
        finding: workspaceFindingCandidateSchema.parse({
          accessClassification: "public" as const,
          artifactRefs: [
            ...occurrenceCorrections.flatMap(({ genericFinding }) => genericFinding.artifactRefs),
            ...(result.finding?.artifactRefs ?? []),
          ].filter((reference): reference is string => reference !== undefined).slice(0, 8),
          asOf: input.now.toISOString(),
          factIdentities,
          facts,
          provenance,
          summary: `${occurrenceCorrections.length} source correction${occurrenceCorrections.length === 1 ? "" : "s"} invalidated prior public-commentary research.${result.finding ? ` ${result.finding.summary}` : ""}`,
        }),
      });
      return combined;
    },
  });
}

type InverseCramerResearchRuntime = Readonly<{
  definition: ReturnType<typeof createInverseCramerResearchDefinition>;
  modelId: string;
  pack: StrategyPackCatalogEntry;
  reasoning: ReturnType<typeof resolveHybridTaskModelRoute>["reasoning"];
  workspaceGeneration: number;
}>;

// The pack pins which immutable version of the classification contract it runs.
export function publicCommentaryImpactDefinitionVersion(
  pack: Pick<StrategyPackCatalogEntry, "evidenceContracts">,
): (typeof PUBLIC_COMMENTARY_IMPACT_DEFINITION_VERSIONS)[number] {
  const declared = pack.evidenceContracts?.find(
    ({ id }) => id === PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
  )?.version;
  return PUBLIC_COMMENTARY_IMPACT_DEFINITION_VERSIONS.includes(
    declared as (typeof PUBLIC_COMMENTARY_IMPACT_DEFINITION_VERSIONS)[number],
  )
    ? declared as (typeof PUBLIC_COMMENTARY_IMPACT_DEFINITION_VERSIONS)[number]
    : "1.0.0";
}

export function resolvePublicCommentarySemanticReasoning(
  pack: Pick<StrategyPackCatalogEntry, "evidenceContracts">,
  configured: Readonly<{ reasoning: "high" }>,
) {
  // A compact classification contract asks for one bounded judgement, not an
  // executive analysis, so it runs at low reasoning whichever strategy declares
  // it.
  return pack.evidenceContracts?.some(({ id }) =>
    PUBLIC_COMMENTARY_COMPACT_EVALUATION_DEFINITION_IDS.includes(id),
  ) === true ? "low" as const : configured.reasoning;
}

async function resolveInverseCramerResearchRuntime(input: {
  capabilities: Awaited<ReturnType<typeof resolveWorkspaceWorkerCapabilitySnapshot>>;
  clients?: PublicCommentaryWorkspaceWorkerClients;
  environment: NodeJS.ProcessEnv;
  monitor: WorkspaceMonitor;
  scope: AuthorizedWorkspaceStoreScope;
}): Promise<InverseCramerResearchRuntime | null> {
  const managed = input.monitor.managedBy;
  if (!managed || managed.packId !== "inverse-cramer") return null;
  const strategy = await readWorkspaceDocument("strategy", input.scope, input.clients?.state);
  const pack = strategyPackCatalog.resolve({
    contentDigest: managed.packContentDigest,
    id: managed.packId,
    version: managed.packVersion,
  });
  if (!pack || !isInverseCramerAgenticResearchPack(pack)) return null;
  const snapshot = strategy?.schemaVersion === 2
    ? strategy.value.pendingSnapshot ?? strategy.value.lastActiveSnapshot
    : null;
  if (
    strategy?.schemaVersion !== 2 || strategy.value.lifecycleState !== "active" ||
    strategy.value.pack?.id !== pack.id || strategy.value.pack.version !== pack.version ||
    strategy.value.pack.contentDigest !== pack.contentDigest ||
    snapshot?.workspaceGeneration === undefined
  ) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  const configured = resolveHybridTaskModelRoute("semantic_interpretation", input.environment);
  const candidates = input.capabilities.resolved.workerModelIds
    .flatMap((modelId) => (pack.evidenceContracts ?? []).flatMap((contract) =>
      contract.id === INVERSE_CRAMER_RESEARCH_DEFINITION_ID &&
          INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS.includes(
            contract.version as (typeof INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS)[number],
          )
        ? [createInverseCramerResearchDefinition(
            [modelId],
            contract.version as (typeof INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS)[number],
          )]
        : []
    ))
    .filter((definition) => pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest
    ));
  if (candidates.length !== 1 || candidates[0]?.allowedModelIds[0] !== configured.modelId) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  return Object.freeze({
    definition: candidates[0]!,
    modelId: configured.modelId,
    pack,
    reasoning: configured.reasoning,
    workspaceGeneration: snapshot.workspaceGeneration,
  });
}

export async function materializeInverseCramerExecutiveOutput(input: {
  asOf: string;
  approvedSupplementaryUrls: readonly string[];
  brief: WorkspaceExecutiveBrief;
  clients?: PublicCommentaryWorkspaceWorkerClients;
  factIdentities: readonly string[];
  officialUrls: readonly string[];
  scope: AuthorizedWorkspaceStoreScope;
  signal?: AbortSignal;
}): Promise<Readonly<{
  artifactRefs: readonly string[];
  presentation: { title: string; whyMatched: string };
}>> {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const officialUrls = new Set(input.officialUrls);
  const briefOfficialUrls = new Set(
    brief.sources.filter(({ role }) => role === "official").map(({ url }) => url),
  );
  const approvedSupplementaryUrls = new Set(input.approvedSupplementaryUrls);
  if (
    officialUrls.size !== briefOfficialUrls.size ||
    [...officialUrls].some((url) => !briefOfficialUrls.has(url)) ||
    brief.sources.some(({ role, url }) =>
      role === "supplementary" && !approvedSupplementaryUrls.has(url)
    ) ||
    brief.materialFacts.some(({ sourceUrls }) =>
      !sourceUrls.some((url) => officialUrls.has(url))
    )
  ) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  const presentation = publicCommentaryAlertPresentationForBrief(brief);
  if (!shouldPublishWorkspaceExecutiveArtifact({
    alertText: `${presentation.title}\n\n${presentation.whyMatched}`,
    brief,
  })) {
    return Object.freeze({ artifactRefs: Object.freeze([]), presentation });
  }
  const artifactId = publicCommentaryReportArtifactId({
    factIdentities: input.factIdentities,
    ownerId: input.scope.ownerId,
    workspaceId: input.scope.workspaceId,
  });
  const published = await (input.clients?.publishReport ?? publishReportArtifact)({
    artifactId,
    report: buildPublicCommentarySignalReport({
      asOf: input.asOf,
      brief,
    }),
    signal: input.signal,
  });
  if (published.artifactId !== artifactId || published.kind !== "report") {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  }
  return Object.freeze({
    artifactRefs: Object.freeze([artifactReferenceForId(artifactId)]),
    presentation,
  });
}

async function runInverseCramerExecutiveResearch(input: {
  clients?: PublicCommentaryWorkspaceWorkerClients;
  environment: NodeJS.ProcessEnv;
  now: Date;
  parentRunId: string;
  result: PublicCommentaryPipelineResult;
  runtime: InverseCramerResearchRuntime;
  scope: AuthorizedWorkspaceStoreScope;
  signal?: AbortSignal;
}): Promise<PublicCommentaryPipelineResult> {
  if (!input.result.finding) return input.result;
  const facts = (input.result.finding.facts ?? []).flatMap((fact) => {
    if (fact.kind !== "public_commentary_signal") return [];
    const finding = commentaryFindingSchema.parse(fact.finding);
    return finding.outcome === "accepted" ? [{ fact, finding }] : [];
  });
  if (facts.length === 0) return input.result;
  if (facts.length !== input.result.finding.facts?.length || facts.length > 8) {
    return input.result;
  }
  const subjects = facts.map(({ finding }) => {
    const subject = input.result.researchSubjects?.find(
      ({ statementRevisionId }) => statementRevisionId === finding.statementRevisionId,
    );
    if (!subject) {
      throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
    }
    return { finding, subject };
  });
  const artifacts = input.clients?.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
  const persisted: Array<Readonly<{
    artifact: Awaited<ReturnType<HybridEvidenceArtifactStore["persist"]>>;
    content: string;
    finding: (typeof subjects)[number]["finding"];
    subject: PublicCommentaryResearchSubject;
  }>> = [];
  try {
    for (const { finding, subject } of subjects) {
      const content = JSON.stringify({
        canonicalUrl: subject.statement.canonicalUrl,
        confidence: finding.confidence,
        counterevidence: subject.counterevidence ?? [],
        findingId: finding.findingId,
        researchDirection: finding.policyDecision.researchDirection,
        statement: subject.plaintext,
        summary: subject.summary ?? finding.summary,
        uncertainty: subject.uncertainty ?? [],
      });
      const artifact = await artifacts.persist({
        acquisitionId: subject.acquisitionId,
        authority: "X",
        bytes: Buffer.from(content, "utf8"),
        canonicalPublicUrl: subject.statement.canonicalUrl,
        mediaType: "text/plain",
        now: input.now,
        observedAt: subject.statement.observedAt,
        parserEligibility: null,
        sourceInstanceId: subject.sourceInstanceId,
        structure: {
          characterCount: content.length,
          columnCount: null,
          pageCount: null,
          rowCount: null,
          sheetCount: null,
        },
      });
      persisted.push(Object.freeze({ artifact, content, finding, subject }));
    }
    const semantic = await runWorkspaceSemanticEvidenceBundleJob({
      definition: input.runtime.definition,
      environment: input.environment,
      members: persisted.map(({ artifact, content, subject }) => ({
        artifact,
        locators: [{
          factRevisionId: subject.statementRevisionId,
          kind: "source_fact" as const,
          payloadDigest: subject.factPayloadDigest,
        }, {
          artifactDigest: artifact.contentDigest,
          end: content.length,
          kind: "text_span" as const,
          spanDigest: digestPublicCommentaryEvidenceSpan(content),
          start: 0,
        }],
        memberId: subject.statementRevisionId,
        projectionReference: {
          factRevisionId: subject.statementRevisionId,
          sourceId: subject.source.sourceId,
          subscriptionId: subject.subscriptionId,
        },
        role: "section" as const,
        semanticContext: Object.freeze({ publicCommentaryFinding: true }),
      })),
      modelId: input.runtime.modelId,
      now: input.now,
      pack: {
        contentDigest: input.runtime.pack.contentDigest,
        id: input.runtime.pack.id,
        version: input.runtime.pack.version,
      },
      parentBudgetRunId: input.parentRunId,
      reasoning: input.runtime.reasoning,
      scope: input.scope,
      workspaceGeneration: input.runtime.workspaceGeneration,
    }, {
      acquisition: input.clients?.acquisition,
      artifacts,
      budget: input.clients?.semantic?.budget,
      catalog: input.clients?.semantic?.catalog,
      execute: async (prepared) => input.clients?.semantic?.execute
        ? input.clients.semantic.execute(prepared)
        : drainPublicCommentaryHybridWorker(prepared.request),
      jobs: input.clients?.semantic?.jobs,
      lineage: input.clients?.semantic?.lineage,
      monitor: input.clients?.monitor,
      semantic: input.clients?.semantic?.semantic,
      state: input.clients?.state,
      subscription: input.clients?.subscription,
    });
    const accepted = semantic.record.acceptedResult;
    if (!accepted) {
      throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
    }
    const brief = workspaceExecutiveBriefSchema.parse(accepted.payload);
    const output = await materializeInverseCramerExecutiveOutput({
      approvedSupplementaryUrls: semantic.record.researchUrlGrants,
      asOf: input.result.finding.asOf,
      brief,
      clients: input.clients,
      factIdentities: input.result.finding.factIdentities ?? [],
      officialUrls: subjects.map(({ subject }) => subject.statement.canonicalUrl),
      scope: input.scope,
      signal: input.signal,
    });
    const finding = workspaceFindingCandidateSchema.parse({
      ...input.result.finding,
      artifactRefs: [
        ...(input.result.finding.artifactRefs ?? []),
        ...output.artifactRefs,
      ].slice(0, 8),
      summary: output.presentation.whyMatched,
    });
    const alertPresentations = Object.freeze([Object.freeze({
      key: "inverse-cramer-executive-brief",
      ...output.presentation,
    })]);
    return Object.freeze({
      ...input.result,
      alertPresentation: output.presentation,
      alertPresentations,
      finding,
    });
  } finally {
    for (const { artifact } of persisted) {
      await artifacts.deleteUnreferenced(artifact.contentDigest);
    }
  }
}

export async function evaluatePublicCommentarySignalsForWorker(input: {
  readonly clients?: PublicCommentaryWorkspaceWorkerClients;
  readonly ctx: WorkerContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const envelope = requireWorkspaceWorkerAuth(input.ctx, {}, environment);
  const scope = authorizeWorkspaceWorkerStore(input.ctx, environment);
  const existing = await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, input.clients?.finding);
  if (existing) {
    // This occurrence already committed a durable outcome. Re-entering the
    // pipeline would re-acquire the source, and the run's source-coverage fence
    // correctly refuses that with `source_outside_fence`, so a duplicate tool
    // invocation could never reach its own replay path. Finalize from the
    // committed outcome instead, with no repeated source read, model call, paid
    // cost, finding, artifact, or alert.
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: INVERSE_CRAMER_EVALUATION_TOOL_ID,
    });
    return Object.freeze({
      analyzedStatements: existing.finding?.facts?.length ?? 0,
      outcome,
      replayed: true,
    });
  }
  const [capabilities, monitor, strategy] = await Promise.all([
    resolveWorkspaceWorkerCapabilitySnapshot({
      envelope,
      registry: [{ definition: true, metadata: { category: "control_plane", id: INVERSE_CRAMER_EVALUATION_TOOL_ID } }],
      scope,
      stateClient: input.clients?.state,
    }),
    getWorkspaceMonitor(scope, envelope.monitorId, input.clients?.monitor),
    readWorkspaceDocument("strategy", scope, input.clients?.state),
  ]);
  if (!(INVERSE_CRAMER_EVALUATION_TOOL_ID in capabilities.tools)) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_capability_denied");
  }
  if (
    !monitor || monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    !monitor.managedBy || !["inverse-cramer", "public-commentary-tracker"].includes(monitor.managedBy.packId) ||
    envelope.strategyPack?.packId !== monitor.managedBy.packId ||
    envelope.strategyPack.packContentDigest !== monitor.managedBy.packContentDigest
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  const sourceAdapterId = resolveReviewedPublicSource(monitor.sources[0]!.sourceId)
    .adapterDefinition.adapterId;
  if (!resolvePublicCommentaryRuntimeFlags(environment, {
    adapterId: sourceAdapterId === "official-web-statements"
      ? "official-web-statements"
      : "x-public-statements",
  }).strategyExecutionEnabled) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_execution_disabled");
  }
  if (
    strategy?.schemaVersion !== 2 || strategy.value.pack?.id !== monitor.managedBy.packId ||
    strategy.value.pack.contentDigest !== monitor.managedBy.packContentDigest ||
    strategy.value.pack.version !== monitor.managedBy.packVersion
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  const researchRuntime = await resolveInverseCramerResearchRuntime({
    capabilities,
    clients: input.clients,
    environment,
    monitor,
    scope,
  });
  const managedBy = monitor.managedBy;
  const strategyDisplayName = strategyPackCatalog.resolve({
    contentDigest: managedBy.packContentDigest,
    id: managedBy.packId,
    version: managedBy.packVersion,
  })?.displayName ?? null;
  const cadenceDerivedBackfill = usesCadenceDerivedBackfill({
    id: managedBy.packId,
    ...(monitor.lifecycleContractId
      ? { lifecycleContractId: monitor.lifecycleContractId }
      : {}),
    version: managedBy.packVersion,
  });
  const pipeline = input.clients?.pipeline ?? createProductionPublicCommentaryPipeline({
    allowedModelIds: capabilities.resolved.workerModelIds,
    clients: input.clients,
    environment,
    monitor,
    now,
    runId: envelope.runId,
    scope,
    workspaceGeneration: envelope.strategyPack.workspaceGeneration,
  });
  const pipelineResult = await pipeline.run({
    configuration: strategy.value.configuration,
    configurationGeneration: envelope.strategyPack.workspaceGeneration,
    environment,
    initialBackfill: isWorkspaceMonitorCheckpointOnlyBaseline(monitor) && cadenceDerivedBackfill,
    monitorId: monitor.monitorId,
    ownerId: scope.ownerId,
    parentBudgetRunId: envelope.runId,
    pack: {
      contentDigest: managedBy.packContentDigest,
      id: managedBy.packId as "inverse-cramer" | "public-commentary-tracker",
      ...(monitor.lifecycleContractId
        ? { lifecycleContractId: monitor.lifecycleContractId }
        : {}),
      version: managedBy.packVersion,
    },
    scope,
    ...(strategyDisplayName ? { strategyDisplayName } : {}),
    window: envelope.window,
  });
  const result = researchRuntime
    ? await runInverseCramerExecutiveResearch({
        clients: input.clients,
        environment,
        now,
        parentRunId: envelope.runId,
        result: pipelineResult,
        runtime: researchRuntime,
        scope,
        signal: input.ctx.abortSignal,
      })
    : pipelineResult;
  const outcome = await commitThenAcknowledgePublicCommentaryResult({
    acknowledge: result.acknowledgeDurableCommit,
    // A committed outcome already returned above, so this is always a first commit.
    commit: () => commitDeterministicWorkspaceEvaluationForWorker({
      alertPresentation: result.alertPresentation ?? undefined,
      alertPresentations: result.alertPresentations,
      checkpoint: result.checkpoint,
      clients: input.clients,
      ctx: input.ctx,
      environment,
      finding: result.finding,
      initialBaseline: resolvePublicCommentaryCommitInitialBaseline({
        cadenceDerivedBackfill,
        checkpointOnlyBaseline: isWorkspaceMonitorCheckpointOnlyBaseline(monitor),
        firstRunLookback: strategy.value.configuration.firstRunLookback,
      }),
      now,
      toolId: INVERSE_CRAMER_EVALUATION_TOOL_ID,
    }),
  });
  return Object.freeze({ analyzedStatements: result.analyzedStatements, outcome, replayed: false });
}

export const evaluatePublicCommentarySignalsTool = defineTool({
  description: "Run the bounded Inverse Cramer acquisition-projection, extraction, optional related-source search, semantic interpretation, registered policy, persistence, checkpoint, and at-most-once alert pipeline.",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    analyzedStatements: z.number().int().nonnegative().max(508),
    outcome: z.enum(["finding_staged", "no_match"]),
    replayed: z.boolean(),
    runId: z.string().min(1).max(160),
  }).strict(),
  async execute(_input, ctx) {
    const result = await evaluatePublicCommentarySignalsForWorker({ ctx });
    return {
      analyzedStatements: result.analyzedStatements,
      outcome: result.outcome.outcome,
      replayed: result.replayed,
      runId: result.outcome.runId,
    };
  },
});
