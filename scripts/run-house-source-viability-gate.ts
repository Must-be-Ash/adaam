import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  TextReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { XMLParser } from "fast-xml-parser";

import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import {
  PUBLIC_SOURCE_LIMITS,
} from "../agent/lib/public-source-adapter-schema";
import {
  extractHousePtrPdfText,
  inspectHouseIndexArchive,
} from "../agent/lib/house-public-source-feasibility";
import {
  runHousePublicSourceAcquisition,
  type HousePublicSourceBinaryResponse,
} from "../agent/lib/house-public-source-adapter";
import {
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "../agent/lib/strategy-pack-reference-catalog";
import { fetchOfficialPublicSourceBytes } from "../agent/tools/fetch_public_source";

const AUTHORIZATION_FLAG = "--authorized-live-read";
const OUTPUT_FLAG = "--output";
const REVIEW_YEAR = 2026;
const SAMPLE_SIZE = 20;
const MINIMUM_DISTINCT_MEMBERS = 10;
const AUTHORITY_ORIGIN = "https://disclosures-clerk.house.gov";

interface HouseIndexMember {
  readonly DocID: string;
  readonly FilingDate: string;
  readonly FilingType: string;
  readonly First: string;
  readonly Last: string;
  readonly Prefix?: string;
  readonly StateDst: string;
  readonly Suffix?: string;
  readonly Year: string;
}

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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedDate(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (!match) throw new Error("live_gate_index_date_invalid");
  const normalized = `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error("live_gate_index_date_invalid");
  }
  return normalized;
}

function memberKey(row: HouseIndexMember): string {
  return [row.First, row.Last, row.StateDst].join("\0");
}

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function parsePtrRows(xml: string): readonly HouseIndexMember[] {
  const parsed = new XMLParser({
    ignoreDeclaration: true,
    parseTagValue: false,
    trimValues: true,
  }).parse(xml) as { FinancialDisclosure?: { Member?: unknown | unknown[] } };
  const rawMembers = parsed.FinancialDisclosure?.Member;
  const members = Array.isArray(rawMembers)
    ? rawMembers
    : rawMembers === undefined
      ? []
      : [rawMembers];
  const rows = members.flatMap((value): HouseIndexMember[] => {
    if (typeof value !== "object" || value === null) throw new Error("live_gate_index_invalid");
    const row = value as Record<string, unknown>;
    if (row.FilingType !== "P") return [];
    const normalized: HouseIndexMember = {
      DocID: requiredText(row.DocID, "live_gate_doc_id_invalid"),
      FilingDate: requiredText(row.FilingDate, "live_gate_filing_date_invalid"),
      FilingType: "P",
      First: requiredText(row.First, "live_gate_member_invalid"),
      Last: requiredText(row.Last, "live_gate_member_invalid"),
      Prefix: typeof row.Prefix === "string" && row.Prefix.trim() ? row.Prefix.trim() : undefined,
      StateDst: requiredText(row.StateDst, "live_gate_district_invalid"),
      Suffix: typeof row.Suffix === "string" && row.Suffix.trim() ? row.Suffix.trim() : undefined,
      Year: requiredText(row.Year, "live_gate_year_invalid"),
    };
    if (normalized.Year !== String(REVIEW_YEAR) || !/^\d{5,20}$/u.test(normalized.DocID)) {
      throw new Error("live_gate_index_invalid");
    }
    normalizedDate(normalized.FilingDate);
    return [Object.freeze(normalized)];
  });
  return Object.freeze(rows.sort((left, right) =>
    normalizedDate(right.FilingDate).localeCompare(normalizedDate(left.FilingDate)) ||
    right.DocID.localeCompare(left.DocID)));
}

function escapeXml(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function oneRowIndexXml(row: HouseIndexMember): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<FinancialDisclosure>
  <Member>
    <Prefix>${escapeXml(row.Prefix)}</Prefix>
    <Last>${escapeXml(row.Last)}</Last>
    <First>${escapeXml(row.First)}</First>
    <Suffix>${escapeXml(row.Suffix)}</Suffix>
    <FilingType>P</FilingType>
    <StateDst>${escapeXml(row.StateDst)}</StateDst>
    <Year>${REVIEW_YEAR}</Year>
    <FilingDate>${escapeXml(row.FilingDate)}</FilingDate>
    <DocID>${escapeXml(row.DocID)}</DocID>
  </Member>
</FinancialDisclosure>`;
}

async function oneRowIndexArchive(row: HouseIndexMember): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(`${REVIEW_YEAR}FD.xml`, new TextReader(oneRowIndexXml(row)));
  return writer.close();
}

