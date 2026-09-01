import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import {
  PUBLIC_SOURCE_RUNTIME_COUNTERS,
  parsePublicSourceRuntimeObservation,
} from "../agent/lib/public-source-observability";
import {
  PublicSourceCoordinatorError,
  coordinatePublicSourceOccurrence,
} from "../agent/lib/public-source-coordinator";
import {
  resolveHousePublicSourceRuntimePath,
  resolveSecPublicSourceRuntimePath,
} from "../agent/lib/public-source-flags";
import { readPublicSourceWorkspaceHealth } from "../agent/lib/public-source-health";
import { createPublicSourceSubscription, resolvePublicSourceWorkspaceReference } from "../agent/lib/public-source-workspace-reference";
import { ensurePublicSourceInstance, type PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { ensurePublicSourceSubscription, type PublicSourceSubscriptionStoreClient } from "../agent/lib/public-source-subscription-store";
import {
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import {
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL,
} from "../agent/lib/strategy-pack-reference-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements PublicSourceAcquisitionStoreClient, PublicSourceSubscriptionStoreClient {
  readonly records = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }

  async get(key: string): Promise<unknown> {
    return this.records.get(key) ?? null;
  }
}

const fullyEnabled = {
  EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
  EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
};
const routedRecovery = {
  EVE_HYBRID_FAST_MODEL_ID: "fixture/extractor",
  EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "fixture/frontier",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
};

