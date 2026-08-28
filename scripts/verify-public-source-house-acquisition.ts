import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import {
  readLatestPublicSourceFactRevision,
  readPublicSourceInstance,
  type PublicSourceAcquisitionStoreClient,
} from "../agent/lib/public-source-acquisition-store";
import { PUBLIC_SOURCE_LIMITS } from "../agent/lib/public-source-adapter-schema";
import { publicSourceSubscriptionSchema } from "../agent/lib/public-source-adapter-schema";
import {
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "../agent/lib/strategy-pack-reference-catalog";
import {
  parseHouseTransactionAmountRange,
  runHousePublicSourceAcquisition,
  runSharedHousePublicSourceAcquisition,
  type HousePublicSourceBinaryResponse,
} from "../agent/lib/house-public-source-adapter";
import { fetchOfficialPublicSourceBytes, PublicSourceHttpStatusError } from "../agent/tools/fetch_public_source";
import {
  derivePublicSourceSubscriptionId,
  ensurePublicSourceSubscription,
  projectPublicSourceAcquisition,
} from "../agent/lib/public-source-subscription-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements PublicSourceAcquisitionStoreClient {
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

const corpusRoot = new URL("./fixtures/public-source-adapters/house/real-layout/", import.meta.url);
const liveReviewRoot = new URL(
  "./fixtures/public-source-adapters/house/live-review-2026-08-16/",
  import.meta.url,
);
const bytes = async (name: string) => new Uint8Array(await readFile(new URL(name, corpusRoot)));
const feasibilitySource = await readFile(
  new URL("../agent/lib/house-public-source-feasibility.ts", import.meta.url),
  "utf8",
);
assert.match(
  feasibilitySource,
  /canvasModule \?\?= import\("@napi-rs\/canvas"\)/u,
  "the House PDF runtime must keep a literal lazy canvas import so Eve/Nitro traces the platform binary",
);
const window = (endAt: string) => ({
  endAt,
  startAt: new Date(Date.parse(endAt) - 6 * 60 * 60 * 1_000).toISOString(),
});
const ptrUrl = (docId: string) =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/${docId}.pdf`;

function response(input: {
  body: Uint8Array;
  contentType: string;
  observedAt: string;
  url: string;
}): HousePublicSourceBinaryResponse {
  return Object.freeze({
    body: input.body,
    contentType: input.contentType,
    finalUrl: input.url,
    observedAt: input.observedAt,
    requestedUrl: input.url,
    status: 200,
  });
}

async function zipXml(xml: string): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("2026FD.xml", new TextReader(xml));
  return writer.close();
}

function indexXml(rows: readonly {
  docId: string;
  filingDate: string;
  first: string;
  last: string;
  prefix?: string;
  stateDistrict: string;
  suffix?: string;
}[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<FinancialDisclosure>
${rows.map((row) => `  <Member>
    <Prefix>${row.prefix ?? "Hon."}</Prefix><Last>${row.last}</Last><First>${row.first}</First><Suffix>${row.suffix ?? ""}</Suffix>
    <FilingType>P</FilingType><StateDst>${row.stateDistrict}</StateDst><Year>2026</Year>
    <FilingDate>${row.filingDate}</FilingDate><DocID>${row.docId}</DocID>
  </Member>`).join("\n")}
</FinancialDisclosure>`;
}

const singlePdf = await bytes("ptr-single-row.pdf");
const amendedPdf = await bytes("ptr-multi-page-amended.pdf");
const correctedAmendedPdf = await bytes("ptr-multi-page-amended-corrected.pdf");
const rowRemovedAmendedPdf = await bytes("ptr-multi-page-amended-row-removed.pdf");
const noTransactionsPdf = await bytes("ptr-no-transactions.pdf");
const ambiguousPdf = await bytes("ptr-ambiguous.pdf");
const scannedPdf = await bytes("ptr-scanned.pdf");
const malformedPdf = await bytes("malformed.pdf");
const representativeIndex = await bytes("2026FD.zip");

