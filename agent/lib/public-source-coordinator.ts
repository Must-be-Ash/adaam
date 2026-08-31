import type {
  PublicSourceAcquisitionResult,
  PublicSourceSubscription,
} from "./public-source-adapter-schema";
import { publicSourceAcquisitionResultSchema } from "./public-source-adapter-schema";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import { readNextPublicSourceAcquisition, readPublicSourcePendingWork } from "./public-source-acquisition-store";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import {
  assertHybridModelRouteAllowed,
  resolveHybridTaskModelRoute,
  type HybridTaskModelRoute,
} from "./hybrid-evidence-model-routing";
import {
  HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION,
  type HouseHybridEvidenceRecoveryClients,
} from "./house-hybrid-evidence-recovery";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceGlobalBudgetClient } from "./workspace-dispatch-budget";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";
import {
  resolveEarningsCallPublicSourceRuntimePath,
  resolveHousePublicSourceRuntimePath,
  resolveOfficialWebStatementRuntimePath,
  resolveSecPublicSourceRuntimePath,
  resolveXPublicStatementRuntimePath,
} from "./public-source-flags";
import {
  emitPublicSourceAcquisitionObservations,
  emitPublicSourceRuntimeObservation,
  type PublicSourceRuntimeObservationSink,
} from "./public-source-observability";
import { resolveReviewedPublicSource } from "./public-source-registry";
import {
  createPublicSourceSubscription,
  type PublicSourceWorkspaceReference,
} from "./public-source-workspace-reference";
import {
  ensurePublicSourceSubscription,
  projectPublicSourceAcquisition,
  type PublicSourceProjectionCommit,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  runSharedHousePublicSourceAcquisition,
  type HouseHybridRecovery,
  type HousePublicSourceBinaryResponse,
} from "./house-public-source-adapter";
import {
  runSharedSecPublicSourceAcquisition,
  type SecPublicSourceResponse,
} from "./sec-public-source-adapter";
import {
  runSharedEarningsCallPublicSourceAcquisition,
  type EarningsCallPublicSourceRequest,
  type EarningsCallPublicSourceResponse,
  type EarningsCallTransientArtifact,
} from "./earnings-call-public-source-adapter";
import {
  runSharedXPublicStatementAcquisition,
  type XAcquisitionReceipt,
  type XPublicStatementRequest,
  type XPublicStatementResponse,
  type XRevocableEvidenceOptions,
} from "./x-public-statement-adapter";
import {
  runSharedOfficialWebStatementAcquisition,
  type OfficialWebStatementResponse,
} from "./official-web-statement-adapter";
import type { RevocableEvidenceStoreClient } from "./revocable-evidence-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import type { WorkspaceMonitor } from "./workspace-monitor-store";

type PublicSourceMonitor = Pick<
  WorkspaceMonitor,
  | "lifecycleState"
  | "managedBy"
  | "monitorId"
  | "publicSourceSubscriptions"
  | "workspaceId"
>;

type CoordinatorFetch =
  | {
      readonly adapterId: "official-web-statements";
      readonly evidence: {
        readonly client: RevocableEvidenceStoreClient;
        readonly encryptionKey: Uint8Array;
        readonly keyReference: string;
      };
      readonly fetchResponse: () => Promise<OfficialWebStatementResponse>;
    }
  | {
      readonly adapterId: "earnings-call-transcripts";
      readonly fetchResponse: (
        request: EarningsCallPublicSourceRequest,
      ) => Promise<EarningsCallPublicSourceResponse>;
      readonly onTransientArtifacts?: (
        artifacts: readonly EarningsCallTransientArtifact[],
      ) => void;
      readonly userAgent: string;
    }
  | {
      readonly adapterId: "sec-latest-filings";
      readonly fetchResponse: () => Promise<SecPublicSourceResponse>;
    }
  | {
      readonly adapterId: "house-financial-disclosures";
      readonly fetchDocument: (url: string) => Promise<HousePublicSourceBinaryResponse>;
      readonly fetchIndex: (url: string) => Promise<HousePublicSourceBinaryResponse>;
    }
  | {
      readonly adapterId: "x-public-statements";
      readonly evidence: XRevocableEvidenceOptions;
      readonly excludeReplies?: boolean;
      readonly firstRunStartAt?: string | null;
      readonly fetchResponse: (
        request: XPublicStatementRequest,
      ) => Promise<XPublicStatementResponse>;
    };

