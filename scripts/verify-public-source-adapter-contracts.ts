import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  PUBLIC_SOURCE_ADAPTER_IDS,
  PUBLIC_SOURCE_ERROR_CODES,
  PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS,
  PUBLIC_SOURCE_LOG_EVENTS,
  PUBLIC_SOURCE_LIMITS,
  canonicalPublicFactRevisionSchema,
  deriveCanonicalPublicFactLogicalKey,
  deriveCanonicalPublicFactRevisionId,
  derivePublicSourceAdapterDefinitionDigest,
  digestPublicSourceValue,
  parsePublicSourceRecord,
  publicSourceAcquisitionJournalSchema,
  publicSourceAcquisitionResultSchema,
  publicSourceAdapterDefinitionSchema,
  publicSourceCorrectionSchema,
  publicSourceInstanceSchema,
  publicSourceLogEventSchema,
  publicSourceProjectionSchema,
  publicSourceRetractionProjectionSchema,
  publicSourceRetractionSchema,
  publicSourceSubscriptionSchema,
} from "../agent/lib/public-source-adapter-schema";
import {
  HouseFeasibilityError,
  inspectHouseIndexArchive,
  inspectHousePtrPdf,
} from "../agent/lib/house-public-source-feasibility";

const fixtureRoot = new URL("./fixtures/public-source-adapters/", import.meta.url);
const houseFixtureRoot = new URL("house/real-layout/", fixtureRoot);
const readJson = async (url: URL) => JSON.parse(await readFile(url, "utf8")) as unknown;
const readBytes = async (url: URL) => new Uint8Array(await readFile(url));
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const observedAt = "2026-08-15T18:00:00.000Z";

assert.deepEqual([...PUBLIC_SOURCE_ADAPTER_IDS].sort(), [...PUBLIC_SOURCE_ADAPTER_IDS]);
assert.deepEqual([...PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS].sort(), [...PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS]);
assert.deepEqual([...PUBLIC_SOURCE_ERROR_CODES].sort(), [...PUBLIC_SOURCE_ERROR_CODES]);
assert.deepEqual([...PUBLIC_SOURCE_LOG_EVENTS].sort(), [...PUBLIC_SOURCE_LOG_EVENTS]);
assert.equal(new Set(PUBLIC_SOURCE_ERROR_CODES).size, PUBLIC_SOURCE_ERROR_CODES.length);

const secDefinitionCore = {
  acquisitionMethod: "poll",
  adapterId: "sec-latest-filings",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://www.sec.gov",
  configurationSchemaVersion: 1,
  factSchemaVersions: ["sec-filing/v1"],
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: PUBLIC_SOURCE_LIMITS.maximumArchiveBytes,
    maximumFactsPerAcquisition: 100,
    maximumPdfBytes: PUBLIC_SOURCE_LIMITS.maximumPdfBytes,
    maximumPdfPages: PUBLIC_SOURCE_LIMITS.maximumPdfPages,
    maximumResponseBytes: 2 * 1024 * 1024,
  },
  maximumCadenceMinutes: 1_440,
  minimumCadenceMinutes: 15,
  recordType: "public_source_adapter_definition",
  schemaVersion: 1,
} as const;
const secDefinition = {
  ...secDefinitionCore,
  definitionDigest: derivePublicSourceAdapterDefinitionDigest(secDefinitionCore),
} as const;
assert.deepEqual(publicSourceAdapterDefinitionSchema.parse(secDefinition), secDefinition);

const { definitionDigest: _secDefinitionDigest, ...houseDefinitionBase } = secDefinition;
const houseDefinitionCore = {
  ...houseDefinitionBase,
  adapterId: "house-financial-disclosures",
  authorityOrigin: "https://disclosures-clerk.house.gov",
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  minimumCadenceMinutes: 60,
} as const;
const houseDefinition = publicSourceAdapterDefinitionSchema.parse({
  ...houseDefinitionCore,
  definitionDigest: derivePublicSourceAdapterDefinitionDigest(houseDefinitionCore),
});

const secConfiguration = {
  canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom",
  kind: "sec_latest_s1",
} as const;
const secSource = publicSourceInstanceSchema.parse({
  adapterDefinitionDigest: secDefinition.definitionDigest,
  adapterId: "sec-latest-filings",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://www.sec.gov",
  cadenceMinutes: 60,
  configuration: secConfiguration,
  configurationDigest: digestPublicSourceValue(secConfiguration),
  cursor: { contentDigest: null, revision: 0, watermark: null },
  lifecycleState: "active",
  recordType: "public_source_instance",
  schemaVersion: 1,
  sourceInstanceId: "source.sec-latest-s1-filings",
});

