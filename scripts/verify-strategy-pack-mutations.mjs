import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import {
  createPhotonWorkspace,
  getPhotonWorkspaceState,
} from "../agent/lib/photon-workspace-store.ts";
import {
  createStrategyPackCatalog,
  strategyPackCatalog,
} from "../agent/lib/strategy-pack-catalog.ts";
import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../agent/lib/strategy-pack-reference-catalog.ts";
import {
  createStrategyPackWorkspace,
  createStrategyPackWorkspaceFromSelection,
  deriveEveStrategyPackMutationIdentity,
  mintSpectrumStrategyPackMutationIdentity,
  StrategyPackServiceError,
  verifySpectrumStrategyPackMutationIdentity,
} from "../agent/lib/strategy-pack-service.ts";
import { listWorkspaceMonitors } from "../agent/lib/workspace-monitor-store.ts";
import { readWorkspaceDocument } from "../agent/lib/workspace-state-store.ts";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization.ts";
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
  failNextCommit = false;
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
      this.failNextCommit = false;
      throw new Error("injected_transaction_failure");
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
}

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
  EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
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
  const dependencies = {
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
  client.failNextCommit = true;
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
    /injected_transaction_failure/u,
  );
  assert.deepEqual(client.values, beforeFailure);

  const spectrumSecret = "spectrum-secret-".repeat(4);
  const duplicateIdentity = verifySpectrumStrategyPackMutationIdentity(
    mintSpectrumStrategyPackMutationIdentity({
      actionId: "action_duplicate",
      issuedAt: new Date("2026-08-15T17:03:00.000Z"),
      nonce: "nonce_duplicate_123456789",
    }, spectrumSecret),
    spectrumSecret,
  );
  await assert.rejects(
    async () => verifySpectrumStrategyPackMutationIdentity(
      { ...duplicateIdentity, signature: "0".repeat(64) },
      spectrumSecret,
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

  const ipoClient = new MemoryStore();
  const ipoInitial = await getPhotonWorkspaceState(routing, ipoClient);
  const ipoIdentity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"7".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "call_create_ipo_session",
    turnId: "turn_create_ipo_session",
  });
  const ipoDependencies = {
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
  assert.deepEqual(ipoMonitors[0]?.schedule, {
    kind: "daily_local",
    times: ["09:00", "16:00"],
    timezone: "America/Vancouver",
  });
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