function response(input: {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly observedAt: string;
  readonly url: string;
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

function outputDirectory(): string {
  if (!process.argv.includes(AUTHORIZATION_FLAG)) {
    throw new Error(`live_gate_owner_authorization_required:${AUTHORIZATION_FLAG}`);
  }
  const outputIndex = process.argv.indexOf(OUTPUT_FLAG);
  const value = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (!value || value.startsWith("-")) throw new Error(`live_gate_output_required:${OUTPUT_FLAG}`);
  return resolve(value);
}

const output = outputDirectory();
await mkdir(output, { recursive: false });

const observedAt = new Date().toISOString();
const fetchedIndex = await fetchOfficialPublicSourceBytes(
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
  PUBLIC_SOURCE_LIMITS.maximumArchiveBytes,
  { origin: AUTHORITY_ORIGIN },
);
const inspectedIndex = await inspectHouseIndexArchive(fetchedIndex.body, REVIEW_YEAR);
const rows = parsePtrRows(inspectedIndex.xml);
const sample = rows.slice(0, SAMPLE_SIZE);
const distinctMemberCount = new Set(sample.map(memberKey)).size;
if (sample.length !== SAMPLE_SIZE || distinctMemberCount < MINIMUM_DISTINCT_MEMBERS) {
  throw new Error("live_gate_sample_diversity_unsatisfied");
}
await writeFile(resolve(output, `${REVIEW_YEAR}FD.zip`), fetchedIndex.body);

const documents = [];
for (const [index, row] of sample.entries()) {
  const publicUrl = new URL(
    `/public_disc/ptr-pdfs/${REVIEW_YEAR}/${row.DocID}.pdf`,
    AUTHORITY_ORIGIN,
  ).toString();
  const fetched = await fetchOfficialPublicSourceBytes(
    publicUrl,
    PUBLIC_SOURCE_LIMITS.maximumPdfBytes,
    { origin: AUTHORITY_ORIGIN },
  );
  const retainedFile = `ptr-${String(index + 1).padStart(2, "0")}.pdf`;
  await writeFile(resolve(output, retainedFile), fetched.body);

  let independentExtractor;
  try {
    const extracted = await extractHousePtrPdfText(fetched.body);
    independentExtractor = {
      errorCode: extracted.errorCode,
      extractionState: extracted.extractionState,
      layout: extracted.layout,
      pageCount: extracted.pageCount,
      transactionRowCount: extracted.transactionRowCount,
    };
  } catch (error) {
    independentExtractor = {
      errorCode: error instanceof Error ? error.message : "pdf_invalid",
      extractionState: "malformed",
      layout: "unknown",
      pageCount: null,
      transactionRowCount: 0,
    };
  }

  const oneRowArchive = await oneRowIndexArchive(row);
  const client = new MemoryStore();
  const production = await runHousePublicSourceAcquisition({
    client,
    fetchDocument: async (url) => response({
      body: fetched.body,
      contentType: fetched.contentType,
      observedAt,
      url,
    }),
    fetchIndex: async (url) => response({
      body: oneRowArchive,
      contentType: "application/zip",
      observedAt,
      url,
    }),
    sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
    window: {
      endAt: observedAt,
      startAt: new Date(Date.parse(observedAt) - 6 * 60 * 60 * 1_000).toISOString(),
    },
  });
  const transactionFacts = production.acquisition.facts.filter(
    (fact) => fact.factSchemaVersion === "house-ptr-transaction/v1",
  );
  const filingFact = production.acquisition.facts.find(
    (fact) => fact.factSchemaVersion === "house-ptr-filing/v1",
  );
  documents.push({
    byteLength: fetched.body.byteLength,
    disclosedFiler: {
      firstName: row.First,
      lastName: row.Last,
      prefix: row.Prefix ?? null,
      stateDistrict: row.StateDst,
      suffix: row.Suffix ?? null,
    },
    docId: row.DocID,
    filingDate: normalizedDate(row.FilingDate),
    independentExtractor,
    independentReviewClassification: "pending",
    productionParser: {
      acquisitionErrorCode: production.acquisition.result.errorCode,
      acquisitionStatus: production.acquisition.result.status,
      filingExtraction: filingFact?.extraction ?? null,
      transactionFactCount: transactionFacts.length,
    },
    publicUrl,
    retainedFile,
    sampleOrder: index + 1,
    sha256: sha256(fetched.body),
  });
}

const manifest = {
  authority: "House Clerk",
  documents,
  index: {
    archiveDigest: inspectedIndex.archiveDigest,
    memberCount: inspectedIndex.memberCount,
    ptrCount: inspectedIndex.ptrCount,
    retainedFile: `${REVIEW_YEAR}FD.zip`,
    sha256: sha256(fetchedIndex.body),
    sourceUrl: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
  },
  observedAt,
  schemaVersion: 1,
  selection: {
    distinctMemberCount,
    minimumDistinctMembers: MINIMUM_DISTINCT_MEMBERS,
    newestFilingDate: normalizedDate(sample[0]!.FilingDate),
    oldestFilingDate: normalizedDate(sample.at(-1)!.FilingDate),
    rule: "literal newest PTR rows by filing date then DocID descending",
    sampleSize: SAMPLE_SIZE,
  },
  sourceInstanceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  year: REVIEW_YEAR,
};
await writeFile(
  resolve(output, "manifest.pending-review.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

const extractionCounts = documents.reduce<Record<string, number>>((counts, document) => {
  const state = document.independentExtractor.extractionState;
  counts[state] = (counts[state] ?? 0) + 1;
  return counts;
}, {});
const productionTransactionDocuments = documents.filter(
  (document) => document.productionParser.transactionFactCount > 0,
).length;
console.log(JSON.stringify({
  distinctMemberCount,
  extractionCounts,
  productionTransactionDocuments,
  reviewedDocuments: documents.length,
}, null, 2));
