import { createHash } from "node:crypto";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  assertScheduledSourceAllowed,
  markScheduledSourceSuccess,
  reserveScheduledSourceAttempt,
} from "../lib/event-trigger-store";
import {
  getPublicFeed,
  type PublicFeedFormat,
} from "../lib/public-feeds";
import {
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "../lib/workspace-source-coverage";
import { authorizeWorkspaceWorkerStore } from "../lib/workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "../lib/workspace-worker-auth";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 20_000;

interface NormalizedFeedItem {
  id: string | null;
  title: string;
  url: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  summary: string | null;
}

function publicGovernmentUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(hostname === "gov" || hostname.endsWith(".gov"))
  ) {
    throw new Error(
      "fetch_public_source accepts only official HTTPS .gov URLs. Use web_fetch for an issuer IR URL.",
    );
  }
  return url;
}

function requestHeaders(url: URL): HeadersInit {
  const secUserAgent = process.env.SEC_USER_AGENT;
  if (url.hostname.toLowerCase().endsWith("sec.gov") && !secUserAgent) {
    throw new Error(
      "SEC_USER_AGENT must be configured before fetching an SEC feed.",
    );
  }

  return {
    accept:
      "application/atom+xml, application/rss+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.2",
    "user-agent":
      secUserAgent ?? "EarningsCallAnalyser/0.1 public-feed-monitor",
  };
}

async function fetchOfficialSource(
  initialUrl: URL,
): Promise<{ response: Response; finalUrl: URL }> {
  let url = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      headers: requestHeaders(url),
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) {
        throw new Error("The public source returned an invalid redirect.");
      }
      url = publicGovernmentUrl(new URL(location, url).toString());
      continue;
    }

    const openFdaNoMatchCandidate =
      response.status === 404 &&
      url.hostname.toLowerCase() === "api.fda.gov";
    if (!response.ok && !openFdaNoMatchCandidate) {
      throw new Error(`The public source returned HTTP ${response.status}.`);
    }
    return { response, finalUrl: url };
  }

  throw new Error("The public source exceeded the redirect limit.");
}

async function readLimitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("The public source response is too large.");
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The public source response is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim() || null;
  }
  if (typeof value !== "object" || value === null) return null;

  for (const key of ["#text", "__cdata", "value"]) {
    const nested = Reflect.get(value, key);
    if (typeof nested === "string" || typeof nested === "number") {
      return String(nested).trim() || null;
    }
  }
  return null;
}

function cleanText(value: unknown, maxLength: number): string | null {
  const text = asText(value);
  if (!text) return null;
  const cleaned = text
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
      (_match, hex: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
        return Number.isSafeInteger(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "";
      },
    )
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizedDate(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function rssLink(value: unknown): string | null {
  const text = asText(value);
  if (text) return text;
  if (typeof value !== "object" || value === null) return null;
  return asText(Reflect.get(value, "@_href"));
}

function atomLink(value: unknown): string | null {
  const links = asArray(value);
  const preferred =
    links.find((link) => {
      if (typeof link !== "object" || link === null) return false;
      const rel = asText(Reflect.get(link, "@_rel"));
      return rel === null || rel === "alternate";
    }) ?? links[0];
  return rssLink(preferred);
}

function parseRss(document: unknown): {
  title: string | null;
  items: NormalizedFeedItem[];
} {
  if (typeof document !== "object" || document === null) {
    throw new Error("The public source did not return an RSS document.");
  }
  const rss = Reflect.get(document, "rss");
  const channel =
    typeof rss === "object" && rss !== null
      ? Reflect.get(rss, "channel")
      : undefined;
  if (typeof channel !== "object" || channel === null) {
    throw new Error("The public source did not return an RSS channel.");
  }

  return {
    title: cleanText(Reflect.get(channel, "title"), 500),
    items: asArray(Reflect.get(channel, "item")).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const url = rssLink(Reflect.get(item, "link"));
      const id = asText(Reflect.get(item, "guid")) ?? url;
      return [
        {
          id,
          title: cleanText(Reflect.get(item, "title"), 500) ?? "(untitled)",
          url,
          publishedAt: normalizedDate(
            Reflect.get(item, "pubDate") ?? Reflect.get(item, "date"),
          ),
          updatedAt: normalizedDate(Reflect.get(item, "updated")),
          summary: cleanText(
            Reflect.get(item, "description") ??
              Reflect.get(item, "encoded") ??
              Reflect.get(item, "summary"),
            2_000,
          ),
        },
      ];
    }),
  };
}

function parseAtom(document: unknown): {
  title: string | null;
  items: NormalizedFeedItem[];
} {
  if (typeof document !== "object" || document === null) {
    throw new Error("The public source did not return an Atom document.");
  }
  const feed = Reflect.get(document, "feed");
  if (typeof feed !== "object" || feed === null) {
    throw new Error("The public source did not return an Atom feed.");
  }

  return {
    title: cleanText(Reflect.get(feed, "title"), 500),
    items: asArray(Reflect.get(feed, "entry")).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const url = atomLink(Reflect.get(entry, "link"));
      return [
        {
          id: asText(Reflect.get(entry, "id")) ?? url,
          title: cleanText(Reflect.get(entry, "title"), 500) ?? "(untitled)",
          url,
          publishedAt: normalizedDate(Reflect.get(entry, "published")),
          updatedAt: normalizedDate(Reflect.get(entry, "updated")),
          summary: cleanText(
            Reflect.get(entry, "summary") ?? Reflect.get(entry, "content"),
            2_000,
          ),
        },
      ];
    }),
  };
}

