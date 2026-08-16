import { createHash } from "node:crypto";

import { z } from "zod";

export const PUBLIC_SOURCE_ADAPTER_IDS = [
  "house-financial-disclosures",
  "sec-latest-filings",
] as const;

export const PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS = [
  "house-ptr-filing/v1",
  "house-ptr-transaction/v1",
  "sec-filing/v1",
] as const;

export const PUBLIC_SOURCE_ERROR_CODES = [
  "acquisition_uncertain",
  "adapter_definition_invalid",
  "archive_entry_ambiguous",
  "archive_entry_forbidden",
  "archive_entry_limit_exceeded",
  "archive_expanded_bytes_exceeded",
  "archive_invalid",
  "archive_ratio_exceeded",
  "fact_invalid",
  "journal_conflict",
  "parser_incomplete",
  "pdf_execution_timeout",
  "pdf_invalid",
  "pdf_layout_ambiguous",
  "pdf_page_limit_exceeded",
  "pdf_scanned_unsupported",
  "pdf_text_limit_exceeded",
  "source_cursor_conflict",
  "source_instance_inactive",
  "source_instance_invalid",
  "transport_origin_forbidden",
  "transport_redirect_forbidden",
  "transport_response_oversized",
  "transport_timeout",
  "xml_bounds_exceeded",
  "xml_external_entity_forbidden",
  "xml_invalid",
] as const;

export const PUBLIC_SOURCE_LOG_EVENTS = [
  "acquisition_completed",
  "acquisition_failed",
  "acquisition_started",
  "correction_created",
  "fact_revision_created",
  "fact_revision_reused",
  "projection_created",
  "stage_completed",
] as const;

export const PUBLIC_SOURCE_LIMITS = Object.freeze({
  maximumArchiveBytes: 5 * 1024 * 1024,
  maximumArchiveEntries: 8,
  maximumArchiveExpandedBytes: 16 * 1024 * 1024,
  maximumArchiveRatio: 100,
  maximumCanonicalPayloadBytes: 64 * 1024,
  maximumFactsPerAcquisition: 500,
  maximumHouseDocumentsPerAcquisition: 25,
  maximumHouseIndexRows: 10_000,
  maximumPdfBytes: 10 * 1024 * 1024,
  maximumPdfExecutionMilliseconds: 5_000,
  maximumPdfPages: 8,
  maximumPdfTextCharacters: 100_000,
  maximumStageReceipts: 8,
  maximumXmlBytes: 8 * 1024 * 1024,
});

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const idSchema = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);
const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const timestampSchema = z.string().datetime({ offset: true });
const adapterIdSchema = z.enum(PUBLIC_SOURCE_ADAPTER_IDS);
const factSchemaVersionSchema = z.enum(PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS);
const errorCodeSchema = z.enum(PUBLIC_SOURCE_ERROR_CODES);

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function safePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.toString() === value
    );
  } catch {
    return false;
  }
}

const publicUrlSchema = z.string().max(2_048).refine(safePublicUrl);
const publicOriginSchema = z.string().max(500).refine(exactHttpsOrigin);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function digestPublicSourceValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function derivePublicSourceAdapterDefinitionDigest(
  definition: unknown,
): string {
  return digestPublicSourceValue(definition);
}

const adapterLimitsSchema = z.object({
  maximumArchiveBytes: z.number().int().positive().max(PUBLIC_SOURCE_LIMITS.maximumArchiveBytes),
  maximumFactsPerAcquisition: z.number().int().positive().max(PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition),
  maximumPdfBytes: z.number().int().positive().max(PUBLIC_SOURCE_LIMITS.maximumPdfBytes),
  maximumPdfPages: z.number().int().positive().max(PUBLIC_SOURCE_LIMITS.maximumPdfPages),
  maximumResponseBytes: z.number().int().positive().max(16 * 1024 * 1024),
}).strict();

