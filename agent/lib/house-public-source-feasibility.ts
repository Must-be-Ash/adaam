import { createHash } from "node:crypto";

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type FileEntry,
} from "@zip.js/zip.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import {
  PUBLIC_SOURCE_LIMITS,
  type PublicSourceAcquisitionResult,
} from "./public-source-adapter-schema";

type FeasibilityErrorCode = Extract<
  NonNullable<PublicSourceAcquisitionResult["errorCode"]>,
  | "archive_entry_ambiguous"
  | "archive_entry_forbidden"
  | "archive_entry_limit_exceeded"
  | "archive_expanded_bytes_exceeded"
  | "archive_invalid"
  | "archive_ratio_exceeded"
  | "pdf_execution_timeout"
  | "pdf_invalid"
  | "pdf_layout_ambiguous"
  | "pdf_page_limit_exceeded"
  | "pdf_scanned_unsupported"
  | "pdf_text_limit_exceeded"
  | "transport_response_oversized"
  | "xml_bounds_exceeded"
  | "xml_external_entity_forbidden"
  | "xml_invalid"
>;

export class HouseFeasibilityError extends Error {
  constructor(readonly code: FeasibilityErrorCode) {
    super(code);
    this.name = "HouseFeasibilityError";
  }
}

let pdfJsModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
let pdfJsWorkerModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.worker.mjs")> | undefined;
let canvasPrimitives: { DOMMatrix: typeof DOMMatrix; Path2D: typeof Path2D } | undefined;

async function loadPdfJs() {
  canvasPrimitives ??= process.getBuiltinModule("module")
    .createRequire(import.meta.url)("@napi-rs/canvas") as typeof canvasPrimitives;
  if (!globalThis.DOMMatrix) {
    Object.defineProperty(globalThis, "DOMMatrix", {
      configurable: true,
      value: canvasPrimitives!.DOMMatrix,
      writable: true,
    });
  }
  if (!globalThis.Path2D) {
    Object.defineProperty(globalThis, "Path2D", {
      configurable: true,
      value: canvasPrimitives!.Path2D,
      writable: true,
    });
  }
  await (pdfJsWorkerModule ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  return (pdfJsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeArchivePath(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename.length <= 200 &&
    !filename.startsWith("/") &&
    !filename.includes("\\") &&
    !filename.split("/").some((part) => part === ".." || part === "")
  );
}

function assertBoundedHouseXmlShape(xml: string): void {
  const tags = xml.match(/<[^>]+>/gu) ?? [];
  if (tags.length > PUBLIC_SOURCE_LIMITS.maximumHouseIndexRows * 12 + 10) {
    throw new HouseFeasibilityError("xml_bounds_exceeded");
  }
  let depth = 0;
  for (const tag of tags) {
    if (/^<\?/u.test(tag)) continue;
    if (/^<\//u.test(tag)) depth -= 1;
    else if (!/\/>$/u.test(tag)) depth += 1;
    if (depth < 0 || depth > 3) {
      throw new HouseFeasibilityError("xml_bounds_exceeded");
    }
  }
  if (depth !== 0) throw new HouseFeasibilityError("xml_invalid");
}

export interface HouseIndexArchiveInspection {
  readonly archiveDigest: string;
  readonly entryCount: number;
  readonly expandedBytes: number;
  readonly memberCount: number;
  readonly ptrCount: number;
  readonly xml: string;
  readonly xmlDigest: string;
  readonly xmlFilename: string;
}

export async function inspectHouseIndexArchive(
  bytes: Uint8Array,
  expectedYear: number,
): Promise<HouseIndexArchiveInspection> {
  if (bytes.byteLength > PUBLIC_SOURCE_LIMITS.maximumArchiveBytes) {
    throw new HouseFeasibilityError("transport_response_oversized");
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new HouseFeasibilityError("archive_invalid");
  }

  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    if (entries.length > PUBLIC_SOURCE_LIMITS.maximumArchiveEntries) {
      throw new HouseFeasibilityError("archive_entry_limit_exceeded");
    }
    if (entries.some((entry) => !safeArchivePath(entry.filename))) {
      throw new HouseFeasibilityError("archive_entry_forbidden");
    }

    let expandedBytes = 0;
    for (const entry of entries) {
      expandedBytes += entry.uncompressedSize;
      if (expandedBytes > PUBLIC_SOURCE_LIMITS.maximumArchiveExpandedBytes) {
        throw new HouseFeasibilityError("archive_expanded_bytes_exceeded");
      }
      if (
        entry.uncompressedSize > 0 &&
        (entry.compressedSize === 0 ||
          entry.uncompressedSize / entry.compressedSize > PUBLIC_SOURCE_LIMITS.maximumArchiveRatio)
      ) {
        throw new HouseFeasibilityError("archive_ratio_exceeded");
      }
    }

    const expectedName = `${expectedYear}FD.xml`;
    const candidates = entries.filter(
      (entry): entry is FileEntry => !entry.directory && entry.filename === expectedName,
    );
    if (candidates.length !== 1) {
      throw new HouseFeasibilityError("archive_entry_ambiguous");
    }
    const xmlBytes = await candidates[0]!.getData(new Uint8ArrayWriter());
    if (xmlBytes.byteLength > PUBLIC_SOURCE_LIMITS.maximumXmlBytes) {
      throw new HouseFeasibilityError("xml_bounds_exceeded");
    }
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
    } catch {
      throw new HouseFeasibilityError("xml_invalid");
    }
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
      throw new HouseFeasibilityError("xml_external_entity_forbidden");
    }
    assertBoundedHouseXmlShape(xml);
    if (XMLValidator.validate(xml) !== true) {
      throw new HouseFeasibilityError("xml_invalid");
    }
    const parsed = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      trimValues: true,
    }).parse(xml) as {
      FinancialDisclosure?: { Member?: unknown | unknown[] };
    };
    const rawMembers = parsed.FinancialDisclosure?.Member;
    const members = Array.isArray(rawMembers)
      ? rawMembers
      : rawMembers === undefined
        ? []
        : [rawMembers];
    if (members.length === 0 || members.length > PUBLIC_SOURCE_LIMITS.maximumHouseIndexRows) {
      throw new HouseFeasibilityError("xml_bounds_exceeded");
    }
    const ptrCount = members.filter((member) =>
      member !== null &&
      typeof member === "object" &&
      (member as { FilingType?: unknown }).FilingType === "P"
    ).length;
    return Object.freeze({
      archiveDigest: digestBytes(bytes),
      entryCount: entries.length,
      expandedBytes,
      memberCount: members.length,
      ptrCount,
      xml,
      xmlDigest: digestBytes(xmlBytes),
      xmlFilename: expectedName,
    });
  } catch (error) {
    if (error instanceof HouseFeasibilityError) throw error;
    throw new HouseFeasibilityError("archive_invalid");
  } finally {
    await reader.close().catch(() => undefined);
  }
}

