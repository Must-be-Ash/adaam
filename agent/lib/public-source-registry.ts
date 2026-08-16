import {
  publicSourceAdapterDefinitionSchema,
  publicSourceInstanceSchema,
} from "./public-source-adapter-schema";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "./strategy-pack-reference-catalog";

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

export function resolveReviewedPublicSource(sourceId: string) {
  const sourceContracts: Readonly<Record<string, ReviewedSourceContract>> =
    STRATEGY_PACK_REFERENCE_CATALOG.sourceContracts;
  const sourceContract = sourceContracts[sourceId];
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
    });
  } catch (error) {
    if (error instanceof ReviewedPublicSourceRegistryError) throw error;
    throw new ReviewedPublicSourceRegistryError("public_source_registry_invalid");
  }
}
