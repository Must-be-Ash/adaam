import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createHybridEvidenceArtifactStore } from "../agent/lib/hybrid-evidence-artifact-store";
import { bindHouseModelCandidateCitations, createHouseHybridEvidenceRecovery, HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION, independentPdfOcrModelSettings } from "../agent/lib/house-hybrid-evidence-recovery";
import { houseDocumentRowModelCandidateSchema, houseDocumentRowWorkerCandidateSchema, validateHouseDocumentRowCandidate, type HouseDocumentRowWorkerCandidate } from "../agent/lib/hybrid-evidence-extraction-recovery";
import { bindHouseLegacyCandidate, bindHouseLegacyText, houseLegacyIndependentText, createHouseLegacyTranscriptionModelSchema, decodeHouseLegacyTranscriptionModel, createHouseLegacyTranscriptionContent } from "../agent/lib/house-legacy-grid-transcription";
import { readHouseLegacyGrid, validateHouseLegacyGrid, verifyHouseLegacyGridImages, readHouseLegacyIndependentViews, houseLegacyRowKey } from "../agent/lib/house-legacy-grid";
import { projectHybridEvidencePdf, readHybridEvidencePdfPage, projectHybridEvidencePdfRegions } from "../agent/lib/hybrid-evidence-pdf";
import { runHousePublicSourceAcquisition } from "../agent/lib/house-public-source-adapter";
import { readGlobalDispatchBudgetLedger } from "../agent/lib/workspace-dispatch-budget";
import { readWorkspaceBudgetLedger, reserveWorkspaceRunBudget } from "../agent/lib/workspace-budget-ledger";
import { HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID } from "../agent/lib/strategy-pack-reference-catalog";
import { publicSourceSubscriptionSchema } from "../agent/lib/public-source-adapter-schema";
import { derivePublicSourceSubscriptionId, ensurePublicSourceSubscription, projectPublicSourceAcquisition } from "../agent/lib/public-source-subscription-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { writeWorkspaceDocument } from "../agent/lib/workspace-state-store";
import { evaluateCongressionalFiling } from "../agent/lib/congressional-strategy";
import { CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1, CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1, CONGRESSIONAL_POLICY_V1, CONGRESSIONAL_SECURITY_CATALOG_V1 } from "../agent/lib/congressional-reference-catalog";

