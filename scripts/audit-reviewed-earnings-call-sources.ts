import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { resolve } from "node:path";

import { z } from "zod";

const MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DISCOVERY_BYTES = 2 * 1024 * 1024;
const MAXIMUM_REDIRECTS = 3;
const MAXIMUM_PDF_PAGES = 128;
const MAXIMUM_PDF_TEXT_CHARACTERS = 500_000;
const FETCH_TIMEOUT_MS = 20_000;
const REVIEWED_ORIGINS = new Set([
  "https://investor.atmeta.com",
  "https://investors.fedex.com",
  "https://investors.thewaltdisneycompany.com",
  "https://s21.q4cdn.com",
  "https://s206.q4cdn.com",
  "https://www.jpmorganchase.com",
  "https://www.microsoft.com",
]);

const endpointSchema = z.object({
  mediaType: z.enum(["application/pdf", "text/html"]).optional(),
  origin: z.string().url().regex(/^https:\/\//u),
  pathPattern: z.string().min(1).max(500),
}).strict();

const manifestSchema = z.object({
  families: z.array(z.object({
    artifact: endpointSchema,
    cik: z.string().regex(/^\d{10}$/u),
    discovery: endpointSchema.omit({ mediaType: true }),
    events: z.array(z.object({
      artifactUrl: z.string().url(),
      callDate: z.string().date(),
      discoveryEvidence: z.enum(["direct_link", "reviewed_path_template"]),
      discoveryUrl: z.string().url(),
      fiscalPeriod: z.string().regex(/^FY\d{4}-Q[1-4]$/u),
      role: z.enum(["current", "prior"]),
    }).strict()).length(2),
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
  }).strict()).min(5).max(12),
  recordType: z.literal("earnings_call_reviewed_public_source_families"),
  schemaVersion: z.literal(1),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.families.map(({ cik }) => cik)).size !== manifest.families.length) {
    context.addIssue({ code: "custom", message: "duplicate_issuer" });
  }
  if (new Set(manifest.families.map(({ sector }) => sector)).size < 3) {
    context.addIssue({ code: "custom", message: "insufficient_sector_coverage" });
  }
  for (const [index, family] of manifest.families.entries()) {
    if (new Set(family.events.map(({ role }) => role)).size !== 2) {
      context.addIssue({ code: "custom", message: "current_and_prior_required", path: ["families", index, "events"] });
    }
  }
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertAllowlistedUrl(urlValue: string, endpoint: z.infer<typeof endpointSchema>): URL {
  const url = new URL(urlValue);
  if (
    url.origin !== endpoint.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !new RegExp(endpoint.pathPattern, "u").test(url.pathname)
  ) {
    throw new Error(`source_url_outside_reviewed_family:${urlValue}`);
  }
  return url;
}

async function fetchReviewedSource(
  requestedUrl: string,
  maximumBytes: number,
  endpoint: z.infer<typeof endpointSchema>,
) {
  if (!REVIEWED_ORIGINS.has(endpoint.origin)) throw new Error("unreviewed_source_origin");
  let url = assertAllowlistedUrl(requestedUrl, endpoint);
  for (let redirect = 0; redirect <= MAXIMUM_REDIRECTS; redirect += 1) {
    const response = await new Promise<{
      body: Uint8Array;
      contentType: string;
      location: string | undefined;
      status: number;
    }>((resolveResponse, rejectResponse) => {
      const outgoing = request(url, {
        headers: {
          accept: "application/pdf,text/html;q=0.9,*/*;q=0.1",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 (compatible; EveSourceAudit/1.0; +https://eve.dev)",
        },
        method: "GET",
      }, (incoming) => {
        const status = incoming.statusCode ?? 0;
        const location = incoming.headers.location;
        if (status >= 300 && status < 400) {
          incoming.resume();
          resolveResponse({ body: new Uint8Array(), contentType: "", location, status });
          return;
        }
        const declaredLength = Number(incoming.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
          incoming.destroy(new Error("source_response_oversized"));
          return;
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        incoming.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maximumBytes) incoming.destroy(new Error("source_response_oversized"));
          else chunks.push(chunk);
        });
        incoming.on("end", () => resolveResponse({
          body: new Uint8Array(Buffer.concat(chunks)),
          contentType: String(incoming.headers["content-type"] ?? ""),
          location,
          status,
        }));
        incoming.on("error", rejectResponse);
      });
      outgoing.setTimeout(FETCH_TIMEOUT_MS, () => outgoing.destroy(new Error("source_fetch_timeout")));
      outgoing.on("error", rejectResponse);
      outgoing.end();
    });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || redirect === MAXIMUM_REDIRECTS) throw new Error("invalid_source_redirect");
      url = assertAllowlistedUrl(new URL(response.location, url).toString(), endpoint);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`source_http_${response.status}`);
    return Object.freeze({
      body: response.body,
      contentType: response.contentType,
      finalUrl: url.toString(),
    });
  }
  throw new Error("source_redirect_limit_exceeded");
}