export interface HousePtrPdfInspection {
  readonly documentDigest: string;
  readonly extractionState: "complete" | "partial" | "unsupported";
  readonly errorCode: "pdf_layout_ambiguous" | "pdf_scanned_unsupported" | null;
  readonly layout: "amended" | "multi_row" | "no_transactions" | "single_row" | "unknown";
  readonly pageCount: number;
  readonly transactionRowCount: number;
}

export interface HousePtrPdfTextExtraction extends HousePtrPdfInspection {
  /** Ephemeral positioned text used only by the deterministic House parser. */
  readonly fragments: readonly HousePtrPdfTextFragment[];
  /** Ephemeral validated row structures shared by feasibility and parsing. */
  readonly transactionStructures: readonly HousePtrPdfTransactionStructure[];
  /** Ephemeral normalized text used only by the deterministic House parser. */
  readonly text: string;
}

export interface HousePtrPdfTextFragment {
  readonly page: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

export interface HousePtrPdfTransactionStructure {
  readonly amountFragments: readonly HousePtrPdfTextFragment[];
  readonly amountLabel: string;
  readonly band: readonly HousePtrPdfTextFragment[];
  readonly dates: readonly [HousePtrPdfTextFragment, HousePtrPdfTextFragment];
  readonly typeFragment: HousePtrPdfTextFragment;
}

export function identifyHousePtrTransactionStructures(
  fragments: readonly HousePtrPdfTextFragment[],
): readonly HousePtrPdfTransactionStructure[] {
  const structures: HousePtrPdfTransactionStructure[] = [];
  for (const typeFragment of fragments) {
    if (!/^[EPS](?:\s*\(partial\))?$/iu.test(typeFragment.text)) continue;
    const band = fragments.filter((fragment) =>
      fragment.page === typeFragment.page &&
      fragment.y <= typeFragment.y + 8 &&
      fragment.y >= typeFragment.y - 18
    ).sort((left, right) => right.y - left.y || left.x - right.x);
    const dates = band
      .filter((fragment) =>
        fragment.x > typeFragment.x && /^\d{2}\/\d{2}\/\d{4}$/u.test(fragment.text)
      )
      .sort((left, right) => left.x - right.x);
    if (dates.length !== 2) continue;
    const amountFragments = band
      .filter((fragment) => fragment.x > dates[1]!.x && /\$|^Over\b/iu.test(fragment.text));
    const amountLabel = amountFragments
      .map((fragment) => fragment.text)
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();
    if (!/^(?:\$\s*[\d,]+\s*-\s*\$\s*[\d,]+|Over\s+\$\s*[\d,]+)$/iu.test(amountLabel)) {
      continue;
    }
    structures.push(Object.freeze({
      amountFragments: Object.freeze(amountFragments),
      amountLabel,
      band: Object.freeze(band),
      dates: Object.freeze([dates[0]!, dates[1]!]) as readonly [
        HousePtrPdfTextFragment,
        HousePtrPdfTextFragment,
      ],
      typeFragment,
    }));
  }
  return Object.freeze(structures);
}

async function withinPdfExecutionLimit<T>(startedAt: number, work: Promise<T>): Promise<T> {
  const remaining = PUBLIC_SOURCE_LIMITS.maximumPdfExecutionMilliseconds - (Date.now() - startedAt);
  if (remaining <= 0) throw new HouseFeasibilityError("pdf_execution_timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HouseFeasibilityError("pdf_execution_timeout")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function extractHousePtrPdfText(
  bytes: Uint8Array,
): Promise<HousePtrPdfTextExtraction> {
  if (bytes.byteLength > PUBLIC_SOURCE_LIMITS.maximumPdfBytes) {
    throw new HouseFeasibilityError("transport_response_oversized");
  }
  if (
    bytes.byteLength < 5 ||
    String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-"
  ) {
    throw new HouseFeasibilityError("pdf_invalid");
  }

  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
  });
  const startedAt = Date.now();
  try {
    const document = await withinPdfExecutionLimit(startedAt, loadingTask.promise);
    if (document.numPages > PUBLIC_SOURCE_LIMITS.maximumPdfPages) {
      throw new HouseFeasibilityError("pdf_page_limit_exceeded");
    }
    const fragments: HousePtrPdfTextFragment[] = [];
    let textCharacterCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await withinPdfExecutionLimit(startedAt, document.getPage(pageNumber));
      const content = await withinPdfExecutionLimit(startedAt, page.getTextContent());
      for (const item of content.items) {
        if ("str" in item) {
          const fragment = item.str.replaceAll("\0", "").trim();
          if (fragment.length > 0) {
            fragments.push(Object.freeze({
              page: pageNumber,
              text: fragment,
              x: item.transform[4],
              y: item.transform[5],
            }));
            textCharacterCount += fragment.length + 1;
            if (textCharacterCount > PUBLIC_SOURCE_LIMITS.maximumPdfTextCharacters) {
              throw new HouseFeasibilityError("pdf_text_limit_exceeded");
            }
          }
        }
      }
    }

