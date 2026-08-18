import { z } from "zod";

import { PUBLIC_SOURCE_ERROR_CODES } from "./public-source-adapter-schema";
import {
  readPublicSourceHealthRecord,
  readPublicSourceInstance,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import {
  resolveEarningsCallPublicSourceRuntimePath,
  resolveHousePublicSourceRuntimePath,
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
  adapterId: z.enum(["earnings-call-transcripts", "house-financial-disclosures", "sec-latest-filings", "x-public-statements"]),
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
  const deliveryRevision = subscription?.deliveryCursor.revision ?? 0;
  const lag = Math.max(0, source.cursor.revision - deliveryRevision);
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
    subscription: {
      deliveryRevision,
      lag,
      state: subscription === null ? "not_initialized" : lag === 0 ? "caught_up" : "behind",
    },
  });
}
