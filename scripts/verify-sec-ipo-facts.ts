import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
} from "../agent/lib/sec-ipo-evaluation";
import {
  SEC_IPO_NORMALIZER_VERSION,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import {
  workspaceFindingCandidateSchema,
  workspaceFindingInputSchema,
} from "../agent/lib/workspace-finding-store";

const body = await readFile(
  new URL("./fixtures/sec-ipo/later-s1.atom", import.meta.url),
  "utf8",
);
const page = normalizeSecIpoFetch({
  body,
  contentType: "application/atom+xml; charset=UTF-8",
  finalUrl: SEC_IPO_SOURCE_URL,
  observedAt: "2026-08-14T18:05:00.000Z",
  requestedUrl: SEC_IPO_SOURCE_URL,
  status: 200,
});
const evaluation = evaluateSecIpoPage(
  page,
  {
    contentDigest: "a".repeat(64),
    watermark: "2026-08-14T17:00:00.000Z",
  },
  {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
);
assert.equal(evaluation.findings.length, 1);
const fact = evaluation.findings[0]!.fact;
assert.deepEqual(fact, {
  accessionNumber: "0001000003-26-000001",
  amendmentIdentity: null,
  canonicalFilingUrl:
    "https://www.sec.gov/Archives/edgar/data/1000003/000100000326000001/new-candidate-s1-index.htm",
  cik: "0001000003",
  classification: "new_registration",
  companyName: "New Candidate Corp",
  contentEvidence: {
    feedContentHash: page.contentHash,
    normalizedFilingHash: page.filings.at(-1)!.contentHash,
  },
  fileNumber: "333-100003",
  filedAt: "2026-08-14T17:59:00.000Z",
  filingIdentity: "0001000003-26-000001:S-1",
  formType: "S-1",
  kind: "sec_ipo_filing",
  normalizerVersion: SEC_IPO_NORMALIZER_VERSION,
  observedAt: "2026-08-14T18:05:00.000Z",
  registrationIdentity: "0001000003:333-100003",
  schemaVersion: 1,
  source: {
    accessClassification: "public",
    canonicalUrl: SEC_IPO_SOURCE_URL,
    origin: "https://www.sec.gov",
    sourceId: SEC_IPO_SOURCE_ID,
  },
  updatedAt: "2026-08-14T18:00:00.000Z",
});

const generic = {
  accessClassification: "public" as const,
  artifactRefs: [],
  asOf: fact.updatedAt,
  provenance: [{
    accessClassification: "public" as const,
    canonicalUrl: fact.canonicalFilingUrl,
    origin: fact.source.origin,
    sourceId: fact.source.sourceId,
  }],
  summary: evaluation.findings[0]!.summary,
};
assert.equal(
  workspaceFindingInputSchema.safeParse({ ...generic, facts: [fact] }).success,
  false,
  "The model-facing generic finding schema must not accept authoritative SEC facts.",
);
assert.equal(
  workspaceFindingCandidateSchema.safeParse({ ...generic, facts: [fact] }).success,
  true,
);
assert.equal(
  workspaceFindingCandidateSchema.safeParse({
    ...generic,
    facts: [{ ...fact, classification: "amendment" }],
  }).success,
  false,
  "Classification and form/amendment identity must stay consistent.",
);

const amendmentBody = await readFile(
  new URL("./fixtures/sec-ipo/amendment.atom", import.meta.url),
  "utf8",
);
const amendmentPage = normalizeSecIpoFetch({
  body: amendmentBody,
  contentType: "application/atom+xml; charset=UTF-8",
  finalUrl: SEC_IPO_SOURCE_URL,
  observedAt: "2026-08-14T19:05:00.000Z",
  requestedUrl: SEC_IPO_SOURCE_URL,
  status: 200,
});
const amendment = evaluateSecIpoPage(
  amendmentPage,
  evaluation.checkpoint,
  {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
).findings[0]!.fact;
assert.equal(amendment.classification, "amendment");
assert.equal(amendment.formType, "S-1/A");
assert.equal(amendment.registrationIdentity, fact.registrationIdentity);
assert.equal(
  amendment.amendmentIdentity,
  `${fact.registrationIdentity}:${amendment.filingIdentity}`,
);

console.info("Typed SEC IPO fact verification passed.");
