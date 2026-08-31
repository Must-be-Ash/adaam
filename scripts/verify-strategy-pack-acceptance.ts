import assert from "node:assert/strict";
import { mock } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ScheduleToFn } from "eve/schedules";

import {
  assignPhotonIngress,
  createPhotonIngressReceipt,
  type PhotonIngressStoreClient,
} from "../agent/lib/photon-ingress-store";
import {
  applyPhotonAlertDiscussAction,
  consumePhotonPendingAlertContext,
  createPhotonWorkspace,
  getPhotonWorkspaceState,
  selectPhotonWorkspace,
} from "../agent/lib/photon-workspace-store";
import { deliverWorkspaceAlertToPhoton } from "../agent/lib/photon-alert-delivery";
import {
  readWorkspaceAlert,
  type WorkspaceAlertStoreClient,
} from "../agent/lib/workspace-alert-store";
import type { WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import {
  finishWorkspaceMonitorDispatchBudget,
  reserveWorkspaceMonitorDispatchBudget,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceFindingStoreClient } from "../agent/lib/workspace-finding-store";
import {
  claimDueWorkspaceMonitors,
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  listWorkspaceMonitors,
  pauseWorkspaceMonitorAfterUncertainAlert,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import { evaluateSecIpoSourceForWorker } from "../agent/lib/sec-ipo-workspace-worker";
import {
  normalizeSecIpoFetch,
} from "../agent/lib/sec-ipo-evaluation";
import { SEC_IPO_SOURCE_URL } from "../agent/lib/sec-ipo-reference";
import {
  prepareSecIpoAcceptanceReplay,
  StrategyPackAcceptanceError,
} from "../agent/lib/strategy-pack-acceptance";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveStrategyPackFlags } from "../agent/lib/strategy-pack-flags";
import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../agent/lib/strategy-pack-reference-catalog";
import {
  createStrategyPackWorkspaceFromSelection,
  deriveEveStrategyPackMutationIdentity,
  inspectStrategyPackWorkspace,
  listStrategyPacks,
  StrategyPackServiceError,
} from "../agent/lib/strategy-pack-service";
import type { StrategyPackTransactionClient } from "../agent/lib/strategy-pack-transaction";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorkerRun,
  requireWorkspaceWorkerOutcome,
  type PreparedWorkspaceWorkerRun,
} from "../agent/lib/workspace-worker-runner";
import { recoverSecIpoWorkspaceRunForControlPlane } from "../agent/lib/sec-ipo-workspace-worker";
import { createEventTriggerSchedule } from "../agent/schedules/event-triggers";

