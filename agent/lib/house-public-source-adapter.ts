import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import {
  commitPublicSourceAcquisition,
  derivePublicSourceAcquisitionEligibilityId,
  ensurePublicSourceInstance,
  readCommittedPublicSourceAcquisitionForWindow,
  readLatestPublicSourceFactRevision,
  readPublicSourceAcquisitionJournal,
  readReusablePublicSourceAcquisition,
  recordPublicSourceAcquisitionOutcome,
  PublicSourceAcquisitionStoreError,
  type PublicSourceAcquisitionCommit,
  type PublicSourceAcquisitionStoreClient,
  type PublicSourcePreparedAcquisition,
} from "./public-source-acquisition-store";
import {
  canonicalPublicFactRevisionSchema,
  deriveCanonicalPublicFactLogicalKey,
  deriveCanonicalPublicFactRevisionId,
  digestPublicSourceValue,
  PUBLIC_SOURCE_LIMITS,
  publicSourceAcquisitionResultSchema,
  publicSourceCorrectionSchema,
  publicSourceInstanceSchema,
  publicSourceRetractionSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceAcquisitionJournal,
  type PublicSourceAcquisitionResult,
  type PublicSourceCorrection,
  type PublicSourceInstance,
  type PublicSourceRetraction,
} from "./public-source-adapter-schema";
import {
  extractHousePtrPdfText,
  HouseFeasibilityError,
  inspectHouseIndexArchive,
  type HousePtrPdfTransactionStructure,
} from "./house-public-source-feasibility";
import { resolveReviewedPublicSource } from "./public-source-registry";
import {
  createHybridPromotionRecord,
} from "./hybrid-evidence-extraction-recovery";
import {
  writeHybridPromotion,
  type HybridEvidenceLineageStoreClient,
} from "./hybrid-evidence-lineage-store";
import type { HybridPromotionRecord } from "./hybrid-evidence-schema";

type HouseErrorCode = NonNullable<PublicSourceAcquisitionResult["errorCode"]>;

export interface HousePublicSourceBinaryResponse {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly requestedUrl: string;
  readonly status: number;
  readonly truncated?: boolean;
}

export interface HousePublicSourceAcquisition extends PublicSourcePreparedAcquisition {
  readonly baselineEstablished: boolean;
  readonly hybridPromotions: readonly HybridPromotionRecord[];
}

export interface SharedHousePublicSourceAcquisitionResult {
  readonly acquisition: HousePublicSourceAcquisition["result"];
  readonly baselineEstablished: boolean;
  readonly commit: PublicSourceAcquisitionCommit | null;
  readonly journal: PublicSourceAcquisitionJournal | null;
  readonly reused: boolean;
}

export interface HouseIndexRow {
  readonly docId: string;
  readonly filer: {
    readonly firstName: string;
    readonly lastName: string;
    readonly prefix: string | null;
    readonly stateDistrict: string;
    readonly suffix: string | null;
  };
  readonly filingDate: string;
  readonly rowDigest: string;
  readonly year: number;
}

export interface HouseTransactionRow {
  readonly amountRange: {
    readonly label: string;
    readonly lower: string | null;
    readonly upper: string | null;
  };
  readonly assetDescription: string;
  readonly capitalGainsIndicator: "no" | "unknown" | "yes";
  readonly notificationDate: string;
  readonly ownerCode: string | null;
  readonly reportedTicker: string | null;
  readonly rowEvidenceDigest: string;
  readonly transactionDate: string;
  readonly transactionType: "E" | "P" | "S";
}

export interface HouseHybridRecoveryResult {
  readonly document: {
    readonly docId: string;
    readonly filerName: string;
    readonly filingDate: string;
    readonly isAmendment: boolean;
    readonly stateDistrict: string;
  };
  readonly resultId: string;
  readonly rows: readonly HouseTransactionRow[];
}

export interface HouseHybridRecovery {
  recover(input: {
    readonly acquisitionId: string;
    readonly artifact: Uint8Array;
    readonly deterministic: {
      readonly errorCode: "deterministic_false_success" | "parser_incomplete" | "pdf_layout_ambiguous" | "pdf_scanned_unsupported";
      readonly state: "partial" | "suspicious" | "unsupported";
    };
    readonly observedAt: string;
    readonly publicUrl: string;
    readonly row: HouseIndexRow;
    readonly source: PublicSourceInstance;
  }): Promise<HouseHybridRecoveryResult | null>;
}

class HouseAdapterError extends Error {
  constructor(
    readonly code: HouseErrorCode,
    readonly stage: "archive" | "normalize" | "pdf" | "transport" | "xml",
    readonly status: "partial" | "terminal_failure" | "uncertain" = "terminal_failure",
  ) {
    super(code);
    this.name = "HouseAdapterError";
  }
}

const sharedAcquisitions = new Map<
  string,
  Promise<Omit<SharedHousePublicSourceAcquisitionResult, "reused">>
>();

