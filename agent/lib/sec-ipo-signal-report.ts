import { createHash } from "node:crypto";

import type { ResearchReport } from "#artifact-schema";

import type { SecIpoFilingFact } from "./workspace-finding-facts";

function plural(count: number, singular: string, multiple = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : multiple}`;
}

function quantityWord(count: number): string {
  return count === 1 ? "one" : count === 2 ? "two" : String(count);
}

function filingMix(facts: readonly SecIpoFilingFact[]): {
  amendmentCount: number;
  newRegistrationCount: number;
} {
  return {
    amendmentCount: facts.filter(({ classification }) => classification === "amendment").length,
    newRegistrationCount: facts.filter(({ classification }) =>
      classification === "new_registration").length,
  };
}

function issuerList(facts: readonly SecIpoFilingFact[]): string {
  const names = facts.map(({ companyName }) => companyName);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

function reportSourceLabel(fact: SecIpoFilingFact): string {
  const suffix = ` ${fact.formType}`;
  return `${fact.companyName.slice(0, 180 - suffix.length).trimEnd()}${suffix}`;
}

function plainEnglishSummary(
  facts: readonly SecIpoFilingFact[],
  mix = filingMix(facts),
): string {
  const { amendmentCount, newRegistrationCount } = mix;
  if (amendmentCount === facts.length) {
    return `${plural(amendmentCount, "newly observed filing is", "newly observed filings are")} S-1/A amendments to existing registration statements. They are not ${amendmentCount === 1 ? "a new IPO" : `${quantityWord(amendmentCount)} new IPOs`} and do not confirm that an offering will proceed.`;
  }
  if (newRegistrationCount === facts.length) {
    return `${plural(newRegistrationCount, "newly observed Form S-1 registration")} may relate to a potential public securities offering. Filing Form S-1 starts or advances an SEC registration process; it does not confirm that an IPO or other offering will occur.`;
  }
  return `This alert contains ${plural(newRegistrationCount, "new Form S-1 registration")} and ${plural(amendmentCount, "S-1/A amendment")}. New registrations may indicate potential offerings, while amendments update existing registrations; neither confirms that an offering will proceed.`;
}

function reportVerdict(input: {
  amendmentCount: number;
  factCount: number;
  newRegistrationCount: number;
  summary: string;
}): ResearchReport["verdict"] {
  const { amendmentCount, factCount, newRegistrationCount, summary } = input;
  if (amendmentCount === factCount) {
    return {
      label: "Registration updates—not new IPO confirmations",
      rationale: summary,
      tone: "info",
    };
  }
  return {
    label: newRegistrationCount === factCount
      ? "Potential offering registrations"
      : "Mixed registration activity",
    rationale: summary,
    tone: "info",
  };
}

export function secIpoReportArtifactId(input: {
  facts: readonly SecIpoFilingFact[];
  ownerId: string;
  workspaceId: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      factIdentities: input.facts.map(({ filingIdentity }) => filingIdentity).sort(),
      ownerId: input.ownerId,
      reportType: "sec-ipo-signal-report/v1",
      workspaceId: input.workspaceId,
    }))
    .digest("hex")
    .slice(0, 32);
}

export function secIpoAlertPresentationForFacts(
  facts: readonly SecIpoFilingFact[],
): { title: string; whyMatched: string } | undefined {
  if (facts.length === 0) return undefined;
  const { amendmentCount, newRegistrationCount } = filingMix(facts);
  const kind = amendmentCount === facts.length
    ? plural(facts.length, "SEC S-1 amendment")
    : newRegistrationCount === facts.length
      ? plural(facts.length, "new SEC S-1 registration")
      : plural(facts.length, "SEC S-1 filing");
  const title = `${kind} · ${issuerList(facts)}`.slice(0, 240);
  const whyMatched = amendmentCount === facts.length
    ? `${issuerList(facts)} filed ${plural(amendmentCount, "S-1/A amendment")} to existing registrations. These are registration updates, not new IPO confirmations; the readable report links each issuer's SEC filing.`
    : `${plainEnglishSummary(facts)} The readable report separates each issuer and links the direct SEC filing.`;
  return { title, whyMatched: whyMatched.slice(0, 1_000) };
}

export function buildSecIpoSignalReport(input: {
  asOf: string;
  facts: readonly SecIpoFilingFact[];
}): ResearchReport {
  if (input.facts.length === 0) {
    throw new Error("sec_ipo_signal_report_empty");
  }
  const mix = filingMix(input.facts);
  const summary = plainEnglishSummary(input.facts, mix);
  return {
    asOf: input.asOf,
    blocks: [
      {
        body: summary,
        heading: "What this alert means",
        tone: "info",
        type: "callout",
      },
      {
        columns: ["Issuer", "Form", "Meaning", "Updated"],
        heading: "Filings in this alert",
        note: "Use the direct SEC source links below to inspect each filing. The feed-level alert is discovery evidence, not an offering recommendation.",
        rows: input.facts.map((fact) => [
          fact.companyName,
          fact.formType,
          fact.classification === "new_registration"
            ? "Potential offering registration"
            : "Amendment to an existing registration",
          fact.updatedAt,
        ]),
        type: "table",
      },
      {
        body: "Form S-1 registers securities under the Securities Act and can support an IPO or another public resale or offering structure. Form S-1/A changes a previously filed registration statement. A filing is an early-to-intermediate regulatory event: it does not show that SEC review is complete, establish pricing, or guarantee that an offering will close.",
        heading: "How to interpret Form S-1",
        bullets: [
          "Read the issuer's direct filing before drawing company-specific conclusions.",
          "Treat amendments as updates to an existing process unless the filing itself shows a materially different transaction.",
          "Do not infer offering completion, timing, valuation, or investment merit from the filing event alone.",
        ],
        type: "text",
      },
    ],
    confidence: "high",
    description: "Plain-English issuer-level interpretation of newly observed SEC Form S-1 activity.",
    disclosure: "Public SEC filing data only. This report explains the filing event and is not investment advice or confirmation that an offering will occur.",
    eyebrow: "Eve · IPO Filings monitor",
    metrics: [
      { label: "Filings", value: String(input.facts.length) },
      {
        label: "New registrations",
        value: String(mix.newRegistrationCount),
      },
      {
        label: "Amendments",
        value: String(mix.amendmentCount),
      },
    ],
    sources: input.facts.map((fact) => ({
      label: reportSourceLabel(fact),
      publisher: "U.S. Securities and Exchange Commission",
      publishedAt: fact.updatedAt,
      url: fact.canonicalFilingUrl,
    })),
    summary,
    title: `${plural(input.facts.length, "SEC S-1 filing")} · plain-English signal report`,
    verdict: reportVerdict({
      ...mix,
      factCount: input.facts.length,
      summary,
    }),
  };
}
