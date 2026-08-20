import assert from "node:assert/strict";

import { artifactReferenceForId } from "../agent/lib/artifact-reference";
import { researchReportSchema } from "../agent/lib/artifact-schema";
import {
  buildSecIpoExecutiveBrief,
  buildSecIpoSignalReport,
  secIpoAlertPresentationForBrief,
} from "../agent/lib/sec-ipo-signal-report";
import { materializeSecIpoExecutiveOutput } from "../agent/lib/sec-ipo-workspace-worker";
import {
  shouldPublishWorkspaceExecutiveArtifact,
  workspaceExecutiveBriefSchema,
} from "../agent/lib/workspace-executive-brief";
import {
  renderWorkspaceAlertPresentation,
  workspaceAlertTurnContext,
} from "../agent/lib/workspace-alert-presentation";
import type { WorkspaceAlert } from "../agent/lib/workspace-alert-store";
import type { SecIpoFilingFact } from "../agent/lib/workspace-finding-facts";

process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example";

const officialFeedUrl =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom";
const officialFilingUrl =
  "https://www.sec.gov/Archives/edgar/data/2064768/000199937126018237/0001999371-26-018237-index.htm";

const fact = {
  accessionNumber: "0001999371-26-018237",
  amendmentIdentity: null,
  canonicalFilingUrl: officialFilingUrl,
  cik: "0002064768",
  classification: "new_registration",
  companyName: "Example Holdings",
  contentEvidence: {
    feedContentHash: "a".repeat(64),
    normalizedFilingHash: "b".repeat(64),
  },
  fileNumber: "333-123456",
  filedAt: "2026-08-20T02:01:03.000Z",
  filingIdentity: "0001999371-26-018237:S-1",
  formType: "S-1",
  kind: "sec_ipo_filing",
  normalizerVersion: "sec-ipo-atom/1.0.0",
  observedAt: "2026-08-20T02:01:03.000Z",
  registrationIdentity: "0002064768:333-123456",
  schemaVersion: 1,
  source: {
    accessClassification: "public",
    canonicalUrl: officialFeedUrl,
    origin: "https://www.sec.gov",
    sourceId: "sec-latest-s1-filings",
  },
  updatedAt: "2026-08-20T02:01:03.000Z",
} satisfies SecIpoFilingFact;

const reportNow = buildSecIpoExecutiveBrief({ facts: [fact] });
assert.equal(reportNow.research.status, "not_needed");
assert.deepEqual(reportNow.sources.map(({ role }) => role), ["official"]);
assert.equal(shouldPublishWorkspaceExecutiveArtifact({ brief: reportNow }), false);
assert.match(reportNow.interpretation, /registration process/u);
assert.match(reportNow.uncertainty.join(" "), /does not confirm/u);

const simplePresentation = secIpoAlertPresentationForBrief(reportNow);
assert.match(simplePresentation.title, /Example Holdings/u);
assert.match(simplePresentation.whyMatched, /potential public offering/u);
assert.match(simplePresentation.whyMatched, /does not confirm/u);

const researched = workspaceExecutiveBriefSchema.parse({
  ...reportNow,
  confidence: "medium",
  implications: [
    "The filing opens an SEC registration process; terms, timing, and completion remain unresolved.",
    "Supplementary issuer context indicates the registrant is preparing a first public offering.",
  ],
  interpretation:
    "The official S-1 is the material event. Public issuer context helps explain the planned offering but does not override the filing.",
  research: { status: "completed" },
  sources: [
    ...reportNow.sources,
    {
      label: "Supplementary issuer overview",
      publisher: "Example Holdings",
      role: "supplementary",
      url: "https://example.com/investors/company-overview",
    },
  ],
  uncertainty: [
    "The issuer has not announced final timing or pricing.",
    "Supplementary context may change and is subordinate to the SEC filing.",
  ],
});
assert.equal(shouldPublishWorkspaceExecutiveArtifact({ brief: researched }), true);