    const text = fragments.map((fragment) => fragment.text).join(" ").replace(/\s+/gu, " ").trim();
    if (text.length === 0) {
      return Object.freeze({
        documentDigest: digestBytes(bytes),
        errorCode: "pdf_scanned_unsupported",
        extractionState: "unsupported",
        fragments: Object.freeze(fragments),
        layout: "unknown",
        pageCount: document.numPages,
        text,
        transactionRowCount: 0,
        transactionStructures: Object.freeze([]),
      });
    }

    const hasOfficialHeader = /Periodic Transaction Report/iu.test(text);
    const hasTableHeader =
      /Owner/iu.test(text) &&
      /Asset/iu.test(text) &&
      /Transaction/iu.test(text) &&
      /Amount/iu.test(text);
    const noTransactions = /no reportable transactions|no transactions to report/iu.test(text);
    const transactionStructures = identifyHousePtrTransactionStructures(fragments);
    if (Date.now() - startedAt > PUBLIC_SOURCE_LIMITS.maximumPdfExecutionMilliseconds) {
      throw new HouseFeasibilityError("pdf_execution_timeout");
    }
    const transactionRowCount = transactionStructures.length;
    if (
      !hasOfficialHeader ||
      (!hasTableHeader && !noTransactions) ||
      (!noTransactions && transactionRowCount === 0)
    ) {
      return Object.freeze({
        documentDigest: digestBytes(bytes),
        errorCode: "pdf_layout_ambiguous",
        extractionState: "partial",
        fragments: Object.freeze(fragments),
        layout: "unknown",
        pageCount: document.numPages,
        text,
        transactionRowCount,
        transactionStructures,
      });
    }

    const layout = noTransactions
      ? "no_transactions"
      : /Amendment/iu.test(text)
        ? "amended"
        : transactionRowCount > 1 || document.numPages > 1
          ? "multi_row"
          : "single_row";
    return Object.freeze({
      documentDigest: digestBytes(bytes),
      errorCode: null,
      extractionState: "complete",
      fragments: Object.freeze(fragments),
      layout,
      pageCount: document.numPages,
      text,
      transactionRowCount,
      transactionStructures,
    });
  } catch (error) {
    if (error instanceof HouseFeasibilityError) throw error;
    throw new HouseFeasibilityError("pdf_invalid");
  } finally {
    await loadingTask.destroy();
  }
}

export async function inspectHousePtrPdf(
  bytes: Uint8Array,
): Promise<HousePtrPdfInspection> {
  const {
    fragments: _fragments,
    text: _text,
    transactionStructures: _transactionStructures,
    ...inspection
  } = await extractHousePtrPdfText(bytes);
  return Object.freeze(inspection);
}