export interface PublicSourceHybridRecoveryExtension {
  readonly adapterId: "house-financial-disclosures";
  create(input: {
    readonly budgetScope?: AuthorizedWorkspaceStoreScope;
    readonly clients?: HouseHybridEvidenceRecoveryClients;
    readonly environment?: NodeJS.ProcessEnv;
    readonly initiatingWorkspaceId: string;
    readonly modelIds: readonly [extraction: string, independentOcr: string];
    readonly parentBudgetRunId?: string;
    readonly reasoning: "provider-default" | "low";
  }): HouseHybridRecovery;
}

const DEFAULT_HYBRID_RECOVERY_EXTENSIONS: readonly PublicSourceHybridRecoveryExtension[] =
  Object.freeze([HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION]);

function resolveHybridRecoveryExtension(input: {
  readonly adapterId: "house-financial-disclosures";
  readonly extensions?: readonly PublicSourceHybridRecoveryExtension[];
}): PublicSourceHybridRecoveryExtension | null {
  const matches = (input.extensions ?? DEFAULT_HYBRID_RECOVERY_EXTENSIONS)
    .filter((extension) => extension.adapterId === input.adapterId);
  return matches.length === 1 ? matches[0]! : null;
}

export interface PublicSourceCoordinatorResult {
  readonly sourceRetryAfterSeconds?: number;
  readonly deliveryAcquisitionId?: string;
  readonly deliveryPending?: boolean;
  readonly acquisition: PublicSourceAcquisitionResult;
  readonly baselineEstablished: boolean;
  readonly projection: PublicSourceProjectionCommit | null;
  readonly reused: boolean;
  readonly subscription: PublicSourceSubscription;
  readonly xReceipt: XAcquisitionReceipt | null;
  readonly workspaceCheckpoint: {
    readonly contentDigest: string;
    readonly watermark: string;
  } | null;
}

export class PublicSourceCoordinatorError extends Error {
  readonly code:
    | "public_source_disabled"
    | "public_source_misconfigured"
    | "public_source_reference_invalid";

  constructor(code: PublicSourceCoordinatorError["code"]) {
    super(code);
    this.code = code;
    this.name = "PublicSourceCoordinatorError";
  }
}

function requireEnabled(
  adapterId: CoordinatorFetch["adapterId"],
  environment: NodeJS.ProcessEnv,
): void {
  const path = adapterId === "sec-latest-filings"
    ? resolveSecPublicSourceRuntimePath(environment)
    : adapterId === "earnings-call-transcripts"
      ? resolveEarningsCallPublicSourceRuntimePath(environment)
      : adapterId === "x-public-statements"
        ? resolveXPublicStatementRuntimePath(environment)
        : adapterId === "official-web-statements"
          ? resolveOfficialWebStatementRuntimePath(environment)
        : resolveHousePublicSourceRuntimePath(environment);
  if (path === "public_source_adapter") return;
  throw new PublicSourceCoordinatorError(
    path === "public_source_misconfigured"
      ? "public_source_misconfigured"
      : "public_source_disabled",
  );
}

function requireReference(input: {
  readonly monitor: PublicSourceMonitor;
  readonly sourceId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
}): PublicSourceWorkspaceReference {
  const reference = input.monitor.publicSourceSubscriptions?.find(
    (candidate) => candidate.sourceId === input.sourceId,
  );
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  if (
    !reference ||
    input.monitor.workspaceId !== input.scope.workspaceId ||
    reference.sourceInstanceId !== reviewed.sourceInstance.sourceInstanceId ||
    reference.adapterDefinitionDigest !== reviewed.adapterDefinition.definitionDigest ||
    reference.sourceConfigurationDigest !== reviewed.sourceInstance.configurationDigest
  ) {
    throw new PublicSourceCoordinatorError("public_source_reference_invalid");
  }
  return reference;
}

function emitWriteCount(input: {
  readonly counter:
    | "public_source_fact_revision_total"
    | "public_source_correction_total"
    | "public_source_retraction_total"
    | "public_source_projection_total";
  readonly count: number;
  readonly operation: "created" | "reused";
  readonly sink?: PublicSourceRuntimeObservationSink;
}): void {
  if (input.count === 0) return;
  emitPublicSourceRuntimeObservation({
    counter: input.counter,
    operation: input.operation,
    value: input.count,
  }, input.sink);
}

