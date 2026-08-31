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
    if (count > width * .65) horizontal.push(y);
  }
  const ys = groups(horizontal);
  if (ys.length < 7 || ys.length > 43) return null;
  const gaps = ys.slice(1).map((y, i) => y - ys[i]);
  const header = gaps.indexOf(Math.max(...gaps));
  if (header !== 1 || gaps[header] < height * .15) return null;
  const rowLines = ys.slice(header + 1);
  const rowHeights = rowLines.slice(1).map((y, i) => y - rowLines[i]);
  const medianHeight = [...rowHeights].sort((a, b) => a - b)[Math.floor(rowHeights.length / 2)];
  if (medianHeight < height * .012 || medianHeight > height * .045 ||
      rowHeights.some((h) => h < medianHeight * .75 || h > medianHeight * 1.3)) return null;
  const vertical = [], radius = Math.ceil(width / 800);
  const top = ys[1] + radius, bottom = ys[ys.length - 1] - radius;
  for (let x = radius; x < width - radius; x++) {
    let count = 0;
    for (let y = top; y < bottom; y++) {
      for (let dx = -radius; dx <= radius; dx++) if (dark(x + dx, y)) { count++; break; }
    }
    if (count > (bottom - top) * .8) vertical.push(x);
  }
  const xs = groups(vertical);
  // Owner, asset, P/S/E, two dates, and eleven A-K columns. Never infer a
  // missing line: any other layout falls back to the normal evidence path.
  if (xs.length !== 19) return null;
  const widths = xs.slice(1).map((x, i) => x - xs[i]);
  const unit = widths.slice(7).reduce((a, b) => a + b, 0) / 11;
  if (widths.slice(7).some((w) => Math.abs(w - unit) > unit * .15) ||
      widths.slice(2, 5).some((w) => w < unit * .8 || w > unit * 1.3) ||
      widths[1] < unit * 15 || widths[0] < unit * 2 || widths[0] > unit * 4 ||
      widths.slice(5, 7).some((w) => w < unit * 2.5 || w > unit * 4.5)) return null;
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
    const transactionType = select(2, 3, "PSE");
    const amountLetter = select(7, 11, "ABCDEFGHIJK");
    if ((transactionType === null) !== (amountLetter === null)) throw new Error("column_mapping_ambiguous");
    // A section heading has no dates. Never silently discard a dated row whose
    // transaction/amount marks are missing or too faint to recognize.
    if (transactionType === null && (density(5) >= .035 || density(6) >= .035)) throw new Error("column_mapping_ambiguous");
    return { top, bottom, transactionType, amountLetter };
  });
  return { columns: xs, rows };
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
        const width = Math.min(image.width - x, grid.columns[18] + 5 - x);
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

} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "hostile_document");
  process.exitCode = 1;
}
`;
