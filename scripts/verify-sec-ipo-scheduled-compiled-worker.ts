import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { MessageStreamEvent } from "eve/client";
import type { ScheduleToFn } from "eve/schedules";
import { createJiti } from "jiti";

import type { OfficialPublicSourceResponse } from "../agent/tools/fetch_public_source";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import type { WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import { readWorkspaceBudgetLedger } from "../agent/lib/workspace-budget-ledger";
import {
  finishWorkspaceMonitorDispatchBudget,
  readGlobalDispatchBudgetLedger,
  reserveWorkspaceMonitorDispatchBudget,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import { startWorkspaceWorkerTask } from "../agent/lib/eve-workspace-worker-runtime";
import type { WorkspaceFindingStoreClient } from "../agent/lib/workspace-finding-store";
import {
  claimDueWorkspaceMonitors,
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  recordWorkspaceMonitorFailure,
  releaseWorkspaceMonitorLease,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
  updateWorkspaceMonitor,
} from "../agent/lib/workspace-monitor-store";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  IPO_FILINGS_CAPABILITY_MANIFEST,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import {
  recoverSecIpoWorkspaceRunForControlPlane,
  type SecIpoWorkspaceWorkerClients,
} from "../agent/lib/sec-ipo-workspace-worker";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorkerRun,
  requireWorkspaceWorkerOutcome,
} from "../agent/lib/workspace-worker-runner";
import { installSecIpoWorkspaceWorkerFixtureClients } from "../agent/lib/workspace-worker-test-fixtures";
import { createEventTriggerSchedule } from "../agent/schedules/event-triggers";

class MemoryCasStore
  implements
    WorkspaceBudgetLedgerClient,
    WorkspaceGlobalBudgetClient,
    WorkspaceSourceCoverageClient,
    WorkspaceStateStoreClient
{
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryCreateStore
  implements WorkspaceAlertStoreClient, WorkspaceFindingStoreClient {
  failNextRecordType: string | null = null;
  nextGetValue: unknown = undefined;
  readonly values = new Map<string, string>();

  async createOutcomeWithIdentityClaims(input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0]) {
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

  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async createOrRead(key: string, value: string) {
    const recordType = (JSON.parse(value) as { recordType?: unknown }).recordType;
    if (recordType === this.failNextRecordType) {
      this.failNextRecordType = null;
      throw new Error("fixture_create_interrupted");
    }
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }

  async get(key: string) {
    if (this.nextGetValue !== undefined) {
      const value = this.nextGetValue;
      this.nextGetValue = undefined;
      return value;
    }
    return this.values.get(key) ?? null;
  }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  completeCalls = 0;
  readonly completedOccurrences = new Set<string>();
  readonly dueAt = new Map<string, number>();
  readonly inflightUntil = new Map<string, number>();
  readonly leases = new Map<string, { expiresAt: number; token: string }>();
  readonly occurrences = new Map<string, Record<string, unknown>>();
  readonly values = new Map<string, string>();
  dueMonitorId: string | null = null;

  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    if (this.completedOccurrences.has(input.occurrenceRecordKey)) {
      return "already_completed" as const;
    }
    const current = this.values.get(input.recordKey);
    if (!current) return "missing" as const;
    if (current !== input.expectedRaw) return "stale" as const;
    const occurrence = this.occurrences.get(input.occurrenceRecordKey);
    if (occurrence) {
      if (
        occurrence.configurationRevision !== input.configurationRevision ||
        occurrence.leaseTokenDigest !== input.leaseTokenDigest
      ) {
        return "stale" as const;
      }
      if (occurrence.status !== "leased" || !this.leases.has(input.leaseKey)) {
        return "lease_mismatch" as const;
      }
      this.occurrences.set(input.occurrenceRecordKey, {
        ...occurrence,
        status: "completed",
        updatedAt: input.completedAt,
      });
      this.leases.delete(input.leaseKey);
      this.inflightUntil.delete(input.recordKey);
    }
    this.values.set(input.recordKey, input.nextRaw);
    if (input.nextDueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.nextDueAtMs);
    this.completeCalls += 1;
    this.completedOccurrences.add(input.occurrenceRecordKey);
    return "completed" as const;
  }

  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    if (input.dueAtMs !== null) this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async get(key: string) {
    const lease = this.leases.get(key);
    if (lease) return lease.token;
    const occurrence = this.occurrences.get(key);
    if (occurrence) return JSON.stringify(occurrence);
    return this.values.get(key) ?? null;
  }

  async claim(input: Parameters<WorkspaceMonitorStoreClient["claim"]>[0]) {
    const current = this.values.get(input.recordKey);
    if (!current) return { status: "missing" as const };
    const monitor = JSON.parse(current) as WorkspaceMonitor;
    if (monitor.configurationRevision !== input.configurationRevision) {
      return { status: "stale" as const };
    }
    if (monitor.lifecycleState !== "enabled" || !monitor.nextOccurrenceAt) {
      this.dueAt.delete(input.recordKey);
      return { status: "not_due" as const };
    }
    if (Date.parse(monitor.nextOccurrenceAt) > input.nowMs) {
      return { status: "not_due" as const };
    }
    const lease = this.leases.get(input.leaseKey);
    if (lease && lease.expiresAt > input.nowMs) {
      return { status: "leased" as const };
    }
    if (lease) this.leases.delete(input.leaseKey);
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
    this.dueAt.delete(input.recordKey);
    this.inflightUntil.set(input.recordKey, input.leaseExpiresAtMs);
    return { attempt, status: "claimed" as const };
  }

  async list(): Promise<unknown[]> {
    return [...this.values.values()];
  }

  async listDue(input: Parameters<WorkspaceMonitorStoreClient["listDue"]>[0]) {
    for (const [recordKey, expiresAt] of this.inflightUntil) {
      if (expiresAt <= input.nowMs) {
        this.inflightUntil.delete(recordKey);
        this.dueAt.set(recordKey, input.nowMs);
      }
    }
    for (const [leaseKey, lease] of this.leases) {
      if (lease.expiresAt <= input.nowMs) this.leases.delete(leaseKey);
    }
    return [...this.dueAt.entries()]
      .filter(([, dueAt]) => dueAt <= input.nowMs)
      .filter(([recordKey]) => {
        if (!this.dueMonitorId) return true;
        const raw = this.values.get(recordKey);
        return raw
          ? (JSON.parse(raw) as WorkspaceMonitor).monitorId === this.dueMonitorId
          : false;
      })
      .sort((left, right) => left[1] - right[1])
      .slice(0, input.limit)
      .map(([recordKey]) => ({
        raw: this.values.get(recordKey) ?? null,
        recordKey,
      }));
  }

  async releaseLease(input: Parameters<WorkspaceMonitorStoreClient["releaseLease"]>[0]) {
    const lease = this.leases.get(input.leaseKey);
    if (!lease) return true;
    if (lease.token !== input.leaseToken) return false;
    this.leases.delete(input.leaseKey);
    this.inflightUntil.delete(input.recordKey);
    if (input.dueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    if (input.dueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture",
  EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "4",
  EVE_WORKSPACE_GLOBAL_RUNS_PER_DAY: "100",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 31).toString("base64url"),
  KV_REST_API_TOKEN: "fixture",
  KV_REST_API_URL: "https://fixture.invalid",
  REDIS_URL: "redis://fixture.invalid:6379",
} as const;

Object.assign(process.env, environment, {
  EVE_MOCK_AUTHORED_MODELS: "1",
  NODE_ENV: "test",
});

const fixtureRoot = new URL("./fixtures/sec-ipo/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, fixtureRoot), "utf8");
const fixtureBodies = {
  amendment: await fixture("amendment.atom"),
  initial: await fixture("initial.atom"),
  later: await fixture("later-s1.atom"),
  malformed: await fixture("malformed.atom"),
  sameS1LaterUpdated: await fixture("same-s1-later-updated.atom"),
};
const state = new MemoryCasStore();
const coverage = new MemoryCasStore();
const budget = new MemoryCasStore();
const findings = new MemoryCreateStore();
const alerts = new MemoryCreateStore();
const monitors = new MemoryMonitorStore();
let activeFetch: (requestedUrl: string) => Promise<OfficialPublicSourceResponse> =
  async () => {
    throw new Error("sec_fixture_fetch_not_configured");
  };
let fetchCount = 0;
const workerClients: SecIpoWorkspaceWorkerClients = {
  alert: alerts,
  async fetchSource(requestedUrl) {
    fetchCount += 1;
    return activeFetch(requestedUrl);
  },
  finding: findings,
  monitor: monitors,
  sourceCoverage: coverage,
  state,
};

async function startFixtureRpc(): Promise<{
  close: () => Promise<void>;
  token: string;
  url: string;
}> {
  const token = Buffer.alloc(32, 47).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        args: unknown[];
        method: string;
        namespace: keyof SecIpoWorkspaceWorkerClients;
      };
      let result: unknown;
      if (payload.namespace === "fetchSource") {
        assert.equal(payload.method, "fetchSource");
        result = await workerClients.fetchSource!(String(payload.args[0]));
      } else {
        const target = workerClients[payload.namespace];
        if (!target || typeof target !== "object") {
          throw new Error("fixture_rpc_namespace_invalid");
        }
        const method = Reflect.get(target, payload.method) as unknown;
        if (typeof method !== "function") {
          throw new Error("fixture_rpc_method_invalid");
        }
        result = await Reflect.apply(method, target, payload.args);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: error instanceof Error ? error.message : "fixture_rpc_failed",
      }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    token,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function setupWorkspace(workspaceId: string): Promise<{
  monitor: WorkspaceMonitor;
  scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>;
}> {
  const scope = authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId },
    environment,
  );
  const createdAt = new Date("2026-08-14T16:00:00.000Z");
  await writeWorkspaceDocument("brief", {
    expectedRevision: 0,
    now: createdAt,
    scope,
    value: {
      currentFindingsSummary: "",
      goal: "Track official public SEC S-1 filings.",
      lastMaterialChange: "",
      openQuestions: [],
      promotedFacts: [],
      sourcePolicy: {
        allowedSourceIds: [SEC_IPO_SOURCE_ID],
        maximumAccessClassification: "public",
      },
      strategyConfigurationRevision: 1,
      thesis: "",
      watchlist: [],
    },
  }, state);
  await writeWorkspaceDocument("strategy", {
    expectedRevision: 0,
    now: createdAt,
    scope,
    value: { configuration: {}, strategyPack: null },
  }, state);
  await writeWorkspaceDocument("capabilities", {
    expectedRevision: 0,
    now: createdAt,
    scope,
    value: IPO_FILINGS_CAPABILITY_MANIFEST,
  }, state);
  await writeWorkspaceDocument("budget", {
    expectedRevision: 0,
    now: createdAt,
    scope,
    value: {
      effectiveAt: createdAt.toISOString(),
      maximumConcurrentWorkers: 1,
      maximumInputTokensPerDay: 80_000,
      maximumInputTokensPerRun: 10_000,
      maximumOutputTokensPerDay: 20_000,
      maximumOutputTokensPerRun: 2_000,
      maximumPaidPerCall: null,
      maximumPaidPerDay: null,
      maximumPaidPerMonth: null,
      maximumScheduledRunsPerDay: 20,
      ownerTimezone: "America/Vancouver",
      unknownPriceFallbackCeiling: "0",
    },
  }, state);
  const monitor = await createWorkspaceMonitor({
    deliverySubscriptionId: `subscription.${workspaceId}`,
    idempotencyKey: `monitor.${workspaceId}`,
    instruction:
      `Call ${EVALUATE_SEC_IPO_SOURCE_TOOL_ID} exactly once for the configured SEC source.`,
    name: "IPO Filings",
    nextOccurrenceAt: "2026-08-14T17:00:00.000Z",
    now: createdAt,
    requiredCapabilityIds: [EVALUATE_SEC_IPO_SOURCE_TOOL_ID],
    schedule: {
      anchor: createdAt.toISOString(),
      everyMinutes: 60,
      kind: "interval",
    },
    scope,
    sources: [{
      accessClassification: "public",
      canonicalUrl: SEC_IPO_SOURCE_URL,
      origin: "https://www.sec.gov",
      sourceId: SEC_IPO_SOURCE_ID,
    }],
    tighteningLimits: {
      inputTokensPerRun: 10_000,
      outputTokensPerRun: 2_000,
      paidPerRun: null,
    },
  }, monitors);
  return { monitor, scope };
}

let runSequence = 0;
function claim(input: {
  monitor: WorkspaceMonitor;
  now: Date;
  scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>;
}): ClaimedWorkspaceMonitor {
  runSequence += 1;
  const occurrenceKey = runSequence.toString(16).padStart(64, "0");
  return {
    leaseExpiresAt: new Date(input.now.getTime() + 30 * 60_000).toISOString(),
    leaseToken: `lease-${runSequence}`,
    monitor: input.monitor,
    occurrence: {
      attempt: 1,
      configurationRevision: input.monitor.configurationRevision,
      leaseTokenDigest: runSequence.toString(16).padStart(64, "a").slice(-64),
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
  };
}

function fetchResponse(
  body: string,
  patch: Partial<OfficialPublicSourceResponse> = {},
) {
  return async (requestedUrl: string): Promise<OfficialPublicSourceResponse> => {
    assert.equal(requestedUrl, SEC_IPO_SOURCE_URL);
    return {
      body,
      contentType: "application/atom+xml; charset=UTF-8",
      finalUrl: SEC_IPO_SOURCE_URL,
      requestedUrl: SEC_IPO_SOURCE_URL,
      status: 200,
      ...patch,
    };
  };
}

type DispatchEvidence = {
  events: MessageStreamEvent[];
  fetches: number;
};
let pendingClaim: ClaimedWorkspaceMonitor | null = null;
let eventCapture: Promise<MessageStreamEvent[]> | null = null;
let workspaceWorkerStarts = 0;
let workspaceBudgetReservations = 0;
let workspaceBudgetEnvironment: NodeJS.ProcessEnv = environment;
const schedule = createEventTriggerSchedule({
  claimEventTriggers: async () => [],
  claimWorkspaceMonitors: async () => {
    const selected = pendingClaim;
    pendingClaim = null;
    return selected ? [selected] : [];
  },
  finishWorkspaceBudget: (job, reservation, input) =>
    finishWorkspaceMonitorDispatchBudget(job, reservation, input, {
      global: budget,
      workspace: budget,
    }),
  getWorkspaceMonitor: (scope, monitorId) =>
    getWorkspaceMonitor(scope, monitorId, monitors),
  inspectWorkspaceLease: (input) =>
    inspectWorkspaceMonitorOccurrenceLease(input, monitors),
  now: () => verificationNow,
  prepareWorkspaceRecovery: (input) =>
    prepareWorkspaceWorkerRecovery({
      ...input,
      clients: { monitor: monitors, state },
    }),
  prepareWorkspaceWorker: (input) => prepareWorkspaceWorkerRun({
    ...input,
    clients: { sourceCoverage: coverage, state },
    environment,
    now: verificationNow,
  }),
  recordWorkspaceFailure: (input) =>
    recordWorkspaceMonitorFailure(input, monitors),
  recoverWorkspaceOutcome: (input) =>
    recoverSecIpoWorkspaceRunForControlPlane({
      ...input,
      clients: workerClients,
      now: verificationNow,
    }),
  releaseWorkspaceLease: (input) =>
    releaseWorkspaceMonitorLease(input, monitors),
  requireWorkspaceOutcome: (prepared) =>
    requireWorkspaceWorkerOutcome(prepared, findings),
  reserveWorkspaceBudget: (job, options) => {
    workspaceBudgetReservations += 1;
    return reserveWorkspaceMonitorDispatchBudget(job, {
      ...options,
      clients: { global: budget, state, workspace: budget },
      environment: workspaceBudgetEnvironment,
    });
  },
  resolveRuntimeFlags: () => ({
    dispatch: true,
    legacyTriggerCreation: false,
    monitorWrites: true,
    paidResearch: false,
    photonAlerts: false,
    sourceEvents: false,
    state: true,
  }),
  startWorkspaceWorker: async (request) => {
    workspaceWorkerStarts += 1;
    const session = await startWorkspaceWorkerTask(request);
    const [scheduleEvents, observedEvents] = session.events.tee();
    eventCapture = (async () => {
      const captured: MessageStreamEvent[] = [];
      for await (const event of observedEvents) captured.push(event);
      return captured;
    })();
    return { ...session, events: scheduleEvents };
  },
});
let verificationNow = new Date();

async function alignMonitorForProductionClaim(input: {
  monitor: WorkspaceMonitor;
  scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>;
}): Promise<WorkspaceMonitor> {
  const scheduledFor = new Date(verificationNow.getTime() - 60_000).toISOString();
  return updateWorkspaceMonitor({
    expectedRevision: input.monitor.configurationRevision,
    monitorId: input.monitor.monitorId,
    now: verificationNow,
    patch: {
      nextOccurrenceAt: scheduledFor,
      schedule: {
        anchor: scheduledFor,
        everyMinutes: 360,
        kind: "interval",
      },
    },
    scope: input.scope,
  }, monitors);
}

async function claimProductionOccurrence(
  monitorId: string,
): Promise<ClaimedWorkspaceMonitor> {
  monitors.dueMonitorId = monitorId;
  try {
    const jobs = await claimDueWorkspaceMonitors({
      environment,
      leaseForMs: 30 * 60_000,
      limit: 10,
      now: verificationNow,
      recoveryWindowMs: 6 * 60 * 60_000,
    }, monitors);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.monitor.monitorId, monitorId);
    return jobs[0]!;
  } finally {
    monitors.dueMonitorId = null;
  }
}

async function dispatch(
  job: ClaimedWorkspaceMonitor,
  fetchSource: (requestedUrl: string) => Promise<OfficialPublicSourceResponse>,
): Promise<DispatchEvidence> {
  pendingClaim = job;
  activeFetch = fetchSource;
  eventCapture = null;
  const fetchesBefore = fetchCount;
  const waiters: Promise<unknown>[] = [];
  if (!("run" in schedule) || !schedule.run) {
    throw new Error("compiled_schedule_run_missing");
  }
  schedule.run({
    appAuth: {
      attributes: {},
      authenticator: "app",
      principalId: "eve:app",
      principalType: "runtime",
    },
    to: (() => {
      throw new Error("legacy_schedule_delivery_not_expected");
    }) as ScheduleToFn,
    waitUntil(task) {
      waiters.push(task);
    },
  });
  assert.equal(waiters.length, 1);
  await Promise.all(waiters);
  const events = eventCapture ? await eventCapture : [];
  return { events, fetches: fetchCount - fetchesBefore };
}

async function runCompiledWorkspaceWorkerWithoutSchedulerTail(
  request: Parameters<typeof startWorkspaceWorkerTask>[0],
  fetchSource: (requestedUrl: string) => Promise<OfficialPublicSourceResponse>,
): Promise<DispatchEvidence> {
  activeFetch = fetchSource;
  const fetchesBefore = fetchCount;
  const session = await startWorkspaceWorkerTask(request);
  const events: MessageStreamEvent[] = [];
  for await (const event of session.events) events.push(event);
  return { events, fetches: fetchCount - fetchesBefore };
}

function assertCompiledEvaluatorEvents(evidence: DispatchEvidence): void {
  const requestedToolNames = evidence.events.flatMap((event) =>
    event.type === "actions.requested"
      ? event.data.actions.flatMap((action) =>
          action.kind === "tool-call" ? [action.toolName] : [],
        )
      : [],
  );
  assert.deepEqual(requestedToolNames, [EVALUATE_SEC_IPO_SOURCE_TOOL_ID]);
  const evaluatorResult = evidence.events.find((event) =>
    event.type === "action.result" &&
    event.data.result.kind === "tool-result" &&
    event.data.result.toolName === EVALUATE_SEC_IPO_SOURCE_TOOL_ID
  );
  assert.ok(evaluatorResult, "compiled evaluator result was not emitted");
  assert.notEqual(
    evaluatorResult.data.result.isError,
    true,
    JSON.stringify(evaluatorResult.data.result),
  );
  assert.ok(evidence.events.some((event) => event.type === "session.completed"));
}

function storedRecords(store: MemoryCreateStore, recordType: string) {
  return [...store.values.values()]
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((record) => record.recordType === recordType);
}

function storedFindings(): Record<string, unknown>[] {
  return storedRecords(findings, "workspace_run_outcome").flatMap((record) =>
    record.finding && typeof record.finding === "object"
      ? [record.finding as Record<string, unknown>]
      : []
  );
}

const appRoot = process.cwd();
const eveEntry = import.meta.resolve("eve");
const [
  { compileAgent },
  { withBundledCompiledArtifacts },
  { createWorld },
  { setWorld },
  { WorkflowBundleBuilder },
  { bundleWorkflowStepRegistrations },
  { writeCompiledArtifactsFiles },
  { resolvePackageRoot, resolveWorkflowModulePath },
  { deriveEveWorkflowQueuePrefix },
] = await Promise.all([
  import(new URL("./compiler/compile-agent.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/compiler/compile-agent.js")
  >,
  import(new URL("./runtime/loaders/bundled-artifacts.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/runtime/loaders/bundled-artifacts.js")
  >,
  import(new URL("./compiled/@workflow/world-local/index.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/compiled/@workflow/world-local/index.js")
  >,
  import(new URL("./internal/workflow/runtime.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/workflow/runtime.js")
  >,
  import(new URL("./internal/workflow-bundle/builder.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/workflow-bundle/builder.js")
  >,
  import(new URL("./internal/workflow-bundle/builder-support.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/workflow-bundle/builder-support.js")
  >,
  import(new URL("./internal/application/compiled-artifacts.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/application/compiled-artifacts.js")
  >,
  import(new URL("./internal/application/package.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/application/package.js")
  >,
  import(new URL("./internal/workflow/queue-namespace.js", eveEntry).href) as Promise<
    typeof import("../node_modules/eve/dist/src/internal/workflow/queue-namespace.js")
  >,
]);
const compilation = await compileAgent({ startPath: appRoot });
const jiti = createJiti(import.meta.url, { interopDefault: false });
const moduleMapModule = await jiti.import<{ moduleMap: unknown }>(
  pathToFileURL(join(appRoot, ".eve/compile/module-map.mjs")).href,
);

const uninstallFixtureClients = installSecIpoWorkspaceWorkerFixtureClients(
  workerClients,
);
const fixtureRpc = await startFixtureRpc();
process.env.EVE_WORKSPACE_WORKER_FIXTURE_RPC_TOKEN = fixtureRpc.token;
process.env.EVE_WORKSPACE_WORKER_FIXTURE_RPC_URL = fixtureRpc.url;
const workflowDataDirectory = await mkdtemp(
  join(tmpdir(), "adaam-sec-ipo-compiled-world-"),
);
const workflowBuildDirectory = await mkdtemp(
  join(tmpdir(), "adaam-sec-ipo-workflow-bundle-"),
);
const generatedArtifacts = await writeCompiledArtifactsFiles({
  compileResult: compilation,
  defaultWorkflowWorld: "local",
  outDir: join(workflowBuildDirectory, "artifacts"),
});
const workflowBundlePath = join(workflowBuildDirectory, "workflows.mjs");
const workflowStepsPath = join(workflowBuildDirectory, "steps.mjs");

class LocalAcceptanceWorkflowBundleBuilder extends WorkflowBundleBuilder {
  async buildStepRegistrations(
    outfile: string,
    compiledArtifactsBootstrapPath: string,
  ): Promise<void> {
    const inputFiles = await this.getInputFiles();
    const tsconfigPath = await this.findTsConfigPath();
    const discoveredEntries = await this.discoverEntries(
      inputFiles,
      workflowBuildDirectory,
      tsconfigPath,
    );
    await bundleWorkflowStepRegistrations({
      builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
      discoveredEntries: {
        ...discoveredEntries,
        discoveredSerdeFiles: [
          ...discoveredEntries.discoveredSerdeFiles,
          compiledArtifactsBootstrapPath,
        ],
      },
      outfile,
      projectRoot: this.transformProjectRoot,
      ...(tsconfigPath ? { tsconfigPath } : {}),
      workingDir: this.config.workingDir,
    });
  }
}

const workflowBundleBuilder = new LocalAcceptanceWorkflowBundleBuilder({
  agentName: compilation.manifest.config.name,
  appRoot,
  compiledArtifactsBootstrapPath: generatedArtifacts.bootstrapPath,
  outDir: join(workflowBuildDirectory, "cache"),
  rootDir: resolvePackageRoot(),
  watch: false,
});
await workflowBundleBuilder.build({
  nitroStepOutfile: workflowStepsPath,
  nitroWorkflowOutfile: workflowBundlePath,
});
await workflowBundleBuilder.buildStepRegistrations(
  workflowStepsPath,
  generatedArtifacts.bootstrapPath,
);
const workflowHandler = await import(pathToFileURL(workflowBundlePath).href) as {
  POST: (request: Request) => Promise<Response>;
};
const workflowWorld = createWorld({
  dataDir: workflowDataDirectory,
  recoverActiveRuns: false,
  streamFlushIntervalMs: 1,
  tag: "adaam-sec-ipo-compiled-fixture",
});
workflowWorld.registerHandler(
  deriveEveWorkflowQueuePrefix(compilation.manifest.config.name),
  workflowHandler.POST,
);
setWorld(workflowWorld);
await workflowWorld.start();
try {
  await withBundledCompiledArtifacts({
    manifest: compilation.manifest,
    metadata: compilation.metadata,
    moduleMap: moduleMapModule.moduleMap as Parameters<
      typeof withBundledCompiledArtifacts
    >[0]["moduleMap"],
    sessionId: "sec-ipo-scheduled-compiled-worker",
  }, async () => {
    const workspaceA = await setupWorkspace(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    let monitorA = workspaceA.monitor;

    const baselineJob = claim({ monitor: monitorA, now: verificationNow, scope: workspaceA.scope });
    const baseline = await dispatch(
      baselineJob,
      fetchResponse(fixtureBodies.initial),
    );
    assert.equal(baseline.fetches, 1);
    assertCompiledEvaluatorEvents(baseline);
    assert.equal(storedRecords(alerts, "workspace_alert").length, 0);
    assert.equal(storedFindings().length, 0);
    assert.equal(storedRecords(findings, "workspace_run_outcome").length, 1);

    monitorA = (await getWorkspaceMonitor(
      workspaceA.scope,
      monitorA.monitorId,
      monitors,
    ))!;
    const later = await dispatch(
      claim({ monitor: monitorA, now: verificationNow, scope: workspaceA.scope }),
      fetchResponse(fixtureBodies.later),
    );
    assert.equal(later.fetches, 1);
    assertCompiledEvaluatorEvents(later);
    const firstFinding = storedFindings().at(-1);
    assert.ok(firstFinding);
    const firstFacts = firstFinding.facts as Array<Record<string, unknown>>;
    assert.equal(firstFacts.length, 1);
    assert.equal(firstFacts[0]?.kind, "sec_ipo_filing");
    assert.equal(firstFacts[0]?.classification, "new_registration");
    assert.equal(firstFacts[0]?.accessionNumber, "0001000003-26-000001");
    assert.equal(storedRecords(alerts, "workspace_alert").length, 1);

    monitorA = (await getWorkspaceMonitor(
      workspaceA.scope,
      monitorA.monitorId,
      monitors,
    ))!;
    const amendment = await dispatch(
      claim({ monitor: monitorA, now: verificationNow, scope: workspaceA.scope }),
      fetchResponse(fixtureBodies.amendment),
    );
    assertCompiledEvaluatorEvents(amendment);
    const amendmentFinding = storedFindings().at(-1)!;
    const amendmentFact = (amendmentFinding.facts as Array<Record<string, unknown>>)[0]!;
    assert.equal(amendmentFact.classification, "amendment");
    assert.equal(amendmentFact.registrationIdentity, firstFacts[0]?.registrationIdentity);
    assert.notEqual(amendmentFact.amendmentIdentity, null);
    assert.equal(storedRecords(alerts, "workspace_alert").length, 2);

    monitorA = (await getWorkspaceMonitor(
      workspaceA.scope,
      monitorA.monitorId,
      monitors,
    ))!;
    const sameFilingOccurrence = monitorA.nextOccurrenceAt;
    const completionsBeforeSameFiling = monitors.completeCalls;
    const sameFiling = await dispatch(
      claim({ monitor: monitorA, now: verificationNow, scope: workspaceA.scope }),
      fetchResponse(fixtureBodies.amendment),
    );
    assertCompiledEvaluatorEvents(sameFiling);
    assert.equal(storedFindings().length, 2);
    assert.equal(storedRecords(alerts, "workspace_alert").length, 2);
    monitorA = (await getWorkspaceMonitor(
      workspaceA.scope,
      monitorA.monitorId,
      monitors,
    ))!;
    assert.notEqual(monitorA.nextOccurrenceAt, sameFilingOccurrence);
    assert.equal(monitors.completeCalls, completionsBeforeSameFiling + 1);

    const laterUpdatedOccurrence = monitorA.nextOccurrenceAt;
    const findingsBeforeLaterUpdated = storedFindings().length;
    const alertsBeforeLaterUpdated = storedRecords(alerts, "workspace_alert").length;
    const outcomesBeforeLaterUpdated = storedRecords(
      findings,
      "workspace_run_outcome",
    ).length;
    const completionsBeforeLaterUpdated = monitors.completeCalls;
    const laterUpdated = await dispatch(
      claim({ monitor: monitorA, now: verificationNow, scope: workspaceA.scope }),
      fetchResponse(fixtureBodies.sameS1LaterUpdated),
    );
    assert.equal(laterUpdated.fetches, 1);
    assertCompiledEvaluatorEvents(laterUpdated);
    assert.equal(storedFindings().length, findingsBeforeLaterUpdated);
    assert.equal(
      storedRecords(alerts, "workspace_alert").length,
      alertsBeforeLaterUpdated,
    );
    const outcomesAfterLaterUpdated = storedRecords(
      findings,
      "workspace_run_outcome",
    );
    assert.equal(outcomesAfterLaterUpdated.length, outcomesBeforeLaterUpdated + 1);
    assert.equal(outcomesAfterLaterUpdated.at(-1)?.outcome, "no_match");
    monitorA = (await getWorkspaceMonitor(
      workspaceA.scope,
      monitorA.monitorId,
      monitors,
    ))!;
    assert.equal(
      monitorA.sourceCheckpoint.watermark,
      "2026-08-14T20:00:00.000Z",
    );
    assert.notEqual(monitorA.nextOccurrenceAt, laterUpdatedOccurrence);
    assert.equal(monitors.completeCalls, completionsBeforeLaterUpdated + 1);

    const recoveryWorkspace = await setupWorkspace(
      "423e4567-e89b-42d3-a456-426614174000",
    );
    const recoveryBaselineJob = claim({
      monitor: recoveryWorkspace.monitor,
      now: verificationNow,
      scope: recoveryWorkspace.scope,
    });
    await dispatch(
      recoveryBaselineJob,
      fetchResponse(fixtureBodies.initial),
    );
    const recoveryMonitor = (await getWorkspaceMonitor(
      recoveryWorkspace.scope,
      recoveryWorkspace.monitor.monitorId,
      monitors,
    ))!;
    const alignedRecoveryMonitor = await alignMonitorForProductionClaim({
      monitor: recoveryMonitor,
      scope: recoveryWorkspace.scope,
    });
    const recoveryAttemptOne = await claimProductionOccurrence(
      alignedRecoveryMonitor.monitorId,
    );
    assert.equal(recoveryAttemptOne.occurrence.attempt, 1);
    workspaceBudgetEnvironment = {
      ...environment,
      EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "1",
    };
    const recoveryAttemptOneBudget =
      await reserveWorkspaceMonitorDispatchBudget(recoveryAttemptOne, {
        clients: { global: budget, state, workspace: budget },
        environment: workspaceBudgetEnvironment,
        now: verificationNow,
      });
    const recoveryAttemptOnePrepared = await prepareWorkspaceWorkerRun({
      claimed: recoveryAttemptOne,
      clients: { sourceCoverage: coverage, state },
      dispatchBudget: recoveryAttemptOneBudget,
      environment,
      now: verificationNow,
    });
    const alertsBeforeRecovery = storedRecords(alerts, "workspace_alert").length;
    const completionsBeforeRecovery = monitors.completeCalls;
    const workerStartsBeforeRecovery = workspaceWorkerStarts;
    alerts.failNextRecordType = "workspace_alert";
    const interrupted = await runCompiledWorkspaceWorkerWithoutSchedulerTail(
      recoveryAttemptOnePrepared.request,
      fetchResponse(fixtureBodies.later),
    );
    assert.equal(interrupted.fetches, 1);
    assert.equal(workspaceWorkerStarts, workerStartsBeforeRecovery);
    assert.ok(interrupted.events.some((event) =>
      event.type === "action.result" &&
      event.data.result.kind === "tool-result" &&
      event.data.result.toolName === EVALUATE_SEC_IPO_SOURCE_TOOL_ID &&
      event.data.result.isError === true
    ));
    assert.ok(interrupted.events.some((event) => event.type === "session.completed"));
    assert.equal(storedRecords(alerts, "workspace_alert").length, alertsBeforeRecovery);
    assert.equal(monitors.completeCalls, completionsBeforeRecovery);
    assert.equal(
      (await getWorkspaceMonitor(
        recoveryWorkspace.scope,
        recoveryWorkspace.monitor.monitorId,
        monitors,
      ))?.nextOccurrenceAt,
      alignedRecoveryMonitor.nextOccurrenceAt,
    );
    const reservedAttemptOneLedger = await readWorkspaceBudgetLedger(
      recoveryWorkspace.scope,
      budget,
    );
    assert.equal(
      reservedAttemptOneLedger.reservations.find(
        ({ runId }) => runId === recoveryAttemptOneBudget.runId,
      )?.state,
      "reserved",
    );
    assert.equal(
      (await readGlobalDispatchBudgetLedger(budget)).reservations.find(
        ({ runId }) => runId === recoveryAttemptOneBudget.runId,
      )?.state,
      "reserved",
    );
    verificationNow = new Date(
      Date.parse(recoveryAttemptOne.leaseExpiresAt) + 1,
    );
    const recoveryAttemptTwo = await claimProductionOccurrence(
      alignedRecoveryMonitor.monitorId,
    );
    assert.equal(recoveryAttemptTwo.occurrence.attempt, 2);
    assert.equal(
      recoveryAttemptTwo.occurrence.occurrenceKey,
      recoveryAttemptOne.occurrence.occurrenceKey,
    );
    const expectedAttemptTwoRunId =
      `${recoveryAttemptTwo.occurrence.occurrenceKey}:attempt:2`;
    assert.notEqual(expectedAttemptTwoRunId, recoveryAttemptOneBudget.runId);
    const budgetAdmissionsBeforeAttemptTwo = workspaceBudgetReservations;
    const coverageRecordsBeforeAttemptTwo = coverage.values.size;
    const recovered = await dispatch(
      recoveryAttemptTwo,
      async () => {
        throw new Error("durable outcome recovery must not refetch");
      },
    );
    assert.equal(recovered.fetches, 0);
    assert.deepEqual(recovered.events, []);
    assert.equal(workspaceWorkerStarts, workerStartsBeforeRecovery);
    assert.equal(workspaceBudgetReservations, budgetAdmissionsBeforeAttemptTwo);
    assert.equal(coverage.values.size, coverageRecordsBeforeAttemptTwo);
    assert.equal(
      storedRecords(alerts, "workspace_alert").length,
      alertsBeforeRecovery + 1,
    );
    assert.equal(monitors.completeCalls, completionsBeforeRecovery + 1);
    const recoveredMonitor = (await getWorkspaceMonitor(
      recoveryWorkspace.scope,
      recoveryWorkspace.monitor.monitorId,
      monitors,
    ))!;
    assert.notEqual(
      recoveredMonitor.nextOccurrenceAt,
      alignedRecoveryMonitor.nextOccurrenceAt,
    );
    const recoveryBudget = await readWorkspaceBudgetLedger(
      recoveryWorkspace.scope,
      budget,
    );
    const recoveryReservations = recoveryBudget.reservations.filter(
      ({ runId }) =>
        runId.startsWith(recoveryAttemptOne.occurrence.occurrenceKey),
    );
    assert.deepEqual(
      recoveryReservations.map(({ state }) => state),
      ["reserved"],
    );
    assert.equal(recoveryReservations[0]?.runId, recoveryAttemptOneBudget.runId);
    assert.equal(
      recoveryBudget.reservations.some(
        ({ runId }) => runId === expectedAttemptTwoRunId,
      ),
      false,
    );
    assert.equal(
      (await readGlobalDispatchBudgetLedger(budget)).reservations.some(
        ({ runId }) => runId === expectedAttemptTwoRunId,
      ),
      false,
    );
    const recoveryReplay = await dispatch(
      recoveryAttemptTwo,
      async () => {
        throw new Error("completed occurrence replay must not restart or refetch");
      },
    );
    assert.equal(recoveryReplay.fetches, 0);
    assert.deepEqual(recoveryReplay.events, []);
    assert.equal(workspaceWorkerStarts, workerStartsBeforeRecovery);
    assert.equal(workspaceBudgetReservations, budgetAdmissionsBeforeAttemptTwo);
    assert.equal(monitors.completeCalls, completionsBeforeRecovery + 1);
    assert.deepEqual(
      await getWorkspaceMonitor(
        recoveryWorkspace.scope,
        recoveryWorkspace.monitor.monitorId,
        monitors,
      ),
      recoveredMonitor,
    );
    workspaceBudgetEnvironment = environment;

    const missingRecoveryWorkspace = await setupWorkspace(
      "523e4567-e89b-42d3-a456-426614174000",
    );
    const missingRecoveryMonitor = await alignMonitorForProductionClaim({
      monitor: missingRecoveryWorkspace.monitor,
      scope: missingRecoveryWorkspace.scope,
    });
    const missingAttemptOne = await claimProductionOccurrence(
      missingRecoveryMonitor.monitorId,
    );
    verificationNow = new Date(Date.parse(missingAttemptOne.leaseExpiresAt) + 1);
    const missingAttemptTwo = await claimProductionOccurrence(
      missingRecoveryMonitor.monitorId,
    );
    assert.equal(missingAttemptTwo.occurrence.attempt, 2);
    const startsBeforeMissingRecovery = workspaceWorkerStarts;
    const missingRecovery = await dispatch(
      missingAttemptTwo,
      async () => {
        throw new Error("missing recovery must not fetch");
      },
    );
    assert.equal(missingRecovery.fetches, 0);
    assert.deepEqual(missingRecovery.events, []);
    assert.equal(workspaceWorkerStarts, startsBeforeMissingRecovery);
    const missingFailedMonitor = (await getWorkspaceMonitor(
      missingRecoveryWorkspace.scope,
      missingRecoveryMonitor.monitorId,
      monitors,
    ))!;
    assert.equal(missingFailedMonitor.lifecycleState, "paused_failure");
    assert.equal(missingFailedMonitor.nextOccurrenceAt, null);
    assert.equal(missingFailedMonitor.consecutiveFailures, 1);
    assert.equal(
      missingFailedMonitor.lastErrorCode,
      "worker_recovery_outcome_missing",
    );
    assert.equal(
      missingFailedMonitor.pauseReason,
      "worker_recovery_outcome_missing",
    );
    const missingBudget = await readWorkspaceBudgetLedger(
      missingRecoveryWorkspace.scope,
      budget,
    );
    assert.deepEqual(
      missingBudget.reservations.map(({ state }) => state),
      [],
    );

    const corruptRecoveryWorkspace = await setupWorkspace(
      "623e4567-e89b-42d3-a456-426614174000",
    );
    const corruptRecoveryMonitor = await alignMonitorForProductionClaim({
      monitor: corruptRecoveryWorkspace.monitor,
      scope: corruptRecoveryWorkspace.scope,
    });
    const corruptAttemptOne = await claimProductionOccurrence(
      corruptRecoveryMonitor.monitorId,
    );
    verificationNow = new Date(Date.parse(corruptAttemptOne.leaseExpiresAt) + 1);
    const corruptAttemptTwo = await claimProductionOccurrence(
      corruptRecoveryMonitor.monitorId,
    );
    assert.equal(corruptAttemptTwo.occurrence.attempt, 2);
    findings.nextGetValue = "{corrupt-outcome";
    const startsBeforeCorruptRecovery = workspaceWorkerStarts;
    const corruptRecovery = await dispatch(
      corruptAttemptTwo,
      async () => {
        throw new Error("corrupt recovery must not fetch");
      },
    );
    assert.equal(corruptRecovery.fetches, 0);
    assert.deepEqual(corruptRecovery.events, []);
    assert.equal(workspaceWorkerStarts, startsBeforeCorruptRecovery);
    const corruptFailedMonitor = (await getWorkspaceMonitor(
      corruptRecoveryWorkspace.scope,
      corruptRecoveryMonitor.monitorId,
      monitors,
    ))!;
    assert.equal(corruptFailedMonitor.lifecycleState, "paused_failure");
    assert.equal(corruptFailedMonitor.nextOccurrenceAt, null);
    assert.equal(corruptFailedMonitor.consecutiveFailures, 1);
    assert.equal(
      corruptFailedMonitor.lastErrorCode,
      "worker_recovery_outcome_corrupt",
    );
    assert.equal(
      corruptFailedMonitor.pauseReason,
      "worker_recovery_outcome_corrupt",
    );
    const corruptBudget = await readWorkspaceBudgetLedger(
      corruptRecoveryWorkspace.scope,
      budget,
    );
    assert.deepEqual(
      corruptBudget.reservations.map(({ state }) => state),
      [],
    );

    verificationNow = new Date();
    const workspaceB = await setupWorkspace(
      "223e4567-e89b-42d3-a456-426614174000",
    );
    await dispatch(
      claim({ monitor: workspaceB.monitor, now: verificationNow, scope: workspaceB.scope }),
      fetchResponse(fixtureBodies.initial),
    );
    let monitorB = (await getWorkspaceMonitor(
      workspaceB.scope,
      workspaceB.monitor.monitorId,
      monitors,
    ))!;
    const isolated = await dispatch(
      claim({ monitor: monitorB, now: verificationNow, scope: workspaceB.scope }),
      fetchResponse(fixtureBodies.later),
    );
    assertCompiledEvaluatorEvents(isolated);
    const workspaceFindings = storedFindings();
    const findingA = workspaceFindings.find((record) =>
      record.workspaceId === workspaceA.scope.workspaceId &&
      (record.facts as Array<Record<string, unknown>>)[0]?.classification === "new_registration"
    )!;
    const findingB = workspaceFindings.find((record) =>
      record.workspaceId === workspaceB.scope.workspaceId
    )!;
    assert.notEqual(findingA.findingId, findingB.findingId);
    assert.notEqual(findingA.workspaceId, findingB.workspaceId);

    monitorB = (await getWorkspaceMonitor(
      workspaceB.scope,
      workspaceB.monitor.monitorId,
      monitors,
    ))!;
    const failures = [
      ["malformed", fetchResponse(fixtureBodies.malformed)],
      ["truncated", fetchResponse(fixtureBodies.amendment, { truncated: true })],
      ["redirected", fetchResponse(fixtureBodies.amendment, {
        finalUrl: "https://www.sec.gov/redirected-feed",
      })],
      ["stale", fetchResponse(fixtureBodies.initial)],
      ["ambiguous", fetchResponse(
        fixtureBodies.later.replace("Baseline One Corp", "Changed Baseline Corp"),
      )],
    ] as const;
    for (const [name, response] of failures) {
      const checkpointBefore = monitorB.sourceCheckpoint;
      const alertCount = storedRecords(alerts, "workspace_alert").length;
      const findingCount = storedFindings().length;
      const failed = await dispatch(
        claim({ monitor: monitorB, now: verificationNow, scope: workspaceB.scope }),
        response,
      );
      assert.equal(failed.fetches, 1, name);
      assert.ok(failed.events.some((event) => event.type === "action.result"), name);
      assert.ok(failed.events.some((event) => event.type === "session.completed"), name);
      monitorB = (await getWorkspaceMonitor(
        workspaceB.scope,
        workspaceB.monitor.monitorId,
        monitors,
      ))!;
      assert.deepEqual(monitorB.sourceCheckpoint, checkpointBefore, name);
      assert.equal(storedRecords(alerts, "workspace_alert").length, alertCount, name);
      assert.equal(storedFindings().length, findingCount, name);
    }
  });
} finally {
  setWorld(undefined);
  await workflowWorld.clear();
  await workflowWorld.close();
  await rm(workflowDataDirectory, { force: true, recursive: true });
  await rm(workflowBuildDirectory, { force: true, recursive: true });
  delete process.env.EVE_WORKSPACE_WORKER_FIXTURE_RPC_TOKEN;
  delete process.env.EVE_WORKSPACE_WORKER_FIXTURE_RPC_URL;
  await fixtureRpc.close();
  uninstallFixtureClients();
}

console.info(
  "Scheduled compiled SEC IPO workspace-worker acceptance verification passed.",
);