export const publicSourceAdapterDefinitionSchema = z.object({
  acquisitionMethod: z.literal("poll"),
  adapterId: adapterIdSchema,
  adapterVersion: semverSchema,
  authorityOrigin: publicOriginSchema,
  configurationSchemaVersion: z.literal(1),
  definitionDigest: digestSchema,
  factSchemaVersions: z.array(factSchemaVersionSchema).min(1).max(3),
  implementationRevision: z.number().int().positive(),
  limits: adapterLimitsSchema,
  maximumCadenceMinutes: z.number().int().positive().max(525_600),
  minimumCadenceMinutes: z.number().int().positive().max(525_600),
  recordType: z.literal("public_source_adapter_definition"),
  schemaVersion: z.literal(1),
}).strict().superRefine((definition, context) => {
  const { definitionDigest: _definitionDigest, ...digestInput } = definition;
  const expectedSchemas = definition.adapterId === "sec-latest-filings"
    ? ["sec-filing/v1"]
    : ["house-ptr-filing/v1", "house-ptr-transaction/v1"];
  if (
    definition.minimumCadenceMinutes > definition.maximumCadenceMinutes ||
    JSON.stringify(definition.factSchemaVersions) !== JSON.stringify(expectedSchemas) ||
    definition.definitionDigest !== derivePublicSourceAdapterDefinitionDigest(digestInput)
  ) {
    context.addIssue({ code: "custom", message: "adapter_definition_invalid" });
  }
});

const secSourceConfigurationSchema = z.object({
  canonicalUrl: z.literal("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom"),
  kind: z.literal("sec_latest_s1"),
}).strict();

const houseSourceConfigurationSchema = z.object({
  canonicalUrl: z.string().max(2_048).refine((value) =>
    /^https:\/\/disclosures-clerk\.house\.gov\/public_disc\/financial-pdfs\/(?:20\d{2})FD\.zip$/u.test(value),
  ),
  kind: z.literal("house_financial_disclosures_year"),
  year: z.number().int().min(2012).max(2100),
}).strict().superRefine((configuration, context) => {
  if (!configuration.canonicalUrl.endsWith(`/${configuration.year}FD.zip`)) {
    context.addIssue({ code: "custom", message: "source_instance_invalid" });
  }
});

const sourceCursorSchema = z.object({
  contentDigest: digestSchema.nullable(),
  revision: z.number().int().nonnegative(),
  watermark: z.string().min(1).max(200).nullable(),
}).strict();

export const publicSourceInstanceSchema = z.object({
  adapterDefinitionDigest: digestSchema,
  adapterId: adapterIdSchema,
  adapterVersion: semverSchema,
  authorityOrigin: publicOriginSchema,
  cadenceMinutes: z.number().int().positive().max(525_600),
  configuration: z.discriminatedUnion("kind", [
    secSourceConfigurationSchema,
    houseSourceConfigurationSchema,
  ]),
  configurationDigest: digestSchema,
  cursor: sourceCursorSchema,
  lifecycleState: z.enum(["active", "paused", "retired"]),
  recordType: z.literal("public_source_instance"),
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
}).strict().superRefine((instance, context) => {
  const expectedAdapter = instance.configuration.kind === "sec_latest_s1"
    ? "sec-latest-filings"
    : "house-financial-disclosures";
  if (
    instance.adapterId !== expectedAdapter ||
    new URL(instance.configuration.canonicalUrl).origin !== instance.authorityOrigin ||
    digestPublicSourceValue(instance.configuration) !== instance.configurationDigest
  ) {
    context.addIssue({ code: "custom", message: "source_instance_invalid" });
  }
});

const proposedCursorSchema = z.object({
  contentDigest: digestSchema,
  expectedRevision: z.number().int().nonnegative(),
  watermark: z.string().min(1).max(200),
}).strict();

const acquisitionStageReceiptSchema = z.object({
  errorCode: errorCodeSchema.nullable(),
  inputDigest: digestSchema,
  outputDigest: digestSchema.nullable(),
  stage: z.enum(["transport", "archive", "xml", "pdf", "normalize"]),
  status: z.enum(["complete", "partial", "unsupported", "failed"]),
}).strict().superRefine((receipt, context) => {
  if ((receipt.status === "complete") !== (receipt.errorCode === null)) {
    context.addIssue({ code: "custom", message: "stage_receipt_invalid" });
  }
});

