import { createHash } from "node:crypto";

import {
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  type Entry,
} from "@zip.js/zip.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { HYBRID_EVIDENCE_LIMITS, digestHybridEvidenceValue } from "./hybrid-evidence-schema";

const MAX_ARCHIVE_ENTRIES = 128;
const MAX_EXPANDED_BYTES = 20 * 1_024 * 1_024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_RUNTIME_MS = 10_000;
const MAX_CELL_CHARACTERS = 4_000;

export class HybridEvidenceSpreadsheetError extends Error {
  constructor(readonly code:
    | "citation_invalid"
    | "column_mapping_ambiguous"
    | "evidence_bounds_exceeded"
    | "hostile_document"
    | "independent_value_mismatch"
    | "required_field_unknown"
    | "unsupported_layout") {
    super(code);
    this.name = "HybridEvidenceSpreadsheetError";
  }
}

export interface HybridEvidenceCellGrid {
  readonly columnCount: number;
  readonly rowCount: number;
  readonly rows: readonly (readonly string[])[];
  readonly sheetId: string;
}

export interface HybridEvidenceWorkbookProjection {
  readonly columnCount: number;
  readonly digest: string;
  readonly rowCount: number;
  readonly sheetCount: number;
  readonly sheets: readonly HybridEvidenceCellGrid[];
}

type XmlObject = Record<string, unknown>;

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && !path.startsWith("/") &&
    !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "..");
}

function array<T>(value: T | readonly T[] | undefined): readonly T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value as T];
}

function object(value: unknown): XmlObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  }
  return value as XmlObject;
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = Reflect.get(value, "#text");
    return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
  }
  return "";
}

