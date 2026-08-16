import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  commitPublicSourceAcquisition,
  ensurePublicSourceInstance,
  readPublicSourceAcquisitionJournal,
  readPublicSourceFactRevision,
  readPublicSourceInstance,
  type PublicSourceAcquisitionStoreClient,
} from "../agent/lib/public-source-acquisition-store";
import {
  deriveCanonicalPublicFactRevisionId,
  digestPublicSourceValue,
  publicSourceCorrectionSchema,
  type CanonicalPublicFactRevision,
} from "../agent/lib/public-source-adapter-schema";
import {
  resolveReviewedPublicSource,
  ReviewedPublicSourceRegistryError,
} from "../agent/lib/public-source-registry";
import {
  acquireSecPublicSource,
  runSecPublicSourceAcquisition,
} from "../agent/lib/sec-public-source-adapter";
import { resolveSecPublicSourceRuntimePath } from "../agent/lib/public-source-flags";
import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
} from "../agent/lib/sec-ipo-evaluation";
import { SEC_IPO_SOURCE_ID, SEC_IPO_SOURCE_URL } from "../agent/lib/sec-ipo-reference";

class MemoryStore implements PublicSourceAcquisitionStoreClient {
  readonly records = new Map<string, string>();
  failNextSourceCursorUpdate = false;

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    if (
      this.failNextSourceCursorUpdate &&
      key.includes(":source-instance:") &&
      expected !== null
    ) {
      this.failNextSourceCursorUpdate = false;
      throw new Error("fixture_interrupted_before_cursor");
    }
    this.records.set(key, next);
    return true;
  }

  async get(key: string): Promise<unknown> {
    return this.records.get(key) ?? null;
  }
}

const fixtureRoot = new URL("./fixtures/sec-ipo/", import.meta.url);
const corpus = JSON.parse(await readFile(
  new URL("./fixtures/public-source-adapters/sec/corpus.json", import.meta.url),
  "utf8",
)) as {
  cases: Array<{
    expectedBaseline?: boolean;
    expectedCoverage: string;
    expectedErrorCode?: string;
    expectedFacts: Array<{ sourceNativeId: string }>;
    expectedStatus: string;
    fixtureId: string;
  }>;
};
const fixture = (name: string) => readFile(new URL(name, fixtureRoot), "utf8");
const contentType = "application/atom+xml; charset=UTF-8";
const response = async (name: string, observedAt: string) => ({
  body: await fixture(name),
  contentType,
  finalUrl: SEC_IPO_SOURCE_URL,
  observedAt,
  requestedUrl: SEC_IPO_SOURCE_URL,
  status: 200,
});
const window = (endAt: string) => ({
  endAt,
  startAt: new Date(Date.parse(endAt) - 60 * 60 * 1_000).toISOString(),
});

const reviewed = resolveReviewedPublicSource(SEC_IPO_SOURCE_ID);
assert.equal(reviewed.adapterDefinition.adapterId, "sec-latest-filings");
assert.equal(reviewed.sourceInstance.configuration.canonicalUrl, SEC_IPO_SOURCE_URL);
assert.equal(reviewed.sourceContract.contractDigest.length, 64);
assert.throws(
  () => resolveReviewedPublicSource("unreviewed-source"),
  ReviewedPublicSourceRegistryError,
);

assert.equal(resolveSecPublicSourceRuntimePath({}), "legacy_sec_workspace_worker");
assert.equal(
  resolveSecPublicSourceRuntimePath({
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
  }),
  "public_source_adapter",
);
assert.equal(
  resolveSecPublicSourceRuntimePath({
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED: "0",
  }),
  "legacy_sec_workspace_worker",
);

const client = new MemoryStore();
const baselineResponse = await response("initial.atom", "2026-08-14T17:05:00.000Z");
const baseline = await runSecPublicSourceAcquisition({
  client,
  response: baselineResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(baselineResponse.observedAt),
});
assert.equal(baseline.acquisition.result.status, "complete");
assert.equal(baseline.acquisition.baselineEstablished, true);
assert.equal(baseline.acquisition.facts.length, 2);
assert.ok(baseline.commit);
assert.equal(baseline.commit.journal.status, "committed");
assert.equal(baseline.commit.sourceInstance.cursor.revision, 1);
assert.equal(baseline.commit.factsCreated, 2);
assert.equal(JSON.stringify(baseline.acquisition.facts).includes("workspaceId"), false);

