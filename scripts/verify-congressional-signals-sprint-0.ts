import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import {
  CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
} from "../agent/lib/congressional-reference-catalog";

import {
  assertImmutableCongressionalCatalog,
  congressionalFilingSignalSchema,
  congressionalPolicySchema,
  congressionalReferenceCatalogSchema,
  congressionalSignalContractDigest,
  deriveCongressionalSignalId,
  deriveCongressionalSignalRevisionId,
  houseStrategyTransactionSchema,
  normalizeProjectedHouseTransaction,
} from "../agent/lib/congressional-signal-schema";
import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import {
  runHousePublicSourceAcquisition,
  type HousePublicSourceBinaryResponse,
} from "../agent/lib/house-public-source-adapter";
import { publicSourceSubscriptionSchema } from "../agent/lib/public-source-adapter-schema";
import {
  derivePublicSourceSubscriptionId,
  ensurePublicSourceSubscription,
  projectPublicSourceAcquisition,
  type PublicSourceSubscriptionStoreClient,
} from "../agent/lib/public-source-subscription-store";
import { HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID } from "../agent/lib/strategy-pack-reference-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements PublicSourceAcquisitionStoreClient, PublicSourceSubscriptionStoreClient {
  readonly records = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }

  async get(key: string): Promise<unknown> {
    return this.records.get(key) ?? null;
  }
}

const fixtureRoot = new URL("./fixtures/congressional-signals/", import.meta.url);
const houseRoot = new URL("./fixtures/public-source-adapters/house/", import.meta.url);
const contracts = JSON.parse(
  await readFile(new URL("sprint-0-contracts.json", fixtureRoot), "utf8"),
) as { readonly catalogs: readonly Record<string, unknown>[]; readonly policy: Record<string, unknown> };
const policy = congressionalPolicySchema.parse({
  ...contracts.policy,
  policyDigest: congressionalSignalContractDigest(contracts.policy),
});
const catalogs = contracts.catalogs.map((catalog) => congressionalReferenceCatalogSchema.parse({
  ...catalog,
  catalogDigest: congressionalSignalContractDigest(catalog),
}));
assert.equal(catalogs.length, 2);
assert.throws(() => congressionalPolicySchema.parse({ ...policy, numericScore: 7 }));
assert.throws(() => congressionalReferenceCatalogSchema.parse({
  ...catalogs[0],
  catalogDigest: "0".repeat(64),
}));
assert.throws(() => assertImmutableCongressionalCatalog(catalogs[0]!, {
  ...catalogs[0]!,
  entries: [{ fixture: "mutated" }],
}));

const liveManifest = JSON.parse(
  await readFile(new URL("live-review-2026-08-16/manifest.json", houseRoot), "utf8"),
) as { readonly documents: readonly {
  readonly disclosedFiler: {
    readonly firstName: string;
    readonly lastName: string;
    readonly prefix: string | null;
    readonly stateDistrict: string;
    readonly suffix: string | null;
  };
  readonly docId: string;
  readonly filingDate: string;
  readonly retainedFile: string;
}[] };
const retained = liveManifest.documents.find((document) => document.retainedFile === "ptr-02.pdf")!;
const observedAt = "2026-08-16T18:00:00.000Z";
const sourceUrl = (docId: string) =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`;
const response = (body: Uint8Array, contentType: string, url: string): HousePublicSourceBinaryResponse => ({
  body,
  contentType,
  finalUrl: url,
  observedAt,
  requestedUrl: url,
  status: 200,
});
async function zipHouseIndex(xml: string): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("2026FD.xml", new TextReader(xml));
  return writer.close();
}

const [year, month, day] = retained.filingDate.split("-");
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FinancialDisclosure><Member><Prefix>${retained.disclosedFiler.prefix ?? ""}</Prefix><Last>${retained.disclosedFiler.lastName}</Last><First>${retained.disclosedFiler.firstName}</First><Suffix>${retained.disclosedFiler.suffix ?? ""}</Suffix><FilingType>P</FilingType><StateDst>${retained.disclosedFiler.stateDistrict}</StateDst><Year>2026</Year><FilingDate>${month}/${day}/${year}</FilingDate><DocID>${retained.docId}</DocID></Member></FinancialDisclosure>`;
const indexBody = await zipHouseIndex(xml);
const pdfBody = new Uint8Array(await readFile(new URL(`live-review-2026-08-16/${retained.retainedFile}`, houseRoot)));
const store = new MemoryStore();
const acquisition = await runHousePublicSourceAcquisition({
  client: store,
  fetchDocument: async (url) => response(pdfBody, "application/pdf", url),
  fetchIndex: async (url) => response(indexBody, "application/zip", url),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: "2026-08-16T12:00:00.000Z", endAt: observedAt },
});
assert.equal(acquisition.acquisition.result.status, "complete");
assert.ok(acquisition.acquisition.facts.some((fact) => fact.factSchemaVersion === "house-ptr-transaction/v1"));