function columnIndex(reference: string): number {
  const match = /^([A-Z]{1,3})[1-9]\d*$/u.exec(reference);
  if (!match) throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  return [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function rowIndex(reference: string): number {
  const match = /^[A-Z]{1,3}([1-9]\d*)$/u.exec(reference);
  if (!match) throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  return Number(match[1]);
}

function parseXml(bytes: Uint8Array): XmlObject {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HybridEvidenceSpreadsheetError("hostile_document");
  }
  if (
    /<!DOCTYPE|<!ENTITY/iu.test(source) ||
    /<(?:[A-Za-z_][\w.-]*:)?f(?:\s|>)/iu.test(source) ||
    /TargetMode\s*=\s*["']External["']/iu.test(source) ||
    XMLValidator.validate(source) !== true
  ) throw new HybridEvidenceSpreadsheetError("hostile_document");
  try {
    return object(new XMLParser({
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: false,
    }).parse(source));
  } catch (error) {
    if (error instanceof HybridEvidenceSpreadsheetError) throw error;
    throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  }
}

async function entryBytes(entry: Entry | undefined): Promise<Uint8Array> {
  if (!entry || entry.directory || !("getData" in entry)) {
    throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  }
  return entry.getData(new Uint8ArrayWriter());
}

function sharedStringValue(value: unknown): string {
  const item = object(value);
  const direct = text(item.t);
  if (direct) return direct;
  return array(item.r as XmlObject | readonly XmlObject[] | undefined)
    .map((run) => text(object(run).t))
    .join("");
}

function normalizeCell(value: string): string {
  const normalized = value.replaceAll("\0", "").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > MAX_CELL_CHARACTERS) {
    throw new HybridEvidenceSpreadsheetError("evidence_bounds_exceeded");
  }
  return normalized;
}

function parseSheet(
  sheetId: string,
  document: XmlObject,
  sharedStrings: readonly string[],
): HybridEvidenceCellGrid {
  const worksheet = object(document.worksheet);
  if (worksheet.hyperlinks !== undefined || worksheet.oleObjects !== undefined) {
    throw new HybridEvidenceSpreadsheetError("hostile_document");
  }
  const sheetData = object(worksheet.sheetData);
  const rows = array(sheetData.row as XmlObject | readonly XmlObject[] | undefined);
  const grid: string[][] = [];
  let columnCount = 0;
  for (const rawRow of rows) {
    const row = object(rawRow);
    const cells = array(row.c as XmlObject | readonly XmlObject[] | undefined);
    for (const rawCell of cells) {
      const cell = object(rawCell);
      if (cell.f !== undefined) throw new HybridEvidenceSpreadsheetError("hostile_document");
      const reference = String(cell["@_r"] ?? "");
      const rowNumber = rowIndex(reference);
      const columnNumber = columnIndex(reference);
      if (
        rowNumber > HYBRID_EVIDENCE_LIMITS.maximumArtifactRows ||
        columnNumber > HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns
      ) throw new HybridEvidenceSpreadsheetError("evidence_bounds_exceeded");
      const kind = String(cell["@_t"] ?? "n");
      const rawValue = kind === "inlineStr"
        ? text(object(cell.is).t)
        : text(cell.v);
      const value = kind === "s"
        ? sharedStrings[Number(rawValue)]
        : rawValue;
      if (value === undefined || !["n", "s", "str", "inlineStr", "b"].includes(kind)) {
        throw new HybridEvidenceSpreadsheetError("unsupported_layout");
      }
      grid[rowNumber - 1] ??= [];
      grid[rowNumber - 1]![columnNumber - 1] = normalizeCell(value);
      columnCount = Math.max(columnCount, columnNumber);
    }
  }
  const rowCount = grid.length;
  const normalizedRows = Array.from({ length: rowCount }, (_, row) =>
    Object.freeze(Array.from({ length: columnCount }, (_, column) => grid[row]?.[column] ?? "")));
  return Object.freeze({
    columnCount,
    rowCount,
    rows: Object.freeze(normalizedRows),
    sheetId,
  });
}

export async function projectHybridEvidenceWorkbook(
  bytes: Uint8Array,
): Promise<HybridEvidenceWorkbookProjection> {
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes ||
    bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04
  ) throw new HybridEvidenceSpreadsheetError("hostile_document");
  const startedAt = Date.now();
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    if (entries.length > MAX_ARCHIVE_ENTRIES || entries.some((entry) => !safePath(entry.filename))) {
      throw new HybridEvidenceSpreadsheetError("hostile_document");
    }
    let expandedBytes = 0;
    for (const entry of entries) {
      expandedBytes += entry.uncompressedSize;
      if (
        expandedBytes > MAX_EXPANDED_BYTES ||
        (entry.uncompressedSize > 0 && (
          entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO
        )) ||
        /(?:^|\/)(?:vbaProject\.bin|embeddings|activeX|printerSettings)(?:\/|$)/iu.test(entry.filename) ||
        /\.(?:bin|exe|dll|js|vbs)$/iu.test(entry.filename)
      ) throw new HybridEvidenceSpreadsheetError("hostile_document");
    }
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));
    for (const relationship of entries.filter((entry) =>
      !entry.directory && entry.filename.endsWith(".rels"))) {
      parseXml(await entryBytes(relationship));
    }
    const workbook = parseXml(await entryBytes(byName.get("xl/workbook.xml")));
    const relationships = parseXml(await entryBytes(byName.get("xl/_rels/workbook.xml.rels")));
    const relationRows = array(object(relationships.Relationships).Relationship as XmlObject | readonly XmlObject[] | undefined);
    const relationMap = new Map<string, string>();
    for (const relationValue of relationRows) {
      const relation = object(relationValue);
      if (String(relation["@_TargetMode"] ?? "") === "External") {
        throw new HybridEvidenceSpreadsheetError("hostile_document");
      }
      const id = String(relation["@_Id"] ?? "");
      const target = String(relation["@_Target"] ?? "");
      if (!id || !target || target.startsWith("/") || target.includes("..") || target.includes(":")) {
        throw new HybridEvidenceSpreadsheetError("hostile_document");
      }
      relationMap.set(id, target.startsWith("xl/") ? target : `xl/${target}`);
    }
    const workbookRoot = object(workbook.workbook);
    const sheetRows = array(object(workbookRoot.sheets).sheet as XmlObject | readonly XmlObject[] | undefined);
    if (sheetRows.length < 1 || sheetRows.length > HYBRID_EVIDENCE_LIMITS.maximumArtifactSheets) {
      throw new HybridEvidenceSpreadsheetError("evidence_bounds_exceeded");
    }
    const sharedStringsDocument = byName.has("xl/sharedStrings.xml")
      ? parseXml(await entryBytes(byName.get("xl/sharedStrings.xml")))
      : null;
    const sharedStrings = sharedStringsDocument
      ? array(object(sharedStringsDocument.sst).si as XmlObject | readonly XmlObject[] | undefined)
          .map(sharedStringValue)
      : [];
    const sheets: HybridEvidenceCellGrid[] = [];
    for (const sheetValue of sheetRows) {
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        throw new HybridEvidenceSpreadsheetError("evidence_bounds_exceeded");
      }
      const sheet = object(sheetValue);
      const sheetId = normalizeCell(String(sheet["@_name"] ?? ""));
      const relationId = String(sheet["@_r:id"] ?? "");
      if (!sheetId || sheetId.length > 80 || sheets.some((candidate) => candidate.sheetId === sheetId)) {
        throw new HybridEvidenceSpreadsheetError("column_mapping_ambiguous");
      }
      sheets.push(parseSheet(
        sheetId,
        parseXml(await entryBytes(byName.get(relationMap.get(relationId) ?? ""))),
        sharedStrings,
      ));
    }
    return Object.freeze({
      columnCount: Math.max(0, ...sheets.map((sheet) => sheet.columnCount)),
      digest: createHash("sha256").update(bytes).digest("hex"),
      rowCount: Math.max(0, ...sheets.map((sheet) => sheet.rowCount)),
      sheetCount: sheets.length,
      sheets: Object.freeze(sheets),
    });
  } catch (error) {
    if (error instanceof HybridEvidenceSpreadsheetError) throw error;
    throw new HybridEvidenceSpreadsheetError("hostile_document");
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function parseRange(range: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/u.exec(range);
  if (!match) throw new HybridEvidenceSpreadsheetError("citation_invalid");
  const startColumn = columnIndex(`${match[1]}1`);
  const endColumn = columnIndex(`${match[3]}1`);
  const startRow = Number(match[2]);
  const endRow = Number(match[4]);
  if (startColumn > endColumn || startRow > endRow) {
    throw new HybridEvidenceSpreadsheetError("citation_invalid");
  }
  return { endColumn, endRow, startColumn, startRow };
}

export function readHybridEvidenceCellRange(input: {
  readonly projection: HybridEvidenceWorkbookProjection;
  readonly range: string;
  readonly sheetId: string;
}): { readonly digest: string; readonly rows: readonly (readonly string[])[] } {
  const sheet = input.projection.sheets.find((candidate) => candidate.sheetId === input.sheetId);
  const bounds = parseRange(input.range);
  if (!sheet || bounds.endRow > sheet.rowCount || bounds.endColumn > sheet.columnCount) {
    throw new HybridEvidenceSpreadsheetError("citation_invalid");
  }
  const rows = sheet.rows.slice(bounds.startRow - 1, bounds.endRow).map((row) =>
    Object.freeze(row.slice(bounds.startColumn - 1, bounds.endColumn)));
  return Object.freeze({ digest: digestHybridEvidenceValue(rows), rows: Object.freeze(rows) });
}

export interface SpreadsheetRoleCandidate {
  readonly amountColumn: string;
  readonly assetColumn: string;
  readonly dateColumn: string;
  readonly range: string;
  readonly sheetId: string;
}

export function validateSpreadsheetRoleCandidate(input: {
  readonly candidate: SpreadsheetRoleCandidate;
  readonly projection: HybridEvidenceWorkbookProjection;
}): Readonly<SpreadsheetRoleCandidate> {
  const cited = readHybridEvidenceCellRange({
    projection: input.projection,
    range: input.candidate.range,
    sheetId: input.candidate.sheetId,
  });
  if (cited.rows.length < 2) throw new HybridEvidenceSpreadsheetError("required_field_unknown");
  const columns = [input.candidate.amountColumn, input.candidate.assetColumn, input.candidate.dateColumn];
  if (new Set(columns).size !== columns.length || columns.some((value) => !/^[A-Z]{1,3}$/u.test(value))) {
    throw new HybridEvidenceSpreadsheetError("column_mapping_ambiguous");
  }
  const index = (letters: string) => columnIndex(`${letters}1`) - 1;
  const headers = cited.rows[0]!;
  const values = cited.rows[1]!;
  const normalizedHeaders = headers.map((header) => header.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim());
  if (normalizedHeaders.some((header, position) =>
    header.length > 0 && normalizedHeaders.indexOf(header) !== position)) {
    throw new HybridEvidenceSpreadsheetError("column_mapping_ambiguous");
  }
  const amountIndex = index(input.candidate.amountColumn);
  const assetIndex = index(input.candidate.assetColumn);
  const dateIndex = index(input.candidate.dateColumn);
  if (
    !headers[amountIndex] || !headers[assetIndex] || !headers[dateIndex] ||
    !values[amountIndex] || !values[assetIndex] || !values[dateIndex]
  ) throw new HybridEvidenceSpreadsheetError("required_field_unknown");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(values[dateIndex]!)) {
    throw new HybridEvidenceSpreadsheetError("independent_value_mismatch");
  }
  if (!/(?:\$|\d)/u.test(values[amountIndex]!)) {
    throw new HybridEvidenceSpreadsheetError("independent_value_mismatch");
  }
  const otherAmountColumns = normalizedHeaders
    .map((header, position) => ({ header, position }))
    .filter(({ header, position }) => position !== amountIndex && /(?:amount|value\s*band)/u.test(header));
  if (otherAmountColumns.some(({ position }) =>
    values[position] && values[position] !== values[amountIndex])) {
    throw new HybridEvidenceSpreadsheetError("independent_value_mismatch");
  }
  return Object.freeze({ ...input.candidate });
}
