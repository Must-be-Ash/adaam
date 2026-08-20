import assert from "node:assert/strict";

import { artifactReferenceForId } from "../agent/lib/artifact-reference";
import { researchReportSchema } from "../agent/lib/artifact-schema";
import {
  buildSecIpoSignalReport,
  secIpoAlertPresentationForFacts,
  secIpoReportArtifactId,
} from "../agent/lib/sec-ipo-signal-report";
import type { SecIpoFilingFact } from "../agent/lib/workspace-finding-facts";
import {
  renderWorkspaceAlertPresentation,
  workspaceAlertTurnContext,
} from "../agent/lib/workspace-alert-presentation";
import type { WorkspaceAlert } from "../agent/lib/workspace-alert-store";

process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example";

function amendment(input: {
  accessionNumber: string;
  cik: string;
  companyName: string;
  filingUrl: string;
  updatedAt: string;
}): SecIpoFilingFact {
  const filingIdentity = `${input.accessionNumber}:S-1/A`;
  const registrationIdentity = `${input.cik}:${input.accessionNumber}`;
  return {
    accessionNumber: input.accessionNumber,
    amendmentIdentity: `${registrationIdentity}:${filingIdentity}`,
    canonicalFilingUrl: input.filingUrl,
    cik: input.cik,
    classification: "amendment",
    companyName: input.companyName,
    contentEvidence: {
      feedContentHash: "a".repeat(64),
      normalizedFilingHash: "b".repeat(64),
    },
    fileNumber: null,
    filedAt: null,
    filingIdentity,
    formType: "S-1/A",
    kind: "sec_ipo_filing",
    normalizerVersion: "sec-ipo-normalizer/v1",
    observedAt: input.updatedAt,
    registrationIdentity,
    schemaVersion: 1,
    source: {
      accessClassification: "public",
      canonicalUrl:
        "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=S-1&owner=include&count=40&output=atom",
      origin: "https://www.sec.gov",
      sourceId: "sec-latest-s1-filings",
    },
    updatedAt: input.updatedAt,
  };
}

const facts = [
  amendment({
    accessionNumber: "0001999371-26-018236",
    cik: "2064768",
    companyName: "Canary Staked TRX ETF",
    filingUrl:
      "https://www.sec.gov/Archives/edgar/data/2064768/000199937126018236/0001999371-26-018236-index.htm",
    updatedAt: "2026-08-19T21:23:38.000Z",
  }),
  amendment({
    accessionNumber: "0001493152-26-039323",
    cik: "720762",
    companyName: "NON INVASIVE MONITORING SYSTEMS INC /FL/",
    filingUrl:
      "https://www.sec.gov/Archives/edgar/data/720762/000149315226039323/0001493152-26-039323-index.htm",
    updatedAt: "2026-08-20T02:01:03.000Z",
  }),
] as const;

const report = buildSecIpoSignalReport({
  asOf: "2026-08-20T02:01:03.000Z",
  facts,
});
assert.match(report.title, /2 SEC S-1 filings/u);
assert.match(report.summary, /amendments to existing registration statements/u);
assert.match(report.summary, /not two new IPOs/u);
assert.deepEqual(
  report.sources.map(({ label, url }) => ({ label, url })),
  facts.map((fact) => ({
    label: `${fact.companyName} ${fact.formType}`,
    url: fact.canonicalFilingUrl,
  })),
);
const table = report.blocks.find((block) => block.type === "table");
assert.ok(table && table.type === "table");
assert.deepEqual(table.columns, ["Issuer", "Form", "Meaning", "Updated"]);
assert.equal(table.rows.length, 2);

const newRegistration = {
  ...facts[0],
  accessionNumber: "0001999371-26-018237",
  amendmentIdentity: null,
  classification: "new_registration",
  filingIdentity: "0001999371-26-018237:S-1",
  formType: "S-1",
  registrationIdentity: "2064768:0001999371-26-018237",
} satisfies SecIpoFilingFact;
const newRegistrationReport = buildSecIpoSignalReport({
  asOf: newRegistration.updatedAt,
  facts: [newRegistration],
});
assert.match(newRegistrationReport.summary, /potential public securities offering/u);
assert.equal(newRegistrationReport.verdict?.label, "Potential offering registrations");
const mixedReport = buildSecIpoSignalReport({
  asOf: facts[1].updatedAt,
  facts: [newRegistration, facts[1]],
});
assert.match(mixedReport.summary, /1 new Form S-1 registration and 1 S-1\/A amendment/u);
assert.equal(mixedReport.verdict?.label, "Mixed registration activity");

const maximumIssuerReport = buildSecIpoSignalReport({
  asOf: facts[0].updatedAt,
  facts: [{ ...facts[0], companyName: "X".repeat(300) }],
});
const validatedMaximumIssuerReport = researchReportSchema.parse(maximumIssuerReport);
assert.equal(validatedMaximumIssuerReport.sources[0]?.label.length, 180);
assert.match(validatedMaximumIssuerReport.sources[0]?.label ?? "", / S-1\/A$/u);

const artifactScope = {
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
};
const artifactIdentity = secIpoReportArtifactId({ facts, ...artifactScope });
assert.equal(
  secIpoReportArtifactId({ facts: [...facts].reverse(), ...artifactScope }),
  artifactIdentity,
);
assert.notEqual(
  secIpoReportArtifactId({
    facts,
    ownerId: "owner_another",
    workspaceId: artifactScope.workspaceId,
  }),
  artifactIdentity,
);
assert.notEqual(
  secIpoReportArtifactId({
    facts,
    ownerId: artifactScope.ownerId,
    workspaceId: "123e4567-e89b-42d3-a456-426614174001",
  }),
  artifactIdentity,
);

const alertPresentation = secIpoAlertPresentationForFacts(facts);
assert.ok(alertPresentation);
assert.match(alertPresentation.title, /Canary Staked TRX ETF/u);
assert.match(alertPresentation.whyMatched, /amendments to existing registrations/u);
assert.match(alertPresentation.whyMatched, /not new IPO confirmations/u);

const artifactId = "c".repeat(32);
const alert = {
  alertId: `alert_${"a".repeat(64)}`,
  artifactRefs: [artifactReferenceForId(artifactId)],
  createdAt: "2026-08-20T16:01:45.673Z",
  eventTime: "2026-08-20T02:01:03.000Z",
  findingId: `finding_${"b".repeat(64)}`,
  ownerId: "owner_fixture",
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceLinks: [{
    canonicalUrl: facts[0].source.canonicalUrl,
    sourceId: facts[0].source.sourceId,
  }],
  sourceRefs: [facts[0].source.sourceId],
  state: "ready",
  title: alertPresentation.title,
  whyMatched: alertPresentation.whyMatched,
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  workspaceName: "IPO Overnight Test",
} satisfies WorkspaceAlert;
const rendered = renderWorkspaceAlertPresentation(alert);
assert.match(
  rendered.fallbackText,
  new RegExp(`Readable report: https://eve\\.example/artifacts/${artifactId}`, "u"),
);
assert.equal(rendered.fallbackText.includes("Exact finding/evidence references: artifact:"), false);
assert.ok(
  rendered.fallbackText.indexOf("Readable report:") <
    rendered.fallbackText.indexOf("Sources:"),
);
assert.match(
  workspaceAlertTurnContext(alert),
  new RegExp(`Readable report: https://eve\\.example/artifacts/${artifactId}`, "u"),
);

console.info("SEC IPO signal report verification passed.");