const workspaceId = "123e4567-e89b-42d3-a456-426614174200";
const scope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
);
const sourceInstance = acquisition.commit!.sourceInstance;
const monitorId = "monitor.fixture.congressional-signals";
const subscriptionId = derivePublicSourceSubscriptionId({
  monitorId,
  sourceInstanceId: sourceInstance.sourceInstanceId,
  workspaceId,
});
await ensurePublicSourceSubscription(scope, publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest,
  adapterVersion: sourceInstance.adapterVersion,
  deliveryCursor: { lastAcquisitionId: null, revision: 0 },
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" },
  lifecycleState: "active",
  monitorId,
  packBinding: {
    bindingRevision: 1,
    packContentDigest: "a".repeat(64),
    packId: "congressional-signals",
    packVersion: "1.0.0",
  },
  recordType: "public_source_subscription",
  schemaVersion: 1,
  sourceInstanceId: sourceInstance.sourceInstanceId,
  subscriptionId,
  workspaceId,
}), store);
const projection = await projectPublicSourceAcquisition({
  acquisition: acquisition.acquisition.result,
  projectedAt: new Date(observedAt),
  scope,
  subscriptionId,
}, { acquisition: store, subscription: store });
const filingProjection = projection.projections.find(
  (item) => item.fact.factSchemaVersion === "house-ptr-filing/v1",
)!;
const transactionProjection = projection.projections.find(
  (item) => item.fact.factSchemaVersion === "house-ptr-transaction/v1",
)!;
const normalized = normalizeProjectedHouseTransaction({
  catalogs: {
    committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
    committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
    member: catalogs.find((catalog) => catalog.kind === "house_members")!,
    security: catalogs.find((catalog) => catalog.kind === "security_classifications")!,
  },
  filing: filingProjection,
  observedAt,
  packBinding: {
    bindingRevision: 1,
    packContentDigest: "a".repeat(64),
    packId: "congressional-signals",
    packVersion: "1.0.0",
  },
  policy,
  processingMode: "live",
  transaction: transactionProjection,
});
assert.deepEqual(houseStrategyTransactionSchema.parse(normalized), normalized);
assert.equal(normalized.source.factRevisionId, transactionProjection.fact.revisionId);
assert.equal(normalized.source.publicDocumentUrl, sourceUrl(retained.docId));
assert.equal(normalized.eligibility.state, "record_only");
assert.deepEqual(normalized.eligibility.reasonCodes, [
  "stale_disclosure",
  "unresolved_member",
  "unresolved_security",
]);
assert.equal(JSON.stringify(normalized).includes("exactAmount"), false);
assert.equal(JSON.stringify(normalized).includes("score"), false);
assert.throws(() => houseStrategyTransactionSchema.parse({ ...normalized, exactAmount: "1001" }));

