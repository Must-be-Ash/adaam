import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import {
  archivePhotonWorkspace,
  createPhotonWorkspace,
  findPhotonWorkspaceByName,
  getPhotonWorkspaceState,
  PHOTON_WORKSPACE_RETAINED_LIMIT,
} from "../agent/lib/photon-workspace-store.ts";
import {
  createStrategyPackCatalog,
  strategyPackCatalog,
} from "../agent/lib/strategy-pack-catalog.ts";
import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../agent/lib/strategy-pack-reference-catalog.ts";
import {
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_ALLOWED_ORIGINS,
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST,
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_VERSION,
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_ID,
  EARNINGS_CALL_TRANSCRIPTS_SOURCE_URL,
} from "../agent/lib/strategy-pack-reference-catalog.ts";
import {
  requireWorkspaceWorkerStrategyPackRuntime,
  StrategyPackRuntimeError,
} from "../agent/lib/strategy-pack-runtime.ts";
import {
  createStrategyPackWorkspace,
  createStrategyPackWorkspaceFromSelection,
  configureStrategyPackWorkspaceFromSelection,
  deriveEveStrategyPackMutationIdentity,
  mintSpectrumStrategyPackMutationIdentity,
  removeStrategyPackWorkspaceFromSelection,
  StrategyPackServiceError,
  verifySpectrumStrategyPackMutationIdentity,
} from "../agent/lib/strategy-pack-service.ts";
import { StrategyPackTransactionStorageError } from "../agent/lib/strategy-pack-transaction.ts";
import {
  listWorkspaceMonitors,
  prepareWorkspaceMonitorCreate,
  workspaceMonitorRecordStorageKey,
} from "../agent/lib/workspace-monitor-store.ts";
import {
  readWorkspaceDocument,
  workspaceDocumentStorageKey,
} from "../agent/lib/workspace-state-store.ts";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization.ts";
import { migrateSecPublicSourceWorkspace } from "../agent/lib/sec-public-source-migration.ts";
import { generateStrategyPackCatalog } from "./generate-strategy-pack-catalog.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(scriptDirectory, "fixtures", "strategy-packs", "valid");
const references = Object.freeze({
  alertPresentationIds: ["alert.beta/v1", "alert.public-event/v1"],
  capabilityIds: [
    "skill.alpha-playbook",
    "skill.beta-playbook",
    "tool.alpha.fetch",
    "tool.beta.fetch",
  ],
  evalSuites: {
    "eval.alpha/v1": [
      "fixture.alpha.forbidden",
      "fixture.alpha.malformed",
      "fixture.alpha.no-match",
      "fixture.alpha.positive",
      "fixture.alpha.replay",
    ],
    "eval.beta/v1": [
      "fixture.beta.forbidden",
      "fixture.beta.malformed",
      "fixture.beta.no-match",
      "fixture.beta.positive",
      "fixture.beta.replay",
    ],
  },
  findingSchemaIds: ["finding.alpha/v1", "finding.beta/v1"],
  parameterizedSourceContracts: {
    [EARNINGS_CALL_TRANSCRIPTS_SOURCE_ID]: {
      allowedOrigins: EARNINGS_CALL_TRANSCRIPTS_SOURCE_ALLOWED_ORIGINS,
      canonicalUrl: EARNINGS_CALL_TRANSCRIPTS_SOURCE_URL,
      contractDigest: EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_DIGEST,
      contractVersion: EARNINGS_CALL_TRANSCRIPTS_SOURCE_CONTRACT_VERSION,
    },
  },
  sourceContracts: {
    "source.alpha": {
      allowedOrigins: ["https://alpha.example.gov"],
      canonicalUrl: "https://alpha.example.gov/events.json",
      contractDigest: "a".repeat(64),
      contractVersion: "1.0.0",
    },
    "source.beta": {
      allowedOrigins: ["https://beta.example.gov"],
      canonicalUrl: "https://beta.example.gov/notices.atom",
      contractDigest: "b".repeat(64),
      contractVersion: "1.0.0",
    },
  },
});

class MemoryStore {
  failNextCommit = null;
  failNextGet = null;
  getFailures = [];
  readReplayFailures = [];
  indexes = new Map();
  values = new Map();
  due = new Map();

  async compareAndSet(key, expected, next, approvalGuardKey) {
    if (approvalGuardKey && this.values.has(approvalGuardKey)) return "blocked";
    if ((this.values.get(key) ?? null) !== expected) return "conflict";
    this.values.set(key, next);
    return "swapped";
  }

  async get(key) {
    const queuedFailure = this.getFailures.shift();
    if (queuedFailure) throw queuedFailure;
    if (this.failNextGet) {
      const error = this.failNextGet;
      this.failNextGet = null;
      throw error;
    }
    return this.values.get(key) ?? null;
  }

  async list(indexKey) {
    return [...(this.indexes.get(indexKey) ?? [])].map((key) => this.values.get(key));
  }

  async set(key, value, options) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async readReplay(input) {
    const failure = this.readReplayFailures.shift();
    if (failure) throw failure;
    if (this.values.has(input.approvalGuardKey)) return { status: "blocked" };
    const mapping = this.values.get(input.mappingKey);
    if (mapping === undefined) return { status: "missing" };
    if (mapping !== input.mappingRaw) return { status: "payload_conflict" };
    const receipt = this.values.get(input.receiptKey);
    return receipt === undefined
      ? { status: "corrupt" }
      : { receiptRaw: receipt, status: "replayed" };
  }

