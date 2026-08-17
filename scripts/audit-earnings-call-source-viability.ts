import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { fetchOfficialPublicSourceBytes } from "../agent/tools/fetch_public_source";

const MAXIMUM_FILINGS_PER_ISSUER = 12;
const MAXIMUM_CANDIDATES_PER_ISSUER = 12;
const MAXIMUM_INDEX_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SUBMISSIONS_BYTES = 8 * 1024 * 1024;
const MAXIMUM_EXHIBIT_BYTES = 4 * 1024 * 1024;
const MINIMUM_REQUEST_INTERVAL_MS = 125;
const MAXIMUM_PDF_PAGES = 128;
const MAXIMUM_PDF_TEXT_CHARACTERS = 500_000;

const cohortSchema = z.object({
  cohortId: z.literal("earnings-call-sec-viability"),
  cohortVersion: z.literal("1.0.0"),
  exchanges: z.array(z.enum(["Nasdaq", "NYSE"])).length(2),
  issuers: z.array(z.object({
    cik: z.string().regex(/^\d{10}$/u),
    exchange: z.enum(["Nasdaq", "NYSE"]),
    sector: z.enum([
      "communication_services",
      "consumer",
      "energy",
      "financials",
      "healthcare",
      "industrials",
      "technology",
      "utilities",
    ]),
    ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u),
  }).strict()).length(50),
  schemaVersion: z.literal(1),
}).strict().superRefine((cohort, context) => {
  if (
    new Set(cohort.issuers.map(({ cik }) => cik)).size !== cohort.issuers.length ||
    new Set(cohort.issuers.map(({ ticker }) => ticker)).size !== cohort.issuers.length ||
    new Set(cohort.issuers.map(({ sector }) => sector)).size < 3
  ) {
    context.addIssue({ code: "custom", message: "issuer_cohort_invalid" });
  }
});

const submissionsSchema = z.object({
  cik: z.string(),
  entityType: z.string(),
  exchanges: z.array(z.string()),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      acceptanceDateTime: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      reportDate: z.array(z.string()),
    }).passthrough(),
  }).passthrough(),
  fiscalYearEnd: z.string().nullable().optional(),
  name: z.string(),
  sicDescription: z.string().nullable().optional(),
  tickers: z.array(z.string()),
}).passthrough();

const companyTickerExchangeSchema = z.object({
  data: z.array(z.tuple([
    z.number().int().positive(),
    z.string().min(1),
    z.string().min(1),
    z.string().min(1).nullable(),
  ])),
  fields: z.tuple([
    z.literal("cik"),
    z.literal("name"),
    z.literal("ticker"),
    z.literal("exchange"),
  ]),
}).passthrough();

type CohortIssuer = z.infer<typeof cohortSchema>["issuers"][number];

interface FilingCandidate {
  readonly accessionNumber: string;
  readonly acceptanceDateTime: string;
  readonly filingDate: string;
  readonly form: string;
  readonly primaryDocument: string;
  readonly reportDate: string;
}

interface FilingDocument {
  readonly description: string;
  readonly document: string;
  readonly filingType: string;
  readonly sequence: string;
  readonly url: string;
}

let lastRequestStartedAt = 0;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rateLimitedFetch(
  url: string,
  maximumBytes: number,
  origin: "https://data.sec.gov" | "https://www.sec.gov",
) {
  const waitMs = Math.max(
    0,
    MINIMUM_REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt),
  );
  if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
  lastRequestStartedAt = Date.now();
  return fetchOfficialPublicSourceBytes(url, maximumBytes, { origin });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

let pdfJsModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
let pdfJsWorkerModule: Promise<typeof import("pdfjs-dist/legacy/build/pdf.worker.mjs")> | undefined;
let canvasPrimitives: { DOMMatrix: typeof DOMMatrix; Path2D: typeof Path2D } | undefined;