assert.equal(resolveSecPublicSourceRuntimePath({}), "legacy_sec_workspace_worker");
assert.equal(resolveHousePublicSourceRuntimePath({}), "disabled");
assert.equal(resolveSecPublicSourceRuntimePath(fullyEnabled), "public_source_adapter");
assert.equal(resolveHousePublicSourceRuntimePath(fullyEnabled), "public_source_adapter");
assert.equal(
  resolveSecPublicSourceRuntimePath({ EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED: "1" }),
  "public_source_misconfigured",
);
assert.equal(
  resolveHousePublicSourceRuntimePath({ EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1" }),
  "public_source_misconfigured",
);

let disabledFetches = 0;
await assert.rejects(
  coordinatePublicSourceOccurrence({
    environment: {},
    fetch: {
      adapterId: "house-financial-disclosures",
      fetchDocument: async () => {
        disabledFetches += 1;
        throw new Error("disabled fetch must not run");
      },
      fetchIndex: async () => {
        disabledFetches += 1;
        throw new Error("disabled fetch must not run");
      },
    },
    monitor: {
      lifecycleState: "enabled",
      managedBy: null,
      monitorId: "123e4567-e89b-42d3-a456-426614174001",
      publicSourceSubscriptions: [],
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    },
    scope: {} as never,
    sourceId: "house-financial-disclosures-2026",
    window: {
      endAt: "2026-08-15T18:00:00.000Z",
      startAt: "2026-08-15T12:00:00.000Z",
    },
  }),
  (error) => error instanceof PublicSourceCoordinatorError && error.code === "public_source_disabled",
);
assert.equal(disabledFetches, 0);
await assert.rejects(
  coordinatePublicSourceOccurrence({
    environment: { EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1" },
    fetch: {
      adapterId: "house-financial-disclosures",
      fetchDocument: async () => {
        disabledFetches += 1;
        throw new Error("partial flag fetch must not run");
      },
      fetchIndex: async () => {
        disabledFetches += 1;
        throw new Error("partial flag fetch must not run");
      },
    },
    monitor: {
      lifecycleState: "enabled",
      managedBy: null,
      monitorId: "123e4567-e89b-42d3-a456-426614174001",
      publicSourceSubscriptions: [],
      workspaceId: "123e4567-e89b-42d3-a456-426614174000",
    },
    scope: {} as never,
    sourceId: "house-financial-disclosures-2026",
    window: {
      endAt: "2026-08-15T18:00:00.000Z",
      startAt: "2026-08-15T12:00:00.000Z",
    },
  }),
  (error) => error instanceof PublicSourceCoordinatorError &&
    error.code === "public_source_misconfigured",
);
assert.equal(disabledFetches, 0);

assert.equal(new Set(PUBLIC_SOURCE_RUNTIME_COUNTERS).size, 7);
for (const observation of [
  { counter: "public_source_acquisition_total", outcome: "complete" },
  { counter: "public_source_fact_revision_total", operation: "created", value: 2 },
  { counter: "public_source_correction_total", operation: "reused" },
  { counter: "public_source_retraction_total", operation: "created" },
  { counter: "public_source_acquisition_reused_total" },
  { counter: "public_source_projection_total", operation: "created" },
  {
    counter: "public_source_failure_total",
    errorCode: "pdf_scanned_unsupported",
    stage: "pdf",
  },
]) {
  assert.deepEqual(parsePublicSourceRuntimeObservation(observation), {
    ...observation,
    value: "value" in observation ? observation.value : 1,
  });
}
for (const invalid of [
  { counter: "public_source_acquisition_total", sourceId: "private-source" },
  { counter: "public_source_projection_total", operation: "created", workspaceId: "private" },
  { counter: "public_source_failure_total", errorCode: "arbitrary", stage: "pdf" },
  { counter: "public_source_failure_total", errorCode: "pdf_invalid", stage: "private-stage" },
]) {
  assert.throws(() => parsePublicSourceRuntimeObservation(invalid));
}

const ownerId = "owner_fixture";
const authorizationEnvironment = { EVE_DEPLOYMENT_OWNER_ID: ownerId };
const workspaceA = "123e4567-e89b-42d3-a456-426614174000";
const workspaceB = "223e4567-e89b-42d3-a456-426614174000";
const secMonitorId = "123e4567-e89b-42d3-a456-426614174011";
const houseMonitorA = "123e4567-e89b-42d3-a456-426614174012";
const houseMonitorB = "223e4567-e89b-42d3-a456-426614174012";
const scopeA = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId: workspaceA },
  authorizationEnvironment,
);
const scopeB = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId: workspaceB },
  authorizationEnvironment,
);
const monitor = (input: { monitorId: string; sourceId: string; workspaceId: string }) => ({
  lifecycleState: "enabled",
  managedBy: null,
  monitorId: input.monitorId,
  publicSourceSubscriptions: [resolvePublicSourceWorkspaceReference(input)],
  workspaceId: input.workspaceId,
});
const store = new MemoryStore();
const observations: Array<ReturnType<typeof parsePublicSourceRuntimeObservation>> = [];

// Connector-owned recovery construction registers at the coordinator boundary;
// the shared coordinator does not construct the House implementation itself.
const extensionStore = new MemoryStore();
const extensionObservedAt = "2026-08-15T17:30:00.000Z";
const [extensionArchive, extensionPdf] = await Promise.all([
  readFile(new URL("./fixtures/public-source-adapters/house/real-layout/2026FD.zip", import.meta.url)),
  readFile(new URL("./fixtures/public-source-adapters/house/real-layout/ptr-scanned.pdf", import.meta.url)),
]);
let singleModelFetches = 0;
await assert.rejects(coordinatePublicSourceOccurrence({
  environment: {
    ...fullyEnabled,
    ...routedRecovery,
    EVE_HYBRID_EVIDENCE_ENABLED: "1",
    EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
    EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/extractor",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  },
  fetch: {
    adapterId: "house-financial-disclosures",
    fetchDocument: async () => { singleModelFetches += 1; throw new Error("must fail before fetch"); },
    fetchIndex: async () => { singleModelFetches += 1; throw new Error("must fail before fetch"); },
  },
  monitor: monitor({ monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA }),
  scope: scopeA,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: "2026-08-15T16:00:00.000Z", endAt: extensionObservedAt },
}), (error) => error instanceof PublicSourceCoordinatorError &&
  error.code === "public_source_misconfigured" && error.message === "public_source_house_ocr_invalid");