const evaluation = {
  alerts: [],
  baselineEstablished: false,
  checkpoint: {
    contentDigest: "d".repeat(64),
    watermark: fact.updatedAt,
  },
  findings: [{ fact }],
};
let publicationCalls = 0;
const publishReport = async (input: { artifactId: string }) => {
  publicationCalls += 1;
  return {
    artifactId: input.artifactId,
    kind: "report" as const,
    publicUrl: `https://eve.example/artifacts/${input.artifactId}`,
  };
};
const simpleOutput = await materializeSecIpoExecutiveOutput({
  approvedSupplementaryUrls: [],
  brief: reportNow,
  clients: { publishReport: publishReport as never },
  evaluation: evaluation as never,
  scope: {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
});
assert.deepEqual(simpleOutput.artifactRefs, []);
assert.equal(publicationCalls, 0);
await assert.rejects(
  materializeSecIpoExecutiveOutput({
    approvedSupplementaryUrls: [],
    brief: researched,
    clients: { publishReport: publishReport as never },
    evaluation: evaluation as never,
    scope: {
      ownerId: "owner_fixture",
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    },
  }),
  /sec_ipo_monitor_invalid/u,
);
assert.equal(publicationCalls, 0);
const researchedOutput = await materializeSecIpoExecutiveOutput({
  approvedSupplementaryUrls: [
    "https://example.com/investors/company-overview",
  ],
  brief: researched,
  clients: { publishReport: publishReport as never },
  evaluation: evaluation as never,
  scope: {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
});
assert.equal(researchedOutput.artifactRefs.length, 1);
assert.equal(publicationCalls, 1);
const oversizedBrief = workspaceExecutiveBriefSchema.parse({
  ...reportNow,
  implications: Array.from(
    { length: 6 },
    (_, index) => `Implication ${index + 1}: ${"x".repeat(470)}`,
  ),
  interpretation: `Interpretation: ${"x".repeat(980)}`,
  uncertainty: Array.from(
    { length: 6 },
    (_, index) => `Uncertainty ${index + 1}: ${"x".repeat(470)}`,
  ),
});
const oversizedOutput = await materializeSecIpoExecutiveOutput({
  approvedSupplementaryUrls: [],
  brief: oversizedBrief,
  clients: { publishReport: publishReport as never },
  evaluation: evaluation as never,
  scope: {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
});
assert.equal(oversizedOutput.artifactRefs.length, 1);
assert.equal(publicationCalls, 2);
researchReportSchema.parse(buildSecIpoSignalReport({
  asOf: fact.updatedAt,
  brief: oversizedBrief,
  facts: [fact],
}));
await assert.rejects(
  materializeSecIpoExecutiveOutput({
    approvedSupplementaryUrls: [],
    brief: workspaceExecutiveBriefSchema.parse({
      ...reportNow,
      materialFacts: [{
        statement: "A mismatched official filing must not be published.",
        sourceUrls: ["https://www.sec.gov/Archives/edgar/data/1/mismatch.htm"],
      }],
      sources: [{
        label: "Mismatched filing",
        role: "official",
        url: "https://www.sec.gov/Archives/edgar/data/1/mismatch.htm",
      }],
    }),
    clients: { publishReport: publishReport as never },
    evaluation: evaluation as never,
    scope: {
      ownerId: "owner_fixture",
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    },
  }),
  /sec_ipo_monitor_invalid/u,
);
assert.equal(publicationCalls, 2);

const report = researchReportSchema.parse(buildSecIpoSignalReport({
  asOf: fact.updatedAt,
  brief: researched,
  facts: [fact],
}));
assert.ok(report.blocks.some((block) => block.heading === "Why it may matter"));
assert.ok(report.blocks.some((block) => block.heading === "Uncertainty"));
assert.match(report.sources[0]?.label ?? "", /^Official filing ·/u);
assert.match(report.sources[1]?.label ?? "", /^Supplementary context ·/u);

const conflicting = workspaceExecutiveBriefSchema.parse({
  ...researched,
  confidence: "low",
  interpretation:
    "The S-1 is material, while supplementary descriptions conflict about the intended offering structure.",
  uncertainty: [
    "Supplementary sources conflict, so no specific offering structure is asserted.",
  ],
});
assert.match(conflicting.uncertainty[0] ?? "", /conflict/u);

const unavailable = workspaceExecutiveBriefSchema.parse({
  ...reportNow,
  research: {
    limitation: "Supplementary research was unavailable; this brief relies on the official filing.",
    status: "unavailable",
  },
});
assert.equal(shouldPublishWorkspaceExecutiveArtifact({ brief: unavailable }), false);
assert.match(unavailable.research.limitation ?? "", /official filing/u);

assert.equal(shouldPublishWorkspaceExecutiveArtifact({
  alertText: "x".repeat(4_001),
  brief: reportNow,
}), true);
assert.equal(shouldPublishWorkspaceExecutiveArtifact({
  brief: workspaceExecutiveBriefSchema.parse({
    ...reportNow,
    materialFacts: [
      ...reportNow.materialFacts,
      {
        statement: "A second independently material registration was observed.",
        sourceUrls: [officialFilingUrl],
      },
    ],
  }),
}), true);
assert.equal(workspaceExecutiveBriefSchema.safeParse({
  ...reportNow,
  materialFacts: [{
    statement: "Unsupported assertion.",
    sourceUrls: ["https://unsupported.example/source"],
  }],
}).success, false);

const artifactId = "c".repeat(32);
const alert = {
  alertId: `alert_${"a".repeat(64)}`,
  artifactRefs: [artifactReferenceForId(artifactId)],
  createdAt: "2026-08-20T16:01:45.673Z",
  eventTime: fact.updatedAt,
  findingId: `finding_${"b".repeat(64)}`,
  ownerId: "owner_fixture",
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceLinks: [
    {
      canonicalUrl: officialFilingUrl,
      role: "official",
      sourceId: "sec-latest-s1-filings",
    },
    {
      canonicalUrl: "https://example.com/investors/company-overview",
      role: "supplementary",
      sourceId: "exa-public-context",
    },
  ],
  sourceRefs: ["sec-latest-s1-filings", "exa-public-context"],
  state: "ready",
  title: simplePresentation.title,
  whyMatched: simplePresentation.whyMatched,
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  workspaceName: "IPO Executive Output Test",
} satisfies WorkspaceAlert;
const fallback = renderWorkspaceAlertPresentation(alert).fallbackText;
const discuss = workspaceAlertTurnContext(alert);
for (const output of [fallback, discuss]) {
  assert.match(output, /Official source/u);
  assert.match(output, /Supplementary context/u);
  assert.match(output, new RegExp(`https://eve\\.example/artifacts/${artifactId}`, "u"));
  assert.match(output, /IPO Executive Output Test|current workspace/u);
  assert.doesNotMatch(output, /Main/u);
}
const boundedLongPresentation = renderWorkspaceAlertPresentation({
  ...alert,
  sourceLinks: Array.from({ length: 8 }, (_, index) => ({
    canonicalUrl: `https://example.com/${String(index).padStart(2, "0")}/${"x".repeat(380)}`,
    role: "supplementary" as const,
    sourceId: `exa-public-context-${index}`,
  })),
});
assert.ok(Buffer.byteLength(boundedLongPresentation.fallbackText, "utf8") <= 4_000);
assert.match(boundedLongPresentation.fallbackText, /additional sources in the readable report/u);

console.info("Agentic durable research U3 executive-output verification passed.");