const root = new URL("./fixtures/public-source-adapters/house/live-review-2026-08-30/", import.meta.url);
assert.deepEqual(independentPdfOcrModelSettings("google/gemini-3-flash"), {
  providerOptions: { google: { thinkingConfig: { thinkingLevel: "minimal" } } },
});
assert.deepEqual(independentPdfOcrModelSettings("google/gemini-3-pro"), { reasoning: "minimal" });
assert.deepEqual(independentPdfOcrModelSettings("fixture/ocr"), { reasoning: "minimal" });
function readFlagValue(name: string): string | null {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`));
  return value ? value.slice(name.length + 1) : null;
}

const captureOutput = readFlagValue("--capture-output");
const replayOutput = readFlagValue("--replay-output");
const liveMaximumUsd = readFlagValue("--live-max-usd");
const live = liveMaximumUsd === "1" || liveMaximumUsd === "2";
const maximumLiveAttempts = live ? Number(liveMaximumUsd) : 1;
if (process.argv.some((arg) => arg.startsWith("--live")) && !live) {
  throw new Error("Explicit --live-max-usd=1 (one attempt) or =2 (up to two durable attempts) is required");
}
if (captureOutput && replayOutput) {
  throw new Error("Choose either --capture-output or --replay-output");
}
if (captureOutput && !live) {
  throw new Error("--capture-output requires the explicit --live-max-usd=1 canary opt-in");
}
if (replayOutput && live) {
  throw new Error("--replay-output is offline-only and cannot be combined with --live-max-usd=1");
}
const golden = JSON.parse(await readFile(new URL("ptr-8221359.golden.json", root), "utf8")) as {
  sha256: string;
  document: { docId: string; filerName: string; filingDate: string; stateDistrict: string; isAmendment: boolean };
  pages: [string, string, "P" | "S", string][][];
};
const pdf = new Uint8Array(await readFile(new URL("ptr-8221359.pdf", root)));
assert.equal(createHash("sha256").update(pdf).digest("hex"), golden.sha256);
assert.deepEqual(golden.pages.map((rows) => rows.length), [25, 26, 26, 26, 20]);
const labels: Record<string, string> = {
  A: "$1,001 - $15,000", B: "$15,001 - $50,000", C: "$50,001 - $100,000",
  D: "$100,001 - $250,000", E: "$250,001 - $500,000", F: "$500,001 - $1,000,000",
  K: "Spouse/DC Asset Over $1,000,000",
};
const rows = golden.pages.flatMap((page, index) => page.map(([assetDescription, day, transactionType, band]) => ({
  assetDescription, transactionType, amountRange: labels[band]!, page: index + 1,
  transactionDate: `2026-02-${day}`, notificationDate: "2026-03-05", ownerCode: "SP",
  reportedTicker: null, capitalGainsIndicator: "unknown" as const,
})));
const projection = await projectHybridEvidencePdf(pdf, { maximumRenderEdge: 2400 });
const gridPages = await Promise.all(projection.pages.map(readHouseLegacyGrid));
for (const [index, grid] of gridPages.entries()) {
  assert.ok(grid, `legacy grid page ${index + 1} must be recognized`);
  assert.deepEqual(grid.rows.filter((row) => row.transactionType !== null).map((row) =>
    [row.transactionType, row.amountLetter]), golden.pages[index]!.map((row) => [row[2], row[3]]),
    `every selected cell on page ${index + 1} must agree with the source-corrected golden`);
  assert.equal(grid.sourceEvidenceDigest, projection.pages[index]!.evidenceDigest);
}
const fourColumnPdf = new Uint8Array(await readFile(new URL("ptr-9115812.pdf", root)));
assert.equal(createHash("sha256").update(fourColumnPdf).digest("hex"),
  "f482dc24b86f6099b22cb2ad15cc400f63eefdaa54354e779832f6a337a962c8");
const fourColumnProjection = await projectHybridEvidencePdf(fourColumnPdf, { maximumRenderEdge: 2400 });
const fourColumnGrids = await Promise.all(fourColumnProjection.pages.map(readHouseLegacyGrid));
assert.deepEqual(fourColumnGrids.map((page) => page?.columns.length), [20, 20]);
assert.deepEqual(fourColumnGrids.map((page) => page?.rows.map((row) =>
  [row.transactionType, row.amountLetter])), [
  [["P", "B"], ["P", "C"], ["P", "B"], ["P", "C"]],
  [["P", "B"], ["P", "B"], ["P", "B"], ["P", "C"], ["P", "C"], ["P", "B"], ["P", "C"], ["P", "B"]],
], "the four-column form must exclude its printed example and trailing notes while preserving every real row");
// Every attached detail image must reproduce from its signed source region.
for (const [index, grid] of gridPages.entries()) for (const view of grid!.regions) {
  const reread = await readHybridEvidencePdfPage({ evidenceDigest: view.evidenceDigest,
    page: index + 1, projection, region: view.region });
  assert.equal(reread.imageBase64, view.imageBase64);
}
await assert.rejects(readHouseLegacyGrid({ ...projection.pages[0]!, evidenceDigest: "0".repeat(64) }),
  /artifact_digest_mismatch/u, "tampered page bytes cannot become grid evidence");
const { createCanvas, loadImage } = await import("@napi-rs/canvas");
async function changedGridPage(edit: (context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>) => void) {
  const original = projection.pages[0]!;
  const canvas = createCanvas(original.width, original.height);
  const context = canvas.getContext("2d");
  context.drawImage(await loadImage(Buffer.from(original.imageBase64, "base64")), 0, 0);
  edit(context);
  const bytes = canvas.toBuffer("image/png");
  return { ...original, byteCount: bytes.byteLength, imageBase64: bytes.toString("base64"),
    evidenceDigest: createHash("sha256").update(bytes).digest("hex") };
}
const grid = gridPages[0]!;
const independentViews = await readHouseLegacyIndependentViews(projection.pages[0]!, grid);
assert.equal(independentViews.length, 27, "two header views and exactly 25 transaction views");
const sourceImage = await loadImage(Buffer.from(projection.pages[0]!.imageBase64, "base64"));
const partialSaleColumnWidth = grid.columns[4]! - grid.columns[3]!;
const partialSaleColumnLeft = grid.columns[4]!;
const assetColumnLeft = grid.columns[1]!;
const transactionColumnsLeft = grid.columns[2]!;
const fourTransactionColumnPage = await changedGridPage((context) => {
  context.fillStyle = "white";
  context.fillRect(0, 0, sourceImage.width, sourceImage.height);
  context.drawImage(sourceImage,
    0, 0, assetColumnLeft, sourceImage.height,
    0, 0, assetColumnLeft, sourceImage.height);
  context.drawImage(sourceImage,
    assetColumnLeft, 0, transactionColumnsLeft - assetColumnLeft, sourceImage.height,
    assetColumnLeft, 0, transactionColumnsLeft - assetColumnLeft - partialSaleColumnWidth, sourceImage.height);
  context.drawImage(sourceImage,
    transactionColumnsLeft, 0, partialSaleColumnLeft - transactionColumnsLeft, sourceImage.height,
    transactionColumnsLeft - partialSaleColumnWidth, 0,
    partialSaleColumnLeft - transactionColumnsLeft, sourceImage.height);
  context.drawImage(sourceImage,
    partialSaleColumnLeft, 0, sourceImage.width - partialSaleColumnLeft, sourceImage.height,
    partialSaleColumnLeft, 0, sourceImage.width - partialSaleColumnLeft, sourceImage.height);
});
const fourTransactionColumnGrid = await readHouseLegacyGrid(fourTransactionColumnPage);
assert.ok(fourTransactionColumnGrid, "legacy grids with a distinct Partial Sale column must be recognized");
assert.equal(fourTransactionColumnGrid.columns.length, 20);
assert.deepEqual(
  fourTransactionColumnGrid.rows.filter((row) => row.transactionType !== null)
    .map((row) => [row.transactionType, row.amountLetter]),
  golden.pages[0]!.map((row) => [row[2], row[3]]),
  "inserting an unselected Partial Sale column must preserve every transaction and amount mark",
);
for (const [index, view] of independentViews.entries()) {
  const source = projection.pages[0]!;
  const x = Math.round(view.region.x * source.width), y = Math.round(view.region.y * source.height);
  const width = Math.round(view.region.width * source.width), height = Math.round(view.region.height * source.height);
  const expected = createCanvas(width, height);
  expected.getContext("2d").drawImage(sourceImage, x, y, width, height, 0, 0, width, height);
  assert.deepEqual(view.image, expected.toBuffer("image/png"), "independent views must contain exact source pixels");
  if (index >= 2) {
    const row = grid.rows[index - 1]!;
    assert.equal(y, row.top - 3);
    assert.equal(height, row.bottom - row.top + 6);
    assert.ok(view.description.includes(houseLegacyRowKey(index)));
  }
}
await assert.rejects(projectHybridEvidencePdfRegions({ page: projection.pages[0]!,
  regions: [{ x: .99, y: 0, width: .1, height: .1 }] }), /evidence_bounds_exceeded/u);
await assert.rejects(projectHybridEvidencePdfRegions({ page: projection.pages[0]!,
  regions: Array.from({ length: 43 }, () => independentViews[0]!.region) }), /evidence_bounds_exceeded/u);

const forgedCrop = { ...grid, regions: grid.regions.map((view, i) => i === 1
  ? { ...view, imageBase64: grid.regions[0]!.imageBase64, evidenceDigest: grid.regions[0]!.evidenceDigest } : view) };
await assert.rejects(verifyHouseLegacyGridImages(forgedCrop, projection.pages[0]!), /artifact_digest_mismatch/u,
  "a self-hashed image from a different source region must never become signed crop evidence");
for (const mutation of [
  (value: typeof grid) => ({ ...value, columns: [...value.columns].reverse() }),
  (value: typeof grid) => ({ ...value, rows: value.rows.map((row, i) => i === 1 ? { ...row, bottom: row.top } : row) }),
  (value: typeof grid) => ({ ...value, rows: value.rows.map((row, i) => i === 1 ? { ...row, amountLetter: null } : row) }),
  (value: typeof grid) => ({ ...value, regions: value.regions.slice(0, -1) }),
  (value: typeof grid) => ({ ...value, regions: value.regions.map((region, i) => i === 1 ? { ...region, firstRow: 1 } : region) }),
]) {
  assert.throws(() => validateHouseLegacyGrid(mutation(grid), projection.pages[0]!), /column_mapping_ambiguous/u,
    "decoder-output relationships must be checked before signing derived evidence");
}
const transaction = grid.rows[1]!;
const ambiguous = await changedGridPage((context) => {
  // Add a second selected amount cell next to the real K selection.
  context.fillStyle = "black";
  const left = grid.columns[7]!, right = grid.columns[8]!;
  context.fillRect(left + (right - left) * .35, transaction.top + (transaction.bottom - transaction.top) * .3,
    (right - left) * .2, (transaction.bottom - transaction.top) * .4);
});
await assert.rejects(readHouseLegacyGrid(ambiguous), /hostile_document|column_mapping_ambiguous/u,
  "two selected cells must fail closed");
const erasedMarks = await changedGridPage((context) => {
  context.fillStyle = "white";
  for (const column of [2, 17]) {
    context.fillRect(grid.columns[column]! + 6, transaction.top + 5,
      grid.columns[column + 1]! - grid.columns[column]! - 12, transaction.bottom - transaction.top - 10);
  }
});
await assert.rejects(readHouseLegacyGrid(erasedMarks), /hostile_document|column_mapping_ambiguous/u,
  "a dated transaction with missing marks cannot become an omitted account heading");
const missingLine = await changedGridPage((context) => {
  context.fillStyle = "white";
  context.fillRect(grid.columns[10]! - 8, 0, 16, projection.pages[0]!.height);
});
assert.equal(await readHouseLegacyGrid(missingLine), null, "a missing grid boundary cannot be interpolated");
const extraLine = await changedGridPage((context) => {
  context.fillStyle = "black";
  context.fillRect((grid.columns[1]! + grid.columns[2]!) / 2, 0, 4, projection.pages[0]!.height);
});
assert.equal(await readHouseLegacyGrid(extraLine), null, "an extra column cannot be silently discarded");
const citations = projection.pages.map((page) => ({
  artifactDigest: golden.sha256, evidenceDigest: page.evidenceDigest,
  kind: "pdf_page" as const, page: page.page, region: null,
}));
const candidate = { citations, disposition: "accepted" as const, fields: { document: golden.document, rows }, unknowns: [] };
const gridMap = new Map(gridPages.map((grid, i) => [i + 1, grid!]));
const signedImages = projection.pages.flatMap((page, i) => [
  { bytes: page.imageBase64, locator: citations[i]! },
  ...gridPages[i]!.regions.map((view) => ({ bytes: view.imageBase64,
    locator: { ...citations[i]!, evidenceDigest: view.evidenceDigest, region: view.region } })),
]);
const legacyMessage = createHouseLegacyTranscriptionContent({ grids: gridMap,
  locators: signedImages.map(({ locator }) => locator),
  message: [{ type: "text", text: "Old full-page order and generic completion instructions" },
    ...signedImages.map(({ bytes }) => ({ type: "file" as const, mediaType: "image/png", data: bytes }))],
});
assert.ok(Array.isArray(legacyMessage));
assert.equal(legacyMessage.some((part) => part.type === "text" && part.text.includes("Old full-page")), false);
assert.deepEqual(legacyMessage.filter((part) => part.type === "file").map((part) => part.data),
  gridPages.flatMap((grid) => grid!.regions.map((view) => view.imageBase64)),
  "the crop-only request must retain the verified file bytes in physical page order");
assert.throws(() => createHouseLegacyTranscriptionContent({ grids: gridMap, locators: citations, message: legacyMessage }),
  /citation_invalid/u, "a file/locator count mismatch cannot be sent to a model");
const textTranscription = { pages: gridPages.map((grid, i) => {
  let cursor = 0;
  return { page: i + 1, layoutConfirmed: true, filerName: "MICHAEL MCCAUL",
    receivedDate: i === 0 ? "2026-03-10" : null,
    rows: grid!.rows.flatMap((cell, rowIndex) => {
      if (cell.transactionType === null) return [];
      const source = rows.filter((row) => row.page === i + 1)[cursor++]!;
      return [{ rowIndex: rowIndex + 1, ownerCode: source.ownerCode, assetDescription: source.assetDescription,
        transactionDate: source.transactionDate, notificationDate: source.notificationDate }];
    }),
  };
}) };
const keyedText = { pages: Object.fromEntries(textTranscription.pages.map(({ page, rows, ...header }) => [
  `page_${page}`, { ...header, rows: Object.fromEntries(rows.map(({ rowIndex, ...text }) => [houseLegacyRowKey(rowIndex), text])) },
])) };
assert.deepEqual(decodeHouseLegacyTranscriptionModel(keyedText, gridMap), textTranscription);
const printedDates = structuredClone(keyedText);
for (const page of Object.values(printedDates.pages)) {
  const us = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8))}/${iso.slice(0, 4)}`;
  if (page.receivedDate) page.receivedDate = us(page.receivedDate);
  for (const row of Object.values(page.rows)) {
    row.transactionDate = us(row.transactionDate); row.notificationDate = us(row.notificationDate);
  }
}
assert.deepEqual(decodeHouseLegacyTranscriptionModel(printedDates, gridMap), textTranscription);
// The Dallas row on the actual last page prints 02-17-2026, unlike adjacent
// slash-delimited dates. Exact transcription must not become schema failure.
const printedHyphenDate = structuredClone(keyedText);
printedHyphenDate.pages.page_5!.rows.row_08!.transactionDate = "02-17-2026";
assert.deepEqual(decodeHouseLegacyTranscriptionModel(printedHyphenDate, gridMap), textTranscription);
assert.equal(createHouseLegacyTranscriptionModelSchema(gridMap, true).safeParse(printedHyphenDate).success, true);