const houseConfiguration = {
  canonicalUrl: "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip",
  kind: "house_financial_disclosures_year",
  year: 2026,
} as const;
const houseSource = publicSourceInstanceSchema.parse({
  ...secSource,
  adapterDefinitionDigest: digestB,
  adapterId: "house-financial-disclosures",
  authorityOrigin: "https://disclosures-clerk.house.gov",
  cadenceMinutes: 360,
  configuration: houseConfiguration,
  configurationDigest: digestPublicSourceValue(houseConfiguration),
  sourceInstanceId: "source.house-financial-disclosures.2026",
});

const proposedCursor = {
  contentDigest: digestA,
  expectedRevision: 0,
  watermark: observedAt,
};
const acquisitionResult = publicSourceAcquisitionResultSchema.parse({
  acquisitionId: "acquisition.fixture.1",
  adapterDefinitionDigest: digestA,
  adapterId: "sec-latest-filings",
  adapterVersion: "1.0.0",
  baselineEstablished: true,
  candidateFactRevisionIds: [],
  correctionIds: [],
  retractionIds: [],
  coverage: "complete",
  errorCode: null,
  observedAt,
  proposedNextCursor: proposedCursor,
  recordType: "public_source_acquisition_result",
  retryAfterSeconds: null,
  schemaVersion: 1,
  sourceInstanceId: secSource.sourceInstanceId,
  stageReceipts: [{
    errorCode: null,
    inputDigest: digestA,
    outputDigest: digestB,
    stage: "transport",
    status: "complete",
  }],
  status: "complete",
});

const journal = publicSourceAcquisitionJournalSchema.parse({
  acquisitionId: acquisitionResult.acquisitionId,
  adapterDefinitionDigest: digestA,
  committedAt: null,
  correctionIds: [],
  retractionIds: [],
  expectedCursorRevision: 0,
  factRevisionIds: [],
  preparedAt: observedAt,
  proposedCursor,
  recordType: "public_source_acquisition_journal",
  schemaVersion: 1,
  sourceInstanceId: secSource.sourceInstanceId,
  status: "prepared",
  window: {
    endAt: observedAt,
    startAt: "2026-08-15T17:00:00.000Z",
  },
});

const secPayload = {
  accessionNumber: "0001000001-26-000001",
  amendmentOfAccessionNumber: null,
  cik: "0001000001",
  companyName: "Fixture Registration Corp",
  fileNumber: "333-100001",
  filingUrl: "https://www.sec.gov/Archives/edgar/data/1000001/000100000126000001/fixture-s1.htm",
  formType: "S-1",
  publishedAt: "2026-08-14T15:59:00.000Z",
  schemaVersion: "sec-filing/v1",
  updatedAt: "2026-08-14T16:00:00.000Z",
} as const;
const secFactBase = {
  adapterId: "sec-latest-filings",
  createdObservedAt: observedAt,
  extraction: { errorCode: null, state: "complete" },
  factSchemaVersion: secPayload.schemaVersion,
  payload: secPayload,
  payloadDigest: digestPublicSourceValue(secPayload),
  provenance: {
    authority: "SEC",
    documentDigest: null,
    publicUrl: secPayload.filingUrl,
    rowEvidenceDigest: null,
  },
  recordType: "canonical_public_fact_revision",
  schemaVersion: 1,
  sourceInstanceId: secSource.sourceInstanceId,
  sourceNativeId: `${secPayload.accessionNumber}:${secPayload.formType}`,
  sourceTimes: {
    publishedAt: secPayload.publishedAt,
    updatedAt: secPayload.updatedAt,
  },
  stableRowIdentity: "filing",
} as const;
const secLogicalKey = deriveCanonicalPublicFactLogicalKey(secFactBase);
const secFact = canonicalPublicFactRevisionSchema.parse({
  ...secFactBase,
  logicalKey: secLogicalKey,
  revisionId: deriveCanonicalPublicFactRevisionId({
    logicalKey: secLogicalKey,
    payloadDigest: secFactBase.payloadDigest,
  }),
});
assert.equal(
  deriveCanonicalPublicFactRevisionId({
    logicalKey: secFact.logicalKey,
    payloadDigest: secFact.payloadDigest,
  }),
  secFact.revisionId,
);

