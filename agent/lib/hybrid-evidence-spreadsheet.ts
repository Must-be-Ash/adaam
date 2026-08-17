import { z } from "zod";

import {
  HybridEvidenceDecoderProcessError,
  runHybridEvidenceDecoderProcess,
} from "./hybrid-evidence-decoder-process";
import { HYBRID_EVIDENCE_LIMITS, digestHybridEvidenceValue } from "./hybrid-evidence-schema";
import { HYBRID_EVIDENCE_SPREADSHEET_DECODER_SOURCE } from "./hybrid-evidence-spreadsheet-decoder-source";

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

function columnIndex(reference: string): number {
  const match = /^([A-Z]{1,3})[1-9]\d*$/u.exec(reference);
  if (!match) throw new HybridEvidenceSpreadsheetError("unsupported_layout");
  return [...match[1]!].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

const cellGridSchema = z.object({
  columnCount: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns),
  rowCount: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactRows),
  rows: z.array(z.array(z.string().max(MAX_CELL_CHARACTERS))
    .max(HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns))
    .max(HYBRID_EVIDENCE_LIMITS.maximumArtifactRows),
  sheetId: z.string().min(1).max(80),
}).strict();

const workbookProjectionSchema = z.object({
  columnCount: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  rowCount: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactRows),
  sheetCount: z.number().int().positive().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactSheets),
  sheets: z.array(cellGridSchema).min(1).max(HYBRID_EVIDENCE_LIMITS.maximumArtifactSheets),
}).strict();

export async function projectHybridEvidenceWorkbook(
  bytes: Uint8Array,
): Promise<HybridEvidenceWorkbookProjection> {
  if (
    bytes.byteLength < 4 ||
    bytes.byteLength > HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes ||
    bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04
  ) throw new HybridEvidenceSpreadsheetError("hostile_document");
  try {
    const decoded = workbookProjectionSchema.parse(await runHybridEvidenceDecoderProcess<unknown>({
      payload: {
        bytesBase64: Buffer.from(bytes).toString("base64"),
        maximumCellCharacters: MAX_CELL_CHARACTERS,
        maximumColumns: HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns,
        maximumCompressionRatio: MAX_COMPRESSION_RATIO,
        maximumEntries: MAX_ARCHIVE_ENTRIES,
        maximumExpandedBytes: MAX_EXPANDED_BYTES,
        maximumRows: HYBRID_EVIDENCE_LIMITS.maximumArtifactRows,
        maximumSheets: HYBRID_EVIDENCE_LIMITS.maximumArtifactSheets,
      },
      source: HYBRID_EVIDENCE_SPREADSHEET_DECODER_SOURCE,
      timeoutMs: MAX_RUNTIME_MS,
    }));
    if (decoded.sheetCount !== decoded.sheets.length || decoded.sheets.some((sheet) =>
      sheet.rowCount !== sheet.rows.length ||
      sheet.rows.some((row) => row.length !== sheet.columnCount))) {
      throw new HybridEvidenceSpreadsheetError("hostile_document");
    }
    return Object.freeze({
      ...decoded,
      sheets: Object.freeze(decoded.sheets.map((sheet) => Object.freeze({
        ...sheet,
        rows: Object.freeze(sheet.rows.map((row) => Object.freeze(row))),
      }))),
    });
  } catch (error) {
    if (error instanceof HybridEvidenceSpreadsheetError) throw error;
    throw new HybridEvidenceSpreadsheetError(
      error instanceof HybridEvidenceDecoderProcessError && error.code === "evidence_bounds_exceeded"
        ? "evidence_bounds_exceeded"
        : "hostile_document",
    );
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