async function loadPdfJs() {
  canvasPrimitives ??= process.getBuiltinModule("module")
    .createRequire(import.meta.url)("@napi-rs/canvas") as typeof canvasPrimitives;
  if (!globalThis.DOMMatrix) {
    Object.defineProperty(globalThis, "DOMMatrix", { configurable: true, value: canvasPrimitives!.DOMMatrix });
  }
  if (!globalThis.Path2D) {
    Object.defineProperty(globalThis, "Path2D", { configurable: true, value: canvasPrimitives!.Path2D });
  }
  await (pdfJsWorkerModule ??= import("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  return (pdfJsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({ data: bytes.slice(), useSystemFonts: true });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > MAXIMUM_PDF_PAGES) throw new Error("pdf_page_limit_exceeded");
    const pages: string[] = [];
    let characters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ");
      characters += text.length;
      if (characters > MAXIMUM_PDF_TEXT_CHARACTERS) throw new Error("pdf_text_limit_exceeded");
      pages.push(text);
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function textContent(value: string): string {
  return decodeEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function safeArchiveDocumentUrl(indexUrl: string, href: string): string | null {
  const decodedHref = decodeEntities(href.trim());
  if (!decodedHref || decodedHref.startsWith("javascript:")) return null;
  const normalizedHref = decodedHref
    .replace(/^\/ixviewer\/doc\/action_getdoc\.xhtml\?doc=/u, "")
    .replace(/^\/ix\?doc=/u, "");
  let url: URL;
  try {
    url = new URL(normalizedHref, indexUrl);
  } catch {
    return null;
  }
  const index = new URL(indexUrl);
  const accessionRoot = index.pathname.replace(/[^/]+$/u, "");
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://www.sec.gov" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith(accessionRoot) ||
    !/^\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9_.-]+$/u.test(url.pathname)
  ) {
    return null;
  }
  return url.toString();
}

function parseFilingDocuments(html: string, indexUrl: string): FilingDocument[] {
  const documents: FilingDocument[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/giu)]
      .map((cell) => cell[1]!);
    if (cells.length < 4) continue;
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu.exec(cells[2]!);
    if (!anchor) continue;
    const url = safeArchiveDocumentUrl(indexUrl, anchor[1]!);
    if (!url) continue;
    documents.push(Object.freeze({
      description: textContent(cells[1]!),
      document: textContent(anchor[2]!),
      filingType: textContent(cells[3]!),
      sequence: textContent(cells[0]!),
      url,
    }));
  }
  return documents;
}

function documentRank(document: FilingDocument): number | null {
  const searchable = `${document.description} ${document.document}`.toLowerCase();
  if (!/^EX-99(?:\.|$)/iu.test(document.filingType)) return null;
  if (/\btranscript\b/u.test(searchable)) return 0;
  if (/\b(?:earnings|results)\s+(?:conference\s+)?call\b/u.test(searchable)) return 1;
  if (/\bconference call\b/u.test(searchable)) return 2;
  if (/\bprepared remarks?\b/u.test(searchable)) return 3;
  return 4;
}

function filingCandidates(recent: z.infer<typeof submissionsSchema>["filings"]["recent"]): FilingCandidate[] {
  const candidates: FilingCandidate[] = [];
  for (let index = 0; index < recent.accessionNumber.length; index += 1) {
    const form = recent.form[index];
    if (!form || !["8-K", "8-K/A", "6-K", "6-K/A"].includes(form)) continue;
    const accessionNumber = recent.accessionNumber[index];
    const acceptanceDateTime = recent.acceptanceDateTime[index];
    const filingDate = recent.filingDate[index];
    const primaryDocument = recent.primaryDocument[index];
    const reportDate = recent.reportDate[index];
    if (!accessionNumber || !acceptanceDateTime || !filingDate || !primaryDocument) continue;
    candidates.push(Object.freeze({
      accessionNumber,
      acceptanceDateTime,
      filingDate,
      form,
      primaryDocument,
      reportDate: reportDate ?? "",
    }));
    if (candidates.length === MAXIMUM_FILINGS_PER_ISSUER) break;
  }
  return candidates;
}

