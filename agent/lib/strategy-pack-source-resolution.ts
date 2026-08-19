import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import {
  resolveReviewedPublicSource,
  ReviewedPublicSourceRegistryError,
} from "./public-source-registry";
import { resolvePublicCommentaryTrackerSourcePolicy } from "./public-commentary-tracker";
import {
  PUBLIC_COMMENTARY_TRACKER_SOURCE_ID,
} from "./strategy-pack-reference-catalog";
import { parseConfirmedXPublicIdentity } from "./x-public-identity";

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
  readonly sourceInstanceId?: string;
}

export function resolveParameterizedStrategyPackSources(
  pack: Pick<StrategyPackCatalogEntry, "sources">,
  configuration: Readonly<Record<string, unknown>>,
  logicalSourceIds: readonly string[] = pack.sources.map(({ sourceId }) => sourceId),
): readonly Readonly<ResolvedStrategyPackSource>[] {
  const resolved: Array<Readonly<ResolvedStrategyPackSource>> = [];
  for (const logicalSourceId of logicalSourceIds) {
    const source = pack.sources.find((candidate) => candidate.sourceId === logicalSourceId);
    if (!source) throw new StrategyPackSourceResolutionError("source_unavailable");
    if (source.sourceId === PUBLIC_COMMENTARY_TRACKER_SOURCE_ID) {
      const policy = resolvePublicCommentaryTrackerSourcePolicy(configuration);
      if (policy.sourceKind === "official_white_house") {
        resolved.push(Object.freeze({ ...source }));
        continue;
      }
      let identity;
      try {
        identity = parseConfirmedXPublicIdentity(configuration.xIdentity);
      } catch {
        throw new StrategyPackSourceResolutionError("configuration_invalid");
      }
      const sourceId = `x-public-commentary-user.${identity.numericUserId}.${identity.username}`;
      const reviewed = resolveReviewedPublicSource(sourceId);
      resolved.push(Object.freeze({
        accessClassification: "public",
        allowedOrigins: Object.freeze([...reviewed.sourceContract.allowedOrigins]),
        canonicalUrl: reviewed.sourceContract.canonicalUrl,
        contractDigest: reviewed.sourceContract.contractDigest,
        contractVersion: reviewed.sourceContract.contractVersion,
        sourceId,
        sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
      }));
      continue;
    }
    if (!source.parameterization) {
      resolved.push(Object.freeze({ ...source }));
      continue;
    }
    const selected = configuration[source.parameterization.selectionConfigurationKey];
    if (!Array.isArray(selected)) {
      throw new StrategyPackSourceResolutionError("configuration_invalid");
    }
    for (const catalogEntryId of selected) {
      if (
        source.sourceId === "earnings-call-transcripts" &&
        (typeof catalogEntryId !== "string" ||
          !EARNINGS_CALL_ISSUER_CATALOG.entries.some(({ cik }) => cik === catalogEntryId))
      ) throw new StrategyPackSourceResolutionError("configuration_invalid");
      let reviewed;
      try {
        reviewed = resolveReviewedPublicSource(`${source.sourceId}.${catalogEntryId}`);
      } catch (error) {
        if (
          source.sourceId === "earnings-call-transcripts" &&
          error instanceof ReviewedPublicSourceRegistryError &&
          error.code === "public_source_not_reviewed"
        ) continue;
        throw new StrategyPackSourceResolutionError("source_unavailable");
      }
      if (
        reviewed.sourceInstance.configuration.kind !== "earnings_call_issuer" ||
        reviewed.sourceInstance.configuration.catalogId !== source.parameterization.catalogId ||
        reviewed.sourceInstance.configuration.catalogRevision !== source.parameterization.catalogRevision ||
        reviewed.sourceInstance.configuration.catalogDigest !== source.parameterization.catalogDigest
      ) throw new StrategyPackSourceResolutionError("source_unavailable");
      if (
        source.sourceId === "earnings-call-transcripts" &&
        reviewed.sourceFamily?.discoveryPolicy.state !== "supported"
      ) continue;
      resolved.push(Object.freeze({
        accessClassification: "public",
        allowedOrigins: Object.freeze([...reviewed.sourceContract.allowedOrigins]),
        canonicalUrl: reviewed.sourceContract.canonicalUrl,
        contractDigest: reviewed.sourceContract.contractDigest,
        contractVersion: reviewed.sourceContract.contractVersion,
        sourceId: `${source.sourceId}.${catalogEntryId}`,
        sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
      }));
    }
  }
  return Object.freeze(resolved);
}
