import { z } from "zod";

import {
  CONGRESSIONAL_SIGNAL_BANDS,
  CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
  CONGRESSIONAL_SIGNAL_REASON_CODES,
} from "./congressional-signal-schema";
import {
  HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "./strategy-pack-reference-catalog";
import { earningsFindingSchema } from "./earnings-call-schema";

export const SEC_IPO_FACT_SCHEMA_VERSION = 1;
export const SEC_IPO_NORMALIZER_VERSION = "sec-ipo-atom/1.0.0";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });

export const secIpoFilingFactSchema = z.object({
  accessionNumber: z.string().regex(/^\d{10}-\d{2}-\d{6}$/u),
  amendmentIdentity: z.string().min(1).max(256).nullable(),
  canonicalFilingUrl: z.string().url().max(2_048),
  cik: z.string().regex(/^\d{10}$/u),
  classification: z.enum(["amendment", "new_registration"]),
  companyName: z.string().trim().min(1).max(300),
  contentEvidence: z.object({
    feedContentHash: digestSchema,
    normalizedFilingHash: digestSchema,
  }).strict(),
  fileNumber: z.string().min(1).max(80).nullable(),
  filedAt: timestampSchema.nullable(),
  filingIdentity: z.string().min(1).max(128),
  formType: z.enum(["S-1", "S-1/A"]),
  kind: z.literal("sec_ipo_filing"),
  normalizerVersion: z.literal(SEC_IPO_NORMALIZER_VERSION),
  observedAt: timestampSchema,
  registrationIdentity: z.string().min(1).max(128),
  schemaVersion: z.literal(SEC_IPO_FACT_SCHEMA_VERSION),
  source: z.object({
    accessClassification: z.literal("public"),
    canonicalUrl: z.string().url().max(2_048),
    origin: z.string().url().max(500),
    sourceId: z.string().min(1).max(160),
  }).strict(),
  updatedAt: timestampSchema,
}).strict().superRefine((fact, context) => {
  const filingUrl = new URL(fact.canonicalFilingUrl);
  const sourceUrl = new URL(fact.source.canonicalUrl);
  if (
    fact.source.origin !== sourceUrl.origin ||
    sourceUrl.origin !== "https://www.sec.gov" ||
    filingUrl.origin !== sourceUrl.origin ||
    fact.filingIdentity !== `${fact.accessionNumber}:${fact.formType}` ||
    (fact.classification === "amendment") !== (fact.formType === "S-1/A") ||
    (fact.classification === "amendment") !== (fact.amendmentIdentity !== null)
  ) {
    context.addIssue({ code: "custom", message: "sec_ipo_fact_invalid" });
  }
});

export const congressionalFilingSignalFactSchema = z.object({
  band: z.enum(CONGRESSIONAL_SIGNAL_BANDS),
  delayedDisclosureCaveat: z.literal(CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT),
  filingDate: z.string().date(),
  filingIdentity: z.string().min(1).max(160),
  kind: z.literal("congressional_filing_signal"),
  member: z.object({
    bioguideId: z.string().regex(/^[A-Z]\d{6}$/u),
    disclosedName: z.string().trim().min(1).max(240),
  }).strict(),
  observedAt: timestampSchema,
  publicDocumentUrl: z.string().url().max(2_048),
  schemaVersion: z.literal(1),
  signalId: z.string().min(1).max(160),
  signalRevisionId: z.string().min(1).max(160),
  source: z.object({
    accessClassification: z.literal("public"),
    canonicalUrl: z.literal(HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL),
    origin: z.literal(HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin),
    sourceId: z.literal(HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID),
  }).strict(),
  transactions: z.array(z.object({
    amountRange: z.object({
      label: z.string().trim().min(1).max(120),
      lower: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
      upper: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
    }).strict(),
    assetDescription: z.string().trim().min(1).max(1_000),
    band: z.enum(CONGRESSIONAL_SIGNAL_BANDS),
    disclosureLagDays: z.number().int().nonnegative().nullable(),
    ownerRelationship: z.enum([
      "dependent_child",
      "joint",
      "other_disclosed",
      "self",
      "spouse",
      "unknown",
    ]),
    reasonCodes: z.array(z.enum(CONGRESSIONAL_SIGNAL_REASON_CODES)).min(1).max(32),
    transactionDate: z.string().date(),
    transactionType: z.enum(["P", "S"]),
  }).strict()).min(1).max(50),
}).strict().superRefine((fact, context) => {
  if (
    fact.filingIdentity !== fact.signalRevisionId ||
    new URL(fact.publicDocumentUrl).origin !==
      HOUSE_FINANCIAL_DISCLOSURES_PUBLIC_SOURCE_ADAPTER.authorityOrigin
  ) {
    context.addIssue({ code: "custom", message: "congressional_filing_signal_fact_invalid" });
  }
});

export const earningsCallChangeFactSchema = z.object({
  cik: z.string().regex(/^\d{10}$/u),
  companyName: z.string().trim().min(1).max(200),
  currentFiscalPeriod: z.string().regex(/^FY\d{4}-Q[1-4]$/u),
  filingIdentity: z.string().min(1).max(160),
  finding: earningsFindingSchema,
  kind: z.literal("earnings_call_change"),
  observedAt: timestampSchema,
  schemaVersion: z.literal(1),
  source: z.object({
    accessClassification: z.literal("public"),
    canonicalUrl: z.string().url().max(2_048),
    origin: z.string().url().max(500),
    sourceId: z.string().min(2).max(160),
  }).strict(),
  ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,9}$/u),
}).strict().superRefine((fact, context) => {
  if (
    fact.filingIdentity !== fact.finding.findingId ||
    fact.finding.outcome !== "accepted" ||
    !fact.finding.materiality.alertEligible
  ) context.addIssue({ code: "custom", message: "earnings_call_change_fact_invalid" });
});

export const workspaceFindingFactSchema = z.discriminatedUnion("kind", [
  secIpoFilingFactSchema,
  congressionalFilingSignalFactSchema,
  earningsCallChangeFactSchema,
]);

export type SecIpoFilingFact = z.infer<typeof secIpoFilingFactSchema>;
export type CongressionalFilingSignalFact = z.infer<typeof congressionalFilingSignalFactSchema>;
export type EarningsCallChangeFact = z.infer<typeof earningsCallChangeFactSchema>;
export type WorkspaceFindingFact = z.infer<typeof workspaceFindingFactSchema>;
