import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import type { CongressionalSignalStoreClient } from "../agent/lib/congressional-signal-store";
import { readCongressionalHistory } from "../agent/lib/congressional-signal-store";
import {
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2,
  CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06,
} from "../agent/lib/congressional-reference-catalog";
import {
  CongressionalWorkspaceWorkerError,
  evaluateCongressionalSignalsForWorker,
  type CongressionalWorkspaceWorkerClients,
} from "../agent/lib/congressional-workspace-worker";
import type { HousePublicSourceBinaryResponse } from "../agent/lib/house-public-source-adapter";
import type { PublicSourceSubscriptionStoreClient } from "../agent/lib/public-source-subscription-store";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
} from "../agent/lib/strategy-pack-reference-catalog";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceFindingStoreClient } from "../agent/lib/workspace-finding-store";
import {
  getWorkspaceMonitor,
  prepareWorkspaceMonitorCreate,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceStateStoreClient,
  type WorkspaceStrategyBindingValue,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { prepareWorkspaceWorkerRun } from "../agent/lib/workspace-worker-runner";

class MemoryCasStore implements
  PublicSourceAcquisitionStoreClient,
  PublicSourceSubscriptionStoreClient,
  WorkspaceSourceCoverageClient,
  WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemorySignalStore implements CongressionalSignalStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return { created: false, value: current };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryFindingStore implements WorkspaceFindingStoreClient {
  failNextOutcome = false;
  readonly values = new Map<string, string>();
  async createOutcomeWithIdentityClaims(input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0]) {
    if (this.failNextOutcome) {
      this.failNextOutcome = false;
      throw new Error("fixture_post_history_interruption");
    }
    const current = this.values.get(input.outcomeKey);
    if (current) return { status: "existing" as const, value: current };
    for (const claim of input.identityClaims) {
      const existing = this.values.get(claim.key);
      if (existing && existing !== claim.value) {
        return { status: "identity_conflict" as const, value: existing };
      }
    }
    for (const claim of input.identityClaims) this.values.set(claim.key, claim.value);
    this.values.set(input.outcomeKey, input.outcomeValue);
    return { status: "created" as const, value: input.outcomeValue };
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  readonly completedOccurrences = new Set<string>();
  readonly values = new Map<string, string>();
  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    if (this.completedOccurrences.has(input.occurrenceRecordKey)) return "already_completed" as const;
    if (this.values.get(input.recordKey) !== input.expectedRaw) return "stale" as const;
    this.values.set(input.recordKey, input.nextRaw);
    this.completedOccurrences.add(input.occurrenceRecordKey);
    return "completed" as const;
  }
  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
  async claim(): Promise<{ status: "missing" }> { return { status: "missing" }; }
  async list(): Promise<unknown[]> { return [...this.values.values()]; }
  async listDue(): Promise<[]> { return []; }
  async releaseLease(): Promise<boolean> { return false; }
  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    return true;
  }
}

const environment = {
  EVE_CONGRESSIONAL_SIGNALS_EXECUTION_ENABLED: "1",
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED: "1",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 37).toString("base64url"),
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
const state = new MemoryCasStore();
const source = new MemoryCasStore();
const coverage = new MemoryCasStore();
const signal = new MemorySignalStore();
const finding = new MemoryFindingStore();
const alert = new MemoryAlertStore();
const monitorStore = new MemoryMonitorStore();
const clients: CongressionalWorkspaceWorkerClients = {
  acquisition: source,
  alert,
  finding,
  monitor: monitorStore,
  signal,
  sourceCoverage: coverage,
  state,
  subscription: source,
};
const baseNow = new Date();

assert.equal(CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06.entries.length, 437);
assert.equal(CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06.source.rowCount, 441);
assert.equal(CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06.vacancies.length, 4);
assert.equal(
  CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06.source.contentDigest,
  "4ccea8259aff2df6a175545e45bdac2dfcdf0085a9cc7ab6c46aa80527bc524b",
);
assert.equal(
  CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06.source.url,
  "https://clerk.house.gov/xml/lists/MemberData.xml",
);
assert.equal(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2.catalogVersion, "1.2.0");
assert.equal(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2.entries.length, 437);
assert.equal(new Set(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2.entries.map(({ bioguideId }) =>
  bioguideId)).size, 437);
