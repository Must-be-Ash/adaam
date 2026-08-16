import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
  CONGRESSIONAL_POLICY_V1_1,
  CONGRESSIONAL_SECURITY_CATALOG_V1_1,
} from "../agent/lib/congressional-reference-catalog";
import {
  assertImmutableCongressionalCatalog,
  congressionalReferenceCatalogSchema,
  congressionalSignalContractDigest,
  deriveHouseStrategyTransactionId,
  deriveHouseStrategyTransactionRevisionId,
  houseStrategyTransactionSchema,
  resolveCongressionalMember,
  resolveCongressionalSecurity,
  type CongressionalReferenceCatalog,
} from "../agent/lib/congressional-signal-schema";
import {
  evaluateCongressionalTransaction,
  resolveCongressionalCommitteeRelevance,
} from "../agent/lib/congressional-strategy";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/congressional-signals/sprint-2-committee-evidence.json", import.meta.url),
  "utf8",
)) as { readonly scenarios: readonly { readonly expected: string; readonly id: string }[] };
assert.deepEqual(fixture.scenarios.map(({ id }) => id), [
  "ambiguous-member",
  "ambiguous-security",
  "broad-jurisdiction",
  "changed-assignment",
  "exact-effective-assignment",
  "same-version-different-digest",
  "stale-catalog",
]);

function catalog<T extends Record<string, unknown>>(core: T): CongressionalReferenceCatalog {
  return congressionalReferenceCatalogSchema.parse({
    ...core,
    catalogDigest: congressionalSignalContractDigest(core),
  });
}

for (const officialCatalog of [
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1,
  CONGRESSIONAL_SECURITY_CATALOG_V1_1,
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
]) {
  assert.deepEqual(congressionalReferenceCatalogSchema.parse(officialCatalog), officialCatalog);
}
assert.ok(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1.entries.every(({ provenanceUrl }) =>
  provenanceUrl.startsWith("https://")));
assert.ok(CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1.entries.every(({ provenanceUrl }) =>
  provenanceUrl.startsWith("https://energycommerce.house.gov/")));
assert.ok(CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1.entries.every(({ provenanceUrl }) =>
  provenanceUrl.startsWith("https://energycommerce.house.gov/")));

const changedAssignments = catalog({
  catalogId: "congressional-committee-assignments-fixture",
  catalogVersion: "1.0.0",
  entries: [
    {
      assignmentId: "assignment.fixture.new",
      bioguideId: "G000568",
      committeeId: "committee.house-agriculture",
      effectiveFrom: "2025-07-01",
      effectiveThrough: null,
      provenanceUrl: "https://clerk.house.gov/committee_info/",
      subcommitteeId: null,
    },
    {
      assignmentId: "assignment.fixture.old",
      bioguideId: "G000568",
      committeeId: "committee.house-energy-commerce",
      effectiveFrom: "2025-01-03",
      effectiveThrough: "2025-06-30",
      provenanceUrl: "https://energycommerce.house.gov/committees/subcommittee/health",
      subcommitteeId: "subcommittee.house-energy-commerce-health",
    },
  ],
  kind: "committee_assignments",
  recordType: "congressional_reference_catalog",
  reviewedAt: "2026-08-16",
  schemaVersion: 1,
}) as Extract<CongressionalReferenceCatalog, { kind: "committee_assignments" }>;

const resolveCommittee = (
  assignments: Extract<CongressionalReferenceCatalog, { kind: "committee_assignments" }>,
  transactionDate: string,
) => resolveCongressionalCommitteeRelevance({
  assignments,
  industryId: "industry.pharmaceuticals",
  jurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  maximumCatalogAgeDays: CONGRESSIONAL_POLICY_V1_1.catalogMaximumAgeDays!,
  memberBioguideId: "G000568",
  observedAt: "2026-08-16T18:00:00.000Z",
  transactionDate,
});
assert.equal(resolveCommittee(changedAssignments, "2025-06-30").state, "yes");
assert.deepEqual(resolveCommittee(changedAssignments, "2025-06-30").assignmentIds, [
  "assignment.fixture.old",
]);
assert.equal(resolveCommittee(changedAssignments, "2025-07-01").state, "unknown");
assert.deepEqual(resolveCommittee(changedAssignments, "2025-07-01").assignmentIds, [
  "assignment.fixture.new",
]);