const signalCore = {
  alertEligible: false,
  band: "record_only" as const,
  catalogReferences: normalized.catalogReferences,
  createdAt: observedAt,
  filingLogicalKey: normalized.source.filingLogicalKey,
  lineage: { correctionId: null, priorRevisionId: null, retractionId: null, state: "active" as const },
  packBinding: normalized.packBinding,
  policyReference: normalized.policyReference,
  reasonTrace: normalized.eligibility.reasonCodes.map((reasonCode) => ({
    reasonCode,
    sourceRevisionId: normalized.transactionRevisionId,
    state: "applied" as const,
  })),
  recordType: "congressional_filing_signal" as const,
  schemaVersion: 1 as const,
  signalId: deriveCongressionalSignalId({
    filingLogicalKey: normalized.source.filingLogicalKey,
    packBinding: normalized.packBinding,
    workspaceId,
  }),
  transactionEvaluations: [{
    band: "record_only" as const,
    evidence: [
      { reasonCode: "committee_cluster" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
      { reasonCode: "committee_relevant" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
      { reasonCode: "material_range" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
      { reasonCode: "pattern_break" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
      { reasonCode: "same_member_cluster" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
      { reasonCode: "timely" as const, sourceRecordIds: [normalized.transactionRevisionId], state: "not_applicable" as const },
    ],
    committeeResolution: { assignmentIds: [], jurisdictionIds: [], state: "unknown" as const },
    reasonCodes: normalized.eligibility.reasonCodes,
    transactionRevisionId: normalized.transactionRevisionId,
  }],
  workspaceId,
};
const signal = congressionalFilingSignalSchema.parse({
  ...signalCore,
  signalRevisionId: deriveCongressionalSignalRevisionId(signalCore),
});
assert.equal(signal.band, "record_only");
assert.throws(() => congressionalFilingSignalSchema.parse({ ...signal, numericScore: 0 }));

// Existing explicit zero-row and unsupported fixtures stay non-transactions at
// the source boundary; normalization has no input to reinterpret as inactivity.
for (const [name, documentFile, expectedState, member] of [
  ["zero-row", "real-layout/ptr-no-transactions.pdf", "complete", {
    docId: "20000012",
    filingDate: "05/01/2026",
    firstName: "Taylor",
    lastName: "Example",
    stateDistrict: "VTAL",
  }],
  ["unsupported", "real-layout/ptr-scanned.pdf", "unsupported", {
    docId: "20000011",
    filingDate: "03/04/2026",
    firstName: "Jordan",
    lastName: "Sample",
    stateDistrict: "OR03",
  }],
] as const) {
  const body = new Uint8Array(await readFile(new URL(documentFile, houseRoot)));
  const candidateXml = `<?xml version="1.0" encoding="UTF-8"?>
<FinancialDisclosure><Member><Prefix>Hon.</Prefix><Last>${member.lastName}</Last><First>${member.firstName}</First><Suffix></Suffix><FilingType>P</FilingType><StateDst>${member.stateDistrict}</StateDst><Year>2026</Year><FilingDate>${member.filingDate}</FilingDate><DocID>${member.docId}</DocID></Member></FinancialDisclosure>`;
  const candidate = await runHousePublicSourceAcquisition({
    client: new MemoryStore(),
    fetchDocument: async (url) => response(body, "application/pdf", url),
    fetchIndex: async (url) => response(await zipHouseIndex(candidateXml), "application/zip", url),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: { startAt: "2026-08-16T06:00:00.000Z", endAt: observedAt },
  });
  const transactions = candidate.acquisition.facts.filter(
    (fact) => fact.factSchemaVersion === "house-ptr-transaction/v1",
  );
  assert.equal(candidate.acquisition.result.status, "complete", name);
  assert.equal(candidate.acquisition.facts.length, 1, name);
  assert.equal(transactions.length, 0, name);
  assert.equal(candidate.acquisition.facts[0]!.extraction.state, expectedState, name);
}

console.log("Congressional Signals Sprint 0 contract verification passed");