export const publicSourceAcquisitionResultSchema = z.object({
  acquisitionId: idSchema,
  adapterDefinitionDigest: digestSchema,
  adapterId: adapterIdSchema,
  adapterVersion: semverSchema,
  baselineEstablished: z.boolean(),
  candidateFactRevisionIds: z.array(idSchema).max(PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition),
  correctionIds: z.array(idSchema).max(PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition),
  coverage: z.enum(["complete", "partial", "unsupported"]),
  errorCode: errorCodeSchema.nullable(),
  observedAt: timestampSchema,
  proposedNextCursor: proposedCursorSchema.nullable(),
  recordType: z.literal("public_source_acquisition_result"),
  retryAfterSeconds: z.number().int().positive().max(86_400).nullable(),
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
  stageReceipts: z
    .array(acquisitionStageReceiptSchema)
    .min(1)
    .max(PUBLIC_SOURCE_LIMITS.maximumStageReceipts),
  status: z.enum([
    "complete",
    "no_change",
    "partial",
    "retryable_failure",
    "terminal_failure",
    "uncertain",
  ]),
}).strict().superRefine((result, context) => {
  const successful = result.status === "complete" || result.status === "no_change";
  if (
    successful !== (result.coverage === "complete" && result.errorCode === null) ||
    successful !== (result.proposedNextCursor !== null) ||
    (!successful && result.errorCode === null) ||
    (result.status === "no_change" && result.candidateFactRevisionIds.length !== 0) ||
    ((result.status === "retryable_failure") !== (result.retryAfterSeconds !== null)) ||
    new Set(result.candidateFactRevisionIds).size !== result.candidateFactRevisionIds.length ||
    new Set(result.correctionIds).size !== result.correctionIds.length
  ) {
    context.addIssue({ code: "custom", message: "acquisition_result_invalid" });
  }
});

export const publicSourceAcquisitionJournalSchema = z.object({
  acquisitionId: idSchema,
  adapterDefinitionDigest: digestSchema,
  committedAt: timestampSchema.nullable(),
  correctionIds: z.array(idSchema).max(PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition),
  expectedCursorRevision: z.number().int().nonnegative(),
  factRevisionIds: z.array(idSchema).max(PUBLIC_SOURCE_LIMITS.maximumFactsPerAcquisition),
  preparedAt: timestampSchema,
  proposedCursor: proposedCursorSchema,
  recordType: z.literal("public_source_acquisition_journal"),
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
  status: z.enum(["prepared", "committed"]),
  window: z.object({
    endAt: timestampSchema,
    startAt: timestampSchema,
  }).strict(),
}).strict().superRefine((journal, context) => {
  if (
    journal.expectedCursorRevision !== journal.proposedCursor.expectedRevision ||
    (journal.status === "committed") !== (journal.committedAt !== null) ||
    journal.window.endAt <= journal.window.startAt ||
    new Set(journal.factRevisionIds).size !== journal.factRevisionIds.length ||
    new Set(journal.correctionIds).size !== journal.correctionIds.length
  ) {
    context.addIssue({ code: "custom", message: "acquisition_journal_invalid" });
  }
});

const nullableDateSchema = z.string().date().nullable();
const extractionSchema = z.object({
  errorCode: errorCodeSchema.nullable(),
  state: z.enum(["complete", "partial", "unsupported"]),
}).strict().superRefine((extraction, context) => {
  if ((extraction.state === "complete") !== (extraction.errorCode === null)) {
    context.addIssue({ code: "custom", message: "fact_extraction_invalid" });
  }
});

const secFilingPayloadSchema = z.object({
  accessionNumber: z.string().regex(/^\d{10}-\d{2}-\d{6}$/u),
  amendmentOfAccessionNumber: z.string().regex(/^\d{10}-\d{2}-\d{6}$/u).nullable(),
  cik: z.string().regex(/^\d{10}$/u),
  companyName: z.string().trim().min(1).max(300),
  fileNumber: z.string().trim().min(1).max(80).nullable(),
  filingUrl: publicUrlSchema,
  formType: z.enum(["S-1", "S-1/A"]),
  publishedAt: timestampSchema.nullable(),
  schemaVersion: z.literal("sec-filing/v1"),
  updatedAt: timestampSchema,
}).strict().superRefine((payload, context) => {
  if (payload.formType === "S-1" && payload.amendmentOfAccessionNumber !== null) {
    context.addIssue({ code: "custom", message: "sec_filing_amendment_invalid" });
  }
});

const houseFilerSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  prefix: z.string().trim().max(40).nullable(),
  stateDistrict: z.string().regex(/^[A-Z]{2}(?:\d{2}|AL)$/u),
  suffix: z.string().trim().max(40).nullable(),
}).strict();

const housePtrFilingPayloadSchema = z.object({
  amendedDocId: z.string().regex(/^\d{5,20}$/u).nullable(),
  docId: z.string().regex(/^\d{5,20}$/u),
  extraction: extractionSchema,
  filer: houseFilerSchema,
  filingDate: z.string().date(),
  isAmendment: z.boolean(),
  publicDocumentUrl: publicUrlSchema,
  schemaVersion: z.literal("house-ptr-filing/v1"),
  year: z.number().int().min(2012).max(2100),
}).strict().superRefine((payload, context) => {
  if (!payload.isAmendment && payload.amendedDocId !== null) {
    context.addIssue({ code: "custom", message: "house_filing_amendment_invalid" });
  }
});

const amountRangeSchema = z.object({
  label: z.string().trim().min(1).max(120),
  lower: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
  upper: z.string().regex(/^(?:0|[1-9]\d*)$/u).nullable(),
}).strict().superRefine((range, context) => {
  if ((range.lower === null) !== (range.upper === null)) {
    context.addIssue({ code: "custom", message: "house_amount_range_invalid" });
  }
});

const housePtrTransactionPayloadSchema = z.object({
  amountRange: amountRangeSchema,
  assetDescription: z.string().trim().min(1).max(1_000).nullable(),
  capitalGainsIndicator: z.enum(["yes", "no", "unknown"]),
  docId: z.string().regex(/^\d{5,20}$/u),
  extraction: extractionSchema,
  filingLogicalKey: idSchema,
  notificationDate: nullableDateSchema,
  ownerCode: z.string().trim().min(1).max(20).nullable(),
  publicDocumentUrl: publicUrlSchema,
  reportedTicker: z.string().regex(/^[A-Z0-9.-]{1,20}$/u).nullable(),
  rowIdentity: z.string().regex(/^row:\d+$/u),
  schemaVersion: z.literal("house-ptr-transaction/v1"),
  transactionDate: nullableDateSchema,
  transactionType: z.enum(["E", "P", "S"]).nullable(),
  year: z.number().int().min(2012).max(2100),
}).strict();

export const canonicalPublicFactPayloadSchema = z.discriminatedUnion("schemaVersion", [
  housePtrFilingPayloadSchema,
  housePtrTransactionPayloadSchema,
  secFilingPayloadSchema,
]);

