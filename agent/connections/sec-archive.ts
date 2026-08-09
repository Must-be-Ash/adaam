import { defineOpenAPIConnection } from "eve/connections";

const archiveCikParameter = {
  in: "path",
  name: "cik",
  required: true,
  description: "The filing entity CIK without leading zeros.",
  schema: {
    type: "string",
    pattern: "^[1-9][0-9]{0,9}$",
  },
} as const;

const accessionParameter = {
  in: "path",
  name: "accession",
  required: true,
  description: "The 18-digit SEC accession number with dashes removed.",
  schema: {
    type: "string",
    pattern: "^[0-9]{18}$",
  },
} as const;

const jsonObjectResponse = {
  description: "Successful response",
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
} as const;

function secUserAgent(): string {
  const userAgent = process.env.SEC_USER_AGENT;
  if (!userAgent) {
    throw new Error(
      "SEC_USER_AGENT is not configured. Set it to an application name and monitored contact before calling SEC EDGAR.",
    );
  }
  return userAgent;
}

export default defineOpenAPIConnection({
  baseUrl: "https://www.sec.gov",
  description:
    "SEC EDGAR read-only archive access. Use it to map tickers to CIKs, inspect a filing directory, and retrieve the primary document for 10-Q, 10-K, 8-K, or Form 4 evidence.",
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason:
            "Scheduled public-feed checks must use their configured sources.",
        }
      : "not-applicable",
  headers: {
    Accept: "application/json, text/html, application/xml, text/plain",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": () => secUserAgent(),
  },
  spec: {
    openapi: "3.0.3",
    info: {
      title: "SEC EDGAR public archive",
      version: "1.0.0",
    },
    paths: {
      "/files/company_tickers.json": {
        get: {
          operationId: "getCompanyTickers",
          summary: "Map US public-company tickers to SEC CIKs",
          responses: { "200": jsonObjectResponse },
        },
      },
      "/Archives/edgar/data/{cik}/{accession}/index.json": {
        get: {
          operationId: "getFilingIndex",
          summary: "List the documents included in an SEC filing",
          parameters: [archiveCikParameter, accessionParameter],
          responses: { "200": jsonObjectResponse },
        },
      },
      "/Archives/edgar/data/{cik}/{accession}/{document}": {
        get: {
          operationId: "getFilingDocument",
          summary: "Retrieve one document from an SEC filing directory",
          parameters: [
            archiveCikParameter,
            accessionParameter,
            {
              in: "path",
              name: "document",
              required: true,
              description: "A filename returned by getFilingIndex.",
              schema: {
                type: "string",
                pattern: "^[A-Za-z0-9_.-]+$",
              },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "text/html": { schema: { type: "string" } },
                "application/xml": { schema: { type: "string" } },
                "text/xml": { schema: { type: "string" } },
                "text/plain": { schema: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
  operations: {
    allow: ["getCompanyTickers", "getFilingIndex", "getFilingDocument"],
  },
});