function parseXmlFeed(
  xml: string,
  expectedFormat: PublicFeedFormat | undefined,
): { format: "rss" | "atom"; title: string | null; items: NormalizedFeedItem[] } {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error("The public source returned invalid XML.");
  }

  const parser = new XMLParser({
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
  });
  const document = parser.parse(xml) as unknown;
  const hasFeed =
    typeof document === "object" &&
    document !== null &&
    Reflect.has(document, "feed");
  const hasRss =
    typeof document === "object" &&
    document !== null &&
    Reflect.has(document, "rss");
  if (expectedFormat === "atom" && !hasFeed) {
    throw new Error("The public source returned RSS or non-feed XML instead of Atom.");
  }
  if (expectedFormat === "rss" && !hasRss) {
    throw new Error("The public source returned Atom or non-feed XML instead of RSS.");
  }
  if (hasFeed) {
    return { format: "atom", ...parseAtom(document) };
  }
  if (hasRss) return { format: "rss", ...parseRss(document) };
  throw new Error("The public source returned XML without an RSS or Atom root.");
}

function eventTimestamp(item: NormalizedFeedItem): number {
  return Date.parse(item.updatedAt ?? item.publishedAt ?? "") || 0;
}

function truncateJson(value: unknown, maxItems: number, depth = 0): unknown {
  if (depth >= 8) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 4_000);
  if (Array.isArray(value)) {
    return value
      .slice(0, maxItems)
      .map((item) => truncateJson(item, maxItems, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, nested]) => [
          key,
          truncateJson(nested, maxItems, depth + 1),
        ]),
    );
  }
  return value;
}

function jsonWouldTruncate(
  value: unknown,
  maxItems: number,
  depth = 0,
): boolean {
  if (depth >= 8) return true;
  if (typeof value === "string") return value.length > 4_000;
  if (Array.isArray(value)) {
    return (
      value.length > maxItems ||
      value.some((item) => jsonWouldTruncate(item, maxItems, depth + 1))
    );
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    return (
      entries.length > 50 ||
      entries.some(([, nested]) =>
        jsonWouldTruncate(nested, maxItems, depth + 1),
      )
    );
  }
  return false;
}

