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

/*
 * The public-commentary lane is shared by two strategies with different framing.
 * `inverse-cramer` reports the registered INVERSE of a pundit's stance, so its
 * artifact must disclose that policy. A plain `public-commentary-tracker` (e.g. a
 * market-news account) reports the signal AS STATED - it has no inverse policy,
 * so inheriting Inverse-Cramer copy ("Inverse-policy research signal", "Inverse
 * Cramer monitor") mislabels it. Brand by strategy rather than hardcoding one.
 */
export type PublicCommentaryReportVariant = "inverse-cramer" | "public-commentary-tracker";

interface PublicCommentaryReportBranding {
  readonly description: string;
  readonly disclosure: string;
  readonly eyebrow: string;
  readonly verdictLabel: string;
}

const PUBLIC_COMMENTARY_REPORT_BRANDING: Readonly<
  Record<PublicCommentaryReportVariant, PublicCommentaryReportBranding>
> = Object.freeze({
  "inverse-cramer": Object.freeze({
    description: "Evidence-linked Inverse Cramer executive signal brief.",
    disclosure:
      "Public commentary and public supplementary sources only. The inverse direction is a registered research policy, not a trade instruction or investment advice.",
    eyebrow: "Eve · Inverse Cramer monitor",
    verdictLabel: "Inverse-policy research signal",
  }),
  "public-commentary-tracker": Object.freeze({
    description: "Evidence-linked public-commentary signal brief.",
    disclosure:
      "Public commentary and public supplementary sources only. A research signal, not a trade instruction or investment advice.",
    eyebrow: "Eve · Public commentary monitor",
    verdictLabel: "Research signal",
  }),
});

export function buildPublicCommentarySignalReport(input: {
  readonly asOf: string;
  readonly brief: WorkspaceExecutiveBrief;
  readonly variant?: PublicCommentaryReportVariant;
}): ResearchReport {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const branding = PUBLIC_COMMENTARY_REPORT_BRANDING[input.variant ?? "inverse-cramer"];
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
    description: branding.description,
    disclosure: branding.disclosure,
    eyebrow: branding.eyebrow,
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
      label: branding.verdictLabel,
      rationale: `${brief.implications[0]} ${brief.uncertainty[0]}`.slice(0, 1_000),
      tone: "info",
    },
  };
}

/*
 * A single check can surface several UNRELATED posts. They are not one story:
 * a Treasury-intervention post and a dollar-positioning post are two events that
 * happen to arrive together, and forcing them into one thesis fabricates a
 * correlation. This lays each post out as its OWN labeled section inside one
 * report - a newspaper with several items - so the owner reads each signal on its
 * own terms, with its own facts, direction, and what-to-watch, in a single
 * artifact rather than a fused narrative or a dozen separate messages.
 */
export function buildPublicCommentaryMultiSignalReport(input: {
  readonly asOf: string;
  readonly briefs: readonly WorkspaceExecutiveBrief[];
  readonly variant?: PublicCommentaryReportVariant;
}): ResearchReport {
  const briefs = input.briefs.map((brief) => workspaceExecutiveBriefSchema.parse(brief));
  if (briefs.length === 0) {
    throw new Error("public_commentary_multi_signal_report_requires_a_brief");
  }
  const branding = PUBLIC_COMMENTARY_REPORT_BRANDING[input.variant ?? "inverse-cramer"];
  const lead = briefs[0]!;
  const blocks = briefs.flatMap((brief, index) => {
    const limitation = brief.research.status === "unavailable" ? [brief.research.limitation] : [];
    return [
      {
        body: `${brief.materialFacts.map(({ statement }) => statement).join(" ")} ${brief.interpretation}`
          .trim()
          .slice(0, 4_000),
        heading: `Signal ${index + 1}: ${brief.title}`.slice(0, 180),
        tone: "info" as const,
        type: "callout" as const,
      },
      {
        body: [...brief.uncertainty, ...limitation].join(" ").trim().slice(0, 12_000) ||
          "No further uncertainty noted for this signal.",
        ...(brief.implications.length
          ? { bullets: brief.implications.slice(0, 20).map((implication) => implication.slice(0, 1_000)) }
          : {}),
        heading: "What it means and what to watch",
        type: "text" as const,
      },
    ];
  }).slice(0, 40);
  const seenSourceUrls = new Set<string>();
  const sources = briefs.flatMap((brief) => brief.sources)
    .filter(({ url }) => (seenSourceUrls.has(url) ? false : (seenSourceUrls.add(url), true)))
    .map(({ label, publishedAt, publisher, role, url }) => ({
      label: `${role === "official" ? "Statement · " : "Supplementary context · "}${label}`.slice(0, 180),
      publishedAt,
      publisher,
      url,
    }));
  return {
    asOf: input.asOf,
    blocks,
    confidence: lead.confidence,
    description: branding.description,
    disclosure: branding.disclosure,
    eyebrow: branding.eyebrow,
    sources,
    summary: `${briefs.length} separate signals, each its own event. ${lead.interpretation}`.slice(0, 5_000),
    title: `${lead.title} · +${briefs.length - 1} more`.slice(0, 200),
    verdict: {
      label: `${branding.verdictLabel} · ${briefs.length} signals`.slice(0, 120),
      rationale: `${lead.implications[0] ?? ""} ${lead.uncertainty[0] ?? ""}`.trim().slice(0, 1_000),
      tone: "info",
    },
  };
}

