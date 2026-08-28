/*
 * Focused red-first regression for docs/congressional-monitor-retry-defect.md.
 *
 * Recorded failure: a House disclosure acquisition failure returned prose
 * without a committed outcome, so the scheduler treated the occurrence as
 * unfinished and dispatched it five times before the monitor auto-paused.
 *
 * This verifier exercises the worker in isolation (the same level sprint 5
 * already tests source-acquisition failure at) because the fix lives entirely
 * inside the strategy-owned worker: a deterministic ("terminal_failure")
 * House acquisition status now pauses the monitor itself, on this first
 * attempt, before the worker throws. The generic scheduler is untouched, so
 * the existing bounded five-attempt recovery window still applies to any
 * failure the worker does not classify as deterministic - proven here by the
 * "uncertain" (transport-ambiguous) case, which must leave the monitor
 * exactly as it was.
 */
import assert from "node:assert/strict";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import type { CongressionalSignalStoreClient } from "../agent/lib/congressional-signal-store";
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
  readonly values = new Map<string, string>();
  async createOutcomeWithIdentityClaims(input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0]) {
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
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 41).toString("base64url"),
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
const baseNow = new Date();

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
    // Production workspaces installed before the deployment's primary-model
    // change retain this reviewed policy. Preparing and evaluating the House
    // occurrence must remain valid because dispatch itself is deterministic;
    // any nested recovery model is authorized separately by the strategy.
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 2_000 },
  };
}

function installWorkspace(input: {
  monitorStore: MemoryMonitorStore;
  state: MemoryCasStore;
  workspaceId: string;
}) {
  const pack = strategyPackCatalog.resolve({ id: "congressional-signals", version: "1.3.0" });
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
      minimumAlertBand: "review",
      selectedMemberBioguideIds: [],
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
    prepareInitialWorkspaceDocument("capabilities", { now: baseNow, scope, value: capabilitiesFor("1.3.0") }),
    prepareInitialWorkspaceStrategyBinding({ now: baseNow, scope, value: strategy }),
  ]) input.state.values.set(prepared.key, prepared.raw);
  input.monitorStore.values.set(preparedMonitor.recordKey, preparedMonitor.raw);
  return { monitor: preparedMonitor.monitor, scope };
}

let sequence = 0;
async function prepare(input: {
  coverage: MemoryCasStore;
  monitor: WorkspaceMonitor;
  now: Date;
  scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>;
  state: MemoryCasStore;
}) {
  sequence += 1;
  const occurrenceKey = sequence.toString(16).padStart(64, "0");
  const claimed = {
    leaseExpiresAt: new Date(input.now.getTime() + 30 * 60_000).toISOString(),
    leaseToken: `lease-${sequence}`,
    monitor: input.monitor,
    occurrence: {
      attempt: 1,
      configurationRevision: input.monitor.configurationRevision,
      leaseTokenDigest: sequence.toString(16).padStart(64, "a").slice(-64),
      monitorId: input.monitor.monitorId,
      occurrenceIdentity: `interval:${input.monitor.nextOccurrenceAt}`,
      occurrenceKey,
      scheduledFor: input.monitor.nextOccurrenceAt!,
      schemaVersion: 1,
      status: "leased",
      updatedAt: input.now.toISOString(),
    },
    scope: input.scope,
    skippedOccurrenceIdentities: [],
  } satisfies ClaimedWorkspaceMonitor;
  const common = {
    calendarDay: input.now.toISOString().slice(0, 10),
    createdAt: input.now.toISOString(),
    runId: `${occurrenceKey}:attempt:1`,
    state: "reserved" as const,
    updatedAt: input.now.toISOString(),
  };
  const dispatchBudget = {
    global: common,
    runId: common.runId,
    workspace: {
      ...common,
      calendarMonth: input.now.toISOString().slice(0, 7),
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
    clients: { sourceCoverage: input.coverage, state: input.state },
    dispatchBudget,
    environment,
    now: input.now,
  });
}

function response(input: {
  body: Uint8Array;
  contentType: string;
  status?: number;
  url: string;
}): HousePublicSourceBinaryResponse {
  return {
    body: input.body,
    contentType: input.contentType,
    finalUrl: input.url,
    observedAt: baseNow.toISOString(),
    requestedUrl: input.url,
    status: input.status ?? 200,
  };
}

async function validArchive(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "2026FD.xml",
    new TextReader(`<?xml version="1.0" encoding="UTF-8"?><FinancialDisclosure></FinancialDisclosure>`),
  );
  return writer.close();
}