function normalizedJsonPayload(
  value: unknown,
  url: URL,
  status: number,
): unknown {
  if (Array.isArray(value)) {
    if (status >= 400) {
      throw new Error("The public JSON source returned an error response.");
    }
    return value;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The public JSON source returned an unexpected payload.");
  }
  const record = value as Record<string, unknown>;
  const error = record.error;
  if (
    status === 404 &&
    url.hostname.toLowerCase() === "api.fda.gov" &&
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === "NOT_FOUND" &&
    String(Reflect.get(error, "message") ?? "")
      .toLowerCase()
      .includes("no matches")
  ) {
    return { results: [] };
  }
  if (
    status >= 400 ||
    error !== undefined ||
    record.errors !== undefined ||
    record.success === false ||
    (typeof record.status === "number" && record.status >= 400) ||
    (typeof record.status === "string" &&
      /error|fail/iu.test(record.status))
  ) {
    throw new Error("The public JSON source returned an error payload.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "api.fda.gov" && !Array.isArray(record.results)) {
    throw new Error("openFDA returned an unexpected response shape.");
  }
  if (
    hostname === "api.nhtsa.gov" &&
    !Array.isArray(record.Results) &&
    !Array.isArray(record.results)
  ) {
    throw new Error("NHTSA returned an unexpected response shape.");
  }
  return value;
}

const inputSchema = z
  .object({
    sourceId: z.string().trim().min(1).optional(),
    url: z.string().url().max(2_048).optional(),
    expectedFormat: z.enum(["atom", "rss", "json"]).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    maxItems: z.number().int().min(1).max(50).default(20),
  })
  .refine(
    ({ sourceId, url }) => Boolean(sourceId) !== Boolean(url),
    "Provide exactly one of sourceId or url.",
  );

export default defineTool({
  description:
    "Fetch and normalize an official public .gov RSS, Atom, or JSON source with response-size, redirect, timeout, XML-entity, and SEC fair-access safeguards. Use web_fetch for issuer IR HTML or non-.gov sources.",
  inputSchema,
  async execute(input, ctx) {
    const source = input.sourceId
      ? getPublicFeed(input.sourceId)
      : undefined;
    if (input.sourceId && (!source || !source.url)) {
      throw new Error(
        `Source "${input.sourceId}" is unknown or requires a resolved URL.`,
      );
    }

    const initialUrl = publicGovernmentUrl(input.url ?? source?.url ?? "");
    const workerRun =
      ctx.session.auth.current?.authenticator === "workspace-monitor-runtime"
        ? {
            envelope: requireWorkspaceWorkerAuth(ctx),
            scope: authorizeWorkspaceWorkerStore(ctx),
          }
        : null;
    const scheduledScope = workerRun
      ? null
      : await assertScheduledSourceAllowed(ctx, {
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          url: initialUrl.toString(),
        });
    const workspaceSource = workerRun
      ? await authorizeWorkspaceSourceFetch({
          runId: workerRun.envelope.runId,
          scope: workerRun.scope,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          url: initialUrl.toString(),
        })
      : null;
    if (workspaceSource) {
      await reserveWorkspaceSourceAttempt({
        runId: workerRun!.envelope.runId,
        scope: workerRun!.scope,
        sourceId: workspaceSource.sourceId,
      });
    } else {
      await reserveScheduledSourceAttempt(scheduledScope);
    }
    const expectedFormat = input.expectedFormat ?? source?.format;
    if (expectedFormat === "html") {
      throw new Error("Use web_fetch for HTML sources.");
    }

    const { response, finalUrl } = await fetchOfficialSource(initialUrl);
    if (workspaceSource && finalUrl.toString() !== workspaceSource.canonicalUrl) {
      throw new Error("A workspace source redirect crossed the exact configured URL fence.");
    }
    const body = await readLimitedText(response);
    const contentDigest = createHash("sha256").update(body).digest("hex");
    const markSuccess = async (): Promise<void> => {
      if (workspaceSource) {
        await markWorkspaceSourceSuccess({
          contentDigest,
          runId: workerRun!.envelope.runId,
          scope: workerRun!.scope,
          sourceId: workspaceSource.sourceId,
        });
      } else {
        await markScheduledSourceSuccess(scheduledScope);
      }
    };
    const contentType = response.headers.get("content-type") ?? "";
    const looksJson =
      expectedFormat === "json" ||
      contentType.includes("application/json") ||
      body.trimStart().startsWith("{") ||
      body.trimStart().startsWith("[");
    if (
      looksJson &&
      (expectedFormat === "rss" || expectedFormat === "atom")
    ) {
      throw new Error(
        `The public source returned JSON instead of ${expectedFormat.toUpperCase()}.`,
      );
    }

    if (looksJson) {
      if (input.since) {
        throw new Error(
          "The since filter is not supported for JSON sources. Use a date-bounded official API URL instead.",
        );
      }
      const parsedJson = normalizedJsonPayload(
        JSON.parse(body) as unknown,
        finalUrl,
        response.status,
      );
      if (
        scheduledScope &&
        jsonWouldTruncate(parsedJson, input.maxItems)
      ) {
        throw new Error(
          "The JSON source exceeds this run's completeness limit. Narrow or paginate the configured official URL.",
        );
      }
      const result = {
        sourceId: source?.id ?? null,
        sourceUrl: finalUrl.toString(),
        format: "json",
        fetchedAt: new Date().toISOString(),
        data: truncateJson(parsedJson, input.maxItems),
      };
      await markSuccess();
      return result;
    }

    const parsed = parseXmlFeed(body, expectedFormat);
    const windowStartAtMs = workerRun
      ? Date.parse(workerRun.envelope.window.startAt)
      : scheduledScope?.windowStartAtMs;
    const windowEndAtMs = workerRun
      ? Date.parse(workerRun.envelope.window.endAt)
      : scheduledScope?.windowEndAtMs;
    if (
      windowStartAtMs !== undefined &&
      (!input.since || Date.parse(input.since) !== windowStartAtMs)
    ) {
      throw new Error(
        "Scheduled RSS and Atom fetches must use the exact evaluation-window start as since.",
      );
    }
    if (windowEndAtMs !== undefined && parsed.items.some((item) => eventTimestamp(item) === 0)) {
      throw new Error(
        "The feed contains an entry without a parseable timestamp, so this run cannot prove complete window coverage.",
      );
    }
    const sinceTimestamp = input.since ? Date.parse(input.since) : null;
    const matchingItems = parsed.items
      .filter(
        (item) => {
          const timestamp = eventTimestamp(item);
          return (
            (sinceTimestamp === null ||
              timestamp === 0 ||
              timestamp > sinceTimestamp) &&
            (windowEndAtMs === undefined || timestamp <= windowEndAtMs)
          );
        },
      )
      .sort((a, b) => eventTimestamp(b) - eventTimestamp(a));
    if (windowEndAtMs !== undefined && matchingItems.length > input.maxItems) {
      throw new Error(
        "The feed has more in-window items than this run can evaluate completely. Narrow the source or trigger.",
      );
    }
    const items = matchingItems;

    const result = {
      sourceId: source?.id ?? null,
      sourceUrl: finalUrl.toString(),
      format: parsed.format,
      title: parsed.title,
      fetchedAt: new Date().toISOString(),
      items,
      itemCount: items.length,
      caveat:
        items.some(
          (item) => item.publishedAt === null && item.updatedAt === null,
        )
          ? "Some entries have no parseable publication timestamp and were retained."
          : null,
    };
    await markSuccess();
    return result;
  },
});
