import assert from "node:assert/strict";

import {
  readWorkspaceRunOutcome,
  selectUnseenWorkspaceFindingIdentities,
  stageWorkspaceFinding,
  workspaceRunAttemptForOccurrence,
  WorkspaceFindingError,
  type WorkspaceFindingStoreClient,
  type WorkspaceRunOutcome,
} from "../agent/lib/workspace-finding-store";
import { createWorkspaceMonitor, type WorkspaceMonitorStoreClient } from "../agent/lib/workspace-monitor-store";
import {
  createWorkspaceSourceCoverage,
  completeWorkspaceSourceCoverage,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
  WorkspaceSourceCoverageError,
  type WorkspaceSourceCoverageClient,
} from "../agent/lib/workspace-source-coverage";
import { writeWorkspaceDocument, type WorkspaceStateStoreClient } from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  COMPLETE_WORKSPACE_RUN_TOOL_ID,
  completeWorkspaceRunForWorker,
  isPriorWorkspaceRunForRecovery,
  WRITE_WORKSPACE_FINDING_TOOL_ID,
  writeWorkspaceFindingForWorker,
  WorkspaceWorkerCommitError,
} from "../agent/lib/workspace-worker-control-plane";
import {
  createWorkspaceWorkerEnvelope,
  signWorkspaceWorkerEnvelope,
  workspaceWorkerExecutionAuth,
} from "../agent/lib/workspace-worker-auth";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import type { WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";

class MemoryCasStore implements WorkspaceStateStoreClient, WorkspaceSourceCoverageClient {
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

class MemoryFindingStore implements WorkspaceFindingStoreClient {
  failNextIdentityCommit = false;
  forceNextIdentityConflict = false;
  readonly values = new Map<string, string>();
  async createOutcomeWithIdentityClaims(input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0]) {
    const outcome = this.values.get(input.outcomeKey);
    if (outcome) return { status: "existing" as const, value: outcome };
    if (this.failNextIdentityCommit) {
      this.failNextIdentityCommit = false;
      throw new Error("fixture_identity_commit_interrupted");
    }
    if (this.forceNextIdentityConflict) {
      this.forceNextIdentityConflict = false;
      return { status: "identity_conflict" as const, value: "fixture_conflict" };
    }
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
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  readonly values = new Map<string, string>();
  async createOrRead(key: string, value: string) {
    const existing = this.values.get(key);
    if (existing) return existing;
    this.values.set(key, value);
    return value;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  completeCalls = 0;
  readonly completedOccurrences = new Set<string>();
  readonly values = new Map<string, string>();
  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    if (this.completedOccurrences.has(input.occurrenceRecordKey)) {
      return "already_completed" as const;
    }
    const raw = this.values.get(input.recordKey);
    if (!raw) return "missing" as const;
    if (raw !== input.expectedRaw) return "stale" as const;
    const monitor = JSON.parse(input.nextRaw);
    if (monitor.configurationRevision !== input.configurationRevision) return "stale" as const;
    this.values.set(input.recordKey, input.nextRaw);
    this.completedOccurrences.add(input.occurrenceRecordKey);
    this.completeCalls += 1;
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
  async claim(): Promise<{ status: "missing" }> { return { status: "missing" }; }
  async list(): Promise<unknown[]> { return []; }
  async listDue(): Promise<[]> { return []; }
  async releaseLease(): Promise<boolean> { return false; }
  async update(): Promise<boolean> { return false; }
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 9).toString("base64url"),
};
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, environment);
const otherScope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "323e4567-e89b-42d3-a456-426614174000",
}, environment);
const stateClient = new MemoryCasStore();
const coverageClient = new MemoryCasStore();
const findingClient = new MemoryFindingStore();
const monitorClient = new MemoryMonitorStore();
const now = new Date();
const window = {
  endAt: now.toISOString(),
  startAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
};
const source = {
  accessClassification: "public" as const,
  canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
  origin: "https://www.sec.gov",
  sourceId: "sec.latest",
};
const monitor = await createWorkspaceMonitor({
  deliverySubscriptionId: "subscription.fixture",
  instruction: "Check for a new filing.",
  name: "Finding fixture",
  nextOccurrenceAt: now.toISOString(),
  now,
  requiredCapabilityIds: [
    COMPLETE_WORKSPACE_RUN_TOOL_ID,
    WRITE_WORKSPACE_FINDING_TOOL_ID,
    "fetch_public_source",
  ],
  schedule: { at: now.toISOString(), kind: "one_time" },
  scope,
  sources: [source],
  tighteningLimits: { inputTokensPerRun: 500, outputTokensPerRun: 200, paidPerRun: null },
}, monitorClient);
await writeWorkspaceDocument("capabilities", {
  expectedRevision: 0,
  now,
  scope,
  value: {
    connectionIds: [],
    controlPlaneToolIds: [COMPLETE_WORKSPACE_RUN_TOOL_ID, WRITE_WORKSPACE_FINDING_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["filesystem.write"],
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: ["fetch_public_source"],
    skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
    sources: [{ origin: source.origin, sourceId: source.sourceId }],
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 200 },
  },
}, stateClient);
await writeWorkspaceDocument("strategy", {
  expectedRevision: 0,
  now,
  scope,
  value: { configuration: {}, strategyPack: null },
}, stateClient);

