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

export const HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID =
  "house-financial-disclosures-2026";
export const HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL =
  "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip";
export const HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ALLOWED_ORIGINS = Object.freeze([
  "https://disclosures-clerk.house.gov",
]);
export const HOUSE_FINANCIAL_DISCLOSURES_SOURCE_CONTRACT_VERSION = "1.0.0";
export const HOUSE_FINANCIAL_DISCLOSURES_SOURCE_CONTRACT_DIGEST =
  "ef0772fd62d5781c9dac989eb12f699856d909d10ad3b81efe6b5a68c29046bc";

export const HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  acquisitionMethod: "poll",
  adapterId: "house-financial-disclosures",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://disclosures-clerk.house.gov",
  configurationSchemaVersion: 1,
  definitionDigest: "c887a0e75bab48019434a9da18f22fc11be4e1dc18b9e85e7b00d767dbdc9264",
  factSchemaVersions: ["house-ptr-filing/v1", "house-ptr-transaction/v1"],
  implementationRevision: 2,
  limits: {
    maximumArchiveBytes: 5 * 1_024 * 1_024,
    maximumFactsPerAcquisition: 500,
    maximumPdfBytes: 10 * 1_024 * 1_024,
    maximumPdfPages: 8,
    maximumResponseBytes: 10 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 1_440,
  minimumCadenceMinutes: 60,
  recordType: "public_source_adapter_definition",
  schemaVersion: 1,
} as const);

const houseSourceConfiguration = {
  canonicalUrl: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
  kind: "house_financial_disclosures_year",
  year: 2026,
} as const;

export const HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_INSTANCE = Object.freeze({
  adapterDefinitionDigest:
    HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.definitionDigest,
  adapterId: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.adapterId,
  adapterVersion: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.adapterVersion,
  authorityOrigin: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
  cadenceMinutes: 360,
  configuration: houseSourceConfiguration,
  configurationDigest:
    "813f0f4ffedbdb05b554ac7e1c468d71a0e59dae5dd8ec762f13b606c4eff9a2",
  cursor: { contentDigest: null, revision: 0, watermark: null },
  lifecycleState: "active",
  recordType: "public_source_instance",
  schemaVersion: 1,
  sourceInstanceId: "source.house-financial-disclosures.2026",
} as const);

const secAdapterDefinitionCore = {
  acquisitionMethod: "poll",
  adapterId: "sec-latest-filings",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://www.sec.gov",
  configurationSchemaVersion: 1,
  factSchemaVersions: ["sec-filing/v1"],
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: 5 * 1_024 * 1_024,
    maximumFactsPerAcquisition: 100,
    maximumPdfBytes: 10 * 1_024 * 1_024,
    maximumPdfPages: 8,
    maximumResponseBytes: 2 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 1_440,
  minimumCadenceMinutes: 15,
  recordType: "public_source_adapter_definition",
  schemaVersion: 1,
} as const;

export const IPO_FILINGS_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  ...secAdapterDefinitionCore,
  definitionDigest: "a867cc7ee8e93f88c5421f91fc594f5970462580e3436b73c51147b102d47f95",
});

const secSourceConfiguration = {
  canonicalUrl: IPO_FILINGS_SOURCE_URL,
  kind: "sec_latest_s1",
} as const;

export const IPO_FILINGS_PUBLIC_SOURCE_INSTANCE = Object.freeze({
  adapterDefinitionDigest: IPO_FILINGS_PUBLIC_SOURCE_ADAPTER.definitionDigest,
  adapterId: IPO_FILINGS_PUBLIC_SOURCE_ADAPTER.adapterId,
  adapterVersion: IPO_FILINGS_PUBLIC_SOURCE_ADAPTER.adapterVersion,
  authorityOrigin: IPO_FILINGS_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
  cadenceMinutes: 60,
  configuration: secSourceConfiguration,
  configurationDigest: "1701a2a4a0119331c5d7af7fd775d84df9e3ef51b8716916a32c51a7262616d9",
  cursor: { contentDigest: null, revision: 0, watermark: null },
  lifecycleState: "active",
  recordType: "public_source_instance",
  schemaVersion: 1,
  sourceInstanceId: "source.sec-latest-s1-filings",
});

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
    [HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID]: Object.freeze({
      allowedOrigins: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
      contractDigest: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_CONTRACT_DIGEST,
      contractVersion: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_CONTRACT_VERSION,
      publicSource: Object.freeze({
        adapterDefinition: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER,
        sourceInstance: HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_INSTANCE,
      }),
    }),
    [IPO_FILINGS_SOURCE_ID]: Object.freeze({
      allowedOrigins: IPO_FILINGS_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: IPO_FILINGS_SOURCE_URL,
      contractDigest: IPO_FILINGS_SOURCE_CONTRACT_DIGEST,
      contractVersion: IPO_FILINGS_SOURCE_CONTRACT_VERSION,
      publicSource: Object.freeze({
        adapterDefinition: IPO_FILINGS_PUBLIC_SOURCE_ADAPTER,
        sourceInstance: IPO_FILINGS_PUBLIC_SOURCE_INSTANCE,
      }),
    }),
  }),
});

export const STRATEGY_PACK_CAPABILITY_INVENTORY = Object.freeze([
  Object.freeze({
    category: "control" as const,
    id: IPO_FILINGS_EVALUATION_TOOL_ID,
  }),
]);
