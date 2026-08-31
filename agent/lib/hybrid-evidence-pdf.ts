import { createHash } from "node:crypto";

import { z } from "zod";

import {
  HybridEvidenceDecoderProcessError,
  runHybridEvidenceDecoderProcess,
} from "./hybrid-evidence-decoder-process";
import { HYBRID_EVIDENCE_PDF_DECODER_SOURCE } from "./hybrid-evidence-pdf-decoder-source";
import { HYBRID_EVIDENCE_LIMITS } from "./hybrid-evidence-schema";

const MAX_RENDER_BYTES = 2_500_000;
const DEFAULT_RENDER_EDGE = 1_600;
export const HYBRID_EVIDENCE_MAX_RENDER_EDGE = 2_400;
const MAX_OCR_CHARACTERS_PER_PAGE = 16_000;
const MAX_PDF_RUNTIME_MS = 15_000;
const MAX_PDF_PAGES = 64;

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPdfContainer(bytes: Uint8Array, allowHttpLinks: boolean): void {
  if (
    bytes.byteLength < 5 ||
    bytes.byteLength > HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes ||
    Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
  ) throw new HybridEvidencePdfError("hostile_document");
  const raw = Buffer.from(bytes).toString("latin1");
  if (
    /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|SubmitForm|ImportData)\b/u.test(raw) ||
    /\/GoToR\b/u.test(raw) ||
    (!allowHttpLinks && /\/URI\b/u.test(raw)) ||
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
  height: z.number().int().positive().max(HYBRID_EVIDENCE_MAX_RENDER_EDGE),
  imageBase64: z.string().max(Math.ceil(MAX_RENDER_BYTES * 4 / 3) + 8),
  mediaType: z.literal("image/png"),
  page: z.number().int().positive().max(MAX_PDF_PAGES),
  text: z.string().max(MAX_OCR_CHARACTERS_PER_PAGE),
  textDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  width: z.number().int().positive().max(HYBRID_EVIDENCE_MAX_RENDER_EDGE),
}).strict();