assert.ok(CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2.entries.every(({ provenanceUrl }) =>
  provenanceUrl === "https://clerk.house.gov/xml/lists/MemberData.xml"));
assert.equal(
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2.entries.find(({ bioguideId }) =>
    bioguideId === "R000600")?.sourceStateDistrict,
  "AQ00",
);

function countRecordType(values: Map<string, string>, recordType: string): number {
  return [...values.values()].filter((raw) =>
    (JSON.parse(raw) as { recordType?: unknown }).recordType === recordType).length;
}

function capabilitiesFor(version: string): WorkspaceCapabilityManifestValue {
  const pack = strategyPackCatalog.resolve({ id: "congressional-signals", version });
  assert.ok(pack);
  return {
    connectionIds: [],
    controlPlaneToolIds: [CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: [...pack.capabilities.hardDenied].sort(),
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: [],
    skills: pack.skills.map(({ id, version: skillVersion }) => ({ id, version: skillVersion })),
    sources: pack.sources.map((item) => ({
      allowedOrigins: [...item.allowedOrigins],
      contractDigest: item.contractDigest,
      contractVersion: item.contractVersion,
      origin: new URL(item.canonicalUrl).origin,
      sourceId: item.sourceId,
    })),
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 2_000 },
  };
}

function installWorkspace(input: {
  configuration: { minimumAlertBand: "priority" | "review"; selectedMemberBioguideIds: string[] };
  version: "1.0.0" | "1.1.0" | "1.2.0" | "1.3.0";
  workspaceId: string;
}) {
  const pack = strategyPackCatalog.resolve({ id: "congressional-signals", version: input.version });
  assert.ok(pack);
  const scope = authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: input.workspaceId },
    environment,
  );
  const resource = pack.monitors[0]!;
  const preparedMonitor = prepareWorkspaceMonitorCreate({
    activateManagedMonitor: true,
    deliverySubscriptionId: `delivery.${input.workspaceId}`,
    idempotencyKey: `congressional:${input.workspaceId}`,
    instruction: resource.instruction,
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: pack.contentDigest,
      packId: pack.id,
      packVersion: pack.version,
      resourceId: resource.resourceId,
    },
    name: resource.displayName,
    nextOccurrenceAt: new Date(baseNow.getTime() + 60 * 60_000).toISOString(),
    now: baseNow,
    publicSourceIds: [HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID],
    requiredCapabilityIds: [...resource.requiredCapabilityIds],
    schedule: { anchor: baseNow.toISOString(), everyMinutes: 60, kind: "interval" },
    scope,
    sources: pack.sources.map((item) => ({
      accessClassification: item.accessClassification,
      canonicalUrl: item.canonicalUrl,
      origin: new URL(item.canonicalUrl).origin,
      sourceId: item.sourceId,
    })),
  });
  const snapshot = {
    bindingRevision: 1,
    capabilityManifestRevision: 1,
    packContentDigest: pack.contentDigest,
    packId: pack.id,
    packVersion: pack.version,
    workspaceGeneration: 1,
  };
  const strategy: WorkspaceStrategyBindingValue = {
    bindingRevision: 1,
    configuration: {
      dailyTimes: ["09:00"],
      minimumAlertBand: input.configuration.minimumAlertBand,
      selectedMemberBioguideIds: input.configuration.selectedMemberBioguideIds,
      timezone: "UTC",
    },
    effectiveCapabilityManifestRevision: 1,
    health: { checkedAt: baseNow.toISOString(), code: null, status: "healthy" },
    lastActiveSnapshot: null,
    lifecycleState: "active",
    managedResources: {
      [resource.resourceId]: {
        monitorId: preparedMonitor.monitor.monitorId,
        sourceIds: [...resource.sourceIds],
      },
    },
    ownerOverrides: {},
    pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version },
    pendingSnapshot: snapshot,
    timestamps: {
      activatedAt: baseNow.toISOString(),
      configuredAt: baseNow.toISOString(),
      generationRolloverAt: baseNow.toISOString(),
      installedAt: baseNow.toISOString(),
    },
  };
  for (const prepared of [
    prepareInitialWorkspaceDocument("brief", {
      now: baseNow,
      scope,
      value: {
        currentFindingsSummary: "",
        goal: "Track official House PTR filings.",
        lastMaterialChange: "",
        openQuestions: [],
        promotedFacts: [],
        sourcePolicy: { allowedSourceIds: [HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID], maximumAccessClassification: "public" },
        strategyConfigurationRevision: 1,
        thesis: "",
        watchlist: [],
      },
    }),
    prepareInitialWorkspaceDocument("budget", {
      now: baseNow,
      scope,
      value: {
        effectiveAt: baseNow.toISOString(),
        maximumConcurrentWorkers: 1,
        maximumInputTokensPerDay: 40_000,
        maximumInputTokensPerRun: 10_000,
        maximumOutputTokensPerDay: 8_000,
        maximumOutputTokensPerRun: 2_000,
        maximumPaidPerCall: null,
        maximumPaidPerDay: null,
        maximumPaidPerMonth: null,
        maximumScheduledRunsPerDay: 8,
        ownerTimezone: "UTC",
        unknownPriceFallbackCeiling: "0",
      },
    }),
    prepareInitialWorkspaceDocument("capabilities", { now: baseNow, scope, value: capabilitiesFor(input.version) }),
    prepareInitialWorkspaceStrategyBinding({ now: baseNow, scope, value: strategy }),
  ]) state.values.set(prepared.key, prepared.raw);
  monitorStore.values.set(preparedMonitor.recordKey, preparedMonitor.raw);
  return { monitor: preparedMonitor.monitor, scope };
}