async function readCursorConflictWinner(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const committed = await readCommittedPublicSourceAcquisitionForWindow({
      accessClassification: "public",
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      sourceInstanceId: input.source.sourceInstanceId,
      window: input.window,
    }, input.client);
    if (committed) return committed;
  }
  return null;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactDate(
  value: string,
  failure: HouseAdapterError = new HouseAdapterError("xml_invalid", "xml"),
): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (!match) throw failure;
  const normalized = `${match[3]}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw failure;
  }
  return normalized;
}

function boundedText(
  member: Record<string, unknown>,
  key: string,
  maximumLength: number,
  optional = false,
): string | null {
  const value = member[key];
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string") throw new HouseAdapterError("xml_invalid", "xml");
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length === 0 || text.length > maximumLength) {
    throw new HouseAdapterError("xml_bounds_exceeded", "xml");
  }
  return text;
}

function normalizeIndex(xml: string, expectedYear: number): readonly HouseIndexRow[] {
  let document: unknown;
  try {
    document = new XMLParser({
      ignoreDeclaration: true,
      parseTagValue: false,
      trimValues: true,
    }).parse(xml);
  } catch {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  if (typeof document !== "object" || document === null) {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  if (JSON.stringify(Object.keys(document)) !== JSON.stringify(["FinancialDisclosure"])) {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  const root = Reflect.get(document, "FinancialDisclosure");
  if (typeof root !== "object" || root === null) {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  if (JSON.stringify(Object.keys(root)) !== JSON.stringify(["Member"])) {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  const rawMembers = Reflect.get(root, "Member");
  const members = Array.isArray(rawMembers) ? rawMembers : [rawMembers];
  const allowedKeys = new Set([
    "DocID",
    "FilingDate",
    "FilingType",
    "First",
    "Last",
    "Prefix",
    "StateDst",
    "Suffix",
    "Year",
  ]);
  const rows: HouseIndexRow[] = [];
  for (const rawMember of members) {
    if (typeof rawMember !== "object" || rawMember === null) {
      throw new HouseAdapterError("xml_invalid", "xml");
    }
    const member = rawMember as Record<string, unknown>;
    if (Object.keys(member).some((key) => !allowedKeys.has(key))) {
      throw new HouseAdapterError("xml_invalid", "xml");
    }
    const filingType = boundedText(member, "FilingType", 4);
    if (filingType !== "P") continue;
    const yearText = boundedText(member, "Year", 4);
    if (yearText !== String(expectedYear)) {
      throw new HouseAdapterError("xml_invalid", "xml");
    }
    const docId = boundedText(member, "DocID", 20)!;
    const stateDistrict = boundedText(member, "StateDst", 4)!;
    if (!/^\d{5,20}$/u.test(docId) || !/^[A-Z]{2}(?:\d{2}|AL)$/u.test(stateDistrict)) {
      throw new HouseAdapterError("xml_invalid", "xml");
    }
    const rowBase = {
      docId,
      filer: {
        firstName: boundedText(member, "First", 120)!,
        lastName: boundedText(member, "Last", 120)!,
        prefix: boundedText(member, "Prefix", 40, true),
        stateDistrict,
        suffix: boundedText(member, "Suffix", 40, true),
      },
      filingDate: exactDate(boundedText(member, "FilingDate", 10)!),
      year: expectedYear,
    };
    rows.push(Object.freeze({ ...rowBase, rowDigest: digestPublicSourceValue(rowBase) }));
  }
  if (new Set(rows.map((row) => row.docId)).size !== rows.length) {
    throw new HouseAdapterError("xml_invalid", "xml");
  }
  return Object.freeze(rows.sort((left, right) =>
    left.filingDate.localeCompare(right.filingDate) || left.docId.localeCompare(right.docId)));
}

function exactPtrUrl(source: PublicSourceInstance, row: HouseIndexRow): string {
  const url = new URL(`/public_disc/ptr-pdfs/${row.year}/${row.docId}.pdf`, source.authorityOrigin);
  if (url.origin !== source.authorityOrigin) {
    throw new HouseAdapterError("transport_origin_forbidden", "transport");
  }
  return url.toString();
}

function validateResponse(input: {
  readonly expectedUrl: string;
  readonly kind: "archive" | "pdf";
  readonly response: HousePublicSourceBinaryResponse;
}): void {
  if (
    input.response.requestedUrl !== input.expectedUrl ||
    input.response.finalUrl !== input.expectedUrl
  ) {
    throw new HouseAdapterError("transport_redirect_forbidden", "transport");
  }
  if (input.response.truncated) {
    throw new HouseAdapterError("transport_response_oversized", "transport");
  }
  if (input.response.status !== 200) {
    throw new HouseAdapterError("acquisition_uncertain", "transport", "uncertain");
  }
  const contentType = input.response.contentType.split(";", 1)[0]!.trim().toLowerCase();
  const allowed = input.kind === "archive"
    ? new Set(["application/octet-stream", "application/zip", "application/x-zip-compressed"])
    : new Set(["application/octet-stream", "application/pdf"]);
  if (!allowed.has(contentType)) {
    throw new HouseAdapterError(
      input.kind === "archive" ? "archive_invalid" : "pdf_invalid",
      input.kind,
    );
  }
}

function filingLogicalKey(source: PublicSourceInstance, row: HouseIndexRow): string {
  return deriveCanonicalPublicFactLogicalKey({
    adapterId: "house-financial-disclosures",
    factSchemaVersion: "house-ptr-filing/v1",
    sourceInstanceId: source.sourceInstanceId,
    sourceNativeId: `${row.year}:${row.docId}`,
    stableRowIdentity: "filing",
  });
}

function rowMatchesLatestIndex(latest: CanonicalPublicFactRevision, row: HouseIndexRow): boolean {
  if (latest.payload.schemaVersion !== "house-ptr-filing/v1") return false;
  return latest.payload.docId === row.docId &&
    latest.payload.year === row.year &&
    latest.payload.filingDate === row.filingDate &&
    JSON.stringify(latest.payload.filer) === JSON.stringify(row.filer);
}

function transactionRowNumber(fact: CanonicalPublicFactRevision): number {
  if (fact.payload.schemaVersion !== "house-ptr-transaction/v1") return 0;
  return Number(fact.payload.rowIdentity.slice("row:".length));
}

function transactionContentSignature(transaction: HouseTransactionRow | Extract<
  CanonicalPublicFactRevision["payload"],
  { schemaVersion: "house-ptr-transaction/v1" }
>): string {
  return JSON.stringify({
    amountRange: transaction.amountRange,
    assetDescription: transaction.assetDescription,
    capitalGainsIndicator: transaction.capitalGainsIndicator,
    notificationDate: transaction.notificationDate,
    ownerCode: transaction.ownerCode,
    reportedTicker: transaction.reportedTicker,
    transactionDate: transaction.transactionDate,
    transactionType: transaction.transactionType,
  });
}

async function readPriorTransactionFacts(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly filing: CanonicalPublicFactRevision;
  readonly row: HouseIndexRow;
  readonly source: PublicSourceInstance;
}): Promise<readonly CanonicalPublicFactRevision[]> {
  const facts: CanonicalPublicFactRevision[] = [];
  const batchSize = 16;
  for (let start = 1; start <= PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition; start += batchSize) {
    const batch = await Promise.all(Array.from(
      { length: Math.min(batchSize, PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition - start + 1) },
      async (_, offset) => {
        const logicalKey = deriveCanonicalPublicFactLogicalKey({
          adapterId: "house-financial-disclosures",
          factSchemaVersion: "house-ptr-transaction/v1",
          sourceInstanceId: input.source.sourceInstanceId,
          sourceNativeId: `${input.row.year}:${input.row.docId}`,
          stableRowIdentity: `row:${start + offset}`,
        });
        return readLatestPublicSourceFactRevision(logicalKey, input.client);
      },
    ));
    for (const fact of batch) {
      if (
        fact?.payload.schemaVersion === "house-ptr-transaction/v1" &&
        fact.payload.filingLogicalKey === input.filing.logicalKey
      ) facts.push(fact);
    }
  }
  return Object.freeze(facts.sort((left, right) =>
    transactionRowNumber(left) - transactionRowNumber(right)));
}

function assignStableRowIdentities(
  transactions: readonly HouseTransactionRow[],
  priorFacts: readonly CanonicalPublicFactRevision[],
): {
  readonly identities: readonly `row:${number}`[];
  readonly removed: readonly CanonicalPublicFactRevision[];
} {
  const current = transactions.map(transactionContentSignature);
  const prior = priorFacts.map((fact) => {
    if (fact.payload.schemaVersion !== "house-ptr-transaction/v1") {
      throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
    }
    return transactionContentSignature(fact.payload);
  });
  const lengths = Array.from({ length: prior.length + 1 }, () =>
    new Uint16Array(current.length + 1));
  for (let priorIndex = prior.length - 1; priorIndex >= 0; priorIndex -= 1) {
    for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex -= 1) {
      lengths[priorIndex]![currentIndex] = prior[priorIndex] === current[currentIndex]
        ? lengths[priorIndex + 1]![currentIndex + 1]! + 1
        : Math.max(
            lengths[priorIndex + 1]![currentIndex]!,
            lengths[priorIndex]![currentIndex + 1]!,
          );
    }
  }
  const identities: Array<`row:${number}` | undefined> = Array(current.length);
  const matchedPrior = new Set<number>();
  let priorIndex = 0;
  let currentIndex = 0;
  while (priorIndex < prior.length && currentIndex < current.length) {
    if (prior[priorIndex] === current[currentIndex]) {
      identities[currentIndex] = `row:${transactionRowNumber(priorFacts[priorIndex]!)}`;
      matchedPrior.add(priorIndex);
      priorIndex += 1;
      currentIndex += 1;
    } else if (lengths[priorIndex + 1]![currentIndex]! >= lengths[priorIndex]![currentIndex + 1]!) {
      priorIndex += 1;
    } else currentIndex += 1;
  }
  const unmatchedPrior = priorFacts
    .map((fact, index) => ({ fact, index }))
    .filter(({ index }) => !matchedPrior.has(index));
  const unmatchedCurrent = Array.from(identities, (identity, index) => ({ identity, index }))
    .filter(({ identity }) => identity === undefined);
  const replacements = Math.min(unmatchedPrior.length, unmatchedCurrent.length);
  for (let index = 0; index < replacements; index += 1) {
    identities[unmatchedCurrent[index]!.index] =
      `row:${transactionRowNumber(unmatchedPrior[index]!.fact)}`;
    matchedPrior.add(unmatchedPrior[index]!.index);
  }
  let nextRow = Math.max(0, ...priorFacts.map(transactionRowNumber)) + 1;
  for (const unmatched of unmatchedCurrent.slice(replacements)) {
    identities[unmatched.index] = `row:${nextRow}`;
    nextRow += 1;
  }
  return Object.freeze({
    identities: Object.freeze(identities as `row:${number}`[]),
    removed: Object.freeze(priorFacts.filter((_, index) => !matchedPrior.has(index))),
  });
}

export function parseHouseTransactionAmountRange(label: string): HouseTransactionRow["amountRange"] {
  const normalized = label.replace(/\s+/gu, " ").trim();
  const closed = /^\$\s*([\d,]+)\s*-\s*\$\s*([\d,]+)$/u.exec(normalized);
  const over = /^Over\s+\$\s*([\d,]+)$/iu.exec(normalized);
  return Object.freeze({
    label: normalized,
    lower: closed
      ? closed[1]!.replaceAll(",", "")
      : over
        ? (BigInt(over[1]!.replaceAll(",", "")) + 1n).toString()
        : null,
    upper: closed ? closed[2]!.replaceAll(",", "") : null,
  });
}

function parsePositionedTransactions(
  structures: readonly HousePtrPdfTransactionStructure[],
): readonly HouseTransactionRow[] {
  const rows: HouseTransactionRow[] = [];
  for (const structure of structures) {
    const { amountFragments, amountLabel, band, dates, typeFragment } = structure;
    const ownerFragment = band.find((fragment) =>
      fragment.x < typeFragment.x && /^[A-Z]{1,3}$/u.test(fragment.text)
    );
    const assetDescription = band
      .filter((fragment) =>
        fragment.x >= 70 &&
        fragment.x < typeFragment.x - 5 &&
        fragment !== ownerFragment &&
        !/^\d{5,20}$/u.test(fragment.text)
      )
      .map((fragment) => fragment.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (assetDescription.length === 0) continue;

    const capitalGains = band.find((fragment) =>
      fragment.x > amountFragments[0]!.x && /^(?:Yes|No)$/iu.test(fragment.text)
    )?.text.toLowerCase();
    const evidence = band.map((fragment) => [fragment.x, fragment.y, fragment.text]);
    rows.push(Object.freeze({
      amountRange: parseHouseTransactionAmountRange(amountLabel),
      assetDescription,
      capitalGainsIndicator: capitalGains === "yes" || capitalGains === "no"
        ? capitalGains
        : "unknown",
      notificationDate: exactDate(
        dates[1]!.text,
        new HouseAdapterError("parser_incomplete", "normalize", "partial"),
      ),
      ownerCode: ownerFragment?.text ?? null,
      reportedTicker: /\(([A-Z0-9.-]{1,20})\)\s*\[[A-Z]{1,8}\]/u.exec(assetDescription)?.[1] ?? null,
      rowEvidenceDigest: digestPublicSourceValue([typeFragment.page, evidence]),
      transactionDate: exactDate(
        dates[0]!.text,
        new HouseAdapterError("parser_incomplete", "normalize", "partial"),
      ),
      transactionType: typeFragment.text[0]!.toUpperCase() as "E" | "P" | "S",
    }));
  }
  return Object.freeze(rows);
}

function parseTransactions(
  text: string,
  structures: readonly HousePtrPdfTransactionStructure[],
): readonly HouseTransactionRow[] {
  const positioned = parsePositionedTransactions(structures);
  if (positioned.length > 0) return positioned;

  const rowPattern = /(?:^|\s)([A-Z]{1,3})\s+(.+?)\s+([EPS])\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\$\s*[\d,]+\s*-\s*\$\s*[\d,]+|Over\s+\$\s*[\d,]+)\s+(Yes|No)(?=\s+(?:[A-Z]{1,3}\s+|Periodic Transaction Report)|$)/gu;
  const rows: HouseTransactionRow[] = [];
  for (const match of text.matchAll(rowPattern)) {
    const assetDescription = match[2]!.replace(/\s+/gu, " ").trim();
    const ticker = /\(([A-Z0-9.-]{1,20})\)\s*\[[A-Z]{1,8}\]\s*$/u.exec(assetDescription)?.[1] ?? null;
    const evidence = match[0].replace(/\s+/gu, " ").trim();
    rows.push(Object.freeze({
      amountRange: parseHouseTransactionAmountRange(match[6]!),
      assetDescription,
      capitalGainsIndicator: match[7]!.toLowerCase() as "no" | "yes",
      notificationDate: exactDate(
        match[5]!,
        new HouseAdapterError("parser_incomplete", "normalize", "partial"),
      ),
      ownerCode: match[1]!,
      reportedTicker: ticker,
      rowEvidenceDigest: digestPublicSourceValue(evidence),
      transactionDate: exactDate(
        match[4]!,
        new HouseAdapterError("parser_incomplete", "normalize", "partial"),
      ),
      transactionType: match[3]!.toUpperCase() as "E" | "P" | "S",
    }));
  }
  return Object.freeze(rows);
}

function assertDocumentIdentity(text: string, row: HouseIndexRow): void {
  const identity = /Filer:\s+(.+?)\s+State\/District:\s+([A-Z]{2}(?:\d{2}|AL))\s+Filing Date:\s+(\d{2}\/\d{2}\/\d{4})/iu.exec(text);
  const expectedName = [
    row.filer.prefix,
    row.filer.firstName,
    row.filer.lastName,
    row.filer.suffix,
  ].filter((value): value is string => value !== null).join(" ");
  const [year, month, day] = row.filingDate.split("-");
  const filingDate = `${month}/${day}/${year}`;
  const legacyIdentityMatches = identity !== null &&
    identity[1]!.replace(/\s+/gu, " ").trim() === expectedName &&
    identity[2]!.toUpperCase() === row.filer.stateDistrict &&
    exactDate(
      identity[3]!,
      new HouseAdapterError("parser_incomplete", "normalize", "partial"),
    ) === row.filingDate;
  const digitalIdentityMatches = text.includes(`Name: ${expectedName}`) &&
    text.includes(`State/District: ${row.filer.stateDistrict}`) &&
    text.includes(`Filing ID #${row.docId}`) &&
    new RegExp(`${RegExp.escape(expectedName)}\\s*,\\s*${RegExp.escape(filingDate)}`, "u").test(text);
  if (!legacyIdentityMatches && !digitalIdentityMatches) {
    throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
  }
}

