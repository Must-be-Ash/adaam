import { congressionalResearchEvidenceContent, congressionalResearchValidationContract } from "../agent/lib/congressional-research";
import { congressionalPackSupportsResearch, type CongressionalPackVersion } from "../agent/lib/congressional-pack-version";
import { publishCongressionalResearchReport } from "../agent/lib/congressional-research-worker";
import { createHybridEvidenceEphemeralArtifactStore, type HybridEvidenceArtifactStore } from "../agent/lib/hybrid-evidence-artifact-store";
import { decodeHybridEvidenceWorkerToken } from "../agent/lib/hybrid-evidence-auth";
import { readHybridEvidenceJob } from "../agent/lib/hybrid-evidence-job-store";
import { completeHybridEvidenceJobForWorker, persistHybridEvidenceResearchDecisionForWorker, readHybridEvidenceSliceForWorker } from "../agent/lib/hybrid-evidence-worker";
import { reserveWorkspaceRunBudget, reconcileWorkspaceRunBudget, readWorkspaceBudgetLedger } from "../agent/lib/workspace-budget-ledger";
import { readWorkspaceDocument } from "../agent/lib/workspace-state-store";
import { researchReportSchema, type ResearchReport } from "../agent/lib/artifact-schema";
import { shouldCreateCongressionalCorrectionAlert } from "../agent/lib/congressional-history";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import { commitPublicSourceAcquisition, readLatestPublicSourceFactRevision, readNextPublicSourceAcquisition, readPublicSourceInstance, readPublicSourceSequenceStart } from "../agent/lib/public-source-acquisition-store";
import { canonicalPublicFactRevisionSchema, deriveCanonicalPublicFactRevisionId, digestPublicSourceValue, publicSourceAcquisitionResultSchema, publicSourceCorrectionSchema, publicSourceRetractionSchema } from "../agent/lib/public-source-adapter-schema";
import { runHousePublicSourceAcquisition } from "../agent/lib/house-public-source-adapter";
import { createEarningsCallSourceLifecycleStore } from "../agent/lib/earnings-call-source-lifecycle-store";
import type { CongressionalSignalStoreClient } from "../agent/lib/congressional-signal-store";
import {
  persistCongressionalSignalRecords,
  readCongressionalHistory,
} from "../agent/lib/congressional-signal-store";
import {
  congressionalFilingSignalSchema,
  deriveCongressionalSignalRevisionId,
  deriveHouseStrategyTransactionId,
  deriveHouseStrategyTransactionRevisionId,
  houseStrategyTransactionSchema,
} from "../agent/lib/congressional-signal-schema";
import {
  CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3,
  CONGRESSIONAL_HOUSE_MEMBER_CATALOG_V1_2,
  CONGRESSIONAL_HOUSE_MEMBER_ROSTER_SNAPSHOT_2026_07_06,
} from "../agent/lib/congressional-reference-catalog";
import {
  CongressionalWorkspaceWorkerError,
  combineCongressionalFindings,
  evaluateCongressionalSignalsForWorker,
  isVerifiedSelectedDisclosureTransaction,
  type CongressionalWorkspaceWorkerClients,
} from "../agent/lib/congressional-workspace-worker";
import type { HousePublicSourceBinaryResponse } from "../agent/lib/house-public-source-adapter";
import type { PublicSourceSubscriptionStoreClient } from "../agent/lib/public-source-subscription-store";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  monitorPreparations,
  resolveStrategyPackInitialBudgetPolicy,
} from "../agent/lib/strategy-pack-service";
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
    if (this.failNextOutcome && JSON.parse(value).recordType === "workspace_run_outcome") {
      this.failNextOutcome = false;
      throw new Error("fixture_post_history_interruption");
    }
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
  EVE_HYBRID_EVIDENCE_ENABLED: "1", EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 48).toString("base64url"),
  EVE_HYBRID_FAST_MODEL_ID: "anthropic/claude-haiku-4.5", EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4", EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
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
const researchMemory = new MemoryCasStore();
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

function capabilitiesFor(version: CongressionalPackVersion): WorkspaceCapabilityManifestValue {
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
    workerModelPolicy: { allowedModelIds: congressionalPackSupportsResearch(version) ? ["zai/glm-5.3-flash", "openai/gpt-5.4"] : ["zai/glm-5.3-flash"], maximumOutputTokens: congressionalPackSupportsResearch(version) ? 12_000 : 2_000 },
  };
}

