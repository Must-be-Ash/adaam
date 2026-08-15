import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import type { OfficialPublicSourceResponse } from "../agent/tools/fetch_public_source";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { WorkspaceFindingStoreClient } from "../agent/lib/workspace-finding-store";
import {
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  IPO_FILINGS_CAPABILITY_MANIFEST,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference";
import {
  evaluateSecIpoSourceForWorker,
} from "../agent/lib/sec-ipo-workspace-worker";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { prepareWorkspaceWorkerRun } from "../agent/lib/workspace-worker-runner";

class MemoryCasStore
  implements WorkspaceSourceCoverageClient, WorkspaceStateStoreClient {
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
  readonly values = new Map<string, string>();

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
    return this.values.get(key) ?? null;
  }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  completeCalls = 0;
  readonly completedOccurrences = new Set<string>();
  readonly values = new Map<string, string>();

  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    if (this.completedOccurrences.has(input.occurrenceRecordKey)) {
      return "already_completed" as const;
    }
    const current = this.values.get(input.recordKey);
    if (!current) return "missing" as const;
    if (current !== input.expectedRaw) return "stale" as const;
    this.values.set(input.recordKey, input.nextRaw);
    this.completeCalls += 1;
    this.completedOccurrences.add(input.occurrenceRecordKey);
    return "completed" as const;
  }

  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async claim(): Promise<{ status: "missing" }> {
    return { status: "missing" };
  }

  async list(): Promise<unknown[]> {
    return [...this.values.values()];
  }

  async listDue(): Promise<[]> {
    return [];
  }

  async releaseLease(): Promise<boolean> {
    return false;
  }

  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    return true;
  }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 29).toString("base64url"),
};
const fixtureRoot = new URL("./fixtures/sec-ipo/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, fixtureRoot), "utf8");
const fixtureBodies = {
  amendment: await fixture("amendment.atom"),
  initial: await fixture("initial.atom"),
  later: await fixture("later-s1.atom"),
  malformed: await fixture("malformed.atom"),
};
const state = new MemoryCasStore();
const coverage = new MemoryCasStore();
const findings = new MemoryCreateStore();
const alerts = new MemoryCreateStore();
const monitors = new MemoryMonitorStore();
const clients = {
  alert: alerts,
  finding: findings,
  monitor: monitors,
  sourceCoverage: coverage,
  state,
};
const verificationNow = new Date();

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
      maximumInputTokensPerDay: 40_000,
      maximumInputTokensPerRun: 10_000,
      maximumOutputTokensPerDay: 8_000,
      maximumOutputTokensPerRun: 2_000,
      maximumPaidPerCall: null,
      maximumPaidPerDay: null,
      maximumPaidPerMonth: null,
      maximumScheduledRunsPerDay: 8,
      ownerTimezone: "America/Vancouver",
      unknownPriceFallbackCeiling: "0",
    },
  }, state);
  const monitor = await createWorkspaceMonitor({
    deliverySubscriptionId: `subscription.${workspaceId}`,
    idempotencyKey: `monitor.${workspaceId}`,
    instruction: "Evaluate the exact SEC S-1 source deterministically.",
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
async function prepare(input: {
  monitor: WorkspaceMonitor;
  now: Date;
  scope: ReturnType<typeof authorizeDeploymentWorkspaceStore>;
}) {
  runSequence += 1;
  const occurrenceKey = runSequence.toString(16).padStart(64, "0");
  const runId = `${occurrenceKey}:attempt:1`;
  const claimed = {
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
  } satisfies ClaimedWorkspaceMonitor;
  const common = {
    calendarDay: input.now.toISOString().slice(0, 10),
    createdAt: input.now.toISOString(),
    runId,
    state: "reserved" as const,
    updatedAt: input.now.toISOString(),
  };
  const dispatchBudget = {
    global: common,
    runId,
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
    clients: { sourceCoverage: coverage, state },
    dispatchBudget,
    environment,
    now: input.now,
  });
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

async function execute(
  prepared: Awaited<ReturnType<typeof prepare>>,
  now: Date,
  fetchSource: SecIpoFetch,
  overrides: Partial<typeof clients> = {},
) {
  return evaluateSecIpoSourceForWorker({
    clients: { ...clients, ...overrides, fetchSource },
    ctx: { session: { auth: { current: prepared.request.auth } } },
    environment,
    now,
  });
}

type SecIpoFetch = NonNullable<
  Parameters<typeof evaluateSecIpoSourceForWorker>[0]["clients"]
>["fetchSource"] extends infer T ? NonNullable<T> : never;

const workspaceA = await setupWorkspace(
  "123e4567-e89b-42d3-a456-426614174000",
);
const baselineNow = verificationNow;
const baselinePrepared = await prepare({ ...workspaceA, now: baselineNow });
const baseline = await execute(
  baselinePrepared,
  baselineNow,
  fetchResponse(fixtureBodies.initial),
);
assert.equal(baseline.baselineEstablished, true);
assert.equal(baseline.factCount, 0);
assert.equal(baseline.outcome.outcome, "no_match");
assert.equal(baseline.checkpoint.watermark, "2026-08-14T17:00:00.000Z");
const countsAfterBaseline = {
  alerts: alerts.values.size,
  coverage: coverage.values.size,
  findings: findings.values.size,
};
const baselineReplay = await execute(
  baselinePrepared,
  baselineNow,
  async () => {
    throw new Error("A completed occurrence replay must not fetch.");
  },
);
assert.equal(baselineReplay.replayed, true);
assert.deepEqual(
  {
    alerts: alerts.values.size,
    coverage: coverage.values.size,
    findings: findings.values.size,
  },
  countsAfterBaseline,
);

let monitorA = await getWorkspaceMonitor(
  workspaceA.scope,
  workspaceA.monitor.monitorId,
  monitors,
);
assert.ok(monitorA);
const laterNow = verificationNow;
const laterPrepared = await prepare({
  monitor: monitorA,
  now: laterNow,
  scope: workspaceA.scope,
});
const later = await execute(
  laterPrepared,
  laterNow,
  fetchResponse(fixtureBodies.later),
);
assert.equal(later.factCount, 1);
assert.equal(later.outcome.outcome, "finding_staged");
assert.equal(later.outcome.finding?.facts?.[0]?.kind, "sec_ipo_filing");
assert.equal(
  later.outcome.finding?.facts?.[0]?.classification,
  "new_registration",
);
assert.equal(alerts.values.size, 1);
assert.equal(findings.values.size, 2);
assert.deepEqual(
  await execute(laterPrepared, laterNow, async () => {
    throw new Error("A finding occurrence replay must not fetch.");
  }),
  { ...later, replayed: true },
);

monitorA = await getWorkspaceMonitor(
  workspaceA.scope,
  workspaceA.monitor.monitorId,
  monitors,
);
assert.ok(monitorA);
const amendmentNow = verificationNow;
const amendment = await execute(
  await prepare({
    monitor: monitorA,
    now: amendmentNow,
    scope: workspaceA.scope,
  }),
  amendmentNow,
  fetchResponse(fixtureBodies.amendment),
);
assert.equal(amendment.factCount, 1);
assert.equal(amendment.outcome.finding?.facts?.[0]?.classification, "amendment");
assert.equal(
  amendment.outcome.finding?.facts?.[0]?.registrationIdentity,
  later.outcome.finding?.facts?.[0]?.registrationIdentity,
);
assert.notEqual(
  amendment.outcome.finding?.facts?.[0]?.amendmentIdentity,
  null,
);
assert.equal(alerts.values.size, 2);

monitorA = await getWorkspaceMonitor(
  workspaceA.scope,
  workspaceA.monitor.monitorId,
  monitors,
);
assert.ok(monitorA);
const sameFilingNow = verificationNow;
const sameFiling = await execute(
  await prepare({
    monitor: monitorA,
    now: sameFilingNow,
    scope: workspaceA.scope,
  }),
  sameFilingNow,
  fetchResponse(fixtureBodies.amendment),
);
assert.equal(sameFiling.outcome.outcome, "no_match");
assert.equal(sameFiling.factCount, 0);
assert.equal(alerts.values.size, 2);

const workspaceRecovery = await setupWorkspace(
  "423e4567-e89b-42d3-a456-426614174000",
);
await execute(
  await prepare({ ...workspaceRecovery, now: baselineNow }),
  baselineNow,
  fetchResponse(fixtureBodies.initial),
);
const recoveryMonitor = await getWorkspaceMonitor(
  workspaceRecovery.scope,
  workspaceRecovery.monitor.monitorId,
  monitors,
);
assert.ok(recoveryMonitor);
const recoveryPrepared = await prepare({
  monitor: recoveryMonitor,
  now: laterNow,
  scope: workspaceRecovery.scope,
});
const recoveryAlertsBefore = alerts.values.size;
const recoveryCompletionsBefore = monitors.completeCalls;
alerts.failNextRecordType = "workspace_alert";
await assert.rejects(
  execute(
    recoveryPrepared,
    laterNow,
    fetchResponse(fixtureBodies.later),
  ),
  /fixture_create_interrupted/u,
);
assert.equal(alerts.values.size, recoveryAlertsBefore);
assert.equal(monitors.completeCalls, recoveryCompletionsBefore);
assert.equal(
  (await getWorkspaceMonitor(
    workspaceRecovery.scope,
    workspaceRecovery.monitor.monitorId,
    monitors,
  ))?.nextOccurrenceAt,
  recoveryMonitor.nextOccurrenceAt,
);
let recoveryFetches = 0;
const recoveredOutcome = await execute(
  recoveryPrepared,
  laterNow,
  async () => {
    recoveryFetches += 1;
    throw new Error("durable outcome recovery must not refetch");
  },
);
assert.equal(recoveryFetches, 0);
assert.equal(recoveredOutcome.replayed, true);
assert.equal(alerts.values.size, recoveryAlertsBefore + 1);
assert.equal(monitors.completeCalls, recoveryCompletionsBefore + 1);
const recoveredMonitor = await getWorkspaceMonitor(
  workspaceRecovery.scope,
  workspaceRecovery.monitor.monitorId,
  monitors,
);
assert.ok(recoveredMonitor);
assert.notEqual(recoveredMonitor.nextOccurrenceAt, recoveryMonitor.nextOccurrenceAt);
const recoveryReplay = await execute(
  recoveryPrepared,
  laterNow,
  async () => {
    recoveryFetches += 1;
    throw new Error("completed recovery replay must not refetch");
  },
);
assert.equal(recoveryFetches, 0);
assert.equal(recoveryReplay.replayed, true);
assert.equal(alerts.values.size, recoveryAlertsBefore + 1);
assert.equal(monitors.completeCalls, recoveryCompletionsBefore + 1);
assert.deepEqual(
  await getWorkspaceMonitor(
    workspaceRecovery.scope,
    workspaceRecovery.monitor.monitorId,
    monitors,
  ),
  recoveredMonitor,
);

const workspaceB = await setupWorkspace(
  "223e4567-e89b-42d3-a456-426614174000",
);
const baselineB = await execute(
  await prepare({ ...workspaceB, now: baselineNow }),
  baselineNow,
  fetchResponse(fixtureBodies.initial),
);
let monitorB = await getWorkspaceMonitor(
  workspaceB.scope,
  workspaceB.monitor.monitorId,
  monitors,
);
assert.ok(monitorB);
const concurrentB = await execute(
  await prepare({ monitor: monitorB, now: laterNow, scope: workspaceB.scope }),
  laterNow,
  fetchResponse(fixtureBodies.later),
);
assert.equal(baselineB.outcome.workspaceId, workspaceB.scope.workspaceId);
assert.notEqual(
  concurrentB.outcome.finding?.findingId,
  later.outcome.finding?.findingId,
);
assert.notEqual(
  concurrentB.outcome.finding?.workspaceId,
  later.outcome.finding?.workspaceId,
);

monitorB = await getWorkspaceMonitor(
  workspaceB.scope,
  workspaceB.monitor.monitorId,
  monitors,
);
assert.ok(monitorB);
const failureNow = verificationNow;
for (const [name, response] of [
  ["malformed", fetchResponse(fixtureBodies.malformed)],
  ["truncated", fetchResponse(fixtureBodies.amendment, { truncated: true })],
  [
    "redirected",
    fetchResponse(fixtureBodies.amendment, {
      finalUrl: "https://www.sec.gov/redirected-feed",
    }),
  ],
  ["stale", fetchResponse(fixtureBodies.initial)],
  [
    "ambiguous",
    fetchResponse(
      fixtureBodies.later.replace("Baseline One Corp", "Changed Baseline Corp"),
    ),
  ],
] as const) {
  const prepared = await prepare({
    monitor: monitorB,
    now: failureNow,
    scope: workspaceB.scope,
  });
  await assert.rejects(
    execute(prepared, failureNow, response),
    (error) => error instanceof Error && error.message.startsWith("sec_atom_"),
    name,
  );
}

console.info("Deterministic SEC IPO workspace-worker verification passed.");