let sequence = 0;
async function prepare(monitor: WorkspaceMonitor, now: Date, scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>) {
  sequence += 1;
  const occurrenceKey = sequence.toString(16).padStart(64, "0");
  const claimed = {
    leaseExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    leaseToken: `lease-${sequence}`,
    monitor,
    occurrence: {
      attempt: 1,
      configurationRevision: monitor.configurationRevision,
      leaseTokenDigest: sequence.toString(16).padStart(64, "a").slice(-64),
      monitorId: monitor.monitorId,
      occurrenceIdentity: `interval:${monitor.nextOccurrenceAt}`,
      occurrenceKey,
      scheduledFor: monitor.nextOccurrenceAt!,
      schemaVersion: 1,
      status: "leased",
      updatedAt: now.toISOString(),
    },
    scope,
    skippedOccurrenceIdentities: [],
  } satisfies ClaimedWorkspaceMonitor;
  const common = {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId: `${occurrenceKey}:attempt:1`,
    state: "reserved" as const,
    updatedAt: now.toISOString(),
  };
  const dispatchBudget = {
    global: common,
    runId: common.runId,
    workspace: {
      ...common,
      calendarMonth: now.toISOString().slice(0, 7),
      inputTokens: 10_000,
      outputTokens: 2_000,
      paidMicros: "0",
      policyRevision: 1,
      reconciledInputTokens: null,
      reconciledOutputTokens: null,
      reconciledPaidMicros: null,
    },
  } satisfies WorkspaceDispatchReservation;
  return prepareWorkspaceWorkerRun({
    claimed,
    clients: { sourceCoverage: coverage, state },
    dispatchBudget,
    environment,
    now,
  });
}

