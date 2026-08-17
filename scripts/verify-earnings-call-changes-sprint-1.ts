import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  EARNINGS_CALL_ISSUER_CATALOG,
  resolveEarningsCallIssuer,
} from "../agent/lib/earnings-call-issuer-catalog";
import { resolveCatalogBackedOptions } from "../agent/lib/catalog-backed-configuration";
import {
  resolveStrategyPackConfiguration,
  resolveStrategyPackSourceInstances,
} from "../agent/lib/strategy-pack-service";
import { strategyPackConfigurationFieldSchema } from "../agent/lib/strategy-pack-schema";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  deriveEarningsCallPublicSource,
  EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER,
  EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES,
  reviewedParameterizedSourceFamilySchema,
} from "../agent/lib/earnings-call-public-source-contract";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST } from "../agent/lib/strategy-pack-reference-catalog";
import reviewedProductionSourceFamilies from "../agent/lib/earnings-call-reviewed-source-families";
import {
  prepareWorkspaceManagedMonitorUpdate,
  prepareWorkspaceMonitorCreate,
} from "../agent/lib/workspace-monitor-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { coordinatePublicSourceOccurrence } from "../agent/lib/public-source-coordinator";
import { acknowledgePublicSourceProjection } from "../agent/lib/public-source-subscription-store";
import {
  runSharedEarningsCallPublicSourceAcquisition,
  type EarningsCallPublicSourceRequest,
  type EarningsCallPublicSourceResponse,
} from "../agent/lib/earnings-call-public-source-adapter";

class MemoryStore {
  readonly records = new Map<string, string>();
  activeFactHeadReads = 0;
  delayFactHeadReads = false;
  maximumConcurrentFactHeadReads = 0;

  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }

  async get(key: string): Promise<unknown> {
    if (this.delayFactHeadReads && key.includes(":fact-head:")) {
      this.activeFactHeadReads += 1;
      this.maximumConcurrentFactHeadReads = Math.max(
        this.maximumConcurrentFactHeadReads,
        this.activeFactHeadReads,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.activeFactHeadReads -= 1;
    }
    return this.records.get(key) ?? null;
  }
}

const reviewedSourceFixture = await readFile(
  new URL("./fixtures/earnings-call-changes/reviewed-public-source-families.json", import.meta.url),
  "utf8",
);
assert.deepEqual(reviewedProductionSourceFamilies, JSON.parse(reviewedSourceFixture));

const catalogField = {
  catalogDigest: EARNINGS_CALL_ISSUER_CATALOG.catalogDigest,
  catalogId: EARNINGS_CALL_ISSUER_CATALOG.catalogId,
  catalogRevision: EARNINGS_CALL_ISSUER_CATALOG.revision,
  default: ["0000789019"],
  description: "Selected SEC issuers.",
  key: "selectedIssuerCiks",
  kind: "catalog_id_list",
  label: "Companies",
  maximumItems: 8,
  minimumItems: 1,
  mutableAfterInstall: true,
  pauseManagedMonitorsOnChange: true,
  required: true,
  rolloverGenerationOnChange: true,
} as const;

assert.equal(EARNINGS_CALL_ISSUER_CATALOG.entries.length, 50);
assert.equal(strategyPackConfigurationFieldSchema.parse(catalogField).kind, "catalog_id_list");
const options = resolveCatalogBackedOptions(catalogField);
assert.equal(options.length, 50);
assert.equal(options.find(({ id }) => id === "0000789019")?.label, "MSFT — Microsoft Corporation");
assert.equal(options.find(({ id }) => id === "0000789019")?.coverageState, "coverage_unavailable");
assert.equal(options.find(({ id }) => id === "0000789019")?.coverageReason, "coverage_not_reviewed");
assert.equal(options.find(({ id }) => id === "0000019617")?.coverageState, "baseline_ready");
assert.equal(options.find(({ id }) => id === "0001341439")?.coverageState, "coverage_unavailable");
assert.equal(resolveEarningsCallIssuer("msft").cik, "0000789019");
assert.equal(resolveEarningsCallIssuer("Microsoft Corporation").cik, "0000789019");
assert.throws(() => resolveEarningsCallIssuer("M"), /issuer_match_ambiguous/u);

