import { createHash } from "node:crypto";

import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from "@napi-rs/canvas";

import { HYBRID_EVIDENCE_LIMITS } from "./hybrid-evidence-schema";

const MAX_RENDER_BYTES = 2_500_000;
const MAX_RENDER_EDGE = 1_600;
const MAX_OCR_CHARACTERS_PER_PAGE = 16_000;
const MAX_PDF_RUNTIME_MS = 15_000;

let pdfJsModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
let pdfJsWorkerModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.worker.mjs")> | undefined;

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function installCanvasPrimitives(): void {
  const primitives = { DOMMatrix, ImageData, Path2D };
  for (const [name, value] of Object.entries(primitives)) {
    if (!Reflect.get(globalThis, name)) {
      Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
    }
  }
}

async function loadPdfJs() {
  installCanvasPrimitives();
  await (pdfJsWorkerModule ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  return (pdfJsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
}

async function bounded<T>(startedAt: number, work: Promise<T>): Promise<T> {
  const remaining = MAX_PDF_RUNTIME_MS - (Date.now() - startedAt);
  if (remaining <= 0) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new HybridEvidencePdfError("evidence_bounds_exceeded")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertPdfContainer(bytes: Uint8Array): void {
  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  ) throw new HybridEvidencePdfError("hostile_document");
  const raw = Buffer.from(bytes).toString("latin1");
  if (
    /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|SubmitForm|ImportData)\b/u.test(raw) ||
    /\/(?:URI|GoToR)\b/u.test(raw) ||
    /(?:file|ftp):\/\//iu.test(raw)
  ) throw new HybridEvidencePdfError("hostile_document");
}

export class HybridEvidencePdfError extends Error {
  constructor(readonly code:
    | "artifact_digest_mismatch"
    | "citation_invalid"
    | "evidence_bounds_exceeded"
    | "hostile_document"
    | "independent_value_mismatch") {
    super(code);
    this.name = "HybridEvidencePdfError";
  }
}

export interface HybridEvidencePdfPage {
  readonly byteCount: number;
  readonly evidenceDigest: string;
  readonly height: number;
  readonly imageBase64: string;
  readonly mediaType: "image/png";
  readonly page: number;
  readonly text: string;
  readonly textDigest: string;
  readonly width: number;
}

export interface HybridEvidencePdfProjection {
  readonly documentDigest: string;
  readonly pageCount: number;
  readonly pages: readonly HybridEvidencePdfPage[];
}

export async function readHybridEvidencePdfPage(input: {
  readonly evidenceDigest: string;
  readonly page: number;
  readonly projection: HybridEvidencePdfProjection;
  readonly region: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  } | null;
}): Promise<HybridEvidencePdfPage> {
  const page = input.projection.pages.find((candidate) => candidate.page === input.page);
  if (!page) throw new HybridEvidencePdfError("citation_invalid");
  if (!input.region) {
    if (page.evidenceDigest !== input.evidenceDigest) {
      throw new HybridEvidencePdfError("artifact_digest_mismatch");
    }
    return page;
  }
  const source = await loadImage(Buffer.from(page.imageBase64, "base64"));
  const sourceX = Math.floor(input.region.x * page.width);
  const sourceY = Math.floor(input.region.y * page.height);
  const width = Math.max(1, Math.ceil(input.region.width * page.width));
  const height = Math.max(1, Math.ceil(input.region.height * page.height));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(source, sourceX, sourceY, width, height, 0, 0, width, height);
  const png = canvas.toBuffer("image/png");
  const evidenceDigest = digestBytes(png);
  if (png.byteLength > MAX_RENDER_BYTES) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
  if (evidenceDigest !== input.evidenceDigest) {
    throw new HybridEvidencePdfError("artifact_digest_mismatch");
  }
  return Object.freeze({
    ...page,
    byteCount: png.byteLength,
    evidenceDigest,
    height,
    imageBase64: png.toString("base64"),
    width,
  });
}

export interface IndependentPdfOcr {
  recognize(input: {
    readonly image: Uint8Array;
    readonly mediaType: "image/png";
    readonly page: number;
  }): Promise<string>;
}

function normalizedText(value: string): string {
  return value.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
}

