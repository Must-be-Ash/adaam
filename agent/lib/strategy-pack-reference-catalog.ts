export const EARNINGS_CALL_TRANSCRIPTS_SOURCE_ID = "earnings-call-transcripts";
export const EARNINGS_CALL_TRANSCRIPTS_SOURCE_URL =
  "https://data.sec.gov/submissions/CIK0000000000.json";
export const EARNINGS_CALL_TRANSCRIPTS_SOURCE_ALLOWED_ORIGINS = Object.freeze([
  "https://data.sec.gov",
]);
export const EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_VERSION = "1.0.0";
export const EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST =
  "8832172086d8e5f582d94cfa9ce32b7c2927c313b41ffea853c3ae9d3fedaf73";

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

export const CONGRESSIONAL_SIGNALS_EVAL_SUITE_ID = "eval.congressional-signals/v1";
export const CONGRESSIONAL_SIGNALS_FINDING_SCHEMA_ID = "congressional-filing-signal/v1";
export const CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID = "evaluate_congressional_signals";

export const EARNINGS_CALL_CHANGES_ALERT_PRESENTATION_ID =
  "alert.earnings-call-change/v1";
export const EARNINGS_CALL_CHANGES_EVAL_SUITE_ID =
  "eval.earnings-call-changes/v1";
export const EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID =
  "evaluate_earnings_call_changes";
export const EARNINGS_CALL_CHANGES_FINDING_SCHEMA_ID =
  "earnings-call-change/v1";
export const INVERSE_CRAMER_ALERT_PRESENTATION_ID =
  "alert.public-commentary-signal/v1";
export const INVERSE_CRAMER_EVAL_SUITE_ID = "eval.inverse-cramer/v1";
export const INVERSE_CRAMER_EVALUATION_TOOL_ID =
  "evaluate_public_commentary_signals";
export const INVERSE_CRAMER_FINDING_SCHEMA_ID =
  "public-commentary-signal/v1";
export const PUBLIC_COMMENTARY_TRACKER_EVAL_SUITE_ID = "eval.public-commentary-tracker/v1";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_ID = "public-commentary-tracker-source";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_URL =
  "https://www.whitehouse.gov/briefings-statements/feed/";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_ALLOWED_ORIGINS = Object.freeze([
  "https://www.whitehouse.gov",
]);
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_VERSION = "1.0.0";
export const PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_DIGEST =
  "e5070e0a70a7e7e89ac07bc64a470529896db56253150e54e93a69e70be88f35";
export const OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  acquisitionMethod: "poll" as const,
  adapterId: "official-web-statements" as const,
  adapterVersion: "1.0.0",
  authorityOrigin: "https://www.whitehouse.gov",
  configurationSchemaVersion: 1 as const,
  definitionDigest: "9e6111301b91c90e6e651a2caf3749e5c9e12472db2eee0719c419f7849fa115",
  factSchemaVersions: ["public-statement/v1"] as const,
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: 1,
    maximumFactsPerAcquisition: 32,
    maximumPdfBytes: 1,
    maximumPdfPages: 1,
    maximumResponseBytes: 2 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 1_440,
  minimumCadenceMinutes: 10,
  recordType: "public_source_adapter_definition" as const,
  schemaVersion: 1 as const,
});
const officialWebStatementConfiguration = Object.freeze({
  canonicalUrl: PUBLIC_COMMENTARY_TRACKER_SOURCE_URL,
  displayLabel: "The White House" as const,
  kind: "official_web_statements_feed" as const,
  maximumStatementsPerPoll: 32 as const,
});
export const OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_INSTANCE = Object.freeze({
  adapterDefinitionDigest: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER.definitionDigest,
  adapterId: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterId,
  adapterVersion: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterVersion,
  authorityOrigin: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
  cadenceMinutes: 60,
  configuration: officialWebStatementConfiguration,
  configurationDigest: "31c524d932dfacda04a7e367145f000ecc013010c5472e4cec1f7b7a67e3e53c",
  cursor: { contentDigest: null, revision: 0, watermark: null },
  lifecycleState: "active" as const,
  recordType: "public_source_instance" as const,
  schemaVersion: 1 as const,
  sourceInstanceId: "source.official-web-statements.white-house-briefings",
});

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