/*
 * Inverse Cramer needs NO research: the statement IS the conclusion. The owner
 * only wants "here is what Cramer said, so he is bullish on X and bearish on Y" -
 * and infers the inverse trade himself. This builder produces exactly that from
 * the deterministic marketView (stance + named companies), grouped by direction
 * across every post in the occurrence, with no per-post fan-out, no research
 * brief, and no "brief unavailable" fallback. It is inverse-cramer only; the
 * research builders above stay in place for the tracker and other lanes.
 */
export interface InverseCramerDirectSignal {
  readonly publishedAt?: string;
  readonly sourceLabel?: string;
  // A human, openable source page. Omitted when only a polling/API endpoint is
  // known (the owner never wants api.x.com shown), in which case no source row is
  // emitted for that post rather than surfacing the machine endpoint.
  readonly sourceUrl?: string;
  readonly stance: "bullish" | "bearish";
  readonly statement: string;
  readonly targets: readonly { readonly displayName: string; readonly symbol: string | null }[];
}

function inverseCramerNameList(names: readonly string[]): string {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0]!;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
}

export function buildInverseCramerDirectSignalReport(input: {
  readonly asOf: string;
  readonly signals: readonly InverseCramerDirectSignal[];
}): ResearchReport {
  if (input.signals.length === 0) {
    throw new Error("inverse_cramer_direct_report_requires_a_signal");
  }
  const branding = PUBLIC_COMMENTARY_REPORT_BRANDING["inverse-cramer"];
  const nameOf = (target: { displayName: string; symbol: string | null }): string =>
    target.symbol ? `${target.displayName} (${target.symbol})` : target.displayName;

  // Cramer's own stance, aggregated across every post in this occurrence.
  const cramerBullish: string[] = [];
  const cramerBearish: string[] = [];
  for (const signal of input.signals) {
    const names = signal.targets.map(nameOf);
    (signal.stance === "bullish" ? cramerBullish : cramerBearish).push(...names);
  }
  // The inverse: what Cramer is bullish on is a bearish read (sell/short), and
  // what he is bearish on is a bullish read (buy/long).
  const inverseSellShort = inverseCramerNameList(cramerBullish);
  const inverseBuyLong = inverseCramerNameList(cramerBearish);

  const moveLines: string[] = [];
  if (inverseSellShort) {
    moveLines.push(
      `Cramer is bullish on ${inverseSellShort}, so the inverse read is bearish: consider selling or shorting.`,
    );
  }
  if (inverseBuyLong) {
    moveLines.push(
      `Cramer is bearish on ${inverseBuyLong}, so the inverse read is bullish: consider buying or going long.`,
    );
  }

  const verdictLabel = [
    inverseSellShort ? `Bearish on ${inverseSellShort}` : "",
    inverseBuyLong ? `Bullish on ${inverseBuyLong}` : "",
  ].filter(Boolean).join(" · ") || "No directional read";

  const tone = inverseSellShort && !inverseBuyLong
    ? "negative" as const
    : inverseBuyLong && !inverseSellShort
      ? "positive" as const
      : "info" as const;

  // One tight line per post: his stance and the companies, plus a short quote.
  const saidBullets = input.signals.map((signal) => {
    const names = inverseCramerNameList(signal.targets.map(nameOf));
    const quote = signal.statement.replace(/\s+/gu, " ").trim().slice(0, 220);
    return `${signal.stance === "bullish" ? "Bullish" : "Bearish"} on ${names}: "${quote}"`.slice(0, 1_000);
  });

  const seenUrls = new Set<string>();
  const sources = input.signals
    .flatMap((signal) => {
      const url = signal.sourceUrl;
      if (!url || seenUrls.has(url)) return [];
      seenUrls.add(url);
      return [{
        label: (signal.sourceLabel ?? "Public statement on X").slice(0, 180),
        ...(signal.publishedAt ? { publishedAt: signal.publishedAt } : {}),
        publisher: "X",
        url,
      }];
    });

  const title = inverseSellShort && !inverseBuyLong
    ? `Jim Cramer is bullish on ${inverseSellShort} — inverse read: bearish`
    : inverseBuyLong && !inverseSellShort
      ? `Jim Cramer is bearish on ${inverseBuyLong} — inverse read: bullish`
      : `Jim Cramer's latest — inverse read on ${inverseCramerNameList([...cramerBullish, ...cramerBearish])}`;

  return {
    asOf: input.asOf,
    blocks: [
      {
        body: moveLines.join(" ").slice(0, 4_000),
        heading: "The inverse read (your move)",
        tone,
        type: "callout" as const,
      },
      {
        body: "Here is what Jim Cramer said.",
        bullets: saidBullets.slice(0, 20),
        heading: "What Cramer said",
        type: "text" as const,
      },
    ],
    confidence: "medium",
    description: branding.description,
    disclosure: branding.disclosure,
    eyebrow: branding.eyebrow,
    sources,
    summary: moveLines.join(" ").slice(0, 5_000),
    title: title.slice(0, 200),
    verdict: {
      label: verdictLabel.slice(0, 120),
      rationale: "Inverse Cramer: his stance is the source view and your read is its deterministic opposite. No further research; the statement is the signal."
        .slice(0, 1_000),
      tone,
    },
  };
}
