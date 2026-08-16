import {
  CONGRESSIONAL_SIGNAL_BANDS,
  CONGRESSIONAL_SIGNAL_REASON_CODES,
  congressionalPolicySchema,
  congressionalReferenceCatalogSchema,
  congressionalSignalContractDigest,
} from "./congressional-signal-schema";

const policyCore = Object.freeze({
  alertThresholds: ["priority", "review"] as const,
  bands: CONGRESSIONAL_SIGNAL_BANDS,
  coverage: "house_only" as const,
  defaultAlertThreshold: "priority" as const,
  eligibleTransactionTypes: ["P", "S"] as const,
  materialLowerBound: "50001" as const,
  maximumDisclosureLagDays: 45 as const,
  policyId: "congressional-signals-policy" as const,
  policyVersion: "1.0.0" as const,
  reasonCodes: CONGRESSIONAL_SIGNAL_REASON_CODES,
  recordType: "congressional_signal_policy" as const,
  schemaVersion: 1 as const,
  timelyMaximumLagDays: 15 as const,
});

export const CONGRESSIONAL_POLICY_V1 = Object.freeze(congressionalPolicySchema.parse({
  ...policyCore,
  policyDigest: congressionalSignalContractDigest(policyCore),
}));

const memberCatalogCore = Object.freeze({
  catalogId: "congressional-house-members",
  catalogVersion: "1.0.0",
  entries: Object.freeze([
    Object.freeze({
      bioguideId: "H001082",
      district: "01",
      effectiveFrom: "2025-01-03",
      effectiveThrough: null,
      officialName: "Kevin Hern",
      party: "Republican" as const,
      provenanceUrl: "https://bioguide.congress.gov/search/bio/H001082",
      state: "OK",
    }),
  ]),
  kind: "house_members" as const,
  recordType: "congressional_reference_catalog" as const,
  schemaVersion: 1 as const,
});

export const CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...memberCatalogCore,
    catalogDigest: congressionalSignalContractDigest(memberCatalogCore),
  }),
);

const securityCatalogCore = Object.freeze({
  catalogId: "congressional-security-classifications",
  catalogVersion: "1.0.0",
  entries: Object.freeze([
    Object.freeze({
      canonicalSecurityId: "security.sec.1821825.ogn",
      classification: "security" as const,
      industryId: "industry.pharmaceuticals",
      reportedTicker: "OGN",
      reviewedAt: "2026-08-16",
      sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=1821825&owner=exclude",
    }),
  ]),
  kind: "security_classifications" as const,
  recordType: "congressional_reference_catalog" as const,
  schemaVersion: 1 as const,
});

export const CONGRESSIONAL_SECURITY_CATALOG_V1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...securityCatalogCore,
    catalogDigest: congressionalSignalContractDigest(securityCatalogCore),
  }),
);
