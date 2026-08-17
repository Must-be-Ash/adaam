import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import { resolveReviewedPublicSource } from "./public-source-registry";

export class StrategyPackSourceResolutionError extends Error {
  constructor(readonly code: "configuration_invalid" | "source_unavailable") {
    super(code);
    this.name = "StrategyPackSourceResolutionError";
  }
}

export interface ResolvedStrategyPackSource {
  readonly accessClassification: "public";
  readonly allowedOrigins: readonly string[];
  readonly canonicalUrl: string;
  readonly contractDigest: string;
  readonly contractVersion: string;
  readonly sourceId: string;
}

export function resolveParameterizedStrategyPackSources(
  pack: StrategyPackCatalogEntry,
  configuration: Readonly<Record<string, unknown>>,
  logicalSourceIds: readonly string[] = pack.sources.map(({ sourceId }) => sourceId),
): readonly Readonly<ResolvedStrategyPackSource>[] {
  const resolved: Array<Readonly<ResolvedStrategyPackSource>> = [];
  for (const logicalSourceId of logicalSourceIds) {
    const source = pack.sources.find((candidate) => candidate.sourceId === logicalSourceId);
    if (!source) throw new StrategyPackSourceResolutionError("source_unavailable");
    if (!source.parameterization) {
      resolved.push(Object.freeze({ ...source }));
      continue;
    }
    const selected = configuration[source.parameterization.selectionConfigurationKey];
    if (!Array.isArray(selected)) {
      throw new StrategyPackSourceResolutionError("configuration_invalid");
    }
    for (const catalogEntryId of selected) {
      let reviewed;
      try {
        reviewed = resolveReviewedPublicSource(`${source.sourceId}.${catalogEntryId}`);
      } catch {
        throw new StrategyPackSourceResolutionError("source_unavailable");
      }
      if (
        reviewed.sourceInstance.configuration.kind !== "earnings_call_issuer" ||
        reviewed.sourceInstance.configuration.catalogId !== source.parameterization.catalogId ||
        reviewed.sourceInstance.configuration.catalogRevision !== source.parameterization.catalogRevision ||
        reviewed.sourceInstance.configuration.catalogDigest !== source.parameterization.catalogDigest
      ) throw new StrategyPackSourceResolutionError("source_unavailable");
      resolved.push(Object.freeze({
        accessClassification: "public",
        allowedOrigins: Object.freeze([...reviewed.sourceContract.allowedOrigins]),
        canonicalUrl: reviewed.sourceContract.canonicalUrl,
        contractDigest: reviewed.sourceContract.contractDigest,
        contractVersion: reviewed.sourceContract.contractVersion,
        sourceId: `${source.sourceId}.${catalogEntryId}`,
      }));
    }
  }
  return Object.freeze(resolved);
}
