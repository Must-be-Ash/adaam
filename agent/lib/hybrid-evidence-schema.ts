import { createHash } from "node:crypto";

import { z } from "zod";

export const HYBRID_EVIDENCE_SCHEMA_VERSION = 1;

export const HYBRID_EVIDENCE_LANES = [
  "source_global_extraction",
  "workspace_semantic",
] as const;

export const HYBRID_EVIDENCE_JOB_STATES = [
  "accepted",
  "completed",
  "failed",
  "prepared",
  "quarantined",
  "running",
  "uncertain",
] as const;

export const HYBRID_EVIDENCE_ERROR_CODES = [
  "artifact_access_not_public",
  "artifact_bounds_exceeded",
  "artifact_digest_mismatch",
  "artifact_quota_exceeded",
  "budget_exhausted",
  "capability_denied",
  "citation_invalid",
  "column_mapping_ambiguous",
  "definition_digest_mismatch",
  "definition_not_found",
  "deterministic_false_success",
  "evidence_bounds_exceeded",
  "execution_failed",
  "execution_uncertain",
  "forbidden_tool",
  "hostile_document",
  "independent_value_mismatch",
  "input_projection_invalid",
  "job_conflict",
  "locator_out_of_bounds",
  "model_denied",
  "model_output_invalid",
  "prompt_injection_detected",
  "required_field_unknown",
  "row_identity_ambiguous",
  "schema_mismatch",
  "source_relationship_invalid",
  "storage_unavailable",
  "unsupported_layout",
  "validator_failed",
  "workspace_scope_mismatch",
] as const;

export const HYBRID_EVIDENCE_EVENTS = [
  "hybrid_artifact_retained",
  "hybrid_job_accepted",
  "hybrid_job_completed",
  "hybrid_job_failed",
  "hybrid_job_prepared",
  "hybrid_job_quarantined",
  "hybrid_job_running",
  "hybrid_job_uncertain",
  "hybrid_result_invalidated",
  "hybrid_result_promoted",
] as const;

export const HYBRID_EVIDENCE_LIMITS = Object.freeze({
  maximumArtifactBytes: 10 * 1_024 * 1_024,
  maximumArtifactCharacters: 200_000,
  maximumArtifactColumns: 128,
  maximumArtifactPages: 8,
  maximumArtifactRows: 2_000,
  maximumArtifactSheets: 16,
  maximumCitations: 64,
  maximumDefinitionModels: 8,
  maximumDefinitionParserCodes: 32,
  maximumPayloadBytes: 64 * 1_024,
  maximumUnknowns: 64,
  maximumValidationSteps: 16,
});

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const semverSchema = z.string().regex(
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u,
);
const identifierSchema = z.string().min(3).max(200).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u,
);
const slugSchema = z.string().min(3).max(120).regex(
  /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u,
);
const timestampSchema = z.string().datetime({ offset: true });
const errorCodeSchema = z.enum(HYBRID_EVIDENCE_ERROR_CODES);
const stateSchema = z.enum(HYBRID_EVIDENCE_JOB_STATES);
const purposeSchema = z.enum([
  "extraction_recovery",
  "semantic_interpretation",
]);

export const hybridEvidenceLaneSchema = z.enum(HYBRID_EVIDENCE_LANES);
export const hybridEvidenceErrorCodeSchema = errorCodeSchema;
export const hybridEvidenceEventSchema = z.enum(HYBRID_EVIDENCE_EVENTS);

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

export function digestHybridEvidenceValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function sortedUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function safePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.toString() !== value
    ) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|credential|password|secret|signature|token)/iu.test(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function boundedStructuredValue(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > HYBRID_EVIDENCE_LIMITS.maximumPayloadBytes) {
      return false;
    }
    const visit = (candidate: unknown, depth: number): boolean => {
      if (depth > 8) return false;
      if (candidate === null || typeof candidate === "boolean") return true;
      if (typeof candidate === "number") return Number.isFinite(candidate);
      if (typeof candidate === "string") return candidate.length <= 8_000;
      if (Array.isArray(candidate)) {
        return candidate.length <= 128 && candidate.every((child) => visit(child, depth + 1));
      }
      if (typeof candidate !== "object") return false;
      const entries = Object.entries(candidate as Record<string, unknown>);
      return entries.length <= 128 && entries.every(
        ([key, child]) => key.length <= 120 && visit(child, depth + 1),
      );
    };
    return visit(value, 0);
  } catch {
    return false;
  }
}