  async commitCreate(input) {
    if (this.failNextCommit) {
      const error = this.failNextCommit === true
        ? new Error("injected_transaction_failure")
        : this.failNextCommit;
      this.failNextCommit = null;
      throw error;
    }
    const replay = await this.readReplay(input);
    if (replay.status !== "missing") return replay;
    if ((this.values.get(input.registryKey) ?? null) !== input.expectedRegistryRaw) {
      return { status: "conflict" };
    }
    if (JSON.parse(input.expectedRegistryRaw).revision !== input.expectedRegistryRevision) {
      return { status: "conflict" };
    }
    if (
      this.values.has(input.receiptKey) ||
      input.records.some(({ key }) => this.values.has(key)) ||
      input.monitors.some(({ recordKey }) => this.values.has(recordKey))
    ) {
      return { status: "conflict" };
    }
    const values = new Map(this.values);
    const indexes = new Map(
      [...this.indexes].map(([key, members]) => [key, new Set(members)]),
    );
    const due = new Map(this.due);
    if (input.nextRegistryRaw !== null) values.set(input.registryKey, input.nextRegistryRaw);
    for (const record of input.records) values.set(record.key, record.raw);
    for (const monitor of input.monitors) {
      values.set(monitor.recordKey, monitor.raw);
      const members = indexes.get(monitor.workspaceIndexKey) ?? new Set();
      members.add(monitor.recordKey);
      indexes.set(monitor.workspaceIndexKey, members);
      if (monitor.dueAtMs !== null) due.set(monitor.recordKey, monitor.dueAtMs);
    }
    values.set(input.mappingKey, input.mappingRaw);
    values.set(input.receiptKey, input.receiptRaw);
    this.values = values;
    this.indexes = indexes;
    this.due = due;
    return { receiptRaw: input.receiptRaw, status: "committed" };
  }

  async commitLifecycle(input) {
    if (this.failNextCommit) {
      const error = this.failNextCommit === true
        ? new Error("injected_transaction_failure")
        : this.failNextCommit;
      this.failNextCommit = null;
      throw error;
    }
    const replay = await this.readReplay(input);
    if (replay.status !== "missing") return replay;
    if (
      (this.values.get(input.registryKey) ?? null) !== input.expectedRegistryRaw ||
      JSON.parse(input.expectedRegistryRaw).revision !== input.expectedRegistryRevision ||
      this.values.has(input.receiptKey) ||
      input.records.some(({ expectedRaw, key }) => this.values.get(key) !== expectedRaw) ||
      input.monitors.some(({ expectedRaw, recordKey }) => this.values.get(recordKey) !== expectedRaw)
    ) {
      return { status: "conflict" };
    }
    const values = new Map(this.values);
    const due = new Map(this.due);
    values.set(input.registryKey, input.nextRegistryRaw);
    for (const record of input.records) values.set(record.key, record.nextRaw);
    for (const monitor of input.monitors) {
      values.set(monitor.recordKey, monitor.nextRaw);
      if (monitor.dueAtMs === null) due.delete(monitor.recordKey);
      else due.set(monitor.recordKey, monitor.dueAtMs);
    }
    values.set(input.mappingKey, input.mappingRaw);
    values.set(input.receiptKey, input.receiptRaw);
    this.values = values;
    this.due = due;
    return { receiptRaw: input.receiptRaw, status: "committed" };
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
  EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
const routing = {
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread",
};
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "eve-pack-mutations-"));