export async function coordinatePublicSourceOccurrence(input: {
  readonly continueIncompleteHouse?: boolean;
  readonly clients?: {
    readonly acquisition?: PublicSourceAcquisitionStoreClient;
    readonly hybridArtifacts?: HybridEvidenceArtifactStore;
    readonly hybridGlobalBudget?: WorkspaceGlobalBudgetClient;
    readonly hybridJobs?: HybridEvidenceJobStoreClient;
    readonly hybridLineage?: HybridEvidenceLineageStoreClient;
    readonly hybridState?: WorkspaceStateStoreClient;
    readonly hybridWorkspaceBudget?: WorkspaceBudgetLedgerClient;
    readonly subscription?: PublicSourceSubscriptionStoreClient;
  };
  readonly deferProjectionAcknowledgement?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch: CoordinatorFetch;
  readonly hybridRecoveryExtensions?: readonly PublicSourceHybridRecoveryExtension[];
  readonly monitor: PublicSourceMonitor;
  readonly observedAt?: Date;
  readonly parentBudgetRunId?: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly sink?: PublicSourceRuntimeObservationSink;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<PublicSourceCoordinatorResult> {
  const environment = input.environment ?? process.env;
  const window = Object.freeze({
    endAt: input.window.endAt,
    startAt: input.window.startAt,
  });
  requireEnabled(input.fetch.adapterId, environment);
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  if (reviewed.adapterDefinition.adapterId !== input.fetch.adapterId) {
    throw new PublicSourceCoordinatorError("public_source_reference_invalid");
  }
  const reference = requireReference(input);
  const hybridFlags = resolveHybridEvidenceFlags(environment);
  const recoveryModelIds = environment.EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  let recoveryRoute: Extract<HybridTaskModelRoute, { executionClass: "fast" }> | null = null;
  let frontierModelId: string | null = null;
  if (
    input.fetch.adapterId === "house-financial-disclosures" &&
    hybridFlags.extractionRecovery
  ) {
    try {
      recoveryRoute = resolveHybridTaskModelRoute(
        "extraction_recovery",
        environment,
      );
      frontierModelId = resolveHybridTaskModelRoute(
        "semantic_interpretation",
        environment,
      ).modelId;
      assertHybridModelRouteAllowed(recoveryRoute, recoveryModelIds);
    } catch {
      throw new PublicSourceCoordinatorError("public_source_misconfigured");
    }
  }
  const configuredIndependentOcrModelId = environment.EVE_HOUSE_INDEPENDENT_OCR_MODEL_ID;
  const configuredHouseExtractionModelId = environment.EVE_HOUSE_EXTRACTION_MODEL_ID;
  const houseExtractionModelId = recoveryRoute
    ? configuredHouseExtractionModelId === undefined
      ? recoveryRoute.modelId
      : configuredHouseExtractionModelId === configuredHouseExtractionModelId.trim() &&
        /^[a-z0-9-]+\/[a-z0-9._-]+$/u.test(configuredHouseExtractionModelId) &&
        recoveryModelIds.includes(configuredHouseExtractionModelId)
      ? configuredHouseExtractionModelId
      : null
    : null;
  const independentOcrModelId = recoveryRoute && houseExtractionModelId
    ? configuredIndependentOcrModelId === undefined
      ? recoveryModelIds.find((modelId) =>
          modelId !== houseExtractionModelId &&
          modelId !== frontierModelId) ?? null
      : configuredIndependentOcrModelId === configuredIndependentOcrModelId.trim() &&
        /^[a-z0-9-]+\/[a-z0-9._-]+$/u.test(configuredIndependentOcrModelId) &&
        configuredIndependentOcrModelId !== houseExtractionModelId &&
        configuredIndependentOcrModelId !== frontierModelId &&
        recoveryModelIds.includes(configuredIndependentOcrModelId)
      ? configuredIndependentOcrModelId
      : null
    : null;
  const recoveryExtension = input.fetch.adapterId === "house-financial-disclosures"
    ? resolveHybridRecoveryExtension({
        adapterId: input.fetch.adapterId,
        extensions: input.hybridRecoveryExtensions,
      })
    : null;
  if (
    input.fetch.adapterId === "house-financial-disclosures" &&
    hybridFlags.extractionRecovery &&
    (
      !recoveryRoute ||
      !houseExtractionModelId ||
      !independentOcrModelId ||
      !recoveryExtension
    )
  ) throw new PublicSourceCoordinatorError("public_source_misconfigured");
  const earningsFetch = input.fetch.adapterId === "earnings-call-transcripts"
    ? input.fetch
    : null;
  const houseFetch = input.fetch.adapterId === "house-financial-disclosures"
    ? input.fetch
    : null;
  const xFetch = input.fetch.adapterId === "x-public-statements"
    ? input.fetch
    : null;
  const officialWebFetch = input.fetch.adapterId === "official-web-statements"
    ? input.fetch
    : null;
  const subscription = await ensurePublicSourceSubscription(
    input.scope,
    createPublicSourceSubscription({
      binding: input.monitor.managedBy
        ? {
            bindingRevision: input.monitor.managedBy.bindingRevision,
            packContentDigest: input.monitor.managedBy.packContentDigest,
            packId: input.monitor.managedBy.packId,
            packVersion: input.monitor.managedBy.packVersion,
          }
        : null,
      lifecycleState: input.monitor.lifecycleState === "enabled" ? "active" : "paused",
      monitorId: input.monitor.monitorId,
      reference,
      workspaceId: input.scope.workspaceId,
    }),
    input.clients?.subscription,
  );
  const shared = input.fetch.adapterId === "sec-latest-filings"
    ? await runSharedSecPublicSourceAcquisition({
        client: input.clients?.acquisition,
        fetchResponse: input.fetch.fetchResponse,
        sourceId: input.sourceId,
        window,
      })
    : earningsFetch
      ? await runSharedEarningsCallPublicSourceAcquisition({
          client: input.clients?.acquisition,
          fetchResponse: earningsFetch.fetchResponse,
          sourceId: input.sourceId,
          userAgent: earningsFetch.userAgent,
          window,
        }).then((result) => {
          earningsFetch.onTransientArtifacts?.(result.transientArtifacts);
          return result;
        })
      : xFetch
        ? await runSharedXPublicStatementAcquisition({
            client: input.clients?.acquisition,
            evidence: xFetch.evidence,
            excludeReplies: xFetch.excludeReplies,
            fetchResponse: xFetch.fetchResponse,
            firstRunStartAt: xFetch.firstRunStartAt,
            sourceId: input.sourceId,
            window,
          })
        : officialWebFetch
          ? await runSharedOfficialWebStatementAcquisition({
              client: input.clients?.acquisition,
              evidence: officialWebFetch.evidence,
              fetchResponse: officialWebFetch.fetchResponse,
              sourceId: input.sourceId,
              window,
            })
        : await runSharedHousePublicSourceAcquisition({
            continueIncomplete: input.continueIncompleteHouse,
            client: input.clients?.acquisition,
            fetchDocument: houseFetch!.fetchDocument,
            fetchIndex: houseFetch!.fetchIndex,
            hybridLineageClient: input.clients?.hybridLineage,
            recovery: hybridFlags.extractionRecovery
              ? recoveryExtension!.create({
                  budgetScope: input.scope,
                  clients: {
                    artifacts: input.clients?.hybridArtifacts,
                    globalBudget: input.clients?.hybridGlobalBudget,
                    jobs: input.clients?.hybridJobs,
                    lineage: input.clients?.hybridLineage,
                    state: input.clients?.hybridState,
                    workspaceBudget: input.clients?.hybridWorkspaceBudget,
                  },
                  environment,
                  initiatingWorkspaceId: input.scope.workspaceId,
                  modelIds: [houseExtractionModelId!, independentOcrModelId!],
                  parentBudgetRunId: input.parentBudgetRunId,
                  reasoning: recoveryRoute!.reasoning,
                })
              : undefined,
            sourceId: input.sourceId,
            window,
          });
  const xReceipt = xFetch && "receipt" in shared
    ? shared.receipt as XAcquisitionReceipt
    : null;
  emitPublicSourceAcquisitionObservations(shared.acquisition, input.sink);
  if (shared.reused) {
    emitPublicSourceRuntimeObservation({
      counter: "public_source_acquisition_reused_total",
    }, input.sink);
  }
  if (shared.commit && !shared.reused) {
    emitWriteCount({ counter: "public_source_fact_revision_total", count: shared.commit.factsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_fact_revision_total", count: shared.commit.factsReused, operation: "reused", sink: input.sink });
    emitWriteCount({ counter: "public_source_correction_total", count: shared.commit.correctionsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_correction_total", count: shared.commit.correctionsReused, operation: "reused", sink: input.sink });
    emitWriteCount({ counter: "public_source_retraction_total", count: shared.commit.retractionsCreated, operation: "created", sink: input.sink });
    emitWriteCount({ counter: "public_source_retraction_total", count: shared.commit.retractionsReused, operation: "reused", sink: input.sink });
  }

  // Canonical source batches can commit resolved siblings, but an unresolved
  // House filing is not a successful workspace occurrence or delivery cursor.
  const incompleteHouse = houseFetch !== null && (
    shared.acquisition.coverage !== "complete" ||
    shared.acquisition.stageReceipts.some(({ status }) => status !== "complete")
  );
  if (!shared.journal || incompleteHouse || (shared.acquisition.status !== "complete" && shared.acquisition.status !== "no_change")) {
    const pending = incompleteHouse ? await readPublicSourcePendingWork(shared.acquisition.sourceInstanceId, input.clients?.acquisition,
      shared.acquisition.proposedNextCursor ? shared.acquisition.proposedNextCursor.expectedRevision + 1 : undefined) : null;
    const due = pending?.pending.length ? Math.min(...pending.pending.map(({ nextAttemptAt }) =>
      nextAttemptAt ? Date.parse(nextAttemptAt) : 0)) : 0;
    const sourceRetryAfterSeconds = Math.min(86_400, Math.max(60,
      Math.ceil((due - (input.observedAt ?? new Date()).getTime()) / 1000)));
    return Object.freeze({
      ...(incompleteHouse ? { sourceRetryAfterSeconds } : {}),
      acquisition: incompleteHouse && shared.journal
        ? publicSourceAcquisitionResultSchema.parse({
            ...shared.acquisition,
            coverage: shared.acquisition.coverage === "complete" ? "partial" : shared.acquisition.coverage,
            errorCode: "parser_incomplete",
            proposedNextCursor: null,
            retryAfterSeconds: null,
            status: "partial",
          })
        : shared.acquisition,
      baselineEstablished: shared.baselineEstablished,
      projection: null,
      reused: shared.reused,
      subscription,
      workspaceCheckpoint: null,
      xReceipt,
    });
  }
  const delivery = houseFetch ? await readNextPublicSourceAcquisition({
    sourceInstanceId: shared.acquisition.sourceInstanceId,
    afterAcquisitionId: subscription.deliveryCursor.lastAcquisitionId,
    throughRevision: shared.acquisition.proposedNextCursor!.expectedRevision,
  }, input.clients?.acquisition) : null;
  const deliveryAcquisition = delivery?.result ?? shared.acquisition;
  const deliveryPending = houseFetch && delivery ? await readNextPublicSourceAcquisition({
    sourceInstanceId: shared.acquisition.sourceInstanceId,
    afterAcquisitionId: deliveryAcquisition.acquisitionId,
    throughRevision: shared.acquisition.proposedNextCursor!.expectedRevision,
  }, input.clients?.acquisition) !== null : false;
  const projection = await projectPublicSourceAcquisition({
    acquisition: deliveryAcquisition,
    advanceDeliveryCursor: input.deferProjectionAcknowledgement !== true,
    projectedAt: input.observedAt,
    scope: input.scope,
    subscriptionId: subscription.subscriptionId,
  }, input.clients);
  emitWriteCount({
    counter: "public_source_projection_total",
    count: projection.projectionsCreated + projection.retractionsCreated,
    operation: "created",
    sink: input.sink,
  });
  emitWriteCount({
    counter: "public_source_projection_total",
    count: projection.projectionsReused + projection.retractionsReused,
    operation: "reused",
    sink: input.sink,
  });
  return Object.freeze({
    deliveryAcquisitionId: deliveryAcquisition.acquisitionId,
    deliveryPending,
    acquisition: shared.acquisition,
    baselineEstablished: deliveryAcquisition.baselineEstablished,
    projection,
    reused: shared.reused,
    subscription: projection.subscription,
    workspaceCheckpoint: Object.freeze({
      contentDigest: shared.acquisition.proposedNextCursor!.contentDigest,
      watermark: shared.acquisition.observedAt,
    }),
    xReceipt,
  });
}