const pdfProjectionSchema = z.object({
  documentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  pageCount: z.number().int().positive().max(MAX_PDF_PAGES),
  pages: z.array(pdfPageSchema).min(1).max(MAX_PDF_PAGES),
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
  return readHybridEvidencePdfRegion({ page, region: input.region, evidenceDigest: input.evidenceDigest });
}

export async function readHybridEvidencePdfRegion(input: {
  readonly evidenceDigest: string;
  readonly page: HybridEvidencePdfPage;
  readonly region: NonNullable<Parameters<typeof readHybridEvidencePdfPage>[0]["region"]>;
}): Promise<HybridEvidencePdfPage> {
  const [crop] = await projectHybridEvidencePdfRegions({ page: input.page, regions: [input.region] });
  if (crop!.evidenceDigest !== input.evidenceDigest) throw new HybridEvidencePdfError("artifact_digest_mismatch");
  return crop!;
}

/** Derive bounded raw crops in one restricted process; no resizing or annotations. */
export async function projectHybridEvidencePdfRegions(input: {
  readonly page: HybridEvidencePdfPage;
  readonly regions: readonly NonNullable<Parameters<typeof readHybridEvidencePdfPage>[0]["region"]>[];
}): Promise<readonly HybridEvidencePdfPage[]> {
  const page = pdfPageSchema.parse(input.page);
  const bytes = Buffer.from(page.imageBase64, "base64");
  if (bytes.byteLength !== page.byteCount || digestBytes(bytes) !== page.evidenceDigest) {
    throw new HybridEvidencePdfError("artifact_digest_mismatch");
  }
  if (input.regions.length < 1 || input.regions.length > 42) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
  try {
    const output = await runHybridEvidenceDecoderProcess<unknown>({
      payload: { height: page.height, imageBase64: page.imageBase64, maximumRenderBytes: MAX_RENDER_BYTES,
        operation: "regions", regions: input.regions, width: page.width },
      source: HYBRID_EVIDENCE_PDF_DECODER_SOURCE, timeoutMs: MAX_PDF_RUNTIME_MS,
    });
    const parsed = z.array(pdfPageSchema.pick({ byteCount: true, evidenceDigest: true,
      height: true, imageBase64: true, width: true })).length(input.regions.length).parse(output);
    let totalBytes = 0;
    return parsed.map((crop, index) => {
      const region = input.regions[index]!;
      const data = Buffer.from(crop.imageBase64, "base64");
      totalBytes += data.byteLength;
      if (totalBytes > MAX_RENDER_BYTES) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
      if (data.byteLength !== crop.byteCount || digestBytes(data) !== crop.evidenceDigest ||
          crop.width !== Math.max(1, Math.ceil(region.width * page.width - 1e-7)) ||
          crop.height !== Math.max(1, Math.ceil(region.height * page.height - 1e-7))) {
        throw new HybridEvidencePdfError("artifact_digest_mismatch");
      }
      return Object.freeze({ ...page, ...crop });
    });
  } catch (error) {
    if (error instanceof HybridEvidencePdfError) throw error;
    throw decoderError(error);
  }
}

export interface IndependentPdfView {
  readonly image: Uint8Array;
  readonly description: string;
}

export interface IndependentPdfOcr {
  recognize(input: {
    readonly views?: readonly IndependentPdfView[];
    readonly image: Uint8Array;
    readonly mediaType: "image/png";
    readonly page: number;
  }): Promise<string | Readonly<{
    text: string;
    invalidResponse?: boolean;
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

class IndependentPdfOcrResponseError extends Error {
  constructor(readonly usage: { inputTokens: number; outputTokens: number; paidCostUsd?: string }) {
    super("independent_ocr_response_invalid");
    this.name = "IndependentPdfOcrResponseError";
  }
}

export class IndependentPdfOcrAggregateError extends Error {
  readonly code = "independent_ocr_failed";

  constructor(
    readonly usage: IndependentPdfTextResult["usage"],
    options?: ErrorOptions,
    readonly textByPage: ReadonlyMap<number, string> = new Map(),
    readonly allUsageKnown: boolean = false,
  ) {
    super("independent_ocr_failed", options);
    this.name = "IndependentPdfOcrAggregateError";
  }
}

function normalizedText(value: string): string {
  return value.replaceAll("\0", "").replace(/\s+/gu, " ").trim();
}

export async function projectHybridEvidencePdf(
  bytes: Uint8Array,
  options: Readonly<{
    allowHttpLinks?: boolean;
    maximumRenderEdge?: number;
    maximumPages?: number;
    preserveTextLines?: boolean;
  }> = {},
): Promise<HybridEvidencePdfProjection> {
  const allowHttpLinks = options.allowHttpLinks === true;
  const maximumRenderEdge = options.maximumRenderEdge ?? DEFAULT_RENDER_EDGE;
  const maximumPages = options.maximumPages ?? HYBRID_EVIDENCE_LIMITS.maximumArtifactPages;
  if (
    !Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > MAX_PDF_PAGES ||
    !Number.isInteger(maximumRenderEdge) || maximumRenderEdge < 1 ||
      maximumRenderEdge > HYBRID_EVIDENCE_MAX_RENDER_EDGE
  ) {
    throw new HybridEvidencePdfError("evidence_bounds_exceeded");
  }
  assertPdfContainer(bytes, allowHttpLinks);
  try {
    const decoded = pdfProjectionSchema.parse(await runHybridEvidenceDecoderProcess<unknown>({
      payload: {
        bytesBase64: Buffer.from(bytes).toString("base64"),
        maximumCharactersPerPage: MAX_OCR_CHARACTERS_PER_PAGE,
        maximumPages,
        maximumRenderBytes: MAX_RENDER_BYTES,
        maximumRenderEdge,
        operation: "project",
        allowHttpLinks,
        preserveTextLines: options.preserveTextLines === true,
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
  readonly onPage?: (input: { page: number; text: string | null; usage: { inputTokens: number; outputTokens: number; paidCostUsd?: string } }) => Promise<void>;
  readonly retainedTextByPage?: ReadonlyMap<number, string>;
  readonly forceOcr?: boolean;
  readonly viewsByPage?: ReadonlyMap<number, readonly IndependentPdfView[]>;
  readonly ocr?: IndependentPdfOcr;
  readonly projection: HybridEvidencePdfProjection;
}): Promise<IndependentPdfTextResult> {
  const values = new Map<number, string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let paidMicros = 0n;
  let paidCostKnown = true;
  let allUsageKnown = true;
  const recognize = async (page: HybridEvidencePdfPage) => {
    const retained = input.retainedTextByPage?.get(page.page);
    const recognized = retained !== undefined
      ? { text: retained, usage: { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" } }
      : page.text.length > 0 && !input.forceOcr
      ? page.text
      : input.ocr
        ? await input.ocr.recognize({
            views: input.viewsByPage?.get(page.page),
            image: Buffer.from(page.imageBase64, "base64"),
            mediaType: page.mediaType,
            page: page.page,
          })
        : "";
    const usage = typeof recognized === "string"
      ? { inputTokens: 0, outputTokens: 0, ...(!input.ocr ? { paidCostUsd: "0" } : {}) }
      : { inputTokens: recognized.usage.inputTokens ?? 0, outputTokens: recognized.usage.outputTokens ?? 0,
        ...(recognized.usage.paidCostUsd === undefined ? {} : { paidCostUsd: recognized.usage.paidCostUsd }) };
    if (typeof recognized !== "string" && "invalidResponse" in recognized && recognized.invalidResponse) {
      // Persist the receipt, but never cache a malformed response as usable OCR.
      await input.onPage?.({ page: page.page, text: null, usage });
      throw new IndependentPdfOcrResponseError(usage);
    }
    const text = normalizedText(typeof recognized === "string" ? recognized : recognized.text);
    if (text.length > MAX_OCR_CHARACTERS_PER_PAGE) throw new HybridEvidencePdfError("evidence_bounds_exceeded");
    await input.onPage?.({ page: page.page, text, usage });
    return Object.freeze({ page, recognized });
  };
  const recognizedPages: PromiseSettledResult<Awaited<ReturnType<typeof recognize>>>[] = [];
  // One admission covers the whole finite page set; never launch an unbounded
  // fanout. allSettled retains usage from successful siblings after failures.
  for (let offset = 0; offset < input.projection.pages.length; offset += 4) {
    recognizedPages.push(...await Promise.allSettled(input.projection.pages.slice(offset, offset + 4).map(recognize)));
  }
  let firstFailure: unknown;
  for (const settled of recognizedPages) {
    if (settled.status === "rejected") {
      firstFailure ??= settled.reason;
      if (settled.reason instanceof IndependentPdfOcrResponseError) {
        inputTokens += settled.reason.usage.inputTokens;
        outputTokens += settled.reason.usage.outputTokens;
        if (settled.reason.usage.paidCostUsd === undefined) paidCostKnown = false;
        else paidMicros += decimalMicros(settled.reason.usage.paidCostUsd);
      } else allUsageKnown = false;
      continue;
    }
    const { page, recognized } = settled.value;
    const value = normalizedText(typeof recognized === "string" ? recognized : recognized.text);
    if (typeof recognized !== "string") {
      inputTokens += recognized.usage.inputTokens ?? 0;
      outputTokens += recognized.usage.outputTokens ?? 0;
      if (recognized.usage.paidCostUsd === undefined) paidCostKnown = false;
      else paidMicros += decimalMicros(recognized.usage.paidCostUsd);
    } else if ((page.text.length === 0 || input.forceOcr) && input.ocr) {
      paidCostKnown = false;
    }
    if (value.length > MAX_OCR_CHARACTERS_PER_PAGE) {
      firstFailure ??= new HybridEvidencePdfError("evidence_bounds_exceeded");
      continue;
    }
    values.set(page.page, value);
  }
  const usage = Object.freeze({
    inputTokens,
    outputTokens,
    paidCostUsd: paidCostKnown ? decimalUsd(paidMicros) : null,
  });
  if (firstFailure !== undefined) {
    throw new IndependentPdfOcrAggregateError(usage, { cause: firstFailure }, values, allUsageKnown && paidCostKnown);
  }
  return Object.freeze({ textByPage: values, usage });
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
