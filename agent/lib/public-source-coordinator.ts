import type {
  PublicSourceAcquisitionResult,
  PublicSourceSubscription,
} from "./public-source-adapter-schema";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import {
  HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION,
  type HouseHybridEvidenceRecoveryClients,
} from "./house-hybrid-evidence-recovery";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceGlobalBudgetClient } from "./workspace-dispatch-budget";
import {
  resolveEarningsCallPublicSourceRuntimePath,
  resolveHousePublicSourceRuntimePath,
  resolveSecPublicSourceRuntimePath,
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
    };

export interface PublicSourceHybridRecoveryExtension {
  readonly adapterId: "house-financial-disclosures";
  create(input: {
    readonly clients?: HouseHybridEvidenceRecoveryClients;
    readonly environment?: NodeJS.ProcessEnv;
    readonly initiatingWorkspaceId: string;
    readonly modelIds: readonly [extraction: string, independentOcr: string];
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
  readonly acquisition: PublicSourceAcquisitionResult;
  readonly baselineEstablished: boolean;
  readonly projection: PublicSourceProjectionCommit | null;
  readonly reused: boolean;
  readonly subscription: PublicSourceSubscription;
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
  readonly clients?: {
    readonly acquisition?: PublicSourceAcquisitionStoreClient;
    readonly hybridArtifacts?: HybridEvidenceArtifactStore;
    readonly hybridGlobalBudget?: WorkspaceGlobalBudgetClient;
    readonly hybridJobs?: HybridEvidenceJobStoreClient;
    readonly hybridLineage?: HybridEvidenceLineageStoreClient;
    readonly hybridWorkspaceBudget?: WorkspaceBudgetLedgerClient;
    readonly subscription?: PublicSourceSubscriptionStoreClient;
  };
  readonly deferProjectionAcknowledgement?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch: CoordinatorFetch;
  readonly hybridRecoveryExtensions?: readonly PublicSourceHybridRecoveryExtension[];
  readonly monitor: PublicSourceMonitor;
  readonly observedAt?: Date;
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
      recoveryModelIds.length < 2 ||
      recoveryModelIds[0] === recoveryModelIds[1] ||
      !recoveryExtension
    )
  ) throw new PublicSourceCoordinatorError("public_source_misconfigured");
  const earningsFetch = input.fetch.adapterId === "earnings-call-transcripts"
    ? input.fetch
    : null;
  const houseFetch = input.fetch.adapterId === "house-financial-disclosures"
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
      : await runSharedHousePublicSourceAcquisition({
        client: input.clients?.acquisition,
        fetchDocument: houseFetch!.fetchDocument,
        fetchIndex: houseFetch!.fetchIndex,
        hybridLineageClient: input.clients?.hybridLineage,
        recovery: hybridFlags.extractionRecovery
          ? recoveryExtension!.create({
              clients: {
                artifacts: input.clients?.hybridArtifacts,
                globalBudget: input.clients?.hybridGlobalBudget,
                jobs: input.clients?.hybridJobs,
                lineage: input.clients?.hybridLineage,
                workspaceBudget: input.clients?.hybridWorkspaceBudget,
              },
              environment,
              initiatingWorkspaceId: input.scope.workspaceId,
              modelIds: [recoveryModelIds[0]!, recoveryModelIds[1]!],
            })
          : undefined,
        sourceId: input.sourceId,
        window,
      });
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

  if (!shared.journal || (shared.acquisition.status !== "complete" && shared.acquisition.status !== "no_change")) {
    return Object.freeze({
      acquisition: shared.acquisition,
      baselineEstablished: shared.baselineEstablished,
      projection: null,
      reused: shared.reused,
      subscription,
    });
  }
  const projection = await projectPublicSourceAcquisition({
    acquisition: shared.acquisition,
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
    acquisition: shared.acquisition,
    baselineEstablished: shared.baselineEstablished,
    projection,
    reused: shared.reused,
    subscription: projection.subscription,
  });
}