for (const invalid of ["2/30/2026", "13/2/2026", "2/3/26", "2026-02-30", "February 3", "02-30-2026", "02-17/2026", "2026-03-05 soul,ownerCode:"]) {
  const malformed = structuredClone(keyedText); malformed.pages.page_2!.rows.row_01!.transactionDate = invalid;
  assert.throws(() => decodeHouseLegacyTranscriptionModel(malformed, gridMap), undefined, "invalid or incomplete dates must not be guessed");
}
for (const page of Object.values(keyedText.pages)) {
  const keys = Object.keys(page.rows);
  assert.deepEqual([...keys].sort(), keys, "schema field order and physical order must agree even under lexical sorting");
}
const keyedSchema = createHouseLegacyTranscriptionModelSchema(gridMap);
const missingKey = structuredClone(keyedText); delete missingKey.pages.page_2!.rows.row_26;
assert.equal(keyedSchema.safeParse(missingKey).success, false);
const extraKey = structuredClone(keyedText); extraKey.pages.page_1!.rows.row_01 = extraKey.pages.page_1!.rows.row_02!;
assert.equal(keyedSchema.safeParse(extraKey).success, false, "the tool schema cannot request a grouping heading");
const joinedClass = structuredClone(textTranscription);
joinedClass.pages[2]!.rows[3]!.assetDescription = "WORKDAY INC COM CLA";
assert.equal(bindHouseLegacyText(joinedClass, gridMap)[2]!.rows[3]!.assetDescription, "WORKDAY INC COM CL A");
assert.deepEqual(bindHouseLegacyCandidate({ value: textTranscription, grids: gridMap,
  document: golden.document, locators: citations }), candidate,
  "grid-owned fields and independently transcribed text reproduce the complete canonical candidate");