assert.equal(singleModelFetches, 0);
let extensionCreations = 0;
const extensionResult = await coordinatePublicSourceOccurrence({
  clients: { acquisition: extensionStore, hybridLineage: extensionStore, subscription: extensionStore },
  environment: {
    ...fullyEnabled,
    ...routedRecovery,
    EVE_HYBRID_EVIDENCE_ENABLED: "1",
    EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
    EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/extractor,fixture/independent-ocr,fixture/frontier,fixture/reviewed-ocr",
    EVE_HOUSE_EXTRACTION_MODEL_ID: "fixture/frontier",
    EVE_HOUSE_INDEPENDENT_OCR_MODEL_ID: "fixture/reviewed-ocr",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  },
  fetch: {
    adapterId: "house-financial-disclosures",
    fetchDocument: async (url) => ({
      body: new Uint8Array(extensionPdf), contentType: "application/pdf", finalUrl: url,
      observedAt: extensionObservedAt, requestedUrl: url, status: 200,
    }),
    fetchIndex: async (url) => ({
      body: new Uint8Array(extensionArchive), contentType: "application/zip", finalUrl: url,
      observedAt: extensionObservedAt, requestedUrl: url, status: 200,
    }),
  },
  hybridRecoveryExtensions: [{
    adapterId: "house-financial-disclosures",
    create({ budgetScope, modelIds, parentBudgetRunId }) {
      extensionCreations += 1;
      assert.equal(budgetScope?.workspaceId, scopeA.workspaceId);
      assert.deepEqual(modelIds, ["fixture/frontier", "fixture/reviewed-ocr"]);
      assert.equal(parentBudgetRunId, "parent-run.fixture-extension");
      return {
        async recover({ row }) {
          return {
            document: {
              docId: row.docId,
              filerName: [row.filer.prefix, row.filer.firstName, row.filer.lastName, row.filer.suffix]
                .filter((value): value is string => value !== null).join(" "),
              filingDate: row.filingDate,
              isAmendment: false,
              stateDistrict: row.filer.stateDistrict,
            },
            resultId: "hybrid-result.fixture-extension",
            rows: [],
          };
        },
      };
    },
  }],
  monitor: monitor({ monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA }),
  observedAt: new Date(extensionObservedAt),
  parentBudgetRunId: "parent-run.fixture-extension",
  scope: scopeA,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: "2026-08-15T16:30:00.000Z", endAt: extensionObservedAt },
});
assert.equal(extensionCreations, 1);
assert.equal(extensionResult.acquisition.status, "complete");

const secObservedAt = "2026-08-15T18:00:00.000Z";
const secBody = await readFile(
  new URL("./fixtures/sec-ipo/initial.atom", import.meta.url),
  "utf8",
);
let secFetches = 0;
const sec = await coordinatePublicSourceOccurrence({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  fetch: {
    adapterId: "sec-latest-filings",
    fetchResponse: async () => {
      secFetches += 1;
      return {
        body: secBody,
        contentType: "application/atom+xml; charset=UTF-8",
        finalUrl: SEC_IPO_SOURCE_URL,
        observedAt: secObservedAt,
        requestedUrl: SEC_IPO_SOURCE_URL,
        status: 200,
      };
    },
  },
  monitor: monitor({ monitorId: secMonitorId, sourceId: SEC_IPO_SOURCE_ID, workspaceId: workspaceA }),
  observedAt: new Date(secObservedAt),
  scope: scopeA,
  sink: (observation) => observations.push(observation),
  sourceId: SEC_IPO_SOURCE_ID,
  window: { startAt: "2026-08-15T17:00:00.000Z", endAt: secObservedAt },
});
assert.equal(secFetches, 1);
assert.equal(sec.acquisition.status, "complete");
assert.equal(sec.projection?.projections.length, 2);