function completeCanonicalFact(source: PublicSourceInstance, input: {
  readonly createdObservedAt: string;
  readonly documentDigest: string;
  readonly extraction: {
    readonly errorCode: "pdf_layout_ambiguous" | "pdf_scanned_unsupported" | null;
    readonly state: "complete" | "partial" | "unsupported";
  };
  readonly payload: CanonicalPublicFactRevision["payload"];
  readonly publicUrl: string;
  readonly row: HouseIndexRow;
  readonly rowEvidenceDigest: string | null;
  readonly stableRowIdentity: string;
}): CanonicalPublicFactRevision {
  const payloadDigest = digestPublicSourceValue(input.payload);
  const base = {
    adapterId: "house-financial-disclosures" as const,
    createdObservedAt: input.createdObservedAt,
    extraction: input.extraction,
    factSchemaVersion: input.payload.schemaVersion,
    payload: input.payload,
    payloadDigest,
    provenance: {
      authority: "House Clerk" as const,
      documentDigest: input.documentDigest,
      publicUrl: input.publicUrl,
      rowEvidenceDigest: input.rowEvidenceDigest,
    },
    recordType: "canonical_public_fact_revision" as const,
    schemaVersion: 1 as const,
    sourceInstanceId: source.sourceInstanceId,
    sourceNativeId: `${input.row.year}:${input.row.docId}`,
    sourceTimes: { publishedAt: null, updatedAt: null },
    stableRowIdentity: input.stableRowIdentity,
  };
  const logicalKey = deriveCanonicalPublicFactLogicalKey(base);
  return canonicalPublicFactRevisionSchema.parse({
    ...base,
    logicalKey,
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest: base.payloadDigest }),
  });
}

