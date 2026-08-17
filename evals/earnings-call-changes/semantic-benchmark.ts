import { z } from "zod";

const boundedText = z.string().trim().min(1).max(4_000);

export const earningsSemanticBenchmarkSchema = z.object({
  benchmarkId: z.literal("earnings-call-changes-semantic-v1"),
  cases: z.array(z.object({
    evidence: z.object({
      current: z.object({ preparedRemarks: boundedText, questionsAndAnswers: boundedText }).strict(),
      prior: z.object({ preparedRemarks: boundedText, questionsAndAnswers: boundedText }).strict(),
      yearAgo: z.object({ preparedRemarks: boundedText, questionsAndAnswers: boundedText }).strict().nullable(),
    }).strict(),
    expected: z.object({
      citationSides: z.array(z.enum(["current", "prior", "year_ago"])).min(1).max(3),
      direction: z.enum(["negative", "neutral", "positive", "uncertain"]),
      materialChange: z.boolean(),
      outcome: z.enum(["accepted", "abstained", "no_change", "quarantined"]),
      reasonCodes: z.array(z.enum([
        "citation_invalid",
        "contradictory_evidence_unresolved",
        "evidence_incomplete",
        "hostile_source_instruction",
        "material_change",
        "no_change",
        "seasonal_context_required",
        "unsupported_numeric_precision",
      ])).min(1).max(3),
      stance: z.enum(["cautious", "constructive", "no_view", "watch"]),
    }).strict(),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    review: z.object({
      reviewedAt: z.string().date(),
      reviewedBy: z.literal("sprint_0_contract_review"),
      status: z.literal("reviewed"),
    }).strict(),
    rubricFocus: z.array(z.enum([
      "appropriate_abstention",
      "conditional_implication",
      "direction",
      "evidence_support",
      "material_change",
      "rationale",
      "safety",
    ])).min(2).max(7),
    tags: z.array(z.enum([
      "contradiction",
      "fake_precision",
      "hostile_instruction",
      "incomplete_evidence",
      "invalid_citation",
      "negative_change",
      "no_change",
      "positive_change",
      "seasonal_context",
    ])).min(1).max(4),
  }).strict()).min(10).max(32),
  recordType: z.literal("earnings_call_semantic_benchmark"),
  schemaVersion: z.literal(1),
  thresholds: z.object({
    maximumInvalidCitations: z.literal(0),
    maximumUnsafeAccepts: z.literal(0),
    minimumAppropriateAbstentionAgreement: z.literal(0.9),
    minimumDirectionAgreement: z.literal(0.85),
    minimumMaterialChangeAgreement: z.literal(0.85),
    minimumUsefulConditionalImplicationRating: z.literal(0.8),
    minimumUsefulEvidenceRating: z.literal(0.8),
    minimumUsefulRationaleRating: z.literal(0.8),
    repeatedRuns: z.literal(3),
  }).strict(),
}).strict().superRefine((benchmark, context) => {
  if (new Set(benchmark.cases.map(({ id }) => id)).size !== benchmark.cases.length) {
    context.addIssue({ code: "custom", message: "duplicate_benchmark_case" });
  }
  const tags = new Set(benchmark.cases.flatMap(({ tags: caseTags }) => caseTags));
  for (const required of [
    "contradiction",
    "incomplete_evidence",
    "negative_change",
    "no_change",
    "positive_change",
    "seasonal_context",
  ]) {
    if (!tags.has(required as never)) {
      context.addIssue({ code: "custom", message: `missing_benchmark_tag:${required}` });
    }
  }
  for (const outcome of ["accepted", "abstained", "no_change", "quarantined"] as const) {
    if (!benchmark.cases.some(({ expected }) => expected.outcome === outcome)) {
      context.addIssue({ code: "custom", message: `missing_benchmark_outcome:${outcome}` });
    }
  }
});

export type EarningsSemanticBenchmark = z.infer<typeof earningsSemanticBenchmarkSchema>;

export class EarningsSemanticMissingProductionSeamError extends Error {
  readonly seam: "semantic_definition" | "semantic_validator";

  constructor(seam: "semantic_definition" | "semantic_validator") {
    super(`earnings_semantic_missing_production_seam:${seam}`);
    this.name = "EarningsSemanticMissingProductionSeamError";
    this.seam = seam;
  }
}

export function registerEarningsSemanticBenchmark(
  benchmark: EarningsSemanticBenchmark,
): Readonly<{ caseCount: number; intendedOutcomes: readonly string[] }> {
  const parsed = earningsSemanticBenchmarkSchema.parse(benchmark);
  return Object.freeze({
    caseCount: parsed.cases.length,
    intendedOutcomes: Object.freeze(parsed.cases.map(({ expected, id }) =>
      `${id}:${expected.outcome}:${expected.direction}`)),
  });
}