const base = strategyPackCatalog.entries.find(({ id }) => id === "ipo-filings")!;
const pack = { ...base, configuration: [...base.configuration, catalogField] };
assert.deepEqual(
  resolveStrategyPackConfiguration(pack, { selectedIssuerCiks: ["0000789019", "0001326801"] })
    .configuration.selectedIssuerCiks,
  ["0000789019", "0001326801"],
);
for (const invalid of [[], ["0000789019", "0000789019"], ["9999999999"]]) {
  assert.throws(
    () => resolveStrategyPackConfiguration(pack, { selectedIssuerCiks: invalid }),
    /strategy_pack_invalid_request/u,
  );
}

assert.equal(EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.length, 5);
assert.equal(EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.filter(
  ({ discoveryPolicy }) => discoveryPolicy.state === "supported",
).length, 1);
assert.equal(EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.filter(
  ({ discoveryPolicy }) => discoveryPolicy.state === "coverage_unavailable",
).length, 4);
assert.equal(
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST,
  EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.definitionDigest,
);
for (const family of EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES) {
  const derived = deriveEarningsCallPublicSource(family);
  assert.equal(derived.sourceInstance.configuration.cik, family.cik);
  assert.equal(derived.sourceInstance.configuration.familyDigest, family.familyDigest);
  assert.ok(derived.sourceInstance.sourceInstanceId.endsWith(family.familyDigest.slice(0, 16)));
  assert.ok(derived.sourceContract.allowedOrigins.includes("https://data.sec.gov"));
  assert.ok(family.baselineEvents.every(({ reviewedArtifact }) =>
    reviewedArtifact.byteCount > 100_000 && /^[a-f0-9]{64}$/u.test(reviewedArtifact.digest)));
  assert.equal(resolveReviewedPublicSource(derived.sourceId).sourceInstance.sourceInstanceId,
    derived.sourceInstance.sourceInstanceId);
  assert.throws(() => reviewedParameterizedSourceFamilySchema.parse({
    ...family,
    baselineEvents: family.baselineEvents.map((event, index) => index === 0
      ? { ...event, artifactUrl: "https://evil.example/transcript.pdf" }
      : event),
  }));
}

const logicalSource = {
  accessClassification: "public" as const,
  allowedOrigins: ["https://data.sec.gov"],
  canonicalUrl: "https://data.sec.gov/submissions/CIK0000000000.json",
  contractDigest: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.definitionDigest,
  contractVersion: "1.0.0",
  parameterization: {
    catalogDigest: EARNINGS_CALL_ISSUER_CATALOG.catalogDigest,
    catalogId: EARNINGS_CALL_ISSUER_CATALOG.catalogId,
    catalogRevision: EARNINGS_CALL_ISSUER_CATALOG.revision,
    selectionConfigurationKey: catalogField.key,
  },
  sourceId: "earnings-call-transcripts",
};
const parameterizedPack = {
  ...base,
  configuration: [...base.configuration, catalogField],
  sources: [...base.sources, logicalSource],
};
const initiallySelected = resolveStrategyPackSourceInstances(
  parameterizedPack,
  { selectedIssuerCiks: ["0000019617", "0000789019"] },
  [logicalSource.sourceId],
);
assert.deepEqual(
  initiallySelected.map(({ sourceId }) => sourceId),
  ["earnings-call-transcripts.0000019617"],
  "mixed selections must retain only reviewed sources with ongoing discovery",
);
assert.deepEqual(resolveStrategyPackSourceInstances(
  parameterizedPack,
  { selectedIssuerCiks: ["0000789019", "0001326801"] },
  [logicalSource.sourceId],
), [], "an all-unavailable selection remains saveable while paused");

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED: "1",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
};
const scopeA = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "10000000-0000-4000-8000-000000000001",
}, environment);
const sourceInput = (sources: ReturnType<typeof resolveStrategyPackSourceInstances>) =>
  sources.map((source) => ({
    accessClassification: source.accessClassification,
    canonicalUrl: source.canonicalUrl,
    origin: new URL(source.canonicalUrl).origin,
    sourceId: source.sourceId,
  }));
