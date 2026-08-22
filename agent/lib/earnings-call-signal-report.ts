import { createHash } from "node:crypto";

import type { ResearchReport } from "#artifact-schema";

import {
  workspaceExecutiveBriefSchema,
  type WorkspaceExecutiveBrief,
} from "./workspace-executive-brief";

export function earningsCallReportArtifactId(input: {
  readonly factIdentities: readonly string[];
  readonly ownerId: string;
  readonly workspaceId: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      factIdentities: [...input.factIdentities].sort(),
      ownerId: input.ownerId,
      reportType: "earnings-call-executive-report/v1",
      workspaceId: input.workspaceId,
    }))
    .digest("hex")
    .slice(0, 32);
}

export function earningsCallAlertPresentationForBrief(
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

export function buildEarningsCallSignalReport(input: {
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
        heading: "What changed on the call",
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
    description: "Evidence-linked earnings-call change executive brief.",
    disclosure: "Official earnings-call transcripts and public supplementary sources only. A cited change in management language is a research observation, not a trade instruction or investment advice.",
    eyebrow: "Eve · Earnings Call Changes monitor",
    sources: brief.sources.map(({ label, publishedAt, publisher, role, url }) => ({
      label: `${hasSupplementaryContext
        ? role === "official" ? "Official transcript · " : "Supplementary context · "
        : ""}${label}`.slice(0, 180),
      publishedAt,
      publisher,
      url,
    })),
    summary: brief.interpretation,
    title: brief.title,
    verdict: {
      label: "Earnings-call change research signal",
      rationale: `${brief.implications[0]} ${brief.uncertainty[0]}`.slice(0, 1_000),
      tone: "info",
    },
  };
}
