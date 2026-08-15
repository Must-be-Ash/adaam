import { createHash } from "node:crypto";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

import type { WorkspaceCapabilityManifestValue } from "./workspace-state-store";
import { SEC_IPO_NORMALIZER_VERSION } from "./workspace-finding-facts";
export const EVALUATE_SEC_IPO_SOURCE_TOOL_ID = "evaluate_sec_ipo_source";
export const SEC_IPO_SOURCE_ID = "sec-latest-s1-filings";
export const SEC_IPO_SOURCE_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom";
export const STAGE_WORKSPACE_ALERT_TOOL_ID = "stage_workspace_alert";
export { SEC_IPO_NORMALIZER_VERSION } from "./workspace-finding-facts";

const MAX_ATOM_BYTES = 2 * 1_024 * 1_024;
const MAX_ENTRIES = 100;
const timestampSchema = z.string().datetime({ offset: true });
const filingSchema = z.object({
  accessionNumber: z.string().regex(/^\d{10}-\d{2}-\d{6}$/u),
  canonicalFilingUrl: z.string().url().max(2_048),
  cik: z.string().regex(/^\d{10}$/u),
  classification: z.enum(["amendment", "new_registration"]),
  companyName: z.string().min(1).max(300),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  dedupeKey: z.string().max(64),
  fileNumber: z.string().max(80).nullable(),
  formType: z.enum(["S-1", "S-1/A"]),
  normalizerVersion: z.literal(SEC_IPO_NORMALIZER_VERSION),
  observedAt: timestampSchema,
  publishedAt: timestampSchema.nullable(),
  registrationKey: z.string().max(128),
  updatedAt: timestampSchema,
}).strict();

export type SecIpoFiling = z.infer<typeof filingSchema>;

export interface SecIpoAtomPage {
  readonly contentHash: string;
  readonly filings: readonly SecIpoFiling[];
  readonly normalizerVersion: typeof SEC_IPO_NORMALIZER_VERSION;
  readonly observedAt: string;
  readonly sourceId: typeof SEC_IPO_SOURCE_ID;
  readonly sourceUrl: typeof SEC_IPO_SOURCE_URL;
}

export class SecIpoNormalizerError extends Error {
  readonly code:
    | "sec_atom_incomplete"
    | "sec_atom_invalid"
    | "sec_atom_oversized";

  constructor(code: SecIpoNormalizerError["code"]) {
    super(code);
    this.code = code;
    this.name = "SecIpoNormalizerError";
  }
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim() || null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const key of ["#text", "__cdata"]) {
    const nested = Reflect.get(value, key);
    if (typeof nested === "string" || typeof nested === "number") {
      return String(nested).trim() || null;
    }
  }
  return null;
}

function decodedText(value: unknown): string {
  return (text(value) ?? "")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;/giu, "'")
    .replace(/&amp;/giu, "&")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function atomLink(value: unknown): string | null {
  const links = array(value);
  const preferred = links.find((link) =>
    typeof link === "object" &&
    link !== null &&
    [undefined, "alternate"].includes(Reflect.get(link, "@_rel") as undefined | string),
  ) ?? links[0];
  if (typeof preferred === "string") return preferred;
  if (typeof preferred !== "object" || preferred === null) return null;
  return text(Reflect.get(preferred, "@_href"));
}

function categoryTerm(value: unknown): string | null {
  for (const category of array(value)) {
    if (typeof category === "object" && category !== null) {
      const term = text(Reflect.get(category, "@_term"));
      if (term === "S-1" || term === "S-1/A") return term;
    }
  }
  return null;
}

function requiredTimestamp(value: unknown): string {
  const candidate = text(value);
  const parsed = candidate ? Date.parse(candidate) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new SecIpoNormalizerError("sec_atom_incomplete");
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) throw new SecIpoNormalizerError("sec_atom_invalid");
  return new Date(parsed).toISOString();
}

function canonicalFilingUrl(value: unknown): URL {
  const raw = atomLink(value);
  if (!raw) throw new SecIpoNormalizerError("sec_atom_incomplete");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "www.sec.gov" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/Archives\/edgar\/data\/\d+\/\d{18}\/[A-Za-z0-9_.-]+-index\.html?$/u.test(url.pathname) ||
    url.toString() !== raw
  ) {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  return url;
}

