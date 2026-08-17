import {
  digestEarningsCallValue,
  earningsIssuerCatalogRevisionSchema,
} from "./earnings-call-schema";

const VERIFIED_CIKS: ReadonlyMap<string, string> = new Map([
  ["0000019617", "2026-07-14T00:00:00.000Z"],
  ["0000789019", "2026-04-29T00:00:00.000Z"],
  ["0001048911", "2026-06-23T00:00:00.000Z"],
  ["0001326801", "2026-04-29T00:00:00.000Z"],
  ["0001744489", "2026-05-06T00:00:00.000Z"],
]);

const ISSUERS = [
  ["0001341439", "ORCL", "Oracle Corporation", "NYSE", "technology"],
  ["0000789019", "MSFT", "Microsoft Corporation", "Nasdaq", "technology"],
  ["0001108524", "CRM", "Salesforce, Inc.", "NYSE", "technology"],
  ["0001730168", "AVGO", "Broadcom Inc.", "Nasdaq", "technology"],
  ["0000723125", "MU", "Micron Technology, Inc.", "Nasdaq", "technology"],
  ["0001835632", "MRVL", "Marvell Technology, Inc.", "Nasdaq", "technology"],
  ["0000804328", "QCOM", "QUALCOMM Incorporated", "Nasdaq", "technology"],
  ["0000858877", "CSCO", "Cisco Systems, Inc.", "Nasdaq", "technology"],
  ["0001048911", "FDX", "FedEx Corporation", "NYSE", "industrials"],
  ["0001090727", "UPS", "United Parcel Service, Inc.", "NYSE", "industrials"],
  ["0000018230", "CAT", "Caterpillar Inc.", "NYSE", "industrials"],
  ["0000315189", "DE", "Deere & Company", "NYSE", "industrials"],
  ["0000773840", "HON", "Honeywell International Inc.", "Nasdaq", "industrials"],
  ["0000040545", "GE", "GE Aerospace", "NYSE", "industrials"],
  ["0000101829", "RTX", "RTX Corporation", "NYSE", "industrials"],
  ["0000936468", "LMT", "Lockheed Martin Corporation", "NYSE", "industrials"],
  ["0000320187", "NKE", "NIKE, Inc.", "NYSE", "consumer"],
  ["0000909832", "COST", "Costco Wholesale Corporation", "Nasdaq", "consumer"],
  ["0000027419", "TGT", "Target Corporation", "NYSE", "consumer"],
  ["0000354950", "HD", "The Home Depot, Inc.", "NYSE", "consumer"],
  ["0000060667", "LOW", "Lowe's Companies, Inc.", "NYSE", "consumer"],
  ["0000829224", "SBUX", "Starbucks Corporation", "Nasdaq", "consumer"],
  ["0000940944", "DRI", "Darden Restaurants, Inc.", "NYSE", "consumer"],
  ["0000815097", "CCL", "Carnival Corporation", "NYSE", "consumer"],
  ["0000920760", "LEN", "Lennar Corporation", "NYSE", "consumer"],
  ["0000882184", "DHI", "D.R. Horton, Inc.", "NYSE", "consumer"],
  ["0000866787", "AZO", "AutoZone, Inc.", "NYSE", "consumer"],
  ["0000019617", "JPM", "JPMorgan Chase & Co.", "NYSE", "financials"],
  ["0000070858", "BAC", "Bank of America Corporation", "NYSE", "financials"],
  ["0000886982", "GS", "The Goldman Sachs Group, Inc.", "NYSE", "financials"],
  ["0000895421", "MS", "Morgan Stanley", "NYSE", "financials"],
  ["0000831001", "C", "Citigroup Inc.", "NYSE", "financials"],
  ["0000072971", "WFC", "Wells Fargo & Company", "NYSE", "financials"],
  ["0000200406", "JNJ", "Johnson & Johnson", "NYSE", "healthcare"],
  ["0000078003", "PFE", "Pfizer Inc.", "NYSE", "healthcare"],
  ["0000059478", "LLY", "Eli Lilly and Company", "NYSE", "healthcare"],
  ["0000310158", "MRK", "Merck & Co., Inc.", "NYSE", "healthcare"],
  ["0000731766", "UNH", "UnitedHealth Group Incorporated", "NYSE", "healthcare"],
  ["0001551152", "ABBV", "AbbVie Inc.", "NYSE", "healthcare"],
  ["0002115436", "XOM", "Exxon Mobil Corporation", "NYSE", "energy"],
  ["0000093410", "CVX", "Chevron Corporation", "NYSE", "energy"],
  ["0001163165", "COP", "ConocoPhillips", "NYSE", "energy"],
  ["0000087347", "SLB", "SLB", "NYSE", "energy"],
  ["0001510295", "MPC", "Marathon Petroleum Corporation", "NYSE", "energy"],
  ["0001744489", "DIS", "The Walt Disney Company", "NYSE", "communication_services"],
  ["0001326801", "META", "Meta Platforms, Inc.", "Nasdaq", "communication_services"],
  ["0000732717", "T", "AT&T Inc.", "NYSE", "communication_services"],
  ["0000732712", "VZ", "Verizon Communications Inc.", "NYSE", "communication_services"],
  ["0000753308", "NEE", "NextEra Energy, Inc.", "NYSE", "utilities"],
  ["0001326160", "DUK", "Duke Energy Corporation", "NYSE", "utilities"],
] as const;

const entries = ISSUERS.map(([cik, ticker, companyName, exchange, sector]) => ({
  cik,
  companyName,
  coverage: VERIFIED_CIKS.has(cik)
    ? { lastSuccessfulEventAt: VERIFIED_CIKS.get(cik)!, reasonCode: null, state: "baseline_ready" as const }
    : { lastSuccessfulEventAt: null, reasonCode: "no_reviewed_source_family" as const, state: "coverage_unavailable" as const },
  exchange,
  sector,
  ticker,
})).sort((left, right) => left.cik.localeCompare(right.cik));

const catalogCore = {
  catalogId: "sec-issuers" as const,
  entries,
  recordType: "earnings_issuer_catalog_revision" as const,
  revision: 1,
  schemaVersion: 1 as const,
};

export const EARNINGS_CALL_ISSUER_CATALOG = Object.freeze(
  earningsIssuerCatalogRevisionSchema.parse({
    ...catalogCore,
    catalogDigest: digestEarningsCallValue(catalogCore),
  }),
);

export class EarningsCallIssuerCatalogError extends Error {
  constructor(readonly code: "issuer_match_ambiguous" | "issuer_not_found") {
    super(code);
    this.name = "EarningsCallIssuerCatalogError";
  }
}

export function resolveEarningsCallIssuer(query: string) {
  const normalized = query.trim().toLocaleLowerCase("en-US");
  const exact = EARNINGS_CALL_ISSUER_CATALOG.entries.filter((entry) =>
    entry.cik === query.trim() ||
    entry.ticker.toLocaleLowerCase("en-US") === normalized ||
    entry.companyName.toLocaleLowerCase("en-US") === normalized);
  if (exact.length === 1) return exact[0]!;
  const partial = EARNINGS_CALL_ISSUER_CATALOG.entries.filter((entry) =>
    entry.ticker.toLocaleLowerCase("en-US").startsWith(normalized) ||
    entry.companyName.toLocaleLowerCase("en-US").includes(normalized));
  if (partial.length === 1) return partial[0]!;
  throw new EarningsCallIssuerCatalogError(
    partial.length > 1 || exact.length > 1 ? "issuer_match_ambiguous" : "issuer_not_found",
  );
}
