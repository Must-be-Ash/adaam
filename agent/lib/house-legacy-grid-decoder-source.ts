/** Runs only inside the existing capability-restricted PDF decoder. */
export const HOUSE_LEGACY_GRID_DECODER_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readHouseGrid = (canvas) => {
  const width = canvas.width, height = canvas.height;
  if (width < 1200 || width > 2400 || height > 2400 || width / height < 1.2 || width / height > 1.4) return null;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const dark = (x, y) => x >= 0 && x < width && y >= 0 && y < height && pixels[(y * width + x) * 4] < 140;
  const groups = (values) => {
    const result = [];
    for (const value of values) {
      if (!result.length || value > result[result.length - 1].end + 1) result.push({ start: value, end: value });
      else result[result.length - 1].end = value;
    }
    return result.map(({ start, end }) => Math.round((start + end) / 2));
  };
  const horizontal = [];
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (dark(x, y)) count++;
    if (count > width * .55) horizontal.push(y);
  }
  const ys = groups(horizontal);
  if (ys.length < 7 || ys.length > 43) return null;
  const gaps = ys.slice(1).map((y, i) => y - ys[i]);
  const header = gaps.indexOf(Math.max(...gaps));
  if (header < 1 || header > 3 || gaps[header] < height * .15) return null;
  const vertical = [], radius = Math.ceil(width / 800);
  // Read the printed column boundaries from the column-label band. Continuation
  // pages can place a notes table directly below the transaction table, so
  // scanning to the last horizontal line would discard otherwise exact grids.
  const top = ys[header] + radius, bottom = ys[header + 1] - radius;
  for (let x = radius; x < width - radius; x++) {
    let count = 0;
    for (let y = top; y < bottom; y++) {
      for (let dx = -radius; dx <= radius; dx++) if (dark(x + dx, y)) { count++; break; }
    }
    if (count > (bottom - top) * .8) vertical.push(x);
  }
  const xs = groups(vertical);
  // Owner, asset, either P/S/E or P/S/Partial Sale/E, two dates, and eleven
  // A-K columns. Never infer a missing line: any other layout falls back to
  // the normal evidence path. House prints Partial Sale as a sale.
  if (xs.length !== 19 && xs.length !== 20) return null;
  const transactionLabels = xs.length === 20 ? "PSSE" : "PSE";
  const amountStart = xs.length - 12;
  const dateStart = amountStart - 2;
  const minimumOwnerWidth = xs.length === 20 ? .7 : 2;
  const minimumAssetWidth = xs.length === 20 ? 6 : 15;
  const widths = xs.slice(1).map((x, i) => x - xs[i]);
  const unit = widths.slice(amountStart).reduce((a, b) => a + b, 0) / 11;
  if (widths.slice(amountStart).some((w) => Math.abs(w - unit) > unit * .15) ||
      widths.slice(2, dateStart).some((w) => w < unit * .8 || w > unit * 1.3) ||
      widths[1] < unit * minimumAssetWidth || widths[0] < unit * minimumOwnerWidth || widths[0] > unit * 4 ||
      widths.slice(dateStart, amountStart).some((w) => w < unit * 2.5 || w > unit * 4.5)) return null;
  // The full first-page form includes one printed example row below the column
  // labels. Continuation pages do not repeat it, and the P/S/E form omits it.
  const allCandidateRowLines = ys.slice(header + 1);
  const candidateRowLines = xs.length === 20 && ys[header - 1] > height * .4
    ? allCandidateRowLines.slice(1) : allCandidateRowLines;
  const rowLines = [candidateRowLines[0]];
  for (let index = 1; index < candidateRowLines.length; index++) {
    const rowTop = candidateRowLines[index - 1], rowBottom = candidateRowLines[index];
    let failedBoundaries = 0;
    for (const x of xs) {
      let selected = 0, samples = 0;
      for (let y = rowTop + radius; y < rowBottom - radius; y++) {
        samples++;
        for (let dx = -radius; dx <= radius; dx++) if (dark(x + dx, y)) { selected++; break; }
      }
      if (samples === 0 || selected / samples <= .7) failedBoundaries++;
      if (failedBoundaries > 1) break;
    }
    if (failedBoundaries > 1) break;
    rowLines.push(rowBottom);
  }
  const rowHeights = rowLines.slice(1).map((y, i) => y - rowLines[i]);
  const medianHeight = [...rowHeights].sort((a, b) => a - b)[Math.floor(rowHeights.length / 2)];
  if (rowHeights.length === 0 || medianHeight < height * .012 || medianHeight > height * .045 ||
      rowHeights.some((h) => h < medianHeight * .65 || h > medianHeight * 1.3)) return null;
  const rows = rowLines.slice(0, -1).map((top, index) => {
    const bottom = rowLines[index + 1];
    const density = (column) => {
      const left = xs[column], right = xs[column + 1];
      let count = 0, area = 0;
      for (let y = Math.ceil(top + (bottom - top) * .22); y < top + (bottom - top) * .78; y++) {
        for (let x = Math.ceil(left + (right - left) * .25); x < left + (right - left) * .75; x++) {
          area++; if (dark(x, y)) count++;
        }
      }
      return count / area;
    };
    const select = (start, count, labels) => {
      const marks = Array.from({length: count}, (_, i) => density(start + i));
      const selected = marks.map((score, i) => score >= .15 && score <= .5 ? i : -1).filter((i) => i >= 0);
      if (selected.length === 0 && marks.every((score) => score < .035)) return null;
      if (selected.length !== 1 || marks.some((score, i) => i !== selected[0] && score >= .12)) throw new Error("column_mapping_ambiguous");
      return labels[selected[0]];
    };
    const transactionType = select(2, transactionLabels.length, transactionLabels);
    const amountLetter = select(amountStart, 11, "ABCDEFGHIJK");
    if ((transactionType === null) !== (amountLetter === null)) throw new Error("column_mapping_ambiguous");
    // A section heading has no dates. Never silently discard a dated row whose
    // transaction/amount marks are missing or too faint to recognize.
    if (transactionType === null && (density(dateStart) >= .035 || density(dateStart + 1) >= .035)) throw new Error("column_mapping_ambiguous");
    return { top, bottom, transactionType, amountLetter };
  });
  return { columns: xs, rows };
};
const readScannerSeparator = (canvas) => {
  const width = canvas.width, height = canvas.height;
  if (width < 1200 || height < 1600 || width / height < .72 || width / height > .8) return false;
  const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
  const dark = (x, y) => pixels[(y * width + x) * 4] < 140;
  const centers = (values) => {
    const result = [];
    for (const value of values) {
      if (!result.length || value > result[result.length - 1].end + 1) result.push({ start: value, end: value });
      else result[result.length - 1].end = value;
    }
    return result.map(({ start, end }) => (start + end) / 2);
  };
  const horizontal = [];
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) if (dark(x, y)) count++;
    if (count > width * .55) horizontal.push(y);
  }
  const vertical = [];
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) if (dark(x, y)) count++;
    if (count > height * .4) vertical.push(x);
  }
  const ys = centers(horizontal).map((value) => value / height);
  const xs = centers(vertical).map((value) => value / width);
  return ys.length === 5 && xs.length === 4 &&
    ys[0] > .05 && ys[0] < .08 && ys[3] < .14 && ys[4] > .25 && ys[4] < .35 &&
    ys.slice(1, 4).every((value, index) => value - ys[index] > .012 && value - ys[index] < .025) &&
    xs[0] > .05 && xs[0] < .08 && xs[3] < .16 &&
    xs.slice(1).every((value, index) => value - xs[index] > .015 && value - xs[index] < .035);
};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {

    const bytes = Buffer.from(input.imageBase64, "base64");
    if (digest(bytes) !== input.evidenceDigest) throw new Error("artifact_digest_mismatch");
    const image = await loadImage(bytes);
    if (image.width !== input.width || image.height !== input.height) throw new Error("artifact_digest_mismatch");
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    if (input.operation === "house-scanner-separator") {
      process.stdout.write(JSON.stringify(readScannerSeparator(canvas)));
    } else {
      if (input.operation !== "house-grid") throw new Error("hostile_document");
      const grid = readHouseGrid(canvas);
      const regions = [];
      if (grid) {
      const spans = [{ firstRow: 0, lastRow: 0, top: 0, bottom: grid.rows[0].top }];
      for (let index = 0; index < grid.rows.length;) {
        if (grid.rows[index].transactionType === null) { index++; continue; }
        const start = index;
        while (index + 1 < grid.rows.length && grid.rows[index + 1].transactionType !== null) index++;
        spans.push({ firstRow: start + 1, lastRow: index + 1, top: grid.rows[start].top, bottom: grid.rows[index].bottom });
        index++;
      }
      if (spans.length > 7) throw new Error("evidence_bounds_exceeded");
      for (const span of spans) {
        const x = Math.max(0, grid.columns[0] - 4);
        const y = Math.max(0, span.top - 3);
        const width = Math.min(image.width - x, grid.columns[grid.columns.length - 1] + 5 - x);
        const height = Math.min(image.height - y, span.bottom + 3 - y);
        const crop = createCanvas(width, height);
        crop.getContext("2d").drawImage(image, x, y, width, height, 0, 0, width, height);
        const png = crop.toBuffer("image/png");
        if (png.byteLength > input.maximumRenderBytes) throw new Error("evidence_bounds_exceeded");
        regions.push({ firstRow: span.firstRow, lastRow: span.lastRow,
          region: { x: x / image.width, y: y / image.height, width: width / image.width, height: height / image.height },
          imageBase64: png.toString("base64"), evidenceDigest: digest(png) });
      }
      }
      process.stdout.write(JSON.stringify(grid ? { ...grid, regions, sourceEvidenceDigest: digest(bytes) } : null));
    }

} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "hostile_document");
  process.exitCode = 1;
}
`;