function htmlText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/\s+/gu, " ")
    .trim();
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

async function pdfText(bytes: Uint8Array): Promise<{ pageCount: number; text: string }> {
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  let characters = 0;
  try {
    if (document.numPages > MAXIMUM_PDF_PAGES) throw new Error("pdf_page_limit_exceeded");
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").join(" ");
      characters += text.length;
      if (characters > MAXIMUM_PDF_TEXT_CHARACTERS) throw new Error("pdf_text_limit_exceeded");
      pages.push(text);
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { pageCount: pages.length, text: pages.join("\n") };
}

function transcriptSignals(text: string) {
  const normalized = text.replace(/\s+/gu, " ").toLowerCase();
  const speakerLabelCount = (text.match(/\b[A-Z][A-Z .'-]{3,50}:/gu) ?? []).length;
  const hasPreparedRemarks =
    /\bprepared remarks?\b/u.test(normalized) ||
    (/\bjoining me today\b/u.test(normalized) && /\bturn (?:the )?(?:call )?over\b/u.test(normalized)) ||
    (/\boperator\b/u.test(normalized) && /\b(?:chief executive officer|chairman and ceo|president and ceo)\b/u.test(normalized));
  const hasQuestionAndAnswer =
    /\bquestions?\s*(?:and|&)\s*answers?\b/u.test(normalized) ||
    /\bquestion-and-answer\b/u.test(normalized) ||
    /\bq\s*&\s*a\b/u.test(normalized) ||
    /\bwe(?:'re| are) now ready to take (?:your )?questions\b/u.test(normalized);
  const hasSpeakerStructure =
    (/\boperator\b/u.test(normalized) && /\banalyst\b/u.test(normalized)) ||
    speakerLabelCount >= 3;
  return Object.freeze({
    characterCount: text.length,
    hasPreparedRemarks,
    hasQuestionAndAnswer,
    hasSpeakerStructure,
    qualifying: hasPreparedRemarks && hasQuestionAndAnswer,
    speakerLabelCount,
  });
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

if (process.env.EVE_EARNINGS_LIVE_SOURCE_AUDIT !== "1") {
  throw new Error("live_source_audit_not_authorized");
}

const manifestPath = resolve(
  argument("--manifest") ?? "scripts/fixtures/earnings-call-changes/reviewed-public-source-families.json",
);
const cohortPath = resolve(
  argument("--cohort") ?? "scripts/fixtures/earnings-call-changes/issuer-cohort.json",
);
const outputPath = resolve(argument("--output") ?? ".tmp/reviewed-earnings-call-source-audit.json");
const manifestBytes = await readFile(manifestPath);
const cohortBytes = await readFile(cohortPath);
const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
const cohortIssuerCiks = new Set(z.object({
  issuers: z.array(z.object({ cik: z.string().regex(/^\d{10}$/u) }).passthrough()).length(50),
}).passthrough().parse(JSON.parse(cohortBytes.toString("utf8"))).issuers.map(({ cik }) => cik));
if (manifest.families.some(({ cik }) => !cohortIssuerCiks.has(cik))) {
  throw new Error("reviewed_family_outside_audited_cohort");
}
const auditedFamilies = [];

for (const family of manifest.families) {
  const events = [];
  for (const event of family.events) {
    let discovery;
    let artifact;
    try {
      assertAllowlistedUrl(event.discoveryUrl, family.discovery);
      assertAllowlistedUrl(event.artifactUrl, family.artifact);
      discovery = await fetchReviewedSource(
        event.discoveryUrl,
        MAXIMUM_DISCOVERY_BYTES,
        family.discovery,
      );
      assertAllowlistedUrl(discovery.finalUrl, family.discovery);
      artifact = await fetchReviewedSource(
        event.artifactUrl,
        MAXIMUM_ARTIFACT_BYTES,
        family.artifact,
      );
    } catch (error) {
      throw new Error(
        `source_fetch_failed:${family.ticker}:${event.role}:${error instanceof Error ? error.message : "unknown"}`,
        { cause: error },
      );
    }
    assertAllowlistedUrl(artifact.finalUrl, family.artifact);
    if (event.discoveryEvidence === "direct_link" && event.discoveryUrl !== event.artifactUrl) {
      const discoveryText = new TextDecoder("utf-8", { fatal: false }).decode(discovery.body);
      const artifactPath = new URL(event.artifactUrl).pathname;
      const artifactFilename = artifactPath.split("/").at(-1)!;
      if (!discoveryText.includes(event.artifactUrl) &&
          !discoveryText.includes(artifactPath) &&
          !discoveryText.includes(artifactFilename)) {
        throw new Error(`discovery_artifact_link_missing:${family.ticker}:${event.role}`);
      }
    }
    const contentType = artifact.contentType.split(";", 1)[0]!.trim().toLowerCase();
    if (contentType !== family.artifact.mediaType) {
      throw new Error(`unexpected_media_type:${family.ticker}:${event.role}:${contentType}`);
    }
    const extracted = contentType === "application/pdf"
      ? await pdfText(artifact.body)
      : { pageCount: null, text: htmlText(artifact.body) };
    const signals = transcriptSignals(extracted.text);
    if (!signals.qualifying) {
      throw new Error(`non_qualifying_transcript:${family.ticker}:${event.role}:${JSON.stringify(signals)}`);
    }
    events.push({
      ...event,
      artifactByteCount: artifact.body.byteLength,
      artifactDigest: sha256(artifact.body),
      contentType,
      discoveryByteCount: discovery.body.byteLength,
      discoveryDigest: sha256(discovery.body),
      finalArtifactUrl: artifact.finalUrl,
      finalDiscoveryUrl: discovery.finalUrl,
      pageCount: extracted.pageCount,
      signals,
    });
  }
  auditedFamilies.push({
    cik: family.cik,
    events,
    sector: family.sector,
    ticker: family.ticker,
  });
}

const auditCore = {
  bounds: {
    maximumArtifactBytes: MAXIMUM_ARTIFACT_BYTES,
    maximumDiscoveryBytes: MAXIMUM_DISCOVERY_BYTES,
    maximumPdfPages: MAXIMUM_PDF_PAGES,
    maximumPdfTextCharacters: MAXIMUM_PDF_TEXT_CHARACTERS,
  },
  cohortDigest: sha256(cohortBytes),
  familyCount: auditedFamilies.length,
  families: auditedFamilies,
  manifestDigest: sha256(manifestBytes),
  qualifyingPairCount: auditedFamilies.filter(({ events }) => events.every(({ signals }) => signals.qualifying)).length,
  recordType: "earnings_call_reviewed_public_source_audit",
  schemaVersion: 1,
  sectorCount: new Set(auditedFamilies.map(({ sector }) => sector)).size,
};
const audit = { ...auditCore, auditDigest: sha256(JSON.stringify(auditCore)) };
await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  auditDigest: audit.auditDigest,
  familyCount: audit.familyCount,
  outputPath,
  qualifyingPairCount: audit.qualifyingPairCount,
  sectorCount: audit.sectorCount,
}, null, 2)}\n`);