const runId = `${"c".repeat(64)}:attempt:1`;
const claimed = {
  leaseExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  leaseToken: "lease_fixture",
  monitor,
  occurrence: {
    attempt: 1,
    configurationRevision: monitor.configurationRevision,
    leaseTokenDigest: "d".repeat(64),
    monitorId: monitor.monitorId,
    occurrenceIdentity: `one_time:${now.toISOString()}`,
    occurrenceKey: "c".repeat(64),
    scheduledFor: now.toISOString(),
    schemaVersion: 1,
    status: "leased",
    updatedAt: now.toISOString(),
  },
  scope,
  skippedOccurrenceIdentities: [],
} satisfies ClaimedWorkspaceMonitor;
const dispatchBudget = {
  global: {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
  runId,
  workspace: {
    calendarDay: now.toISOString().slice(0, 10),
    calendarMonth: now.toISOString().slice(0, 7),
    createdAt: now.toISOString(),
    inputTokens: 500,
    outputTokens: 200,
    paidMicros: "0",
    policyRevision: 1,
    reconciledInputTokens: null,
    reconciledOutputTokens: null,
    reconciledPaidMicros: null,
    runId,
    state: "reserved",
    updatedAt: now.toISOString(),
  },
} satisfies WorkspaceDispatchReservation;
const envelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed,
  dispatchBudget,
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
const token = signWorkspaceWorkerEnvelope(envelope, environment);
const ctx = { session: { auth: { current: workspaceWorkerExecutionAuth(envelope, token) } } };
const clients = {
  alert: new MemoryAlertStore(),
  finding: findingClient,
  monitor: monitorClient,
  sourceCoverage: coverageClient,
  state: stateClient,
};
const initialMaxCoverage = await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
assert.equal(initialMaxCoverage.state, "evaluating");

const finding = {
  accessClassification: "public" as const,
  artifactRefs: [],
  asOf: now.toISOString(),
  factIdentities: ["0001000001-26-000001:S-1"],
  facts: [{
    accessionNumber: "0001000001-26-000001",
    amendmentIdentity: null,
    canonicalFilingUrl:
      "https://www.sec.gov/Archives/edgar/data/1000001/000100000126000001/fixture-s1-index.htm",
    cik: "0001000001",
    classification: "new_registration" as const,
    companyName: "Fixture Corp",
    contentEvidence: {
      feedContentHash: "1".repeat(64),
      normalizedFilingHash: "2".repeat(64),
    },
    fileNumber: "333-100001",
    filedAt: now.toISOString(),
    filingIdentity: "0001000001-26-000001:S-1",
    formType: "S-1" as const,
    kind: "sec_ipo_filing" as const,
    normalizerVersion: "sec-ipo-atom/1.0.0" as const,
    observedAt: now.toISOString(),
    registrationIdentity: "0001000001:333-100001",
    schemaVersion: 1 as const,
    source: {
      accessClassification: "public" as const,
      canonicalUrl: source.canonicalUrl,
      origin: source.origin,
      sourceId: source.sourceId,
    },
    updatedAt: now.toISOString(),
  }],
  provenance: [{
    accessClassification: "public" as const,
    canonicalUrl: "https://www.sec.gov/Archives/edgar/data/1000001/fixture-s1.htm",
    origin: source.origin,
    sourceId: source.sourceId,
  }],
  summary: "Fixture Corp filed a potential IPO registration on Form S-1.",
};

await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now }),
  (error) => error instanceof WorkspaceSourceCoverageError && error.code === "source_coverage_incomplete",
);
await reserveWorkspaceSourceAttempt({ now, runId, scope, sourceId: source.sourceId }, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "e".repeat(64),
  now,
  runId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx,
    environment,
    finding: { ...finding, accessClassification: "owner_private" },
    now,
  }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_classification_denied",
);
const outcome = await writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now });
assert.equal(outcome.outcome, "finding_staged");
assert.equal(outcome.ownerId, scope.ownerId);
assert.equal(outcome.workspaceId, scope.workspaceId);
assert.equal(outcome.runId, runId);
assert.equal(outcome.finding?.summary, finding.summary);
assert.deepEqual(outcome.finding?.facts, finding.facts);
assert.equal(outcome.strategyPack, null);
assert.equal(outcome.finding?.strategyPack, null);
assert.equal("strategyPack" in outcome.finding!.facts![0]!, false);
assert.match(outcome.finding?.findingId ?? "", /^finding_[a-f0-9]{64}$/u);
assert.ok(outcome.finding);