for (const mutate of [
  (value: typeof textTranscription) => value.pages[0]!.rows.pop(),
  (value: typeof textTranscription) => value.pages[0]!.rows.push(value.pages[0]!.rows[0]!),
  (value: typeof textTranscription) => { value.pages[0]!.rows[0]!.rowIndex = 1; },
  (value: typeof textTranscription) => value.pages.reverse(),
]) {
  const bad = structuredClone(textTranscription); mutate(bad);
  assert.throws(() => bindHouseLegacyText(bad, gridMap), /row_identity_ambiguous/u,
    "missing, extra, heading, and reordered physical rows cannot bind");
}
const gridIndependent = new Map(textTranscription.pages.map((page) =>
  [page.page, houseLegacyIndependentText({ pages: [page] }, page.page, gridMap.get(page.page)!)]));
assert.equal(validateHouseDocumentRowCandidate({ artifactDigest: golden.sha256, candidate,
  expected: golden.document, independentTextByPage: gridIndependent, projection }).rows.length, 123);
const wrongIndependent = new Map(gridIndependent);
wrongIndependent.set(1, wrongIndependent.get(1)!.replace("2026-02-11", "2026-02-12"));
assert.throws(() => validateHouseDocumentRowCandidate({ artifactDigest: golden.sha256, candidate,
  expected: golden.document, independentTextByPage: wrongIndependent, projection }), /source_relationship_invalid/u,
  "independently transcribed dates must still agree exactly");
type PublicRecoveryOutput = Readonly<{
  candidate: HouseDocumentRowWorkerCandidate;
  extractionUsage: { inputTokens: number; outputTokens: number; paidCostUsd?: string };
  independentEvidence: Readonly<{
    pageUsage: readonly [number, { inputTokens: number; outputTokens: number; paidCostUsd?: string }][];
    textByPage: readonly [number, string][];
    usage: { inputTokens: number; outputTokens: number; paidCostUsd?: string };
  }>;
  schemaVersion: 1;
}>;

function parsePublicRecoveryOutput(value: unknown): PublicRecoveryOutput {
  if (!value || typeof value !== "object") throw new Error("public_recovery_output_invalid");
  const output = value as Record<string, unknown>;
  if (output.schemaVersion !== 1) throw new Error("public_recovery_output_version_invalid");
  const parseUsage = (usage: unknown) => {
    if (!usage || typeof usage !== "object") throw new Error("public_recovery_output_usage_invalid");
    const candidateUsage = usage as Record<string, unknown>;
    if (!Number.isInteger(candidateUsage.inputTokens) || !Number.isInteger(candidateUsage.outputTokens) ||
      (candidateUsage.paidCostUsd !== undefined &&
        (typeof candidateUsage.paidCostUsd !== "string" || !/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/u.test(candidateUsage.paidCostUsd)))) {
      throw new Error("public_recovery_output_usage_invalid");
    }
    return {
      inputTokens: candidateUsage.inputTokens as number,
      outputTokens: candidateUsage.outputTokens as number,
      ...(candidateUsage.paidCostUsd === undefined ? {} : { paidCostUsd: candidateUsage.paidCostUsd as string }),
    };
  };
  if (!output.independentEvidence || typeof output.independentEvidence !== "object") {
    throw new Error("public_recovery_output_ocr_invalid");
  }
  const independent = output.independentEvidence as Record<string, unknown>;
  if (!Array.isArray(independent.textByPage) || !independent.textByPage.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
      typeof entry[1] === "string" && entry[0] >= 1 && entry[0] <= 8)) {
    throw new Error("public_recovery_output_ocr_invalid");
  }
  if (!Array.isArray(independent.pageUsage) || !independent.pageUsage.every((entry) =>
    Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) &&
      entry[0] >= 1 && entry[0] <= 8)) {
    throw new Error("public_recovery_output_ocr_usage_invalid");
  }
  return {
    candidate: houseDocumentRowWorkerCandidateSchema.parse(output.candidate),
    extractionUsage: parseUsage(output.extractionUsage),
    independentEvidence: {
      pageUsage: independent.pageUsage.map(([page, usage]) => [page, parseUsage(usage)] as const),
      textByPage: independent.textByPage as [number, string][],
      usage: parseUsage(independent.usage),
    },
    schemaVersion: 1,
  };
}
const recordedOutput = replayOutput
  ? parsePublicRecoveryOutput(JSON.parse(await readFile(replayOutput, "utf8")))
  : null;
function replayOcrUsage(output: PublicRecoveryOutput, page: number) {
  // The completed OCR record owns one aggregate receipt; per-page receipts may
  // have been compacted. Charge it once in replay, never substitute fixture fees.
  return page === Math.min(...output.independentEvidence.textByPage.map(([number]) => number))
    ? output.independentEvidence.usage
    : { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" };
}
function capturedPaidMicros(output: PublicRecoveryOutput): bigint {
  const prices = [output.extractionUsage.paidCostUsd, output.independentEvidence.usage.paidCostUsd];
  if (prices.some((price) => price === undefined)) return 1_000_000n;
  return prices.reduce((total, price) => {
    const [whole, fraction = ""] = price!.split(".");
    return total + BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  }, 0n);
}
const modelCandidate = { ...candidate, citations: citations.map(({ page }) => ({ page })) };
assert.equal(houseDocumentRowModelCandidateSchema.safeParse(modelCandidate).success, true);
assert.equal(houseDocumentRowModelCandidateSchema.safeParse({
  ...modelCandidate,
  citations: [{}],
}).success, false, "the direct model must provide a page");
assert.equal(houseDocumentRowModelCandidateSchema.safeParse({
  ...modelCandidate,
  citations: [{ page: 1, evidenceDigest: "a".repeat(64) }],
}).success, false, "the direct model must not echo trusted locator hashes");
assert.deepEqual(bindHouseModelCandidateCitations({ candidate: modelCandidate, locators: citations }), candidate);
assert.throws(() => bindHouseModelCandidateCitations({
  candidate: { ...modelCandidate, citations: [{ page: 8 }] },
  locators: citations,
}), /citation_invalid/u, "an unknown page cannot be rebound into trusted evidence");
const textByPage = new Map(golden.pages.map((_, index) => [index + 1,
  "documentType=Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status;\n" +
  rows.filter((row) => row.page === index + 1).map((row) => [row.ownerCode, row.assetDescription,
    row.transactionType, row.transactionDate, row.notificationDate, row.amountRange].join(" ")).join("\n"),
]));
const replayTextByPage = recordedOutput ? new Map(recordedOutput.independentEvidence.textByPage) : textByPage;
const validate = (value: unknown) => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate: value, expected: golden.document, independentTextByPage: textByPage, projection,
});
const validated = validate(candidate);
assert.equal(validated.rows.length, 123);
assert.throws(() => validate({
  ...candidate,
  citations: candidate.citations.map((citation, index) => index === 0
    ? { ...citation, evidenceDigest: "b".repeat(64) }
    : citation),
}), /citation_invalid/u, "a tampered trusted page locator is rejected deterministically");
function comparableGoldenRows<T extends { assetDescription: string; rowEvidenceDigest: string }>(
  values: readonly T[],
) {
  return values.map(({ assetDescription, rowEvidenceDigest: _digest, ...row }) => ({
    ...row,
    // House's all-caps grid is visual typography. Preserve every non-text
    // field and duplicate/order exactly while accepting cosmetic OCR casing.
    assetDescription: assetDescription.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US"),
  }));
}
const expectedGoldenRows = comparableGoldenRows(validated.rows);
assert.equal(new Set(validated.rows.map((row) => row.rowEvidenceDigest)).size, 123);
assert.deepEqual(validated.rows.filter((row) => row.amountRange.upper === null).map((row) => row.amountRange), [
  { label: labels.K, lower: "1000001", upper: null }, { label: labels.K, lower: "1000001", upper: null },
]);
for (const droppedIndex of [0, 15, 122]) {
  assert.throws(() => validate({ ...candidate, fields: { ...candidate.fields, rows: rows.filter((_, index) => index !== droppedIndex) } }),
    /source_relationship_invalid|row_identity_ambiguous/u, "an individually supported subset must not become complete");
}
assert.throws(() => validate({ ...candidate, fields: { ...candidate.fields, rows: [...rows, rows.at(-1)!] } }),
  /source_relationship_invalid|row_identity_ambiguous/u);
