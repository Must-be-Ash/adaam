import { createHash } from "node:crypto";

import { z } from "zod";

import {
  HybridEvidenceDecoderProcessError,
  runHybridEvidenceDecoderProcess,
} from "./hybrid-evidence-decoder-process";
import { HYBRID_EVIDENCE_PDF_DECODER_SOURCE } from "./hybrid-evidence-pdf-decoder-source";
import { HYBRID_EVIDENCE_LIMITS } from "./hybrid-evidence-schema";

const MAX_RENDER_BYTES = 2_500_000;
const MAX_RENDER_EDGE = 1_600;
const MAX_OCR_CHARACTERS_PER_PAGE = 16_000;
const MAX_PDF_RUNTIME_MS = 15_000;

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

const pdfPageSchema = z.object({
  byteCount: z.number().int().positive().max(MAX_RENDER_BYTES),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  height: z.number().int().positive().max(MAX_RENDER_EDGE),
  imageBase64: z.string().max(Math.ceil(MAX_RENDER_BYTES * 4 / 3) + 8),
  mediaType: z.literal("image/png"),
  page: z.number().int().positive().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactPages),
  text: z.string().max(MAX_OCR_CHARACTERS_PER_PAGE),
  textDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().positive().max(MAX_RENDER_EDGE),
}).strict();

const pdfProjectionSchema = z.object({
  documentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  pageCount: z.number().int().positive().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactPages),
  pages: z.array(pdfPageSchema).min(1).max(HYBRID_EVIDENCE_LIMITS.maximumArtifactPages),
}).strict();

function decoderError(error: unknown): HybridEvidencePdfError {
  return new HybridEvidencePdfError(
    error instanceof HybridEvidenceDecoderProcessError && error.code === "evidence_bounds_exceeded"
      ? "evidence_bounds_exceeded"
      : "hostile_document",
  );
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
  try {
    const region = await runHybridEvidenceDecoderProcess<unknown>({
      payload: {
        height: page.height,
        imageBase64: page.imageBase64,
        maximumRenderBytes: MAX_RENDER_BYTES,
        operation: "region",
        region: input.region,
        width: page.width,
      },
      source: HYBRID_EVIDENCE_PDF_DECODER_SOURCE,
      timeoutMs: MAX_PDF_RUNTIME_MS,
    });
    const parsed = pdfPageSchema.pick({
      byteCount: true,
      evidenceDigest: true,
      height: true,
      imageBase64: true,
      width: true,
    }).parse(region);
    if (parsed.evidenceDigest !== input.evidenceDigest) {
      throw new HybridEvidencePdfError("artifact_digest_mismatch");
    }
    return Object.freeze({ ...page, ...parsed });
  } catch (error) {
    if (error instanceof HybridEvidencePdfError) throw error;
    throw decoderError(error);
  }
}

export interface IndependentPdfOcr {
  recognize(input: {
    readonly image: Uint8Array;
    readonly mediaType: "image/png";
    readonly page: number;
  }): Promise<string | Readonly<{
    text: string;
    usage: Readonly<{
      inputTokens?: number;
      outputTokens?: number;
      paidCostUsd?: string;
    }>;
  }>>;
}

export interface IndependentPdfTextResult {
  readonly textByPage: ReadonlyMap<number, string>;
  readonly usage: Readonly<{
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly paidCostUsd: string | null;
  }>;
}

function normalizedText(value: string): string {
  return value.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
}

export async function projectHybridEvidencePdf(
  bytes: Uint8Array,
): Promise<HybridEvidencePdfProjection> {
  assertPdfContainer(bytes);
  try {
    const decoded = pdfProjectionSchema.parse(await runHybridEvidenceDecoderProcess<unknown>({
      payload: {
        bytesBase64: Buffer.from(bytes).toString("base64"),
        maximumCharactersPerPage: MAX_OCR_CHARACTERS_PER_PAGE,
        maximumPages: HYBRID_EVIDENCE_LIMITS.maximumArtifactPages,
        maximumRenderBytes: MAX_RENDER_BYTES,
        maximumRenderEdge: MAX_RENDER_EDGE,
        operation: "project",
      },
      source: HYBRID_EVIDENCE_PDF_DECODER_SOURCE,
      timeoutMs: MAX_PDF_RUNTIME_MS,
    }));
    if (decoded.documentDigest !== digestBytes(bytes) || decoded.pageCount !== decoded.pages.length) {
      throw new HybridEvidencePdfError("artifact_digest_mismatch");
    }
    return Object.freeze({
      ...decoded,
      pages: Object.freeze(decoded.pages.map((page) => Object.freeze(page))),
    });
  } catch (error) {
    if (error instanceof HybridEvidencePdfError) throw error;
    throw decoderError(error);
  }
}

export async function readIndependentPdfText(input: {
  readonly ocr?: IndependentPdfOcr;
  readonly projection: HybridEvidencePdfProjection;
}): Promise<ReadonlyMap<number, string>> {
  return (await readIndependentPdfTextWithUsage(input)).textByPage;
}

function decimalMicros(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(value);
  if (!match) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
  return BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

function decimalUsd(value: bigint): string {
  const remainder = value % 1_000_000n;
  return `${value / 1_000_000n}${remainder === 0n
    ? ""
    : `.${remainder.toString().padStart(6, "0").replace(/0+$/u, "")}`}`;
}

export async function readIndependentPdfTextWithUsage(input: {
  readonly ocr?: IndependentPdfOcr;
  readonly projection: HybridEvidencePdfProjection;
}): Promise<IndependentPdfTextResult> {
  const values = new Map<number, string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let paidMicros = 0n;
  let paidCostKnown = true;
  for (const page of input.projection.pages) {
    const recognized = page.text.length > 0
      ? page.text
      : input.ocr
        ? await input.ocr.recognize({
            image: Buffer.from(page.imageBase64, "base64"),
            mediaType: page.mediaType,
            page: page.page,
          })
        : "";
    const value = normalizedText(typeof recognized === "string" ? recognized : recognized.text);
    if (typeof recognized !== "string") {
      inputTokens += recognized.usage.inputTokens ?? 0;
      outputTokens += recognized.usage.outputTokens ?? 0;
      if (recognized.usage.paidCostUsd === undefined) paidCostKnown = false;
      else paidMicros += decimalMicros(recognized.usage.paidCostUsd);
    } else if (page.text.length === 0 && input.ocr) {
      paidCostKnown = false;
    }
    if (value.length > MAX_OCR_CHARACTERS_PER_PAGE) {
      throw new HybridEvidencePdfError("evidence_bounds_exceeded");
    }
    values.set(page.page, value);
  }
  return Object.freeze({
    textByPage: values,
    usage: Object.freeze({
      inputTokens,
      outputTokens,
      paidCostUsd: paidCostKnown ? decimalUsd(paidMicros) : null,
    }),
  });
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
