import { defineOpenAPIConnection } from "eve/connections";

const cikParameter = {
  in: "path",
  name: "cik",
  required: true,
  description: "The SEC CIK padded to exactly 10 digits, without the CIK prefix.",
  schema: {
    type: "string",
    pattern: "^[0-9]{10}$",
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
  baseUrl: "https://data.sec.gov",
  description:
    "SEC EDGAR read-only JSON data APIs. Use submissions to locate 10-Q, 10-K, 8-K, and Form 4 filings, and company facts to verify reported fundamentals. CIK values must contain 10 digits.",
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason:
            "Scheduled public-feed checks must use their configured sources.",
        }
      : "not-applicable",
  headers: {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "User-Agent": () => secUserAgent(),
  },
  spec: {
    openapi: "3.0.3",
    info: {
      title: "SEC EDGAR data APIs",
      version: "1.0.0",
    },
    paths: {
      "/submissions/CIK{cik}.json": {
        get: {
          operationId: "getCompanySubmissions",
          summary: "Get company metadata and recent SEC filing history",
          parameters: [cikParameter],
          responses: { "200": jsonObjectResponse },
        },
      },
      "/api/xbrl/companyfacts/CIK{cik}.json": {
        get: {
          operationId: "getCompanyFacts",
          summary: "Get all SEC XBRL company facts for a company",
          parameters: [cikParameter],
          responses: { "200": jsonObjectResponse },
        },
      },
    },
  },
  operations: {
    allow: ["getCompanySubmissions", "getCompanyFacts"],
  },
});