const maxOccurrenceKey = "7".repeat(64);
const maxRunId = `${maxOccurrenceKey}:attempt:1`;
const maxSecUrl = (pathPrefix: string) => {
  const prefix = `https://www.sec.gov/${pathPrefix}`;
  assert.ok(prefix.length < 2_048);
  return `${prefix}${"a".repeat(2_048 - prefix.length)}`;
};
const maxSources = Array.from({ length: 8 }, (_, index) => {
  const sourceIdPrefix = `sec.maximum.${index}.`;
  return {
    accessClassification: "public" as const,
    canonicalUrl: maxSecUrl(`source-${index}/`),
    origin: "https://www.sec.gov",
    sourceId: `${sourceIdPrefix}${"s".repeat(160 - sourceIdPrefix.length)}`,
  };
});
const maxCoverageSources = maxSources.map(
  ({ canonicalUrl, origin, sourceId }) => ({ canonicalUrl, origin, sourceId }),
);
const maxClaimed = {
  ...claimed,
  monitor: {
    ...claimed.monitor,
    sources: maxSources,
  },
  occurrence: {
    ...claimed.occurrence,
    occurrenceKey: maxOccurrenceKey,
  },
} satisfies ClaimedWorkspaceMonitor;
const maxEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: maxClaimed,
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: maxRunId },
    runId: maxRunId,
    workspace: { ...dispatchBudget.workspace, runId: maxRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: maxRunId,
  scope,
  sources: maxCoverageSources,
  window,
}, coverageClient);
for (const maxSource of maxSources) {
  await reserveWorkspaceSourceAttempt({
    now,
    runId: maxRunId,
    scope,
    sourceId: maxSource.sourceId,
  }, coverageClient);
  await markWorkspaceSourceSuccess({
    contentDigest: "9".repeat(64),
    now,
    runId: maxRunId,
    scope,
    sourceId: maxSource.sourceId,
  }, coverageClient);
}
const maxCoverage = await completeWorkspaceSourceCoverage({
  now,
  runId: maxRunId,
  scope,
}, coverageClient);
const maxFacts = Array.from({ length: 40 }, (_, index) => {
  const ordinal = String(index + 101).padStart(6, "0");
  const accessionNumber = `0001000001-26-${ordinal}`;
  const registrationPrefix = `registration-${ordinal}-`;
  return {
    ...finding.facts[0]!,
    accessionNumber,
    amendmentIdentity: "修".repeat(256),
    canonicalFilingUrl: maxSecUrl(`Archives/edgar/data/1000001/${ordinal}/`),
    classification: "amendment" as const,
    companyName: "界".repeat(300),
    fileNumber: "3".repeat(80),
    filingIdentity: `${accessionNumber}:S-1/A`,
    formType: "S-1/A" as const,
    registrationIdentity:
      `${registrationPrefix}${"r".repeat(128 - registrationPrefix.length)}`,
    source: maxSources[index % maxSources.length]!,
  };
});
const maxOutcome = await stageWorkspaceFinding({
  coverage: maxCoverage,
  envelope: maxEnvelope,
  finding: {
    ...finding,
    artifactRefs: Array.from({ length: 8 }, (_, index) => {
      const prefix = `artifact.maximum.${index}.`;
      return `${prefix}${"a".repeat(160 - prefix.length)}`;
    }),
    factIdentities: maxFacts.map((fact) => fact.filingIdentity),
    facts: maxFacts,
    provenance: maxSources,
    summary: "概".repeat(2_000),
  },
  now,
  scope,
}, findingClient);
assert.equal(maxOutcome.finding?.facts?.length, 40);
const maxOutcomeBytes = Buffer.byteLength(JSON.stringify(maxOutcome), "utf8");
assert.ok(maxOutcomeBytes > 128 * 1_024);
assert.ok(maxOutcomeBytes < 512 * 1_024);
assert.deepEqual(
  await readWorkspaceRunOutcome(scope, maxOccurrenceKey, findingClient),
  maxOutcome,
);
console.info(`Schema-maximum 40-fact outcome: ${maxOutcomeBytes} bytes.`);
const storedOutcomeReader = (candidate: WorkspaceRunOutcome) => ({
  get: async () => JSON.stringify(candidate),
}) as WorkspaceFindingStoreClient;
for (const mismatchedFinding of [
  { ...outcome.finding, ownerId: "other_owner" },
  {
    ...outcome.finding,
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  },
  {
    ...outcome.finding,
    monitorId: "423e4567-e89b-42d3-a456-426614174000",
  },
  { ...outcome.finding, runId: `${outcome.occurrenceKey}:attempt:2` },
]) {
  await assert.rejects(
    readWorkspaceRunOutcome(
      scope,
      outcome.occurrenceKey,
      storedOutcomeReader({ ...outcome, finding: mismatchedFinding }),
    ),
    (error) =>
      error instanceof WorkspaceFindingError && error.code === "finding_invalid",
  );
}
for (const invalidRunId of [
  `${"d".repeat(64)}:attempt:1`,
  `${outcome.occurrenceKey}:attempt:0`,
  `${outcome.occurrenceKey}:attempt:01`,
  `${outcome.occurrenceKey}:attempt:1.5`,
  `${outcome.occurrenceKey}:attempt:9007199254740992`,
  `${outcome.occurrenceKey}:other:1`,
]) {
  await assert.rejects(
    readWorkspaceRunOutcome(
      scope,
      outcome.occurrenceKey,
      storedOutcomeReader({
        ...outcome,
        finding: { ...outcome.finding, runId: invalidRunId },
        runId: invalidRunId,
      }),
    ),
    (error) =>
      error instanceof WorkspaceFindingError && error.code === "finding_invalid",
  );
}
assert.equal(
  workspaceRunAttemptForOccurrence(
    outcome.occurrenceKey,
    `${outcome.occurrenceKey}:attempt:1`,
  ),
  1,
);
assert.equal(
  isPriorWorkspaceRunForRecovery({
    claimedAttempt: 2,
    claimedOccurrenceKey: outcome.occurrenceKey,
    outcomeOccurrenceKey: outcome.occurrenceKey,
    outcomeRunId: `${outcome.occurrenceKey}:attempt:1`,
  }),
  true,
);
for (const rejectedPrior of [
  {
    claimedAttempt: 2,
    claimedOccurrenceKey: outcome.occurrenceKey,
    outcomeOccurrenceKey: outcome.occurrenceKey,
    outcomeRunId: `${outcome.occurrenceKey}:attempt:2`,
  },
  {
    claimedAttempt: 2,
    claimedOccurrenceKey: outcome.occurrenceKey,
    outcomeOccurrenceKey: outcome.occurrenceKey,
    outcomeRunId: `${outcome.occurrenceKey}:attempt:3`,
  },
  {
    claimedAttempt: 2,
    claimedOccurrenceKey: outcome.occurrenceKey,
    outcomeOccurrenceKey: "d".repeat(64),
    outcomeRunId: `${"d".repeat(64)}:attempt:1`,
  },
  {
    claimedAttempt: 2,
    claimedOccurrenceKey: outcome.occurrenceKey,
    outcomeOccurrenceKey: outcome.occurrenceKey,
    outcomeRunId: `${outcome.occurrenceKey}:attempt:not-an-integer`,
  },
]) {
  assert.equal(isPriorWorkspaceRunForRecovery(rejectedPrior), false);
}
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: finding.factIdentities,
    monitorId: monitor.monitorId,
    scope,
  }, findingClient),
  [],
);
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: finding.factIdentities,
    monitorId: monitor.monitorId,
    scope: otherScope,
  }, findingClient),
  finding.factIdentities,
);
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: finding.factIdentities,
    monitorId: "523e4567-e89b-42d3-a456-426614174000",
    scope,
  }, findingClient),
  finding.factIdentities,
);
assert.deepEqual(
  await writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now: new Date(now.getTime() + 1_000) }),
  outcome,
);
await assert.rejects(
  completeWorkspaceRunForWorker({ clients, ctx, environment, now }),
  (error) => error instanceof WorkspaceFindingError && error.code === "finding_conflict",
);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx,
    environment,
    finding: {
      ...finding,
      provenance: [{
        ...finding.provenance[0],
        canonicalUrl: "https://sec.gov.evil.example/fixture-s1.htm",
        origin: "https://sec.gov.evil.example",
      }],
    },
    now,
  }),
  (error) =>
    error instanceof WorkspaceFindingError &&
    error.code === "finding_source_outside_fence",
);
assert.deepEqual(await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, findingClient), outcome);
assert.equal(await readWorkspaceRunOutcome(otherScope, envelope.occurrenceKey, findingClient), null);