function indexUrl(cik: string, accessionNumber: string): string {
  const unpaddedCik = String(Number(cik));
  const accessionPath = accessionNumber.replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/data/${unpaddedCik}/${accessionPath}/${accessionNumber}-index.html`;
}

function automatedCoverageState(text: string):
  | "ambiguous"
  | "missing_qa"
  | "qualifying_candidate"
  | "release_only" {
  const lower = text.toLowerCase();
  const hasQuestionAndAnswer =
    /\bquestions?\s*(?:and|&)\s*answers?\b/u.test(lower) ||
    /\bquestion-and-answer\b/u.test(lower) ||
    /\bq\s*&\s*a\b/u.test(lower);
  const hasPreparedRemarks =
    /\bprepared remarks?\b/u.test(lower) ||
    (/\boperator\b/u.test(lower) && /\bchief (?:executive|financial) officer\b/u.test(lower));
  const looksLikeRelease =
    /\b(?:condensed consolidated statements|balance sheets|financial highlights)\b/u.test(lower) &&
    !/\boperator\b/u.test(lower);
  if (looksLikeRelease) return "release_only";
  if (hasPreparedRemarks && hasQuestionAndAnswer) return "qualifying_candidate";
  if (hasPreparedRemarks) return "missing_qa";
  return "ambiguous";
}

function fileExtension(document: FilingDocument, contentType: string): string {
  const extension = /\.(html?|txt)$/iu.exec(document.document)?.[1]?.toLowerCase();
  if (extension === "htm" || extension === "html") return "html";
  if (extension === "txt") return "txt";
  if (/\.pdf$/iu.test(document.document) || contentType.toLowerCase().includes("pdf")) return "pdf";
  if (contentType.toLowerCase().includes("html")) return "html";
  return "txt";
}

async function auditIssuer(input: {
  readonly issuer: CohortIssuer;
  readonly outputDirectory: string;
}) {
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${input.issuer.cik}.json`;
  const submissionsResponse = await rateLimitedFetch(
    submissionsUrl,
    MAXIMUM_SUBMISSIONS_BYTES,
    "https://data.sec.gov",
  );
  const submissions = submissionsSchema.parse(JSON.parse(decode(submissionsResponse.body)));
  if (submissions.cik.padStart(10, "0") !== input.issuer.cik) {
    throw new Error(`issuer_identity_mismatch:${input.issuer.ticker}`);
  }

  const reviewedFilings = [];
  const rankedCandidates: Array<{
    readonly document: FilingDocument;
    readonly filing: FilingCandidate;
    readonly indexUrl: string;
    readonly rank: number;
  }> = [];
  for (const filing of filingCandidates(submissions.filings.recent)) {
    const filingIndexUrl = indexUrl(input.issuer.cik, filing.accessionNumber);
    const indexResponse = await rateLimitedFetch(
      filingIndexUrl,
      MAXIMUM_INDEX_BYTES,
      "https://www.sec.gov",
    );
    const documents = parseFilingDocuments(decode(indexResponse.body), filingIndexUrl);
    const candidates = documents
      .map((document) => ({ document, rank: documentRank(document) }))
      .filter((candidate): candidate is { document: FilingDocument; rank: number } => candidate.rank !== null);
    reviewedFilings.push({
      ...filing,
      candidateDocumentCount: candidates.length,
      indexDigest: sha256(indexResponse.body),
      indexUrl: filingIndexUrl,
    });
    rankedCandidates.push(...candidates.map(({ document, rank }) => ({
      document,
      filing,
      indexUrl: filingIndexUrl,
      rank,
    })));
  }

  rankedCandidates.sort((left, right) =>
    left.rank - right.rank ||
    right.filing.acceptanceDateTime.localeCompare(left.filing.acceptanceDateTime),
  );
  const selected = rankedCandidates.slice(0, MAXIMUM_CANDIDATES_PER_ISSUER);
  const candidateDirectory = resolve(input.outputDirectory, "candidates", input.issuer.ticker);
  await mkdir(candidateDirectory, { recursive: true });
  const candidates = [];
  for (const candidate of selected) {
    try {
      const response = await rateLimitedFetch(
        candidate.document.url,
        MAXIMUM_EXHIBIT_BYTES,
        "https://www.sec.gov",
      );
      const contentType = response.contentType.split(";", 1)[0]!.trim().toLowerCase();
      const text = contentType.includes("pdf") ||
          (response.body[0] === 0x25 && response.body[1] === 0x50 && response.body[2] === 0x44 && response.body[3] === 0x46)
        ? await extractPdfText(response.body)
        : textContent(decode(response.body));
      const extension = fileExtension(candidate.document, contentType);
      const retainedFile = `${candidate.filing.accessionNumber}-${candidate.document.sequence}.${extension}`;
      await writeFile(resolve(candidateDirectory, retainedFile), response.body);
      candidates.push({
        accessionNumber: candidate.filing.accessionNumber,
        acceptanceDateTime: candidate.filing.acceptanceDateTime,
        automatedCoverageState: automatedCoverageState(text),
        byteCount: response.body.byteLength,
        contentDigest: sha256(response.body),
        contentType,
        description: candidate.document.description,
        document: candidate.document.document,
        filingDate: candidate.filing.filingDate,
        filingType: candidate.document.filingType,
        form: candidate.filing.form,
        humanReview: null,
        indexUrl: candidate.indexUrl,
        reportDate: candidate.filing.reportDate,
        retainedFile: `candidates/${input.issuer.ticker}/${retainedFile}`,
        sourceUrl: candidate.document.url,
      });
    } catch (error) {
      const code = error instanceof Error && error.message.includes("too large")
        ? "oversized"
        : "fetch_failed";
      candidates.push({
        accessionNumber: candidate.filing.accessionNumber,
        acceptanceDateTime: candidate.filing.acceptanceDateTime,
        automatedCoverageState: code,
        byteCount: null,
        contentDigest: null,
        contentType: null,
        description: candidate.document.description,
        document: candidate.document.document,
        filingDate: candidate.filing.filingDate,
        filingType: candidate.document.filingType,
        form: candidate.filing.form,
        humanReview: null,
        indexUrl: candidate.indexUrl,
        reportDate: candidate.filing.reportDate,
        retainedFile: null,
        sourceUrl: candidate.document.url,
      });
    }
  }

  return Object.freeze({
    candidates,
    cik: input.issuer.cik,
    companyName: submissions.name,
    exchange: input.issuer.exchange,
    fiscalYearEnd: submissions.fiscalYearEnd ?? null,
    reviewedFilings,
    sector: input.issuer.sector,
    sicDescription: submissions.sicDescription ?? null,
    ticker: input.issuer.ticker,
  });
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.env.EVE_EARNINGS_LIVE_SOURCE_AUDIT !== "1") {
  throw new Error("live_source_audit_not_authorized");
}
if (!process.env.SEC_USER_AGENT) {
  throw new Error("SEC_USER_AGENT is required for the live source audit");
}