const publicUrlSchema = z.string().max(2_048).refine(safePublicUrl);
const mediaTypeSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/xml",
  "text/html",
  "text/plain",
]);

const artifactStructureSchema = z.object({
  characterCount: z.number().int().nonnegative().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactCharacters,
  ).nullable(),
  columnCount: z.number().int().nonnegative().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactColumns,
  ).nullable(),
  pageCount: z.number().int().nonnegative().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactPages,
  ).nullable(),
  rowCount: z.number().int().nonnegative().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactRows,
  ).nullable(),
  sheetCount: z.number().int().nonnegative().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactSheets,
  ).nullable(),
}).strict();

export const evidenceArtifactManifestSchema = z.object({
  accessClassification: z.literal("public"),
  acquisitionId: identifierSchema,
  artifactId: identifierSchema,
  authority: z.string().trim().min(2).max(160),
  byteCount: z.number().int().positive().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes,
  ),
  canonicalPublicUrl: publicUrlSchema,
  contentDigest: digestSchema,
  mediaType: mediaTypeSchema,
  observedAt: timestampSchema,
  parserEligibility: z.object({
    adapterId: identifierSchema,
    factSchemaVersion: identifierSchema,
    outcomeDigest: digestSchema,
    reasonCode: identifierSchema,
    state: z.enum(["partial", "suspicious", "unsupported"]),
  }).strict().nullable(),
  recordType: z.literal("hybrid_evidence_artifact"),
  retention: z.object({
    expiresAt: timestampSchema.nullable(),
    state: z.enum(["active", "orphaned", "quarantined"]),
  }).strict(),
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
  sourceInstanceId: identifierSchema,
  storageKey: z.string().regex(
    /^hybrid-evidence\/sha256\/[a-f0-9]{64}$/u,
  ),
  structure: artifactStructureSchema,
}).strict().superRefine((artifact, context) => {
  const isPdf = artifact.mediaType === "application/pdf";
  const isSpreadsheet = artifact.mediaType ===
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (
    (isPdf && artifact.structure.pageCount === null) ||
    (isSpreadsheet && (
      artifact.structure.sheetCount === null ||
      artifact.structure.rowCount === null ||
      artifact.structure.columnCount === null
    )) ||
    artifact.storageKey !== `hybrid-evidence/sha256/${artifact.contentDigest}` ||
    ((artifact.retention.state === "active") !== (artifact.retention.expiresAt === null)) ||
    (artifact.retention.expiresAt !== null && artifact.retention.expiresAt <= artifact.observedAt)
  ) {
    context.addIssue({ code: "custom", message: "artifact_structure_invalid" });
  }
});

const pdfPageLocatorSchema = z.object({
  artifactDigest: digestSchema,
  evidenceDigest: digestSchema,
  kind: z.literal("pdf_page"),
  page: z.number().int().positive().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactPages),
  region: z.object({
    height: z.number().positive().max(1),
    width: z.number().positive().max(1),
    x: z.number().nonnegative().lt(1),
    y: z.number().nonnegative().lt(1),
  }).strict().nullable(),
}).strict().superRefine((locator, context) => {
  if (locator.region && (
    locator.region.x + locator.region.width > 1 ||
    locator.region.y + locator.region.height > 1
  )) {
    context.addIssue({ code: "custom", message: "locator_out_of_bounds" });
  }
});

const spreadsheetRangeLocatorSchema = z.object({
  artifactDigest: digestSchema,
  kind: z.literal("spreadsheet_range"),
  normalizedRangeDigest: digestSchema,
  range: z.string().min(2).max(40).regex(/^[A-Z]{1,3}[1-9]\d*:[A-Z]{1,3}[1-9]\d*$/u),
  sheetId: z.string().min(1).max(80),
}).strict();

const textSpanLocatorSchema = z.object({
  artifactDigest: digestSchema,
  end: z.number().int().positive().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactCharacters),
  kind: z.literal("text_span"),
  spanDigest: digestSchema,
  start: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactCharacters),
}).strict().superRefine((locator, context) => {
  if (locator.start >= locator.end) {
    context.addIssue({ code: "custom", message: "locator_out_of_bounds" });
  }
});

