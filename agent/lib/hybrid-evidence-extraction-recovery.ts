import { z } from "zod";

import type { HybridEvidenceJobRecord } from "./hybrid-evidence-job-store";
import {
  digestHybridEvidenceValue,
  hybridAcceptedResultSchema,
  hybridInvalidationRecordSchema,
  hybridPromotionRecordSchema,
  type EvidenceLocator,
  type HybridAcceptedResult,
  type HybridEvidenceJobDefinition,
  type HybridInvalidationRecord,
  type HybridPromotionRecord,
} from "./hybrid-evidence-schema";
import {
  HybridEvidencePdfError,
  type HybridEvidencePdfProjection,
} from "./hybrid-evidence-pdf";
import {
  readHybridEvidenceCellRange,
  validateSpreadsheetRoleCandidate,
  type HybridEvidenceWorkbookProjection,
  type SpreadsheetRoleCandidate,
} from "./hybrid-evidence-spreadsheet";

const pdfCitationSchema = z.object({
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.literal("pdf_page"),
  page: z.number().int().positive().max(8),
  region: z.object({
    height: z.number().positive().max(1),
    width: z.number().positive().max(1),
    x: z.number().nonnegative().lt(1),
    y: z.number().nonnegative().lt(1),
  }).strict().nullable(),
}).strict();

export const houseAmountRangeSchema = z.enum([
  "$1,001 - $15,000",
  "$15,001 - $50,000",
  "$50,001 - $100,000",
  "$100,001 - $250,000",
  "$250,001 - $500,000",
  "$500,001 - $1,000,000",
  "$1,000,001 - $5,000,000",
  "$5,000,001 - $25,000,000",
  "$25,000,001 - $50,000,000",
  "Over $50,000,000",
  "Spouse/DC Asset Over $1,000,000",
]);

export const houseDocumentRowWorkerCandidateSchema = z.object({
  citations: z.array(pdfCitationSchema).min(1).max(64),
  disposition: z.enum(["accepted", "quarantined"]),
  fields: z.object({
    document: z.object({
      docId: z.string().regex(/^\d{5,20}$/u),
      filerName: z.string().trim().min(1).max(320),
      filingDate: z.string().date(),
      isAmendment: z.boolean(),
      stateDistrict: z.string().regex(/^[A-Z]{2}(?:\d{2}|AL)$/u),
    }).strict(),
    rows: z.array(z.object({
      amountRange: houseAmountRangeSchema,
      assetDescription: z.string().trim().min(1).max(1_000),
      capitalGainsIndicator: z.enum(["yes", "no", "unknown"])
        .describe("Use unknown when the legacy form has no capital-gains field."),
      notificationDate: z.string().date(),
      ownerCode: z.string().trim().min(1).max(20).nullable(),
      page: z.number().int().positive().max(8),
      reportedTicker: z.string().regex(/^[A-Z0-9.-]{1,20}$/u).nullable()
        .describe("Use null unless a ticker is printed in the asset cell; never infer one."),
      transactionDate: z.string().date(),
      transactionType: z.enum(["E", "P", "S"])
        .describe("P=Purchase, S=Sale or Partial Sale, E=Exchange."),
    }).strict()).max(499),
  }).strict(),
  unknowns: z.array(z.string().min(1).max(200)).max(64),
}).strict();

export type HouseDocumentRowWorkerCandidate = z.infer<
  typeof houseDocumentRowWorkerCandidateSchema
>;

/* The direct extractor already has a signed page set. It identifies pages;
 * application code restores the opaque trusted locator fields before validation. */
export const houseDocumentRowModelCandidateSchema =
  houseDocumentRowWorkerCandidateSchema.extend({
    citations: z.array(z.object({
      page: z.number().int().positive().max(8),
    }).strict()).min(1).max(64),
  });

export type HouseDocumentRowModelCandidate = z.infer<
  typeof houseDocumentRowModelCandidateSchema
>;

const houseCandidateSchema = houseDocumentRowWorkerCandidateSchema;

const spreadsheetCandidateSchema = z.object({
  citations: z.array(z.object({
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    kind: z.literal("spreadsheet_range"),
    normalizedRangeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    range: z.string(),
    sheetId: z.string(),
  }).strict()).min(1).max(64),
  disposition: z.enum(["accepted", "quarantined"]),
  fields: z.object({
    amountColumn: z.string().optional(),
    assetColumn: z.string().optional(),
    dateColumn: z.string().optional(),
    range: z.string().optional(),
    sheetId: z.string().optional(),
  }).strict(),
  unknowns: z.array(z.string().min(1).max(200)).max(64),
}).strict();