const houseObservedAt = "2026-08-15T18:30:00.000Z";
const [houseArchive, scannedPdf] = await Promise.all([
  readFile(new URL("./fixtures/public-source-adapters/house/real-layout/2026FD.zip", import.meta.url)),
  readFile(new URL("./fixtures/public-source-adapters/house/real-layout/ptr-scanned.pdf", import.meta.url)),
]);
let houseFetches = 0;
const houseFetch = {
  adapterId: "house-financial-disclosures" as const,
  fetchDocument: async (url: string) => {
    houseFetches += 1;
    return {
      body: new Uint8Array(scannedPdf),
      contentType: "application/pdf",
      finalUrl: url,
      observedAt: houseObservedAt,
      requestedUrl: url,
      status: 200,
    };
  },
  fetchIndex: async (url: string) => {
    houseFetches += 1;
    return {
      body: new Uint8Array(houseArchive),
      contentType: "application/zip",
      finalUrl: url,
      observedAt: houseObservedAt,
      requestedUrl: url,
      status: 200,
    };
  },
};
const houseWindow = { startAt: "2026-08-15T12:30:00.000Z", endAt: houseObservedAt };
// Migration can start the ordered journal after older source revisions.
// Acknowledgement counts must not be mistaken for source cursor revisions.
const houseSeed = resolveReviewedPublicSource(HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID).sourceInstance;
await ensurePublicSourceInstance({ ...houseSeed, cursor: { ...houseSeed.cursor, revision: 4 } }, store);
const missingSequenceStore = new MemoryStore();
const missingSequenceReference = resolvePublicSourceWorkspaceReference({
  monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA,
});
await ensurePublicSourceInstance({ ...houseSeed, cursor: { ...houseSeed.cursor, revision: 4 } }, missingSequenceStore);
await ensurePublicSourceSubscription(scopeA, createPublicSourceSubscription({
  binding: null, lifecycleState: "active", monitorId: houseMonitorA,
  reference: missingSequenceReference, workspaceId: workspaceA,
}), missingSequenceStore);
await assert.rejects(readPublicSourceWorkspaceHealth({
  clients: { acquisition: missingSequenceStore, subscription: missingSequenceStore },
  environment: fullyEnabled, reference: missingSequenceReference, scope: scopeA,
}), /public_source_reference_mismatch/, "missing delivery metadata cannot prove caught-up state");
const houseA = await coordinatePublicSourceOccurrence({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  fetch: houseFetch,
  monitor: monitor({ monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA }),
  observedAt: new Date(houseObservedAt),
  scope: scopeA,
  sink: (observation) => observations.push(observation),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: houseWindow,
});
assert.equal(houseA.acquisition.status, "complete");
assert.equal(houseA.acquisition.coverage, "unsupported");
assert.equal(houseA.unresolvedFilingCount, 1);
assert.equal(houseA.sourceContinuationPending, false,
  "a filing whose retry is deferred must not cause one-minute polling loops");
assert.equal(houseA.projection?.projections.length, 0, "unresolved headers must not be projected");
assert.ok(houseA.workspaceCheckpoint);
assert.ok(houseA.acquisition.proposedNextCursor);
assert.equal(houseFetches, 2);

const queuedStore = new MemoryStore();
const queuedWriter = new ZipWriter(new Uint8ArrayWriter());
const queuedRows = Array.from({ length: 26 }, (_, index) => `
  <Member><Prefix>Hon.</Prefix><Last>Sample</Last><First>Jordan</First><Suffix>Jr.</Suffix>
    <FilingType>P</FilingType><StateDst>OR03</StateDst><Year>2026</Year>
    <FilingDate>3/4/2026</FilingDate><DocID>${21_100_000 + index}</DocID></Member>`).join("");