const preparedMonitor = prepareWorkspaceMonitorCreate({
  activateManagedMonitor: true,
  deliverySubscriptionId: "delivery.fixture",
  idempotencyKey: "earnings-call-reconciliation",
  instruction: "Watch selected earnings calls.",
  managedBy: {
    bindingRevision: 1,
    kind: "strategy_pack",
    packContentDigest: base.contentDigest,
    packId: "earnings-call-changes",
    packVersion: "1.0.0",
    resourceId: "earnings-call-monitor",
  },
  name: "Earnings calls",
  nextOccurrenceAt: "2026-08-18T16:00:00.000Z",
  now: new Date("2026-08-17T16:00:00.000Z"),
  publicSourceIds: initiallySelected.map(({ sourceId }) => sourceId),
  schedule: { kind: "daily_local", times: ["08:00"], timezone: "UTC" },
  scope: scopeA,
  sources: sourceInput(initiallySelected),
});
const reselected = resolveStrategyPackSourceInstances(
  parameterizedPack,
  { selectedIssuerCiks: ["0000019617", "0001048911"] },
  [logicalSource.sourceId],
);
const reconciled = prepareWorkspaceManagedMonitorUpdate({
  current: preparedMonitor.monitor,
  lifecycleState: "paused",
  managedBy: { ...preparedMonitor.monitor.managedBy!, bindingRevision: 2 },
  now: new Date("2026-08-17T16:05:00.000Z"),
  pauseReason: "strategy_pack_configuration",
  publicSourceIds: reselected.map(({ sourceId }) => sourceId),
  scope: scopeA,
  sources: sourceInput(reselected),
});
assert.equal(reconciled.monitor.configurationRevision, 2);
assert.deepEqual(
  reconciled.monitor.publicSourceSubscriptions?.map(({ sourceId }) => sourceId),
  ["earnings-call-transcripts.0000019617"],
);
assert.equal(
  reconciled.monitor.publicSourceSubscriptions?.[0]?.subscriptionId,
  preparedMonitor.monitor.publicSourceSubscriptions?.[0]?.subscriptionId,
);
const allUnavailable = prepareWorkspaceManagedMonitorUpdate({
  current: reconciled.monitor,
  lifecycleState: "paused",
  managedBy: { ...reconciled.monitor.managedBy!, bindingRevision: 3 },
  now: new Date("2026-08-17T16:10:00.000Z"),
  pauseReason: "strategy_pack_configuration",
  publicSourceIds: [],
  scope: scopeA,
  sources: [],
});
assert.deepEqual(allUnavailable.monitor.sources, []);
assert.deepEqual(allUnavailable.monitor.publicSourceSubscriptions, []);
const allUnavailableInput = {
  deliverySubscriptionId: "delivery.fixture",
  idempotencyKey: "earnings-call-all-unavailable",
  instruction: "Watch selected earnings calls.",
  managedBy: preparedMonitor.monitor.managedBy!,
  name: "Earnings calls unavailable",
  nextOccurrenceAt: "2026-08-18T16:00:00.000Z",
  now: new Date("2026-08-17T16:15:00.000Z"),
  publicSourceIds: [],
  schedule: { kind: "daily_local" as const, times: ["08:00"], timezone: "UTC" },
  scope: scopeA,
  sources: [],
};
const pausedAllUnavailable = prepareWorkspaceMonitorCreate(allUnavailableInput);
assert.equal(pausedAllUnavailable.monitor.lifecycleState, "paused");
assert.deepEqual(pausedAllUnavailable.monitor.sources, []);
assert.throws(() => prepareWorkspaceMonitorCreate({
  ...allUnavailableInput,
  activateManagedMonitor: true,
}), /monitor_invalid/u, "all-unavailable activation must fail closed");
const transitionStore = new MemoryStore();
assert.equal(await transitionStore.compareAndSet(preparedMonitor.recordKey, null, preparedMonitor.raw), true);
assert.equal(await transitionStore.compareAndSet(
  reconciled.recordKey,
  reconciled.expectedRaw,
  reconciled.nextRaw,
), true);
assert.equal(await transitionStore.compareAndSet(
  reconciled.recordKey,
  reconciled.expectedRaw,
  reconciled.nextRaw,
), false, "a stale in-flight configuration transition must not commit");