class MemoryCasStore
  implements WorkspaceBudgetLedgerClient, WorkspaceGlobalBudgetClient,
    WorkspaceSourceCoverageClient, WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryCreateStore
  implements WorkspaceAlertStoreClient, WorkspaceFindingStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async createOutcomeWithIdentityClaims(
    input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0],
  ) {
    const outcome = this.values.get(input.outcomeKey);
    if (outcome) return { status: "existing" as const, value: outcome };
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
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryIngressStore implements PhotonIngressStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return { created: false, value: existing };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryAcceptanceStore
  implements WorkspaceMonitorStoreClient, StrategyPackTransactionClient {
  indexes = new Map<string, Set<string>>();
  values = new Map<string, string>();
  due = new Map<string, number>();
  leases = new Map<string, { expiresAt: number; token: string }>();
  occurrences = new Map<string, Record<string, unknown>>();
  inflightUntil = new Map<string, number>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return "conflict" as const;
    this.values.set(key, next);
    return "swapped" as const;
  }
  async get(key: string) {
    const lease = this.leases.get(key);
    if (lease) return lease.token;
    const occurrence = this.occurrences.get(key);
    if (occurrence) return JSON.stringify(occurrence);
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, options?: { ex?: number; nx?: true }) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK" as const;
  }
  async list(indexKey: string) {
    return [...(this.indexes.get(indexKey) ?? [])].map(
      (key) => this.values.get(key) ?? null,
    );
  }
  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    const members = this.indexes.get(input.workspaceIndexKey) ?? new Set<string>();
    members.add(input.recordKey);
    this.indexes.set(input.workspaceIndexKey, members);
    if (input.dueAtMs !== null) this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }
  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    if (input.dueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }
  async listDue(input: Parameters<WorkspaceMonitorStoreClient["listDue"]>[0]) {
    for (const [recordKey, expiresAt] of this.inflightUntil) {
      if (expiresAt <= input.nowMs) {
        this.inflightUntil.delete(recordKey);
        this.due.set(recordKey, input.nowMs);
      }
    }
    for (const [leaseKey, lease] of this.leases) {
      if (lease.expiresAt <= input.nowMs) this.leases.delete(leaseKey);
    }
    return [...this.due]
      .filter(([, dueAt]) => dueAt <= input.nowMs)
      .sort((left, right) => left[1] - right[1])
      .slice(0, input.limit)
      .map(([recordKey]) => ({ raw: this.values.get(recordKey) ?? null, recordKey }));
  }
  async claim(input: Parameters<WorkspaceMonitorStoreClient["claim"]>[0]) {
    const raw = this.values.get(input.recordKey);
    if (!raw) return { status: "missing" as const };
    const monitor = JSON.parse(raw) as WorkspaceMonitor;
    if (monitor.configurationRevision !== input.configurationRevision) {
      return { status: "stale" as const };
    }
    if (monitor.lifecycleState !== "enabled" || !monitor.nextOccurrenceAt) {
      this.due.delete(input.recordKey);
      return { status: "not_due" as const };
    }
    if (Date.parse(monitor.nextOccurrenceAt) > input.nowMs) {
      return { status: "not_due" as const };
    }
    const activeLease = this.leases.get(input.leaseKey);
    if (activeLease && activeLease.expiresAt > input.nowMs) {
      return { status: "leased" as const };
    }
    const existing = this.occurrences.get(input.occurrenceRecordKey);
    if (existing && existing.status !== "leased") {
      return { status: "duplicate" as const };
    }
    const attempt = existing ? Number(existing.attempt) + 1 : 1;
    this.leases.set(input.leaseKey, {
      expiresAt: input.leaseExpiresAtMs,
      token: input.leaseToken,
    });
    this.occurrences.set(input.occurrenceRecordKey, {
      attempt,
      configurationRevision: input.configurationRevision,
      leaseTokenDigest: input.leaseTokenDigest,
      monitorId: input.monitorId,
      occurrenceIdentity: input.occurrenceIdentity,
      occurrenceKey: input.occurrenceKey,
      scheduledFor: input.scheduledFor,
      schemaVersion: 1,
      status: "leased",
      updatedAt: input.updatedAt,
    });
    this.due.delete(input.recordKey);
    this.inflightUntil.set(input.recordKey, input.leaseExpiresAtMs);
    return { attempt, status: "claimed" as const };
  }
  async releaseLease(
    input: Parameters<WorkspaceMonitorStoreClient["releaseLease"]>[0],
  ) {
    const lease = this.leases.get(input.leaseKey);
    if (!lease) return true;
    if (lease.token !== input.leaseToken) return false;
    this.leases.delete(input.leaseKey);
    this.inflightUntil.delete(input.recordKey);
    if (input.dueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.dueAtMs);
    return true;
  }
  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    const current = this.values.get(input.recordKey);
    if (!current) return "missing" as const;
    if (current !== input.expectedRaw) return "stale" as const;
    const occurrence = this.occurrences.get(input.occurrenceRecordKey);
    if (!occurrence) return "lease_mismatch" as const;
    if (occurrence.status === "completed") return "already_completed" as const;
    if (
      occurrence.configurationRevision !== input.configurationRevision ||
      occurrence.leaseTokenDigest !== input.leaseTokenDigest ||
      occurrence.status !== "leased" ||
      !this.leases.has(input.leaseKey)
    ) return "stale" as const;
    this.occurrences.set(input.occurrenceRecordKey, {
      ...occurrence,
      status: "completed",
      updatedAt: input.completedAt,
    });
    this.leases.delete(input.leaseKey);
    this.inflightUntil.delete(input.recordKey);
    this.values.set(input.recordKey, input.nextRaw);
    if (input.nextDueAtMs === null) this.due.delete(input.recordKey);
    else this.due.set(input.recordKey, input.nextDueAtMs);
    return "completed" as const;
  }
  async readReplay(input: Parameters<StrategyPackTransactionClient["readReplay"]>[0]) {
    if (this.values.has(input.approvalGuardKey)) return { status: "blocked" as const };
    const mapping = this.values.get(input.mappingKey);
    if (mapping === undefined) return { status: "missing" as const };
    if (mapping !== input.mappingRaw) return { status: "payload_conflict" as const };
    const receipt = this.values.get(input.receiptKey);
    return receipt === undefined
      ? { status: "corrupt" as const }
      : { receiptRaw: receipt, status: "replayed" as const };
  }
  async commitCreate(input: Parameters<StrategyPackTransactionClient["commitCreate"]>[0]) {
    const replay = await this.readReplay(input);
    if (replay.status !== "missing") return replay;
    if (
      (this.values.get(input.registryKey) ?? null) !== input.expectedRegistryRaw ||
      JSON.parse(input.expectedRegistryRaw).revision !== input.expectedRegistryRevision ||
      this.values.has(input.receiptKey) ||
      input.records.some(({ key }) => this.values.has(key)) ||
      input.monitors.some(({ recordKey }) => this.values.has(recordKey))
    ) return { status: "conflict" as const };
    const values = new Map(this.values);
    const indexes = new Map(
      [...this.indexes].map(([key, members]) => [key, new Set(members)]),
    );
    const due = new Map(this.due);
    if (input.nextRegistryRaw !== null) values.set(input.registryKey, input.nextRegistryRaw);
    for (const record of input.records) values.set(record.key, record.raw);
    for (const monitor of input.monitors) {
      values.set(monitor.recordKey, monitor.raw);
      const members = indexes.get(monitor.workspaceIndexKey) ?? new Set<string>();
      members.add(monitor.recordKey);
      indexes.set(monitor.workspaceIndexKey, members);
      if (monitor.dueAtMs !== null) due.set(monitor.recordKey, monitor.dueAtMs);
    }
    values.set(input.mappingKey, input.mappingRaw);
    values.set(input.receiptKey, input.receiptRaw);
    this.values = values;
    this.indexes = indexes;
    this.due = due;
    return { receiptRaw: input.receiptRaw, status: "committed" as const };
  }
  async commitLifecycle(
    _input: Parameters<StrategyPackTransactionClient["commitLifecycle"]>[0],
  ) {
    throw new Error("acceptance_lifecycle_not_expected");
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
  EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "4",
  EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "100",
  EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 31).toString("base64url"),
  EVE_WORKSPACE_STATE_ENABLED: "1",
} as const;
process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example.test";