await queuedWriter.add("2026FD.xml", new TextReader(
  `<?xml version="1.0" encoding="UTF-8"?><FinancialDisclosure>${queuedRows}</FinancialDisclosure>`,
));
const queuedArchive = await queuedWriter.close();
const queuedAt = "2026-08-15T18:31:00.000Z";
const queued = await coordinatePublicSourceOccurrence({
  clients: { acquisition: queuedStore, subscription: queuedStore },
  environment: fullyEnabled,
  fetch: {
    adapterId: "house-financial-disclosures",
    fetchDocument: async (url) => ({
      body: new Uint8Array(scannedPdf), contentType: "application/pdf", finalUrl: url,
      observedAt: queuedAt, requestedUrl: url, status: 200,
    }),
    fetchIndex: async (url) => ({
      body: new Uint8Array(queuedArchive), contentType: "application/zip", finalUrl: url,
      observedAt: queuedAt, requestedUrl: url, status: 200,
    }),
  },
  monitor: monitor({ monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA }),
  observedAt: new Date(queuedAt),
  scope: scopeA,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: houseObservedAt, endAt: queuedAt },
});
assert.equal(queued.unresolvedFilingCount, 26);
assert.equal(queued.sourceContinuationPending, true,
  "unattempted archive filings must schedule another bounded source page");

const referenceB = resolvePublicSourceWorkspaceReference({
  monitorId: houseMonitorB,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  workspaceId: workspaceB,
});
const behind = await readPublicSourceWorkspaceHealth({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  reference: referenceB,
  scope: scopeB,
});
assert.equal(behind.healthState, "degraded");
assert.equal(behind.extraction.state, "unsupported");
assert.equal(behind.subscription.state, "not_initialized");
assert.equal(behind.subscription.lag, 1);
assert.equal(JSON.stringify(behind).includes("acquisition."), false);
assert.equal(JSON.stringify(behind).includes(HOUSE_FINANCIAL_DISCLOSURES_SOURCE_URL), false);
assert.equal(JSON.stringify(behind).includes(workspaceA), false);

const houseB = await coordinatePublicSourceOccurrence({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  fetch: houseFetch,
  monitor: monitor({ monitorId: houseMonitorB, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceB }),
  observedAt: new Date(houseObservedAt),
  scope: scopeB,
  sink: (observation) => observations.push(observation),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: houseWindow,
});
assert.equal(houseB.reused, true);
assert.equal(houseFetches, 2);
assert.equal(houseB.projection?.projections.length, 0);
const caughtUp = await readPublicSourceWorkspaceHealth({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  reference: referenceB,
  scope: scopeB,
});
assert.equal(caughtUp.subscription.state, "caught_up");
assert.equal(caughtUp.subscription.lag, 0);
assert.equal(caughtUp.healthState, "degraded", "delivery progress must not conceal incomplete extraction");
assert.deepEqual(caughtUp.sourceBacklog, {
  phase: "live",
  unresolvedFilings: 1,
}, "workspace journal catch-up must remain distinct from the global House archive backlog");
const quietStore = new MemoryStore();
for (const [key, value] of store.records) quietStore.records.set(key, value);
const quietAt = "2026-08-15T18:40:00.000Z";
const quiet = await coordinatePublicSourceOccurrence({
  clients: { acquisition: quietStore, subscription: quietStore },
  environment: fullyEnabled,
  fetch: { ...houseFetch, fetchIndex: async (url) => ({
    body: new Uint8Array(houseArchive), contentType: "application/zip",
    finalUrl: url, requestedUrl: url, observedAt: quietAt, status: 200,
  }) },
  monitor: monitor({ monitorId: houseMonitorB, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceB }),
  observedAt: new Date(quietAt), scope: scopeB,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: houseObservedAt, endAt: quietAt },
});
assert.equal(quiet.acquisition.candidateFactRevisionIds.length, 0);
const quietHealth = await readPublicSourceWorkspaceHealth({
  clients: { acquisition: quietStore, subscription: quietStore },
  environment: fullyEnabled, scope: scopeA,
  reference: resolvePublicSourceWorkspaceReference({
    monitorId: houseMonitorA, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceA,
  }),
});
assert.equal(quietHealth.subscription.lag, 0, "empty committed batches must not create a false backlog");
assert.equal(quietHealth.subscription.state, "caught_up");
assert.equal(quietHealth.healthState, "degraded", "queued extraction gaps remain visible after a quiet poll");
assert.deepEqual(quietHealth.sourceBacklog, {
  phase: "live",
  unresolvedFilings: 1,
}, "a quiet poll must retain the durable global backlog count");
assert.ok(observations.some((item) => item.counter === "public_source_acquisition_reused_total"));
assert.ok(observations.some((item) => item.counter === "public_source_fact_revision_total"));
assert.ok(observations.some((item) => item.counter === "public_source_projection_total"));

