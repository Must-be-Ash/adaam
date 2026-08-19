import {
  publicSourceAdapterDefinitionSchema,
  publicSourceInstanceSchema,
} from "./public-source-adapter-schema";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "./strategy-pack-reference-catalog";
import { resolveEarningsCallPublicSource } from "./earnings-call-public-source-contract";
import {
  X_CONFIGURABLE_PUBLIC_STATEMENTS_CONTRACT_DIGEST,
  X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER,
} from "./strategy-pack-reference-catalog";
import { digestPublicSourceValue } from "./public-source-adapter-schema";

function configurableXPublicSource(sourceId: string) {
  const match = /^x-public-commentary-user\.(\d{1,20})\.([A-Za-z0-9_]{1,15})$/u.exec(sourceId);
  if (!match) return null;
  const [, numericUserId, username] = match;
  const canonicalUrl = `https://api.x.com/2/users/${numericUserId}/tweets`;
  const configuration = {
    canonicalUrl,
    displayLabel: `@${username}`,
    excludeReposts: true as const,
    kind: "x_public_statements_user" as const,
    maximumPagesPerPoll: 2 as const,
    maximumPostsPerPoll: 200 as const,
    numericUserId: numericUserId!,
    username: username!,
  };
  return Object.freeze({
    sourceContract: Object.freeze({
      allowedOrigins: Object.freeze(["https://api.x.com"]),
      canonicalUrl,
      contractDigest: X_CONFIGURABLE_PUBLIC_STATEMENTS_CONTRACT_DIGEST,
      contractVersion: "1.0.0",
      publicSource: Object.freeze({
        adapterDefinition: X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER,
        sourceInstance: Object.freeze({
          adapterDefinitionDigest: X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.definitionDigest,
          adapterId: X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterId,
          adapterVersion: X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterVersion,
          authorityOrigin: "https://api.x.com",
          cadenceMinutes: 10,
          configuration,
          configurationDigest: digestPublicSourceValue(configuration),
          cursor: { contentDigest: null, revision: 0, watermark: null },
          lifecycleState: "active" as const,
          recordType: "public_source_instance" as const,
          schemaVersion: 1 as const,
          sourceInstanceId: `source.x-public-statements.${numericUserId}`,
        }),
      }),
    }),
  });
}

export class ReviewedPublicSourceRegistryError extends Error {
  readonly code:
    | "public_source_not_reviewed"
    | "public_source_registry_invalid";

  constructor(code: ReviewedPublicSourceRegistryError["code"]) {
    super(code);
    this.code = code;
    this.name = "ReviewedPublicSourceRegistryError";
  }
}

type ReviewedSourceContract =
  (typeof STRATEGY_PACK_REFERENCE_CATALOG.sourceContracts)[keyof typeof STRATEGY_PACK_REFERENCE_CATALOG.sourceContracts];

export function isReviewedPublicSource(sourceId: string): boolean {
  try {
    resolveReviewedPublicSource(sourceId);
    return true;
  } catch (error) {
    if (
      error instanceof ReviewedPublicSourceRegistryError &&
      error.code === "public_source_not_reviewed"
    ) {
      return false;
    }
    throw error;
  }
}

export function resolveReviewedPublicSource(sourceId: string) {
  const sourceContracts: Readonly<Record<string, ReviewedSourceContract>> =
    STRATEGY_PACK_REFERENCE_CATALOG.sourceContracts;
  const parameterized = resolveEarningsCallPublicSource(sourceId);
  const configurableX = configurableXPublicSource(sourceId);
  const sourceContract = configurableX?.sourceContract ?? parameterized?.sourceContract ?? sourceContracts[sourceId];
  if (!sourceContract?.publicSource) {
    throw new ReviewedPublicSourceRegistryError("public_source_not_reviewed");
  }
  try {
    const adapterDefinition = publicSourceAdapterDefinitionSchema.parse(
      sourceContract.publicSource.adapterDefinition,
    );
    const sourceInstance = publicSourceInstanceSchema.parse(
      sourceContract.publicSource.sourceInstance,
    );
    if (
      sourceInstance.adapterId !== adapterDefinition.adapterId ||
      sourceInstance.adapterVersion !== adapterDefinition.adapterVersion ||
      sourceInstance.adapterDefinitionDigest !== adapterDefinition.definitionDigest ||
      sourceInstance.configuration.canonicalUrl !== sourceContract.canonicalUrl ||
      sourceInstance.authorityOrigin !== new URL(sourceContract.canonicalUrl).origin ||
      !sourceContract.allowedOrigins.includes(sourceInstance.authorityOrigin)
    ) {
      throw new ReviewedPublicSourceRegistryError("public_source_registry_invalid");
    }
    return Object.freeze({
      adapterDefinition,
      sourceContract,
      sourceInstance,
      ...(parameterized ? { sourceFamily: parameterized.family } : {}),
    });
  } catch (error) {
    if (error instanceof ReviewedPublicSourceRegistryError) throw error;
    throw new ReviewedPublicSourceRegistryError("public_source_registry_invalid");
  }
}