const sourceFactLocatorSchema = z.object({
  factRevisionId: identifierSchema,
  kind: z.literal("source_fact"),
  payloadDigest: digestSchema,
}).strict();

export const evidenceLocatorSchema = z.union([
  pdfPageLocatorSchema,
  spreadsheetRangeLocatorSchema,
  textSpanLocatorSchema,
  sourceFactLocatorSchema,
]);

const schemaReferenceSchema = z.object({
  schemaId: slugSchema,
  schemaVersion: semverSchema,
}).strict();

const definitionLimitsSchema = z.object({
  maximumAttempts: z.number().int().positive().max(3),
  maximumEvidenceBytes: z.number().int().positive().max(
    HYBRID_EVIDENCE_LIMITS.maximumArtifactBytes,
  ),
  maximumInputTokens: z.number().int().positive().max(200_000),
  maximumOutputTokens: z.number().int().positive().max(20_000),
  maximumPages: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactPages),
  maximumPaidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/u),
  maximumRows: z.number().int().nonnegative().max(HYBRID_EVIDENCE_LIMITS.maximumArtifactRows),
  maximumRuntimeMs: z.number().int().positive().max(300_000),
}).strict();

export const hybridEvidenceJobDefinitionSchema = z.object({
  accessClassifications: z.array(z.literal("public")).length(1),
  allowedAdapterIds: z.array(identifierSchema).min(1).max(16),
  allowedMediaTypes: z.array(mediaTypeSchema).min(1).max(8),
  allowedModelIds: z.array(identifierSchema).min(1).max(
    HYBRID_EVIDENCE_LIMITS.maximumDefinitionModels,
  ),
  definitionDigest: digestSchema,
  definitionId: slugSchema,
  definitionVersion: semverSchema,
  inputProjection: schemaReferenceSchema,
  instructionTemplate: z.object({
    delimiterPolicy: identifierSchema,
    digest: digestSchema,
    templateId: slugSchema,
    version: semverSchema,
  }).strict(),
  limits: definitionLimitsSchema,
  outputSchema: schemaReferenceSchema,
  purpose: purposeSchema,
  recordType: z.literal("hybrid_evidence_job_definition"),
  requiredValidator: z.object({
    validatorId: slugSchema,
    version: semverSchema,
  }).strict(),
  resultScope: z.enum(["source_global", "workspace"]),
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
  triggeringParserCodes: z.array(identifierSchema).max(
    HYBRID_EVIDENCE_LIMITS.maximumDefinitionParserCodes,
  ),
}).strict().superRefine((definition, context) => {
  const { definitionDigest: _definitionDigest, ...digestInput } = definition;
  const correctScope = definition.purpose === "extraction_recovery"
    ? "source_global"
    : "workspace";
  if (
    definition.resultScope !== correctScope ||
    !sortedUnique(definition.allowedAdapterIds) ||
    !sortedUnique(definition.allowedMediaTypes) ||
    !sortedUnique(definition.allowedModelIds) ||
    !sortedUnique(definition.triggeringParserCodes) ||
    ((definition.purpose === "extraction_recovery") !==
      (definition.triggeringParserCodes.length > 0)) ||
    definition.definitionDigest !== digestHybridEvidenceValue(digestInput)
  ) {
    context.addIssue({ code: "custom", message: "definition_digest_mismatch" });
  }
});

const sourceGlobalScopeSchema = z.object({
  initiatingWorkspaceId: identifierSchema,
  kind: z.literal("source_global"),
  sourceInstanceId: identifierSchema,
}).strict();

const workspaceScopeSchema = z.object({
  bindingRevision: z.number().int().positive(),
  kind: z.literal("workspace"),
  ownerId: identifierSchema,
  packContentDigest: digestSchema,
  packId: identifierSchema,
  packVersion: semverSchema,
  workspaceId: identifierSchema,
}).strict();

export const hybridEvidenceScopeSchema = z.union([
  sourceGlobalScopeSchema,
  workspaceScopeSchema,
]);