export interface ExtractionParserOutcome {
  readonly errorCode: string | null;
  readonly plausibilityPassed: boolean;
  readonly relationshipPassed: boolean;
  readonly state: "complete" | "partial" | "suspicious" | "unsupported";
}

export type ExtractionRecoveryDecision =
  | Readonly<{ kind: "bypass" }>
  | Readonly<{ code: string; kind: "ineligible" | "quarantine" }>
  | Readonly<{ code: string; kind: "recover"; state: "partial" | "suspicious" | "unsupported" }>;

export function assessExtractionRecoveryEligibility(input: {
  readonly definition: HybridEvidenceJobDefinition | null;
  readonly outcome: ExtractionParserOutcome;
}): ExtractionRecoveryDecision {
  const outcome = input.outcome.state === "complete" &&
      (!input.outcome.plausibilityPassed || !input.outcome.relationshipPassed)
    ? { ...input.outcome, errorCode: "deterministic_false_success", state: "suspicious" as const }
    : input.outcome;
  if (outcome.state === "complete") return Object.freeze({ kind: "bypass" as const });
  if (!outcome.errorCode) return Object.freeze({ code: "validator_failed", kind: "quarantine" as const });
  if (!input.definition || !input.definition.triggeringParserCodes.includes(outcome.errorCode)) {
    return Object.freeze({ code: outcome.errorCode, kind: "ineligible" as const });
  }
  return Object.freeze({ code: outcome.errorCode, kind: "recover" as const, state: outcome.state });
}

function injectionDetected(values: Iterable<string>): boolean {
  const text = [...values].join(" ");
  return /(?:ignore|override|disregard).{0,80}(?:instruction|schema|system|tool)|(?:broker|trade).{0,40}(?:call|submit|execute)/iu.test(text);
}

function range(label: string) {
  const normalized = label.replace(/\s+/gu, " ").trim();
  if (normalized === "Spouse/DC Asset Over $1,000,000") {
    return Object.freeze({
      label: normalized,
      lower: "1000001",
      upper: null,
    });
  }
  const closed = /^\$\s*([\d,]+)\s*-\s*\$\s*([\d,]+)$/u.exec(normalized);
  const over = /^Over\s+\$\s*([\d,]+)$/iu.exec(normalized);
  if (!closed && !over) throw new HybridEvidencePdfError("independent_value_mismatch");
  return Object.freeze({
    label: normalized,
    lower: closed
      ? closed[1]!.replaceAll(",", "")
      : (BigInt(over![1]!.replaceAll(",", "")) + 1n).toString(),
    upper: closed ? closed[2]!.replaceAll(",", "") : null,
  });
}

function independentValueVariants(value: string): readonly string[] {
  const normalized = value.replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  // The legacy printed heading uses "Amount over"; the canonical K label
  // uses "Asset Over". Both retain the spouse/DC qualifier and exact amount.
  if (normalized === "spouse/dc asset over $1,000,000") {
    return Object.freeze([normalized, "spouse/dc amount over $1,000,000"]);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  return date
    ? Object.freeze([
        normalized,
        `${date[2]}/${date[3]}/${date[1]}`,
        `${Number(date[2])}/${Number(date[3])}/${date[1]}`,
      ])
    : Object.freeze([normalized]);
}

function normalizeIndependentEvidence(text: string): string {
  return text
    // OCR uses pipes as visual column separators. They are not evidence data.
    .replace(/[|\s]+/gu, " ")
    .replace(/(\$[\d,]+)\s*-\s*(\$[\d,]+)/gu, "$1 - $2")
    .trim()
    .toLocaleLowerCase("en-US");
}

function findIndependentValue(
  text: string,
  value: string,
  startAt = 0,
): Readonly<{ end: number; start: number }> | null {
  let found: { end: number; start: number } | null = null;
  for (const variant of independentValueVariants(value)) {
    let start = text.indexOf(variant, startAt);
    while (start !== -1) {
      const before = start === 0 ? "" : text[start - 1]!;
      const after = text[start + variant.length] ?? "";
      const bounded = !/[a-z0-9]/iu.test(before) && !/[a-z0-9]/iu.test(after);
      if (bounded) {
        if (!found || start < found.start) found = { end: start + variant.length, start };
        break;
      }
      start = text.indexOf(variant, start + 1);
    }
  }
  return found === null ? null : Object.freeze(found);
}

function assertIndependentDocument(input: {
  readonly document: z.infer<typeof houseCandidateSchema>["fields"]["document"];
  readonly textByPage: ReadonlyMap<number, string>;
}): void {
  const text = normalizeIndependentEvidence([...input.textByPage.values()].join(" "));
  const filerTokens = input.document.filerName
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/gu)
    .map((value) => value.trim())
    .filter((value) => value.length > 1 && !/^(?:hon|honorable|mr|mrs|ms|dr)$/iu.test(value));
  const identityTokens = filerTokens.length < 2
    ? filerTokens
    : [filerTokens[0]!, filerTokens.at(-1)!];
  if (
    identityTokens.length < 2 ||
    identityTokens.some((value) => !findIndependentValue(text, value)) ||
    !findIndependentValue(text, input.document.filingDate)
  ) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
  const initial = /\breportstatus\s*=\s*initial\b|\binitial report\s*\[x\]|\[x\]\s*initial report\b/iu.test(text);
  const amendment = /\breportstatus\s*=\s*amendment\b|\bamendment\s*\[x\]|\[x\]\s*amendment\b/iu.test(text);
  const legacyGrid = /\breportstatus\s*=\s*legacy_grid_no_status\b/iu.test(text);
  if (
    (input.document.isAmendment && (!amendment || initial || legacyGrid)) ||
    (!input.document.isAmendment && (amendment || (!initial && !legacyGrid)))
  ) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
  if (!/\bperiodic transaction report\b/iu.test(text)) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
}