function normalizeEntry(entry: unknown, observedAt: string): SecIpoFiling | null {
  if (typeof entry !== "object" || entry === null) {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  const formType = categoryTerm(Reflect.get(entry, "category"));
  if (formType === null) return null;
  const title = decodedText(Reflect.get(entry, "title"));
  const cikMatch = /\((\d{1,10})\)(?:\s+\([^)]+\))*\s*$/u.exec(title);
  const companyName = title
    .replace(/^S-1(?:\/A)?\s*-\s*/u, "")
    .replace(/\s+\(\d{1,10}\)(?:\s+\([^)]+\))*\s*$/u, "")
    .trim();
  if (!cikMatch || !companyName) throw new SecIpoNormalizerError("sec_atom_incomplete");
  const cik = cikMatch[1]!.padStart(10, "0");
  const url = canonicalFilingUrl(Reflect.get(entry, "link"));
  const pathMatch = /^\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//u.exec(url.pathname);
  if (!pathMatch || pathMatch[1]!.replace(/^0+/u, "") !== cik.replace(/^0+/u, "")) {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  const summary = decodedText(Reflect.get(entry, "summary"));
  const id = text(Reflect.get(entry, "id")) ?? "";
  const accession =
    /accession-number=(\d{10}-\d{2}-\d{6})/iu.exec(id)?.[1] ??
    /(\d{10}-\d{2}-\d{6})/u.exec(summary)?.[1];
  if (!accession || accession.replaceAll("-", "") !== pathMatch[2]) {
    throw new SecIpoNormalizerError("sec_atom_incomplete");
  }
  const fileNumber = /\bFile\s+(?:No\.?|Number)\s*:\s*([A-Za-z0-9-]{3,80})/iu.exec(summary)?.[1] ?? null;
  const updatedAt = requiredTimestamp(Reflect.get(entry, "updated"));
  const publishedAt = optionalTimestamp(Reflect.get(entry, "published"));
  const core = {
    accessionNumber: accession,
    canonicalFilingUrl: url.toString(),
    cik,
    classification: formType === "S-1" ? "new_registration" as const : "amendment" as const,
    companyName,
    fileNumber,
    formType,
    publishedAt,
    updatedAt,
  };
  return filingSchema.parse({
    ...core,
    contentHash: createHash("sha256").update(JSON.stringify(core)).digest("hex"),
    dedupeKey: `${accession}:${formType}`,
    normalizerVersion: SEC_IPO_NORMALIZER_VERSION,
    observedAt,
    registrationKey: `${cik}:${fileNumber ?? accession}`,
  });
}

export function normalizeSecIpoAtom(
  xml: string,
  options: { observedAt: string },
): SecIpoAtomPage {
  if (Buffer.byteLength(xml, "utf8") > MAX_ATOM_BYTES) {
    throw new SecIpoNormalizerError("sec_atom_oversized");
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  const observedAt = requiredTimestamp(options.observedAt);
  const document = new XMLParser({
    attributeNamePrefix: "@_",
    cdataPropName: "__cdata",
    htmlEntities: false,
    ignoreAttributes: false,
    maxNestedTags: 40,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
    removeNSPrefix: true,
    strictReservedNames: true,
    trimValues: true,
  }).parse(xml) as unknown;
  const feed = typeof document === "object" && document !== null
    ? Reflect.get(document, "feed")
    : null;
  if (typeof feed !== "object" || feed === null) {
    throw new SecIpoNormalizerError("sec_atom_invalid");
  }
  const entries = array(Reflect.get(feed, "entry"));
  if (entries.length > MAX_ENTRIES) throw new SecIpoNormalizerError("sec_atom_oversized");
  const filings = new Map<string, SecIpoFiling>();
  for (const entry of entries) {
    const filing = normalizeEntry(entry, observedAt);
    if (!filing) continue;
    const existing = filings.get(filing.dedupeKey);
    if (existing && existing.contentHash !== filing.contentHash) {
      throw new SecIpoNormalizerError("sec_atom_invalid");
    }
    filings.set(filing.dedupeKey, existing ?? filing);
  }
  const contentHash = createHash("sha256").update(xml).digest("hex");
  return Object.freeze({
    contentHash,
    filings: Object.freeze([...filings.values()]
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.dedupeKey.localeCompare(right.dedupeKey))
      .map((filing) => Object.freeze(filing))),
    normalizerVersion: SEC_IPO_NORMALIZER_VERSION,
    observedAt,
    sourceId: SEC_IPO_SOURCE_ID,
    sourceUrl: SEC_IPO_SOURCE_URL,
  });
}

export const IPO_FILINGS_CAPABILITY_MANIFEST = Object.freeze({
  connectionIds: [],
  controlPlaneToolIds: [EVALUATE_SEC_IPO_SOURCE_TOOL_ID],
  financialToolIds: [],
  hardDeniedCapabilityIds: [
    "bash",
    "coinbase_create_order",
    "coinbase_mcp",
    "filesystem.read",
    "filesystem.write",
    "glob",
    "grep",
    "masterkey_mcp",
    "private.history",
    "read_file",
    "session.manager",
    "todo",
    "web.search",
    "web_fetch",
    "web_search",
    "write_file",
  ],
  maximumDataAccessClassification: "public",
  paidResearchAllowed: false,
  providerTools: [],
  researchToolIds: [],
  skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
  sources: [{ origin: "https://www.sec.gov", sourceId: SEC_IPO_SOURCE_ID }],
  workerModelPolicy: {
    allowedModelIds: ["google/gemini-3.6-flash"],
    maximumOutputTokens: 2_000,
  },
} satisfies WorkspaceCapabilityManifestValue);
