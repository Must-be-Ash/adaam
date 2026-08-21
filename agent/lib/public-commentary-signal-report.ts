import { createHash } from "node:crypto";

import type { ResearchReport } from "#artifact-schema";

import {
  workspaceExecutiveBriefSchema,
  type WorkspaceExecutiveBrief,
} from "./workspace-executive-brief";

export function publicCommentaryReportArtifactId(input: {
  readonly factIdentities: readonly string[];
  readonly ownerId: string;
  readonly workspaceId: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      factIdentities: [...input.factIdentities].sort(),
      ownerId: input.ownerId,
      reportType: "public-commentary-executive-report/v1",
      workspaceId: input.workspaceId,
    }))
    .digest("hex")
    .slice(0, 32);
}

export function publicCommentaryAlertPresentationForBrief(
  input: WorkspaceExecutiveBrief,
): { title: string; whyMatched: string } {
  const brief = workspaceExecutiveBriefSchema.parse(input);
  const limitation = brief.research.status === "unavailable"
    ? ` ${brief.research.limitation}`
    : "";
  return {
    title: brief.title.slice(0, 240),
    whyMatched: `${brief.interpretation} ${brief.implications[0]} ${brief.uncertainty[0]}${limitation}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 1_000),
  };
}

export function buildPublicCommentarySignalReport(input: {
  readonly asOf: string;
  readonly brief: WorkspaceExecutiveBrief;
}): ResearchReport {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const hasSupplementaryContext = brief.sources.some(({ role }) => role === "supplementary");
  return {
    asOf: input.asOf,
    blocks: [
      {
        body: `${brief.materialFacts.map(({ statement }) => statement).join(" ")} ${brief.interpretation}`
          .trim()
          .slice(0, 4_000),
        heading: "What happened",
        tone: "info",
        type: "callout",
      },
      {
        body: brief.interpretation,
        bullets: brief.implications,
        heading: "Why it may matter",
        type: "text",
      },
      {
        body: brief.uncertainty.join(" "),
        bullets: brief.research.status === "unavailable"
          ? [brief.research.limitation]
          : undefined,
        heading: "Uncertainty",
        type: "text",
      },
    ],
    confidence: brief.confidence,
    description: "Evidence-linked Inverse Cramer executive signal brief.",
    disclosure: "Public commentary and public supplementary sources only. The inverse direction is a registered research policy, not a trade instruction or investment advice.",
    eyebrow: "Eve · Inverse Cramer monitor",
    sources: brief.sources.map(({ label, publishedAt, publisher, role, url }) => ({
      label: `${hasSupplementaryContext
        ? role === "official" ? "Official statement · " : "Supplementary context · "
        : ""}${label}`.slice(0, 180),
      publishedAt,
      publisher,
      url,
    })),
    summary: brief.interpretation,
    title: brief.title,
    verdict: {
      label: "Inverse-policy research signal",
      rationale: `${brief.implications[0]} ${brief.uncertainty[0]}`.slice(0, 1_000),
      tone: "info",
    },
  };
}
