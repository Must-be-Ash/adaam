import { createHash } from "node:crypto";
import { z } from "zod";
import { runHybridEvidenceDecoderProcess } from "./hybrid-evidence-decoder-process";
import { HOUSE_LEGACY_GRID_DECODER_SOURCE } from "./house-legacy-grid-decoder-source";
import { projectHybridEvidencePdfRegions, type HybridEvidencePdfPage } from "./hybrid-evidence-pdf";

export const houseLegacyRowKey = (index: number) => `row_${String(index).padStart(2, "0")}`;

export interface HouseLegacyGrid {
  readonly sourceEvidenceDigest: string;
  readonly regions: readonly {
    readonly firstRow: number;
    readonly lastRow: number;
    readonly imageBase64: string;
    readonly evidenceDigest: string;
    readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  }[];
  readonly columns: readonly number[];
  readonly rows: readonly {
    readonly top: number;
    readonly bottom: number;
    readonly transactionType: "P" | "S" | "E" | null;
    readonly amountLetter: string | null;
  }[];
}

const gridSchema = z.object({
  sourceEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  regions: z.array(z.object({
    firstRow: z.number().int().nonnegative().max(40), lastRow: z.number().int().nonnegative().max(40),
    imageBase64: z.string().max(3_333_344), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
      width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict(),
  }).strict()).min(1).max(7),
  columns: z.array(z.number().int().nonnegative().max(2400)).min(19).max(20),
  rows: z.array(z.object({
    top: z.number().int().nonnegative().max(2400),
    bottom: z.number().int().positive().max(2400),
    transactionType: z.enum(["P", "S", "E"]).nullable(),
    amountLetter: z.string().regex(/^[A-K]$/u).nullable(),
  }).strict()).min(1).max(40),
}).strict();

export async function readHouseLegacyGrid(page: HybridEvidencePdfPage): Promise<HouseLegacyGrid | null> {
  const bytes = Buffer.from(page.imageBase64, "base64");
  if (bytes.byteLength > 2_500_000 || bytes.byteLength !== page.byteCount ||
      createHash("sha256").update(bytes).digest("hex") !== page.evidenceDigest ||
      page.width > 2400 || page.height > 2400) throw new Error("artifact_digest_mismatch");
  const result = await runHybridEvidenceDecoderProcess<unknown>({
    payload: { operation: "house-grid", imageBase64: page.imageBase64, evidenceDigest: page.evidenceDigest,
      width: page.width, height: page.height, maximumRenderBytes: 2_500_000 },
    source: HOUSE_LEGACY_GRID_DECODER_SOURCE,
    timeoutMs: 15_000,
  });
  if (result === null) return null;
  const grid = validateHouseLegacyGrid(result, page);
  await verifyHouseLegacyGridImages(grid, page);
  return grid;
}

export async function verifyHouseLegacyGridImages(grid: HouseLegacyGrid, page: HybridEvidencePdfPage): Promise<void> {
  const crops = await projectHybridEvidencePdfRegions({ page, regions: grid.regions.map((view) => view.region) });
  for (const [index, view] of grid.regions.entries()) {
    if (crops[index]!.evidenceDigest !== view.evidenceDigest || crops[index]!.imageBase64 !== view.imageBase64) {
      throw new Error("artifact_digest_mismatch");
    }
  }
}

export function validateHouseLegacyGrid(value: unknown, page: HybridEvidencePdfPage): HouseLegacyGrid {
  const grid = gridSchema.parse(value);
  const invalid = () => { throw new Error("column_mapping_ambiguous"); };
  if (grid.sourceEvidenceDigest !== page.evidenceDigest) throw new Error("artifact_digest_mismatch");
  if (grid.columns.some((x, i) => x >= page.width || (i > 0 && x <= grid.columns[i - 1]!))) invalid();
  if (grid.rows.some((row, i) => row.top >= row.bottom || row.bottom > page.height ||
      (i > 0 && row.top !== grid.rows[i - 1]!.bottom) ||
      ((row.transactionType === null) !== (row.amountLetter === null)))) invalid();
  const covered = new Set<number>();
  for (const [index, view] of grid.regions.entries()) {
    if (createHash("sha256").update(Buffer.from(view.imageBase64, "base64")).digest("hex") !== view.evidenceDigest ||
        view.region.x + view.region.width > 1 || view.region.y + view.region.height > 1) {
      throw new Error("artifact_digest_mismatch");
    }
    if (index === 0) {
      if (view.firstRow !== 0 || view.lastRow !== 0) invalid();
    } else {
      if (view.firstRow < 1 || view.lastRow < view.firstRow || view.lastRow > grid.rows.length) invalid();
      for (let row = view.firstRow; row <= view.lastRow; row++) {
        if (covered.has(row) || grid.rows[row - 1]!.transactionType === null) invalid();
        covered.add(row);
      }
    }
    const top = index === 0 ? 0 : grid.rows[view.firstRow - 1]!.top;
    const bottom = index === 0 ? grid.rows[0]!.top : grid.rows[view.lastRow - 1]!.bottom;
    const x = Math.max(0, grid.columns[0]! - 4);
    const y = Math.max(0, top - 3);
    const width = Math.min(page.width - x, grid.columns[grid.columns.length - 1]! + 5 - x);
    const height = Math.min(page.height - y, bottom + 3 - y);
    if (Math.abs(view.region.x * page.width - x) > 1e-7 ||
        Math.abs(view.region.y * page.height - y) > 1e-7 ||
        Math.abs(view.region.width * page.width - width) > 1e-7 ||
        Math.abs(view.region.height * page.height - height) > 1e-7) invalid();
  }
  if (covered.size !== grid.rows.filter((row) => row.transactionType !== null).length) invalid();
  return grid;
}

/** The independent reader gets one physical row per image so repeated names
 * cannot shift the row association. Every pixel is an unmodified source crop. */
export async function readHouseLegacyIndependentViews(page: HybridEvidencePdfPage, grid: HouseLegacyGrid) {
  validateHouseLegacyGrid(grid, page);
  const amountStart = grid.columns.length - 12;
  const dateStart = amountStart - 2;
  const rectangle = (left: number, top: number, right: number, bottom: number) => ({
    x: left / page.width, y: top / page.height,
    width: (right - left) / page.width, height: (bottom - top) / page.height,
  });
  const descriptors = [
    { description: `Same page ${page.page}, header only; no transactions.`, region: grid.regions[0]!.region },
    { description: `Same page ${page.page}, Clerk stamp detail; no transactions.`,
      region: rectangle(Math.max(0, grid.columns[dateStart]! - 4), 0,
        Math.min(page.width, grid.columns[grid.columns.length - 1]! + 5), grid.rows[0]!.top) },
    ...grid.rows.flatMap((row, index) => row.transactionType === null ? [] : [{
      description: `Same page ${page.page}, exactly one row: ${houseLegacyRowKey(index + 1)}, exact crop.`,
      region: rectangle(Math.max(0, grid.columns[0]! - 4), Math.max(0, row.top - 3),
        Math.min(page.width, grid.columns[amountStart]! + 4), Math.min(page.height, row.bottom + 3)),
    }]),
  ];
  const images = await projectHybridEvidencePdfRegions({ page, regions: descriptors.map((view) => view.region) });
  return descriptors.map((view, index) => ({ ...view, evidenceDigest: images[index]!.evidenceDigest,
    image: Buffer.from(images[index]!.imageBase64, "base64") }));
}
