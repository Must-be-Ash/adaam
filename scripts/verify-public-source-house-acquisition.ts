import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import {
  readLatestPublicSourceFactRevision,
  readPublicSourceInstance,
  type PublicSourceAcquisitionStoreClient,
} from "../agent/lib/public-source-acquisition-store";
import { PUBLIC_SOURCE_LIMITS } from "../agent/lib/public-source-adapter-schema";
import {
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "../agent/lib/strategy-pack-reference-catalog";
import {
  runHousePublicSourceAcquisition,
  runSharedHousePublicSourceAcquisition,
  type HousePublicSourceBinaryResponse,
} from "../agent/lib/house-public-source-adapter";
import { fetchOfficialPublicSourceBytes } from "../agent/tools/fetch_public_source";

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
const bytes = async (name: string) => new Uint8Array(await readFile(new URL(name, corpusRoot)));
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
const noTransactionsPdf = await bytes("ptr-no-transactions.pdf");
const ambiguousPdf = await bytes("ptr-ambiguous.pdf");
const scannedPdf = await bytes("ptr-scanned.pdf");
const malformedPdf = await bytes("malformed.pdf");
const representativeIndex = await bytes("2026FD.zip");

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

// A representative-scale yearly index is accepted, but each occurrence reads
// only the reviewed document budget and advances a durable baseline batch.
const largeBaselineRows = Array.from({ length: 501 }, (_, index) => ({
  docId: String(21_000_000 + index),
  filingDate: "03/04/2026",
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
  assert.equal(result.acquisition.facts.length, 1);
  assert.deepEqual(result.acquisition.facts[0]?.extraction, { errorCode: expectedError, state: expectedState });
}

// Malformed containers/documents and resource bounds are terminal and never
// advance the source cursor.
for (const [name, indexBody, documentBody, expectedError, expectedStatus] of [
  ["zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), singlePdf, "archive_invalid", "terminal_failure"],
  ["xml", await zipXml("<FinancialDisclosure>"), singlePdf, "xml_invalid", "terminal_failure"],
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

console.log("public-source House acquisition verification passed");