const broadAssignment = catalog({
  catalogId: "congressional-committee-assignments-broad-fixture",
  catalogVersion: "1.0.0",
  entries: [{
    assignmentId: "assignment.fixture.broad",
    bioguideId: "G000568",
    committeeId: "committee.house-energy-commerce",
    effectiveFrom: "2025-01-03",
    effectiveThrough: null,
    provenanceUrl: "https://energycommerce.house.gov/committees",
    subcommitteeId: null,
  }],
  kind: "committee_assignments",
  recordType: "congressional_reference_catalog",
  reviewedAt: "2026-08-16",
  schemaVersion: 1,
}) as Extract<CongressionalReferenceCatalog, { kind: "committee_assignments" }>;
assert.equal(resolveCommittee(broadAssignment, "2026-08-01").state, "unknown");

const ambiguousMembers = catalog({
  catalogId: "congressional-house-members-ambiguous-fixture",
  catalogVersion: "1.0.0",
  entries: ["A000001", "B000001"].map((bioguideId) => ({
    bioguideId,
    district: "09",
    effectiveFrom: "2025-01-03",
    effectiveThrough: null,
    officialName: "Morgan Griffith",
    party: "Republican",
    provenanceUrl: `https://bioguide.congress.gov/search/bio/${bioguideId}`,
    state: "VA",
  })),
  kind: "house_members",
  recordType: "congressional_reference_catalog",
  schemaVersion: 1,
}) as Extract<CongressionalReferenceCatalog, { kind: "house_members" }>;
assert.equal(resolveCongressionalMember({
  catalog: ambiguousMembers,
  filer: { firstName: "Morgan", lastName: "Griffith", stateDistrict: "VA09" },
  filingDate: "2026-08-16",
  transactionDate: "2026-08-01",
}).state, "ambiguous");

const ambiguousSecurities = catalog({
  catalogId: "congressional-security-classifications-ambiguous-fixture",
  catalogVersion: "1.0.0",
  entries: ["security.fixture.a", "security.fixture.b"].map((canonicalSecurityId) => ({
    canonicalSecurityId,
    classification: "security",
    industryId: "industry.pharmaceuticals",
    reportedTicker: "DUP",
    reviewedAt: "2026-08-16",
    sourceUrl: "https://www.sec.gov/edgar/search/",
  })),
  kind: "security_classifications",
  recordType: "congressional_reference_catalog",
  schemaVersion: 1,
}) as Extract<CongressionalReferenceCatalog, { kind: "security_classifications" }>;
assert.equal(resolveCongressionalSecurity({ catalog: ambiguousSecurities, reportedTicker: "DUP" }).state, "ambiguous");

const { catalogDigest: _assignmentDigest, ...assignmentCore } =
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1;
const staleAssignments = catalog({ ...assignmentCore, reviewedAt: "2025-01-01" }) as Extract<
  CongressionalReferenceCatalog,
  { kind: "committee_assignments" }
>;
assert.equal(resolveCommittee(staleAssignments, "2026-08-01").state, "stale");
const { catalogDigest: _jurisdictionDigest, ...jurisdictionCore } =
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1;
const staleJurisdictions = catalog({ ...jurisdictionCore, reviewedAt: "2025-01-01" }) as Extract<
  CongressionalReferenceCatalog,
  { kind: "committee_jurisdictions" }
>;
assert.equal(resolveCongressionalCommitteeRelevance({
  assignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  industryId: "industry.pharmaceuticals",
  jurisdictions: staleJurisdictions,
  maximumCatalogAgeDays: CONGRESSIONAL_POLICY_V1_1.catalogMaximumAgeDays!,
  memberBioguideId: "G000568",
  observedAt: "2026-08-16T18:00:00.000Z",
  transactionDate: "2026-08-01",
}).state, "stale");
assert.throws(
  () => assertImmutableCongressionalCatalog(
    CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    staleAssignments,
  ),
  (error: unknown) => error instanceof Error && error.message === "catalog_identity_conflict",
);

