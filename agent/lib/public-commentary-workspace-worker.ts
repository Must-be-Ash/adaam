import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

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
  readPublicSourceAcquisitionResult,
  readPublicSourceCorrection,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import { coordinatePublicSourceOccurrence } from "./public-source-coordinator";
import { resolveReviewedPublicSource } from "./public-source-registry";
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
import { publicStatementSchema } from "./public-commentary-schema";
import {
  createCommentarySemanticDefinition,
  recoverNamedAssetCommentaryMetadata,
} from "./public-commentary-semantics";
import {
  createPublicCommentaryPipeline,
  materializePublicCommentaryCorrection,
} from "./public-commentary-vertical";
import {
  createDefaultRevocableEvidenceStoreClient,
  purgeRevocableEvidence,
  readRevocableEvidencePayload,
} from "./revocable-evidence-store";
import { INVERSE_CRAMER_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";
import { X_PUBLIC_STATEMENTS_SOURCE_ID } from "./strategy-pack-reference-catalog";
import { strategyPackCatalog } from "./strategy-pack-catalog";
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

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];

export interface PublicCommentaryPipelineResult {
  readonly acknowledgeDurableCommit?: () => Promise<void>;
  readonly alertPresentation: { readonly title: string; readonly whyMatched: string } | null;
  readonly analyzedStatements: number;
  readonly checkpoint: Readonly<{ readonly contentDigest: string; readonly watermark: string }>;
  readonly finding: WorkspaceFindingCandidate | null;
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
      monitorId: string;
      ownerId: string;
      pack: Readonly<{ contentDigest: string; id: "inverse-cramer"; version: string }>;
      scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
      window: Readonly<{ endAt: string; startAt: string }>;
    }>): Promise<PublicCommentaryPipelineResult>;
  }>;
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

export function resolvePublicCommentaryFirstRunLookbackStart(input: {
  readonly activationWatermark?: string | null;
  readonly firstRunLookback: "off" | "hours_1" | "hours_6" | "hours_12" | "hours_24";
  readonly initialBaseline: boolean;
  readonly windowEndAt: string;
}): string | null {
  if (!input.initialBaseline || input.firstRunLookback === "off") return null;
  if (!input.activationWatermark) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  const lookbackMinutes = strategyPackIntervalMinutes(input.firstRunLookback);
  const end = Date.parse(input.windowEndAt);
  const activation = Date.parse(input.activationWatermark);
  if (lookbackMinutes === null || !Number.isFinite(end) || !Number.isFinite(activation) || activation > end) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  return new Date(Math.max(activation, end - lookbackMinutes * 60_000)).toISOString();
}

export function resolvePublicCommentaryCommitInitialBaseline(input: Readonly<{
  checkpointOnlyBaseline: boolean;
  firstRunLookback: unknown;
}>): boolean {
  return input.checkpointOnlyBaseline &&
    (input.firstRunLookback === undefined || input.firstRunLookback === "off");
}

