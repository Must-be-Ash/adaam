import { z } from "zod";

import { PUBLIC_SOURCE_ADAPTER_IDS, PUBLIC_SOURCE_ERROR_CODES } from "./public-source-adapter-schema";
import {
  readNextPublicSourceAcquisition,
  readPublicSourceAcquisitionJournal,
  readPublicSourceHealthRecord,
  readPublicSourceInstance,
  readPublicSourcePendingWork,
  readPublicSourceSequenceStart,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import {
  resolveEarningsCallPublicSourceRuntimePath,
  resolveHousePublicSourceRuntimePath,
  resolveOfficialWebStatementRuntimePath,
  resolveSecPublicSourceRuntimePath,
  resolveXPublicStatementRuntimePath,
} from "./public-source-flags";
import { resolveReviewedPublicSource } from "./public-source-registry";
import type { PublicSourceWorkspaceReference } from "./public-source-workspace-reference";
import {
  readPublicSourceSubscription,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const publicSourceWorkspaceHealthSchema = z.object({
  adapterId: z.enum(PUBLIC_SOURCE_ADAPTER_IDS),
  adapterVersion: z.string().max(40),
  cursor: z.object({
    revision: z.number().int().nonnegative(),
    watermark: z.string().max(200).nullable(),
  }).strict(),
  extraction: z.object({
    complete: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    state: z.enum(["complete", "partial", "unsupported"]),
    unsupported: z.number().int().nonnegative(),
  }).strict(),
  healthState: z.enum(["degraded", "healthy", "idle", "unavailable"]),
  lastCompleteAcquisition: z.object({
    observedAt: z.string().datetime({ offset: true }),
    status: z.enum(["complete", "no_change"]),
  }).strict().nullable(),
  lastOutcome: z.object({
    coverage: z.enum(["complete", "partial", "unsupported"]),
    errorCode: z.enum(PUBLIC_SOURCE_ERROR_CODES).nullable(),
    failureStage: z.enum(["transport", "archive", "xml", "pdf", "normalize"]).nullable(),
    observedAt: z.string().datetime({ offset: true }),
    status: z.enum(["complete", "no_change", "partial", "retryable_failure", "terminal_failure", "uncertain"]),
  }).strict().nullable(),
  lifecycleState: z.enum(["active", "paused", "retired"]),
  runtimeState: z.enum(["disabled", "enabled", "misconfigured"]),
  sourceId: z.string().min(2).max(160),
  sourceBacklog: z.object({
    phase: z.enum(["initial_baseline", "live"]),
    unresolvedFilings: z.number().int().nonnegative(),
  }).strict().nullable(),
  subscription: z.object({
    deliveryRevision: z.number().int().nonnegative(),
    lag: z.number().int().nonnegative(),
    state: z.enum(["behind", "caught_up", "not_initialized"]),
  }).strict(),
}).strict();

export type PublicSourceWorkspaceHealth = z.infer<
  typeof publicSourceWorkspaceHealthSchema
>;

function runtimeState(
  adapterId: PublicSourceWorkspaceHealth["adapterId"],
  environment: NodeJS.ProcessEnv,
): PublicSourceWorkspaceHealth["runtimeState"] {
  const path = adapterId === "sec-latest-filings"
    ? resolveSecPublicSourceRuntimePath(environment)
    : adapterId === "earnings-call-transcripts"
      ? resolveEarningsCallPublicSourceRuntimePath(environment)
      : adapterId === "x-public-statements"
        ? resolveXPublicStatementRuntimePath(environment)
        : adapterId === "official-web-statements"
          ? resolveOfficialWebStatementRuntimePath(environment)
        : resolveHousePublicSourceRuntimePath(environment);
  if (path === "public_source_adapter") return "enabled";
  if (path === "public_source_misconfigured") return "misconfigured";
  return "disabled";
}

export function unavailablePublicSourceWorkspaceHealth(
  reference: PublicSourceWorkspaceReference,
  environment: NodeJS.ProcessEnv = process.env,
): PublicSourceWorkspaceHealth {
  const reviewed = resolveReviewedPublicSource(reference.sourceId);
  return publicSourceWorkspaceHealthSchema.parse({
    adapterId: reviewed.adapterDefinition.adapterId,
    adapterVersion: reviewed.adapterDefinition.adapterVersion,
    cursor: {
      revision: reviewed.sourceInstance.cursor.revision,
      watermark: reviewed.sourceInstance.cursor.watermark,
    },
    extraction: { complete: 0, partial: 0, state: "complete", unsupported: 0 },
    healthState: "unavailable",
    lastCompleteAcquisition: null,
    lastOutcome: null,
    lifecycleState: reviewed.sourceInstance.lifecycleState,
    runtimeState: runtimeState(reviewed.adapterDefinition.adapterId, environment),
    sourceId: reference.sourceId,
    sourceBacklog: null,
    subscription: { deliveryRevision: 0, lag: 0, state: "not_initialized" },
  });
}

export async function readPublicSourceWorkspaceHealth(input: {
  readonly clients?: {
    readonly acquisition?: PublicSourceAcquisitionStoreClient;
    readonly subscription?: PublicSourceSubscriptionStoreClient;
  };
  readonly environment?: NodeJS.ProcessEnv;
  readonly reference: PublicSourceWorkspaceReference;
  readonly scope: AuthorizedWorkspaceStoreScope;
}): Promise<PublicSourceWorkspaceHealth> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const reviewed = resolveReviewedPublicSource(input.reference.sourceId);
  if (
    input.reference.sourceInstanceId !== reviewed.sourceInstance.sourceInstanceId ||
    input.reference.adapterDefinitionDigest !== reviewed.adapterDefinition.definitionDigest ||
    input.reference.sourceConfigurationDigest !== reviewed.sourceInstance.configurationDigest
  ) throw new Error("public_source_reference_mismatch");
  const [storedSource, health, subscription] = await Promise.all([
    readPublicSourceInstance(input.reference.sourceInstanceId, input.clients?.acquisition),
    readPublicSourceHealthRecord(input.reference.sourceInstanceId, input.clients?.acquisition),
    readPublicSourceSubscription(input.scope, input.reference.subscriptionId, input.clients?.subscription),
  ]);
  const source = storedSource ?? reviewed.sourceInstance;
  const pendingWork = source.adapterId === "house-financial-disclosures"
    ? await readPublicSourcePendingWork(
        source.sourceInstanceId,
        input.clients?.acquisition,
        source.cursor.revision,
      )
    : null;
  const deliveryRevision = subscription?.deliveryCursor.revision ?? 0;
  // Delivery revisions count acknowledgements, not source acquisitions. The
  // journal pins the source position even after migration or skipped batches.
  const lastAcquisitionId = subscription?.deliveryCursor.lastAcquisitionId ?? null;
  let lag: number;
  if (source.adapterId === "house-financial-disclosures") {
    const next = await readNextPublicSourceAcquisition({
      sourceInstanceId: source.sourceInstanceId,
      afterAcquisitionId: lastAcquisitionId,
      throughRevision: source.cursor.revision - 1,
    }, input.clients?.acquisition);
    if (!next && source.cursor.revision > 0 &&
      await readPublicSourceSequenceStart(source.sourceInstanceId, input.clients?.acquisition) === null) {
      throw new Error("public_source_reference_mismatch");
    }
    lag = next ? Math.max(0, source.cursor.revision - next.journal.expectedCursorRevision) : 0;
  } else {
    const acknowledged = lastAcquisitionId
      ? await readPublicSourceAcquisitionJournal(lastAcquisitionId, input.clients?.acquisition)
      : null;
    if (lastAcquisitionId && (!acknowledged || acknowledged.status !== "committed" ||
      acknowledged.sourceInstanceId !== source.sourceInstanceId)) {
      throw new Error("public_source_reference_mismatch");
    }
    lag = Math.max(0, source.cursor.revision - (acknowledged ? acknowledged.expectedCursorRevision + 1 : 0));
  }
  const extraction = health?.extraction ?? {
    complete: 0,
    partial: 0,
    state: "complete" as const,
    unsupported: 0,
  };
  const degraded = health !== null && (
    health.lastOutcome.coverage !== "complete" ||
    health.lastOutcome.errorCode !== null ||
    extraction.state !== "complete"
  );
  return publicSourceWorkspaceHealthSchema.parse({
    adapterId: reviewed.adapterDefinition.adapterId,
    adapterVersion: reviewed.adapterDefinition.adapterVersion,
    cursor: {
      revision: source.cursor.revision,
      watermark: source.cursor.watermark,
    },
    extraction,
    healthState: degraded ? "degraded" : health ? "healthy" : "idle",
    lastCompleteAcquisition: health?.lastCompleteAcquisition
      ? {
          observedAt: health.lastCompleteAcquisition.observedAt,
          status: health.lastCompleteAcquisition.status,
        }
      : null,
    lastOutcome: health
      ? {
          coverage: health.lastOutcome.coverage,
          errorCode: health.lastOutcome.errorCode,
          failureStage: health.lastOutcome.failureStage,
          observedAt: health.lastOutcome.observedAt,
          status: health.lastOutcome.status,
        }
      : null,
    lifecycleState: source.lifecycleState,
    runtimeState: runtimeState(reviewed.adapterDefinition.adapterId, input.environment ?? process.env),
    sourceId: input.reference.sourceId,
    sourceBacklog: source.adapterId === "house-financial-disclosures"
      ? {
          phase: source.cursor.watermark?.startsWith("baseline:")
            ? "initial_baseline"
            : "live",
          unresolvedFilings: pendingWork?.cursorRevision === source.cursor.revision
            ? pendingWork.pending.length
            : 0,
        }
      : null,
    subscription: {
      deliveryRevision,
      lag,
      state: subscription === null ? "not_initialized" : lag === 0 ? "caught_up" : "behind",
    },
  });
}
