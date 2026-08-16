export const IPO_FILINGS_ALERT_PRESENTATION_ID = "alert.public-event/v1";
export const IPO_FILINGS_EVAL_SUITE_ID = "eval.sec-ipo/v1";
export const IPO_FILINGS_FINDING_SCHEMA_ID = "ipo-registration-filing/v1";
export const IPO_FILINGS_SOURCE_ID = "sec-latest-s1-filings";
export const IPO_FILINGS_SOURCE_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom";
export const IPO_FILINGS_SOURCE_CONTRACT_VERSION = "1.0.0";
export const IPO_FILINGS_SOURCE_CONTRACT_DIGEST =
  "c9d9fd8e6c0881fd59692e1986b151c17df30a9e899074222098888d56127f98";
export const IPO_FILINGS_SOURCE_ALLOWED_ORIGINS = Object.freeze([
  "https://www.sec.gov",
]);
export const IPO_FILINGS_EVALUATION_TOOL_ID = "evaluate_sec_ipo_source";

export const IPO_FILINGS_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.sec-ipo.forbidden-capability",
  "fixture.sec-ipo.malformed",
  "fixture.sec-ipo.no-match",
  "fixture.sec-ipo.positive",
  "fixture.sec-ipo.replay",
]);

export const STRATEGY_PACK_REFERENCE_CATALOG = Object.freeze({
  alertPresentationIds: Object.freeze([IPO_FILINGS_ALERT_PRESENTATION_ID]),
  capabilityIds: Object.freeze([
    IPO_FILINGS_EVALUATION_TOOL_ID,
    "skill.public-event-monitoring",
  ]),
  evalSuites: Object.freeze({
    [IPO_FILINGS_EVAL_SUITE_ID]: IPO_FILINGS_EVAL_FIXTURE_IDS,
  }),
  findingSchemaIds: Object.freeze([IPO_FILINGS_FINDING_SCHEMA_ID]),
  sourceContracts: Object.freeze({
    [IPO_FILINGS_SOURCE_ID]: Object.freeze({
      allowedOrigins: IPO_FILINGS_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: IPO_FILINGS_SOURCE_URL,
      contractDigest: IPO_FILINGS_SOURCE_CONTRACT_DIGEST,
      contractVersion: IPO_FILINGS_SOURCE_CONTRACT_VERSION,
    }),
  }),
});

export const STRATEGY_PACK_CAPABILITY_INVENTORY = Object.freeze([
  Object.freeze({
    category: "control" as const,
    id: IPO_FILINGS_EVALUATION_TOOL_ID,
  }),
]);