export const hybridEvidenceJobSchema = z.object({
  artifactDigests: z.array(digestSchema).min(1).max(16),
  attempt: z.number().int().nonnegative().max(3),
  budgetReservation: z.object({
    key: identifierSchema,
    kind: z.literal("hybrid_model_attempt"),
    scope: z.enum(["deployment_source_recovery", "workspace"]),
  }).strict(),
  completedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  definitionDigest: digestSchema,
  definitionId: slugSchema,
  definitionVersion: semverSchema,
  idempotencyKey: digestSchema,
  jobId: identifierSchema,
  locatorDigests: z.array(digestSchema).min(1).max(HYBRID_EVIDENCE_LIMITS.maximumCitations),
  modelId: identifierSchema,
  purpose: purposeSchema,
  recordType: z.literal("hybrid_evidence_job"),
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
  scope: hybridEvidenceScopeSchema,
  startedAt: timestampSchema.nullable(),
  state: stateSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((job, context) => {
  const terminal = ["accepted", "failed", "quarantined", "uncertain"].includes(job.state);
  const expectedBudgetScope = job.scope.kind === "source_global"
    ? "deployment_source_recovery"
    : "workspace";
  const expectedScope = job.purpose === "extraction_recovery"
    ? "source_global"
    : "workspace";
  const timestampsOrdered =
    job.createdAt <= job.updatedAt &&
    (job.startedAt === null || job.createdAt <= job.startedAt) &&
    (job.completedAt === null || (
      job.startedAt !== null &&
      job.startedAt <= job.completedAt &&
      job.completedAt <= job.updatedAt
    ));
  if (
    !sortedUnique(job.artifactDigests) ||
    !sortedUnique(job.locatorDigests) ||
    job.budgetReservation.scope !== expectedBudgetScope ||
    job.scope.kind !== expectedScope ||
    !timestampsOrdered ||
    (job.state === "prepared" && (
      job.attempt !== 0 || job.startedAt !== null || job.completedAt !== null
    )) ||
    (job.state === "running" && (
      job.attempt === 0 || job.startedAt === null || job.completedAt !== null
    )) ||
    ((job.state === "completed" || terminal) && (
      job.attempt === 0 || job.startedAt === null || job.completedAt === null
    ))
  ) {
    context.addIssue({ code: "custom", message: "job_lifecycle_invalid" });
  }
});

const validationTraceSchema = z.object({
  errorCode: errorCodeSchema.nullable(),
  outcome: z.enum(["failed", "passed"]),
  validatorId: slugSchema,
  validatorVersion: semverSchema,
}).strict().superRefine((trace, context) => {
  if ((trace.outcome === "passed") !== (trace.errorCode === null)) {
    context.addIssue({ code: "custom", message: "validation_trace_invalid" });
  }
});

const payloadSchema = z.record(z.string().min(1).max(120), z.unknown()).refine(
  boundedStructuredValue,
  "result_payload_out_of_bounds",
);

export const hybridAcceptedResultSchema = z.object({
  citations: z.array(evidenceLocatorSchema).max(HYBRID_EVIDENCE_LIMITS.maximumCitations),
  definition: z.object({
    definitionDigest: digestSchema,
    definitionId: slugSchema,
    definitionVersion: semverSchema,
  }).strict(),
  disposition: z.enum(["accepted", "abstained"]),
  inputDigest: digestSchema,
  jobId: identifierSchema,
  model: z.object({
    modelId: identifierSchema,
    modelOutputDigest: digestSchema,
    promptTemplateDigest: digestSchema,
  }).strict(),
  outputDigest: digestSchema,
  payload: payloadSchema,
  purpose: purposeSchema,
  recordType: z.literal("hybrid_evidence_accepted_result"),
  resultId: identifierSchema,
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
  scope: hybridEvidenceScopeSchema,
  uncertainty: z.object({
    confidence: z.number().min(0).max(1).nullable(),
    coverage: z.enum(["complete", "partial", "unknown"]),
    unknowns: z.array(z.string().min(1).max(200)).max(
      HYBRID_EVIDENCE_LIMITS.maximumUnknowns,
    ),
  }).strict(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().max(200_000),
    outputTokens: z.number().int().nonnegative().max(20_000),
    paidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/u),
  }).strict(),
  validatedAt: timestampSchema,
  validationTrace: z.array(validationTraceSchema).min(1).max(
    HYBRID_EVIDENCE_LIMITS.maximumValidationSteps,
  ),
}).strict().superRefine((result, context) => {
  const correctScope = result.purpose === "extraction_recovery"
    ? "source_global"
    : "workspace";
  if (
    result.scope.kind !== correctScope ||
    (result.disposition === "accepted" && result.citations.length === 0) ||
    (result.disposition === "abstained" && result.purpose !== "semantic_interpretation") ||
    result.validationTrace.some(({ outcome }) => outcome !== "passed")
  ) {
    context.addIssue({ code: "custom", message: "accepted_result_invalid" });
  }
});