function assertedTicker(assetDescription: string): string | null {
  return /\(([A-Z0-9.-]{1,20})\)\s*\[[A-Z]{1,8}\]/u.exec(assetDescription)?.[1] ?? null;
}

function assertIndependentRow(input: {
  readonly startAt: number;
  readonly page: number;
  readonly row: z.infer<typeof houseCandidateSchema>["fields"]["rows"][number];
  readonly textByPage: ReadonlyMap<number, string>;
}): number {
  const pageText = input.textByPage.get(input.page);
  const evidence = pageText === undefined ? undefined : normalizeIndependentEvidence(pageText);
  if (evidence === undefined) throw new HybridEvidencePdfError("citation_invalid");
  if (assertedTicker(input.row.assetDescription) !== input.row.reportedTicker) {
    throw new Error("source_relationship_invalid");
  }
  const values = [
    input.row.ownerCode,
    input.row.assetDescription,
    input.row.transactionType,
    input.row.transactionDate,
    input.row.notificationDate,
    input.row.amountRange,
    input.row.capitalGainsIndicator === "unknown"
      ? null
      : input.row.capitalGainsIndicator,
  ].filter((value): value is string => value !== null);
  let cursor: number | null = null;
  for (const value of values) {
    const found = findIndependentValue(evidence, value, cursor ?? input.startAt);
    if (!found || (cursor !== null && found.start - cursor > 600)) {
      throw new Error("source_relationship_invalid");
    }
    cursor = found.end;
  }
  return cursor ?? input.startAt;
}

export interface ValidatedHouseDocumentCandidate {
  readonly document: z.infer<typeof houseCandidateSchema>["fields"]["document"];
  readonly rows: readonly Readonly<{
    amountRange: ReturnType<typeof range>;
    assetDescription: string;
    capitalGainsIndicator: "no" | "unknown" | "yes";
    notificationDate: string;
    ownerCode: string | null;
    page: number;
    reportedTicker: string | null;
    rowEvidenceDigest: string;
    transactionDate: string;
    transactionType: "E" | "P" | "S";
  }>[];
}

