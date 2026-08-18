import { z } from "zod";

export const publicCommentarySemanticBenchmarkSchema = z.object({
  benchmarkId: z.literal("public-commentary-semantic-v1"),
  cases: z.array(z.object({
    expected: z.object({
      direction: z.enum(["bearish", "bullish"]).nullable(),
      outcome: z.enum(["accepted", "abstained", "no_view", "quarantined"]),
      stance: z.enum(["bullish", "bearish", "mixed", "neutral", "unclear"]),
      targetSymbols: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/u)).max(8),
      voiceOwnership: z.enum(["speaker", "quoted_party", "mixed", "unclear"]),
    }).strict(),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    review: z.object({
      reviewedAt: z.string().date(),
      reviewedBy: z.literal("sprint_2_contract_review"),
      status: z.literal("reviewed"),
    }).strict(),
    statement: z.object({
      attribution: z.enum(["direct", "quoted", "alleged", "conflicting"]),
      cashtags: z.array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/u)).max(8),
      role: z.enum(["original", "reply", "quote"]),
      text: z.string().trim().min(1).max(2_000),
    }).strict(),
    tags: z.array(z.enum([
      "abstention",
      "bearish",
      "bullish",
      "conflict",
      "hostile_instruction",
      "mixed",
      "quotation",
      "target_resolution",
      "unknown",
    ])).min(1).max(5),
  }).strict()).min(8).max(24),
  recordType: z.literal("public_commentary_semantic_benchmark"),
  schemaVersion: z.literal(1),
  thresholds: z.object({
    maximumInvalidCitations: z.literal(0),
    maximumUnsafeAccepts: z.literal(0),
    minimumAbstentionAgreement: z.literal(0.9),
    minimumExplanationRating: z.literal(0.8),
    minimumQuotationAgreement: z.literal(0.95),
    minimumStanceAgreement: z.literal(0.85),
    minimumTargetAgreement: z.literal(0.85),
    repeatedRuns: z.literal(3),
  }).strict(),
}).strict().superRefine((benchmark, context) => {
  if (new Set(benchmark.cases.map(({ id }) => id)).size !== benchmark.cases.length) {
    context.addIssue({ code: "custom", message: "duplicate_benchmark_case" });
  }
  const tags = new Set(benchmark.cases.flatMap(({ tags }) => tags));
  for (const tag of ["abstention", "bearish", "bullish", "conflict", "hostile_instruction", "mixed", "quotation", "target_resolution", "unknown"] as const) {
    if (!tags.has(tag)) context.addIssue({ code: "custom", message: `missing_benchmark_tag:${tag}` });
  }
});

export type PublicCommentarySemanticBenchmark = z.infer<typeof publicCommentarySemanticBenchmarkSchema>;