interface LiveReviewManifest {
  readonly documents: readonly {
    readonly disclosedFiler: {
      readonly firstName: string;
      readonly lastName: string;
      readonly prefix: string | null;
      readonly stateDistrict: string;
      readonly suffix: string | null;
    };
    readonly docId: string;
    readonly filingDate: string;
    readonly independentReviewClassification: "transaction_bearing";
    readonly retainedFile: string;
  }[];
}

const liveReviewManifest = JSON.parse(
  await readFile(new URL("manifest.json", liveReviewRoot), "utf8"),
) as LiveReviewManifest;

function houseIndexDate(value: string): string {
  const [year, month, day] = value.split("-");
  assert.ok(year && month && day, `invalid retained filing date: ${value}`);
  return `${month}/${day}/${year}`;
}

// The production byte transport streams under an explicit bound while reusing
// the official-source origin/redirect/timeout fence. No live read occurs here.
const originalFetch = globalThis.fetch;
try {
  let transportUrl = "";
  globalThis.fetch = async (request) => {
    transportUrl = String(request);
    return new Response(singlePdf, { headers: { "content-type": "application/pdf" } });
  };
  const transported = await fetchOfficialPublicSourceBytes(
    ptrUrl("20000011"),
    PUBLIC_SOURCE_LIMITS.maximumPdfBytes,
    { origin: "https://disclosures-clerk.house.gov" },
  );
  assert.equal(transportUrl, ptrUrl("20000011"));
  assert.deepEqual(transported.body, singlePdf);

  globalThis.fetch = async () => new Response(new Uint8Array(11));
  await assert.rejects(
    fetchOfficialPublicSourceBytes(
      ptrUrl("20000011"),
      10,
      { origin: "https://disclosures-clerk.house.gov" },
    ),
    /too large/u,
  );
} finally {
  globalThis.fetch = originalFetch;
}