function installWorkspace(input: {
  configuration: { minimumAlertBand?: "priority" | "review"; selectedMemberBioguideIds: string[] };
  nextOccurrenceAt?: string;
  version: CongressionalPackVersion;
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
    nextOccurrenceAt: input.nextOccurrenceAt ?? new Date(baseNow.getTime() + 60 * 60_000).toISOString(),
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
      ...(input.configuration.minimumAlertBand ? { minimumAlertBand: input.configuration.minimumAlertBand } : {}),
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
      value: congressionalPackSupportsResearch(input.version) ? resolveStrategyPackInitialBudgetPolicy(pack, strategy.configuration, baseNow.toISOString()) : {
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
  if (monitor.managedBy && congressionalPackSupportsResearch(monitor.managedBy.packVersion as CongressionalPackVersion)) {
    const budget = await readWorkspaceDocument("budget", scope, state);
    assert.ok(budget);
    dispatchBudget.workspace = await reserveWorkspaceRunBudget({
      inputTokens: 100_000, outputTokens: 12_000, paidCostCeiling: { kind: "known", amount: "1.000000" },
      now, policy: budget.value, policyRevision: budget.revision, runId: common.runId, scope,
    }, researchMemory);
  }
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
async function index(document: ReturnType<typeof fixture> | ReturnType<typeof fixture>[]) {
  const documents = Array.isArray(document) ? document : [document];
  const members = documents.map((document) => {
  const [year, month, day] = document.filingDate.split("-");
  const filer = document.disclosedFiler;
  return `<Member><Prefix>${filer.prefix ?? ""}</Prefix><Last>${filer.lastName}</Last><First>${filer.firstName}</First><Suffix>${filer.suffix ?? ""}</Suffix><FilingType>P</FilingType><StateDst>${filer.stateDistrict}</StateDst><Year>${year}</Year><FilingDate>${month}/${day}/${year}</FilingDate><DocID>${document.docId}</DocID></Member>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?><FinancialDisclosure>${members.join("")}</FinancialDisclosure>`;
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
  sourceClient?: MemoryCasStore;
}) {
  const archive = await index(input.document);
  const documentBytes = new Uint8Array(await pdf(input.document.retainedFile));
  let fetches = 0;
  const result = await evaluateCongressionalSignalsForWorker({
    clients: {
      ...clients,
      acquisition: input.sourceClient ?? clients.acquisition,
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
      subscription: input.sourceClient ?? clients.subscription,
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
const workspaceG = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.3.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175507",
});
const workspaceH = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  nextOccurrenceAt: new Date(baseNow.getTime() + 1_000).toISOString(),
  version: "1.3.0",
  workspaceId: "123e4567-e89b-42d3-a456-426614175508",
});
const packV1_3 = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.3.0" });
assert.ok(packV1_3);
assert.deepEqual(packV1_3.evidenceContracts, CONGRESSIONAL_EVIDENCE_CONTRACTS_V1_3);
const packV1_4 = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.4.0" });
assert.ok(packV1_4);
const initialPaidBudget = resolveStrategyPackInitialBudgetPolicy(packV1_4, {
  dailyTimes: ["09:00", "16:00"],
  minimumAlertBand: "priority",
  selectedMemberBioguideIds: [],
  timezone: "America/Vancouver",
}, baseNow.toISOString());
assert.equal(initialPaidBudget.maximumPaidPerCall, "1.000000");
assert.equal(initialPaidBudget.maximumPaidPerDay, "10.000000");
assert.equal(initialPaidBudget.maximumPaidPerMonth, "50.000000");
for (const version of ["1.0.0", "1.0.1", "1.1.0"]) {
  const earningsPack = strategyPackCatalog.resolve({ id: "earnings-call-changes", version });
  assert.ok(earningsPack);
  const configuration = { selectedIssuerCiks: ["0000019617"], timezone: "America/Vancouver", dailyTimes: ["09:00"] };
  const budget = resolveStrategyPackInitialBudgetPolicy(earningsPack, configuration, baseNow.toISOString());
  assert.ok(Number(budget.maximumPaidPerCall) >= 1, `Earnings ${version} admits the shared source-recovery ceiling`);
  assert.ok(Number(budget.maximumPaidPerDay) >= 10);
  assert.ok(Number(budget.maximumPaidPerMonth) >= 50);
  const prepared = monitorPreparations({ activate: new Set([earningsPack.monitors[0]!.resourceId]),
    budget, configuration, deliverySubscriptionId: "delivery.earnings.fixture",
    now: baseNow, pack: earningsPack, scope: workspaceF.scope });
  assert.ok(Number(prepared[0]?.monitor.tighteningLimits.paidPerRun) >= 1);
}
assert.equal(monitorPreparations({
  activate: new Set([packV1_4.monitors[0]!.resourceId]),
  budget: initialPaidBudget,
  configuration: {
    dailyTimes: ["09:00", "16:00"],
    minimumAlertBand: "priority",
    selectedMemberBioguideIds: [],
    timezone: "America/Vancouver",
  },
  deliverySubscriptionId: "delivery.congressional.fixture",
  now: baseNow,
  pack: packV1_4,
  scope: workspaceF.scope,
})[0]?.monitor.tighteningLimits.paidPerRun, "1.000000");
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

const seedSignal = [...signal.values.values()].map((raw) => JSON.parse(raw) as unknown).find(
  (record) => congressionalFilingSignalSchema.safeParse(record).data?.workspaceId === workspaceF.scope.workspaceId,
);
const parsedSeedSignal = congressionalFilingSignalSchema.parse(seedSignal);
const seedTransactionRevisionId = parsedSeedSignal.transactionEvaluations[0]!.transactionRevisionId;
const seedTransaction = [...signal.values.values()].map((raw) => JSON.parse(raw) as unknown).find(
  (record) => houseStrategyTransactionSchema.safeParse(record).data?.transactionRevisionId === seedTransactionRevisionId,
);
const parsedSeedTransaction = houseStrategyTransactionSchema.parse(seedTransaction);
const largeFilingTransactions = Array.from({ length: 224 }, (_, index) => {
  const sequence = String(index + 1).padStart(3, "0");
  const source = {
    ...parsedSeedTransaction.source,
    factLogicalKey: `${parsedSeedTransaction.source.factLogicalKey}.large-${sequence}`,
    factRevisionId: `${parsedSeedTransaction.source.factRevisionId}.large-${sequence}`,
    rowIdentity: `row:${index + 1}`,
  };
  const transactionId = deriveHouseStrategyTransactionId({
    factLogicalKey: source.factLogicalKey,
    subscriptionId: source.subscriptionId,
    workspaceId: parsedSeedTransaction.workspaceId,
  });
  const { transactionRevisionId: _seedRevisionId, ...seedCore } = parsedSeedTransaction;
  const core = { ...seedCore, source, transactionId };
  return houseStrategyTransactionSchema.parse({
    ...core,
    transactionRevisionId: deriveHouseStrategyTransactionRevisionId(core),
  });
}).sort((left, right) => left.transactionRevisionId.localeCompare(right.transactionRevisionId));
const seedEvaluation = parsedSeedSignal.transactionEvaluations[0]!;
const transactionEvaluations = largeFilingTransactions.map(({ transactionRevisionId }) => ({
  ...seedEvaluation,
  transactionRevisionId,
}));
const { signalRevisionId: _seedSignalRevisionId, ...seedSignalCore } = parsedSeedSignal;
const largeSignalCore = { ...seedSignalCore, transactionEvaluations };
const largeFilingSignal = congressionalFilingSignalSchema.parse({
  ...largeSignalCore,
  signalRevisionId: deriveCongressionalSignalRevisionId(largeSignalCore),
});
assert.ok(
  Buffer.byteLength(JSON.stringify(largeFilingSignal), "utf8") > 256 * 1_024,
  "the production-shaped 224-transaction House filing must exercise the former signal-record ceiling",
);
const largeFilingPersistence = await persistCongressionalSignalRecords({
  scope: workspaceF.scope,
  signal: largeFilingSignal,
  transactions: largeFilingTransactions,
}, signal);
assert.equal(
  largeFilingPersistence.signalCreated,
  true,
  "a valid House filing with 224 transactions must persist as one filing signal",
);

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

const unresolvedNow = baseNow;
const unresolvedDocument = fixture("ptr-05.pdf");
const unresolvedPrepared = await prepare(workspaceG.monitor, unresolvedNow, workspaceG.scope);
const unresolvedResult = await execute({
  document: unresolvedDocument,
  now: unresolvedNow,
  prepared: unresolvedPrepared,
  shouldFetch: true,
  sourceClient: new MemoryCasStore(),
});
assert.equal(unresolvedResult.result.replayed, false);
const unresolvedHistory = await readCongressionalHistory(workspaceG.scope, signal);
assert.ok(unresolvedHistory);
assert.equal(
  unresolvedHistory.activeEntries.length,
  0,
  "unresolved members remain durable filing signals but cannot enter party-based history",
);
assert.equal(
  [...signal.values.values()].some((raw) =>
    raw.includes(workspaceG.scope.workspaceId) && raw.includes("unresolved_member")),
  true,
  "the unresolved-member filing signal must remain durable",
);

const lateNow = new Date(baseNow.getTime() + 2_000);
const latePrepared = await prepare(workspaceH.monitor, lateNow, workspaceH.scope);
const lateResult = await execute({
  document: baselineDocument,
  now: lateNow,
  prepared: latePrepared,
  shouldFetch: true,
  sourceClient: new MemoryCasStore(),
});
assert.equal(
  lateResult.result.checkpoint.watermark,
  workspaceH.monitor.nextOccurrenceAt,
  "a delayed cron run advances to its logical window end, not its later physical observation time",
);

// A source baseline spans multiple acquisitions, but every filing must reach
// the actual worker before its first completed checkpoint can suppress replay.
const pagedWorkspace = installWorkspace({
  configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175519",
});
const pagedSource = new MemoryCasStore();
const pagedDocuments = Array.from({ length: 26 }, (_, offset) => ({
  ...baselineDocument, docId: String(21000000 + offset), filingDate: "2026-03-04",
  disclosedFiler: { firstName: "Jordan", lastName: "Sample", prefix: "Hon.", suffix: "Jr.", stateDistrict: "OR03" },
}));
const pagedArchive = await index(pagedDocuments);
const pagedPdf = new Uint8Array(await readFile(new URL("./fixtures/public-source-adapters/house/real-layout/ptr-single-row.pdf", import.meta.url)));
const alertsBeforePaging = alert.values.size;
const pagedOutcomes: string[] = [];
for (let page = 0; page < 2; page++) {
  const now = new Date(baseNow.getTime() + (page + 1) * 1_000);
  const monitor = (await getWorkspaceMonitor(pagedWorkspace.scope, pagedWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, pagedWorkspace.scope);
  const result = await evaluateCongressionalSignalsForWorker({ clients: { ...clients, acquisition: pagedSource,
    subscription: pagedSource,
    fetchIndex: async (url) => response(pagedArchive, "application/zip", url, now.toISOString()),
    fetchDocument: async (url) => response(pagedPdf, "application/pdf", url, now.toISOString()),
  }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment, now });
  pagedOutcomes.push(result.outcome.outcome);
  if (page === 0) {
    assert.equal(result.outcome.outcome, "source_pending",
      "an immediately actionable archive page must arm a bounded continuation");
    assert.equal((await getWorkspaceMonitor(pagedWorkspace.scope, monitor.monitorId, monitorStore))!
      .sourceCheckpoint.contentDigest, null, "the initial baseline checkpoint stays open between pages");
  } else {
    assert.equal(result.outcome.outcome, "no_match");
    assert.ok((await getWorkspaceMonitor(pagedWorkspace.scope, monitor.monitorId, monitorStore))!
      .sourceCheckpoint.contentDigest, "the checkpoint closes only after the actionable archive queue drains");
  }
}
assert.deepEqual(pagedOutcomes, ["source_pending", "no_match"],
  "the actionable archive queue must terminate after its second page");
const pagedSignals = [...signal.values.values()].map((raw) => JSON.parse(raw)).filter((record) =>
  record.workspaceId === pagedWorkspace.scope.workspaceId && record.recordType === "congressional_filing_signal");
assert.equal(pagedSignals.length, 26, "all 26 baseline filings must survive withheld acquisition batches");
assert.equal(alert.values.size, alertsBeforePaging, "no historical alert may escape a multi-batch baseline");

// A selected filer gets the first bounded acquisition slot without deleting
// unrelated work that does not fit in the batch.
const prioritySource = new MemoryCasStore();
const priorityDocument = { ...pagedDocuments[0]!, docId: "21999999",
  disclosedFiler: { firstName: "Jordan", lastName: "Sample", prefix: "Hon.", suffix: "Jr.", stateDistrict: "OR03" } };
const wrongDistrictDocument = { ...priorityDocument, docId: "21999998",
  disclosedFiler: { ...priorityDocument.disclosedFiler, stateDistrict: "OR04" } };
const ordinaryPriorityDocuments = pagedDocuments.slice(0, 25).map((document) => ({ ...document,
  disclosedFiler: { ...document.disclosedFiler, stateDistrict: "OR04" } }));
const priorityArchive = await index([...ordinaryPriorityDocuments, wrongDistrictDocument, priorityDocument]);
const priorityFetches: string[] = [];
const priorityAt = new Date(baseNow.getTime() + 7_000).toISOString();
const priorityResult = await runHousePublicSourceAcquisition({ client: prioritySource,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  priorityFilers: [{ firstName: "jordan", lastName: "sample", stateDistrict: "OR03" }],
  fetchIndex: async (url) => response(priorityArchive, "application/zip", url, priorityAt),
  fetchDocument: async (url) => { priorityFetches.push(url); return response(pagedPdf, "application/pdf", url, priorityAt); },
  window: { startAt: baseNow.toISOString(), endAt: priorityAt },
});
assert.equal(priorityResult.acquisition.result.status, "partial",
  "the synthetic state/district variants intentionally remain unresolved after proving selection order");
assert.match(priorityFetches[0]!, /21999999\.pdf$/u, "selected-filer matching must be case-insensitive and state/district exact");
assert.equal(priorityFetches.some((url) => url.endsWith("21999998.pdf")), false,
  "a state/district mismatch must not consume the selected-filer priority slot");
assert.equal(pagedSignals.length, 26,
  "the adjacent multi-batch fixture proves that priority ordering does not weaken durable overflow replay");

// A serverless interruption before the coordinator returns must already have
// a continuation receipt; the committed source page is reused on resumption.
class InterruptedWorkerSource extends MemoryCasStore {
  armed = true;
  async compareAndSet(key: string, expected: string | null, next: string) {
    const record = JSON.parse(next);
    const hit = this.armed && record.recordType === "public_source_instance" && record.cursor.revision === 1;
    if (hit) this.armed = false;
    const written = await super.compareAndSet(key, expected, next);
    if (hit) throw new Error("fixture_worker_interrupted_before_coordinator_return");
    return written;
  }
}
const interruptedWorkerSource = new InterruptedWorkerSource();
const interruptedWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175523" });
const interruptedNow = new Date(baseNow.getTime() + 2_000);
const interruptedPrepared = await prepare(interruptedWorkspace.monitor, interruptedNow, interruptedWorkspace.scope);
const interruptedLifecycle = createEarningsCallSourceLifecycleStore(interruptedWorkerSource);
const interruptedReceipt = { occurrenceKey: interruptedPrepared.envelope.occurrenceKey, scope: interruptedWorkspace.scope };
let interruptedDownloads = 0;
const interruptedArchive = await index(pagedDocuments[0]!);
const runInterruptedWorker = () => evaluateCongressionalSignalsForWorker({ clients: { ...clients,
  acquisition: interruptedWorkerSource, subscription: interruptedWorkerSource,
  fetchIndex: async (url) => {
    assert.ok(await interruptedLifecycle.readRetry(interruptedReceipt), "continuation must precede slow source I/O");
    return response(interruptedArchive, "application/zip", url, interruptedNow.toISOString());
  },
  fetchDocument: async (url) => {
    interruptedDownloads += 1;
    return response(pagedPdf, "application/pdf", url, interruptedNow.toISOString());
  },
}, ctx: { session: { auth: { current: interruptedPrepared.request.auth } } }, environment, now: interruptedNow });
await assert.rejects(runInterruptedWorker(), /fixture_worker_interrupted_before_coordinator_return/u);
assert.ok(await interruptedLifecycle.readRetry(interruptedReceipt));
assert.equal((await getWorkspaceMonitor(interruptedWorkspace.scope, interruptedWorkspace.monitor.monitorId, monitorStore))!.sourceCheckpoint.contentDigest, null);
await runInterruptedWorker();
assert.equal(interruptedDownloads, 1, "resumption must reuse the committed document instead of extracting again");
assert.equal(await interruptedLifecycle.readRetry(interruptedReceipt), null);
assert.equal(alert.values.size, alertsBeforePaging);

// Production compatibility: cursor revision four, canonical facts, no pending
// queue or sequence keys (the old deployment's exact storage shape).
const legacySource = new MemoryCasStore();
for (const [key, raw] of pagedSource.values) {
  const record = JSON.parse(raw);
  if (key.includes(":pending:") || record.eligibilityId?.startsWith("sequence:") ||
    (record.sourceInstanceId && Object.keys(record).sort().join() === "revision,sourceInstanceId")) continue;
  if (record.recordType === "public_source_instance") record.cursor = { ...record.cursor, revision: 4, watermark: "baseline:2026-03-04:21000025" };
  delete record.firstObservedCursorRevision;
  delete record.initialBaselineThroughRevision;
  legacySource.values.set(key, JSON.stringify(record));
}
const legacyWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175520" });
const legacySeed = new Map(legacySource.values);
// A recovery-enabled migration must use all replay slots when an unresolved
// filing exists: paid retries are deliberately deferred until replay finishes.
const unresolvedSeed = new MemoryCasStore();
const unresolvedAt = new Date(baseNow.getTime() + 8_000).toISOString();
const unresolvedArchive = await index(pagedDocuments.at(-1)!);
const unresolvedPdf = new Uint8Array(await readFile(new URL("./fixtures/public-source-adapters/house/real-layout/ptr-scanned.pdf", import.meta.url)));
await runHousePublicSourceAcquisition({ client: unresolvedSeed, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: baseNow.toISOString(), endAt: unresolvedAt },
  fetchIndex: async (url) => response(unresolvedArchive, "application/zip", url, unresolvedAt),
  fetchDocument: async (url) => response(unresolvedPdf, "application/pdf", url, unresolvedAt),
});
const fullReplaySource = new MemoryCasStore();
for (const [key, raw] of legacySeed) fullReplaySource.values.set(key, raw);
for (const [key, raw] of unresolvedSeed.values) {
  if (key.includes(":fact:") || key.includes(":fact-head:")) fullReplaySource.values.set(key, raw);
}
const fullReplayAt = new Date(baseNow.getTime() + 9_000).toISOString();
const fullReplay = await runHousePublicSourceAcquisition({ client: fullReplaySource,
  sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: baseNow.toISOString(), endAt: fullReplayAt },
  fetchIndex: async (url) => response(pagedArchive, "application/zip", url, fullReplayAt),
  fetchDocument: async () => { throw new Error("migration_replay_must_not_download"); },
  recovery: { async recover() { throw new Error("migration_replay_must_not_purchase_recovery"); } },
});
assert.equal(fullReplay.acquisition.facts.filter(({ factSchemaVersion }) => factSchemaVersion === "house-ptr-filing/v1").length,
  25, "an unresolved sibling must not halve the stored-fact replay batch");
for (let page = 0; page < 4; page++) {
  const now = new Date(baseNow.getTime() + (page + 10) * 1000);
  const monitor = (await getWorkspaceMonitor(legacyWorkspace.scope, legacyWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, legacyWorkspace.scope);
  try {
    await evaluateCongressionalSignalsForWorker({ clients: { ...clients, acquisition: legacySource, subscription: legacySource,
      fetchIndex: async (url) => response(pagedArchive, "application/zip", url, now.toISOString()),
      fetchDocument: async () => { throw new Error("legacy_complete_heads_must_not_refetch_pdf"); },
    }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment, now });
  } catch (error) {
    assert.ok(error instanceof CongressionalWorkspaceWorkerError && error.code === "congressional_source_unavailable", String(error));
  }
}
assert.equal([...signal.values.values()].map((raw) => JSON.parse(raw)).filter((record) =>
  record.workspaceId === legacyWorkspace.scope.workspaceId && record.recordType === "congressional_filing_signal").length, 26);
assert.ok((await getWorkspaceMonitor(legacyWorkspace.scope, legacyWorkspace.monitor.monitorId, monitorStore))!.sourceCheckpoint.contentDigest);

// Losing acknowledgements at every new durable boundary must not lose the
// remaining bootstrap queue or leave an unrepairable sequence/cursor gap.
for (const boundary of ["pending", "sequence", "cursor"] as const) {
  class InterruptedStore extends MemoryCasStore {
    armed = true;
    async compareAndSet(key: string, expected: string | null, next: string) {
      const record = JSON.parse(next);
      const hit = this.armed && (boundary === "pending" ? key.includes(":pending:") :
        boundary === "sequence" ? record.eligibilityId?.startsWith("sequence:") :
        record.recordType === "public_source_instance" && record.cursor.revision > 4);
      if (hit) this.armed = false;
      if (hit && boundary === "sequence") throw new Error("fixture_sequence_write_lost");
      const result = await super.compareAndSet(key, expected, next);
      if (hit) throw new Error(`fixture_${boundary}_ack_lost`);
      return result;
    }
  }
  const interrupted = new InterruptedStore();
  for (const [key, raw] of legacySeed) interrupted.values.set(key, raw);
  const acquire = (step: number) => {
    const at = new Date(baseNow.getTime() + (step + 30) * 1000).toISOString();
    return runHousePublicSourceAcquisition({ client: interrupted, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
      window: { startAt: baseNow.toISOString(), endAt: at },
      fetchIndex: async (url) => response(pagedArchive, "application/zip", url, at),
      fetchDocument: async () => { throw new Error("bootstrap_must_reuse_canonical_heads"); },
    });
  };
  await assert.rejects(acquire(0), /fixture_/u);
  const repaired = await acquire(1);
  assert.equal(repaired.acquisition.result.coverage, "complete", `${boundary} must resume the remaining bootstrap page`);
  assert.equal(await readPublicSourceSequenceStart("source.house-financial-disclosures.2026", interrupted), 4);
  assert.equal((await readPublicSourceInstance("source.house-financial-disclosures.2026", interrupted))!.cursor.revision, 6);
}

const mixedWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175521" });
const mixedSource = new MemoryCasStore();
const scanned = new Uint8Array(await readFile(new URL("./fixtures/public-source-adapters/house/real-layout/ptr-scanned.pdf", import.meta.url)));
const mixedEnvironment = { ...environment, EVE_HYBRID_EVIDENCE_ENABLED: "1", EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
  EVE_HYBRID_FAST_MODEL_ID: "fixture/extractor", EVE_HYBRID_FAST_MODEL_REASONING: "provider-default",
  EVE_HYBRID_FRONTIER_MODEL_ID: "fixture/frontier", EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/extractor,fixture/ocr,fixture/frontier" };
for (let page = 0; page < 5; page++) {
  const now = new Date(baseNow.getTime() + (page + 50) * 1000);
  const at = page === 0 ? new Date(baseNow.getTime() - 31 * 60_000).toISOString() : now.toISOString();
  const monitor = (await getWorkspaceMonitor(mixedWorkspace.scope, mixedWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, mixedWorkspace.scope);
  try {
    await evaluateCongressionalSignalsForWorker({ clients: { ...clients, acquisition: mixedSource, subscription: mixedSource,
      hybridRecoveryExtensions: [{ adapterId: "house-financial-disclosures", create: () => ({ recover: async () => null }) }],
      fetchIndex: async (url) => response(pagedArchive, "application/zip", url, at),
      fetchDocument: async (url) => response(page === 0 && url.endsWith("21000000.pdf") ? scanned : pagedPdf, "application/pdf", url, at),
    }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment: mixedEnvironment, now });
  } catch (error) {
    assert.ok(error instanceof CongressionalWorkspaceWorkerError && error.code === "congressional_source_unavailable", String(error));
  }
}
assert.equal([...signal.values.values()].map((raw) => JSON.parse(raw)).filter((record) =>
  record.workspaceId === mixedWorkspace.scope.workspaceId && record.recordType === "congressional_filing_signal").length, 26,
"a recovered incomplete filing must not hide its previously complete siblings");
assert.equal(alert.values.size, alertsBeforePaging);

const liveBackfill = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175522" });
const liveBackfillSource = new MemoryCasStore();
for (const [key, raw] of legacySeed) {
  const record = JSON.parse(raw);
  if (record.recordType === "public_source_instance") record.cursor.watermark = "2026-03-04:21000025";
  liveBackfillSource.values.set(key, JSON.stringify(record));
}
for (const [key, raw] of monitorStore.values) {
  const record = JSON.parse(raw);
  if (record.monitorId === liveBackfill.monitor.monitorId) {
    record.sourceCheckpoint = { contentDigest: "c".repeat(64), watermark: baseNow.toISOString() };
    monitorStore.values.set(key, JSON.stringify(record));
  }
}
const liveBackfillArchive = await index([...pagedDocuments, liveDocument]);
const liveBackfillPdf = new Uint8Array(await pdf(liveDocument.retainedFile));
const liveBackfillOutcomes: string[] = [];
for (let page = 0; page < 6; page++) {
  const now = new Date(baseNow.getTime() + (page + 20) * 1000);
  const monitor = (await getWorkspaceMonitor(liveBackfill.scope, liveBackfill.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, liveBackfill.scope);
  const run = () => evaluateCongressionalSignalsForWorker({ clients: { ...clients,
    acquisition: liveBackfillSource, subscription: liveBackfillSource,
    fetchIndex: async (url) => response(liveBackfillArchive, "application/zip", url, now.toISOString()),
    fetchDocument: async (url) => {
      assert.ok(url.endsWith(`${liveDocument.docId}.pdf`), "old canonical heads must not refetch");
      return response(liveBackfillPdf, "application/pdf", url, now.toISOString());
    },
  }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment, now });
  try {
    const result = await run();
    liveBackfillOutcomes.push(result.outcome.outcome);
    const alertsAfterPage = alert.values.size;
    assert.equal((await run()).replayed, true);
    assert.equal(alert.values.size, alertsAfterPage, "replaying a delivered page must not duplicate its alert");
  } catch (error) {
    assert.ok(error instanceof CongressionalWorkspaceWorkerError && error.code === "congressional_source_unavailable", String(error));
  }
}
assert.equal(liveBackfillOutcomes.filter((outcome) => outcome === "finding_staged").length, 1,
  "plain-watermark migration suppresses historical heads without suppressing the new live filing");

console.log("Congressional Signals Sprint 5 worker, replay, version, and isolation verification passed.");

// The adopted pack must use the real signed semantic job, with a deterministic
// completion provider for offline replay. No model, search, message, or trade.
Object.assign(clients, { budget: researchMemory });
const researchWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  nextOccurrenceAt: new Date(baseNow.getTime() + 1_000).toISOString(), version: "1.5.0", workspaceId: "123e4567-e89b-42d3-a456-426614175590" });
const researchBytes = new Map<string, Uint8Array>();
const researchArtifacts = createHybridEvidenceEphemeralArtifactStore({ index: researchMemory, blob: {
  async put(key, bytes) { researchBytes.set(key, Uint8Array.from(bytes)); },
  async get(key) { return researchBytes.get(key) ?? null; },
  async delete(key) { researchBytes.delete(key); },
} });
let researchDispatches = 0;
let researchBand: "priority" | "record_only" = "priority";
let researchFailure = false;
let researchCleanupFailure = false;
let reportPublications = 0;
const publishedReports: ResearchReport[] = [];
let lastEvidence: { canonicalUrl: string; rows: unknown[][]; historyCoverage: string; evidenceScope: string } | null = null;
const researchClientArtifacts: HybridEvidenceArtifactStore = { ...researchArtifacts,
  async deleteUnreferenced(artifactDigest) {
    if (researchCleanupFailure) throw new Error("fixture_cleanup_unavailable");
    return researchArtifacts.deleteUnreferenced(artifactDigest);
  },
};
(clients as { research?: CongressionalWorkspaceWorkerClients["research"] }).research = { artifacts: researchClientArtifacts, publishReport: async ({ artifactId, report }) => {
  publishedReports.push(researchReportSchema.parse(report)); reportPublications += 1;
  return { artifactId, kind: "report" } as never;
}, semantic: { jobs: researchMemory, semantic: researchMemory, lineage: researchMemory,
  async execute(prepared) {
    researchDispatches += 1;
    if (researchFailure) throw new Error("fixture_research_unavailable");
    const envelope = decodeHybridEvidenceWorkerToken(prepared.token);
    const completedAt = new Date((await readHybridEvidenceJob(envelope.jobId, researchMemory))!.job.updatedAt);
    assert.equal(envelope.modelId, "openai/gpt-5.4");
    const ctx = { session: { id: "fixture-research", auth: { current: prepared.request.auth, initiator: prepared.request.auth } } };
    const locator = envelope.allowedLocators.find(({ kind }) => kind === "text_span")!;
    const slice = await readHybridEvidenceSliceForWorker({ ctx, environment, locator,
      clients: { artifacts: researchArtifacts, jobs: researchMemory } });
    lastEvidence = JSON.parse(slice.content);
    assert.ok(lastEvidence && lastEvidence.rows.length > 0);
    await persistHybridEvidenceResearchDecisionForWorker({ ctx, environment, jobClient: researchMemory, now: completedAt,
      decision: { decision: "report_now", reason: "The official filing is sufficient for this bounded fixture brief." } });
    await completeHybridEvidenceJobForWorker({ ctx, environment, jobClient: researchMemory, now: completedAt,
      candidate: { citations: [locator], disposition: researchBand === "record_only" ? "abstained" : "accepted", unknowns: researchBand === "record_only" ? ["No supported incremental investment implication."] : [], fields: { band: researchBand, brief: {
        confidence: "low", title: "House disclosure merits a closer look", interpretation: "The disclosed transactions warrant review; their present investment significance is uncertain.",
        materialFacts: [{ statement: "The official PTR reports financial transactions.", sourceUrls: [lastEvidence.canonicalUrl] }],
        implications: ["Review the disclosed activity before drawing a current positioning conclusion."],
        uncertainty: ["The disclosure is delayed and does not establish current holdings or intent."], research: { status: "not_needed" },
        sources: [{ label: "Official House PTR", role: "official", url: lastEvidence.canonicalUrl }],
      } } } });
    return { inputTokens: 300, outputTokens: 150, paidCostUsd: "0.010001" };
  },
} };
const researchSource = new MemoryCasStore();
const researchBaseline = await prepare(researchWorkspace.monitor, baseNow, researchWorkspace.scope);
const researchBaselineResult = await execute({ document: baselineDocument, now: baseNow, prepared: researchBaseline, shouldFetch: true, sourceClient: researchSource });
await reconcileWorkspaceRunBudget({ runId: researchBaselineResult.result.outcome.runId, scope: researchWorkspace.scope,
  now: baseNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
assert.equal(researchDispatches, 0, "baseline must not purchase research or emit historical alerts");
const researchMonitor = await getWorkspaceMonitor(researchWorkspace.scope, researchWorkspace.monitor.monitorId, monitorStore);
assert.ok(researchMonitor);
const researchNow = new Date(baseNow.getTime() + 40_000);
const researchLive = await prepare({ ...researchMonitor, nextOccurrenceAt: researchNow.toISOString() }, researchNow, researchWorkspace.scope);
finding.failNextOutcome = true;
await assert.rejects(execute({ document: fixture("ptr-14.pdf"), now: researchNow, prepared: researchLive, shouldFetch: true, sourceClient: researchSource }), /fixture_post_history_interruption/);
const attemptsBeforeRetry = researchDispatches;
assert.ok(attemptsBeforeRetry > 0);
const researchRetry = await execute({ document: fixture("ptr-14.pdf"), now: researchNow, prepared: researchLive, shouldFetch: false, sourceClient: researchSource });
assert.equal(researchDispatches, attemptsBeforeRetry, "replay must reuse the accepted semantic result without a second model charge");
assert.equal(researchRetry.result.outcome.outcome, "finding_staged");
assert.equal(researchRetry.result.outcome.finding?.artifactRefs.length, 1);
assert.equal(researchRetry.result.outcome.finding?.facts?.[0]?.band, "priority");
assert.ok(reportPublications > 0);
const researchLedger = await readWorkspaceBudgetLedger(researchWorkspace.scope, researchMemory);
const researchChildren = researchLedger.reservations.filter(({ parentRunId }) => parentRunId === researchLive.envelope.runId);
assert.equal(researchChildren.length, attemptsBeforeRetry);
assert.ok(researchChildren.every((entry) => entry.state === "reconciled" && entry.reconciledPaidMicros === "10001" && entry.reconciledInputTokens === 300));

const historyForCorrection = await readCongressionalHistory(researchWorkspace.scope, signal);
const priorEntry = historyForCorrection!.activeEntries.find(({ alertEligible }) => alertEligible)!;
assert.ok(priorEntry);
assert.ok(priorEntry.transaction.source.page && priorEntry.transaction.source.page > 0,
  "positioned PDF evidence must retain its page through canonical signal projection");
assert.equal(isVerifiedSelectedDisclosureTransaction(priorEntry.transaction), true);
assert.equal(isVerifiedSelectedDisclosureTransaction({ ...priorEntry.transaction, transactionType: "E" }), false,
  "an exchange beside a verified purchase or sale must not inherit filing-level alert eligibility");
assert.equal(isVerifiedSelectedDisclosureTransaction({ ...priorEntry.transaction,
  eligibility: { reasonCodes: ["invalid_date"], state: "record_only" } }), false,
"a disqualified row beside a valid row must remain excluded from research, history eligibility, and reports");
// A deployed subscription/fact may predate the durable baseline metadata.
// Two successive header corrections must retain its established live lineage.
for (const [key, raw] of researchSource.values) {
  const record = JSON.parse(raw);
  delete record.firstObservedCursorRevision;
  delete record.initialBaselineThroughRevision;
  researchSource.values.set(key, JSON.stringify(record));
}
await reconcileWorkspaceRunBudget({ runId: researchLive.envelope.runId, scope: researchWorkspace.scope,
  now: researchNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
for (const [offset, filingDate] of ["2026-08-18", "2026-08-19", null].entries()) {
  const now = new Date(researchNow.getTime() + (offset + 1) * 1_000);
  const monitor = (await getWorkspaceMonitor(researchWorkspace.scope, researchWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, researchWorkspace.scope);
  // Inject an already-validated canonical journal to isolate legacy delivery
  // compatibility; physical amendment extraction has its own adapter fixtures.
  const previous = (await readLatestPublicSourceFactRevision(priorEntry.transaction.source.filingLogicalKey, researchSource))!;
  const source = (await readPublicSourceInstance(previous.sourceInstanceId, researchSource))!;
  const priorResult = publicSourceAcquisitionResultSchema.parse([...researchSource.values.values()].map((raw) => JSON.parse(raw))
    .find((record) => record.recordType === "public_source_acquisition_result" && record.candidateFactRevisionIds.includes(previous.revisionId)));
  const payload = { ...previous.payload, filingDate };
  const payloadDigest = digestPublicSourceValue(payload);
  const corrected = filingDate ? canonicalPublicFactRevisionSchema.parse({ ...previous, payload, payloadDigest,
    firstObservedCursorRevision: 0, createdObservedAt: now.toISOString(),
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey: previous.logicalKey, payloadDigest }) }) : null;
  const corrections = corrected ? [publicSourceCorrectionSchema.parse({ recordType: "public_source_fact_correction", schemaVersion: 1,
    logicalKey: previous.logicalKey, fromRevisionId: previous.revisionId, toRevisionId: corrected.revisionId,
    reason: "source_correction", createdObservedAt: now.toISOString(), correctionId: `correction.${digestPublicSourceValue([
      previous.logicalKey, previous.revisionId, corrected.revisionId, "source_correction"])}` })] : [];
  const removed = (await readLatestPublicSourceFactRevision(priorEntry.transaction.source.factLogicalKey, researchSource))!;
  const retractions = corrected ? [] : [publicSourceRetractionSchema.parse({ recordType: "public_source_fact_retraction", schemaVersion: 1,
    logicalKey: removed.logicalKey, fromRevisionId: removed.revisionId, sourceInstanceId: source.sourceInstanceId,
    reason: "source_amendment", createdObservedAt: now.toISOString(), retractionId: `retraction.${digestPublicSourceValue([
      removed.logicalKey, removed.revisionId, "source_amendment"])}` })];
  await commitPublicSourceAcquisition({ client: researchSource, acquisition: { facts: corrected ? [corrected] : [], corrections, retractions,
    window: prepared.envelope.window, result: { ...priorResult, acquisitionId: `fixture-legacy-correction-${offset}`,
      observedAt: now.toISOString(), candidateFactRevisionIds: corrected ? [corrected.revisionId] : [],
      correctionIds: corrections.map(({ correctionId }) => correctionId), retractionIds: retractions.map(({ retractionId }) => retractionId),
      proposedNextCursor: { ...priorResult.proposedNextCursor!, expectedRevision: source.cursor.revision,
        contentDigest: digestPublicSourceValue([offset, filingDate]), watermark: source.cursor.watermark! } } } });
  const dispatches = researchDispatches;
  const correction = await execute({ document: liveDocument, now, prepared, shouldFetch: false, sourceClient: researchSource });
  assert.equal(researchDispatches, dispatches + (corrected ? 1 : 0), "legacy live corrections must still reach research");
  assert.equal(correction.result.outcome.outcome, "finding_staged");
  const history = (await readCongressionalHistory(researchWorkspace.scope, signal))!;
  const entries = history.activeEntries.filter(({ transaction }) => transaction.source.filingLogicalKey === priorEntry.transaction.source.filingLogicalKey);
  assert.ok(entries.length > 0 && entries.every(({ transaction, alertEligible }) => transaction.processingMode === "live" && alertEligible));
  assert.equal((await execute({ document: liveDocument, now, prepared, shouldFetch: false, sourceClient: researchSource })).result.replayed, true);
  assert.equal(researchDispatches, dispatches + (corrected ? 1 : 0), "correction replay must not buy research twice");
  await reconcileWorkspaceRunBudget({ runId: prepared.envelope.runId, scope: researchWorkspace.scope,
    now, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
}
for (const mutation of [
  { amountRange: { ...priorEntry.transaction.amountRange, label: "Different disclosed range" } },
  { owner: { ...priorEntry.transaction.owner, relationship: priorEntry.transaction.owner.relationship === "spouse" ? "self" : "spouse" } },
  { transactionDate: "2026-01-01" },
  { notificationDate: "2026-01-02" },
  { asset: { ...priorEntry.transaction.asset, description: "Changed unmapped asset" } },
]) assert.equal(shouldCreateCongressionalCorrectionAlert({ currentBand: priorEntry.band, priorEntry,
  currentTransaction: { ...priorEntry.transaction, ...mutation } as typeof priorEntry.transaction }), true);
console.log("Congressional frontier research baseline, materiality, artifact, crash replay, and correction verification passed.");

const denseEvidence = congressionalResearchEvidenceContent({
  evaluation: { transactions: largeFilingTransactions, signal: largeFilingSignal,
    filing: { fact: { revisionId: "fixture-dense-filing" } } } as never,
  minimumAlertBand: "review", previousAlert: false,
});
assert.equal(JSON.parse(denseEvidence).rows.length, 224, "research must receive rows beyond the finding preview's first three");
assert.equal(JSON.parse(denseEvidence).historyCoverage, "incomplete");
assert.match(JSON.parse(denseEvidence).evidenceScope, /not a complete trading history/u);
const validationLocator = { kind: "text_span", artifactDigest: "a".repeat(64), start: 0, end: denseEvidence.length, spanDigest: "b".repeat(64) } as const;
const denseUrl = largeFilingTransactions[0]!.source.publicDocumentUrl;
const validationFields = { band: "record_only", brief: {
  confidence: "low", title: "No supported implication", interpretation: "The disclosed transactions alone do not support an incremental conclusion.",
  materialFacts: [{ statement: "The official PTR discloses transactions.", sourceUrls: [denseUrl] }],
  implications: ["Do not infer a current position from this disclosure."], uncertainty: ["Current holdings are unknown."],
  research: { status: "not_needed" }, sources: [{ label: "Official PTR", role: "official", url: denseUrl }],
} };
const validateResearch = (fields: unknown, disposition: "accepted" | "abstained", unknowns = ["No supported implication."]) =>
  congressionalResearchValidationContract.validate({ disposition, fields, unknowns,
    evidenceTexts: [{ content: denseEvidence, locator: validationLocator }], inputProjection: {} });
assert.equal(validateResearch(validationFields, "abstained").requireExactCitations, true);
assert.throws(() => validateResearch(validationFields, "accepted"), /congressional_research_output_invalid/);
assert.throws(() => validateResearch(validationFields, "abstained", []), /congressional_research_output_invalid/);
assert.throws(() => validateResearch({ ...validationFields, brief: { ...validationFields.brief,
  sources: [{ label: "Wrong official source", role: "official", url: "https://example.com/" }] } }, "abstained"));
const maximumEntries = Array.from({ length: 25 }, (_, index) => ({
  identity: `fixture.maximum.${String(index).padStart(2, "0")}`,
  transactions: [{ ...priorEntry.transaction, source: index === 0 ? {
    publicDocumentUrl: priorEntry.transaction.source.publicDocumentUrl,
    rowIdentity: `${priorEntry.transaction.source.rowIdentity}:maximum:${index}`,
  } : { ...priorEntry.transaction.source, rowIdentity: `${priorEntry.transaction.source.rowIdentity}:maximum:${index}` } }],
  brief: validationFields.brief,
}));
const maximumReports: ResearchReport[] = [];
const maximumReportRefs = await publishCongressionalResearchReport({
  entries: maximumEntries,
  scope: researchWorkspace.scope,
  asOf: researchNow.toISOString(),
  publishReport: async ({ artifactId, report }) => {
    maximumReports.push(researchReportSchema.parse(report));
    return { artifactId, kind: "report" } as never;
  },
});
assert.equal(maximumReportRefs.length, 2, "25 enriched filings must be split across bounded report artifacts");
assert.ok(maximumReports.every(({ blocks }) => blocks.length <= 40));
assert.equal(maximumReports.flatMap(({ blocks }) => blocks.flatMap((block) =>
  block.type === "table" ? block.rows : [])).length, 25, "report batching must retain every filing row");
assert.match(maximumReports.flatMap(({ blocks }) => blocks.flatMap((block) =>
  block.type === "table" ? block.rows.flat() : [])).join(" "), /page citation unavailable/u,
"a row without retained page provenance must say that the citation is unavailable rather than guessing");
const partialReportIds: string[] = [];
await assert.rejects(publishCongressionalResearchReport({ entries: maximumEntries,
  scope: researchWorkspace.scope, asOf: researchNow.toISOString(),
  publishReport: async ({ artifactId }) => {
    partialReportIds.push(artifactId);
    if (partialReportIds.length === 2) throw new Error("fixture_second_report_unavailable");
    return { artifactId, kind: "report" } as never;
  },
}), /fixture_second_report_unavailable/u);
const replayedReportIds: string[] = [];
const replayedReportRefs = await publishCongressionalResearchReport({ entries: maximumEntries,
  scope: researchWorkspace.scope, asOf: researchNow.toISOString(),
  publishReport: async ({ artifactId }) => {
    replayedReportIds.push(artifactId);
    return { artifactId, kind: "report" } as never;
  },
});
assert.deepEqual(replayedReportIds, partialReportIds,
  "a partial report publication must replay the same deterministic artifact identities");
assert.equal(replayedReportRefs.length, 2);
researchBand = "record_only";
const abstentionWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.5.0", workspaceId: "123e4567-e89b-42d3-a456-426614175591" });
const abstentionSource = new MemoryCasStore();
const abstentionBaseline = await prepare(abstentionWorkspace.monitor, baseNow, abstentionWorkspace.scope);
const abstentionBaselineResult = await execute({ document: baselineDocument, now: baseNow, prepared: abstentionBaseline, shouldFetch: true, sourceClient: abstentionSource });
await reconcileWorkspaceRunBudget({ runId: abstentionBaselineResult.result.outcome.runId, scope: abstentionWorkspace.scope,
  now: baseNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
const abstentionMonitor = await getWorkspaceMonitor(abstentionWorkspace.scope, abstentionWorkspace.monitor.monitorId, monitorStore);
assert.ok(abstentionMonitor);
const abstentionLive = await prepare(abstentionMonitor, researchNow, abstentionWorkspace.scope);
const publicationsBeforeAbstention = reportPublications;
const abstentionResult = await execute({ document: liveDocument, now: researchNow, prepared: abstentionLive, shouldFetch: true, sourceClient: abstentionSource });
assert.equal(abstentionResult.result.outcome.outcome, "finding_staged", "a verified transaction must alert even when research abstains");
assert.equal(reportPublications, publicationsBeforeAbstention + 1, "record-only research cannot veto the factual report");
const abstentionReport = publishedReports.at(-1)!;
const abstentionRows = abstentionReport.blocks.flatMap((block) => block.type === "table" ? block.rows : []);
assert.ok(abstentionRows.length > 0 && abstentionRows.every((row) => row.length === 6),
  "the factual report must retain every P/S row in a structured table");
const renderedAbstentionFacts = abstentionRows.flat().join(" ");
for (const required of ["not reported", "Purchase", "filed", "$", "page", ":"]) {
  assert.match(renderedAbstentionFacts, new RegExp(required.replace("$", "\\$"), "u"),
    `the factual report must render ${required}`);
}
assert.ok(abstentionReport.sources.some(({ url }) => url.endsWith(".pdf")),
  "the factual report must link the official filing URL referenced by each row");
assert.ok(abstentionReport.blocks.some((block) => block.type === "text" &&
  block.body.includes("Optional model interpretation")), "optional interpretation must follow the official facts");
const combinedFixtureFinding = combineCongressionalFindings([
  abstentionResult.result.outcome.finding!, researchRetry.result.outcome.finding!,
])!;
assert.deepEqual(combinedFixtureFinding.factIdentities,
  combinedFixtureFinding.facts?.map(({ filingIdentity }) => filingIdentity),
  "multi-filing facts and identities must remain paired after deterministic ordering");
const baseFinding = abstentionResult.result.outcome.finding!;
const baseFact = baseFinding.facts![0]!;
assert.equal(baseFact.kind, "congressional_filing_signal");
const maximumFinding = combineCongressionalFindings(Array.from({ length: 25 }, (_, index) => {
  const identity = `congressional-signal-revision.${String(index).padStart(2, "0")}${"a".repeat(62)}`;
  return { ...baseFinding, factIdentities: [identity], facts: [{ ...baseFact,
    filingIdentity: identity, signalRevisionId: identity,
    transactions: Array.from({ length: 50 }, () => ({ ...baseFact.transactions[0]!,
      assetDescription: "X".repeat(1_000) })) }] };
}))!;
assert.equal(maximumFinding.factIdentities.length, 25, "size compaction must retain every filing identity");
assert.ok(maximumFinding.facts?.every((fact) => fact.kind !== "congressional_filing_signal" || fact.transactions.length === 1));
assert.ok(Buffer.byteLength(JSON.stringify(maximumFinding), "utf8") < 512 * 1_024,
  "a maximum valid acquisition must remain below the atomic finding record limit");
assert.equal(researchBytes.size, 0, "temporary evidence bytes must be removed after acceptance and replay");
console.log("Congressional dense evidence, validator rejection, abstention, and artifact cleanup verification passed.");

// An unresolved historical filing is a coverage gap, not a barrier to validated
// selected-member filings, later arrivals, or a durable baseline checkpoint.
researchBand = "priority";
const partialWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: ["H001082"] },
  version: "1.5.0", workspaceId: "123e4567-e89b-42d3-a456-426614175592" });
const partialSource = new MemoryCasStore();
const historicalGap = pagedDocuments[0]!;
const baselineBytes = new Uint8Array(await pdf(baselineDocument.retainedFile));
const liveBytes = new Uint8Array(await pdf(liveDocument.retainedFile));
const researchBeforePartial = researchDispatches;
for (let phase = 0; phase < 3; phase++) {
  const now = new Date(baseNow.getTime() + (phase + 54) * 1_000);
  const observedAt = new Date(now.getTime() - (phase < 2 ? 31 * 60_000 : 0)).toISOString();
  const archive = await index([baselineDocument, historicalGap, ...(phase > 0 ? [liveDocument] : [])]);
  const monitor = (await getWorkspaceMonitor(partialWorkspace.scope, partialWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, partialWorkspace.scope);
  const run = () => evaluateCongressionalSignalsForWorker({ clients: { ...clients,
    acquisition: partialSource, subscription: partialSource,
    hybridRecoveryExtensions: [{ adapterId: "house-financial-disclosures", create: () => ({ recover: async () => null }) }],
    fetchIndex: async (url) => response(archive, "application/zip", url, observedAt),
    fetchDocument: async (url) => response(url.endsWith(`${historicalGap.docId}.pdf`) ? (phase === 2 ? pagedPdf : scanned) :
      url.endsWith(`${baselineDocument.docId}.pdf`) ? baselineBytes : liveBytes, "application/pdf", url, observedAt),
  }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment: {
    ...mixedEnvironment, EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
    EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: "fixture/extractor,fixture/ocr,openai/gpt-5.4",
  }, now });
  const result = await run();
  assert.equal(result.outcome.outcome, phase === 1 ? "finding_staged" : "no_match");
  const after = (await getWorkspaceMonitor(partialWorkspace.scope, monitor.monitorId, monitorStore))!;
  assert.ok(after.sourceCheckpoint.contentDigest, "resolved filings must establish a checkpoint despite unrelated gaps");
  const history = (await readCongressionalHistory(partialWorkspace.scope, signal))!;
  if (phase < 2) {
    assert.equal(history.coverage.state, "incomplete");
    const runCoverage = [...coverage.values.values()].map((raw) => JSON.parse(raw)).find((record) => record.runId === result.outcome.runId);
    assert.equal(runCoverage.successes[0].unresolvedItemCount, 1);
    assert.equal(runCoverage.successes[0].acquisitionCoverage, phase === 0 ? "unsupported" : "partial");
    assert.ok(history.activeEntries.some(({ transaction }) => transaction.source.publicDocumentUrl.endsWith(`${baselineDocument.docId}.pdf`)));
    assert.ok(history.activeEntries.every(({ transaction }) => !transaction.source.publicDocumentUrl.endsWith(`${historicalGap.docId}.pdf`)),
      "unsupported filing rows must never enter history or research");
  } else {
    const recovered = [...signal.values.values()].map((raw) => JSON.parse(raw)).filter((record) =>
      record.workspaceId === partialWorkspace.scope.workspaceId && record.recordType === "house_strategy_transaction" &&
      record.source.publicDocumentUrl.endsWith(`${historicalGap.docId}.pdf`));
    assert.ok(recovered.length > 0);
    assert.ok(recovered.every((transaction) => transaction.processingMode === "baseline"),
      "a filing first observed in the initial archive remains historical after late recovery");
  }
  assert.equal(researchDispatches, researchBeforePartial + (phase > 0 ? 1 : 0), "only the genuinely new selected filing may buy research");
  if (phase === 1) {
    assert.equal(lastEvidence!.historyCoverage, "incomplete", "the real research worker must receive incomplete coverage");
    assert.match(lastEvidence!.evidenceScope, /not a complete trading history/u);
  }
  const alertCount = alert.values.size;
  assert.equal((await run()).replayed, true);
  assert.equal(alert.values.size, alertCount);
  await reconcileWorkspaceRunBudget({ runId: result.outcome.runId, scope: partialWorkspace.scope, now,
    outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
}
console.log("Congressional partial progress, durable baseline, new arrivals, and late recovery verification passed.");

// The shared source head is not a lagging live workspace's initial boundary.
const migrationSource = new MemoryCasStore();
const migrationWorkspaces = ["123e4567-e89b-42d3-a456-426614175593", "123e4567-e89b-42d3-a456-426614175594"].map((workspaceId) =>
  installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: ["H001082"] },
    nextOccurrenceAt: new Date(baseNow.getTime() + 1_000).toISOString(), version: "1.5.0", workspaceId }));
for (const [offset, workspace] of migrationWorkspaces.entries()) {
  const prepared = await prepare(workspace.monitor, baseNow, workspace.scope);
  await execute({ document: baselineDocument, now: baseNow, prepared, shouldFetch: offset === 0, sourceClient: migrationSource });
  await reconcileWorkspaceRunBudget({ runId: prepared.envelope.runId, scope: workspace.scope,
    now: baseNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
}
for (const [key, raw] of migrationSource.values) {
  const record = JSON.parse(raw);
  if (record.workspaceId === migrationWorkspaces[1]!.scope.workspaceId) {
    delete record.initialBaselineThroughRevision;
    migrationSource.values.set(key, JSON.stringify(record));
  }
}
const migrationNow = new Date(baseNow.getTime() + 45_000);
for (const [offset, workspace] of migrationWorkspaces.entries()) {
  const monitor = (await getWorkspaceMonitor(workspace.scope, workspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: migrationNow.toISOString() }, migrationNow, workspace.scope);
  const dispatches = researchDispatches;
  const result = await execute({ document: liveDocument, now: migrationNow, prepared, shouldFetch: offset === 0, sourceClient: migrationSource });
  assert.equal(result.result.outcome.outcome, "finding_staged", "another workspace's acquisition must not turn an undelivered live filing into baseline");
  assert.equal(researchDispatches, dispatches + 1);
  assert.equal((await execute({ document: liveDocument, now: migrationNow, prepared, shouldFetch: false, sourceClient: migrationSource })).result.replayed, true);
  assert.equal(researchDispatches, dispatches + 1);
  await reconcileWorkspaceRunBudget({ runId: prepared.envelope.runId, scope: workspace.scope,
    now: migrationNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
}
console.log("Congressional live subscription migration across shared acquisitions verified.");

const backlogWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175595" });
const backlogSourceId = backlogWorkspace.monitor.publicSourceSubscriptions![0]!.sourceInstanceId;
const backlogSourceBefore = (await readPublicSourceInstance(backlogSourceId, pagedSource))!;
const backlogIds: string[] = [];
for (;;) {
  const next = await readNextPublicSourceAcquisition({ sourceInstanceId: backlogSourceId,
    afterAcquisitionId: backlogIds.at(-1) ?? null, throughRevision: backlogSourceBefore.cursor.revision - 1 }, pagedSource);
  if (!next) break;
  backlogIds.push(next.result.acquisitionId);
}
assert.ok(backlogIds.length > 1);
let backlogFetches = 0;
for (const [offset] of backlogIds.entries()) {
  const now = new Date(baseNow.getTime() + (offset + 46) * 1_000);
  const monitor = (await getWorkspaceMonitor(backlogWorkspace.scope, backlogWorkspace.monitor.monitorId, monitorStore))!;
  const prepared = await prepare({ ...monitor, nextOccurrenceAt: now.toISOString() }, now, backlogWorkspace.scope);
  const run = () => evaluateCongressionalSignalsForWorker({ clients: { ...clients, acquisition: pagedSource, subscription: pagedSource,
    fetchIndex: async () => { backlogFetches++; throw new Error("committed_backlog_must_not_fetch_index"); },
    fetchDocument: async () => { backlogFetches++; throw new Error("committed_backlog_must_not_fetch_document"); },
  }, ctx: { session: { auth: { current: prepared.request.auth } } }, environment, now });
  const result = await run();
  assert.equal(result.outcome.outcome, offset < backlogIds.length - 1 ? "source_pending" : "no_match");
  assert.equal(result.outcome.sourcePending === true, offset < backlogIds.length - 1);
  assert.equal((await run()).replayed, true);
  assert.deepEqual((await readPublicSourceInstance(backlogSourceId, pagedSource))!.cursor, backlogSourceBefore.cursor);
}
assert.equal(backlogFetches, 0, "validated backlog drains without source I/O or recovery work");
assert.ok((await getWorkspaceMonitor(backlogWorkspace.scope, backlogWorkspace.monitor.monitorId, monitorStore))!.sourceCheckpoint.contentDigest);
console.log("Congressional ordered backlog delivery without acquisition verified.");

const movingSource = new MemoryCasStore();
const movingWorkspace = installWorkspace({ configuration: { minimumAlertBand: "review", selectedMemberBioguideIds: [] },
  version: "1.4.0", workspaceId: "123e4567-e89b-42d3-a456-426614175596" });
const movingNow = new Date(baseNow.getTime() + 52_000);
const movingPrepared = await prepare({ ...movingWorkspace.monitor, nextOccurrenceAt: movingNow.toISOString() }, movingNow, movingWorkspace.scope);
finding.failNextOutcome = true;
await assert.rejects(execute({ document: baselineDocument, now: movingNow, prepared: movingPrepared, shouldFetch: true, sourceClient: movingSource }), /fixture_post_history_interruption/);
const movingHistory = await readCongressionalHistory(movingWorkspace.scope, signal);
await runHousePublicSourceAcquisition({ client: movingSource, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
  window: { startAt: movingNow.toISOString(), endAt: new Date(movingNow.getTime() + 1_000).toISOString() },
  fetchIndex: async (url) => response(await index(liveDocument), "application/zip", url, new Date(movingNow.getTime() + 1_000).toISOString()),
  fetchDocument: async (url) => response(liveBytes, "application/pdf", url, new Date(movingNow.getTime() + 1_000).toISOString()),
});
const movingRetry = await execute({ document: baselineDocument, now: movingNow, prepared: movingPrepared, shouldFetch: false, sourceClient: movingSource });
assert.equal(movingRetry.result.outcome.outcome, "no_match");
assert.deepEqual(await readCongressionalHistory(movingWorkspace.scope, signal), movingHistory,
  "a shared-source append between attempts must not change the occurrence's persisted history");
const movingMonitor = (await getWorkspaceMonitor(movingWorkspace.scope, movingWorkspace.monitor.monitorId, monitorStore))!;
const nextMovingNow = new Date(movingNow.getTime() + 2_000);
const nextMoving = await prepare({ ...movingMonitor, nextOccurrenceAt: nextMovingNow.toISOString() }, nextMovingNow, movingWorkspace.scope);
const nextMovingResult = await execute({ document: liveDocument, now: nextMovingNow, prepared: nextMoving, shouldFetch: false, sourceClient: movingSource });
assert.equal(nextMovingResult.result.outcome.outcome, "finding_staged", "the next occurrence must still deliver the newly appended live filing");
console.log("Congressional interrupted delivery retains an occurrence-stable source boundary.");
const emptyNow = new Date(movingNow.getTime() + 3_000);
const emptyMonitor = (await getWorkspaceMonitor(movingWorkspace.scope, movingWorkspace.monitor.monitorId, monitorStore))!;
const emptyPrepared = await prepare({ ...emptyMonitor, nextOccurrenceAt: emptyNow.toISOString() }, emptyNow, movingWorkspace.scope);
finding.failNextOutcome = true;
await assert.rejects(execute({ document: liveDocument, now: emptyNow, prepared: emptyPrepared, shouldFetch: true, sourceClient: movingSource }), /fixture_post_history_interruption/);
assert.equal((await execute({ document: liveDocument, now: emptyNow, prepared: emptyPrepared, shouldFetch: false, sourceClient: movingSource })).result.outcome.outcome, "no_match",
  "a pinned empty acquisition must remain replayable");

researchFailure = true;
researchCleanupFailure = true;
try {
const failedResearchWorkspace = installWorkspace({ configuration: { selectedMemberBioguideIds: [] },
  version: "1.6.0", workspaceId: "123e4567-e89b-42d3-a456-426614175598" });
const failedResearchSource = new MemoryCasStore();
const failedBaseline = await prepare(failedResearchWorkspace.monitor, baseNow, failedResearchWorkspace.scope);
const failedBaselineResult = await execute({ document: baselineDocument, now: baseNow, prepared: failedBaseline, shouldFetch: true, sourceClient: failedResearchSource });
await reconcileWorkspaceRunBudget({ runId: failedBaselineResult.result.outcome.runId, scope: failedResearchWorkspace.scope,
  now: baseNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
const failedMonitor = (await getWorkspaceMonitor(failedResearchWorkspace.scope, failedResearchWorkspace.monitor.monitorId, monitorStore))!;
const failedPrepared = await prepare(failedMonitor, researchNow, failedResearchWorkspace.scope);
const reportsBeforeFailedResearch = publishedReports.length;
const failedResult = await execute({ document: liveDocument, now: researchNow, prepared: failedPrepared, shouldFetch: true, sourceClient: failedResearchSource });
assert.equal(failedResult.result.outcome.outcome, "finding_staged", "research failure must fall back to verified facts");
assert.match(failedResult.result.outcome.finding!.summary, /disclosed/u);
assert.ok(publishedReports.length > reportsBeforeFailedResearch);
assert.ok(publishedReports.at(-1)!.blocks.some((block) => block.type === "text" &&
  block.body.includes("interpretation unavailable")), "research failure must produce an explicitly factual-only report");
const failedLedger = await readWorkspaceBudgetLedger(failedResearchWorkspace.scope, researchMemory);
const failedChildren = failedLedger.reservations.filter(({ parentRunId }) => parentRunId === failedPrepared.envelope.runId);
assert.ok(failedChildren.length > 0 && failedChildren.every(({ state, paidMicros, reconciledPaidMicros }) =>
  state === "uncertain" && BigInt(paidMicros) > 0n && reconciledPaidMicros === null),
"a dispatched research failure must settle conservatively as uncertain reserved usage");
assert.equal(failedLedger.reservations.some(({ parentRunId, state }) =>
  parentRunId === failedPrepared.envelope.runId && state === "reserved"), false,
"a research failure must not leave an unsettled child reservation");
} finally { researchFailure = false; researchCleanupFailure = false; }
console.log("Congressional research failure falls back to factual notification and reconciles conservatively.");

const deniedResearchWorkspace = installWorkspace({ configuration: { selectedMemberBioguideIds: [] },
  version: "1.6.0", workspaceId: "123e4567-e89b-42d3-a456-426614175599" });
const deniedResearchSource = new MemoryCasStore();
const deniedBaseline = await prepare(deniedResearchWorkspace.monitor, baseNow, deniedResearchWorkspace.scope);
const deniedBaselineResult = await execute({ document: baselineDocument, now: baseNow, prepared: deniedBaseline, shouldFetch: true, sourceClient: deniedResearchSource });
await reconcileWorkspaceRunBudget({ runId: deniedBaselineResult.result.outcome.runId, scope: deniedResearchWorkspace.scope,
  now: baseNow, outcome: "reconciled", actualInputTokens: 0, actualOutputTokens: 0, actualPaidCost: "0" }, researchMemory);
const deniedMonitor = (await getWorkspaceMonitor(deniedResearchWorkspace.scope, deniedResearchWorkspace.monitor.monitorId, monitorStore))!;
const deniedPrepared = await prepare(deniedMonitor, researchNow, deniedResearchWorkspace.scope);
const savedBudgetClient = clients.budget;
(clients as { budget?: WorkspaceBudgetLedgerClient }).budget = {
  get: (key) => researchMemory.get(key),
  compareAndSet: async () => { throw new Error("fixture_no_research_budget"); },
};
const dispatchesBeforeDeniedResearch = researchDispatches;
try {
const deniedResult = await execute({ document: liveDocument, now: researchNow, prepared: deniedPrepared, shouldFetch: true, sourceClient: deniedResearchSource });
assert.equal(deniedResult.result.outcome.outcome, "finding_staged", "no research allowance must fall back to verified facts");
assert.equal(researchDispatches, dispatchesBeforeDeniedResearch, "budget denial must occur before model dispatch");
assert.equal((await readWorkspaceBudgetLedger(deniedResearchWorkspace.scope, researchMemory)).reservations
  .some(({ parentRunId }) => parentRunId === deniedPrepared.envelope.runId), false,
"pre-dispatch budget denial must not create a child model reservation");
} finally { (clients as { budget?: WorkspaceBudgetLedgerClient }).budget = savedBudgetClient; }
console.log("Congressional research-budget denial falls back to factual notification without model dispatch.");