const sourceId = "earnings-call-transcripts.0000789019";
const reviewedBaselineSource = resolveReviewedPublicSource(sourceId);
const selectedSource = [{
  accessClassification: "public" as const,
  allowedOrigins: reviewedBaselineSource.sourceContract.allowedOrigins,
  canonicalUrl: reviewedBaselineSource.sourceContract.canonicalUrl,
  contractDigest: reviewedBaselineSource.sourceContract.contractDigest,
  contractVersion: reviewedBaselineSource.sourceContract.contractVersion,
  sourceId,
}];
const scopeB = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "20000000-0000-4000-8000-000000000002",
}, environment);
function acquisitionMonitor(scope: typeof scopeA, key: string) {
  return prepareWorkspaceMonitorCreate({
    deliverySubscriptionId: `delivery.${key}`,
    idempotencyKey: `earnings-call-${key}`,
    instruction: "Acquire issuer events without semantic analysis.",
    name: `Earnings ${key}`,
    nextOccurrenceAt: "2026-08-18T16:00:00.000Z",
    now: new Date("2026-08-17T16:00:00.000Z"),
    publicSourceIds: [sourceId],
    schedule: { kind: "daily_local" as const, times: ["08:00"], timezone: "UTC" },
    scope,
    sources: sourceInput(selectedSource),
  }).monitor;
}
const monitorA = acquisitionMonitor(scopeA, "alpha");
const monitorB = acquisitionMonitor(scopeB, "beta");
const store = new MemoryStore();
const observedAt = "2026-08-17T17:00:00.000Z";
const encoder = new TextEncoder();
const family = EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.find(({ cik }) => cik === "0000789019")!;
const secBody = encoder.encode(JSON.stringify({
  cik: "789019",
  filings: {
    recent: {
      accessionNumber: ["0001193125-26-123456", "0001193125-26-023456"],
      acceptanceDateTime: ["20260429170000", "20260128170000"],
      filingDate: ["2026-04-29", "2026-01-28"],
      form: ["8-K", "8-K"],
      primaryDocument: ["msft-20260429.htm", "msft-20260128.htm"],
      reportDate: ["2026-04-29", "2026-01-28"],
    },
  },
}));
let correctedCurrent = false;
let truncateCurrent = false;
let fetchCount = 0;
const secFetchTimes: number[] = [];
const fetchResponse = async (
  request: EarningsCallPublicSourceRequest,
): Promise<EarningsCallPublicSourceResponse> => {
  fetchCount += 1;
  assert.equal(request.headers["User-Agent"], "Eve verification ops@example.com");
  let body: Uint8Array;
  let contentType: string;
  if (request.kind === "sec_submissions") {
    secFetchTimes.push(Date.now());
    assert.equal(request.url, `https://data.sec.gov/submissions/CIK${family.cik}.json`);
    assert.equal(
      request.maximumBytes,
      8 * 1_024 * 1_024,
      "large-company SEC submissions histories must fit within the reviewed bounded fetch",
    );
    body = secBody;
    contentType = "application/json; charset=utf-8";
  } else {
    const event = family.baselineEvents.find(({ artifactUrl }) => artifactUrl === request.url);
    assert.ok(event);
    body = encoder.encode(`<!doctype html><html><body>${event.fiscalPeriod} prepared remarks and questions and answers${correctedCurrent && event.role === "current" ? " corrected" : ""}</body></html>`);
    contentType = "text/html; charset=utf-8";
  }
  return {
    body,
    contentType,
    finalUrl: request.url,
    observedAt,
    redirectChain: [request.url],
    redirectCount: 0,
    requestedUrl: request.url,
    status: 200,
    ...(truncateCurrent && request.kind === "transcript_artifact" ? { truncated: true } : {}),
  };
};
const occurrence = {
  clients: { acquisition: store, subscription: store },
  deferProjectionAcknowledgement: true,
  environment,
  fetch: {
    adapterId: "earnings-call-transcripts" as const,
    fetchResponse,
    userAgent: "Eve verification ops@example.com",
  },
  observedAt: new Date(observedAt),
  sourceId,
  window: {
    endAt: "2026-08-17T18:00:00.000Z",
    startAt: "2026-08-17T16:00:00.000Z",
  },
};
store.delayFactHeadReads = true;
const first = await coordinatePublicSourceOccurrence({ ...occurrence, monitor: monitorA, scope: scopeA });
store.delayFactHeadReads = false;
assert.equal(first.reused, false);
assert.equal(first.baselineEstablished, true);
assert.equal(first.acquisition.candidateFactRevisionIds.length, 2);
assert.equal(first.projection?.projections.length, 2);
assert.equal(first.subscription.deliveryCursor.revision, 0);
assert.equal(fetchCount, 3);
assert.equal(
  store.maximumConcurrentFactHeadReads,
  2,
  "independent latest fact-head reads must run concurrently",
);
const second = await coordinatePublicSourceOccurrence({ ...occurrence, monitor: monitorB, scope: scopeB });
assert.equal(second.reused, true);
assert.equal(second.acquisition.acquisitionId, first.acquisition.acquisitionId);
assert.equal(fetchCount, 5, "the second workspace must hydrate only the two exact committed artifacts");
assert.equal(second.projection?.projections.length, 2);
assert.equal(second.subscription.deliveryCursor.revision, 0);
assert.notEqual(first.subscription.subscriptionId, second.subscription.subscriptionId);
assert.ok(first.projection?.projections.every(({ fact, projection }) =>
  projection.workspaceId === scopeA.workspaceId &&
  !JSON.stringify(fact).includes(scopeA.workspaceId) &&
  !JSON.stringify(fact).includes(scopeB.workspaceId)));
