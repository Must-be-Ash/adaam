import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import { resolveEarningsCallPublicSource } from "./earnings-call-public-source-contract";

export interface CatalogBackedFieldReference {
  readonly catalogDigest: string;
  readonly catalogId: string;
  readonly catalogRevision: number;
}

export interface CatalogBackedOption {
  readonly coverageReason: string | null;
  readonly coverageState: string;
  readonly id: string;
  readonly label: string;
}

export class CatalogBackedConfigurationError extends Error {
  constructor(readonly code: "catalog_reference_invalid" | "catalog_value_invalid") {
    super(code);
    this.name = "CatalogBackedConfigurationError";
  }
}

function requireCatalog(reference: CatalogBackedFieldReference) {
  if (
    reference.catalogId !== EARNINGS_CALL_ISSUER_CATALOG.catalogId ||
    reference.catalogRevision !== EARNINGS_CALL_ISSUER_CATALOG.revision ||
    reference.catalogDigest !== EARNINGS_CALL_ISSUER_CATALOG.catalogDigest
  ) throw new CatalogBackedConfigurationError("catalog_reference_invalid");
  return EARNINGS_CALL_ISSUER_CATALOG;
}

export function resolveCatalogBackedOptions(
  reference: CatalogBackedFieldReference,
): readonly CatalogBackedOption[] {
  return Object.freeze(requireCatalog(reference).entries.map((entry) => {
    const reviewed = resolveEarningsCallPublicSource(`earnings-call-transcripts.${entry.cik}`);
    const ongoingDiscovery = reviewed?.family.discoveryPolicy;
    const coverage = ongoingDiscovery?.state === "coverage_unavailable"
      ? { reasonCode: "coverage_not_reviewed", state: "coverage_unavailable" }
      : entry.coverage;
    return Object.freeze({
      coverageReason: coverage.reasonCode,
      coverageState: coverage.state,
      id: entry.cik,
      label: `${entry.ticker} — ${entry.companyName}`,
    });
  }));
}

export function assertCatalogBackedValues(
  reference: CatalogBackedFieldReference,
  values: readonly string[],
): void {
  const ids = new Set(requireCatalog(reference).entries.map(({ cik }) => cik));
  if (values.some((value) => !ids.has(value))) {
    throw new CatalogBackedConfigurationError("catalog_value_invalid");
  }
}