const legacyInitialPage = normalizeSecIpoFetch(baselineResponse);
const legacyInitial = evaluateSecIpoPage(
  legacyInitialPage,
  null,
  { ownerId: "owner_fixture", workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
);
assert.equal(
  baseline.commit.sourceInstance.cursor.watermark,
  legacyInitial.checkpoint.watermark,
);
assert.deepEqual(
  baseline.acquisition.facts.map((fact) => ({
    accessionNumber: fact.payload.schemaVersion === "sec-filing/v1"
      ? fact.payload.accessionNumber
      : null,
    formType: fact.payload.schemaVersion === "sec-filing/v1" ? fact.payload.formType : null,
  })),
  legacyInitialPage.filings.map((filing) => ({
    accessionNumber: filing.accessionNumber,
    formType: filing.formType,
  })),
);

const noChangeResponse = await response("initial.atom", "2026-08-14T17:10:00.000Z");
const noChange = await runSecPublicSourceAcquisition({
  client,
  response: noChangeResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(noChangeResponse.observedAt),
});
assert.equal(noChange.acquisition.result.status, "no_change");
assert.equal(noChange.acquisition.facts.length, 0);
assert.ok(noChange.commit);
assert.equal(noChange.commit.sourceInstance.cursor.revision, 2);

const laterResponse = await response("later-s1.atom", "2026-08-14T18:05:00.000Z");
const later = await runSecPublicSourceAcquisition({
  client,
  response: laterResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(laterResponse.observedAt),
});
assert.equal(later.acquisition.result.status, "complete");
assert.equal(later.acquisition.facts.length, 1);
assert.ok(later.commit);
assert.equal(later.acquisition.facts[0]?.payload.schemaVersion, "sec-filing/v1");
assert.equal(
  later.acquisition.facts[0]?.payload.schemaVersion === "sec-filing/v1"
    ? later.acquisition.facts[0].payload.fileNumber
    : null,
  "333-100003",
);

const amendmentResponse = await response("amendment.atom", "2026-08-14T19:05:00.000Z");
const amendment = await runSecPublicSourceAcquisition({
  client,
  response: amendmentResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(amendmentResponse.observedAt),
});
assert.equal(amendment.acquisition.facts.length, 1);
assert.ok(amendment.commit);
const amendmentPayload = amendment.acquisition.facts[0]?.payload;
assert.equal(amendmentPayload?.schemaVersion, "sec-filing/v1");
assert.equal(
  amendmentPayload?.schemaVersion === "sec-filing/v1"
    ? amendmentPayload.amendmentOfAccessionNumber
    : null,
  "0001000003-26-000001",
);

const cursorBeforeFailures = amendment.commit.sourceInstance.cursor;
const malformedResponse = await response("malformed.atom", "2026-08-14T20:05:00.000Z");
const malformed = await runSecPublicSourceAcquisition({
  client,
  response: malformedResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(malformedResponse.observedAt),
});
assert.equal(malformed.acquisition.result.status, "terminal_failure");
assert.equal(malformed.acquisition.result.errorCode, "xml_invalid");
assert.equal(malformed.commit, null);
assert.deepEqual((await readPublicSourceInstance(reviewed.sourceInstance.sourceInstanceId, client))?.cursor, cursorBeforeFailures);

const partialResponse = await response("incomplete.atom", "2026-08-14T20:10:00.000Z");
const partial = await runSecPublicSourceAcquisition({
  client,
  response: partialResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(partialResponse.observedAt),
});
assert.equal(partial.acquisition.result.status, "partial");
assert.equal(partial.acquisition.result.errorCode, "parser_incomplete");
assert.equal(partial.commit, null);

for (const [fixtureCase, actual] of corpus.cases.map((fixtureCase, index) => [
  fixtureCase,
  [baseline, noChange, later, amendment, malformed, partial][index],
] as const)) {
  assert.ok(actual, fixtureCase.fixtureId);
  assert.equal(actual.acquisition.result.status, fixtureCase.expectedStatus, fixtureCase.fixtureId);
  assert.equal(actual.acquisition.result.coverage, fixtureCase.expectedCoverage, fixtureCase.fixtureId);
  assert.equal(
    actual.acquisition.baselineEstablished,
    fixtureCase.expectedBaseline ?? false,
    fixtureCase.fixtureId,
  );
  assert.equal(
    actual.acquisition.result.errorCode,
    fixtureCase.expectedErrorCode ?? null,
    fixtureCase.fixtureId,
  );
  assert.deepEqual(
    actual.acquisition.facts.map((fact) => fact.sourceNativeId),
    fixtureCase.expectedFacts.map((fact) => fact.sourceNativeId),
    fixtureCase.fixtureId,
  );
}

const interruptedClient = new MemoryStore();
interruptedClient.failNextSourceCursorUpdate = true;
await assert.rejects(
  runSecPublicSourceAcquisition({
    client: interruptedClient,
    response: baselineResponse,
    sourceId: SEC_IPO_SOURCE_ID,
    window: window(baselineResponse.observedAt),
  }),
  /fixture_interrupted_before_cursor/u,
);
const preparedAcquisition = acquireSecPublicSource({
  response: baselineResponse,
  sourceInstance: reviewed.sourceInstance,
  window: window(baselineResponse.observedAt),
});
assert.equal(
  (await readPublicSourceAcquisitionJournal(
    preparedAcquisition.result.acquisitionId,
    interruptedClient,
  ))?.status,
  "committed",
);
const recovered = await runSecPublicSourceAcquisition({
  client: interruptedClient,
  response: baselineResponse,
  sourceId: SEC_IPO_SOURCE_ID,
  window: window(baselineResponse.observedAt),
});
assert.ok(recovered.commit);
assert.equal(recovered.commit.sourceInstance.cursor.revision, 1);
assert.equal(recovered.commit.factsCreated, 0);
assert.equal(recovered.commit.factsReused, 2);

// The generic kernel also persists a new immutable revision and its correction
// idempotently without changing the first observation of an existing revision.
const correctionClient = new MemoryStore();
await ensurePublicSourceInstance(reviewed.sourceInstance, correctionClient);
const firstFact = baseline.acquisition.facts[0]!;
const firstOnly = acquireSecPublicSource({
  response: baselineResponse,
  sourceInstance: reviewed.sourceInstance,
  window: window(baselineResponse.observedAt),
});
const firstFactAcquisition = {
  ...firstOnly,
  facts: [firstFact],
  result: {
    ...firstOnly.result,
    candidateFactRevisionIds: [firstFact.revisionId],
  },
};
await commitPublicSourceAcquisition({
  acquisition: firstFactAcquisition,
  client: correctionClient,
});
const correctedPayload = {
  ...firstFact.payload,
  companyName: "Fixture Registration Corporation",
};
const correctedDigest = digestPublicSourceValue(correctedPayload);
const correctedFact: CanonicalPublicFactRevision = {
  ...firstFact,
  createdObservedAt: "2026-08-14T18:05:00.000Z",
  payload: correctedPayload,
  payloadDigest: correctedDigest,
  revisionId: deriveCanonicalPublicFactRevisionId({
    logicalKey: firstFact.logicalKey,
    payloadDigest: correctedDigest,
  }),
};
const correction = publicSourceCorrectionSchema.parse({
  correctionId: `correction.${digestPublicSourceValue([
    firstFact.logicalKey,
    firstFact.revisionId,
    correctedFact.revisionId,
    "source_correction",
  ])}`,
  createdObservedAt: "2026-08-14T18:05:00.000Z",
  fromRevisionId: firstFact.revisionId,
  logicalKey: firstFact.logicalKey,
  reason: "source_correction",
  recordType: "public_source_fact_correction",
  schemaVersion: 1,
  toRevisionId: correctedFact.revisionId,
});
const correctedCursorSource = (await readPublicSourceInstance(
  reviewed.sourceInstance.sourceInstanceId,
  correctionClient,
))!;
const correctionAcquisition = {
  ...firstFactAcquisition,
  corrections: [correction],
  facts: [correctedFact],
  result: {
    ...firstFactAcquisition.result,
    acquisitionId: `acquisition.${"c".repeat(64)}`,
    candidateFactRevisionIds: [correctedFact.revisionId],
    correctionIds: [correction.correctionId],
    observedAt: "2026-08-14T18:05:00.000Z",
    proposedNextCursor: {
      contentDigest: correctedDigest,
      expectedRevision: correctedCursorSource.cursor.revision,
      watermark: "2026-08-14T18:00:00.000Z",
    },
  },
  window: window("2026-08-14T18:05:00.000Z"),
};
const correctionCommit = await commitPublicSourceAcquisition({
  acquisition: correctionAcquisition,
  client: correctionClient,
});
const correctionReplay = await commitPublicSourceAcquisition({
  acquisition: correctionAcquisition,
  client: correctionClient,
});
assert.equal(correctionCommit.correctionsCreated, 1);
assert.equal(correctionReplay.correctionsReused, 1);
assert.equal(
  (await readPublicSourceFactRevision(firstFact.revisionId, correctionClient))?.createdObservedAt,
  firstFact.createdObservedAt,
);

console.info("Public-source SEC acquisition and kernel verification passed.");