assert.equal(validate({
  ...candidate,
  fields: { ...candidate.fields, rows },
}).rows.length, 123, "the canonical OCR form remains accepted");
assert.deepEqual(validate({
  ...candidate,
  fields: { ...candidate.fields, rows },
}), validated, "validation is deterministic");
const pipeDelimitedEvidence = new Map([...textByPage].map(([page, text]) => [
  page,
  text.replace(/\s+/gu, " | "),
]));
assert.equal(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: pipeDelimitedEvidence,
  projection,
}).rows.length, 123, "pipe-delimited OCR is presentation-equivalent evidence");
const printedAmountEvidence = new Map([...textByPage].map(([page, text]) => [page,
  text.replaceAll(" - $", "-$").replaceAll("Spouse/DC Asset Over", "Spouse/DC Amount over"),
]));
assert.equal(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate, expected: golden.document,
  independentTextByPage: printedAmountEvidence, projection,
}).rows.length, 123, "printed K wording and amount dash spacing preserve the same values");
for (const wrongAmount of ["Over $50,000,000", "Spouse/DC Amount over $5,000,000"]) {
  const incorrect = new Map(printedAmountEvidence);
  incorrect.set(1, incorrect.get(1)!.replace("Spouse/DC Amount over $1,000,000", wrongAmount));
  assert.throws(() => validateHouseDocumentRowCandidate({
    artifactDigest: golden.sha256, candidate, expected: golden.document,
    independentTextByPage: incorrect, projection,
  }), /source_relationship_invalid/u, "K cannot match a different amount or J");
}
const missingPageEvidence = new Map(textByPage);
missingPageEvidence.delete(5);
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: missingPageEvidence,
  projection,
}), /independent_value_mismatch/u);
const blankPageEvidence = new Map(textByPage);
blankPageEvidence.set(5, "   ");
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate,
  expected: golden.document,
  independentTextByPage: blankPageEvidence,
  projection,
}), /independent_value_mismatch/u);
const zeroPageProjection = { ...projection, pages: [projection.pages[0]!] };
const zeroPageCandidate = {
  ...candidate,
  citations: [citations[0]!],
  fields: { ...candidate.fields, rows: [] },
};
const explicitZeroPageEvidence = new Map([[1,
  "Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status; no_transaction_rows=true",
]]);
assert.deepEqual(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate: zeroPageCandidate,
  expected: golden.document,
  independentTextByPage: explicitZeroPageEvidence,
  projection: zeroPageProjection,
}).rows, []);
assert.deepEqual(validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256, candidate: zeroPageCandidate, expected: golden.document,
  independentTextByPage: new Map([[1, explicitZeroPageEvidence.get(1)!.replace("no_transaction_rows=true", "No reportable transactions")]]),
  projection: zeroPageProjection,
}).rows, [], "an explicit no-transactions statement remains valid without an OCR-only marker");
assert.throws(() => validateHouseDocumentRowCandidate({
  artifactDigest: golden.sha256,
  candidate: zeroPageCandidate,
  expected: golden.document,
  independentTextByPage: new Map([[1,
    "Periodic Transaction Report; filerName=MICHAEL MCCAUL; filingDate=3/10/2026; reportStatus=legacy_grid_no_status",
  ]]),
  projection: zeroPageProjection,
}), /independent_value_mismatch|source_relationship_invalid/u,
"an unparseable zero-row page must never be inferred as empty");

