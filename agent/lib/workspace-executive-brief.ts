import { z } from "zod";

export const WORKSPACE_ALERT_MESSAGE_MAXIMUM = 4_000;

const publicSourceUrlSchema = z.string().url().max(2_048).superRefine(
  (value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      context.addIssue({ code: "custom", message: "executive_source_url_invalid" });
    }
  },
);

const executiveSourceSchema = z.object({
  label: z.string().trim().min(1).max(180),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  publisher: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["official", "supplementary"]),
  sourceId: z.string().min(1).max(160).optional(),
  url: publicSourceUrlSchema,
}).strict();

const materialFactSchema = z.object({
  sourceUrls: z.array(publicSourceUrlSchema).min(1).max(8),
  statement: z.string().trim().min(1).max(500),
}).strict();

const researchSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_needed") }).strict(),
  z.object({ status: z.literal("completed") }).strict(),
  z.object({
    limitation: z.string().trim().min(1).max(500),
    status: z.literal("unavailable"),
  }).strict(),
]);

export const workspaceExecutiveBriefSchema = z.object({
  confidence: z.enum(["high", "medium", "low"]),
  implications: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
  interpretation: z.string().trim().min(1).max(1_000),
  materialFacts: z.array(materialFactSchema).min(1).max(40),
  research: researchSchema,
  sources: z.array(executiveSourceSchema).min(1).max(40),
  title: z.string().trim().min(1).max(200),
  uncertainty: z.array(z.string().trim().min(1).max(500)).min(1).max(6),
}).strict().superRefine((brief, context) => {
  const sourceUrls = new Set(brief.sources.map(({ url }) => url));
  if (
    sourceUrls.size !== brief.sources.length ||
    !brief.sources.some(({ role }) => role === "official") ||
    brief.materialFacts.some(({ sourceUrls: references }) =>
      references.some((url) => !sourceUrls.has(url))
    )
  ) {
    context.addIssue({ code: "custom", message: "executive_source_support_invalid" });
  }
  const supplementaryCount = brief.sources.filter(
    ({ role }) => role === "supplementary",
  ).length;
  if (
    (brief.research.status === "completed" && supplementaryCount === 0) ||
    (brief.research.status !== "completed" && supplementaryCount !== 0)
  ) {
    context.addIssue({ code: "custom", message: "executive_research_sources_invalid" });
  }
});

export type WorkspaceExecutiveBrief = z.infer<
  typeof workspaceExecutiveBriefSchema
>;

export function shouldPublishWorkspaceExecutiveArtifact(input: {
  alertText?: string;
  brief: WorkspaceExecutiveBrief;
}): boolean {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const fullBriefText = [
    brief.title,
    ...brief.materialFacts.map(({ statement }) => statement),
    brief.interpretation,
    ...brief.implications,
    ...brief.uncertainty,
    ...(brief.research.status === "unavailable"
      ? [brief.research.limitation]
      : []),
  ].join("\n");
  return brief.research.status === "completed" ||
    brief.materialFacts.length > 1 ||
    new Set(brief.sources.map(({ url }) => url)).size > 1 ||
    Math.max(input.alertText?.length ?? 0, fullBriefText.length) >
      WORKSPACE_ALERT_MESSAGE_MAXIMUM;
}