function correction(
  from: CanonicalPublicFactRevision,
  to: CanonicalPublicFactRevision,
  observedAt: string,
): PublicSourceCorrection {
  const reason = "source_correction" as const;
  return publicSourceCorrectionSchema.parse({
    correctionId: `correction.${digestPublicSourceValue([
      to.logicalKey,
      from.revisionId,
      to.revisionId,
      reason,
    ])}`,
    createdObservedAt: observedAt,
    fromRevisionId: from.revisionId,
    logicalKey: to.logicalKey,
    reason,
    recordType: "public_source_fact_correction",
    schemaVersion: 1,
    toRevisionId: to.revisionId,
  });
}

function retraction(
  from: CanonicalPublicFactRevision,
  observedAt: string,
): PublicSourceRetraction {
  const reason = "source_amendment" as const;
  return publicSourceRetractionSchema.parse({
    createdObservedAt: observedAt,
    fromRevisionId: from.revisionId,
    logicalKey: from.logicalKey,
    reason,
    recordType: "public_source_fact_retraction",
    retractionId: `retraction.${digestPublicSourceValue([
      from.logicalKey,
      from.revisionId,
      reason,
    ])}`,
    schemaVersion: 1,
    sourceInstanceId: from.sourceInstanceId,
  });
}

function acquisitionId(input: {
  readonly contentDigest: string;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): string {
  return `acquisition.${digestPublicSourceValue([
    input.source.sourceInstanceId,
    input.source.adapterDefinitionDigest,
    input.source.cursor.revision,
    input.window.startAt,
    input.window.endAt,
    input.contentDigest,
  ])}`;
}

function failureAcquisition(input: {
  readonly bodyDigest: string;
  readonly error: HouseAdapterError;
  readonly observedAt: string;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): HousePublicSourceAcquisition {
  const id = acquisitionId({ contentDigest: digestPublicSourceValue([input.bodyDigest, input.error.code]), source: input.source, window: input.window });
  return Object.freeze({
    baselineEstablished: false,
    corrections: Object.freeze([]),
    facts: Object.freeze([]),
    hybridPromotions: Object.freeze([]),
    retractions: Object.freeze([]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: id,
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      adapterId: input.source.adapterId,
      adapterVersion: input.source.adapterVersion,
      baselineEstablished: false,
      candidateFactRevisionIds: [],
      correctionIds: [],
      retractionIds: [],
      coverage: "partial",
      errorCode: input.error.code,
      observedAt: input.observedAt,
      proposedNextCursor: null,
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: null,
      schemaVersion: 1,
      sourceInstanceId: input.source.sourceInstanceId,
      stageReceipts: [{
        errorCode: input.error.code,
        inputDigest: input.bodyDigest,
        outputDigest: null,
        stage: input.error.stage,
        status: "failed",
      }],
      status: input.error.status,
    }),
    window: input.window,
  });
}

function mappedError(error: unknown): HouseAdapterError {
  if (error instanceof HouseAdapterError) return error;
  if (error instanceof HouseFeasibilityError) {
    const stage = error.code.startsWith("pdf_")
      ? "pdf"
      : error.code.startsWith("xml_")
        ? "xml"
        : error.code === "transport_response_oversized"
          ? "transport"
          : "archive";
    return new HouseAdapterError(error.code, stage);
  }
  return new HouseAdapterError("acquisition_uncertain", "transport", "uncertain");
}

async function candidateWithLineage(input: {
  readonly candidate: CanonicalPublicFactRevision;
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly observedAt: string;
}): Promise<{ readonly correction: PublicSourceCorrection | null; readonly fact: CanonicalPublicFactRevision | null }> {
  const latest = await readLatestPublicSourceFactRevision(input.candidate.logicalKey, input.client);
  if (latest?.revisionId === input.candidate.revisionId) {
    return Object.freeze({ correction: null, fact: null });
  }
  return Object.freeze({
    correction: latest ? correction(latest, input.candidate, input.observedAt) : null,
    fact: input.candidate,
  });
}

async function acquireHouse(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchDocument: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly indexResponse: HousePublicSourceBinaryResponse;
  readonly recovery?: HouseHybridRecovery;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<HousePublicSourceAcquisition> {
  const source = publicSourceInstanceSchema.parse(input.source);
  const bodyDigest = digestBytes(input.indexResponse.body);
  try {
    if (source.configuration.kind !== "house_financial_disclosures_year") {
      throw new HouseAdapterError("source_instance_invalid", "normalize");
    }
    validateResponse({
      expectedUrl: source.configuration.canonicalUrl,
      kind: "archive",
      response: input.indexResponse,
    });
    const archive = await inspectHouseIndexArchive(
      input.indexResponse.body,
      source.configuration.year,
    );
    const rows = normalizeIndex(archive.xml, source.configuration.year);
    const pendingBatch = /^(?:baseline|incremental):/u.test(source.cursor.watermark ?? "");
    const baselineEstablished = source.cursor.revision === 0 ||
      source.cursor.watermark?.startsWith("baseline:") === true;
    if (!pendingBatch && !baselineEstablished && source.cursor.contentDigest === archive.xmlDigest) {
      return successfulAcquisition({
        archiveDigest: archive.archiveDigest,
        baselineEstablished,
        corrections: [],
        facts: [],
        pdfReceipts: [],
        retractions: [],
        source,
        status: "no_change",
        watermark: source.cursor.watermark ?? `${source.configuration.year}:none`,
        window: input.window,
        xmlDigest: archive.xmlDigest,
        observedAt: input.indexResponse.observedAt,
      });
    }

    const selected: HouseIndexRow[] = [];
    for (const row of rows) {
      const latest = await readLatestPublicSourceFactRevision(filingLogicalKey(source, row), input.client);
      if (!latest || !rowMatchesLatestIndex(latest, row)) selected.push(row);
    }

    const facts: CanonicalPublicFactRevision[] = [];
    const corrections: PublicSourceCorrection[] = [];
    const retractions: PublicSourceRetraction[] = [];
    const hybridPromotionInputs: Array<{
      correctionIds: string[];
      factRevisionIds: string[];
      resultId: string;
      retractionIds: string[];
    }> = [];
    const pdfReceipts: Array<{
      errorCode: "pdf_layout_ambiguous" | "pdf_scanned_unsupported" | null;
      inputDigest: string;
      outputDigest: string;
      status: "complete" | "partial" | "unsupported";
    }> = [];
    const selectedBatch = selected.slice(
      0,
      PUBLIC_SOURCE_LIMITS.maximumHouseDocumentsPerAcquisition,
    );
    for (const row of selectedBatch) {
      const publicUrl = exactPtrUrl(source, row);
      const documentResponse = await input.fetchDocument(publicUrl);
      validateResponse({ expectedUrl: publicUrl, kind: "pdf", response: documentResponse });
      const extraction = await extractHousePtrPdfText(documentResponse.body);
      let extractionState: {
        readonly errorCode: "pdf_layout_ambiguous" | "pdf_scanned_unsupported" | null;
        readonly state: "complete" | "partial" | "unsupported";
      } = {
        errorCode: extraction.errorCode,
        state: extraction.extractionState,
      };
      let transactions: readonly HouseTransactionRow[] = Object.freeze([]);
      let recovered: HouseHybridRecoveryResult | null = null;
      let recoveryOutcome: Parameters<HouseHybridRecovery["recover"]>[0]["deterministic"] | null = null;
      if (extraction.extractionState === "complete") {
        try {
          assertDocumentIdentity(extraction.text, row);
          transactions = parseTransactions(extraction.text, extraction.transactionStructures);
          if (transactions.length !== extraction.transactionRowCount) {
            throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
          }
        } catch (error) {
          if (!(error instanceof HouseAdapterError) || !input.recovery) throw error;
          recoveryOutcome = { errorCode: "deterministic_false_success", state: "suspicious" };
        }
      } else if (input.recovery) {
        recoveryOutcome = {
          errorCode: extraction.errorCode!,
          state: extraction.extractionState,
        };
      }
      if (recoveryOutcome && input.recovery) {
        try {
          recovered = await input.recovery.recover({
            acquisitionId: acquisitionId({
              contentDigest: digestPublicSourceValue([bodyDigest, extraction.documentDigest, row.docId]),
              source,
              window: input.window,
            }),
            artifact: documentResponse.body,
            deterministic: recoveryOutcome,
            observedAt: input.indexResponse.observedAt,
            publicUrl,
            row,
            source,
          });
        } catch {
          throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
        }
        if (!recovered) throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
        const expectedFilerName = [row.filer.prefix, row.filer.firstName, row.filer.lastName, row.filer.suffix]
          .filter((value): value is string => value !== null).join(" ");
        if (
          recovered.document.docId !== row.docId ||
          recovered.document.filerName !== expectedFilerName ||
          recovered.document.filingDate !== row.filingDate ||
          recovered.document.stateDistrict !== row.filer.stateDistrict
        ) throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
        transactions = recovered.rows;
        extractionState = { errorCode: null, state: "complete" };
      }
      const amendedDocId = null;
      const filingPayload = {
        amendedDocId,
        docId: row.docId,
        extraction: extractionState,
        filer: row.filer,
        filingDate: row.filingDate,
        isAmendment: recovered?.document.isAmendment ?? extraction.layout === "amended",
        publicDocumentUrl: publicUrl,
        schemaVersion: "house-ptr-filing/v1" as const,
        year: row.year,
      };
      const filingFact = completeCanonicalFact(source, {
        createdObservedAt: input.indexResponse.observedAt,
        documentDigest: extraction.documentDigest,
        extraction: extractionState,
        payload: filingPayload,
        publicUrl,
        row,
        rowEvidenceDigest: row.rowDigest,
        stableRowIdentity: "filing",
      });
      const filingCandidate = await candidateWithLineage({
        candidate: filingFact,
        client: input.client,
        observedAt: input.indexResponse.observedAt,
      });
      if (filingCandidate.fact) facts.push(filingCandidate.fact);
      if (filingCandidate.correction) corrections.push(filingCandidate.correction);
      const promotionInput = recovered
        ? { correctionIds: [] as string[], factRevisionIds: [] as string[], resultId: recovered.resultId, retractionIds: [] as string[] }
        : null;
      if (promotionInput) promotionInput.factRevisionIds.push(filingFact.revisionId);
      if (promotionInput && filingCandidate.correction) promotionInput.correctionIds.push(filingCandidate.correction.correctionId);

      const priorTransactionFacts = extractionState.state === "complete" &&
          filingCandidate.correction !== null
        ? await readPriorTransactionFacts({
            client: input.client,
            filing: filingFact,
            row,
            source,
          })
        : [];
      const stableRows = assignStableRowIdentities(transactions, priorTransactionFacts);

      for (const [index, transaction] of transactions.entries()) {
        const transactionPayload = {
          amountRange: transaction.amountRange,
          assetDescription: transaction.assetDescription,
          capitalGainsIndicator: transaction.capitalGainsIndicator,
          docId: row.docId,
          extraction: extractionState,
          filingLogicalKey: filingFact.logicalKey,
          notificationDate: transaction.notificationDate,
          ownerCode: transaction.ownerCode,
          publicDocumentUrl: publicUrl,
          reportedTicker: transaction.reportedTicker,
          rowIdentity: stableRows.identities[index]!,
          schemaVersion: "house-ptr-transaction/v1" as const,
          transactionDate: transaction.transactionDate,
          transactionType: transaction.transactionType,
          year: row.year,
        };
        const transactionFact = completeCanonicalFact(source, {
          createdObservedAt: input.indexResponse.observedAt,
          documentDigest: extraction.documentDigest,
          extraction: extractionState,
          payload: transactionPayload,
          publicUrl,
          row,
          rowEvidenceDigest: transaction.rowEvidenceDigest,
          stableRowIdentity: transactionPayload.rowIdentity,
        });
        const candidate = await candidateWithLineage({
          candidate: transactionFact,
          client: input.client,
          observedAt: input.indexResponse.observedAt,
        });
        if (candidate.fact) facts.push(candidate.fact);
        if (candidate.correction) corrections.push(candidate.correction);
        if (promotionInput) promotionInput.factRevisionIds.push(transactionFact.revisionId);
        if (promotionInput && candidate.correction) promotionInput.correctionIds.push(candidate.correction.correctionId);
      }
      if (extractionState.state === "complete") {
        for (const latest of stableRows.removed) {
          if (retractions.length === PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition) {
            throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
          }
          retractions.push(retraction(latest, input.indexResponse.observedAt));
          if (promotionInput) promotionInput.retractionIds.push(retractions.at(-1)!.retractionId);
        }
      }
      if (promotionInput) hybridPromotionInputs.push(promotionInput);
      pdfReceipts.push({
        errorCode: extractionState.errorCode,
        inputDigest: digestBytes(documentResponse.body),
        outputDigest: digestPublicSourceValue([
          filingFact.revisionId,
          ...transactions.map((transaction) => transaction.rowEvidenceDigest),
        ]),
        status: extractionState.state,
      });
      if (facts.length > PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition) {
        throw new HouseAdapterError("parser_incomplete", "normalize", "partial");
      }
    }
    const hasMore = selectedBatch.length < selected.length;
    const lastProcessed = selectedBatch.at(-1);
    return successfulAcquisition({
      archiveDigest: archive.archiveDigest,
      baselineEstablished,
      corrections,
      facts,
      observedAt: input.indexResponse.observedAt,
      pdfReceipts,
      source,
      status: facts.length === 0 && retractions.length === 0 && !hasMore ? "no_change" : "complete",
      watermark: hasMore && lastProcessed
        ? `${baselineEstablished ? "baseline" : "incremental"}:${lastProcessed.filingDate}:${lastProcessed.docId}`
        : rows.at(-1)
          ? `${rows.at(-1)!.filingDate}:${rows.at(-1)!.docId}`
          : `${source.configuration.year}:none`,
      window: input.window,
      xmlDigest: archive.xmlDigest,
      retractions,
      hybridPromotionInputs,
    });
  } catch (error) {
    return failureAcquisition({
      bodyDigest,
      error: mappedError(error),
      observedAt: input.indexResponse.observedAt,
      source,
      window: input.window,
    });
  }
}

function successfulAcquisition(input: {
  readonly archiveDigest: string;
  readonly baselineEstablished: boolean;
  readonly corrections: readonly PublicSourceCorrection[];
  readonly facts: readonly CanonicalPublicFactRevision[];
  readonly observedAt: string;
  readonly pdfReceipts: readonly {
    readonly errorCode: "pdf_layout_ambiguous" | "pdf_scanned_unsupported" | null;
    readonly inputDigest: string;
    readonly outputDigest: string;
    readonly status: "complete" | "partial" | "unsupported";
  }[];
  readonly source: PublicSourceInstance;
  readonly retractions: readonly PublicSourceRetraction[];
  readonly hybridPromotionInputs?: readonly {
    readonly correctionIds: readonly string[];
    readonly factRevisionIds: readonly string[];
    readonly resultId: string;
    readonly retractionIds: readonly string[];
  }[];
  readonly status: "complete" | "no_change";
  readonly watermark: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
  readonly xmlDigest: string;
}): HousePublicSourceAcquisition {
  const retractions = input.retractions;
  const pdfInputDigest = digestPublicSourceValue(input.pdfReceipts.map((receipt) => receipt.inputDigest));
  const contentDigest = digestPublicSourceValue([input.xmlDigest, pdfInputDigest]);
  const id = acquisitionId({ contentDigest, source: input.source, window: input.window });
  const pdfState = input.pdfReceipts.some((receipt) => receipt.status === "partial")
    ? "partial" as const
    : input.pdfReceipts.some((receipt) => receipt.status === "unsupported")
      ? "unsupported" as const
      : "complete" as const;
  const pdfError = input.pdfReceipts.find((receipt) => receipt.errorCode !== null)?.errorCode ?? null;
  return Object.freeze({
    baselineEstablished: input.baselineEstablished,
    corrections: Object.freeze([...input.corrections]),
    facts: Object.freeze([...input.facts]),
    hybridPromotions: Object.freeze((input.hybridPromotionInputs ?? []).map((promotion) =>
      createHybridPromotionRecord({
        canonicalFactRevisionIds: promotion.factRevisionIds,
        correctionIds: promotion.correctionIds,
        now: new Date(input.observedAt),
        resultId: promotion.resultId,
        retractionIds: promotion.retractionIds,
      }))),
    retractions: Object.freeze([...retractions]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: id,
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      adapterId: input.source.adapterId,
      adapterVersion: input.source.adapterVersion,
      baselineEstablished: input.baselineEstablished,
      candidateFactRevisionIds: input.facts.map((fact) => fact.revisionId),
      correctionIds: input.corrections.map((item) => item.correctionId),
      retractionIds: retractions.map((item) => item.retractionId),
      coverage: pdfState,
      errorCode: null,
      observedAt: input.observedAt,
      proposedNextCursor: {
        contentDigest: input.xmlDigest,
        expectedRevision: input.source.cursor.revision,
        watermark: input.watermark,
      },
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: null,
      schemaVersion: 1,
      sourceInstanceId: input.source.sourceInstanceId,
      stageReceipts: [
        { errorCode: null, inputDigest: input.archiveDigest, outputDigest: input.archiveDigest, stage: "transport", status: "complete" },
        { errorCode: null, inputDigest: input.archiveDigest, outputDigest: input.xmlDigest, stage: "archive", status: "complete" },
        { errorCode: null, inputDigest: input.xmlDigest, outputDigest: digestPublicSourceValue(input.facts.map((fact) => fact.logicalKey)), stage: "xml", status: "complete" },
        ...(input.pdfReceipts.length === 0 ? [] : [{
          errorCode: pdfError,
          inputDigest: pdfInputDigest,
          outputDigest: digestPublicSourceValue(input.pdfReceipts.map((receipt) => receipt.outputDigest)),
          stage: "pdf" as const,
          status: pdfState,
        }]),
        { errorCode: null, inputDigest: input.xmlDigest, outputDigest: digestPublicSourceValue(input.facts.map((fact) => fact.revisionId)), stage: "normalize", status: "complete" },
      ],
      status: input.status,
    }),
    window: input.window,
  });
}

export async function runHousePublicSourceAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchDocument: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly fetchIndex: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly hybridLineageClient?: HybridEvidenceLineageStoreClient;
  readonly recovery?: HouseHybridRecovery;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<{
  readonly acquisition: HousePublicSourceAcquisition;
  readonly commit: PublicSourceAcquisitionCommit | null;
}> {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  const source = await ensurePublicSourceInstance(reviewed.sourceInstance, input.client);
  let indexResponse: HousePublicSourceBinaryResponse;
  try {
    indexResponse = await input.fetchIndex(source.configuration.canonicalUrl);
  } catch (error) {
    const observedAt = input.window.endAt;
    const acquisition = failureAcquisition({
      bodyDigest: digestPublicSourceValue("transport_failure"),
      error: mappedError(error),
      observedAt,
      source,
      window: input.window,
    });
    await recordPublicSourceAcquisitionOutcome(acquisition.result, input.client);
    return Object.freeze({ acquisition, commit: null });
  }
  const acquisition = await acquireHouse({
    client: input.client,
    fetchDocument: input.fetchDocument,
    indexResponse,
    recovery: input.recovery,
    source,
    window: input.window,
  });
  if (acquisition.result.status !== "complete" && acquisition.result.status !== "no_change") {
    await recordPublicSourceAcquisitionOutcome(acquisition.result, input.client);
    return Object.freeze({ acquisition, commit: null });
  }
  const commit = await commitPublicSourceAcquisition({ acquisition, client: input.client });
  await Promise.all(acquisition.hybridPromotions.map((promotion) =>
    writeHybridPromotion(promotion, input.hybridLineageClient)));
  return Object.freeze({ acquisition, commit });
}

export async function runSharedHousePublicSourceAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchDocument: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly fetchIndex: (url: string) => Promise<HousePublicSourceBinaryResponse>;
  readonly hybridLineageClient?: HybridEvidenceLineageStoreClient;
  readonly recovery?: HouseHybridRecovery;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<SharedHousePublicSourceAcquisitionResult> {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  const committedForWindow = await readCommittedPublicSourceAcquisitionForWindow({
    accessClassification: "public",
    adapterDefinitionDigest: reviewed.sourceInstance.adapterDefinitionDigest,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    window: input.window,
  }, input.client);
  if (committedForWindow) {
    return Object.freeze({
      acquisition: committedForWindow.result,
      baselineEstablished: committedForWindow.result.baselineEstablished,
      commit: null,
      journal: committedForWindow.journal,
      reused: true,
    });
  }
  const source = await ensurePublicSourceInstance(reviewed.sourceInstance, input.client);
  const eligibility = {
    accessClassification: "public" as const,
    adapterDefinitionDigest: source.adapterDefinitionDigest,
    expectedCursorRevision: source.cursor.revision,
    sourceInstanceId: source.sourceInstanceId,
    window: input.window,
  };
  const reusable = await readReusablePublicSourceAcquisition(eligibility, input.client);
  if (reusable) {
    return Object.freeze({
      acquisition: reusable.result,
      baselineEstablished: reusable.result.baselineEstablished,
      commit: null,
      journal: reusable.journal,
      reused: true,
    });
  }
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  const active = sharedAcquisitions.get(eligibilityId);
  if (active) return Object.freeze({ ...(await active), reused: true });

  const started = (async (): Promise<Omit<SharedHousePublicSourceAcquisitionResult, "reused">> => {
    const raced = await readReusablePublicSourceAcquisition(eligibility, input.client);
    if (raced) {
      return Object.freeze({
        acquisition: raced.result,
        baselineEstablished: raced.result.baselineEstablished,
        commit: null,
        journal: raced.journal,
      });
    }
    let completed: Awaited<ReturnType<typeof runHousePublicSourceAcquisition>>;
    try {
      completed = await runHousePublicSourceAcquisition(input);
    } catch (error) {
      if (
        !(error instanceof PublicSourceAcquisitionStoreError) ||
        (error.code !== "source_cursor_conflict" && error.code !== "journal_conflict")
      ) {
        throw error;
      }
      const winner = await readCursorConflictWinner({
        client: input.client,
        source,
        window: input.window,
      });
      if (!winner) throw error;
      return Object.freeze({
        acquisition: winner.result,
        baselineEstablished: winner.result.baselineEstablished,
        commit: null,
        journal: winner.journal,
      });
    }
    const journal = completed.commit?.journal ?? await readPublicSourceAcquisitionJournal(
      completed.acquisition.result.acquisitionId,
      input.client,
    );
    return Object.freeze({
      acquisition: completed.acquisition.result,
      baselineEstablished: completed.acquisition.baselineEstablished,
      commit: completed.commit,
      journal,
    });
  })();
  sharedAcquisitions.set(eligibilityId, started);
  try {
    return Object.freeze({ ...(await started), reused: false });
  } finally {
    if (sharedAcquisitions.get(eligibilityId) === started) sharedAcquisitions.delete(eligibilityId);
  }
}
