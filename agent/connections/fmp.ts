import { defineOpenAPIConnection } from "eve/connections";

const apiKeyParameter = {
  in: "query",
  name: "apikey",
  required: true,
  schema: { type: "string" },
} as const;

const symbolParameter = {
  in: "query",
  name: "symbol",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;

const nameParameter = {
  in: "query",
  name: "name",
  required: true,
  schema: { type: "string", minLength: 1 },
} as const;

const pageParameter = {
  in: "query",
  name: "page",
  required: false,
  schema: { type: "integer", minimum: 0, default: 0 },
} as const;

const limitParameter = {
  in: "query",
  name: "limit",
  required: false,
  schema: { type: "integer", minimum: 1, maximum: 100, default: 100 },
} as const;

const jsonResponse = {
  description: "Successful response",
  content: {
    "application/json": {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
} as const;

export default defineOpenAPIConnection({
  baseUrl: "https://financialmodelingprep.com",
  description:
    "Financial Modeling Prep (FMP), read-only access to earnings-call transcripts, company profiles, congressional financial disclosures, corporate insider trades, and beneficial-ownership data.",
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason: "Scheduled public-feed checks cannot use FMP.",
        }
      : "not-applicable",
  spec: {
    openapi: "3.0.3",
    info: {
      title: "FMP earnings-call research",
      version: "1.0.0",
    },
    paths: {
      "/stable/earning-call-transcript-dates": {
        get: {
          operationId: "listEarningCallTranscriptDates",
          summary: "List available earnings-call transcript dates for a ticker",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/earning-call-transcript": {
        get: {
          operationId: "getEarningCallTranscript",
          summary: "Get one earnings-call transcript by ticker, fiscal year, and quarter",
          parameters: [
            symbolParameter,
            {
              in: "query",
              name: "year",
              required: true,
              schema: { type: "integer", minimum: 1990, maximum: 2100 },
            },
            {
              in: "query",
              name: "quarter",
              required: true,
              schema: { type: "integer", minimum: 1, maximum: 4 },
            },
            apiKeyParameter,
          ],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/profile": {
        get: {
          operationId: "getCompanyProfile",
          summary: "Get a company profile, including identifiers such as CIK when available",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/senate-latest": {
        get: {
          operationId: "listLatestSenateDisclosures",
          summary: "List the latest US Senate financial disclosures",
          parameters: [pageParameter, limitParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/senate-trades": {
        get: {
          operationId: "listSenateTradesBySymbol",
          summary: "List US Senate trades for a stock symbol",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/senate-trades-by-name": {
        get: {
          operationId: "listSenateTradesByName",
          summary: "List US Senate trades matching a member name",
          parameters: [nameParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/house-latest": {
        get: {
          operationId: "listLatestHouseDisclosures",
          summary: "List the latest US House financial disclosures",
          parameters: [pageParameter, limitParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/house-trades": {
        get: {
          operationId: "listHouseTradesBySymbol",
          summary: "List US House trades for a stock symbol",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/house-trades-by-name": {
        get: {
          operationId: "listHouseTradesByName",
          summary: "List US House trades matching a member name",
          parameters: [nameParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/insider-trading/latest": {
        get: {
          operationId: "listLatestInsiderTrades",
          summary: "List the latest reported corporate insider transactions",
          parameters: [pageParameter, limitParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/insider-trading/search": {
        get: {
          operationId: "listInsiderTradesBySymbol",
          summary: "Search corporate insider transactions by stock symbol",
          parameters: [
            symbolParameter,
            pageParameter,
            limitParameter,
            apiKeyParameter,
          ],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/insider-trading/reporting-name": {
        get: {
          operationId: "searchInsidersByReportingName",
          summary: "Find corporate insiders and reporting CIKs by name",
          parameters: [nameParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/insider-trading/statistics": {
        get: {
          operationId: "getInsiderTradeStatistics",
          summary: "Get quarterly insider acquisition and disposition statistics",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
      "/stable/acquisition-of-beneficial-ownership": {
        get: {
          operationId: "getBeneficialOwnershipAcquisitions",
          summary: "Get beneficial-ownership acquisition disclosures by stock symbol",
          parameters: [symbolParameter, apiKeyParameter],
          responses: { "200": jsonResponse },
        },
      },
    },
  },
  operations: {
    allow: [
      "listEarningCallTranscriptDates",
      "getEarningCallTranscript",
      "getCompanyProfile",
      "listLatestSenateDisclosures",
      "listSenateTradesBySymbol",
      "listSenateTradesByName",
      "listLatestHouseDisclosures",
      "listHouseTradesBySymbol",
      "listHouseTradesByName",
      "listLatestInsiderTrades",
      "listInsiderTradesBySymbol",
      "searchInsidersByReportingName",
      "getInsiderTradeStatistics",
      "getBeneficialOwnershipAcquisitions",
    ],
  },
  toolCall: {
    providedArguments: {
      apikey: () => {
        const apiKey = process.env.FMP_API_KEY;
        if (!apiKey) {
          throw new Error(
            "FMP_API_KEY is not configured. Add it to the deployment's encrypted environment.",
          );
        }
        return apiKey;
      },
    },
  },
});
