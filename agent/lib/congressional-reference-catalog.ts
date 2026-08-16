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

const policyV1_1Core = Object.freeze({
  ...policyCore,
  catalogMaximumAgeDays: 90 as const,
  policyVersion: "1.1.0" as const,
});

export const CONGRESSIONAL_POLICY_V1_1 = Object.freeze(congressionalPolicySchema.parse({
  ...policyV1_1Core,
  policyDigest: congressionalSignalContractDigest(policyV1_1Core),
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

const memberCatalogV1_1Core = Object.freeze({
  ...memberCatalogCore,
  catalogVersion: "1.1.0",
  entries: Object.freeze([
    Object.freeze({
      bioguideId: "G000568",
      district: "09",
      effectiveFrom: "2025-01-03",
      effectiveThrough: null,
      officialName: "Morgan Griffith",
      party: "Republican" as const,
      provenanceUrl: "https://bioguide.congress.gov/search/bio/G000568",
      state: "VA",
    }),
    ...memberCatalogCore.entries,
  ]),
});

export const CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...memberCatalogV1_1Core,
    catalogDigest: congressionalSignalContractDigest(memberCatalogV1_1Core),
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

const securityCatalogV1_1Core = Object.freeze({
  ...securityCatalogCore,
  catalogVersion: "1.1.0",
  entries: Object.freeze([
    ...securityCatalogCore.entries,
    Object.freeze({
      canonicalSecurityId: "security.sec.78003.pfe",
      classification: "security" as const,
      industryId: "industry.pharmaceuticals",
      reportedTicker: "PFE",
      reviewedAt: "2026-08-16",
      sourceUrl: "https://www.sec.gov/edgar/browse/?CIK=78003&owner=exclude",
    }),
  ]),
});

export const CONGRESSIONAL_SECURITY_CATALOG_V1_1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...securityCatalogV1_1Core,
    catalogDigest: congressionalSignalContractDigest(securityCatalogV1_1Core),
  }),
);

const committeeAssignmentCatalogCore = Object.freeze({
  catalogId: "congressional-committee-assignments",
  catalogVersion: "1.0.0",
  entries: Object.freeze([
    Object.freeze({
      assignmentId: "assignment.G000568.house-energy-commerce-health.2025",
      bioguideId: "G000568",
      committeeId: "committee.house-energy-commerce",
      effectiveFrom: "2025-01-03",
      effectiveThrough: null,
      provenanceUrl: "https://energycommerce.house.gov/committees/subcommittee/health",
      subcommitteeId: "subcommittee.house-energy-commerce-health",
    }),
  ]),
  kind: "committee_assignments" as const,
  recordType: "congressional_reference_catalog" as const,
  reviewedAt: "2026-08-16",
  schemaVersion: 1 as const,
});

export const CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...committeeAssignmentCatalogCore,
    catalogDigest: congressionalSignalContractDigest(committeeAssignmentCatalogCore),
  }),
) as Extract<
  ReturnType<typeof congressionalReferenceCatalogSchema.parse>,
  { kind: "committee_assignments" }
>;

const committeeJurisdictionCatalogCore = Object.freeze({
  catalogId: "congressional-committee-jurisdictions",
  catalogVersion: "1.0.0",
  entries: Object.freeze([
    Object.freeze({
      committeeId: "committee.house-energy-commerce",
      effectiveFrom: "2025-01-03",
      effectiveThrough: null,
      industryId: "industry.pharmaceuticals",
      jurisdictionId: "jurisdiction.house-energy-commerce-health.pharmaceuticals.2025",
      provenanceUrl: "https://energycommerce.house.gov/committees/subcommittee/health",
      relevance: "yes" as const,
      subcommitteeId: "subcommittee.house-energy-commerce-health",
    }),
    Object.freeze({
      committeeId: "committee.house-energy-commerce",
      effectiveFrom: "2025-01-03",
      effectiveThrough: null,
      industryId: null,
      jurisdictionId: "jurisdiction.house-energy-commerce.broad.2025",
      provenanceUrl: "https://energycommerce.house.gov/committees",
      relevance: "broad" as const,
      subcommitteeId: null,
    }),
  ]),
  kind: "committee_jurisdictions" as const,
  recordType: "congressional_reference_catalog" as const,
  reviewedAt: "2026-08-16",
  schemaVersion: 1 as const,
});

export const CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1 = Object.freeze(
  congressionalReferenceCatalogSchema.parse({
    ...committeeJurisdictionCatalogCore,
    catalogDigest: congressionalSignalContractDigest(committeeJurisdictionCatalogCore),
  }),
) as Extract<
  ReturnType<typeof congressionalReferenceCatalogSchema.parse>,
  { kind: "committee_jurisdictions" }
>;

export const CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_1 = Object.freeze([
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
  CONGRESSIONAL_POLICY_V1_1,
  CONGRESSIONAL_SECURITY_CATALOG_V1_1,
].map((contract) => Object.freeze({
  digest: "catalogDigest" in contract ? contract.catalogDigest : contract.policyDigest,
  id: "catalogId" in contract ? contract.catalogId : contract.policyId,
  version: "catalogVersion" in contract ? contract.catalogVersion : contract.policyVersion,
})).sort((left, right) => left.id.localeCompare(right.id)));