export async function projectHybridEvidencePdf(
  bytes: Uint8Array,
): Promise<HybridEvidencePdfProjection> {
  assertPdfContainer(bytes);
  const startedAt = Date.now();
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({ data: bytes.slice(), useSystemFonts: true });
  try {
    const document = await bounded(startedAt, loadingTask.promise);
    if (
      document.numPages < 1 ||
      document.numPages > HYBRID_EVIDENCE_LIMITS.maximumArtifactPages ||
      await bounded(startedAt, document.getAttachments()) !== null ||
      await bounded(startedAt, document.getJSActions()) !== null
    ) throw new HybridEvidencePdfError("hostile_document");

    const pages: HybridEvidencePdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await bounded(startedAt, document.getPage(pageNumber));
      const annotations = await bounded(startedAt, page.getAnnotations());
      if (annotations.some((annotation) =>
        Boolean(annotation.url || annotation.unsafeUrl || annotation.file || annotation.attachment || annotation.action))) {
        throw new HybridEvidencePdfError("hostile_document");
      }
      const content = await bounded(startedAt, page.getTextContent());
      const text = normalizedText(content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
      if (text.length > MAX_OCR_CHARACTERS_PER_PAGE) {
        throw new HybridEvidencePdfError("evidence_bounds_exceeded");
      }

      const initial = page.getViewport({ scale: 1 });
      let scale = Math.min(2, MAX_RENDER_EDGE / Math.max(initial.width, initial.height));
      let png: Buffer | undefined;
      let width = 0;
      let height = 0;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const viewport = page.getViewport({ scale });
        width = Math.max(1, Math.ceil(viewport.width));
        height = Math.max(1, Math.ceil(viewport.height));
        const canvas = createCanvas(width, height);
        const context = canvas.getContext("2d");
        await bounded(startedAt, page.render({
          canvas: canvas as never,
          canvasContext: context as never,
          viewport,
        }).promise);
        png = canvas.toBuffer("image/png");
        if (png.byteLength <= MAX_RENDER_BYTES) break;
        scale *= 0.7;
      }
      if (!png || png.byteLength > MAX_RENDER_BYTES) {
        throw new HybridEvidencePdfError("evidence_bounds_exceeded");
      }
      pages.push(Object.freeze({
        byteCount: png.byteLength,
        evidenceDigest: digestBytes(png),
        height,
        imageBase64: png.toString("base64"),
        mediaType: "image/png" as const,
        page: pageNumber,
        text,
        textDigest: digestBytes(Buffer.from(text, "utf8")),
        width,
      }));
    }
    return Object.freeze({
      documentDigest: digestBytes(bytes),
      pageCount: document.numPages,
      pages: Object.freeze(pages),
    });
  } catch (error) {
    if (error instanceof HybridEvidencePdfError) throw error;
    throw new HybridEvidencePdfError("hostile_document");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

export async function readIndependentPdfText(input: {
  readonly ocr?: IndependentPdfOcr;
  readonly projection: HybridEvidencePdfProjection;
}): Promise<ReadonlyMap<number, string>> {
  const values = new Map<number, string>();
  for (const page of input.projection.pages) {
    const value = page.text.length > 0
      ? page.text
      : input.ocr
        ? normalizedText(await input.ocr.recognize({
            image: Buffer.from(page.imageBase64, "base64"),
            mediaType: page.mediaType,
            page: page.page,
          }))
        : "";
    if (value.length > MAX_OCR_CHARACTERS_PER_PAGE) {
      throw new HybridEvidencePdfError("evidence_bounds_exceeded");
    }
    values.set(page.page, value);
  }
  return values;
}

export function assertIndependentPdfValue(input: {
  readonly page: number;
  readonly textByPage: ReadonlyMap<number, string>;
  readonly value: string;
}): void {
  const evidence = input.textByPage.get(input.page);
  if (evidence === undefined) throw new HybridEvidencePdfError("citation_invalid");
  const expected = normalizedText(input.value).toLocaleLowerCase("en-US");
  const actual = normalizedText(evidence).toLocaleLowerCase("en-US");
  if (expected.length === 0 || !actual.includes(expected)) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
}