const failedAt = "2026-08-16T00:30:00.000Z";
const failed = await coordinatePublicSourceOccurrence({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  fetch: {
    adapterId: "house-financial-disclosures",
    fetchDocument: async () => {
      throw new Error("failed archive must not select a document");
    },
    fetchIndex: async (url) => ({
      body: new Uint8Array(houseArchive),
      contentType: "text/plain",
      finalUrl: url,
      observedAt: failedAt,
      requestedUrl: url,
      status: 200,
    }),
  },
  monitor: monitor({ monitorId: houseMonitorB, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID, workspaceId: workspaceB }),
  scope: scopeB,
  sink: (observation) => observations.push(observation),
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: houseObservedAt, endAt: failedAt },
});
assert.equal(failed.acquisition.status, "terminal_failure");
assert.equal(failed.projection, null);
const degradedAfterFailure = await readPublicSourceWorkspaceHealth({
  clients: { acquisition: store, subscription: store },
  environment: fullyEnabled,
  reference: referenceB,
  scope: scopeB,
});
assert.equal(degradedAfterFailure.lastCompleteAcquisition?.observedAt, houseObservedAt);
assert.equal(degradedAfterFailure.lastOutcome?.status, "terminal_failure");
assert.equal(degradedAfterFailure.lastOutcome?.failureStage, "archive");
assert.equal(degradedAfterFailure.subscription.state, "caught_up");
assert.ok(observations.some((item) => item.counter === "public_source_failure_total"));

await assert.rejects(
  readPublicSourceWorkspaceHealth({
    clients: { acquisition: store, subscription: store },
    environment: fullyEnabled,
    reference: referenceB,
    scope: { ownerId, workspaceId: workspaceB },
  }),
  /authoritative owner and workspace scope/u,
);

console.info("Public-source runtime integration verification passed.");

/*
 * An entity URL that the statement schema would reject must be dropped, never
 * fatal. `safePublicUrl` requires `url.toString() === value`, so an ordinary
 * bare-domain link normalizes to a trailing slash and fails - and before this
 * it failed the whole statement, losing every post in the window and
 * terminalizing the occurrence as `acquisition_uncertain`. Five of those
 * auto-paused a live monitor.
 */
{
  const { safePublicUrl } = await import("../agent/lib/public-commentary-schema");
  const rejected = [
    "https://www.kobeissiletter.com",
    "https://example.com/article#section",
    "http://example.com/insecure",
    "https://EXAMPLE.com/Caps",
  ];
  for (const url of rejected) {
    assert.equal(safePublicUrl(url), false, `expected the schema to reject ${url}`);
  }
  assert.equal(safePublicUrl("https://example.com/article"), true);
  const source = await readFile(
    new URL("../agent/lib/x-public-statement-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /expanded_url && safePublicUrl\(expanded_url\)/u,
    "the adapter must filter entity URLs through the schema's own predicate",
  );
}
console.info("Public commentary entity-URL tolerance verified.");