const retryRunId = `${"c".repeat(64)}:attempt:2`;
const retryClaimed = {
  ...claimed,
  occurrence: {
    ...claimed.occurrence,
    attempt: 2,
    leaseTokenDigest: "9".repeat(64),
  },
} satisfies ClaimedWorkspaceMonitor;
const retryEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: retryClaimed,
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: retryRunId },
    runId: retryRunId,
    workspace: { ...dispatchBudget.workspace, runId: retryRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
const retryToken = signWorkspaceWorkerEnvelope(retryEnvelope, environment);
const retryCtx = {
  session: { auth: { current: workspaceWorkerExecutionAuth(retryEnvelope, retryToken) } },
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: retryRunId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
await reserveWorkspaceSourceAttempt({
  now,
  runId: retryRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "e".repeat(64),
  now,
  runId: retryRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
assert.deepEqual(
  await writeWorkspaceFindingForWorker({ clients, ctx: retryCtx, environment, finding, now }),
  outcome,
);

const noMatchRunId = `${"f".repeat(64)}:attempt:1`;
const noMatchClaimed = {
  ...claimed,
  occurrence: {
    ...claimed.occurrence,
    leaseTokenDigest: "f".repeat(64),
    occurrenceKey: "f".repeat(64),
  },
} satisfies ClaimedWorkspaceMonitor;
const noMatchDispatchBudget = {
  ...dispatchBudget,
  global: { ...dispatchBudget.global, runId: noMatchRunId },
  runId: noMatchRunId,
  workspace: { ...dispatchBudget.workspace, runId: noMatchRunId },
} satisfies WorkspaceDispatchReservation;
const noMatchEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: noMatchClaimed,
  dispatchBudget: noMatchDispatchBudget,
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
const noMatchToken = signWorkspaceWorkerEnvelope(noMatchEnvelope, environment);
const noMatchCtx = {
  session: { auth: { current: workspaceWorkerExecutionAuth(noMatchEnvelope, noMatchToken) } },
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: noMatchRunId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
await reserveWorkspaceSourceAttempt({
  now,
  runId: noMatchRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "a".repeat(64),
  now,
  runId: noMatchRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
const noMatch = await completeWorkspaceRunForWorker({
  clients,
  ctx: noMatchCtx,
  environment,
  now,
});
assert.equal(noMatch.outcome, "no_match");
assert.equal(noMatch.finding, null);
assert.deepEqual(
  await completeWorkspaceRunForWorker({ clients, ctx: noMatchCtx, environment, now }),
  noMatch,
);
await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx: noMatchCtx, environment, finding, now }),
  (error) => error instanceof WorkspaceFindingError && error.code === "finding_conflict",
);

const interruptedRunId = `${"a".repeat(64)}:attempt:1`;
const interruptedScheduledFor = new Date(now.getTime() + 60_000).toISOString();
const interruptedClaimed = {
  ...claimed,
  occurrence: {
    ...claimed.occurrence,
    leaseTokenDigest: "a".repeat(64),
    occurrenceIdentity: `interval:${interruptedScheduledFor}`,
    occurrenceKey: "a".repeat(64),
    scheduledFor: interruptedScheduledFor,
  },
} satisfies ClaimedWorkspaceMonitor;
const interruptedEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 1,
  claimed: interruptedClaimed,
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: interruptedRunId },
    runId: interruptedRunId,
    workspace: { ...dispatchBudget.workspace, runId: interruptedRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
const interruptedToken = signWorkspaceWorkerEnvelope(interruptedEnvelope, environment);
const interruptedCtx = {
  session: { auth: { current: workspaceWorkerExecutionAuth(interruptedEnvelope, interruptedToken) } },
};
await createWorkspaceSourceCoverage({
  configurationRevision: monitor.configurationRevision,
  monitorId: monitor.monitorId,
  now,
  runId: interruptedRunId,
  scope,
  sources: [{ canonicalUrl: source.canonicalUrl, origin: source.origin, sourceId: source.sourceId }],
  window,
}, coverageClient);
await reserveWorkspaceSourceAttempt({
  now,
  runId: interruptedRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
await markWorkspaceSourceSuccess({
  contentDigest: "8".repeat(64),
  now,
  runId: interruptedRunId,
  scope,
  sourceId: source.sourceId,
}, coverageClient);
const interruptedIdentity = "0001000002-26-000002:S-1";
const interruptedFinding = {
  ...finding,
  factIdentities: [interruptedIdentity],
  facts: [{
    ...finding.facts[0],
    accessionNumber: "0001000002-26-000002",
    canonicalFilingUrl:
      "https://www.sec.gov/Archives/edgar/data/1000002/000100000226000002/fixture-s1-index.htm",
    cik: "0001000002",
    contentEvidence: {
      feedContentHash: "8".repeat(64),
      normalizedFilingHash: "7".repeat(64),
    },
    companyName: "Interrupted Fixture Corp",
    fileNumber: "333-100002",
    filingIdentity: interruptedIdentity,
    registrationIdentity: "0001000002:333-100002",
  }],
  summary: "Interrupted Fixture Corp filed a potential IPO registration on Form S-1.",
};
const completionsBeforeInterruptedCommit = monitorClient.completeCalls;
findingClient.failNextIdentityCommit = true;
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx: interruptedCtx,
    environment,
    finding: interruptedFinding,
    now,
  }),
  /fixture_identity_commit_interrupted/u,
);
assert.equal(
  await readWorkspaceRunOutcome(scope, interruptedEnvelope.occurrenceKey, findingClient),
  null,
);
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: [interruptedIdentity],
    monitorId: monitor.monitorId,
    scope,
  }, findingClient),
  [interruptedIdentity],
);
assert.equal(monitorClient.completeCalls, completionsBeforeInterruptedCommit);
findingClient.forceNextIdentityConflict = true;
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx: interruptedCtx,
    environment,
    finding: interruptedFinding,
    now,
  }),
  (error) =>
    error instanceof WorkspaceFindingError && error.code === "finding_conflict",
);
assert.equal(
  await readWorkspaceRunOutcome(scope, interruptedEnvelope.occurrenceKey, findingClient),
  null,
);
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: [interruptedIdentity],
    monitorId: monitor.monitorId,
    scope,
  }, findingClient),
  [interruptedIdentity],
);
assert.equal(monitorClient.completeCalls, completionsBeforeInterruptedCommit);
const recoveredInterruptedOutcome = await writeWorkspaceFindingForWorker({
  clients,
  ctx: interruptedCtx,
  environment,
  finding: interruptedFinding,
  now,
});
assert.equal(recoveredInterruptedOutcome.outcome, "finding_staged");
assert.deepEqual(
  await selectUnseenWorkspaceFindingIdentities({
    factIdentities: [interruptedIdentity],
    monitorId: monitor.monitorId,
    scope,
  }, findingClient),
  [],
);
assert.equal(monitorClient.completeCalls, completionsBeforeInterruptedCommit + 1);
assert.deepEqual(
  await writeWorkspaceFindingForWorker({
    clients,
    ctx: interruptedCtx,
    environment,
    finding: interruptedFinding,
    now,
  }),
  recoveredInterruptedOutcome,
);
assert.equal(monitorClient.completeCalls, completionsBeforeInterruptedCommit + 1);

