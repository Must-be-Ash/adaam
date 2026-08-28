/** Plain JavaScript evaluated in a capability-restricted decoder process. */
export const HYBRID_EVIDENCE_PDF_DECODER_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from "@napi-rs/canvas";
await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
for (const [name, value] of Object.entries({ DOMMatrix, ImageData, Path2D })) {
  if (!Reflect.get(globalThis, name)) Object.defineProperty(globalThis, name, { value });
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const wasmUrl = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/wasm/jbig2.wasm"))) + sep;
const normalized = (value) => value.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
const normalizedLines = (items) => items
  .flatMap((item) => "str" in item ? [item.str, item.hasEOL ? "\n" : " "] : [])
  .join("")
  .replaceAll("\0", "")
  .split("\n")
  .map((line) => line.replace(/[\t\f\v ]+/gu, " ").trim())
  .filter((line) => line.length > 0)
  .join("\n");
const safeHttpLink = (value) => {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
try {
  if (input.operation === "region") {
    const source = await loadImage(Buffer.from(input.imageBase64, "base64"));
    const sourceX = Math.floor(input.region.x * input.width);
    const sourceY = Math.floor(input.region.y * input.height);
    const width = Math.max(1, Math.ceil(input.region.width * input.width));
    const height = Math.max(1, Math.ceil(input.region.height * input.height));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(source, sourceX, sourceY, width, height, 0, 0, width, height);
    const png = canvas.toBuffer("image/png");
    if (png.byteLength > input.maximumRenderBytes) throw new Error("evidence_bounds_exceeded");
    process.stdout.write(JSON.stringify({
      byteCount: png.byteLength,
      evidenceDigest: digest(png),
      height,
      imageBase64: png.toString("base64"),
      width,
    }));
  } else {
    const bytes = Buffer.from(input.bytesBase64, "base64");
    const loadingTask = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, wasmUrl });
    try {
      const document = await loadingTask.promise;
      if (
        document.numPages < 1 ||
        document.numPages > input.maximumPages ||
        await document.getAttachments() !== null ||
        await document.getJSActions() !== null
      ) throw new Error("hostile_document");
      const pages = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const annotations = await page.getAnnotations();
        if (annotations.some((annotation) => {
          if (annotation.file || annotation.attachment || annotation.action) return true;
          const links = [annotation.url, annotation.unsafeUrl].filter((value) => value !== undefined);
          return links.length > 0 && (!input.allowHttpLinks || links.some((value) => !safeHttpLink(value)));
        })) {
          throw new Error("hostile_document");
        }
        const content = await page.getTextContent();
        const text = input.preserveTextLines
          ? normalizedLines(content.items)
          : normalized(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
        if (text.length > input.maximumCharactersPerPage) throw new Error("evidence_bounds_exceeded");
        const initial = page.getViewport({ scale: 1 });
        let scale = Math.min(4, input.maximumRenderEdge / Math.max(initial.width, initial.height));
        let png;
        let width = 0;
        let height = 0;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const viewport = page.getViewport({ scale });
          width = Math.max(1, Math.ceil(viewport.width));
          height = Math.max(1, Math.ceil(viewport.height));
          const canvas = createCanvas(width, height);
          await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
          png = canvas.toBuffer("image/png");
          if (png.byteLength <= input.maximumRenderBytes) break;
          scale *= 0.7;
        }
        if (!png || png.byteLength > input.maximumRenderBytes) throw new Error("evidence_bounds_exceeded");
        pages.push({
          byteCount: png.byteLength,
          evidenceDigest: digest(png),
          height,
          imageBase64: png.toString("base64"),
          mediaType: "image/png",
          page: pageNumber,
          text,
          textDigest: digest(Buffer.from(text, "utf8")),
          width,
        });
      }
      process.stdout.write(JSON.stringify({ documentDigest: digest(bytes), pageCount: document.numPages, pages }));
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "hostile_document");
  process.exitCode = 1;
}
`;
