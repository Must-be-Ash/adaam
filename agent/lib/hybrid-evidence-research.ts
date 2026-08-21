import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import { z } from "zod";

const MAXIMUM_DOCUMENT_BYTES = 64 * 1_024;
const MAXIMUM_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|credential|key|password|secret|sig(?:nature)?|token)(?:$|[-_])/iu;
const ALLOWED_MEDIA_TYPES = new Set([
  "application/json",
  "application/xhtml+xml",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml",
]);

export const hybridEvidenceResearchDecisionSchema = z.object({
  decision: z.enum(["report_now", "research_needed"]),
  reason: z.string().trim().min(1).max(280),
}).strict();

export type HybridEvidenceResearchDecision = z.infer<
  typeof hybridEvidenceResearchDecisionSchema
>;

export const HYBRID_EVIDENCE_RESEARCH_TOOL_NAMES = Object.freeze([
  "complete_hybrid_evidence_job",
  "decide_hybrid_evidence_research",
  "fetch_hybrid_evidence_research_document",
  "read_hybrid_evidence_bundle",
  "search_hybrid_evidence_research",
] as const);

export type HybridEvidenceResearchToolName =
  (typeof HYBRID_EVIDENCE_RESEARCH_TOOL_NAMES)[number];

export class HybridEvidenceResearchError extends Error {
  constructor(readonly code:
    | "research_destination_denied"
    | "research_document_too_large"
    | "research_fetch_failed"
    | "research_media_type_denied"
    | "research_redirect_denied"
    | "research_url_invalid"
    | "research_url_not_granted") {
    super(code);
    this.name = "HybridEvidenceResearchError";
  }
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce(
    (value, octet) => (value << 8) + Number(octet),
    0,
  ) >>> 0;
}

function inV4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

export function isPublicHybridEvidenceResearchAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedDotted = /^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/u
    .exec(normalized)?.groups?.ipv4;
  const mappedHex = /^::ffff:(?<high>[0-9a-f]{1,4}):(?<low>[0-9a-f]{1,4})$/u
    .exec(normalized)?.groups;
  const ipv4 = mappedHex
    ? ((Number.parseInt(mappedHex.high!, 16) << 16) +
      Number.parseInt(mappedHex.low!, 16)) >>> 0
    : ipv4Number(mappedDotted ?? normalized);
  if (ipv4 !== null) {
    const forbidden: ReadonlyArray<readonly [string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
      ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
      ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
      ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !forbidden.some(([base, prefix]) =>
      inV4Range(ipv4, ipv4Number(base)!, prefix)
    );
  }
  if (isIP(normalized) !== 6) return false;
  return normalized !== "::" && normalized !== "::1" &&
    !/^f[cd]/u.test(normalized) &&
    !/^fe[89ab]/u.test(normalized) &&
    !/^fe[c-f]/u.test(normalized) &&
    !/^ff/u.test(normalized) &&
    !/^2001:db8(?::|$)/u.test(normalized);
}

export function normalizeHybridEvidenceResearchUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HybridEvidenceResearchError("research_url_invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key)) ||
    (isIP(hostname) !== 0 && !isPublicHybridEvidenceResearchAddress(hostname))
  ) {
    throw new HybridEvidenceResearchError("research_url_invalid");
  }
  return url.toString();
}

export function resolveHybridEvidenceResearchToolNames(input: {
  readonly decision: HybridEvidenceResearchDecision["decision"] | null;
  readonly fetchCompleted?: boolean;
  readonly hasGrantedUrls?: boolean;
  readonly researchEnabled: boolean;
  readonly searchCompleted?: boolean;
}): readonly HybridEvidenceResearchToolName[] {
  const base: HybridEvidenceResearchToolName[] = [
    "complete_hybrid_evidence_job",
    "read_hybrid_evidence_bundle",
  ];
  if (!input.researchEnabled) return Object.freeze(base);
  if (input.decision === null) {
    return Object.freeze([
      "decide_hybrid_evidence_research",
      "read_hybrid_evidence_bundle",
    ]);
  }
  if (input.decision === "report_now") return Object.freeze(base);
  const research: HybridEvidenceResearchToolName[] = ["read_hybrid_evidence_bundle"];
  if (!input.searchCompleted) {
    research.push("search_hybrid_evidence_research");
    return Object.freeze(research.sort());
  }
  research.push("complete_hybrid_evidence_job");
  if (input.searchCompleted && input.hasGrantedUrls && !input.fetchCompleted) {
    research.push("fetch_hybrid_evidence_research_document");
  }
  return Object.freeze(research.sort());
}

type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

async function defaultResolveAddresses(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true }))
    .map(({ address }) => address);
}

async function assertPublicDestination(
  url: string,
  resolveAddresses: ResolveAddresses,
  signal: AbortSignal,
): Promise<string> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/gu, "");
  let addresses: readonly string[];
  try {
    addresses = isIP(hostname)
      ? [hostname]
      : await new Promise<readonly string[]>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        resolveAddresses(hostname).then(resolve, reject).finally(() => {
          signal.removeEventListener("abort", onAbort);
        });
      });
  } catch {
    if (signal.aborted) {
      throw new HybridEvidenceResearchError("research_fetch_failed");
    }
    throw new HybridEvidenceResearchError("research_destination_denied");
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicHybridEvidenceResearchAddress(address))
  ) {
    throw new HybridEvidenceResearchError("research_destination_denied");
  }
  return addresses[0]!;
}