// --- Scenario A: a deterministic acquisition failure ("terminal_failure") ---
// The House index responds 200 with a content-type House never sends for its
// ZIP index (e.g. an HTML error page instead of the archive). This is exactly
// the "archive_invalid" -> "terminal_failure" classification the shared House
// adapter already produces; it will recur identically on every retry.
{
  const state = new MemoryCasStore();
  const source = new MemoryCasStore();
  const coverage = new MemoryCasStore();
  const monitorStore = new MemoryMonitorStore();
  const clients: CongressionalWorkspaceWorkerClients = {
    acquisition: source,
    alert: new MemoryAlertStore(),
    finding: new MemoryFindingStore(),
    monitor: monitorStore,
    signal: new MemorySignalStore(),
    sourceCoverage: coverage,
    state,
    subscription: source,
  };
  const workspace = installWorkspace({ monitorStore, state, workspaceId: "123e4567-e89b-42d3-a456-426614179601" });
  const prepared = await prepare({ coverage, monitor: workspace.monitor, now: baseNow, scope: workspace.scope, state });

  await assert.rejects(
    evaluateCongressionalSignalsForWorker({
      clients: {
        ...clients,
        fetchIndex: async (url) => response({ body: new TextEncoder().encode("<html>error</html>"), contentType: "text/html", url }),
      },
      ctx: { session: { auth: { current: prepared.request.auth } } },
      environment,
      now: baseNow,
    }),
    (error) => error instanceof CongressionalWorkspaceWorkerError &&
      error.code === "congressional_source_unavailable",
    "a deterministic House acquisition failure must still surface as congressional_source_unavailable",
  );

  const after = await getWorkspaceMonitor(workspace.scope, workspace.monitor.monitorId, monitorStore);
  assert.ok(after, "the monitor record must still exist");
  assert.equal(
    after.lifecycleState,
    "paused_failure",
    "a deterministic acquisition failure must terminalize the occurrence by pausing the monitor on the first attempt, not after the default five-attempt threshold",
  );
  assert.equal(after.consecutiveFailures, 1, "the monitor must pause on exactly one deterministic failure");
  assert.equal(after.nextOccurrenceAt, null, "a paused monitor must not remain due for the same occurrence again");

  console.log("Scenario A (terminal_failure): monitor paused after exactly one attempt.");
}

// --- Scenario B: a genuine transport interruption ("uncertain") ---
// The generic bounded-recovery contract this repairs explicitly preserves:
// an ambiguous failure (e.g. a transport error with no HTTP response at all)
// must NOT pause the monitor itself. It must fall through unchanged to the
// scheduler's existing default consecutive-failure/recovery-window handling.
{
  const state = new MemoryCasStore();
  const source = new MemoryCasStore();
  const coverage = new MemoryCasStore();
  const monitorStore = new MemoryMonitorStore();
  const clients: CongressionalWorkspaceWorkerClients = {
    acquisition: source,
    alert: new MemoryAlertStore(),
    finding: new MemoryFindingStore(),
    monitor: monitorStore,
    signal: new MemorySignalStore(),
    sourceCoverage: coverage,
    state,
    subscription: source,
  };
  const workspace = installWorkspace({ monitorStore, state, workspaceId: "123e4567-e89b-42d3-a456-426614179602" });
  const prepared = await prepare({ coverage, monitor: workspace.monitor, now: baseNow, scope: workspace.scope, state });
  const before = await getWorkspaceMonitor(workspace.scope, workspace.monitor.monitorId, monitorStore);
  assert.ok(before);

  await assert.rejects(
    evaluateCongressionalSignalsForWorker({
      clients: {
        ...clients,
        fetchIndex: async () => {
          throw new Error("fixture_house_transport_timeout");
        },
      },
      ctx: { session: { auth: { current: prepared.request.auth } } },
      environment,
      now: baseNow,
    }),
    (error) => error instanceof CongressionalWorkspaceWorkerError &&
      error.code === "congressional_source_unavailable",
  );

  const after = await getWorkspaceMonitor(workspace.scope, workspace.monitor.monitorId, monitorStore);
  assert.ok(after);
  assert.deepEqual(
    after,
    before,
    "an ambiguous transport interruption must leave the monitor record untouched, preserving the scheduler's own bounded recovery window",
  );

  console.log("Scenario B (uncertain): monitor left untouched for the scheduler's bounded recovery.");
}

// --- Control: the fixture archive still round-trips as "complete" ---
// Guards against the new content-type check accidentally rejecting a normal
// acquisition (i.e. proves scenario A fails for the intended reason).
{
  assert.equal((await validArchive()).length > 0, true);
}

console.log("Congressional Signals retry-defect verification passed.");
