import { z } from "zod";

import {
  publicSourceSubscriptionSchema,
  type PublicSourceSubscription,
} from "./public-source-adapter-schema";
import { resolveReviewedPublicSource } from "./public-source-registry";
import { derivePublicSourceSubscriptionId } from "./public-source-subscription-store";

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const publicSourceWorkspaceReferenceSchema = z.object({
  adapterDefinitionDigest: digestSchema,
  sourceConfigurationDigest: digestSchema,
  sourceId: idSchema,
  sourceInstanceId: idSchema,
  subscriptionId: idSchema,
}).strict();

export type PublicSourceWorkspaceReference = z.infer<
  typeof publicSourceWorkspaceReferenceSchema
>;

export function resolvePublicSourceWorkspaceReference(input: {
  readonly monitorId: string;
  readonly sourceId: string;
  readonly workspaceId: string;
}): PublicSourceWorkspaceReference {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  return publicSourceWorkspaceReferenceSchema.parse({
    adapterDefinitionDigest: reviewed.adapterDefinition.definitionDigest,
    sourceConfigurationDigest: reviewed.sourceInstance.configurationDigest,
    sourceId: input.sourceId,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    subscriptionId: derivePublicSourceSubscriptionId({
      monitorId: input.monitorId,
      sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
      workspaceId: input.workspaceId,
    }),
  });
}

export function createPublicSourceSubscription(input: {
  readonly binding: {
    readonly bindingRevision: number;
    readonly packContentDigest: string;
    readonly packId: string;
    readonly packVersion: string;
  } | null;
  readonly lifecycleState: PublicSourceSubscription["lifecycleState"];
  readonly monitorId: string;
  readonly reference: PublicSourceWorkspaceReference;
  readonly workspaceId: string;
}): PublicSourceSubscription {
  const reviewed = resolveReviewedPublicSource(input.reference.sourceId);
  if (
    reviewed.sourceInstance.sourceInstanceId !== input.reference.sourceInstanceId ||
    reviewed.sourceInstance.configurationDigest !==
      input.reference.sourceConfigurationDigest ||
    reviewed.adapterDefinition.definitionDigest !==
      input.reference.adapterDefinitionDigest
  ) {
    throw new Error("public_source_reference_mismatch");
  }
  return publicSourceSubscriptionSchema.parse({
    adapterDefinitionDigest: reviewed.adapterDefinition.definitionDigest,
    adapterVersion: reviewed.adapterDefinition.adapterVersion,
    deliveryCursor: { lastAcquisitionId: null, revision: 0 },
    factSchemaVersions: reviewed.adapterDefinition.factSchemaVersions,
    filter: reviewed.adapterDefinition.adapterId === "sec-latest-filings"
      ? { forms: ["S-1", "S-1/A"], kind: "sec_forms" }
      : { kind: "all" },
    lifecycleState: input.lifecycleState,
    monitorId: input.monitorId,
    packBinding: input.binding,
    recordType: "public_source_subscription",
    schemaVersion: 1,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    subscriptionId: input.reference.subscriptionId,
    workspaceId: input.workspaceId,
  });
}