const manifest = JSON.parse(await readFile(
  new URL("./fixtures/public-source-adapters/house/live-review-2026-08-16/manifest.json", import.meta.url),
  "utf8",
)) as { documents: Array<{ disclosedFiler: { firstName: string; lastName: string; prefix: string | null; stateDistrict: string; suffix: string | null }; docId: string; filingDate: string; retainedFile: string }> };
const fixture = (name: string) => manifest.documents.find(({ retainedFile }) => retainedFile === name)!;
const pdf = (name: string) => readFile(new URL(
  `./fixtures/public-source-adapters/house/live-review-2026-08-16/${name}`,
  import.meta.url,
));
async function index(document: ReturnType<typeof fixture>) {
  const [year, month, day] = document.filingDate.split("-");
  const filer = document.disclosedFiler;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><FinancialDisclosure><Member><Prefix>${filer.prefix ?? ""}</Prefix><Last>${filer.lastName}</Last><First>${filer.firstName}</First><Suffix>${filer.suffix ?? ""}</Suffix><FilingType>P</FilingType><StateDst>${filer.stateDistrict}</StateDst><Year>${year}</Year><FilingDate>${month}/${day}/${year}</FilingDate><DocID>${document.docId}</DocID></Member></FinancialDisclosure>`;
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("2026FD.xml", new TextReader(xml));
  return writer.close();
}
function response(body: Uint8Array, contentType: string, url: string, observedAt: string): HousePublicSourceBinaryResponse {
  return { body, contentType, finalUrl: url, observedAt, requestedUrl: url, status: 200 };
}
async function execute(input: {
  document: ReturnType<typeof fixture>;
  now: Date;
  prepared: Awaited<ReturnType<typeof prepare>>;
  shouldFetch: boolean;
}) {
  const archive = await index(input.document);
  const documentBytes = new Uint8Array(await pdf(input.document.retainedFile));
  let fetches = 0;
  const result = await evaluateCongressionalSignalsForWorker({
    clients: {
      ...clients,
      fetchDocument: async (url) => {
        fetches += 1;
        if (!input.shouldFetch) throw new Error("shared_acquisition_should_be_reused");
        return response(documentBytes, "application/pdf", url, input.now.toISOString());
      },
      fetchIndex: async (url) => {
        fetches += 1;
        if (!input.shouldFetch) throw new Error("shared_acquisition_should_be_reused");
        return response(archive, "application/zip", url, input.now.toISOString());
      },
    },
    ctx: { session: { auth: { current: input.prepared.request.auth } } },
    environment,
    now: input.now,
  });
  return { fetches, result };
}

const workspaceA = installWorkspace({
  configuration: { minimumAlertBand: "priority", selectedMemberBioguideIds: ["H001082"] },
  version: "1.0.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175501",
});
const workspaceB = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.2.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175502",
});
const workspaceC = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: ["H001082"] },
  version: "1.1.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175503",
});
const workspaceD = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.3.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175504",
});
const workspaceE = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.3.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175505",
});
// U4: 1.4.0 declares monitor.congressional-house-disclosures/v1 (the strategy's
// first lifecycle-contract binding) but keeps every catalog, policy, and
// evidence contract identical to 1.3.0 - a pure plumbing migration, not a
// policy change. workspaceF proves the two versions produce the same runtime
// and the same evaluation output for the same document.
const workspaceF = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175506",
});
const packV1_3 = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.3.0" });
assert.ok(packV1_3);
assert.deepEqual(packV1_3.evidenceContracts, CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3);
const packV1_4 = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.4.0" });
assert.ok(packV1_4);
assert.deepEqual(packV1_4.evidenceContracts, CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3);
assert.equal(packV1_4.monitors[0]?.lifecycleContractId, "monitor.congressional-house-disclosures/v1");
assert.notEqual(
  packV1_4.contentDigest,
  packV1_3.contentDigest,
  "1.4.0 must still be a distinct immutable version despite sharing runtime catalogs",
);
assert.deepEqual(
  ["1.0.0", "1.1.0", "1.2.0"].map((version) =>
    strategyPackCatalog.resolve({ id: "congressional-signals", version })?.contentDigest),
  [
    "c5031a9d345956d491b35e5459043195437497bc90ce18f8fe8600a596fa8d29",
    "54b09e91047f9e34681994eefc5f1284c45b658f55873df49ba3fab3ad211630",
    "3ced2a1538b6ce1fbb1113fe326a9232963c08b56f0b264bab663c0597bc30ab",
  ],
);
const baselineDocument = fixture("ptr-10.pdf");
const unavailable = await prepare(workspaceE.monitor, baseNow, workspaceE.scope);
await assert.rejects(
  evaluateCongressionalSignalsForWorker({
    clients: {
      ...clients,
      fetchIndex: async () => {
        throw new Error("fixture_house_transport_timeout");
      },
    },
    ctx: { session: { auth: { current: unavailable.request.auth } } },
    environment,
    now: baseNow,
  }),
  (error) => error instanceof CongressionalWorkspaceWorkerError &&
    error.code === "congressional_source_unavailable",
);
const baselineA = await prepare(workspaceA.monitor, baseNow, workspaceA.scope);
assert.equal((await execute({ document: baselineDocument, now: baseNow, prepared: baselineA, shouldFetch: true })).result.baselineEstablished, true);
const sourceRecordsAfterFirstBaseline = source.values.size;
const sharedFactsAfterFirstBaseline = countRecordType(source.values, "canonical_public_fact_revision");
const baselineB = await prepare(workspaceB.monitor, baseNow, workspaceB.scope);
const sharedBaseline = await execute({ document: baselineDocument, now: baseNow, prepared: baselineB, shouldFetch: false });
assert.equal(sharedBaseline.result.baselineEstablished, true);
assert.equal(
  countRecordType(source.values, "canonical_public_fact_revision"),
  sharedFactsAfterFirstBaseline,
  "the second workspace must reuse source-global canonical facts",
);
assert.equal(source.values.size > sourceRecordsAfterFirstBaseline, true, "workspace projection records are isolated");
const baselineC = await prepare(workspaceC.monitor, baseNow, workspaceC.scope);
assert.equal((await execute({ document: baselineDocument, now: baseNow, prepared: baselineC, shouldFetch: false })).result.baselineEstablished, true);
const baselineD = await prepare(workspaceD.monitor, baseNow, workspaceD.scope);
assert.equal((await execute({ document: baselineDocument, now: baseNow, prepared: baselineD, shouldFetch: false })).result.baselineEstablished, true);
const baselineF = await prepare(workspaceF.monitor, baseNow, workspaceF.scope);
assert.equal((await execute({ document: baselineDocument, now: baseNow, prepared: baselineF, shouldFetch: false })).result.baselineEstablished, true);

const liveNow = baseNow;
const liveDocument = fixture("ptr-14.pdf");
const currentB = await getWorkspaceMonitor(workspaceB.scope, workspaceB.monitor.monitorId, monitorStore);
assert.ok(currentB);
const liveB = await prepare(currentB, liveNow, workspaceB.scope);
finding.failNextOutcome = true;
await assert.rejects(
  execute({ document: liveDocument, now: liveNow, prepared: liveB, shouldFetch: true }),
  /fixture_post_history_interruption/u,
);
const historyBeforeRetry = await readCongressionalHistory(workspaceB.scope, signal);
assert.ok(historyBeforeRetry?.activeEntries.length);
const retried = await execute({
  document: liveDocument,
  now: baseNow,
  prepared: liveB,
  shouldFetch: false,
});
assert.equal(retried.result.replayed, false);
const currentA = await getWorkspaceMonitor(workspaceA.scope, workspaceA.monitor.monitorId, monitorStore);
assert.ok(currentA);
const liveA = await prepare(currentA, liveNow, workspaceA.scope);
await execute({ document: liveDocument, now: liveNow, prepared: liveA, shouldFetch: false });
const currentC = await getWorkspaceMonitor(workspaceC.scope, workspaceC.monitor.monitorId, monitorStore);
assert.ok(currentC);
const liveC = await prepare(currentC, liveNow, workspaceC.scope);
await execute({ document: liveDocument, now: liveNow, prepared: liveC, shouldFetch: false });
const currentD = await getWorkspaceMonitor(workspaceD.scope, workspaceD.monitor.monitorId, monitorStore);
assert.ok(currentD);
const liveD = await prepare(currentD, liveNow, workspaceD.scope);
await execute({ document: liveDocument, now: liveNow, prepared: liveD, shouldFetch: false });
const currentF = await getWorkspaceMonitor(workspaceF.scope, workspaceF.monitor.monitorId, monitorStore);
assert.ok(currentF);
const liveF = await prepare(currentF, liveNow, workspaceF.scope);
await execute({ document: liveDocument, now: liveNow, prepared: liveF, shouldFetch: false });

const [historyA, historyB, historyC, historyD, historyF] = await Promise.all([
  readCongressionalHistory(workspaceA.scope, signal),
  readCongressionalHistory(workspaceB.scope, signal),
  readCongressionalHistory(workspaceC.scope, signal),
  readCongressionalHistory(workspaceD.scope, signal),
  readCongressionalHistory(workspaceF.scope, signal),
]);
assert.ok(historyA?.activeEntries.length);
assert.ok(historyB?.activeEntries.length);
assert.ok(historyC?.activeEntries.length);
assert.ok(historyD?.activeEntries.length);
assert.ok(historyF?.activeEntries.length);
assert.equal(historyA.activeEntries[0]!.transaction.policyReference.policyVersion, "1.0.0");
assert.equal(historyB.activeEntries[0]!.transaction.policyReference.policyVersion, "1.2.0");
assert.equal(historyC.activeEntries[0]!.transaction.policyReference.policyVersion, "1.1.0");
assert.equal(historyD.activeEntries[0]!.transaction.policyReference.policyVersion, "1.2.0");
assert.equal(historyF.activeEntries[0]!.transaction.policyReference.policyVersion, "1.2.0");
assert.equal(historyB.activeEntries[0]!.transaction.catalogReferences.member.catalogVersion, "1.1.0");
assert.equal(historyD.activeEntries[0]!.transaction.catalogReferences.member.catalogVersion, "1.2.0");
assert.equal(historyF.activeEntries[0]!.transaction.catalogReferences.member.catalogVersion, "1.2.0");
// The contract migration must not change the evaluation itself: given the
// same two documents, 1.4.0 (declared contract) and 1.3.0 (no contract) must
// reach the same set of eligibility/band/committee/cluster/pattern
// conclusions - workspace- and pack-identity-scoped fields (ids, revision
// ids, packBinding, lineage's revision references, source) aside. Compare as
// an order-independent set: activeEntries is not guaranteed to enumerate in
// the same order across two independently-scoped workspace histories.
function contentFingerprint(entry: (typeof historyD.activeEntries)[number]): string {
  const { transaction } = entry;
  return JSON.stringify({
    ...transaction,
    lineage: transaction.lineage.state,
    packBinding: undefined,
    source: undefined,
    transactionId: undefined,
    transactionRevisionId: undefined,
    workspaceId: undefined,
  });
}
assert.equal(historyD.activeEntries.length, historyF.activeEntries.length);
assert.deepEqual(
  historyD.activeEntries.map(contentFingerprint).sort(),
  historyF.activeEntries.map(contentFingerprint).sort(),
  "1.4.0 must evaluate the same set of facts identically to 1.3.0",
);
assert.notEqual(historyA.historyRevisionId, historyB.historyRevisionId);
assert.equal(historyA.workspaceId, workspaceA.scope.workspaceId);
assert.equal(historyB.workspaceId, workspaceB.scope.workspaceId);
assert.equal(historyD.workspaceId, workspaceD.scope.workspaceId);
assert.equal(historyF.workspaceId, workspaceF.scope.workspaceId);
assert.equal([...signal.values.values()].some((raw) => raw.includes(workspaceA.scope.workspaceId)), true);
assert.equal([...signal.values.values()].some((raw) => raw.includes(workspaceB.scope.workspaceId)), true);
assert.equal(countRecordType(finding.values, "workspace_run_outcome") >= 8, true);
assert.equal(alert.values.size > 0, true, "the review-threshold workspace should stage an isolated alert");
assert.equal([...alert.values.values()].every((raw) =>
  !raw.includes(workspaceA.scope.workspaceId) || !raw.includes(workspaceB.scope.workspaceId)), true);

console.log("Congressional Signals Sprint 5 worker, replay, version, and isolation verification passed.");