export interface PinnedHybridEvidenceResearchRequest {
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly url: string;
}

type PinnedResearchTransport = (
  input: PinnedHybridEvidenceResearchRequest,
) => Promise<Response>;

export function createPinnedHybridEvidenceResearchLookup(
  address: string,
): LookupFunction {
  const family = isIP(address);
  if (
    (family !== 4 && family !== 6) ||
    !isPublicHybridEvidenceResearchAddress(address)
  ) {
    throw new HybridEvidenceResearchError("research_destination_denied");
  }
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

async function defaultPinnedResearchTransport(
  input: PinnedHybridEvidenceResearchRequest,
): Promise<Response> {
  const pinnedLookup = createPinnedHybridEvidenceResearchLookup(input.address);
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(input.url, {
      // A one-request agent prevents reuse of a connection that was not opened
      // through this occurrence's validated and pinned DNS result.
      agent: false,
      headers: input.headers,
      lookup: pinnedLookup,
      method: "GET",
      signal: input.signal,
    }, (incoming) => {
      const status = incoming.statusCode;
      if (status === undefined) {
        incoming.destroy();
        reject(new HybridEvidenceResearchError("research_fetch_failed"));
        return;
      }
      try {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        resolve(new Response(
          Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          { headers, status },
        ));
      } catch {
        incoming.destroy();
        reject(new HybridEvidenceResearchError("research_fetch_failed"));
      }
    });
    request.once("error", reject);
    request.end();
  });
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly byteCount: number; readonly content: string }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HybridEvidenceResearchError("research_document_too_large");
  }
  if (!response.body) return { byteCount: 0, content: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maximumBytes) {
      await reader.cancel();
      throw new HybridEvidenceResearchError("research_document_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { byteCount, content: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

export interface BoundedPublicResearchDocument {
  readonly byteCount: number;
  readonly content: string;
  readonly contentType: string;
  readonly url: string;
}

export function createBoundedPublicDocumentFetcher(options: {
  readonly maximumBytes?: number;
  readonly resolveAddresses?: ResolveAddresses;
  readonly timeoutMs?: number;
  readonly transport?: PinnedResearchTransport;
} = {}): (input: {
  readonly allowedUrls: readonly string[];
  readonly signal?: AbortSignal;
  readonly url: string;
}) => Promise<BoundedPublicResearchDocument> {
  const transport = options.transport ?? defaultPinnedResearchTransport;
  const maximumBytes = options.maximumBytes ?? MAXIMUM_DOCUMENT_BYTES;
  const resolveAddresses = options.resolveAddresses ?? defaultResolveAddresses;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > MAXIMUM_DOCUMENT_BYTES) {
    throw new HybridEvidenceResearchError("research_document_too_large");
  }
  return async (input) => {
    const requestedUrl = normalizeHybridEvidenceResearchUrl(input.url);
    const grants = new Set(input.allowedUrls.map(normalizeHybridEvidenceResearchUrl));
    if (!grants.has(requestedUrl)) {
      throw new HybridEvidenceResearchError("research_url_not_granted");
    }
    let currentUrl = requestedUrl;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
      let pinnedAddress: string;
      try {
        pinnedAddress = await assertPublicDestination(currentUrl, resolveAddresses, signal);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason ?? error;
        throw error;
      }
      let response: Response;
      try {
        response = await transport({
          address: pinnedAddress,
          headers: {
            accept: "text/html, text/plain, application/json, application/xml, text/xml;q=0.9",
            "user-agent": "EveDurableResearch/1.0 public-research-fetch",
          },
          signal,
          url: currentUrl,
        });
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        if (error instanceof HybridEvidenceResearchError) throw error;
        throw new HybridEvidenceResearchError("research_fetch_failed");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirectCount === MAXIMUM_REDIRECTS) {
          throw new HybridEvidenceResearchError("research_redirect_denied");
        }
        let destination: string;
        try {
          destination = normalizeHybridEvidenceResearchUrl(
            new URL(location, currentUrl).toString(),
          );
        } catch {
          throw new HybridEvidenceResearchError("research_redirect_denied");
        }
        if (!grants.has(destination)) {
          throw new HybridEvidenceResearchError("research_redirect_denied");
        }
        currentUrl = destination;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new HybridEvidenceResearchError("research_fetch_failed");
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]!
        .trim()
        .toLowerCase();
      if (!ALLOWED_MEDIA_TYPES.has(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new HybridEvidenceResearchError("research_media_type_denied");
      }
      let body: Awaited<ReturnType<typeof readBoundedText>>;
      try {
        body = await readBoundedText(response, maximumBytes);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        if (error instanceof HybridEvidenceResearchError) throw error;
        throw new HybridEvidenceResearchError("research_fetch_failed");
      }
      return Object.freeze({
        ...body,
        contentType,
        url: currentUrl,
      });
    }
    throw new HybridEvidenceResearchError("research_redirect_denied");
  };
}
