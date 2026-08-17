/** Plain JavaScript evaluated in a capability-restricted decoder process. */
export const HYBRID_EVIDENCE_SPREADSHEET_DECODER_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { XMLParser, XMLValidator } from "fast-xml-parser";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const fail = (code) => { throw new Error(code); };
const safePath = (path) => path.length > 0 && path.length <= 240 && !path.startsWith("/") &&
  !path.includes("\\") && !path.split("/").some((part) => part === "" || part === "..");
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const object = (value) => value && typeof value === "object" && !Array.isArray(value)
  ? value
  : fail("unsupported_layout");
const text = (value) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const candidate = Reflect.get(value, "#text");
    return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
  }
  return "";
};
const columnIndex = (reference) => {
  const match = /^([A-Z]{1,3})[1-9]\d*$/u.exec(reference);
  if (!match) fail("unsupported_layout");
  return [...match[1]].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
};
const rowIndex = (reference) => {
  const match = /^[A-Z]{1,3}([1-9]\d*)$/u.exec(reference);
  if (!match) fail("unsupported_layout");
  return Number(match[1]);
};
const parseXml = (bytes) => {
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("hostile_document"); }
  if (
    /<!DOCTYPE|<!ENTITY/iu.test(source) ||
    /<(?:[A-Za-z_][\w.-]*:)?f(?:\s|>)/iu.test(source) ||
    /TargetMode\s*=\s*["']External["']/iu.test(source) ||
    XMLValidator.validate(source) !== true
  ) fail("hostile_document");
  try {
    return object(new XMLParser({
      attributeNamePrefix: "@_",
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: false,
    }).parse(source));
  } catch { fail("unsupported_layout"); }
};
const entryBytes = async (entry) => {
  if (!entry || entry.directory || !("getData" in entry)) fail("unsupported_layout");
  return entry.getData(new Uint8ArrayWriter());
};
const sharedStringValue = (value) => {
  const item = object(value);
  const direct = text(item.t);
  return direct || array(item.r).map((run) => text(object(run).t)).join("");
};
const normalizeCell = (value) => {
  const normalized = value.replaceAll("\0", "").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length > input.maximumCellCharacters) fail("evidence_bounds_exceeded");
  return normalized;
};
const parseSheet = (sheetId, document, sharedStrings) => {
  const worksheet = object(document.worksheet);
  if (worksheet.hyperlinks !== undefined || worksheet.oleObjects !== undefined) fail("hostile_document");
  const rows = array(object(worksheet.sheetData).row);
  const grid = [];
  let columnCount = 0;
  for (const rawRow of rows) {
    const cells = array(object(rawRow).c);
    for (const rawCell of cells) {
      const cell = object(rawCell);
      if (cell.f !== undefined) fail("hostile_document");
      const reference = String(cell["@_r"] ?? "");
      const rowNumber = rowIndex(reference);
      const columnNumber = columnIndex(reference);
      if (rowNumber > input.maximumRows || columnNumber > input.maximumColumns) fail("evidence_bounds_exceeded");
      const kind = String(cell["@_t"] ?? "n");
      const rawValue = kind === "inlineStr" ? text(object(cell.is).t) : text(cell.v);
      const value = kind === "s" ? sharedStrings[Number(rawValue)] : rawValue;
      if (value === undefined || !["n", "s", "str", "inlineStr", "b"].includes(kind)) fail("unsupported_layout");
      grid[rowNumber - 1] ??= [];
      grid[rowNumber - 1][columnNumber - 1] = normalizeCell(value);
      columnCount = Math.max(columnCount, columnNumber);
    }
  }
  return {
    columnCount,
    rowCount: grid.length,
    rows: Array.from({ length: grid.length }, (_, row) =>
      Array.from({ length: columnCount }, (_, column) => grid[row]?.[column] ?? "")),
    sheetId,
  };
};
const bytes = Buffer.from(input.bytesBase64, "base64");
const reader = new ZipReader(new Uint8ArrayReader(bytes));
try {
  const entries = await reader.getEntries();
  if (entries.length > input.maximumEntries || entries.some((entry) => !safePath(entry.filename))) fail("hostile_document");
  let expandedBytes = 0;
  for (const entry of entries) {
    expandedBytes += entry.uncompressedSize;
    if (
      expandedBytes > input.maximumExpandedBytes ||
      (entry.uncompressedSize > 0 && (entry.compressedSize === 0 ||
        entry.uncompressedSize / entry.compressedSize > input.maximumCompressionRatio)) ||
      /(?:^|\/)(?:vbaProject\.bin|embeddings|activeX|printerSettings)(?:\/|$)/iu.test(entry.filename) ||
      /\.(?:bin|exe|dll|js|vbs)$/iu.test(entry.filename)
    ) fail("hostile_document");
  }
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  for (const relationship of entries.filter((entry) => !entry.directory && entry.filename.endsWith(".rels"))) {
    parseXml(await entryBytes(relationship));
  }
  const workbook = parseXml(await entryBytes(byName.get("xl/workbook.xml")));
  const relationships = parseXml(await entryBytes(byName.get("xl/_rels/workbook.xml.rels")));
  const relationRows = array(object(relationships.Relationships).Relationship);
  const relationMap = new Map();
  for (const relationValue of relationRows) {
    const relation = object(relationValue);
    if (String(relation["@_TargetMode"] ?? "") === "External") fail("hostile_document");
    const id = String(relation["@_Id"] ?? "");
    const target = String(relation["@_Target"] ?? "");
    if (!id || !target || target.startsWith("/") || target.includes("..") || target.includes(":")) fail("hostile_document");
    relationMap.set(id, target.startsWith("xl/") ? target : "xl/" + target);
  }
  const sheetRows = array(object(object(workbook.workbook).sheets).sheet);
  if (sheetRows.length < 1 || sheetRows.length > input.maximumSheets) fail("evidence_bounds_exceeded");
  const sharedStringsDocument = byName.has("xl/sharedStrings.xml")
    ? parseXml(await entryBytes(byName.get("xl/sharedStrings.xml")))
    : null;
  const sharedStrings = sharedStringsDocument
    ? array(object(sharedStringsDocument.sst).si).map(sharedStringValue)
    : [];
  const sheets = [];
  for (const sheetValue of sheetRows) {
    const sheet = object(sheetValue);
    const sheetId = normalizeCell(String(sheet["@_name"] ?? ""));
    const relationId = String(sheet["@_r:id"] ?? "");
    if (!sheetId || sheetId.length > 80 || sheets.some((candidate) => candidate.sheetId === sheetId)) {
      fail("column_mapping_ambiguous");
    }
    sheets.push(parseSheet(
      sheetId,
      parseXml(await entryBytes(byName.get(relationMap.get(relationId) ?? ""))),
      sharedStrings,
    ));
  }
  process.stdout.write(JSON.stringify({
    columnCount: Math.max(0, ...sheets.map((sheet) => sheet.columnCount)),
    digest: createHash("sha256").update(bytes).digest("hex"),
    rowCount: Math.max(0, ...sheets.map((sheet) => sheet.rowCount)),
    sheetCount: sheets.length,
    sheets,
  }));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "hostile_document");
  process.exitCode = 1;
} finally {
  await reader.close().catch(() => undefined);
}
`;
