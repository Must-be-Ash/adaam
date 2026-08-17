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

const houseCandidateSchema = z.object({
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
      amountRange: z.string().trim().min(1).max(120),
      assetDescription: z.string().trim().min(1).max(1_000),
      capitalGainsIndicator: z.enum(["yes", "no", "unknown"]),
      notificationDate: z.string().date(),
      ownerCode: z.string().trim().min(1).max(20).nullable(),
      page: z.number().int().positive().max(8),
      reportedTicker: z.string().regex(/^[A-Z0-9.-]{1,20}$/u).nullable(),
      transactionDate: z.string().date(),
      transactionType: z.enum(["E", "P", "S"]),
    }).strict()).max(499),
  }).strict(),
  unknowns: z.array(z.string().min(1).max(200)).max(64),
}).strict();

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
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  return date
    ? Object.freeze([
        normalized,
        `${date[2]}/${date[3]}/${date[1]}`,
        `${Number(date[2])}/${Number(date[3])}/${date[1]}`,
      ])
    : Object.freeze([normalized]);
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
  const text = [...input.textByPage.values()]
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  for (const value of [
    input.document.docId,
    input.document.filerName,
    input.document.filingDate,
    input.document.stateDistrict,
  ]) {
    if (!findIndependentValue(text, value)) {
      throw new HybridEvidencePdfError("independent_value_mismatch");
    }
  }
  const amendment = /\bamend(?:ed|ment)\b/iu.test(text);
  if (input.document.isAmendment !== amendment) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
  if (!input.document.isAmendment && !/\bperiodic transaction report\b/iu.test(text)) {
    throw new HybridEvidencePdfError("independent_value_mismatch");
  }
}

function assertedTicker(assetDescription: string): string | null {
  return /\(([A-Z0-9.-]{1,20})\)\s*\[[A-Z]{1,8}\]/u.exec(assetDescription)?.[1] ?? null;
}

function assertIndependentRow(input: {
  readonly page: number;
  readonly row: z.infer<typeof houseCandidateSchema>["fields"]["rows"][number];
  readonly textByPage: ReadonlyMap<number, string>;
}): void {
  const evidence = input.textByPage.get(input.page)
    ?.replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
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
    const found = findIndependentValue(evidence, value, cursor ?? 0);
    if (!found || (cursor !== null && found.start - cursor > 600)) {
      throw new Error("source_relationship_invalid");
    }
    cursor = found.end;
  }
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
    ![...input.independentTextByPage.values()].some((text) =>
      /\bno reportable transactions\b/iu.test(text))
  ) throw new Error("source_relationship_invalid");
  const rows = candidate.fields.rows.map((row) => {
    if (!citations.has(row.page)) throw new HybridEvidencePdfError("citation_invalid");
    assertIndependentRow({ page: row.page, row, textByPage: input.independentTextByPage });
    return Object.freeze({
      ...row,
      amountRange: range(row.amountRange),
      rowEvidenceDigest: digestHybridEvidenceValue([
        input.artifactDigest,
        row.page,
        row,
      ]),
    });
  });
  if (new Set(rows.map((row) => row.rowEvidenceDigest)).size !== rows.length) {
    throw new Error("row_identity_ambiguous");
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