const routing = {
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread",
};
const acceptanceNow = new Date("2026-08-14T16:00:00.000Z");
mock.timers.enable({ apis: ["Date"], now: acceptanceNow });
const store = new MemoryAcceptanceStore();
const stateReader: WorkspaceStateStoreClient = {
  compareAndSet: async () => false,
  get: (key) => store.get(key),
};
const budget = new MemoryCasStore();
const coverage = new MemoryCasStore();
const findings = new MemoryCreateStore();
const alerts = new MemoryCreateStore();
const ingress = new MemoryIngressStore();
const initial = await getPhotonWorkspaceState(routing, store);
const researchState = await createPhotonWorkspace({
  ...routing,
  expectedRevision: initial.revision,
  name: "Research",
  select: true,
}, store);
const research = researchState.activeWorkspace;
const sourceIngress = (await createPhotonIngressReceipt({
  classification: "ordinary",
  conversationId: `conversation_${"a".repeat(64)}`,
  eventId: "acceptance-create-event",
  now: acceptanceNow,
  ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
}, ingress)).record;
const sourceAssignment = await assignPhotonIngress({
  generation: research.generation,
  ingress: sourceIngress,
  now: acceptanceNow,
  reason: "selected_workspace",
  routingRevision: researchState.revision,
  workspaceId: research.id,
}, ingress);
const ids = [
  "723e4567-e89b-42d3-a456-426614174000",
  "823e4567-e89b-42d3-a456-426614174000",
  "923e4567-e89b-42d3-a456-426614174000",
  "a23e4567-e89b-42d3-a456-426614174000",
];
/*
 * Managed-workspace creation ensures the delivery subscription its monitors
 * name (strategy-pack-service.ts). The real store needs KV credentials this
 * offline acceptance does not provide, so inject an in-memory recorder - like
 * every other client here - and assert the seam fires rather than reaching KV.
 */
