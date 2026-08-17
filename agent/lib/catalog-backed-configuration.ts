import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";

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
  return Object.freeze(requireCatalog(reference).entries.map((entry) => Object.freeze({
    coverageReason: entry.coverage.reasonCode,
    coverageState: entry.coverage.state,
    id: entry.cik,
    label: `${entry.ticker} — ${entry.companyName}`,
  })));
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