const filingPayload = {
  amendedDocId: null,
  docId: "20000011",
  extraction: { errorCode: null, state: "complete" },
  filer: {
    firstName: "Jordan",
    lastName: "Sample",
    prefix: "Hon.",
    stateDistrict: "OR03",
    suffix: "Jr.",
  },
  filingDate: "2026-03-04",
  isAmendment: false,
  publicDocumentUrl: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20000011.pdf",
  schemaVersion: "house-ptr-filing/v1",
  year: 2026,
} as const;
const factBase = {
  adapterId: "house-financial-disclosures",
  createdObservedAt: observedAt,
  extraction: filingPayload.extraction,
  factSchemaVersion: filingPayload.schemaVersion,
  payload: filingPayload,
  payloadDigest: digestPublicSourceValue(filingPayload),
  provenance: {
    authority: "House Clerk",
    documentDigest: digestA,
    publicUrl: filingPayload.publicDocumentUrl,
    rowEvidenceDigest: null,
  },
  recordType: "canonical_public_fact_revision",
  schemaVersion: 1,
  sourceInstanceId: houseSource.sourceInstanceId,
  sourceNativeId: "2026:20000011",
  sourceTimes: { publishedAt: null, updatedAt: null },
  stableRowIdentity: "filing",
} as const;
const logicalKey = deriveCanonicalPublicFactLogicalKey(factBase);
const fact = canonicalPublicFactRevisionSchema.parse({
  ...factBase,
  logicalKey,
  revisionId: deriveCanonicalPublicFactRevisionId({
    logicalKey,
    payloadDigest: factBase.payloadDigest,
  }),
});

const transactionPayload = {
  amountRange: { label: "$1,001 - $15,000", lower: "1001", upper: "15000" },
  assetDescription: "Example Corp - Common Stock (EXM) [ST]",
  capitalGainsIndicator: "no",
  docId: "20000011",
  extraction: { errorCode: null, state: "complete" },
  filingLogicalKey: fact.logicalKey,
  notificationDate: "2026-03-04",
  ownerCode: "SP",
  publicDocumentUrl: filingPayload.publicDocumentUrl,
  reportedTicker: "EXM",
  rowIdentity: "row:1",
  schemaVersion: "house-ptr-transaction/v1",
  transactionDate: "2026-02-20",
  transactionType: "P",
  year: 2026,
} as const;
const transactionFactBase = {
  ...factBase,
  factSchemaVersion: transactionPayload.schemaVersion,
  payload: transactionPayload,
  payloadDigest: digestPublicSourceValue(transactionPayload),
  provenance: { ...factBase.provenance, rowEvidenceDigest: digestB },
  stableRowIdentity: "row:1",
};
const transactionLogicalKey = deriveCanonicalPublicFactLogicalKey(transactionFactBase);
const transactionFact = canonicalPublicFactRevisionSchema.parse({
  ...transactionFactBase,
  logicalKey: transactionLogicalKey,
  revisionId: deriveCanonicalPublicFactRevisionId({
    logicalKey: transactionLogicalKey,
    payloadDigest: transactionFactBase.payloadDigest,
  }),
});
assert.notEqual(fact.revisionId, transactionFact.revisionId);

const correction = publicSourceCorrectionSchema.parse({
  correctionId: `correction.${digestPublicSourceValue([
    fact.logicalKey,
    fact.revisionId,
    "fact-revision.corrected",
    "source_correction",
  ])}`,
  createdObservedAt: observedAt,
  fromRevisionId: fact.revisionId,
  logicalKey: fact.logicalKey,
  reason: "source_correction",
  recordType: "public_source_fact_correction",
  schemaVersion: 1,
  toRevisionId: "fact-revision.corrected",
});
const retraction = publicSourceRetractionSchema.parse({
  createdObservedAt: observedAt,
  fromRevisionId: transactionFact.revisionId,
  logicalKey: transactionFact.logicalKey,
  reason: "source_amendment",
  recordType: "public_source_fact_retraction",
  retractionId: `retraction.${digestPublicSourceValue([
    transactionFact.logicalKey,
    transactionFact.revisionId,
    "source_amendment",
  ])}`,
  schemaVersion: 1,
  sourceInstanceId: houseSource.sourceInstanceId,
});
assert.equal(
  publicSourceRetractionSchema.safeParse({ ...retraction, retractionId: "retraction.invalid" }).success,
  false,
);