const ensuredAlertSubscriptions: Array<{
  ownerId: string;
  subscriptionId: string;
}> = [];
const dependencies = {
  alertDeliverySubscription: async (
    input: { ownerId: string; subscriptionId: string },
  ) => {
    ensuredAlertSubscriptions.push({
      ownerId: input.ownerId,
      subscriptionId: input.subscriptionId,
    });
  },
  capabilityInventory: STRATEGY_PACK_CAPABILITY_INVENTORY,
  catalog: strategyPackCatalog,
  environment,
  idFactory: () => ids.shift() ?? "b23e4567-e89b-42d3-a456-426614174000",
  monitorClient: store,
  observationSink() {},
  stateClient: stateReader,
  transactionClient: store,
  workspaceClient: store,
};
const created = await createStrategyPackWorkspaceFromSelection({
  activateMonitorResourceIds: ["detect-new-s1"],
  configuration: {
    dailyTimes: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  },
  expectedRegistryRevision: researchState.revision,
  name: "IPO Filings",
  now: new Date(acceptanceNow.getTime() + 100),
  packId: "ipo-filings",
  packVersion: "1.0.0",
  ...routing,
  requestIdentity: deriveEveStrategyPackMutationIdentity({
    ingressId: sourceIngress.ingressId,
    operationOrdinal: 0,
    stepId: "step_create_ipo_acceptance",
    turnId: "turn_create_ipo_acceptance",
  }),
  sourceAssignment: {
    generation: sourceAssignment.generation,
    workspaceId: sourceAssignment.workspaceId,
  },
}, dependencies);
assert.equal(created.replayed, false);
assert.equal(sourceAssignment.workspaceId, research.id);
const afterCreate = await getPhotonWorkspaceState(routing, store);
const ipo = afterCreate.activeWorkspace;
assert.equal(ipo.id, created.receipt.targetWorkspaceId);
const ipoScope = authorizeDeploymentWorkspaceStore({
  ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
  workspaceId: ipo.id,
}, environment);
let [monitor] = await listWorkspaceMonitors(ipoScope, store);
assert.ok(monitor);
assert.deepEqual(monitor.schedule, {
  kind: "daily_local",
  times: ["09:00", "16:00"],
  timezone: "America/Vancouver",
});
const createdInspection = await inspectStrategyPackWorkspace({
  scope: ipoScope,
  workspaceGeneration: ipo.generation,
}, {
  catalog: strategyPackCatalog,
  environment,
  hybridSemanticClient: budget,
  monitorClient: store,
  publicSourceAcquisitionClient: budget,
  publicSourceSubscriptionClient: budget,
  stateClient: stateReader,
});
assert.equal(createdInspection.managedMonitors[0]?.lastErrorCode, null);
assert.equal(
  ensuredAlertSubscriptions.length,
  1,
  "creating the managed workspace must ensure exactly one delivery subscription",
);
assert.equal(
  ensuredAlertSubscriptions[0]?.subscriptionId,
  monitor.deliverySubscriptionId,
  "the ensured subscription must be the one the monitor delivers through",
);