assert.ok(second.projection?.projections.every(({ projection }) =>
  projection.workspaceId === scopeB.workspaceId));
assert.notDeepEqual(
  first.projection?.projections.map(({ projection }) => projection.projectionId),
  second.projection?.projections.map(({ projection }) => projection.projectionId),
);

// Stand in for each workspace's durable no-match/finding outcome. Projection
// delivery is acknowledged only after that outcome exists and remains
// independently retryable for each workspace subscription.
const acknowledgedA = await acknowledgePublicSourceProjection({
  acquisitionId: first.acquisition.acquisitionId,
  expectedDeliveryRevision: first.subscription.deliveryCursor.revision,
  scope: scopeA,
  subscriptionId: first.subscription.subscriptionId,
}, store);
const acknowledgedB = await acknowledgePublicSourceProjection({
  acquisitionId: second.acquisition.acquisitionId,
  expectedDeliveryRevision: second.subscription.deliveryCursor.revision,
  scope: scopeB,
  subscriptionId: second.subscription.subscriptionId,
}, store);
assert.equal(acknowledgedA.deliveryCursor.revision, 1);
assert.equal(acknowledgedB.deliveryCursor.revision, 1);

const postCommitRetry = await runSharedEarningsCallPublicSourceAcquisition({
  client: store,
  fetchResponse,
  sourceId,
  userAgent: "Eve verification ops@example.com",
  window: occurrence.window,
});
assert.equal(postCommitRetry.reused, true);
assert.equal(postCommitRetry.acquisition.acquisitionId, first.acquisition.acquisitionId);
assert.equal(postCommitRetry.transientArtifacts.length, 2);
assert.equal(fetchCount, 7, "a post-commit retry must hydrate the exact artifacts without a new acquisition");