const subscription = publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: digestB,
  adapterVersion: "1.0.0",
  deliveryCursor: { lastAcquisitionId: null, revision: 0 },
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" },
  lifecycleState: "active",
  monitorId: "monitor.fixture.house",
  packBinding: null,
  recordType: "public_source_subscription",
  schemaVersion: 1,
  sourceInstanceId: houseSource.sourceInstanceId,
  subscriptionId: "subscription.fixture.house",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
});
const projectionId = `projection.${digestPublicSourceValue([
  subscription.subscriptionId,
  fact.revisionId,
])}`;
const projection = publicSourceProjectionSchema.parse({
  acquisitionId: "acquisition.fixture.house",
  factRevisionId: fact.revisionId,
  factSchemaVersion: fact.factSchemaVersion,
  monitorId: subscription.monitorId,
  projectedAt: observedAt,
  projectionId,
  recordType: "public_source_fact_projection",
  schemaVersion: 1,
  sourceInstanceId: houseSource.sourceInstanceId,
  subscriptionId: subscription.subscriptionId,
  workspaceId: subscription.workspaceId,
});
const retractionProjection = publicSourceRetractionProjectionSchema.parse({
  acquisitionId: "acquisition.fixture.house-amendment",
  factRevisionId: transactionFact.revisionId,
  factSchemaVersion: transactionFact.factSchemaVersion,
  monitorId: subscription.monitorId,
  projectedAt: observedAt,
  projectionId: `projection.${digestPublicSourceValue([
    subscription.subscriptionId,
    retraction.retractionId,
  ])}`,
  recordType: "public_source_fact_retraction_projection",
  retractionId: retraction.retractionId,
  schemaVersion: 1,
  sourceInstanceId: houseSource.sourceInstanceId,
  subscriptionId: subscription.subscriptionId,
  workspaceId: subscription.workspaceId,
});
assert.equal(
  publicSourceRetractionProjectionSchema.safeParse({
    ...retractionProjection,
    projectionId: "projection.invalid",
  }).success,
  false,
);

const validRecords = [
  secDefinition,
  houseDefinition,
  secSource,
  houseSource,
  acquisitionResult,
  journal,
  secFact,
  fact,
  transactionFact,
  correction,
  retraction,
  subscription,
  projection,
  retractionProjection,
];
for (const record of validRecords) assert.deepEqual(parsePublicSourceRecord(record), record);

const invalidFixtures = await readJson(new URL("contracts.invalid.json", fixtureRoot)) as {
  cases: Array<{
    expectedIssueCode: string;
    fixtureId: string;
    patch: Record<string, unknown>;
    schema: "acquisition_result" | "adapter" | "fact" | "fact_payload" | "log_event" | "source_instance";
  }>;
};
for (const fixture of invalidFixtures.cases) {
  let schema;
  let candidate: Record<string, unknown>;
  switch (fixture.schema) {
    case "adapter":
      schema = publicSourceAdapterDefinitionSchema;
      candidate = { ...secDefinition, ...fixture.patch };
      break;
    case "source_instance":
      schema = publicSourceInstanceSchema;
      candidate = { ...houseSource, ...fixture.patch };
      break;
    case "acquisition_result":
      schema = publicSourceAcquisitionResultSchema;
      candidate = { ...acquisitionResult, ...fixture.patch };
      break;
    case "fact":
      schema = canonicalPublicFactRevisionSchema;
      candidate = { ...fact, ...fixture.patch };
      break;
    case "fact_payload":
      schema = canonicalPublicFactRevisionSchema;
      candidate = {
        ...transactionFact,
        payload: { ...transactionFact.payload, ...fixture.patch },
      };
      break;
    case "log_event":
      schema = publicSourceLogEventSchema;
      candidate = {
        adapterId: "sec-latest-filings",
        errorCode: null,
        event: "acquisition_started",
        factSchemaVersion: null,
        outcome: null,
        stage: null,
        ...fixture.patch,
      };
      break;
  }
  const parsed = schema.safeParse(candidate);
  assert.equal(parsed.success, false, fixture.fixtureId);
  assert.equal(
    parsed.success ? null : parsed.error.issues.some((issue) => issue.code === fixture.expectedIssueCode),
    true,
    fixture.fixtureId,
  );
}