const installOnly = await createStrategyPackWorkspaceFromSelection({
  activateMonitorResourceIds: [],
  expectedRegistryRevision: afterCreate.revision,
  name: "IPO Inspect Only",
  now: new Date(acceptanceNow.getTime() + 200),
  packId: "ipo-filings",
  packVersion: "1.0.0",
  ...routing,
  requestIdentity: deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"b".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_install_only_acceptance",
    turnId: "turn_install_only_acceptance",
  }),
  sourceAssignment: { generation: ipo.generation, workspaceId: ipo.id },
}, dependencies);
const installOnlyScope = authorizeDeploymentWorkspaceStore({
  ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
  workspaceId: installOnly.receipt.targetWorkspaceId,
}, environment);
assert.equal((await listWorkspaceMonitors(installOnlyScope, store))[0]?.lifecycleState, "paused");
assert.equal(store.due.size, 1);

let currentState = await getPhotonWorkspaceState(routing, store);
currentState = await selectPhotonWorkspace({
  ...routing,
  expectedRevision: currentState.revision,
  workspaceId: research.id,
}, store);
assert.equal(currentState.activeWorkspace.id, research.id);

const fixtureRoot = new URL("./fixtures/sec-ipo/", import.meta.url);
const initialBody = await readFile(new URL("initial.atom", fixtureRoot), "utf8");
const laterBody = await readFile(new URL("later-s1.atom", fixtureRoot), "utf8");
const amendmentBody = await readFile(new URL("amendment.atom", fixtureRoot), "utf8");
const normalizedLater = normalizeSecIpoFetch({
  body: laterBody,
  contentType: "application/atom+xml",
  finalUrl: SEC_IPO_SOURCE_URL,
  observedAt: "2026-08-15T20:00:00.000Z",
  requestedUrl: SEC_IPO_SOURCE_URL,
  status: 200,
});
const replay = prepareSecIpoAcceptanceReplay({
  identityScope: ipoScope,
  page: normalizedLater,
  targetAccessionNumber: "0001000003-26-000001",
});
assert.equal(replay.predecessor.accessionNumber, "0001000002-26-000001");
assert.equal(replay.checkpoint.watermark, replay.predecessor.updatedAt);
assert.throws(
  () => prepareSecIpoAcceptanceReplay({
    identityScope: ipoScope,
    page: normalizedLater,
    targetAccessionNumber: "0000000000-00-000000",
  }),
  (error) => error instanceof StrategyPackAcceptanceError &&
    error.code === "acceptance_target_absent",
);
assert.throws(
  () => prepareSecIpoAcceptanceReplay({
    identityScope: ipoScope,
    page: normalizedLater,
    targetAccessionNumber: "0001000002-26-000001",
  }),
  (error) => error instanceof StrategyPackAcceptanceError &&
    error.code === "acceptance_target_not_latest",
);

let activeBody = initialBody;
let fetches = 0;
let deliveryCards: Array<{ discussUrl: string; heading: string }> = [];
let prepared: PreparedWorkspaceWorkerRun | null = null;
let tickNow = new Date(monitor.nextOccurrenceAt!);
let claimCalls = 0;
const workerErrors: unknown[] = [];