// Representative checked-in baseline: the exact yearly archive selects only
// its PTR row, derives the exact official PDF URL, and emits filing + row facts.
const baselineClient = new MemoryStore();
const baselineObservedAt = "2026-08-15T18:00:00.000Z";
const requestedDocuments: string[] = [];
const baseline = await runHousePublicSourceAcquisition({
  client: baselineClient,
  fetchDocument: async (url) => {
    requestedDocuments.push(url);
    return response({ body: singlePdf, contentType: "application/pdf", observedAt: baselineObservedAt, url });
  },
  fetchIndex: async (url) => response({
    body: representativeIndex,
    contentType: "application/zip",
    observedAt: baselineObservedAt,
    url,
  }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(baselineObservedAt),
});
assert.equal(HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL.endsWith("/2026FD.zip"), true);
assert.deepEqual(requestedDocuments, [ptrUrl("20000011")]);
assert.equal(baseline.acquisition.baselineEstablished, true);
assert.equal(baseline.acquisition.result.status, "complete");
assert.equal(baseline.acquisition.facts.length, 2);
assert.ok(baseline.commit);
assert.equal(baseline.commit.factsCreated, 2);
const filing = baseline.acquisition.facts.find((fact) => fact.factSchemaVersion === "house-ptr-filing/v1")!;
const transaction = baseline.acquisition.facts.find((fact) => fact.factSchemaVersion === "house-ptr-transaction/v1")!;
assert.deepEqual(filing.payload.schemaVersion === "house-ptr-filing/v1" ? filing.payload.filer : null, {
  firstName: "Jordan",
  lastName: "Sample",
  prefix: "Hon.",
  stateDistrict: "OR03",
  suffix: "Jr.",
});
assert.deepEqual(
  transaction.payload.schemaVersion === "house-ptr-transaction/v1"
    ? transaction.payload.amountRange
    : null,
  { label: "$1,001 - $15,000", lower: "1001", upper: "15000" },
);
assert.equal(
  transaction.payload.schemaVersion === "house-ptr-transaction/v1"
    ? transaction.payload.reportedTicker
    : null,
  "EXM",
);
assert.equal(
  transaction.payload.schemaVersion === "house-ptr-transaction/v1"
    ? transaction.payload.ownerCode
    : null,
  "SP",
);
assert.equal(
  transaction.payload.schemaVersion === "house-ptr-transaction/v1"
    ? transaction.payload.assetDescription
    : null,
  "Example Corp - Common Stock (EXM) [ST]",
);
assert.equal(JSON.stringify(baseline.acquisition.facts).includes("workspaceId"), false);
assert.deepEqual(parseHouseTransactionAmountRange("Over $5,000,000"), {
  label: "Over $5,000,000",
  lower: "5000001",
  upper: null,
});

// A representative-scale yearly index is accepted, but each occurrence reads
// only the reviewed document budget and advances a durable baseline batch.
const largeBaselineRows = Array.from({ length: 501 }, (_, index) => ({
  docId: String(21_000_000 + index),
  // The official yearly index uses non-zero-padded month/day values.
  filingDate: "3/4/2026",
  first: "Jordan",
  last: "Sample",
  stateDistrict: "OR03",
  suffix: "Jr.",
}));
const largeBaselineArchive = await zipXml(indexXml(largeBaselineRows));
const largeBaselineClient = new MemoryStore();
let largeBaselineFetches = 0;
const runLargeBaselineBatch = async (observedAt: string) =>
  runHousePublicSourceAcquisition({
    client: largeBaselineClient,
    fetchDocument: async (url) => {
      largeBaselineFetches += 1;
      return response({ body: scannedPdf, contentType: "application/pdf", observedAt, url });
    },
    fetchIndex: async (url) => response({
      body: largeBaselineArchive,
      contentType: "application/zip",
      observedAt,
      url,
    }),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
const largeBaselineFirst = await runLargeBaselineBatch("2026-08-15T19:00:00.000Z");
assert.equal(largeBaselineFirst.acquisition.result.status, "complete");
assert.equal(largeBaselineFirst.acquisition.baselineEstablished, true);
assert.equal(
  largeBaselineFirst.acquisition.facts.length,
  PUBLIC_SOURCE_LIMITS.maximumHouseDocumentsPerAcquisition,
);
const normalizedLargeBaselineFiling = largeBaselineFirst.acquisition.facts[0]?.payload;
assert.equal(
  normalizedLargeBaselineFiling?.schemaVersion === "house-ptr-filing/v1"
    ? normalizedLargeBaselineFiling.filingDate
    : null,
  "2026-03-04",
);
assert.equal(largeBaselineFetches, PUBLIC_SOURCE_LIMITS.maximumHouseDocumentsPerAcquisition);
assert.match(largeBaselineFirst.commit?.sourceInstance.cursor.watermark ?? "", /^baseline:/u);
const largeBaselineSecond = await runLargeBaselineBatch("2026-08-16T01:00:00.000Z");
assert.equal(largeBaselineSecond.acquisition.baselineEstablished, true);
assert.equal(
  largeBaselineFetches,
  PUBLIC_SOURCE_LIMITS.maximumHouseDocumentsPerAcquisition * 2,
);
assert.equal(largeBaselineSecond.commit?.sourceInstance.cursor.revision, 2);

// Same-window replay is source-global and performs no second external read.
let replayReads = 0;
const replay = await runSharedHousePublicSourceAcquisition({
  client: baselineClient,
  fetchDocument: async () => {
    replayReads += 1;
    throw new Error("replay must not fetch a document");
  },
  fetchIndex: async () => {
    replayReads += 1;
    throw new Error("replay must not fetch the index");
  },
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(baselineObservedAt),
});
assert.equal(replayReads, 0);
assert.equal(replay.reused, true);
assert.equal(replay.acquisition.acquisitionId, baseline.acquisition.result.acquisitionId);

// A changed archive with one new row selects only that row. The explicit
// no-transaction document emits a filing fact without inventing transactions.
const laterObservedAt = "2026-08-15T21:00:00.000Z";
const laterIndex = await zipXml(indexXml([
  { docId: "20000011", filingDate: "03/04/2026", first: "Jordan", last: "Sample", stateDistrict: "OR03", suffix: "Jr." },
  { docId: "20000012", filingDate: "05/01/2026", first: "Taylor", last: "Example", stateDistrict: "VTAL" },
]));
const laterDocuments: string[] = [];
const later = await runHousePublicSourceAcquisition({
  client: baselineClient,
  fetchDocument: async (url) => {
    laterDocuments.push(url);
    return response({ body: noTransactionsPdf, contentType: "application/pdf", observedAt: laterObservedAt, url });
  },
  fetchIndex: async (url) => response({ body: laterIndex, contentType: "application/zip", observedAt: laterObservedAt, url }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(laterObservedAt),
});
assert.deepEqual(laterDocuments, [ptrUrl("20000012")]);
assert.equal(later.acquisition.baselineEstablished, false);
assert.equal(later.acquisition.facts.length, 1);
assert.equal(later.acquisition.facts[0]?.sourceNativeId, "2026:20000012");

// Amendment and multi-row extraction. A prior partial filing establishes the
// source-derived amendment link without inventing a prior document ID.
const amendmentClient = new MemoryStore();
const priorObservedAt = "2026-08-15T12:00:00.000Z";
const priorRows = [
  { docId: "20000020", filingDate: "03/01/2026", first: "Casey", last: "Fixture", stateDistrict: "CA12" },
] as const;
await runHousePublicSourceAcquisition({
  client: amendmentClient,
  fetchDocument: async (url) => response({ body: ambiguousPdf, contentType: "application/pdf", observedAt: priorObservedAt, url }),
  fetchIndex: async (url) => response({ body: await zipXml(indexXml(priorRows)), contentType: "application/zip", observedAt: priorObservedAt, url }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(priorObservedAt),
});
const amendmentObservedAt = "2026-08-15T15:00:00.000Z";
const amendmentRows = [
  ...priorRows,
  { docId: "20000021", filingDate: "04/10/2026", first: "Casey", last: "Fixture", stateDistrict: "CA12" },
] as const;
const amendment = await runHousePublicSourceAcquisition({
  client: amendmentClient,
  fetchDocument: async (url) => response({ body: amendedPdf, contentType: "application/pdf", observedAt: amendmentObservedAt, url }),
  fetchIndex: async (url) => response({ body: await zipXml(indexXml(amendmentRows)), contentType: "application/zip", observedAt: amendmentObservedAt, url }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(amendmentObservedAt),
});
assert.equal(amendment.acquisition.facts.length, 3);
const amendmentFiling = amendment.acquisition.facts.find((fact) => fact.factSchemaVersion === "house-ptr-filing/v1")!;
assert.equal(amendmentFiling.payload.schemaVersion === "house-ptr-filing/v1" ? amendmentFiling.payload.amendedDocId : "invalid", null);
assert.equal(amendmentFiling.payload.schemaVersion === "house-ptr-filing/v1" ? amendmentFiling.payload.isAmendment : false, true);
const amendmentTransactions = amendment.acquisition.facts.filter((fact) => fact.factSchemaVersion === "house-ptr-transaction/v1");
assert.deepEqual(amendmentTransactions.map((fact) => fact.stableRowIdentity), ["row:1", "row:2"]);
assert.deepEqual(amendmentTransactions.map((fact) => fact.payload.schemaVersion === "house-ptr-transaction/v1" ? fact.payload.amountRange.label : null), [
  "$15,001 - $50,000",
  "$1,001 - $15,000",
]);

// A corrected index row for the same DocID creates a new immutable filing
// revision and explicit correction while reusing unchanged transaction facts.
const correctedObservedAt = "2026-08-15T18:00:00.000Z";
const correctedRows = [
  priorRows[0],
  { ...amendmentRows[1], suffix: "Jr." },
] as const;
const corrected = await runHousePublicSourceAcquisition({
  client: amendmentClient,
  fetchDocument: async (url) => response({ body: correctedAmendedPdf, contentType: "application/pdf", observedAt: correctedObservedAt, url }),
  fetchIndex: async (url) => response({ body: await zipXml(indexXml(correctedRows)), contentType: "application/zip", observedAt: correctedObservedAt, url }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(correctedObservedAt),
});
assert.equal(corrected.acquisition.facts.length, 1);
assert.equal(corrected.acquisition.corrections.length, 1);
assert.equal(corrected.acquisition.corrections[0]?.reason, "source_correction");
const correctedFiling = corrected.acquisition.facts[0]!;
assert.equal((await readLatestPublicSourceFactRevision(correctedFiling.logicalKey, amendmentClient))?.revisionId, correctedFiling.revisionId);

// A later complete amendment for the same DocID retracts a formerly projected
// trailing row without deleting its immutable canonical fact revision.
const rowRemovedObservedAt = "2026-08-15T21:00:00.000Z";
const rowRemovedRows = [
  priorRows[0],
  { ...amendmentRows[1], suffix: "Sr." },
] as const;
const rowRemoved = await runHousePublicSourceAcquisition({
  client: amendmentClient,
  fetchDocument: async (url) => response({ body: rowRemovedAmendedPdf, contentType: "application/pdf", observedAt: rowRemovedObservedAt, url }),
  fetchIndex: async (url) => response({ body: await zipXml(indexXml(rowRemovedRows)), contentType: "application/zip", observedAt: rowRemovedObservedAt, url }),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: window(rowRemovedObservedAt),
});
assert.equal(Reflect.get(rowRemoved.acquisition, "retractions")?.length, 1);
assert.equal(Reflect.get(rowRemoved.acquisition.result, "retractionIds")?.length, 1);
assert.equal(
  await readLatestPublicSourceFactRevision(amendmentTransactions[1]!.logicalKey, amendmentClient),
  null,
);
const retractionWorkspaceId = "123e4567-e89b-42d3-a456-426614174100";
const retractionScope = authorizeDeploymentWorkspaceStore(
  { ownerId: "owner_fixture", workspaceId: retractionWorkspaceId },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
);
const retractionSource = (await readPublicSourceInstance(
  rowRemoved.acquisition.result.sourceInstanceId,
  amendmentClient,
))!;
const retractionSubscriptionId = derivePublicSourceSubscriptionId({
  monitorId: "monitor.fixture.house-retractions",
  sourceInstanceId: retractionSource.sourceInstanceId,
  workspaceId: retractionWorkspaceId,
});
await ensurePublicSourceSubscription(retractionScope, publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: retractionSource.adapterDefinitionDigest,
  adapterVersion: retractionSource.adapterVersion,
  deliveryCursor: { lastAcquisitionId: null, revision: 0 },
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" },
  lifecycleState: "active",
  monitorId: "monitor.fixture.house-retractions",
  packBinding: null,
  recordType: "public_source_subscription",
  schemaVersion: 1,
  sourceInstanceId: retractionSource.sourceInstanceId,
  subscriptionId: retractionSubscriptionId,
  workspaceId: retractionWorkspaceId,
}), amendmentClient);
const projectedRetraction = await projectPublicSourceAcquisition({
  acquisition: rowRemoved.acquisition.result,
  projectedAt: new Date(rowRemovedObservedAt),
  scope: retractionScope,
  subscriptionId: retractionSubscriptionId,
}, { acquisition: amendmentClient, subscription: amendmentClient });
assert.equal(projectedRetraction.retractions.length, 1);
assert.equal(projectedRetraction.retractionsCreated, 1);
assert.equal(projectedRetraction.retractions[0]?.fact.revisionId, amendmentTransactions[1]!.revisionId);
assert.equal(projectedRetraction.retractions[0]?.projection.recordType, "public_source_fact_retraction_projection");

// Partial and scanned layouts emit only a filing fact with explicit extraction
// state; they are completed classifications, so replay cannot skip a document.
for (const [name, documentBytes, expectedState, expectedError] of [
  ["partial", ambiguousPdf, "partial", "pdf_layout_ambiguous"],
  ["scanned", scannedPdf, "unsupported", "pdf_scanned_unsupported"],
] as const) {
  const client = new MemoryStore();
  const observedAt = name === "partial" ? "2026-08-16T00:00:00.000Z" : "2026-08-16T03:00:00.000Z";
  const result = await runHousePublicSourceAcquisition({
    client,
    fetchDocument: async (url) => response({ body: documentBytes, contentType: "application/pdf", observedAt, url }),
    fetchIndex: async (url) => response({ body: representativeIndex, contentType: "application/zip", observedAt, url }),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
  assert.equal(result.acquisition.result.status, "complete");
  assert.equal(result.acquisition.result.coverage, expectedState);
  assert.equal(result.acquisition.facts.length, 1);
  assert.deepEqual(result.acquisition.facts[0]?.extraction, { errorCode: expectedError, state: expectedState });
}

// The owner-authorized 2026-08-16 sample is a retained, immutable regression
// corpus. At least 80% of the literal newest 20 independently reviewed PTRs
// must yield a non-empty transaction projection through the production adapter.
let retainedTransactionBearingDocuments = 0;
let retainedExplicitNonTransactions = 0;
const retainedNonTransactions: string[] = [];
for (const document of liveReviewManifest.documents) {
  assert.equal(document.independentReviewClassification, "transaction_bearing");
  const client = new MemoryStore();
  const observedAt = "2026-08-16T18:00:00.000Z";
  const documentBytes = new Uint8Array(await readFile(new URL(document.retainedFile, liveReviewRoot)));
  const indexBody = await zipXml(indexXml([{
    docId: document.docId,
    filingDate: houseIndexDate(document.filingDate),
    first: document.disclosedFiler.firstName,
    last: document.disclosedFiler.lastName,
    prefix: document.disclosedFiler.prefix ?? undefined,
    stateDistrict: document.disclosedFiler.stateDistrict,
    suffix: document.disclosedFiler.suffix ?? undefined,
  }]));
  const result = await runHousePublicSourceAcquisition({
    client,
    fetchDocument: async (url) => response({
      body: documentBytes,
      contentType: "application/pdf",
      observedAt,
      url,
    }),
    fetchIndex: async (url) => response({
      body: indexBody,
      contentType: "application/zip",
      observedAt,
      url,
    }),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
  const transactionCount = result.acquisition.facts.filter(
    (fact) => fact.factSchemaVersion === "house-ptr-transaction/v1",
  ).length;
  if (transactionCount > 0) retainedTransactionBearingDocuments += 1;
  else {
    retainedExplicitNonTransactions += 1;
    retainedNonTransactions.push(document.retainedFile);
  }
}
assert.deepEqual(retainedNonTransactions, ["ptr-01.pdf", "ptr-06.pdf", "ptr-15.pdf"]);
assert.equal(retainedTransactionBearingDocuments, 17);
assert.equal(retainedExplicitNonTransactions, 3);
assert.ok(retainedTransactionBearingDocuments / liveReviewManifest.documents.length >= 0.8);

// Malformed containers/documents and resource bounds are terminal and never
// advance the source cursor.
for (const [name, indexBody, documentBody, expectedError, expectedStatus] of [
  ["zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), singlePdf, "archive_invalid", "terminal_failure"],
  ["xml", await zipXml("<FinancialDisclosure>"), singlePdf, "xml_invalid", "terminal_failure"],
  ["invalid-date", await zipXml(indexXml([{
    docId: "20000999",
    filingDate: "2/29/2025",
    first: "Jordan",
    last: "Sample",
    stateDistrict: "OR03",
  }])), singlePdf, "xml_invalid", "terminal_failure"],
  ["pdf", representativeIndex, malformedPdf, "pdf_invalid", "terminal_failure"],
  ["identity", representativeIndex, noTransactionsPdf, "parser_incomplete", "partial"],
  ["archive-bounds", new Uint8Array(PUBLIC_SOURCE_LIMITS.maximumArchiveBytes + 1), singlePdf, "transport_response_oversized", "terminal_failure"],
  ["pdf-bounds", representativeIndex, new Uint8Array(PUBLIC_SOURCE_LIMITS.maximumPdfBytes + 1), "transport_response_oversized", "terminal_failure"],
] as const) {
  const client = new MemoryStore();
  const observedAt = "2026-08-16T06:00:00.000Z";
  const result = await runHousePublicSourceAcquisition({
    client,
    fetchDocument: async (url) => response({ body: documentBody, contentType: "application/pdf", observedAt, url }),
    fetchIndex: async (url) => response({ body: indexBody, contentType: "application/zip", observedAt, url }),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
  assert.equal(result.acquisition.result.status, expectedStatus, name);
  assert.equal(result.acquisition.result.errorCode, expectedError, name);
  assert.equal(result.commit, null, name);
  assert.equal((await readPublicSourceInstance(result.acquisition.result.sourceInstanceId, client))?.cursor.revision, 0, name);
}

// A non-200 HTTP response and the fetch call itself throwing must classify a
// given status identically (one shared houseHttpStatusError) while the logged
// detail still distinguishes the two failure shapes - the ambiguity that made
// the U4 Congressional acceptance's real failure undiagnosable from Production
// logs alone. A determinate transient status (429, 502/503/504) is now a
// bounded retryable_failure so a temporary upstream hiccup does not terminalize
// the occurrence and wait a full cadence; other statuses stay uncertain.
function captureWarnings(): { readonly calls: unknown[][]; restore(): void } {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => { calls.push(args); };
  return { calls, restore: () => { console.warn = original; } };
}

{
  const warnings = captureWarnings();
  const client = new MemoryStore();
  const observedAt = "2026-08-16T07:00:00.000Z";
  let result;
  try {
    result = await runHousePublicSourceAcquisition({
      client,
      fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
      fetchIndex: async (url) => ({
        body: representativeIndex,
        contentType: "application/zip",
        finalUrl: url,
        observedAt,
        requestedUrl: url,
        status: 503,
      }),
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      window: window(observedAt),
    });
  } finally {
    warnings.restore();
  }
  assert.equal(result.acquisition.result.status, "retryable_failure");
  assert.equal(result.acquisition.result.errorCode, "service_unavailable");
  assert.equal(result.acquisition.result.retryAfterSeconds, 60,
    "a retryable_failure must carry a bounded retry hint");
  const logged = warnings.calls.find(([message]) => message === "[house-public-source] acquisition failed");
  assert.ok(logged, "a non-200 index response must log a bounded failure summary");
  assert.equal((logged![1] as { detail: string }).detail, "http_503",
    "a non-200 HTTP status must be distinguishable from a thrown transport exception in the log");
}

{
  const warnings = captureWarnings();
  const client = new MemoryStore();
  const observedAt = "2026-08-16T07:00:00.000Z";
  let result;
  try {
    result = await runHousePublicSourceAcquisition({
      client,
      fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
      fetchIndex: async () => { throw new TypeError("fetch failed"); },
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      window: window(observedAt),
    });
  } finally {
    warnings.restore();
  }
  assert.equal(result.acquisition.result.status, "uncertain");
  assert.equal(result.acquisition.result.errorCode, "acquisition_uncertain");
  const logged = warnings.calls.find(([message]) => message === "[house-public-source] acquisition failed");
  assert.ok(logged, "a thrown transport exception must log a bounded failure summary");
  assert.equal((logged![1] as { detail: string }).detail, "exception_TypeError",
    "a thrown exception must be distinguishable from a non-200 HTTP status in the log");
  assert.equal(JSON.stringify(logged![1]).includes("fetch failed"), false,
    "the raw exception message must never reach the log, only its bounded classification");
}

{
  // undici surfaces the real network reason on error.cause.code; the adapter
  // must carry it into the bounded detail so the log names ETIMEDOUT /
  // ECONNRESET / etc. rather than a bare "TypeError" - the gap that left the
  // live Congressional House-fetch failures undiagnosable (only the raw code,
  // never the message, ever reaches the log).
  const warnings = captureWarnings();
  const observedAt = "2026-08-16T07:00:00.000Z";
  try {
    await runHousePublicSourceAcquisition({
      client: new MemoryStore(),
      fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
      fetchIndex: async () => {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = Object.assign(
          new Error("connect ETIMEDOUT 1.2.3.4:443"),
          { code: "ETIMEDOUT" },
        );
        throw error;
      },
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      window: window(observedAt),
    });
  } finally {
    warnings.restore();
  }
  const logged = warnings.calls.find(([message]) => message === "[house-public-source] acquisition failed");
  assert.ok(logged, "a thrown transport exception with a cause must log a bounded failure summary");
  assert.equal((logged![1] as { detail: string }).detail, "exception_TypeError_ETIMEDOUT",
    "the fetch cause code must reach the bounded detail so the real network reason is diagnosable");
  assert.equal(/ETIMEDOUT 1\.2\.3\.4/u.test(JSON.stringify(logged![1])), false,
    "only the bounded code, never the raw cause message/address, reaches the log");
}

{
  // The actual production shape: fetchOfficialPublicSourceBytes (the real
  // fetchIndex implementation) validates the response status itself and
  // throws PublicSourceHttpStatusError before returning - it never reaches
  // validateResponse's own status check above. Confirmed the real cause of
  // two live "acquisition_uncertain" occurrences an hour apart, both
  // indistinguishable from a network failure until this was traced.
  const warnings = captureWarnings();
  const client = new MemoryStore();
  const observedAt = "2026-08-16T07:00:00.000Z";
  let result;
  try {
    result = await runHousePublicSourceAcquisition({
      client,
      fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
      fetchIndex: async () => { throw new PublicSourceHttpStatusError(503); },
      sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      window: window(observedAt),
    });
  } finally {
    warnings.restore();
  }
  // Identical classification to the response-object path above (one shared
  // houseHttpStatusError), and the determinate status still reaches the log.
  assert.equal(result.acquisition.result.status, "retryable_failure");
  assert.equal(result.acquisition.result.errorCode, "service_unavailable");
  assert.equal(result.acquisition.result.retryAfterSeconds, 60);
  const logged = warnings.calls.find(([message]) => message === "[house-public-source] acquisition failed");
  assert.ok(logged, "a real fetchOfficialPublicSourceBytes-shaped status error must log a bounded failure summary");
  assert.equal((logged![1] as { detail: string }).detail, "http_503",
    "the actual HTTP status must survive fetchOfficialPublicSourceBytes throwing, not just validateResponse's own check");
}

// A determinate rate-limit (429) is retryable and carries its own code, while a
// determinate client error (404) is not transient and stays uncertain - proving
// the classification distinguishes transient from non-transient status codes.
{
  const observedAt = "2026-08-16T07:00:00.000Z";
  const rateLimited = await runHousePublicSourceAcquisition({
    client: new MemoryStore(),
    fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
    fetchIndex: async () => { throw new PublicSourceHttpStatusError(429); },
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
  assert.equal(rateLimited.acquisition.result.status, "retryable_failure");
  assert.equal(rateLimited.acquisition.result.errorCode, "rate_limit_exhausted");
  assert.equal(rateLimited.acquisition.result.retryAfterSeconds, 60);

  const notFound = await runHousePublicSourceAcquisition({
    client: new MemoryStore(),
    fetchDocument: async (url) => response({ body: singlePdf, contentType: "application/pdf", observedAt, url }),
    fetchIndex: async () => { throw new PublicSourceHttpStatusError(404); },
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: window(observedAt),
  });
  assert.equal(notFound.acquisition.result.status, "uncertain");
  assert.equal(notFound.acquisition.result.errorCode, "acquisition_uncertain");
  assert.equal(notFound.acquisition.result.retryAfterSeconds, null);
}

console.log("public-source House acquisition verification passed");