export const canonicalPublicFactRevisionSchema = z.object({
  adapterId: adapterIdSchema,
  createdObservedAt: timestampSchema,
  extraction: extractionSchema,
  factSchemaVersion: factSchemaVersionSchema,
  logicalKey: idSchema,
  payload: canonicalPublicFactPayloadSchema,
  payloadDigest: digestSchema,
  provenance: z.object({
    authority: z.enum(["House Clerk", "SEC"]),
    documentDigest: digestSchema.nullable(),
    publicUrl: publicUrlSchema,
    rowEvidenceDigest: digestSchema.nullable(),
  }).strict(),
  recordType: z.literal("canonical_public_fact_revision"),
  revisionId: idSchema,
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
  sourceNativeId: z.string().trim().min(1).max(200),
  sourceTimes: z.object({
    publishedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema.nullable(),
  }).strict(),
  stableRowIdentity: z.string().trim().min(1).max(100),
}).strict().superRefine((fact, context) => {
  const payloadExtraction = "extraction" in fact.payload ? fact.payload.extraction : null;
  let expectedAdapterId: (typeof PUBLIC_SOURCE_ADAPTER_IDS)[number];
  let expectedAuthority: "House Clerk" | "SEC";
  let expectedPublicUrl: string;
  let expectedSourceNativeId: string;
  if (fact.payload.schemaVersion === "sec-filing/v1") {
    expectedAdapterId = "sec-latest-filings";
    expectedAuthority = "SEC";
    expectedPublicUrl = fact.payload.filingUrl;
    expectedSourceNativeId = `${fact.payload.accessionNumber}:${fact.payload.formType}`;
  } else {
    expectedAdapterId = "house-financial-disclosures";
    expectedAuthority = "House Clerk";
    expectedPublicUrl = fact.payload.publicDocumentUrl;
    expectedSourceNativeId = `${fact.payload.year}:${fact.payload.docId}`;
  }
  if (
    fact.adapterId !== expectedAdapterId ||
    fact.provenance.authority !== expectedAuthority ||
    fact.provenance.publicUrl !== expectedPublicUrl ||
    fact.sourceNativeId !== expectedSourceNativeId ||
    fact.factSchemaVersion !== fact.payload.schemaVersion ||
    (fact.payload.schemaVersion === "house-ptr-filing/v1" && fact.stableRowIdentity !== "filing") ||
    (fact.payload.schemaVersion === "house-ptr-transaction/v1" &&
      fact.stableRowIdentity !== fact.payload.rowIdentity) ||
    (payloadExtraction !== null &&
      (fact.extraction.state !== payloadExtraction.state ||
        fact.extraction.errorCode !== payloadExtraction.errorCode)) ||
    Buffer.byteLength(JSON.stringify(fact.payload), "utf8") >
      PUBLIC_SOURCE_LIMITS.maximumCanonicalPayloadBytes ||
    digestPublicSourceValue(fact.payload) !== fact.payloadDigest ||
    deriveCanonicalPublicFactLogicalKey(fact) !== fact.logicalKey ||
    deriveCanonicalPublicFactRevisionId(fact) !== fact.revisionId
  ) {
    context.addIssue({ code: "custom", message: "fact_invalid" });
  }
});

export function deriveCanonicalPublicFactLogicalKey(
  fact: Pick<z.input<typeof canonicalPublicFactRevisionSchema>, "adapterId" | "factSchemaVersion" | "sourceInstanceId" | "sourceNativeId" | "stableRowIdentity">,
): string {
  const digest = digestPublicSourceValue([
    fact.adapterId,
    fact.sourceInstanceId,
    fact.sourceNativeId,
    fact.factSchemaVersion,
    fact.stableRowIdentity,
  ]);
  return `fact.${digest}`;
}

export function deriveCanonicalPublicFactRevisionId(
  fact: Pick<z.input<typeof canonicalPublicFactRevisionSchema>, "logicalKey" | "payloadDigest">,
): string {
  return `fact-revision.${digestPublicSourceValue([fact.logicalKey, fact.payloadDigest])}`;
}

export const publicSourceCorrectionSchema = z.object({
  correctionId: idSchema,
  createdObservedAt: timestampSchema,
  fromRevisionId: idSchema,
  logicalKey: idSchema,
  reason: z.enum(["source_amendment", "source_correction", "parser_correction"]),
  recordType: z.literal("public_source_fact_correction"),
  schemaVersion: z.literal(1),
  toRevisionId: idSchema,
}).strict().superRefine((correction, context) => {
  if (
    correction.fromRevisionId === correction.toRevisionId ||
    correction.correctionId !== `correction.${digestPublicSourceValue([
      correction.logicalKey,
      correction.fromRevisionId,
      correction.toRevisionId,
      correction.reason,
    ])}`
  ) {
    context.addIssue({ code: "custom", message: "correction_invalid" });
  }
});

const subscriptionFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({
    forms: z.array(z.enum(["S-1", "S-1/A"])).min(1).max(2),
    kind: z.literal("sec_forms"),
  }).strict(),
]);

