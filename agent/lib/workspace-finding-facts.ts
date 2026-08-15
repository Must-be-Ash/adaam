import { z } from "zod";

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

export const workspaceFindingFactSchema = z.discriminatedUnion("kind", [
  secIpoFilingFactSchema,
]);

export type SecIpoFilingFact = z.infer<typeof secIpoFilingFactSchema>;
export type WorkspaceFindingFact = z.infer<typeof workspaceFindingFactSchema>;