export const X_PUBLIC_STATEMENTS_SOURCE_ID = "x-jim-cramer-public-statements";
export const X_PUBLIC_STATEMENTS_SOURCE_URL =
  "https://api.x.com/2/users/14216123/tweets";
export const X_PUBLIC_STATEMENTS_SOURCE_ALLOWED_ORIGINS = Object.freeze([
  "https://api.x.com",
]);
export const X_PUBLIC_STATEMENTS_SOURCE_CONTRACT_VERSION = "1.0.0";
export const X_PUBLIC_STATEMENTS_SOURCE_CONTRACT_DIGEST =
  "cfc44775cb9aaf01ddd5e583e267137158651414c09e8d2d2fc2af10d3f953a5";

const xPublicStatementAdapterDefinitionCore = {
  acquisitionMethod: "poll",
  adapterId: "x-public-statements",
  adapterVersion: "1.0.0",
  authorityOrigin: "https://api.x.com",
  configurationSchemaVersion: 1,
  factSchemaVersions: ["public-statement/v1"],
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: 1,
    maximumFactsPerAcquisition: 200,
    maximumPdfBytes: 1,
    maximumPdfPages: 1,
    maximumResponseBytes: 1 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 60,
  minimumCadenceMinutes: 10,
  recordType: "public_source_adapter_definition",
  schemaVersion: 1,
} as const;

export const X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  ...xPublicStatementAdapterDefinitionCore,
  definitionDigest: "bf15cf4bfa830b385a3a6e3964a1d19d449591916f8452b772bbb045381b6129",
});

export const X_CONFIGURABLE_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER = Object.freeze({
  ...xPublicStatementAdapterDefinitionCore,
  adapterVersion: "1.1.0",
  definitionDigest: "e3ae1002875dc764e4f8e1f23e7fde6b32c97f096128a963a1dc8b7533ed84f6",
  maximumCadenceMinutes: 1_440,
});
export const X_CONFIGURABLE_PUBLIC_STATEMENTS_CONTRACT_DIGEST =
  "97c37a9d709181f355ef1e82a20de65306139836c1700a6f1efbe96ae0f6f979";

const xPublicStatementSourceConfiguration = {
  canonicalUrl: X_PUBLIC_STATEMENTS_SOURCE_URL,
  displayLabel: "Jim Cramer",
  excludeReposts: true,
  kind: "x_public_statements_user",
  maximumPagesPerPoll: 2,
  maximumPostsPerPoll: 200,
  numericUserId: "14216123",
  username: "jimcramer",
} as const;

export const X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_INSTANCE = Object.freeze({
  adapterDefinitionDigest: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.definitionDigest,
  adapterId: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterId,
  adapterVersion: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.adapterVersion,
  authorityOrigin: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
  cadenceMinutes: 10,
  configuration: xPublicStatementSourceConfiguration,
  configurationDigest: "72eb27e5a8e0a451b130f3eaa59138fd3aff7d7599999c86cdb6464fa21e62f5",
  cursor: { contentDigest: null, revision: 0, watermark: null },
  lifecycleState: "active",
  recordType: "public_source_instance",
  schemaVersion: 1,
  sourceInstanceId: "source.x-public-statements.14216123",
} as const);

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

export const CONGRESSIONAL_SIGNALS_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.congressional-signals.baseline",
  "fixture.congressional-signals.forbidden-capability",
  "fixture.congressional-signals.non-qualifying",
  "fixture.congressional-signals.priority",
  "fixture.congressional-signals.replay",
]);

export const EARNINGS_CALL_CHANGES_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.earnings-call-changes.forbidden-capability",
  "fixture.earnings-call-changes.malformed",
  "fixture.earnings-call-changes.no-match",
  "fixture.earnings-call-changes.positive",
  "fixture.earnings-call-changes.replay",
]);

export const INVERSE_CRAMER_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.inverse-cramer.correction",
  "fixture.inverse-cramer.forbidden-capability",
  "fixture.inverse-cramer.malformed",
  "fixture.inverse-cramer.no-view",
  "fixture.inverse-cramer.positive",
  "fixture.inverse-cramer.replay",
]);
export const PUBLIC_COMMENTARY_TRACKER_EVAL_FIXTURE_IDS = Object.freeze([
  "fixture.public-commentary-tracker.forbidden-capability",
  "fixture.public-commentary-tracker.malformed",
  "fixture.public-commentary-tracker.no-view",
  "fixture.public-commentary-tracker.positive",
  "fixture.public-commentary-tracker.replay",
]);