export const hybridPromotionRecordSchema = z.object({
  canonicalFactRevisionIds: z.array(identifierSchema).max(500),
  correctionIds: z.array(identifierSchema).max(500),
  createdAt: timestampSchema,
  promotionId: identifierSchema,
  recordType: z.literal("hybrid_evidence_promotion"),
  resultId: identifierSchema,
  retractionIds: z.array(identifierSchema).max(500),
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
}).strict().superRefine((promotion, context) => {
  const allIds = [
    ...promotion.canonicalFactRevisionIds,
    ...promotion.correctionIds,
    ...promotion.retractionIds,
  ];
  if (allIds.length === 0 || new Set(allIds).size !== allIds.length) {
    context.addIssue({ code: "custom", message: "promotion_lineage_invalid" });
  }
});

export const hybridInvalidationRecordSchema = z.object({
  cause: z.object({
    digest: digestSchema,
    kind: z.enum([
      "binding_revision",
      "definition_revision",
      "pack_revision",
      "source_revision",
      "validator_revision",
    ]),
    revision: identifierSchema,
  }).strict(),
  createdAt: timestampSchema,
  invalidationId: identifierSchema,
  recordType: z.literal("hybrid_evidence_invalidation"),
  resultId: identifierSchema,
  schemaVersion: z.literal(HYBRID_EVIDENCE_SCHEMA_VERSION),
  supersedingResultId: identifierSchema.nullable(),
}).strict().superRefine((invalidation, context) => {
  if (invalidation.supersedingResultId === invalidation.resultId) {
    context.addIssue({ code: "custom", message: "invalidation_lineage_invalid" });
  }
});

export const hybridEvidenceObservationSchema = z.object({
  definitionVersion: semverSchema.optional(),
  errorCode: errorCodeSchema.nullable().optional(),
  event: hybridEvidenceEventSchema,
  modelFamily: slugSchema.optional(),
  purpose: purposeSchema,
  state: stateSchema.optional(),
  validatorOutcome: z.enum(["failed", "passed", "skipped"]).optional(),
  value: z.number().int().positive().max(1_000).default(1),
}).strict();

export type EvidenceArtifactManifest = z.infer<typeof evidenceArtifactManifestSchema>;
export type EvidenceLocator = z.infer<typeof evidenceLocatorSchema>;
export type HybridEvidenceJobDefinition = z.infer<typeof hybridEvidenceJobDefinitionSchema>;
export type HybridEvidenceJob = z.infer<typeof hybridEvidenceJobSchema>;
export type HybridAcceptedResult = z.infer<typeof hybridAcceptedResultSchema>;
export type HybridEvidenceObservation = z.infer<typeof hybridEvidenceObservationSchema>;

export function parseHybridEvidenceRecord(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new Error("hybrid_evidence_record_invalid");
  }
  switch (Reflect.get(value, "recordType")) {
    case "hybrid_evidence_artifact":
      return evidenceArtifactManifestSchema.parse(value);
    case "hybrid_evidence_job_definition":
      return hybridEvidenceJobDefinitionSchema.parse(value);
    case "hybrid_evidence_job":
      return hybridEvidenceJobSchema.parse(value);
    case "hybrid_evidence_accepted_result":
      return hybridAcceptedResultSchema.parse(value);
    case "hybrid_evidence_promotion":
      return hybridPromotionRecordSchema.parse(value);
    case "hybrid_evidence_invalidation":
      return hybridInvalidationRecordSchema.parse(value);
    default:
      throw new Error("hybrid_evidence_record_invalid");
  }
}