class Memory {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async createOrRead(key: string, value: string) {
    const previous = this.values.get(key);
    if (previous !== undefined) return { created: false, value: previous };
    this.values.set(key, value); return { created: true, value };
  }
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next); return true;
  }
}
const memory = new Memory();
const blobs = new Map<string, Uint8Array>();
const artifacts = createHybridEvidenceArtifactStore({ index: memory, blob: {
  async get(key) { return blobs.get(key) ?? null; },
  async put(key, value) { blobs.set(key, new Uint8Array(value)); },
  async delete(key) { blobs.delete(key); },
} });
const environment = {
  ...(live ? process.env : {}),
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: randomBytes(32).toString("base64url"),
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: live ? "anthropic/claude-haiku-4.5,google/gemini-3-flash" : "fixture/extractor,fixture/ocr",
  EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "500000",
  EVE_HYBRID_SOURCE_RECOVERY_OUTPUT_TOKENS_PER_DAY: "100000",
};
let extractionCalls = 0;
// Every signed job in this harness is isolated in memory. Do not require or
// persist a production signing key, including under Vercel's local env runner.
if (live) process.env.EVE_HYBRID_EVIDENCE_AUTH_SECRET = environment.EVE_HYBRID_EVIDENCE_AUTH_SECRET;
let ocrCalls = 0;
const recovery = live ? HOUSE_HYBRID_EVIDENCE_RECOVERY_REGISTRATION.create({
  clients: { artifacts, jobs: memory, lineage: memory, globalBudget: memory },
  environment, initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599",
  modelIds: ["anthropic/claude-haiku-4.5", "google/gemini-3-flash"], reasoning: "provider-default",
}) : createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"], environment,
  initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599", modelId: "fixture/extractor",
  clients: { artifacts, jobs: memory, lineage: memory, globalBudget: memory },
  dependencies: {
    async generateCandidate() {
      extractionCalls += 1;
      return { candidate: recordedOutput?.candidate ?? candidate,
        usage: recordedOutput?.extractionUsage ?? { inputTokens: 16000, outputTokens: 14000, paidCostUsd: "0.086" } };
    },
    ocr: { async recognize({ page }) {
      ocrCalls += 1;
      return { text: replayTextByPage.get(page)!, usage: recordedOutput ? replayOcrUsage(recordedOutput, page) :
        { inputTokens: 1000, outputTokens: 2000, paidCostUsd: "0.0065" } };
    } },
  },
});
const zip = new ZipWriter(new Uint8ArrayWriter());
await zip.add("2026FD.xml", new TextReader(`<FinancialDisclosure><Member><Prefix>Hon.</Prefix><Last>McCaul</Last><First>Michael T.</First><Suffix/><FilingType>P</FilingType><StateDst>TX10</StateDst><Year>2026</Year><FilingDate>3/10/2026</FilingDate><DocID>8221359</DocID></Member></FinancialDisclosure>`));
const archive = await zip.close();
let capturedRecoveryInput: Parameters<typeof recovery.recover>[0] | undefined;
let recoveredGolden: Awaited<ReturnType<typeof recovery.recover>> = null;
function publicRecoveryRecord(store: Memory) {
  const records = [...store.values.values()].flatMap((raw) => {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      return value.recordType === "hybrid_evidence_job_record" ? [value] : [];
    } catch {
      return [];
    }
  });
  assert.equal(records.length, 1, "the isolated canary must produce exactly one recovery record");
  return records[0]!;
}
function capturePublicRecoveryOutput(store: Memory): PublicRecoveryOutput {
  const record = publicRecoveryRecord(store);
  const independent = record.independentEvidence as Record<string, unknown> | null;
  assert.ok(record.candidate, "the canary did not produce a candidate to capture");
  assert.equal(independent?.state, "completed", "the canary did not complete independent OCR");
  return parsePublicRecoveryOutput({
    candidate: record.candidate,
    extractionUsage: record.extractionUsage,
    independentEvidence: {
      pageUsage: independent?.pageUsage,
      textByPage: independent?.textByPage,
      usage: independent?.usage,
    },
    schemaVersion: 1,
  });
}
const acquire = (observedAt: string) => runHousePublicSourceAcquisition({
  client: memory, hybridLineageClient: memory,
  recovery: { async recover(input) {
    capturedRecoveryInput = input;
    for (let attempt = 0; attempt < maximumLiveAttempts; attempt++) {
      recoveredGolden = await recovery.recover(input);
      if (recoveredGolden || !live || attempt + 1 >= maximumLiveAttempts) break;
      const record = publicRecoveryRecord(memory);
      const phase = record.independentEvidence as { state?: string } | null;
      if ((record.job as { state: string }).state !== "completed" || phase?.state !== "uncertain") break;
      const accounting = (await readGlobalDispatchBudgetLedger(memory)).reservations;
      const committedMicros = accounting.reduce((sum, entry) => sum + BigInt(entry.reconciledPaidMicros ?? entry.paidMicros), 0n);
      assert.ok(committedMicros + 1000000n <= BigInt(maximumLiveAttempts) * 1000000n,
        "a fresh $1 admission must fit the explicitly authorized total canary envelope");
      console.info("Resuming the same durable job for missing OCR only; successful extraction/pages remain cached.");
    }
    return recoveredGolden;
  } },
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  fetchDocument: async (url) => ({ body: pdf, contentType: "application/pdf", requestedUrl: url, finalUrl: url, status: 200, observedAt }),
  fetchIndex: async (url) => ({ body: archive, contentType: "application/zip", requestedUrl: url, finalUrl: url, status: 200, observedAt }),
  window: { startAt: "2026-08-30T00:00:00.000Z", endAt: observedAt },
});
const first = await acquire("2026-08-30T12:00:00.000Z");
if (live) console.info("Real-model canary accounting", (await readGlobalDispatchBudgetLedger(memory)).reservations);
if (captureOutput) {
  const record = publicRecoveryRecord(memory);
  const independent = record.independentEvidence as Record<string, unknown> | null;
  const output = record.candidate && independent?.state === "completed"
    ? capturePublicRecoveryOutput(memory)
    : { diagnosticOnly: true, state: "incomplete", candidate: record.candidate,
        extractionUsage: record.extractionUsage, independentEvidence: independent ? {
          state: independent.state, textByPage: independent.textByPage,
          pageUsage: independent.pageUsage, usage: independent.usage,
        } : null };
  await writeFile(captureOutput, `${JSON.stringify({ ...output,
    attemptAccounting: (await readGlobalDispatchBudgetLedger(memory)).reservations.map(({ state, inputTokens, outputTokens,
      reconciledInputTokens, reconciledOutputTokens, paidMicros, reconciledPaidMicros }) => ({ state, inputTokens, outputTokens,
      reconciledInputTokens, reconciledOutputTokens, paidMicros, reconciledPaidMicros })),
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.info(`Captured public House recovery output to ${captureOutput}; no credentials, tokens, or job receipts were written.`);
}
assert.equal(first.acquisition.result.coverage, "complete");
assert.equal(first.acquisition.baselineEstablished, true);
assert.equal(first.acquisition.facts.length, 124, "123 transaction facts plus one filing");
assert.equal(first.acquisition.facts.filter((fact) => fact.payload.schemaVersion === "house-ptr-transaction/v1" && fact.payload.amountRange.upper === null).length, 2);
assert.deepEqual(recoveredGolden?.document, golden.document);
assert.deepEqual(comparableGoldenRows(recoveredGolden?.rows ?? []), expectedGoldenRows,
  "every golden row, including repeated transactions, must survive in order");
const scope = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614175599" },
  { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const sourceInstance = first.commit!.sourceInstance;
const monitorId = "7dd4968b-3cf6-4ac3-a36a-9567b9b71234";
const subscriptionId = derivePublicSourceSubscriptionId({ monitorId, sourceInstanceId: sourceInstance.sourceInstanceId, workspaceId: scope.workspaceId });
const packBinding = { bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "congressional-signals" as const, packVersion: "1.0.0" as const };
await ensurePublicSourceSubscription(scope, publicSourceSubscriptionSchema.parse({
  adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest, adapterVersion: sourceInstance.adapterVersion,
  deliveryCursor: { lastAcquisitionId: null, revision: 0 }, factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  filter: { kind: "all" }, lifecycleState: "active", monitorId, packBinding,
  recordType: "public_source_subscription", schemaVersion: 1, sourceInstanceId: sourceInstance.sourceInstanceId,
  subscriptionId, workspaceId: scope.workspaceId,
}), memory);
const projected = await projectPublicSourceAcquisition({ acquisition: first.acquisition.result,
  projectedAt: new Date("2026-08-30T12:00:00.000Z"), scope, subscriptionId }, { acquisition: memory, subscription: memory });
const evaluation = evaluateCongressionalFiling({ catalogs: {
  committeeAssignments: CONGRESSIONAL_COMMITTEE_ASSIGNMENT_CATALOG_V1,
  committeeJurisdictions: CONGRESSIONAL_COMMITTEE_JURISDICTION_CATALOG_V1,
  member: CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1, security: CONGRESSIONAL_SECURITY_CATALOG_V1,
}, filing: projected.projections.find(({ fact }) => fact.factSchemaVersion === "house-ptr-filing/v1")!,
  transactions: projected.projections.filter(({ fact }) => fact.factSchemaVersion === "house-ptr-transaction/v1"),
  minimumAlertBand: "review", observedAt: "2026-08-30T12:00:00.000Z", packBinding,
  policy: CONGRESSIONAL_POLICY_V1, processingMode: "baseline", selectedMemberBioguideIds: [],
});
assert.equal(evaluation.transactions.length, 123);
assert.equal(evaluation.transactions.filter(({ amountRange }) => amountRange.lower === "1000001" && amountRange.upper === null).length, 2);
assert.equal(evaluation.signal.alertEligible, false, "baseline transactions must never produce historical alerts");
assert.equal(evaluation.finding, null);
const ledger = await readGlobalDispatchBudgetLedger(memory);
assert.equal(ledger.reservations.at(-1)!.state, "settled");
if (!live) assert.equal(ledger.reservations.at(-1)!.reconciledPaidMicros,
  recordedOutput ? capturedPaidMicros(recordedOutput).toString() : "118500");
else assert.ok(BigInt(ledger.reservations.at(-1)!.reconciledPaidMicros!) <= 1000000n);
const second = await acquire("2026-08-30T13:00:00.000Z");
assert.equal(second.acquisition.result.status, "no_change");
if (!live) {
assert.equal(extractionCalls, 1);
assert.equal(ocrCalls, 5);
const replayAccountingFixture = parsePublicRecoveryOutput({
  ...capturePublicRecoveryOutput(memory),
  extractionUsage: { inputTokens: 100, outputTokens: 200, paidCostUsd: "0.0123" },
  independentEvidence: { textByPage: [...textByPage], pageUsage: [],
    usage: { inputTokens: 300, outputTokens: 400, paidCostUsd: "0.0234" } },
});
assert.equal(capturedPaidMicros(replayAccountingFixture), 35700n);
assert.deepEqual([1, 2, 3, 4, 5].map((page) => replayOcrUsage(replayAccountingFixture, page)), [
  { inputTokens: 300, outputTokens: 400, paidCostUsd: "0.0234" },
  ...Array.from({ length: 4 }, () => ({ inputTokens: 0, outputTokens: 0, paidCostUsd: "0" })),
]);
// One failed OCR page must preserve the extraction and every paid sibling page.
for (const malformedResponse of [false, true]) {
const retryMemory = new Memory();
let retryExtractions = 0;
const retryOcrCalls = new Map<number, number>();
const retryRecovery = createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"], environment,
  initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614175599", modelId: "fixture/extractor",
  clients: { artifacts: createHybridEvidenceArtifactStore({ index: retryMemory, blob: {
    async get(key) { return blobs.get(key) ?? null; }, async put(key, value) { blobs.set(key, new Uint8Array(value)); },
    async delete(key) { blobs.delete(key); },
  } }), jobs: retryMemory, lineage: retryMemory, globalBudget: retryMemory },
  dependencies: {
    async generateCandidate() { retryExtractions++; return { candidate, usage: { inputTokens: 16000, outputTokens: 14000, paidCostUsd: "0.086" } }; },
    ocr: { async recognize({ page }) {
      const count = (retryOcrCalls.get(page) ?? 0) + 1; retryOcrCalls.set(page, count);
      if (page === 3 && count === 1 && !malformedResponse) throw new Error("fixture_ocr_transport_failure");
      if (page === 3 && count === 1) return { text: "invalid_grid_transcription.schema", invalidResponse: true,
        usage: { inputTokens: 1000, outputTokens: 2000, paidCostUsd: "0.0065" } };
      return { text: textByPage.get(page)!, usage: { inputTokens: 1000, outputTokens: 2000, paidCostUsd: "0.0065" } };
    } },
  },
});
assert.ok(capturedRecoveryInput);
assert.equal(await retryRecovery.recover(capturedRecoveryInput), null);
const partialPhase = publicRecoveryRecord(retryMemory).independentEvidence as { textByPage: [number, string][]; pageUsage: [number, unknown][] };
assert.equal(partialPhase.textByPage.some(([page]) => page === 3), false, "invalid OCR text cannot enter the reusable cache");
assert.equal(partialPhase.pageUsage.length, malformedResponse ? 5 : 4, "known rejected output must retain its paid receipt");
const retried = await retryRecovery.recover(capturedRecoveryInput);
assert.equal(retried?.rows.length, 123);
assert.equal(retryExtractions, 1);
assert.deepEqual([...retryOcrCalls.entries()].sort(), [[1, 1], [2, 1], [3, 2], [4, 1], [5, 1]]);
const retryLedger = await readGlobalDispatchBudgetLedger(retryMemory);
assert.deepEqual(retryLedger.reservations.map(({ state }) => state), [malformedResponse ? "settled" : "uncertain", "settled"]);
assert.equal(retryLedger.reservations[0]!.reconciledInputTokens ?? retryLedger.reservations[0]!.inputTokens, malformedResponse ? 21000 : 400000);
assert.equal(retryLedger.reservations[0]!.reconciledOutputTokens ?? retryLedger.reservations[0]!.outputTokens, malformedResponse ? 24000 : 40000);
if (malformedResponse) assert.equal(retryLedger.reservations[0]!.reconciledPaidMicros, "118500");
assert.equal(retryLedger.reservations.at(-1)!.reconciledPaidMicros, "6500");
assert.equal(retryLedger.reservations.at(-1)!.inputTokens, 100000, "one missing page must fit the remaining 500k/day envelope after a 400k uncertain attempt");
assert.equal(retryLedger.reservations.at(-1)!.outputTokens, 20000);
}

// A storage acknowledgement can be lost after the OCR completion CAS has
// committed. Replay must settle the exact durable usage in both ledgers without
// issuing extraction or OCR again.
class CasThenThrowMemory extends Memory {
  private throwAfterCompletedOcrWrite = true;
  constructor(private readonly omitExtractionUsage = false) { super(); }

  override async compareAndSet(key: string, expected: string | null, next: string) {
    const committed = await super.compareAndSet(key, expected, next);
    const record = JSON.parse(next) as { independentEvidence?: { state?: string }; recordType?: string };
    if (committed && this.throwAfterCompletedOcrWrite && record.recordType === "hybrid_evidence_job_record" &&
      record.independentEvidence?.state === "completed") {
      this.throwAfterCompletedOcrWrite = false;
      if (this.omitExtractionUsage) this.values.set(key, JSON.stringify({ ...JSON.parse(next), extractionUsage: null }));
      throw new Error("fixture_ocr_completed_cas_then_throw");
    }
    return committed;
  }
}
async function verifyLostOcrAcknowledgement(missingUsage = false) {
const faultMemory = new CasThenThrowMemory(missingUsage);
const faultBlobs = new Map<string, Uint8Array>();
const faultScope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614175599",
}, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const faultEnvironment = {
  ...environment,
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
};
const faultPolicy = {
  effectiveAt: "2026-08-30T00:00:00.000Z",
  maximumConcurrentWorkers: 1,
  maximumInputTokensPerDay: 500_000,
  maximumInputTokensPerRun: 500_000,
  maximumOutputTokensPerDay: 100_000,
  maximumOutputTokensPerRun: 100_000,
  maximumPaidPerCall: "1.000000",
  maximumPaidPerDay: "10.000000",
  maximumPaidPerMonth: "100.000000",
  maximumScheduledRunsPerDay: 8,
  ownerTimezone: "UTC",
  unknownPriceFallbackCeiling: "1.000000",
} as const;
const faultNow = new Date();
await writeWorkspaceDocument("budget", {
  expectedRevision: 0,
  now: faultNow,
  scope: faultScope,
  value: faultPolicy,
}, faultMemory);
await reserveWorkspaceRunBudget({
  inputTokens: 500_000,
  kind: "scheduled_monitor",
  now: faultNow,
  outputTokens: 100_000,
  policy: faultPolicy,
  policyRevision: 1,
  runId: "fault-parent-run",
  scope: faultScope,
}, faultMemory);
assert.deepEqual((await readWorkspaceBudgetLedger(faultScope, faultMemory)).reservations.map((reservation) => ({
  kind: reservation.kind, parentRunId: reservation.parentRunId, policyRevision: reservation.policyRevision,
  runId: reservation.runId, state: reservation.state,
})), [{
  kind: "scheduled_monitor", parentRunId: null, policyRevision: 1,
  runId: "fault-parent-run", state: "reserved",
}]);
let faultExtractions = 0;
let faultOcrCalls = 0;
const faultRecovery = createHouseHybridEvidenceRecovery({
  allowedModelIds: ["fixture/extractor", "fixture/ocr"],
  budgetScope: faultScope,
  clients: {
    artifacts: createHybridEvidenceArtifactStore({ index: faultMemory, blob: {
      async get(key) { return faultBlobs.get(key) ?? null; },
      async put(key, value) { faultBlobs.set(key, new Uint8Array(value)); },
      async delete(key) { faultBlobs.delete(key); },
    } }),
    globalBudget: faultMemory,
    jobs: faultMemory,
    lineage: faultMemory,
    state: faultMemory,
    workspaceBudget: faultMemory,
  },
  dependencies: {
    async generateCandidate() {
      faultExtractions += 1;
      return { candidate, usage: { inputTokens: 16_000, outputTokens: 14_000, paidCostUsd: "0.086" } };
    },
    ocr: { async recognize({ page }) {
      faultOcrCalls += 1;
      return { text: textByPage.get(page)!, usage: { inputTokens: 1_000, outputTokens: 2_000, paidCostUsd: "0.0065" } };
    } },
  },
  environment: faultEnvironment,
  initiatingWorkspaceId: faultScope.workspaceId,
  modelId: "fixture/extractor",
  parentBudgetRunId: "fault-parent-run",
});
assert.ok(capturedRecoveryInput);
assert.equal(await faultRecovery.recover(capturedRecoveryInput), null);
const globalAtFault = await readGlobalDispatchBudgetLedger(faultMemory);
const workspaceAtFault = await readWorkspaceBudgetLedger(faultScope, faultMemory);
if (missingUsage) {
  assert.equal(globalAtFault.reservations.at(-1)!.state, "uncertain", "missing durable usage is not settled actual spend");
  assert.equal(globalAtFault.reservations.at(-1)!.reconciledPaidMicros, null);
  assert.equal(workspaceAtFault.reservations.find(({ parentRunId }) => parentRunId === "fault-parent-run")?.state, "uncertain");
  return;
}
assert.equal(globalAtFault.reservations.at(-1)!.state, "settled");
assert.equal(globalAtFault.reservations.at(-1)!.reconciledInputTokens, 21_000);
assert.equal(globalAtFault.reservations.at(-1)!.reconciledOutputTokens, 24_000);
assert.equal(globalAtFault.reservations.at(-1)!.reconciledPaidMicros, "118500");
const faultWorkspaceReservation = workspaceAtFault.reservations.find(({ parentRunId }) => parentRunId === "fault-parent-run");
assert.equal(faultWorkspaceReservation?.state, "reconciled");
assert.equal(faultWorkspaceReservation?.reconciledInputTokens, 21_000);
assert.equal(faultWorkspaceReservation?.reconciledOutputTokens, 24_000);
assert.equal(faultWorkspaceReservation?.reconciledPaidMicros, "118500");
const faultReplay = await faultRecovery.recover(capturedRecoveryInput);
assert.equal(faultReplay?.rows.length, 123);
assert.equal(faultExtractions, 1);
assert.equal(faultOcrCalls, 5);
assert.deepEqual(await readGlobalDispatchBudgetLedger(faultMemory), globalAtFault);
assert.deepEqual(await readWorkspaceBudgetLedger(faultScope, faultMemory), workspaceAtFault);
}
await verifyLostOcrAcknowledgement();
await verifyLostOcrAcknowledgement(true);
}
console.info(`Exact House 8221359 verification passed: 123 transactions, 2 K rows, complete canonical acquisition, baseline without alerts, settled accounting, unchanged replay (${live ? "real models; isolated test storage" : recordedOutput ? "recorded model evidence; no spend" : "offline fixtures; no spend"}).`);