export const STRATEGY_PACK_REFERENCE_CATALOG = Object.freeze({
  alertPresentationIds: Object.freeze([
    EARNINGS_CALL_CHANGES_ALERT_PRESENTATION_ID,
    INVERSE_CRAMER_ALERT_PRESENTATION_ID,
    IPO_FILINGS_ALERT_PRESENTATION_ID,
  ]),
  capabilityIds: Object.freeze([
    CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
    EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
    INVERSE_CRAMER_EVALUATION_TOOL_ID,
    IPO_FILINGS_EVALUATION_TOOL_ID,
    "skill.earnings-call-change-analysis",
    "skill.inverse-cramer-commentary-analysis",
    "skill.public-commentary-tracker-analysis",
    "skill.congressional-signal-triage",
    "skill.public-event-monitoring",
  ]),
  evalSuites: Object.freeze({
    [CONGRESSIONAL_SIGNALS_EVAL_SUITE_ID]: CONGRESSIONAL_SIGNALS_EVAL_FIXTURE_IDS,
    [EARNINGS_CALL_CHANGES_EVAL_SUITE_ID]: EARNINGS_CALL_CHANGES_EVAL_FIXTURE_IDS,
    [INVERSE_CRAMER_EVAL_SUITE_ID]: INVERSE_CRAMER_EVAL_FIXTURE_IDS,
    [PUBLIC_COMMENTARY_TRACKER_EVAL_SUITE_ID]: PUBLIC_COMMENTARY_TRACKER_EVAL_FIXTURE_IDS,
    [IPO_FILINGS_EVAL_SUITE_ID]: IPO_FILINGS_EVAL_FIXTURE_IDS,
  }),
  findingSchemaIds: Object.freeze([
    CONGRESSIONAL_SIGNALS_FINDING_SCHEMA_ID,
    EARNINGS_CALL_CHANGES_FINDING_SCHEMA_ID,
    INVERSE_CRAMER_FINDING_SCHEMA_ID,
    IPO_FILINGS_FINDING_SCHEMA_ID,
  ]),
  parameterizedSourceContracts: Object.freeze({
    [EARNINGS_CALL_TRANSCRIPTS_SOURCE_ID]: Object.freeze({
      allowedOrigins: EARNINGS_CALL_TRANSCRIPTS_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: EARNINGS_CALL_TRANSCRIPTS_SOURCE_URL,
      contractDigest: EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST,
      contractVersion: EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_VERSION,
    }),
  }),
  sourceContracts: Object.freeze({
    [PUBLIC_COMMENTARY_TRACKER_SOURCE_ID]: Object.freeze({
      allowedOrigins: PUBLIC_COMMENTARY_TRACKER_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: PUBLIC_COMMENTARY_TRACKER_SOURCE_URL,
      contractDigest: PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_DIGEST,
      contractVersion: PUBLIC_COMMENTARY_TRACKER_SOURCE_CONTRACT_VERSION,
      publicSource: Object.freeze({
        adapterDefinition: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_ADAPTER,
        sourceInstance: OFFICIAL_WEB_STATEMENTS_PUBLIC_SOURCE_INSTANCE,
      }),
    }),
    [X_PUBLIC_STATEMENTS_SOURCE_ID]: Object.freeze({
      allowedOrigins: X_PUBLIC_STATEMENTS_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: X_PUBLIC_STATEMENTS_SOURCE_URL,
      contractDigest: X_PUBLIC_STATEMENTS_SOURCE_CONTRACT_DIGEST,
      contractVersion: X_PUBLIC_STATEMENTS_SOURCE_CONTRACT_VERSION,
      publicSource: Object.freeze({
        adapterDefinition: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER,
        sourceInstance: X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_INSTANCE,
      }),
    }),
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
    id: INVERSE_CRAMER_EVALUATION_TOOL_ID,
  }),
  Object.freeze({
    category: "control" as const,
    id: EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
  }),
  Object.freeze({
    category: "control" as const,
    id: CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  }),
  Object.freeze({
    category: "control" as const,
    id: IPO_FILINGS_EVALUATION_TOOL_ID,
  }),
]);