async function drainHybridWorker(
  request: Parameters<typeof startHybridEvidenceWorkerTask>[0],
): Promise<void> {
  const handle = await startHybridEvidenceWorkerTask(request);
  const reader = handle.events.getReader();
  try {
    while (!(await reader.read()).done) {
      // Completion is durably recorded by the compiled hybrid worker tool.
    }
  } finally {
    reader.releaseLock();
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
  const source = input.monitor.sources.find(({ sourceId }) =>
    sourceId === X_PUBLIC_STATEMENTS_SOURCE_ID);
  if (!source || input.monitor.sources.length !== 1) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  }
  const evidence = resolveXEvidence(input.environment, clients?.xEvidence);
  const artifacts = clients?.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
  const fetchResponse = clients?.fetchResponse ?? createXPublicStatementFetch({
    environment: input.environment,
  });
  const semanticSubjects = new Map<string, Readonly<{
    acquisitionId: string;
    factPayloadDigest: string;
    sourceInstanceId: string;
    subscriptionId: string;
  }>>();
  const semanticRoute = resolveHybridTaskModelRoute("semantic_interpretation", input.environment);
  assertHybridModelRouteAllowed(semanticRoute, input.allowedModelIds);
  const definition = createCommentarySemanticDefinition([semanticRoute.modelId]);
  let occurrenceCorrections: Awaited<ReturnType<typeof materializePublicCommentaryCorrection>>[] = [];
  let pendingRehydrationAcknowledgements: Readonly<{
    outcomeId: string;
    stablePostId: string;
  }>[] = [];

  const pipeline = createPublicCommentaryPipeline({
    acquireAndProject: async ({ firstRunLookback, scope, window }) => {
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
      const timelineReservation = await reserveWorkspaceRunBudget({
        inputTokens: 0,
        kind: "paid_source_attempt",
        now: input.now,
        outputTokens: 0,
        paidCostCeiling: { amount: "1.000000", kind: "known" },
        policy: budget.value,
        policyRevision: budget.revision,
        runId: timelineReservationId,
        scope,
      }, clients?.semantic?.budget);
      await reserveWorkspaceSourceAttempt({
        now: input.now,
        runId: input.runId,
        scope,
        sourceId: authorized.sourceId,
      }, clients?.sourceCoverage);
      let coordinated: Awaited<ReturnType<typeof coordinatePublicSourceOccurrence>>;
      try {
        const firstRunStartAt = resolvePublicCommentaryFirstRunLookbackStart({
          activationWatermark: input.monitor.activationWatermark,
          firstRunLookback,
          initialBaseline: isWorkspaceMonitorCheckpointOnlyBaseline(input.monitor),
          windowEndAt: window.endAt,
        });
        coordinated = await coordinatePublicSourceOccurrence({
        clients: {
          acquisition: clients?.acquisition,
          subscription: clients?.subscription,
        },
        environment: input.environment,
          fetch: {
            adapterId: "x-public-statements",
            evidence,
            firstRunStartAt,
          fetchResponse: timelineReservation.state === "reserved"
            ? fetchResponse
            : async () => { throw new Error("x_paid_timeline_replay_without_receipt"); },
        },
        monitor: input.monitor,
        observedAt: input.now,
        scope,
        sourceId: source.sourceId,
        window,
        });
      } catch (error) {
        if (timelineReservation.state === "reserved") {
          await reconcileWorkspaceRunBudget({
            now: input.now,
            outcome: "uncertain",
            runId: timelineReservationId,
            scope,
          }, clients?.semantic?.budget);
        }
        throw error;
      }
      if (timelineReservation.state === "reserved") {
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
        if (statement.provider !== "x") throw new Error("x_statement_provider_invalid");
        await registerWorkspaceXPublicStatementForRehydration({
          scope,
          stablePostId: statement.stablePostId,
        }, evidence.client);
      }
      const reviewed = resolveReviewedPublicSource(source.sourceId);
      if (reviewed.sourceInstance.configuration.kind !== "x_public_statements_user") {
        throw new Error("x_source_configuration_invalid");
      }
      const expectedXAuthorId = reviewed.sourceInstance.configuration.numericUserId;
      const due = await claimDueXPublicStatementsForRehydration({
        limit: 8,
        now: input.now,
        scope,
      }, evidence.client);
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
            policy: budget.value,
            policyRevision: budget.revision,
            runId: reservationId,
            scope,
          }, clients?.semantic?.budget);
          let response: XPublicStatementResponse;
          let billablePostReads = 0;
          try {
            response = await fetchResponse(request);
            billablePostReads += response.status === 200 ? 1 : 0;
            const latestPostId = resolveXLatestEditPostId({
              expectedAuthorId: expectedXAuthorId,
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
              response = await fetchResponse(latestRequest);
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
        if (replacementStatement.lifecycle !== "edited") continue;
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
      const checkpoint = lifecycleDigests.length === 0
        ? coordinated.workspaceCheckpoint
        : Object.freeze({
            contentDigest: createHash("sha256").update(JSON.stringify([
              coordinated.workspaceCheckpoint.contentDigest,
              ...lifecycleDigests.sort(),
            ])).digest("hex"),
            watermark: coordinated.workspaceCheckpoint.watermark,
          });
      await markWorkspaceSourceSuccess({
        contentDigest: checkpoint.contentDigest,
        now: input.now,
        runId: input.runId,
        scope,
        sourceId: authorized.sourceId,
      }, clients?.sourceCoverage);
      const lookbackActive = firstRunLookback !== "off" &&
        isWorkspaceMonitorCheckpointOnlyBaseline(input.monitor);
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
            statement.publishedAt <= input.monitor.activationWatermark! ||
            (statement.lifecycle !== "final" && statement.lifecycle !== "edited") ||
            statement.contentReference === null
          ) return null;
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
    interpret: async ({ plaintext, statement, statementRevisionId }) => {
      const subject = semanticSubjects.get(statementRevisionId);
      if (!subject) {
        throw new PublicCommentaryWorkspaceWorkerError("public_commentary_source_unavailable");
      }
      const bytes = Buffer.from(plaintext, "utf8");
      const artifact = await artifacts.persist({
        acquisitionId: subject.acquisitionId,
        authority: "X",
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
        spanDigest: createHash("sha256").update(plaintext).digest("hex"),
        start: 0,
      });
      try {
        return await runWorkspaceSemanticEvidenceBundleJob({
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
            semanticContext: Object.freeze({ metadataOnly: false }),
          }],
          modelId: semanticRoute.modelId,
          now: input.now,
          pack: {
            contentDigest: input.monitor.managedBy!.packContentDigest,
            id: "inverse-cramer",
            version: input.monitor.managedBy!.packVersion,
          },
          reasoning: semanticRoute.reasoning,
          scope: input.scope,
          workspaceGeneration: input.workspaceGeneration,
        }, {
          acquisition: clients?.acquisition,
          artifacts,
          budget: clients?.semantic?.budget,
          catalog: clients?.semantic?.catalog,
          execute: async (prepared) => clients?.semantic?.execute
            ? clients.semantic.execute(prepared)
            : drainHybridWorker(prepared.request),
          jobs: clients?.semantic?.jobs,
          lineage: clients?.semantic?.lineage,
          monitor: clients?.monitor,
          semantic: clients?.semantic?.semantic,
          state: clients?.state,
          subscription: clients?.subscription,
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
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: INVERSE_CRAMER_EVALUATION_TOOL_ID,
    });
    return Object.freeze({ analyzedStatements: 0, outcome, replayed: true });
  }
  if (!resolvePublicCommentaryRuntimeFlags(environment).strategyExecutionEnabled) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_execution_disabled");
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
    monitor.managedBy?.packId !== "inverse-cramer" ||
    envelope.strategyPack?.packId !== "inverse-cramer" ||
    envelope.strategyPack.packContentDigest !== monitor.managedBy.packContentDigest
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  if (
    strategy?.schemaVersion !== 2 || strategy.value.pack?.id !== "inverse-cramer" ||
    strategy.value.pack.contentDigest !== monitor.managedBy.packContentDigest ||
    strategy.value.pack.version !== monitor.managedBy.packVersion
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
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
  const result = await pipeline.run({
    configuration: strategy.value.configuration,
    configurationGeneration: envelope.strategyPack.workspaceGeneration,
    environment,
    monitorId: monitor.monitorId,
    ownerId: scope.ownerId,
    pack: {
      contentDigest: monitor.managedBy.packContentDigest,
      id: "inverse-cramer",
      version: monitor.managedBy.packVersion,
    },
    scope,
    window: envelope.window,
  });
  const outcome = await commitThenAcknowledgePublicCommentaryResult({
    acknowledge: result.acknowledgeDurableCommit,
    commit: () => commitDeterministicWorkspaceEvaluationForWorker({
      alertPresentation: result.alertPresentation ?? undefined,
      checkpoint: result.checkpoint,
      clients: input.clients,
      ctx: input.ctx,
      environment,
      finding: result.finding,
      initialBaseline: resolvePublicCommentaryCommitInitialBaseline({
        checkpointOnlyBaseline: isWorkspaceMonitorCheckpointOnlyBaseline(monitor),
        firstRunLookback: strategy.value.configuration.firstRunLookback ?? "off",
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