async function runScheduleTick(input: {
  photonAlerts: boolean;
  workspaceDispatch: boolean;
}) {
  mock.timers.setTime(tickNow.getTime());
  const schedule = createEventTriggerSchedule({
    claimEventTriggers: async () => [],
    claimWorkspaceMonitors: async (claimInput) => {
      claimCalls += 1;
      return claimDueWorkspaceMonitors(
        { ...claimInput, environment },
        store,
      );
    },
    deliverWorkspaceOutcome: async ({ job, outcome }) => {
      const finding = outcome.finding;
      if (!finding) return;
      const alert = await readWorkspaceAlert(job.scope, finding.findingId, alerts);
      assert.ok(alert);
      await deliverWorkspaceAlertToPhoton({
        alert,
        alertClient: alerts,
        monitor: job.monitor,
        now: tickNow,
        pauseMonitor: (pauseInput) => pauseWorkspaceMonitorAfterUncertainAlert(
          pauseInput,
          store,
        ),
        recordRecent: async () => {},
        scope: job.scope,
        send: async (card) => {
          deliveryCards.push({ discussUrl: card.discussUrl, heading: card.heading });
          return { messageId: `message_${deliveryCards.length}` };
        },
        subscription: {
          conversationId: `conversation_${"a".repeat(64)}`,
          destination: "fixture-destination",
          ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
          ...routing,
          subscriptionId: job.monitor.deliverySubscriptionId,
        },
        workspaceClient: store,
      });
    },
    emitRuntimeObservation() {},
    executeEventTrigger: async () => {},
    finishWorkspaceBudget: (job, reservation, result) =>
      finishWorkspaceMonitorDispatchBudget(job, reservation, result, {
        global: budget,
        workspace: budget,
      }),
    getWorkspaceMonitor: (scope, monitorId) =>
      getWorkspaceMonitor(scope, monitorId, store),
    inspectWorkspaceLease: (leaseInput) =>
      inspectWorkspaceMonitorOccurrenceLease(leaseInput, store),
    now: () => tickNow,
    prepareWorkspaceRecovery: (recoveryInput) => prepareWorkspaceWorkerRecovery({
      ...recoveryInput,
      clients: { monitor: store, state: stateReader },
    }),
    prepareWorkspaceWorker: async (workerInput) => {
      prepared = await prepareWorkspaceWorkerRun({
        ...workerInput,
        clients: {
          sourceCoverage: coverage,
          state: stateReader,
          strategyPackCatalog,
        },
        environment,
        now: tickNow,
      });
      return prepared;
    },
    recordWorkspaceFailure: (failureInput) =>
      recordWorkspaceMonitorFailure(failureInput, store),
    recoverWorkspaceOutcome: (recoveryInput) =>
      recoverSecIpoWorkspaceRunForControlPlane({
        ...recoveryInput,
        clients: {
          alert: alerts,
          finding: findings,
          monitor: store,
          sourceCoverage: coverage,
          state: stateReader,
        },
        now: tickNow,
      }),
    releaseWorkspaceLease: (releaseInput) =>
      releaseWorkspaceMonitorLease(releaseInput, store),
    requireWorkspaceOutcome: (workerRun) =>
      requireWorkspaceWorkerOutcome(workerRun, findings),
    reserveWorkspaceBudget: (job, options) =>
      reserveWorkspaceMonitorDispatchBudget(job, {
        ...options,
        clients: { global: budget, state: stateReader, workspace: budget },
        environment,
      }),
    resolveRuntimeFlags: () => ({
      dispatch: input.workspaceDispatch,
      legacyTriggerCreation: false,
      monitorWrites: true,
      paidResearch: false,
      photonAlerts: input.photonAlerts,
      sourceEvents: false,
      state: true,
    }),
    runWorkspaceEvaluator: async ({ prepared: evaluatorPrepared }) => {
      assert.equal(evaluatorPrepared.envelope.runId, prepared?.envelope.runId);
      fetches += 1;
      try {
        await evaluateSecIpoSourceForWorker({
          clients: {
            alert: alerts,
            fetchSource: async (requestedUrl) => ({
              body: activeBody,
              contentType: "application/atom+xml",
              finalUrl: SEC_IPO_SOURCE_URL,
              requestedUrl,
              status: 200,
            }),
            finding: findings,
            monitor: store,
            publishReport: async ({ artifactId }) => ({ artifactId, kind: "report" as const }),
            sourceCoverage: coverage,
            state: stateReader,
          },
          ctx: { session: { auth: { current: evaluatorPrepared.request.auth } } },
          environment,
          now: tickNow,
        });
      } catch (error) {
        workerErrors.push(error);
        throw error;
      }
    },
  });
  assert.ok("run" in schedule && schedule.run);
  const waiters: Promise<unknown>[] = [];
  schedule.run({
    appAuth: {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    to: (() => { throw new Error("legacy_delivery_not_expected"); }) as ScheduleToFn,
    waitUntil(task) { waiters.push(task); },
  });
  await Promise.all(waiters);
}

await runScheduleTick({ photonAlerts: true, workspaceDispatch: true });
assert.equal(fetches, 1);
assert.deepEqual(workerErrors, []);
assert.equal(deliveryCards.length, 0);
monitor = (await getWorkspaceMonitor(ipoScope, monitor.monitorId, store))!;
assert.notEqual(monitor.sourceCheckpoint.watermark, null);

activeBody = laterBody;
tickNow = new Date(monitor.nextOccurrenceAt!);
await runScheduleTick({ photonAlerts: true, workspaceDispatch: true });
assert.equal(fetches, 2);
assert.equal(
  deliveryCards.length,
  1,
  workerErrors.map((error) => error instanceof Error
    ? `${error.name}:${error.message}`
    : typeof error).join(","),
);
assert.match(deliveryCards[0]!.heading, /IPO Filings/u);
assert.equal((await getPhotonWorkspaceState(routing, store)).activeWorkspace.id, research.id);

const fragment = new URL(deliveryCards[0]!.discussUrl).hash.slice(1);
const [alertToken] = fragment.split(".");
assert.ok(alertToken);
const discuss = await applyPhotonAlertDiscussAction(alertToken, store);
assert.equal(discuss.status, "applied");
const discussedState = await getPhotonWorkspaceState(routing, store);
assert.equal(discussedState.activeWorkspace.id, ipo.id);
const nextIngressInput = {
  classification: "ordinary" as const,
  conversationId: `conversation_${"a".repeat(64)}`,
  eventId: "acceptance-next-message",
  now: new Date(tickNow.getTime() + 1_000),
  ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
};
const nextIngress = await createPhotonIngressReceipt(nextIngressInput, ingress);
const duplicateIngress = await createPhotonIngressReceipt(nextIngressInput, ingress);
assert.equal(nextIngress.created, true);
assert.equal(duplicateIngress.created, false);
const nextAssignment = await assignPhotonIngress({
  generation: discussedState.activeWorkspace.generation,
  ingress: nextIngress.record,
  now: nextIngressInput.now,
  reason: "selected_workspace",
  routingRevision: discussedState.revision,
  workspaceId: discussedState.activeWorkspace.id,
}, ingress);
assert.equal(nextAssignment.workspaceId, ipo.id);
const consumed = await consumePhotonPendingAlertContext({
  ...routing,
  workspaceId: nextAssignment.workspaceId,
}, store);
assert.equal(consumed.context?.workspaceId, ipo.id);

monitor = (await getWorkspaceMonitor(ipoScope, monitor.monitorId, store))!;
activeBody = amendmentBody;
tickNow = new Date(monitor.nextOccurrenceAt!);
await runScheduleTick({ photonAlerts: false, workspaceDispatch: true });
assert.equal(fetches, 3);
assert.equal(deliveryCards.length, 1);
const stagedAlerts = [...alerts.values.values()].filter((raw) =>
  JSON.parse(raw).recordType === "workspace_alert"
);
assert.equal(stagedAlerts.length, 2);

const claimsBeforeRollback = claimCalls;
await runScheduleTick({ photonAlerts: false, workspaceDispatch: false });
assert.equal(claimCalls, claimsBeforeRollback);
assert.equal(fetches, 3);
const ownerTurn = await createPhotonIngressReceipt({
  ...nextIngressInput,
  eventId: "acceptance-owner-turn-during-rollback",
  now: new Date(tickNow.getTime() + 2_000),
}, ingress);
assert.equal(ownerTurn.created, true);
const ownerTurnAssignment = await assignPhotonIngress({
  generation: consumed.state.activeWorkspace.generation,
  ingress: ownerTurn.record,
  now: new Date(tickNow.getTime() + 2_000),
  reason: "selected_workspace",
  routingRevision: consumed.state.revision,
  workspaceId: consumed.state.activeWorkspace.id,
}, ingress);
assert.equal(ownerTurnAssignment.workspaceId, ipo.id);

const strategyBeforeKillSwitches = await readWorkspaceDocument(
  "strategy",
  ipoScope,
  stateReader,
);
const runtimeOff = { ...environment, EVE_STRATEGY_PACK_RUNTIME_ENABLED: "0" };
assert.equal((await inspectStrategyPackWorkspace({
  scope: ipoScope,
  workspaceGeneration: consumed.state.activeWorkspace.generation,
}, {
  catalog: strategyPackCatalog,
  environment: runtimeOff,
  hybridSemanticClient: budget,
  monitorClient: store,
  publicSourceAcquisitionClient: budget,
  publicSourceSubscriptionClient: budget,
  stateClient: stateReader,
})).state, "unavailable");
assert.throws(
  () => listStrategyPacks({
    environment: { ...environment, EVE_STRATEGY_PACK_CATALOG_ENABLED: "0" },
  }),
  (error) => error instanceof StrategyPackServiceError &&
    error.code === "strategy_pack_catalog_disabled",
);
assert.equal(resolveStrategyPackFlags({
  ...environment,
  EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "0",
}).managedDispatch, false);
assert.deepEqual(
  await readWorkspaceDocument("strategy", ipoScope, stateReader),
  strategyBeforeKillSwitches,
);
assert.equal(stagedAlerts.length, 2);

const inspection = await inspectStrategyPackWorkspace({
  scope: ipoScope,
  workspaceGeneration: consumed.state.activeWorkspace.generation,
}, {
  catalog: strategyPackCatalog,
  environment,
  hybridSemanticClient: budget,
  monitorClient: store,
  publicSourceAcquisitionClient: budget,
  publicSourceSubscriptionClient: budget,
  stateClient: stateReader,
});
assert.equal(inspection.state, "active");
assert.equal(inspection.pack?.id, "ipo-filings");
assert.equal(inspection.managedMonitors[0]?.lifecycleState, "enabled");
assert.equal(inspection.managedMonitors[0]?.lastErrorCode, null);

const pack = strategyPackCatalog.resolve({ id: "ipo-filings", version: "1.0.0" });
assert.ok(pack);
assert.match(strategyPackCatalog.catalogDigest, /^[a-f0-9]{64}$/u);
console.info(JSON.stringify({
  catalogDigest: strategyPackCatalog.catalogDigest,
  deliveryCount: deliveryCards.length,
  duplicateIngressSuppressed: true,
  fetchCount: fetches,
  findingCount: [...findings.values.values()].filter((raw) =>
    JSON.parse(raw).recordType === "workspace_run_outcome"
  ).length,
  installOnlyFetchCount: 0,
  localOnly: true,
  packDigest: pack.contentDigest,
  rollbackPreservedDurableIngress: true,
  stagedAlertCount: stagedAlerts.length,
  verificationDigest: createHash("sha256").update(JSON.stringify({
    catalog: strategyPackCatalog.catalogDigest,
    pack: pack.contentDigest,
    schedule: monitor.schedule,
  })).digest("hex"),
}));
console.info("Strategy-pack local vertical acceptance verification passed.");