let activeHydrations = 0;
let maximumConcurrentHydrations = 0;
let hydrationFetches = 0;
const sharedHydrationFetch = async (request: EarningsCallPublicSourceRequest) => {
  if (request.kind === "transcript_artifact") {
    hydrationFetches += 1;
    activeHydrations += 1;
    maximumConcurrentHydrations = Math.max(maximumConcurrentHydrations, activeHydrations);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeHydrations -= 1;
  }
  return fetchResponse(request);
};
const concurrentHydrations = await Promise.all([
  runSharedEarningsCallPublicSourceAcquisition({
    client: store,
    fetchResponse: sharedHydrationFetch,
    sourceId,
    userAgent: "Eve verification ops@example.com",
    window: occurrence.window,
  }),
  runSharedEarningsCallPublicSourceAcquisition({
    client: store,
    fetchResponse: sharedHydrationFetch,
    sourceId,
    userAgent: "Eve verification ops@example.com",
    window: occurrence.window,
  }),
]);
assert.ok(concurrentHydrations.every(({ transientArtifacts }) => transientArtifacts.length === 2));
assert.equal(hydrationFetches, 2, "identical concurrent hydration must share one bounded fetch set");
assert.equal(maximumConcurrentHydrations, 2, "independent committed artifacts must hydrate concurrently");
await runSharedEarningsCallPublicSourceAcquisition({
  client: store,
  fetchResponse: sharedHydrationFetch,
  sourceId,
  userAgent: "Eve verification ops@example.com",
  window: occurrence.window,
});
assert.equal(hydrationFetches, 4, "completed hydration must not retain artifact bytes in the in-flight cache");

correctedCurrent = true;
const corrected = await coordinatePublicSourceOccurrence({
  ...occurrence,
  monitor: monitorA,
  scope: scopeA,
  window: {
    endAt: "2026-08-18T18:00:00.000Z",
    startAt: "2026-08-18T16:00:00.000Z",
  },
});
assert.equal(corrected.acquisition.correctionIds.length, 1);
assert.equal(corrected.acquisition.status, "complete");

truncateCurrent = true;
const boundedFailure = await runSharedEarningsCallPublicSourceAcquisition({
  client: store,
  fetchResponse,
  sourceId,
  userAgent: "Eve verification ops@example.com",
  window: {
    endAt: "2026-08-19T18:00:00.000Z",
    startAt: "2026-08-19T16:00:00.000Z",
  },
});
assert.equal(boundedFailure.acquisition.status, "terminal_failure");
assert.equal(boundedFailure.acquisition.errorCode, "transport_response_oversized");
assert.equal(boundedFailure.commit, null);
assert.ok(secFetchTimes.every((time, index) =>
  index === 0 || time - secFetchTimes[index - 1]! >= 100),
"shared SEC fair-access reservations must pace independent acquisition windows");