const sourcePlaneFiles = [
  new URL("../agent/lib/public-source-adapter-schema.ts", import.meta.url),
  new URL("../agent/lib/public-source-acquisition-store.ts", import.meta.url),
  new URL("../agent/lib/public-source-flags.ts", import.meta.url),
  new URL("../agent/lib/public-source-registry.ts", import.meta.url),
  new URL("../agent/lib/sec-public-source-adapter.ts", import.meta.url),
  new URL("../agent/lib/house-public-source-feasibility.ts", import.meta.url),
  new URL("../agent/lib/house-public-source-adapter.ts", import.meta.url),
];
for (const sourceFile of sourcePlaneFiles) {
  const source = await readFile(sourceFile, "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:photon|channel|alert)[^"']*["']/iu);
}
assert.throws(() => publicSourceLogEventSchema.parse({
  adapterId: "sec-latest-filings",
  errorCode: null,
  event: "acquisition_started",
  factSchemaVersion: null,
  outcome: null,
  stage: null,
  workspaceId: subscription.workspaceId,
}));

const houseCorpus = await readJson(new URL("corpus.json", houseFixtureRoot)) as {
  cases: Array<{
    expectedErrorCode?: string;
    expectedLayout?: string;
    expectedPages?: number;
    expectedRows?: number;
    expectedStatus: string;
    expectedXmlFilename?: string;
    fixtureId: string;
    input: string;
    kind: "index_zip" | "ptr_pdf";
  }>;
  layoutBasis: string;
  schemaVersion: number;
};
assert.equal(houseCorpus.schemaVersion, 1);
assert.match(houseCorpus.layoutBasis, /official House Clerk PTR form/iu);
for (const fixture of houseCorpus.cases) {
  const bytes = await readBytes(new URL(fixture.input, houseFixtureRoot));
  if (fixture.kind === "index_zip") {
    const inspected = await inspectHouseIndexArchive(bytes, 2026);
    assert.equal(inspected.xmlFilename, fixture.expectedXmlFilename, fixture.fixtureId);
    assert.equal(inspected.memberCount, 2, fixture.fixtureId);
    assert.equal(inspected.ptrCount, 1, fixture.fixtureId);
    assert.match(inspected.xml, /<FilingType>P<\/FilingType>/u, fixture.fixtureId);
    continue;
  }
  try {
    const inspected = await inspectHousePtrPdf(bytes);
    assert.equal(inspected.extractionState, fixture.expectedStatus, fixture.fixtureId);
    assert.equal(inspected.layout, fixture.expectedLayout, fixture.fixtureId);
    assert.equal(inspected.pageCount, fixture.expectedPages, fixture.fixtureId);
    assert.equal(inspected.transactionRowCount, fixture.expectedRows, fixture.fixtureId);
    assert.equal(inspected.errorCode ?? undefined, fixture.expectedErrorCode, fixture.fixtureId);
  } catch (error) {
    assert.equal(fixture.expectedStatus, "terminal_failure", fixture.fixtureId);
    assert.equal(error instanceof HouseFeasibilityError ? error.code : null, fixture.expectedErrorCode, fixture.fixtureId);
  }
}

await assert.rejects(
  inspectHouseIndexArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 2026),
  (error: unknown) => error instanceof HouseFeasibilityError && error.code === "archive_invalid",
);
await assert.rejects(
  inspectHousePtrPdf(new Uint8Array(PUBLIC_SOURCE_LIMITS.maximumPdfBytes + 1)),
  (error: unknown) => error instanceof HouseFeasibilityError && error.code === "transport_response_oversized",
);

const secCorpus = await readJson(new URL("sec/corpus.json", fixtureRoot)) as {
  cases: Array<{ expectedCoverage: string; expectedFacts: unknown[]; expectedStatus: string; fixtureId: string }>;
  schemaVersion: number;
};
assert.equal(secCorpus.schemaVersion, 1);
assert.ok(secCorpus.cases.length >= 5);
for (const fixture of secCorpus.cases) {
  assert.ok(["complete", "no_change", "partial", "terminal_failure"].includes(fixture.expectedStatus), fixture.fixtureId);
  assert.ok(["complete", "partial", "unsupported"].includes(fixture.expectedCoverage), fixture.fixtureId);
  assert.ok(Array.isArray(fixture.expectedFacts), fixture.fixtureId);
}

console.info("Public source adapter Sprint 0 contract and House feasibility verification passed.");