export const publicSourceSubscriptionSchema = z.object({
  adapterDefinitionDigest: digestSchema,
  adapterVersion: semverSchema,
  deliveryCursor: z.object({
    lastAcquisitionId: idSchema.nullable(),
    revision: z.number().int().nonnegative(),
  }).strict(),
  factSchemaVersions: z.array(factSchemaVersionSchema).min(1).max(3),
  filter: subscriptionFilterSchema,
  lifecycleState: z.enum(["active", "paused", "retired"]),
  monitorId: idSchema,
  packBinding: z.object({
    bindingRevision: z.number().int().positive(),
    packContentDigest: digestSchema,
    packId: idSchema,
    packVersion: semverSchema,
  }).strict().nullable(),
  recordType: z.literal("public_source_subscription"),
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
  subscriptionId: idSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((subscription, context) => {
  const schemaVersions = JSON.stringify(subscription.factSchemaVersions);
  const validSchemaSet =
    schemaVersions === JSON.stringify(["sec-filing/v1"]) ||
    schemaVersions === JSON.stringify([
      "house-ptr-filing/v1",
      "house-ptr-transaction/v1",
    ]);
  if (
    !validSchemaSet ||
    (subscription.filter.kind === "sec_forms" && schemaVersions !== JSON.stringify(["sec-filing/v1"]))
  ) {
    context.addIssue({ code: "custom", message: "subscription_invalid" });
  }
});

export const publicSourceProjectionSchema = z.object({
  acquisitionId: idSchema,
  factRevisionId: idSchema,
  factSchemaVersion: factSchemaVersionSchema,
  monitorId: idSchema,
  projectedAt: timestampSchema,
  projectionId: idSchema,
  recordType: z.literal("public_source_fact_projection"),
  schemaVersion: z.literal(1),
  sourceInstanceId: idSchema,
  subscriptionId: idSchema,
  workspaceId: z.string().uuid(),
}).strict().superRefine((projection, context) => {
  const expected = `projection.${digestPublicSourceValue([
    projection.subscriptionId,
    projection.factRevisionId,
  ])}`;
  if (projection.projectionId !== expected) {
    context.addIssue({ code: "custom", message: "projection_invalid" });
  }
});

export const publicSourceLogEventSchema = z.object({
  adapterId: adapterIdSchema,
  errorCode: errorCodeSchema.nullable(),
  event: z.enum(PUBLIC_SOURCE_LOG_EVENTS),
  factSchemaVersion: factSchemaVersionSchema.nullable(),
  outcome: z.enum([
    "complete",
    "no_change",
    "partial",
    "retryable_failure",
    "terminal_failure",
    "uncertain",
  ]).nullable(),
  stage: z.enum([
    "transport",
    "archive",
    "xml",
    "pdf",
    "normalize",
    "commit",
    "projection",
  ]).nullable(),
}).strict();

export const publicSourceRecordSchema = z.discriminatedUnion("recordType", [
  publicSourceAcquisitionJournalSchema,
  publicSourceAcquisitionResultSchema,
  publicSourceAdapterDefinitionSchema,
  canonicalPublicFactRevisionSchema,
  publicSourceCorrectionSchema,
  publicSourceInstanceSchema,
  publicSourceProjectionSchema,
  publicSourceSubscriptionSchema,
]);

export function parsePublicSourceRecord(value: unknown): z.infer<typeof publicSourceRecordSchema> {
  return publicSourceRecordSchema.parse(value);
}

export type PublicSourceAdapterDefinition = z.infer<typeof publicSourceAdapterDefinitionSchema>;
export type PublicSourceAcquisitionResult = z.infer<typeof publicSourceAcquisitionResultSchema>;
export type PublicSourceAcquisitionJournal = z.infer<typeof publicSourceAcquisitionJournalSchema>;
export type CanonicalPublicFactRevision = z.infer<typeof canonicalPublicFactRevisionSchema>;
export type PublicSourceCorrection = z.infer<typeof publicSourceCorrectionSchema>;
export type PublicSourceInstance = z.infer<typeof publicSourceInstanceSchema>;
export type PublicSourceProjection = z.infer<typeof publicSourceProjectionSchema>;
export type PublicSourceSubscription = z.infer<typeof publicSourceSubscriptionSchema>;
