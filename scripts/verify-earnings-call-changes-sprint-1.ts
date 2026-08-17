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
import {
  runSharedEarningsCallPublicSourceAcquisition,
  type EarningsCallPublicSourceRequest,
  type EarningsCallPublicSourceResponse,
} from "../agent/lib/earnings-call-public-source-adapter";

class MemoryStore {
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
assert.equal(options.find(({ id }) => id === "0000789019")?.coverageState, "baseline_ready");
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
assert.equal(
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST,
  EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.definitionDigest,
);
for (const family of EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES) {
  const derived = deriveEarningsCallPublicSource(family);
  assert.equal(derived.sourceInstance.configuration.cik, family.cik);
  assert.equal(derived.sourceInstance.configuration.familyDigest, family.familyDigest);
  assert.ok(derived.sourceContract.allowedOrigins.includes("https://data.sec.gov"));
  assert.ok(family.events.every(({ reviewedArtifact }) =>
    reviewedArtifact.byteCount > 100_000 && /^[a-f0-9]{64}$/u.test(reviewedArtifact.digest)));
  assert.equal(resolveReviewedPublicSource(derived.sourceId).sourceInstance.sourceInstanceId,
    derived.sourceInstance.sourceInstanceId);
  assert.throws(() => reviewedParameterizedSourceFamilySchema.parse({
    ...family,
    events: family.events.map((event, index) => index === 0
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
  { selectedIssuerCiks: ["0000789019", "0001326801"] },
  [logicalSource.sourceId],
);
assert.deepEqual(
  initiallySelected.map(({ sourceId }) => sourceId),
  ["earnings-call-transcripts.0000789019", "earnings-call-transcripts.0001326801"],
);

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
  { selectedIssuerCiks: ["0000789019", "0001048911"] },
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
  ["earnings-call-transcripts.0000789019", "earnings-call-transcripts.0001048911"],
);
assert.equal(
  reconciled.monitor.publicSourceSubscriptions?.[0]?.subscriptionId,
  preparedMonitor.monitor.publicSourceSubscriptions?.[0]?.subscriptionId,
);
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
const selectedSource = resolveStrategyPackSourceInstances(
  parameterizedPack,
  { selectedIssuerCiks: ["0000789019"] },
  [logicalSource.sourceId],
);
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
    assert.equal(request.maximumBytes, 2 * 1_024 * 1_024);
    body = secBody;
    contentType = "application/json; charset=utf-8";
  } else {
    const event = family.events.find(({ artifactUrl }) => artifactUrl === request.url);
    assert.ok(event);
    body = encoder.encode(`<!doctype html><html><body>${event.fiscalPeriod} prepared remarks and questions and answers${correctedCurrent && event.role === "current" ? " corrected" : ""}</body></html>`);
    contentType = "text/html; charset=utf-8";
  }
  return {
    body,
    contentType,
    finalUrl: request.url,
    observedAt,
    redirectCount: 0,
    requestedUrl: request.url,
    status: 200,
    ...(truncateCurrent && request.kind === "transcript_artifact" ? { truncated: true } : {}),
  };
};
const occurrence = {
  clients: { acquisition: store, subscription: store },
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
const first = await coordinatePublicSourceOccurrence({ ...occurrence, monitor: monitorA, scope: scopeA });
assert.equal(first.reused, false);
assert.equal(first.baselineEstablished, true);
assert.equal(first.acquisition.candidateFactRevisionIds.length, 2);
assert.equal(first.projection?.projections.length, 2);
assert.equal(fetchCount, 3);
const second = await coordinatePublicSourceOccurrence({ ...occurrence, monitor: monitorB, scope: scopeB });
assert.equal(second.reused, true);
assert.equal(second.acquisition.acquisitionId, first.acquisition.acquisitionId);
assert.equal(fetchCount, 3, "the second workspace must not repeat source-global transport");
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

process.stdout.write(JSON.stringify({
  acquisition: {
    corrections: corrected.acquisition.correctionIds.length,
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