try {
  const generated = await generateStrategyPackCatalog({
    outputPath: resolve(temporaryRoot, "catalog.generated.ts"),
    packRoot: fixtureRoot,
    references,
  });
  const catalog = createStrategyPackCatalog(generated.entries);
  const alpha = catalog.resolve({ id: "alpha-pack", version: "1.0.0" });
  assert.ok(alpha);
  const client = new MemoryStore();
  const initial = await getPhotonWorkspaceState(routing, client);
  const identity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"1".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_create_alpha",
    turnId: "turn_create_alpha",
  });
  const request = {
    activateMonitorResourceIds: ["detect-alpha"],
    configuration: {
      dailyTimes: ["09:00", "16:00"],
      selectedIssuerCiks: ["0000789019", "0001326801"],
      timezone: "America/Vancouver",
    },
    expectedRegistryRevision: initial.revision,
    name: "Alpha Research",
    pack: {
      contentDigest: alpha.contentDigest,
      id: alpha.id,
      version: alpha.version,
    },
  };
  /*
   * A managed monitor names its delivery subscription, but naming one does not
   * create it. Only the interactive monitor tools ever wrote that record, so a
   * pack installed from the session manager produced monitors that commit
   * findings and then cannot resolve a subscription to deliver them - fatal on
   * a fresh fork where no interactive tool has run. Installing must ensure it.
   */
  const alertSubscriptions = [];
  const dependencies = {
    alertDeliverySubscription: async (input) => {
      alertSubscriptions.push(input);
    },
    budgetCeilings: {
      maximumInputTokensPerDay: 15_000,
      maximumInputTokensPerRun: 9_000,
      maximumOutputTokensPerDay: 3_000,
      maximumOutputTokensPerRun: 1_500,
      maximumScheduledRunsPerDay: 3,
    },
    capabilityInventory: [{ category: "research", id: "tool.alpha.fetch" }],
    catalog,
    environment,
    idFactory: (() => {
      let value = 0;
      return () => `${++value}23e4567-e89b-42d3-a456-426614174000`;
    })(),
    monitorClient: client,
    observationSink() {},
    stateClient: client,
    transactionClient: client,
    workspaceClient: client,
  };
  const first = await createStrategyPackWorkspace({
    ...routing,
    now: new Date("2026-08-15T17:00:00.000Z"),
    request,
    requestIdentity: identity,
    sourceAssignment: {
      generation: initial.activeWorkspace.generation,
      workspaceId: initial.activeWorkspace.id,
    },
  }, dependencies);
  assert.equal(first.replayed, false);
  assert.equal(first.receipt.outcome, "created");
  assert.equal(
    alertSubscriptions.length,
    1,
    "installing a pack must ensure the delivery subscription its monitors name",
  );
  assert.equal(
    alertSubscriptions[0].subscriptionId,
    alertSubscriptions[0].conversationId,
    "the subscription is the owner conversation the monitor is bound to",
  );
  assert.equal(alertSubscriptions[0].principalId, routing.principalId);
  assert.equal(alertSubscriptions[0].threadId, routing.threadId);
  assert.equal(first.receipt.targetWorkspaceId, "123e4567-e89b-42d3-a456-426614174000");
  const afterCreate = await getPhotonWorkspaceState(routing, client);
  assert.equal(afterCreate.activeWorkspace.id, first.receipt.targetWorkspaceId);
  assert.equal(afterCreate.revision, 1);
  assert.equal(afterCreate.workspaces.length, 2);

  const targetScope = authorizeDeploymentWorkspaceStore({
    ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
    workspaceId: first.receipt.targetWorkspaceId,
  }, environment);
  const [brief, budget, capabilities, strategy] = await Promise.all([
    readWorkspaceDocument("brief", targetScope, client),
    readWorkspaceDocument("budget", targetScope, client),
    readWorkspaceDocument("capabilities", targetScope, client),
    readWorkspaceDocument("strategy", targetScope, client),
  ]);
  assert.equal(brief?.revision, 1);
  assert.equal(budget?.revision, 1);
  assert.equal(budget?.value.maximumInputTokensPerDay, 15_000);
  assert.equal(budget?.value.maximumInputTokensPerRun, 9_000);
  assert.equal(budget?.value.maximumOutputTokensPerRun, 1_500);
  assert.equal(budget?.value.maximumScheduledRunsPerDay, 3);
  assert.equal(capabilities?.revision, 1);
  assert.equal(strategy?.schemaVersion, 2);
  assert.equal(strategy?.revision, 1);
  assert.equal(strategy?.value.bindingRevision, 1);
  assert.equal(strategy?.value.pendingSnapshot?.workspaceGeneration, 1);
  assert.equal(strategy?.value.pack?.contentDigest, alpha.contentDigest);
  assert.deepEqual(capabilities?.value.sources[0], {
    allowedOrigins: ["https://alpha.example.gov"],
    contractDigest: "a".repeat(64),
    contractVersion: "1.0.0",
    origin: "https://alpha.example.gov",
    sourceId: "source.alpha",
  });
  assert.deepEqual(
    capabilities?.value.sources.slice(1).map(({ sourceId }) => sourceId),
    [],
  );
  const monitors = await listWorkspaceMonitors(targetScope, client);
  assert.equal(monitors.length, 1);
  assert.equal(monitors[0].lifecycleState, "enabled");
  assert.equal(monitors[0].tighteningLimits.inputTokensPerRun, 9_000);
  assert.equal(monitors[0].tighteningLimits.outputTokensPerRun, 1_500);
  assert.deepEqual(monitors[0].schedule, {
    kind: "daily_local",
    times: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  });
  assert.equal(client.due.size, 1);

  const replay = await createStrategyPackWorkspace({
    ...routing,
    now: new Date("2026-08-15T17:01:00.000Z"),
    request,
    requestIdentity: identity,
    sourceAssignment: {
      generation: initial.activeWorkspace.generation,
      workspaceId: initial.activeWorkspace.id,
    },
  }, dependencies);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal((await getPhotonWorkspaceState(routing, client)).workspaces.length, 2);

  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request,
      requestIdentity: identity,
      sourceAssignment: {
        generation: afterCreate.activeWorkspace.generation,
        workspaceId: afterCreate.activeWorkspace.id,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_mutation_payload_conflict",
  );

  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: { ...request, name: "Different Payload" },
      requestIdentity: identity,
      sourceAssignment: {
        generation: initial.activeWorkspace.generation,
        workspaceId: initial.activeWorkspace.id,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_mutation_payload_conflict",
  );

  const installOnlyIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"2".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_install_only",
    turnId: "turn_install_only",
  });
  const installOnly = await createStrategyPackWorkspace({
    ...routing,
    now: new Date("2026-08-15T17:02:00.000Z"),
    request: {
      ...request,
      activateMonitorResourceIds: [],
      expectedRegistryRevision: afterCreate.revision,
      name: "Alpha Install Only",
    },
    requestIdentity: installOnlyIdentity,
    sourceAssignment: {
      generation: initial.activeWorkspace.generation,
      workspaceId: initial.activeWorkspace.id,
    },
  }, dependencies);
  const installOnlyScope = authorizeDeploymentWorkspaceStore({
    ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
    workspaceId: installOnly.receipt.targetWorkspaceId,
  }, environment);
  assert.equal((await listWorkspaceMonitors(installOnlyScope, client))[0].lifecycleState, "paused");

  const beforeInvalid = client.values.size;
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "Forged Digest",
        pack: { ...request.pack, contentDigest: "f".repeat(64) },
      },
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"3".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_forged",
        turnId: "turn_forged",
      }),
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_unavailable",
  );
  assert.equal(client.values.size, beforeInvalid);

  let invalidOrdinal = 10;
  const assertInvalidWithoutPersistence = async ({
    code,
    dependenciesOverride = {},
    requestOverride,
  }) => {
    const before = {
      due: new Map(client.due),
      indexes: new Map([...client.indexes].map(([key, value]) => [key, new Set(value)])),
      values: new Map(client.values),
    };
    invalidOrdinal += 1;
    await assert.rejects(
      createStrategyPackWorkspace({
        ...routing,
        request: requestOverride,
        requestIdentity: deriveEveStrategyPackMutationIdentity({
          ingressId: `ingress_${String(invalidOrdinal).padStart(64, "0")}`,
          operationOrdinal: 0,
          stepId: `step_invalid_${invalidOrdinal}`,
          turnId: `turn_invalid_${invalidOrdinal}`,
        }),
        sourceAssignment: { generation: 1, workspaceId: installOnly.receipt.targetWorkspaceId },
      },
      { ...dependencies, ...dependenciesOverride },
      ),
      (error) => error instanceof StrategyPackServiceError && error.code === code,
    );
    assert.deepEqual(client.values, before.values);
    assert.deepEqual(client.indexes, before.indexes);
    assert.deepEqual(client.due, before.due);
  };

  await assertInvalidWithoutPersistence({
    code: "strategy_pack_unavailable",
    requestOverride: {
      ...request,
      expectedRegistryRevision: 2,
      name: "Wrong Version",
      pack: { ...request.pack, version: "9.9.9" },
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_invalid_request",
    requestOverride: {
      ...request,
      configuration: { ...request.configuration, unknownField: true },
      expectedRegistryRevision: 2,
      name: "Unknown Configuration",
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_invalid_request",
    requestOverride: {
      ...request,
      configuration: undefined,
      expectedRegistryRevision: 2,
      name: "Implicit Schedule",
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_invalid_request",
    requestOverride: {
      ...request,
      configuration: { ...request.configuration, padding: "x".repeat(20_000) },
      expectedRegistryRevision: 2,
      name: "Oversized Request",
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_invalid_request",
    requestOverride: {
      ...request,
      expectedRegistryRevision: 2,
      name: "Inverse Cramer Lifecycle Acceptance 20260821",
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_authority_expansion",
    dependenciesOverride: {
      capabilityInventory: [{ category: "financial", id: "tool.alpha.fetch" }],
    },
    requestOverride: {
      ...request,
      expectedRegistryRevision: 2,
      name: "Authority Expansion",
    },
  });
  await assertInvalidWithoutPersistence({
    code: "strategy_pack_mutation_conflict",
    requestOverride: {
      ...request,
      expectedRegistryRevision: 1,
      name: "Stale Revision",
    },
  });

  const guardKey = photonApprovalGuardKey(routing);
  client.values.set(guardKey, "pending-approval");
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: { invalid: true },
      requestIdentity: { invalid: true },
      sourceAssignment: { generation: 1, workspaceId: installOnly.receipt.targetWorkspaceId },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_financial_approval_pending",
  );
  client.values.delete(guardKey);

  const failureIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"4".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_failure",
    turnId: "turn_failure",
  });
  const beforeFailure = new Map(client.values);
  client.failNextCommit = new Error(
    'ERR rate limit exceeded, command was: ["EVAL","owner-private"]',
  );
  client.readReplayFailures.push(null, new Error(
    'ERR connection unavailable, command was: ["EVAL","owner-private"]',
  ));
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "Atomic Failure",
      },
      requestIdentity: failureIdentity,
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackTransactionStorageError &&
      error.providerReasonCode === "rate_limited" &&
      error.message === "Strategy pack transaction storage failed." &&
      !error.message.includes("owner-private"),
  );
  assert.deepEqual(client.values, beforeFailure);

  client.failNextGet = new Error(
    'ERR max request size exceeded, command was: ["GET","owner-private"]',
  );
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "Initial Storage Read Failure",
      },
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"5".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_initial_storage_read_failure",
        turnId: "turn_initial_storage_read_failure",
      }),
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackTransactionStorageError &&
      error.providerReasonCode === "request_too_large",
  );

  client.readReplayFailures.push(new Error(
    'ERR WRONGTYPE Operation against a key, command was: ["EVAL","owner-private"]',
  ));
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "Initial Replay Read Failure",
      },
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"6".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_initial_replay_read_failure",
        turnId: "turn_initial_replay_read_failure",
      }),
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackTransactionStorageError &&
      error.providerReasonCode === "wrong_type",
  );

  client.getFailures.push(null, new Error(
    'ERR upstream unavailable, command was: ["GET","owner-private"]',
  ));
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "Registry Storage Read Failure",
      },
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"7".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_registry_storage_read_failure",
        turnId: "turn_registry_storage_read_failure",
      }),
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies),
    (error) => error instanceof StrategyPackTransactionStorageError &&
      error.providerReasonCode === "upstream_unavailable",
  );

  const spectrumSecret = "spectrum-secret-".repeat(4);
  const duplicateIdentity = verifySpectrumStrategyPackMutationIdentity(
    mintSpectrumStrategyPackMutationIdentity({
      actionId: "action_duplicate",
      expectedRegistryRevision: 2,
      issuedAt: new Date("2026-08-15T17:03:00.000Z"),
      nonce: "nonce_duplicate_123456789",
      principalId: routing.principalId,
      sourceWorkspaceGeneration: 1,
      sourceWorkspaceId: installOnly.receipt.targetWorkspaceId,
      threadId: routing.threadId,
    }, spectrumSecret),
    spectrumSecret,
    new Date("2026-08-15T17:03:01.000Z"),
  );
  await assert.rejects(
    async () => verifySpectrumStrategyPackMutationIdentity(
      { ...duplicateIdentity, signature: "0".repeat(64) },
      spectrumSecret,
      new Date("2026-08-15T17:03:01.000Z"),
    ),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_invalid_request",
  );
  await assert.rejects(
    async () => verifySpectrumStrategyPackMutationIdentity(
      duplicateIdentity,
      spectrumSecret,
      new Date("2026-08-15T17:19:01.000Z"),
    ),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_invalid_request",
  );
  const duplicate = await createStrategyPackWorkspace({
    ...routing,
    request: {
      ...request,
      expectedRegistryRevision: 2,
      name: "  alpha   research  ",
    },
    requestIdentity: duplicateIdentity,
    sourceAssignment: {
      generation: 1,
      workspaceId: installOnly.receipt.targetWorkspaceId,
    },
  }, dependencies);
  assert.equal(duplicate.receipt.outcome, "rejected");
  assert.equal(duplicate.receipt.rejectionCode, "duplicate_name");
  assert.equal(duplicate.receipt.targetWorkspaceId, null);
  assert.deepEqual(
    (await createStrategyPackWorkspace({
      ...routing,
      request: {
        ...request,
        expectedRegistryRevision: 2,
        name: "  alpha   research  ",
      },
      requestIdentity: duplicateIdentity,
      sourceAssignment: {
        generation: 1,
        workspaceId: installOnly.receipt.targetWorkspaceId,
      },
    }, dependencies)).receipt,
    duplicate.receipt,
  );

  const ownerMonitor = prepareWorkspaceMonitorCreate({
    deliverySubscriptionId: "owner-delivery",
    instruction: "Owner-created monitor must survive pack lifecycle changes.",
    name: "Owner monitor",
    nextOccurrenceAt: null,
    now: new Date("2026-08-15T17:04:00.000Z"),
    schedule: { at: "2026-08-16T17:04:00.000Z", kind: "one_time" },
    scope: targetScope,
    sources: [{
      accessClassification: "public",
      canonicalUrl: "https://owner.example.test/events",
      origin: "https://owner.example.test",
      sourceId: "owner.source",
    }],
  });
  client.values.set(ownerMonitor.recordKey, ownerMonitor.raw);
  const ownerIndex = client.indexes.get(ownerMonitor.workspaceIndexKey) ?? new Set();
  ownerIndex.add(ownerMonitor.recordKey);
  client.indexes.set(ownerMonitor.workspaceIndexKey, ownerIndex);
  const evidenceKeys = ["finding", "checkpoint", "alert", "audit"].map(
    (kind) => `evidence:${kind}:${first.receipt.targetWorkspaceId}`,
  );
  for (const key of evidenceKeys) client.values.set(key, `preserved-${key}`);

  const managedBeforeConfigure = (await listWorkspaceMonitors(targetScope, client))
    .find((monitor) => monitor.managedBy);
  const leasedSnapshot = {
    ...strategy.value.pendingSnapshot,
    resourceId: managedBeforeConfigure.managedBy.resourceId,
  };
  const managedRecordKey = [...client.indexes.values()]
    .flatMap((members) => [...members])
    .find((key) => key.endsWith(`:${managedBeforeConfigure.monitorId}`));
  const exactManagedRaw = client.values.get(managedRecordKey);
  const mismatchedManaged = JSON.parse(exactManagedRaw);
  mismatchedManaged.managedBy.resourceId = "wrong-resource";
  client.values.set(managedRecordKey, JSON.stringify(mismatchedManaged));
  await assert.rejects(
    configureStrategyPackWorkspaceFromSelection({
      ...routing,
      confirmedConsequences: true,
      configuration: { dailyTimes: ["08:30"] },
      expectedBindingRevision: 1,
      expectedRegistryRevision: 2,
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"6".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_provenance_mismatch",
        turnId: "turn_provenance_mismatch",
      }),
      sourceAssignment: { generation: 1, workspaceId: first.receipt.targetWorkspaceId },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_unavailable",
  );
  client.values.set(managedRecordKey, exactManagedRaw);

  const configureIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"7".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_configure_alpha",
    turnId: "turn_configure_alpha",
  });
  const configured = await configureStrategyPackWorkspaceFromSelection({
    ...routing,
    confirmedConsequences: true,
    configuration: {
      dailyTimes: ["08:30"],
      selectedIssuerCiks: ["0000019617", "0001048911"],
      timezone: "America/Vancouver",
    },
    expectedBindingRevision: 1,
    expectedRegistryRevision: 2,
    now: new Date("2026-08-15T17:05:00.000Z"),
    requestIdentity: configureIdentity,
    sourceAssignment: { generation: 1, workspaceId: first.receipt.targetWorkspaceId },
  }, dependencies);
  assert.equal(configured.receipt.outcome, "configured");
  assert.equal(configured.receipt.bindingRevision, 2);
  const configuredState = await getPhotonWorkspaceState(routing, client);
  const configuredWorkspace = configuredState.workspaces.find(
    ({ id }) => id === first.receipt.targetWorkspaceId,
  );
  assert.equal(configuredState.revision, 3);
  assert.equal(configuredWorkspace.generation, 2);
  const configuredStrategy = await readWorkspaceDocument("strategy", targetScope, client);
  assert.equal(configuredStrategy.value.bindingRevision, 2);
  assert.equal(configuredStrategy.value.pendingSnapshot.workspaceGeneration, 2);
  assert.equal(configuredStrategy.value.effectiveCapabilityManifestRevision, 2);
  assert.equal(configuredStrategy.value.pendingSnapshot.capabilityManifestRevision, 2);
  const configuredCapabilities = await readWorkspaceDocument("capabilities", targetScope, client);
  assert.equal(configuredCapabilities.revision, 2);
  assert.deepEqual(
    configuredCapabilities.value.sources.slice(1).map(({ sourceId }) => sourceId),
    ["earnings-call-transcripts.0000019617"],
  );
  const configuredBrief = await readWorkspaceDocument("brief", targetScope, client);
  assert.ok(configuredBrief.value.sourcePolicy.allowedSourceIds.includes(
    "earnings-call-transcripts.0000019617",
  ));
  assert.ok(!configuredBrief.value.sourcePolicy.allowedSourceIds.includes(
    "earnings-call-transcripts.0001326801",
  ));
  const configuredMonitors = await listWorkspaceMonitors(targetScope, client);
  const configuredManaged = configuredMonitors.find((monitor) => monitor.managedBy);
  assert.equal(configuredManaged.lifecycleState, "paused");
  assert.equal(configuredManaged.pauseReason, "strategy_pack_configuration");
  assert.equal(configuredManaged.managedBy.bindingRevision, 2);
  assert.deepEqual(configuredManaged.schedule.times, ["08:30"]);
  await assert.rejects(
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 1,
        sources: managedBeforeConfigure.sources,
        strategyPack: leasedSnapshot,
      },
      environment,
      monitor: managedBeforeConfigure,
      scope: targetScope,
      stateClient: client,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_stale",
  );
  assert.equal(client.due.has(ownerMonitor.recordKey), false);
  assert.deepEqual(
    (await configureStrategyPackWorkspaceFromSelection({
      ...routing,
      confirmedConsequences: true,
      configuration: {
        dailyTimes: ["08:30"],
        selectedIssuerCiks: ["0000019617", "0001048911"],
        timezone: "America/Vancouver",
      },
      expectedBindingRevision: 1,
      expectedRegistryRevision: 2,
      requestIdentity: configureIdentity,
      sourceAssignment: { generation: 1, workspaceId: first.receipt.targetWorkspaceId },
    }, dependencies)).receipt,
    configured.receipt,
  );
  await assert.rejects(
    configureStrategyPackWorkspaceFromSelection({
      ...routing,
      confirmedConsequences: true,
      configuration: { dailyTimes: ["10:00"] },
      expectedBindingRevision: 1,
      expectedRegistryRevision: 2,
      requestIdentity: configureIdentity,
      sourceAssignment: { generation: 1, workspaceId: first.receipt.targetWorkspaceId },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError &&
      error.code === "strategy_pack_mutation_payload_conflict",
  );

  const beforeLifecycleFailure = {
    due: new Map(client.due),
    indexes: new Map([...client.indexes].map(([key, value]) => [key, new Set(value)])),
    values: new Map(client.values),
  };
  client.failNextCommit = true;
  await assert.rejects(
    removeStrategyPackWorkspaceFromSelection({
      ...routing,
      confirmedConsequences: true,
      expectedBindingRevision: 2,
      expectedRegistryRevision: 3,
      requestIdentity: deriveEveStrategyPackMutationIdentity({
        ingressId: `ingress_${"8".repeat(64)}`,
        operationOrdinal: 0,
        stepId: "step_remove_failure",
        turnId: "turn_remove_failure",
      }),
      sourceAssignment: { generation: 2, workspaceId: first.receipt.targetWorkspaceId },
    }, dependencies),
    /injected_transaction_failure/u,
  );
  assert.deepEqual(client.values, beforeLifecycleFailure.values);
  assert.deepEqual(client.indexes, beforeLifecycleFailure.indexes);
  assert.deepEqual(client.due, beforeLifecycleFailure.due);

  const removeIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"9".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_remove_alpha",
    turnId: "turn_remove_alpha",
  });
  const removed = await removeStrategyPackWorkspaceFromSelection({
    ...routing,
    confirmedConsequences: true,
    expectedBindingRevision: 2,
    expectedRegistryRevision: 3,
    now: new Date("2026-08-15T17:06:00.000Z"),
    requestIdentity: removeIdentity,
    sourceAssignment: { generation: 2, workspaceId: first.receipt.targetWorkspaceId },
  }, dependencies);
  assert.equal(removed.receipt.outcome, "removed");
  assert.equal(removed.receipt.bindingRevision, 3);
  const removedState = await getPhotonWorkspaceState(routing, client);
  assert.equal(removedState.revision, 4);
  assert.equal(
    removedState.workspaces.find(({ id }) => id === first.receipt.targetWorkspaceId).generation,
    3,
  );
  const [removedStrategy, removedCapabilities, removedBrief] = await Promise.all([
    readWorkspaceDocument("strategy", targetScope, client),
    readWorkspaceDocument("capabilities", targetScope, client),
    readWorkspaceDocument("brief", targetScope, client),
  ]);
  assert.equal(removedStrategy.value.lifecycleState, "unbound");
  assert.equal(removedStrategy.value.lastActiveSnapshot.bindingRevision, 2);
  assert.deepEqual(removedCapabilities.value.researchToolIds, []);
  assert.deepEqual(removedCapabilities.value.sources, []);
  assert.deepEqual(removedBrief.value.sourcePolicy.allowedSourceIds, []);
  const removedMonitors = await listWorkspaceMonitors(targetScope, client);
  assert.equal(removedMonitors.find((monitor) => monitor.managedBy).lifecycleState, "retired");
  assert.equal(removedMonitors.find((monitor) => monitor.managedBy === null).name, "Owner monitor");
  for (const key of evidenceKeys) assert.equal(client.values.get(key), `preserved-${key}`);
  assert.deepEqual(
    (await removeStrategyPackWorkspaceFromSelection({
      ...routing,
      confirmedConsequences: true,
      expectedBindingRevision: 2,
      expectedRegistryRevision: 3,
      requestIdentity: removeIdentity,
      sourceAssignment: { generation: 2, workspaceId: first.receipt.targetWorkspaceId },
    }, dependencies)).receipt,
    removed.receipt,
  );

  let state = await getPhotonWorkspaceState(routing, client);
  while (state.workspaces.length < 12) {
    state = await createPhotonWorkspace({
      ...routing,
      expectedRevision: state.revision,
      name: `Capacity ${state.workspaces.length}`,
    }, client);
  }
  const capacity = await createStrategyPackWorkspace({
    ...routing,
    request: {
      ...request,
      expectedRegistryRevision: state.revision,
      name: "Over Capacity",
    },
    requestIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId: `ingress_${"6".repeat(64)}`,
      operationOrdinal: 0,
      stepId: "step_capacity",
      turnId: "turn_capacity",
    }),
    sourceAssignment: {
      generation: state.activeWorkspace.generation,
      workspaceId: state.activeWorkspace.id,
    },
  }, dependencies);
  assert.equal(capacity.receipt.outcome, "rejected");
  assert.equal(capacity.receipt.rejectionCode, "capacity_exhausted");
  assert.equal((await getPhotonWorkspaceState(routing, client)).workspaces.length, 12);

  const retainedClient = new MemoryStore();
  let retainedState = await getPhotonWorkspaceState(routing, retainedClient);
  while (retainedState.workspaces.length < PHOTON_WORKSPACE_RETAINED_LIMIT) {
    const name = `Retained ${retainedState.workspaces.length}`;
    retainedState = await createPhotonWorkspace({
      ...routing,
      expectedRevision: retainedState.revision,
      name,
    }, retainedClient);
    const createdWorkspace = findPhotonWorkspaceByName(retainedState, name);
    assert.ok(createdWorkspace);
    retainedState = await archivePhotonWorkspace({
      ...routing,
      expectedRevision: retainedState.revision,
      workspaceId: createdWorkspace.id,
    }, retainedClient);
  }
  const retainedDependencies = {
    ...dependencies,
    monitorClient: retainedClient,
    stateClient: retainedClient,
    transactionClient: retainedClient,
    workspaceClient: retainedClient,
  };
  const retainedCapacity = await createStrategyPackWorkspace({
    ...routing,
    request: {
      ...request,
      expectedRegistryRevision: retainedState.revision,
      name: "Retained Capacity",
    },
    requestIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId: `ingress_${"8".repeat(64)}`,
      operationOrdinal: 0,
      stepId: "step_retained_capacity",
      turnId: "turn_retained_capacity",
    }),
    sourceAssignment: {
      generation: retainedState.activeWorkspace.generation,
      workspaceId: retainedState.activeWorkspace.id,
    },
  }, retainedDependencies);
  assert.equal(retainedCapacity.receipt.outcome, "rejected");
  assert.equal(
    retainedCapacity.receipt.rejectionCode,
    "retained_capacity_exhausted",
  );
  const retainedStateAfterRejection = await getPhotonWorkspaceState(
    routing,
    retainedClient,
  );
  assert.equal(
    retainedStateAfterRejection.workspaces.length,
    PHOTON_WORKSPACE_RETAINED_LIMIT,
  );
  assert.equal(
    retainedStateAfterRejection.workspaces.filter(
      ({ status }) => status === "archived",
    ).length,
    PHOTON_WORKSPACE_RETAINED_LIMIT - 1,
  );

  const ipoClient = new MemoryStore();
  const ipoInitial = await getPhotonWorkspaceState(routing, ipoClient);
  const ipoIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"7".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "call_create_ipo_session",
    turnId: "turn_create_ipo_session",
  });
  const ipoAlertSubscriptions = [];
  const ipoDependencies = {
    alertDeliverySubscription: async (input) => {
      ipoAlertSubscriptions.push(input);
    },
    capabilityInventory: STRATEGY_PACK_CAPABILITY_INVENTORY,
    catalog: strategyPackCatalog,
    environment,
    idFactory: (() => {
      const ids = [
        "723e4567-e89b-42d3-a456-426614174000",
        "823e4567-e89b-42d3-a456-426614174000",
        "923e4567-e89b-42d3-a456-426614174000",
        "a23e4567-e89b-42d3-a456-426614174000",
      ];
      return () => ids.shift() ?? "b23e4567-e89b-42d3-a456-426614174000";
    })(),
    observationSink() {},
    transactionClient: ipoClient,
    workspaceClient: ipoClient,
  };
  const ipoCreateInput = {
    activateMonitorResourceIds: ["detect-new-s1"],
    configuration: {
      dailyTimes: ["09:00", "16:00"],
      timezone: "America/Vancouver",
    },
    expectedRegistryRevision: ipoInitial.revision,
    name: "IPO Filings",
    now: new Date("2026-08-15T18:00:00.000Z"),
    packId: "ipo-filings",
    packVersion: "1.0.0",
    principalId: routing.principalId,
    requestIdentity: ipoIdentity,
    sourceAssignment: {
      generation: ipoInitial.activeWorkspace.generation,
      workspaceId: ipoInitial.activeWorkspace.id,
    },
    threadId: routing.threadId,
  };
  const ipoCreated = await createStrategyPackWorkspaceFromSelection(
    ipoCreateInput,
    ipoDependencies,
  );
  const ipoReplay = await createStrategyPackWorkspaceFromSelection(
    ipoCreateInput,
    ipoDependencies,
  );
  assert.equal(ipoCreated.replayed, false);
  assert.equal(ipoReplay.replayed, true);
  assert.deepEqual(ipoReplay.receipt, ipoCreated.receipt);
  const ipoState = await getPhotonWorkspaceState(routing, ipoClient);
  assert.equal(ipoState.workspaces.length, 2);
  assert.equal(ipoState.activeWorkspace.id, ipoCreated.receipt.targetWorkspaceId);
  assert.equal(
    ipoState.workspaces.some(({ id }) => id === ipoInitial.activeWorkspace.id),
    true,
  );
  const ipoScope = authorizeDeploymentWorkspaceStore({
    ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
    workspaceId: ipoCreated.receipt.targetWorkspaceId,
  }, environment);
  const [ipoStrategy, ipoMonitors] = await Promise.all([
    readWorkspaceDocument("strategy", ipoScope, ipoClient),
    listWorkspaceMonitors(ipoScope, ipoClient),
  ]);
  assert.equal(ipoStrategy?.schemaVersion, 2);
  assert.equal(ipoStrategy?.value.pack?.id, "ipo-filings");
  assert.equal(ipoStrategy?.value.pack?.version, "1.0.0");
  assert.equal(ipoMonitors.length, 1);
  assert.equal(ipoMonitors[0]?.lifecycleState, "enabled");
  assert.match(
    ipoMonitors[0]?.deliverySubscriptionId ?? "",
    /^conversation_[a-f0-9]{64}$/u,
  );
  assert.equal(
    ipoStrategy?.value.managedResources["detect-new-s1"]
      ?.publicSourceSubscriptions?.[0]?.sourceInstanceId,
    "source.sec-latest-s1-filings",
  );
  assert.equal(
    ipoMonitors[0]?.publicSourceSubscriptions?.[0]?.subscriptionId,
    ipoStrategy?.value.managedResources["detect-new-s1"]
      ?.publicSourceSubscriptions?.[0]?.subscriptionId,
  );
  assert.deepEqual(ipoMonitors[0]?.schedule, {
    kind: "daily_local",
    times: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  });
  const strategyKey = workspaceDocumentStorageKey("strategy", ipoScope);
  const monitorKey = workspaceMonitorRecordStorageKey(
    ipoScope,
    ipoMonitors[0].monitorId,
  );
  const legacyStrategy = JSON.parse(ipoClient.values.get(strategyKey));
  const legacyMonitor = JSON.parse(ipoClient.values.get(monitorKey));
  delete legacyStrategy.value.managedResources["detect-new-s1"]
    .publicSourceSubscriptions;
  delete legacyMonitor.publicSourceSubscriptions;
  ipoClient.values.set(strategyKey, JSON.stringify(legacyStrategy));
  ipoClient.values.set(monitorKey, JSON.stringify(legacyMonitor));
  const subscriptionClient = {
    compareAndSet: async (key, expected, next) =>
      (await ipoClient.compareAndSet(key, expected, next)) === "swapped",
    get: (key) => ipoClient.get(key),
  };
  const monitorClient = {
    get: (key) => ipoClient.get(key),
    update: async ({ expected, next, recordKey }) => {
      if (ipoClient.values.get(recordKey) !== expected) return false;
      ipoClient.values.set(recordKey, next);
      return true;
    },
  };
  const migrated = await migrateSecPublicSourceWorkspace({
    monitorId: ipoMonitors[0].monitorId,
    now: new Date("2026-08-15T18:01:00.000Z"),
    scope: ipoScope,
  }, {
    monitor: monitorClient,
    state: subscriptionClient,
    subscription: subscriptionClient,
  });
  assert.equal(migrated.monitor.configurationRevision, 1);
  assert.equal(migrated.strategy?.value.bindingRevision, 1);
  assert.equal(
    migrated.strategy?.value.managedResources["detect-new-s1"]
      ?.publicSourceSubscriptions?.[0]?.subscriptionId,
    migrated.subscription.subscriptionId,
  );
  assert.equal(migrated.subscription.deliveryCursor.revision, 0);
  const ipoInstallOnly = await createStrategyPackWorkspaceFromSelection({
    activateMonitorResourceIds: [],
    expectedRegistryRevision: ipoState.revision,
    name: "IPO Pack Inspect Only",
    packId: "ipo-filings",
    packVersion: "1.0.0",
    principalId: routing.principalId,
    requestIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId: `ingress_${"8".repeat(64)}`,
      operationOrdinal: 0,
      stepId: "call_install_ipo_session",
      turnId: "turn_install_ipo_session",
    }),
    sourceAssignment: {
      generation: ipoState.activeWorkspace.generation,
      workspaceId: ipoState.activeWorkspace.id,
    },
    threadId: routing.threadId,
  }, ipoDependencies);
  const ipoInstallOnlyScope = authorizeDeploymentWorkspaceStore({
    ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
    workspaceId: ipoInstallOnly.receipt.targetWorkspaceId,
  }, environment);
  assert.equal(
    (await listWorkspaceMonitors(ipoInstallOnlyScope, ipoClient))[0]?.lifecycleState,
    "paused",
  );
  assert.equal(ipoClient.due.size, 1);

  console.log("Strategy pack memory mutation verification passed.");
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