const workspaceId = "123e4567-e89b-42d3-a456-426614174302";
const subscriptionId = "subscription.fixture.congressional";
const factLogicalKey = "fact.fixture.congressional.transaction";
const reference = (value: CongressionalReferenceCatalog) => ({
  catalogDigest: value.catalogDigest,
  catalogId: value.catalogId,
  catalogVersion: value.catalogVersion,
});
const transactionCore = {
  amountRange: { label: "$50,001 - $100,000", lower: "50001", upper: "100000" },
  asset: { description: "Pfizer Inc. common stock", reportedTicker: "PFE" },
  catalogReferences: {
    committeeAssignments: reference(CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1),
    committeeJurisdictions: reference(CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1),
    member: reference(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_1),
    security: reference(CONGRESSIONAL_SECURITY_CATALOG_V1_1),
  },
  createdAt: "2026-08-16T18:00:00.000Z",
  disclosedMember: { firstName: "Morgan", lastName: "Griffith", prefix: null, stateDistrict: "VA09", suffix: null },
  disclosureLagDays: 16,
  eligibility: { reasonCodes: ["eligible"], state: "eligible" },
  filingDate: "2026-08-16",
  lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" },
  memberResolution: { bioguideId: "G000568", state: "resolved" },
  notificationDate: null,
  observedAt: "2026-08-16T18:00:00.000Z",
  owner: { disclosedCode: "SELF", relationship: "self" },
  packBinding: { bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "congressional-signals", packVersion: "1.1.0" },
  policyReference: { policyDigest: CONGRESSIONAL_POLICY_V1_1.policyDigest, policyId: CONGRESSIONAL_POLICY_V1_1.policyId, policyVersion: CONGRESSIONAL_POLICY_V1_1.policyVersion },
  processingMode: "live",
  recordType: "house_strategy_transaction",
  schemaVersion: 1,
  securityResolution: { canonicalSecurityId: "security.sec.78003.pfe", classification: "security", industryId: "industry.pharmaceuticals", state: "resolved" },
  source: {
    authority: "House Clerk",
    factLogicalKey,
    factRevisionId: "fact-revision.fixture.congressional",
    filingLogicalKey: "filing.fixture.congressional",
    projectionId: "projection.fixture.congressional",
    publicDocumentUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/fixture.pdf",
    rowIdentity: "row:1",
    sourceInstanceId: "source-instance.fixture.congressional",
    subscriptionId,
  },
  transactionDate: "2026-07-31",
  transactionId: deriveHouseStrategyTransactionId({ factLogicalKey, subscriptionId, workspaceId }),
  transactionType: "P",
  workspaceId,
} as const;
const transaction = houseStrategyTransactionSchema.parse({
  ...transactionCore,
  transactionRevisionId: deriveHouseStrategyTransactionRevisionId(transactionCore),
});
const exactEvaluation = evaluateCongressionalTransaction(transaction, CONGRESSIONAL_POLICY_V1_1, {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
});
assert.equal(exactEvaluation.committeeResolution.state, "yes");
assert.equal(exactEvaluation.band, "priority");
assert.deepEqual(exactEvaluation.reasonCodes, ["committee_relevant", "eligible", "material_range"]);
assert.deepEqual(
  exactEvaluation.evidence.find(({ reasonCode }) => reasonCode === "committee_relevant"),
  {
    reasonCode: "committee_relevant",
    sourceRecordIds: [
      "assignment.G000568.house-energy-commerce-health.2025",
      "jurisdiction.house-energy-commerce-health.pharmaceuticals.2025",
    ],
    state: "applied",
  },
);
const broadEvaluation = evaluateCongressionalTransaction(transaction, CONGRESSIONAL_POLICY_V1_1, {
  committeeAssignments: broadAssignment,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
});
assert.equal(broadEvaluation.committeeResolution.state, "unknown");
assert.equal(broadEvaluation.band, "review");
assert.equal(
  broadEvaluation.evidence.find(({ reasonCode }) => reasonCode === "committee_relevant")?.state,
  "unavailable",
);

const pack = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.1.0" });
assert.deepEqual(pack?.evidenceContracts, CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_1);
assert.equal(JSON.stringify(exactEvaluation).includes("score"), false);

console.info("Congressional Signals Sprint 2 committee evidence verification passed.");