const rawMonitor = [...monitorClient.values.entries()][0];
assert.ok(rawMonitor);
monitorClient.values.set(rawMonitor[0], JSON.stringify({
  ...JSON.parse(rawMonitor[1]),
  configurationRevision: monitor.configurationRevision + 1,
}));
await assert.rejects(
  writeWorkspaceFindingForWorker({ clients, ctx, environment, finding, now }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_run_stale",
);

await writeWorkspaceDocument("capabilities", {
  expectedRevision: 1,
  now: new Date(now.getTime() + 2_000),
  scope,
  value: {
    connectionIds: [],
    controlPlaneToolIds: [COMPLETE_WORKSPACE_RUN_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["filesystem.write"],
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: ["fetch_public_source"],
    skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
    sources: [{ origin: source.origin, sourceId: source.sourceId }],
    workerModelPolicy: { allowedModelIds: ["google/gemini-3.6-flash"], maximumOutputTokens: 200 },
  },
}, stateClient);
const deniedRunId = `${"b".repeat(64)}:attempt:1`;
const deniedEnvelope = createWorkspaceWorkerEnvelope({
  budgetRevision: 1,
  capabilityRevision: 2,
  claimed: {
    ...claimed,
    occurrence: {
      ...claimed.occurrence,
      leaseTokenDigest: "b".repeat(64),
      occurrenceKey: "b".repeat(64),
    },
  },
  dispatchBudget: {
    ...dispatchBudget,
    global: { ...dispatchBudget.global, runId: deniedRunId },
    runId: deniedRunId,
    workspace: { ...dispatchBudget.workspace, runId: deniedRunId },
  },
  expiresAt: new Date(now.getTime() + 10 * 60_000),
  issuedAt: now,
  stateRevision: { brief: 1, strategy: 1 },
  strategyPack: null,
  window,
});
const deniedToken = signWorkspaceWorkerEnvelope(deniedEnvelope, environment);
await assert.rejects(
  writeWorkspaceFindingForWorker({
    clients,
    ctx: {
      session: { auth: { current: workspaceWorkerExecutionAuth(deniedEnvelope, deniedToken) } },
    },
    environment,
    finding,
    now,
  }),
  (error) =>
    error instanceof WorkspaceWorkerCommitError &&
    error.code === "workspace_worker_capability_denied",
);

console.info("Scoped workspace finding and completion verification passed.");
