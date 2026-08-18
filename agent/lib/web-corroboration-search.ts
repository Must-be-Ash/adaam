import { z } from "zod";

import {
  digestPublicCommentaryValue,
  publicStatementSchema,
  webCorroborationSearchSchema,
  type PublicStatement,
  type WebCorroborationSearch,
} from "./public-commentary-schema";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const MAX_RESULTS = 5;
const ZERO_COST = Object.freeze({ amountUsd: "0.000000", billableUnits: 0, currency: "USD" as const });

const queryInputSchema = z.object({
  endPublishedAt: z.string().datetime({ offset: true }),
  publicTargetTerms: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  publicTopicTerms: z.array(z.string().trim().min(1).max(80)).max(4),
  startPublishedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((input, context) => {
  const terms = [...input.publicTargetTerms, ...input.publicTopicTerms];
  if (
    input.startPublishedAt >= input.endPublishedAt ||
    terms.some((term) => /(?:https?:\/\/|(?:^|\s)@|\$[A-Z]|\b\d{15,20}\b|api[-_ ]?key|password|secret|token|["“”])/iu.test(term))
  ) context.addIssue({ code: "custom", message: "corroboration_query_forbidden" });
});

export type WebCorroborationQuery = Readonly<{
  endPublishedAt: string;
  query: string;
  queryDigest: string;
  startPublishedAt: string;
}>;

export function compileWebCorroborationQuery(
  value: z.input<typeof queryInputSchema>,
): WebCorroborationQuery {
  const input = queryInputSchema.parse(value);
  const terms = [...new Set([...input.publicTargetTerms, ...input.publicTopicTerms]
    .map((term) => term.replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/gu, " ").trim())
    .filter(Boolean))];
  const query = `${terms.join(" ")} latest material news`;
  if (query.length > 400) throw new Error("corroboration_query_bounds_exceeded");
  return Object.freeze({
    endPublishedAt: input.endPublishedAt,
    query,
    queryDigest: digestPublicCommentaryValue({
      endPublishedAt: input.endPublishedAt,
      query,
      startPublishedAt: input.startPublishedAt,
      version: "1.0.0",
    }),
    startPublishedAt: input.startPublishedAt,
  });
}

export interface WebCorroborationProvider {
  search(input: {
    readonly budgetAuthorized: boolean;
    readonly enabled: boolean;
    readonly now?: Date;
    readonly query: WebCorroborationQuery;
  }): Promise<WebCorroborationSearch>;
}

type WebCorroborationRequest = Parameters<WebCorroborationProvider["search"]>[0];

const exaResponseSchema = z.object({
  costDollars: z.object({ total: z.number().finite().nonnegative().max(10) }).passthrough(),
  requestId: z.string().min(1).max(200),
  results: z.array(z.object({
    author: z.string().trim().min(1).max(200).nullish(),
    id: z.string().min(1).max(2_048),
    publishedDate: z.string().datetime({ offset: true }).nullish(),
    title: z.string().trim().min(1).max(500),
    url: z.string().url().max(2_048),
  }).passthrough()).max(MAX_RESULTS),
}).passthrough();

function localReceipt(input: {
  readonly now: string;
  readonly query: WebCorroborationQuery;
  readonly status: "not_run" | "unavailable";
}): WebCorroborationSearch {
  return webCorroborationSearchSchema.parse({
    completeness: input.status === "not_run" ? "complete" : "unknown",
    cost: ZERO_COST,
    provider: "exa",
    queriedAt: input.now,
    queryDigest: input.query.queryDigest,
    recordType: "web_corroboration_search",
    requestId: `exa-local.${digestPublicCommentaryValue([input.query.queryDigest, input.now, input.status])}`,
    results: [],
    schemaVersion: 1,
    status: input.status,
  });
}

function exactCost(value: number) {
  return value.toFixed(6);
}

export function createExaWebCorroborationProvider(input: {
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
} = {}): WebCorroborationProvider {
  const transport = input.fetch ?? fetch;
  const apiKey = input.apiKey ?? process.env.EXA_API_KEY;
  const timeoutMs = input.timeoutMs ?? 10_000;
  return Object.freeze({
    async search(request: WebCorroborationRequest) {
      const now = (request.now ?? new Date()).toISOString();
      if (!request.enabled || !apiKey || !request.budgetAuthorized) {
        return localReceipt({ now, query: request.query, status: "not_run" });
      }
      try {
        const response = await transport(EXA_SEARCH_URL, {
          body: JSON.stringify({
            category: "news",
            endPublishedDate: request.query.endPublishedAt,
            numResults: MAX_RESULTS,
            query: request.query.query,
            startPublishedDate: request.query.startPublishedAt,
            type: "fast",
          }),
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok || response.url !== EXA_SEARCH_URL) {
          return localReceipt({ now, query: request.query, status: "unavailable" });
        }
        const parsed = exaResponseSchema.parse(await response.json());
        const domains = new Set(parsed.results.map(({ url }) => new URL(url).hostname.toLowerCase()));
        if (domains.size > MAX_RESULTS) throw new Error("corroboration_domain_bounds_exceeded");
        const results = parsed.results.map((result) => ({
          author: result.author ?? null,
          publishedAt: result.publishedDate ?? null,
          resultId: result.id,
          title: result.title,
          url: new URL(result.url).toString(),
        }));
        return webCorroborationSearchSchema.parse({
          completeness: "complete",
          cost: { amountUsd: exactCost(parsed.costDollars.total), billableUnits: 1, currency: "USD" },
          provider: "exa",
          queriedAt: now,
          queryDigest: request.query.queryDigest,
          recordType: "web_corroboration_search",
          requestId: parsed.requestId,
          results,
          schemaVersion: 1,
          status: results.length > 0 ? "candidates_found" : "not_found",
        });
      } catch {
        return localReceipt({ now, query: request.query, status: "unavailable" });
      }
    },
  });
}

export function classifyCorroborationMetadata(
  search: WebCorroborationSearch,
  classifications: Readonly<Record<string, "established_newsroom" | "official" | "other">>,
) {
  return Object.freeze(webCorroborationSearchSchema.parse(search).results.map((result) => Object.freeze({
    classification: classifications[new URL(result.url).hostname.toLowerCase()] ?? "other",
    metadataOnly: true as const,
    proofOfClaim: false as const,
    result,
  })));
}

export function attachCorroborationMetadata(
  statement: PublicStatement,
  search: WebCorroborationSearch,
) {
  return Object.freeze({
    corroboration: webCorroborationSearchSchema.parse(search),
    statement: publicStatementSchema.parse(statement),
  });
}