const discoveryFamily = EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.find(
  ({ cik }) => cik === "0000019617",
)!;
const futureArtifactUrl = "https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/3rd-quarter/3Q26-earnings-transcript.pdf";
const discoverySecBody = encoder.encode(JSON.stringify({
  cik: "19617",
  filings: {
    recent: {
      accessionNumber: [
        "0000019617-27-000501",
        "0000019617-27-000404",
        "0000019617-26-000303",
        "0000019617-26-000202",
        "0000019617-26-000101",
      ],
      acceptanceDateTime: ["2027-04-15T17:00:00.000Z", "2027-01-15T17:00:00.000Z", "2026-10-13T17:00:00.000Z", "2026-07-14T17:00:00.000Z", "2026-04-14T17:00:00.000Z"],
      filingDate: ["2027-04-15", "2027-01-15", "2026-10-13", "2026-07-14", "2026-04-14"],
      form: ["8-K", "8-K", "8-K", "8-K", "8-K"],
      items: ["2.02,9.01", "2.02,9.01", "2.02,9.01", "2.02,9.01", "2.02,9.01"],
      primaryDocument: ["jpm-20270415.htm", "jpm-20270115.htm", "jpm-20261013.htm", "jpm-20260714.htm", "jpm-20260414.htm"],
      reportDate: ["2027-04-15", "2027-01-15", "2026-10-13", "2026-07-14", "2026-04-14"],
    },
  },
}));
const discoveryListing = new Uint8Array(await readFile(
  new URL("./fixtures/earnings-call-changes/jpm-reviewed-listing-future.json", import.meta.url),
));
const discoveryStore = new MemoryStore();
const discovered = await runSharedEarningsCallPublicSourceAcquisition({
  client: discoveryStore,
  fetchResponse: async (request) => ({
    body: request.kind === "sec_submissions"
      ? discoverySecBody
      : request.kind === "issuer_discovery"
        ? discoveryListing
        : encoder.encode(`%PDF-1.7\n${request.url}`),
    contentType: request.kind === "sec_submissions"
      ? "application/json"
      : request.kind === "issuer_discovery"
        ? "application/json"
        : "application/pdf",
    finalUrl: request.url,
    observedAt,
    redirectChain: [request.url],
    redirectCount: 0,
    requestedUrl: request.url,
    status: 200,
  }),
  sourceId: discoveryFamily.familyId,
  userAgent: "Eve verification ops@example.com",
  window: {
    endAt: "2026-10-14T18:00:00.000Z",
    startAt: "2026-10-14T16:00:00.000Z",
  },
});
assert.equal(
  discovered.acquisition.candidateFactRevisionIds.length,
  4,
  "a reviewed listing response must discover future calls within the four-event bound",
);
assert.equal(discovered.transientArtifacts.length, 4);
assert.equal(
  discovered.transientArtifacts.find(({ artifactUrl }) => artifactUrl === futureArtifactUrl)
    ?.fact.sourceNativeId,
  "0000019617:FY2026-Q3:2026-10-13",
  "discovered calls must retain stable issuer/period/date identities",
);
assert.ok(discovered.transientArtifacts.every(({ artifactUrl }) =>
  new URL(artifactUrl).origin === discoveryFamily.artifact.origin));
assert.ok(
  [...discoveryStore.records.values()].every((record) =>
    !record.includes("%PDF-1.7") &&
    !record.includes("total-items") &&
    !record.includes("evil.example")),
  "raw listing and transcript bytes must remain ephemeral",
);
const overboundedDiscovery = await runSharedEarningsCallPublicSourceAcquisition({
  client: new MemoryStore(),
  fetchResponse: async (request) => ({
    body: request.kind === "sec_submissions"
      ? discoverySecBody
      : encoder.encode(JSON.stringify({ items: Array.from({ length: 257 }, () => ({
          docs: {}, quarter: "1st", year: "2026",
        })), "total-items": 257 })),
    contentType: "application/json",
    finalUrl: request.url,
    observedAt,
    redirectChain: [request.url],
    redirectCount: 0,
    requestedUrl: request.url,
    status: 200,
  }),
  sourceId: discoveryFamily.familyId,
  userAgent: "Eve verification ops@example.com",
  window: {
    endAt: "2026-10-15T18:00:00.000Z",
    startAt: "2026-10-15T16:00:00.000Z",
  },
});
assert.equal(overboundedDiscovery.acquisition.status, "terminal_failure");
assert.equal(overboundedDiscovery.acquisition.errorCode, "parser_incomplete",
  "discovery must reject the 257th feed item within its parser bound");

process.stdout.write(JSON.stringify({
  acquisition: {
    corrections: corrected.acquisition.correctionIds.length,
    discoveredFactsWithinBackfillBound: discovered.acquisition.candidateFactRevisionIds.length,
    facts: first.acquisition.candidateFactRevisionIds.length,
    sourceGlobalFetchesBeforeReuse: 3,
    sharedFairAccessReservations: secFetchTimes.length,
  },
  catalogEntries: EARNINGS_CALL_ISSUER_CATALOG.entries.length,
  interpretationState: "not_created_in_sprint_1",
  reviewedSourceFamilies: EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.length,
  staleTransitionRejected: true,
  workspaceProjectionIsolation: true,
}, null, 2) + "\n");