const cohortPath = resolve(
  argument("--cohort") ?? "scripts/fixtures/earnings-call-changes/issuer-cohort.json",
);
const outputDirectory = resolve(argument("--output-dir") ?? ".tmp/earnings-call-source-audit");
const cohort = cohortSchema.parse(JSON.parse(await readFile(cohortPath, "utf8")));
await mkdir(outputDirectory, { recursive: true });

const tickerExchangeUrl = "https://www.sec.gov/files/company_tickers_exchange.json";
const tickerExchangeResponse = await rateLimitedFetch(
  tickerExchangeUrl,
  MAXIMUM_SUBMISSIONS_BYTES,
  "https://www.sec.gov",
);
const tickerExchange = companyTickerExchangeSchema.parse(
  JSON.parse(decode(tickerExchangeResponse.body)),
);
const publicIssuerKeys = new Set(tickerExchange.data.flatMap(([cik, _name, ticker, exchange]) =>
  exchange === null
    ? []
    : [`${String(cik).padStart(10, "0")}:${ticker}:${exchange.toLowerCase()}`],
));
for (const issuer of cohort.issuers) {
  const key = `${issuer.cik}:${issuer.ticker}:${issuer.exchange.toLowerCase()}`;
  if (!publicIssuerKeys.has(key)) throw new Error(`issuer_catalog_mismatch:${issuer.ticker}`);
}

const issuers = [];
for (const issuer of cohort.issuers) {
  issuers.push(await auditIssuer({ issuer, outputDirectory }));
}

const auditCore = {
  auditBounds: {
    maximumCandidatesPerIssuer: MAXIMUM_CANDIDATES_PER_ISSUER,
    maximumExhibitBytes: MAXIMUM_EXHIBIT_BYTES,
    maximumFilingsPerIssuer: MAXIMUM_FILINGS_PER_ISSUER,
    maximumIndexBytes: MAXIMUM_INDEX_BYTES,
    maximumPdfPages: MAXIMUM_PDF_PAGES,
    maximumPdfTextCharacters: MAXIMUM_PDF_TEXT_CHARACTERS,
    maximumSubmissionsBytes: MAXIMUM_SUBMISSIONS_BYTES,
    minimumRequestIntervalMs: MINIMUM_REQUEST_INTERVAL_MS,
  },
  cohortDigest: sha256(await readFile(cohortPath)),
  cohortId: cohort.cohortId,
  cohortVersion: cohort.cohortVersion,
  issuerCatalogDigest: sha256(tickerExchangeResponse.body),
  issuerCatalogUrl: tickerExchangeUrl,
  issuers,
  recordType: "earnings_call_source_viability_audit",
  schemaVersion: 1,
};
const audit = {
  ...auditCore,
  auditDigest: sha256(JSON.stringify(auditCore)),
};
await writeFile(
  resolve(outputDirectory, "audit.json"),
  `${JSON.stringify(audit, null, 2)}\n`,
  "utf8",
);

const qualifyingCandidates = issuers.reduce(
  (count, issuer) => count + issuer.candidates.filter(
    ({ automatedCoverageState }) => automatedCoverageState === "qualifying_candidate",
  ).length,
  0,
);
process.stdout.write(JSON.stringify({
  auditDigest: audit.auditDigest,
  issuerCount: issuers.length,
  outputDirectory,
  qualifyingCandidates,
}, null, 2) + "\n");