export function validateHouseDocumentRowCandidate(input: {
  readonly artifactDigest: string;
  readonly candidate: unknown;
  readonly expected: {
    readonly docId: string;
    readonly filerName: string;
    readonly filingDate: string;
    readonly stateDistrict: string;
  };
  readonly independentTextByPage: ReadonlyMap<number, string>;
  readonly projection: HybridEvidencePdfProjection;
}): ValidatedHouseDocumentCandidate {
  const expectedPages = new Set(input.projection.pages.map(({ page }) => page));
  if (
    input.independentTextByPage.size !== expectedPages.size ||
    [...input.independentTextByPage].some(([page, text]) =>
      !expectedPages.has(page) || normalizeIndependentEvidence(text).length === 0)
  ) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
  if (injectionDetected(input.independentTextByPage.values())) {
    throw new Error("prompt_injection_detected");
  }
  const parsed = houseCandidateSchema.safeParse(input.candidate);
  if (!parsed.success) {
    const unknowns = input.candidate && typeof input.candidate === "object" &&
        Array.isArray(Reflect.get(input.candidate, "unknowns"))
      ? Reflect.get(input.candidate, "unknowns") as unknown[]
      : [];
    if (unknowns.includes("rowIdentity")) throw new Error("row_identity_ambiguous");
    if (unknowns.length > 0) throw new Error("required_field_unknown");
    throw new Error("schema_mismatch");
  }
  const candidate = parsed.data;
  if (candidate.disposition !== "accepted" || candidate.unknowns.length > 0) {
    if (candidate.unknowns.includes("rowIdentity")) throw new Error("row_identity_ambiguous");
    throw new Error("required_field_unknown");
  }
  if (
    candidate.fields.document.docId !== input.expected.docId ||
    candidate.fields.document.filerName !== input.expected.filerName ||
    candidate.fields.document.filingDate !== input.expected.filingDate ||
    candidate.fields.document.stateDistrict !== input.expected.stateDistrict
  ) throw new Error("source_relationship_invalid");
  const citations = new Map(candidate.citations.map((citation) => [citation.page, citation]));
  for (const citation of candidate.citations) {
    const page = input.projection.pages.find((item) => item.page === citation.page);
    if (
      citation.artifactDigest !== input.artifactDigest ||
      !page || citation.evidenceDigest !== page.evidenceDigest
    ) throw new HybridEvidencePdfError("citation_invalid");
  }
  assertIndependentDocument({
    document: candidate.fields.document,
    textByPage: input.independentTextByPage,
  });
  if (
    candidate.fields.rows.length === 0 &&
    !(
      [...input.independentTextByPage.values()].some((text) =>
        /\bno reportable transactions\b/iu.test(text)) ||
      [...input.independentTextByPage.values()].every((text) =>
        /\bno_transaction_rows\s*=\s*true\b/iu.test(normalizeIndependentEvidence(text)))
    )
  ) throw new Error("source_relationship_invalid");
  const pageCursors = new Map<number, number>();
  let priorPage = 0;
  const rows = candidate.fields.rows.map((row, index) => {
    if (!citations.has(row.page)) throw new HybridEvidencePdfError("citation_invalid");
    if (row.page < priorPage) throw new Error("row_identity_ambiguous");
    priorPage = row.page;
    pageCursors.set(row.page, assertIndependentRow({
      startAt: pageCursors.get(row.page) ?? 0,
      page: row.page, row, textByPage: input.independentTextByPage,
    }));
    return Object.freeze({
      ...row,
      amountRange: range(row.amountRange),
      rowEvidenceDigest: digestHybridEvidenceValue([
        input.artifactDigest,
        row.page,
        index,
        row,
      ]),
    });
  });
  // The normalized independent row contract carries two dates and an amount
  // after a transaction code. Count those rows independently: a supported
  // subset is not a complete extraction, even if each returned row is valid.
  for (const [page, text] of input.independentTextByPage) {
    const evidence = normalizeIndependentEvidence(text);
    const date = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})`;
    const rowPattern = new RegExp(String.raw`\b[PSE]\s+${date}\s+${date}\s+(?:\$|Over\s+\$|Spouse/DC)`, "giu");
    const independentCount = [...evidence.matchAll(rowPattern)].length;
    const candidateCount = rows.filter((row) => row.page === page).length;
    if (independentCount === 0 && candidateCount === 0) {
      // Legitimate cover/footer/instruction pages must say so explicitly; an
      // unreadable page is never evidence that it has no transactions.
      if (!/\bno_transaction_rows\s*=\s*true\b|\bno reportable transactions\b/iu.test(evidence)) {
        throw new HybridEvidencePdfError("independent_value_mismatch");
      }
    } else if (independentCount !== candidateCount) {
      throw new Error("row_identity_ambiguous");
    }
  }
  return Object.freeze({ document: candidate.fields.document, rows: Object.freeze(rows) });
}

export function validateSpreadsheetMappingCandidate(input: {
  readonly artifactDigest: string;
  readonly candidate: unknown;
  readonly projection: HybridEvidenceWorkbookProjection;
}): Readonly<SpreadsheetRoleCandidate> {
  const candidate = spreadsheetCandidateSchema.parse(input.candidate);
  if (candidate.disposition !== "accepted" || candidate.unknowns.length > 0) {
    throw new Error("required_field_unknown");
  }
  const fields = candidate.fields;
  if (!fields.amountColumn || !fields.assetColumn || !fields.dateColumn || !fields.range || !fields.sheetId) {
    throw new Error("required_field_unknown");
  }
  if (injectionDetected(input.projection.sheets.flatMap((sheet) => sheet.rows.flat()))) {
    throw new Error("prompt_injection_detected");
  }
  const citation = candidate.citations.find((item) =>
    item.artifactDigest === input.artifactDigest &&
    item.sheetId === fields.sheetId &&
    item.range === fields.range);
  if (!citation) throw new Error("citation_invalid");
  const cited = readHybridEvidenceCellRange({
    projection: input.projection,
    range: fields.range,
    sheetId: fields.sheetId,
  });
  if (cited.digest !== citation.normalizedRangeDigest) throw new Error("citation_invalid");
  const validated = validateSpreadsheetRoleCandidate({
    candidate: fields as SpreadsheetRoleCandidate,
    projection: input.projection,
  });
  return validated;
}

export function createAcceptedExtractionResult(input: {
  readonly citations: readonly EvidenceLocator[];
  readonly definition: HybridEvidenceJobDefinition;
  readonly job: HybridEvidenceJobRecord;
  readonly now: Date;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly paidCostUsd: string;
  };
}): HybridAcceptedResult {
  if (input.job.job.state !== "completed" || !input.job.candidateDigest) {
    throw new Error("job_conflict");
  }
  const outputDigest = digestHybridEvidenceValue(input.payload);
  return hybridAcceptedResultSchema.parse({
    citations: input.citations,
    definition: {
      definitionDigest: input.definition.definitionDigest,
      definitionId: input.definition.definitionId,
      definitionVersion: input.definition.definitionVersion,
    },
    disposition: "accepted",
    inputDigest: input.job.job.inputDigest,
    jobId: input.job.job.jobId,
    model: {
      modelId: input.job.job.modelId,
      modelOutputDigest: input.job.candidateDigest,
      promptTemplateDigest: input.definition.instructionTemplate.digest,
    },
    outputDigest,
    payload: input.payload,
    purpose: "extraction_recovery",
    recordType: "hybrid_evidence_accepted_result",
    resultId: `hybrid-result.${digestHybridEvidenceValue([
      input.job.job.jobId,
      input.job.candidateDigest,
      outputDigest,
      input.definition.requiredValidator,
    ])}`,
    schemaVersion: 1,
    scope: input.job.job.scope,
    uncertainty: { confidence: null, coverage: "complete", unknowns: [] },
    usage: input.usage,
    validatedAt: input.now.toISOString(),
    validationTrace: [{
      errorCode: null,
      outcome: "passed",
      validatorId: input.definition.requiredValidator.validatorId,
      validatorVersion: input.definition.requiredValidator.version,
    }],
  });
}

export function createHybridPromotionRecord(input: {
  readonly canonicalFactRevisionIds: readonly string[];
  readonly correctionIds: readonly string[];
  readonly now: Date;
  readonly resultId: string;
  readonly retractionIds: readonly string[];
}): HybridPromotionRecord {
  const ids = {
    canonicalFactRevisionIds: [...input.canonicalFactRevisionIds],
    correctionIds: [...input.correctionIds],
    retractionIds: [...input.retractionIds],
  };
  return hybridPromotionRecordSchema.parse({
    ...ids,
    createdAt: input.now.toISOString(),
    promotionId: `hybrid-promotion.${digestHybridEvidenceValue([input.resultId, ids])}`,
    recordType: "hybrid_evidence_promotion",
    resultId: input.resultId,
    schemaVersion: 1,
  });
}

export function createHybridSourceInvalidation(input: {
  readonly now: Date;
  readonly resultId: string;
  readonly sourceDigest: string;
  readonly sourceRevision: string;
  readonly supersedingResultId: string | null;
}): HybridInvalidationRecord {
  return hybridInvalidationRecordSchema.parse({
    cause: { digest: input.sourceDigest, kind: "source_revision", revision: input.sourceRevision },
    createdAt: input.now.toISOString(),
    invalidationId: `hybrid-invalidation.${digestHybridEvidenceValue([
      input.resultId,
      input.sourceDigest,
      input.sourceRevision,
      input.supersedingResultId,
    ])}`,
    recordType: "hybrid_evidence_invalidation",
    resultId: input.resultId,
    schemaVersion: 1,
    supersedingResultId: input.supersedingResultId,
  });
}
