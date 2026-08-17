import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStrategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "../agent/lib/strategy-pack-reference-catalog";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import {
  requireWorkspaceWorkerStrategyPackRuntime,
  resolveInteractiveStrategyPackRuntime,
  resolveSessionStrategyPackRuntime,
  StrategyPackRuntimeError,
} from "../agent/lib/strategy-pack-runtime";
import { prepareWorkspaceMonitorCreate } from "../agent/lib/workspace-monitor-store";
import type { ClaimedWorkspaceMonitor } from "../agent/lib/workspace-monitor-store";
import {
  completeWorkspaceSourceCoverage,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "../agent/lib/workspace-source-coverage";
import { stageWorkspaceFinding } from "../agent/lib/workspace-finding-store";
import { prepareWorkspaceWorkerRun } from "../agent/lib/workspace-worker-runner";
import type { WorkspaceDispatchReservation } from "../agent/lib/workspace-dispatch-budget";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  writeWorkspaceDocument,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceStrategyBindingValue,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { generateStrategyPackCatalog } from "./generate-strategy-pack-catalog.mjs";
import { photonAuth } from "../agent/lib/photon-auth";
import { projectPhotonWorkspaceRuntimeScope } from "../agent/lib/workspace-runtime-scope";

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
  parameterizedSourceContracts: STRATEGY_PACK_REFERENCE_CATALOG.parameterizedSourceContracts,
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

const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 17).toString("base64url"),
  EVE_WORKSPACE_STATE_ENABLED: "1",
};
const now = new Date("2026-08-15T17:00:00.000Z");

function capabilitiesFor(
  pack: ReturnType<typeof createStrategyPackCatalog>["entries"][number],
  configuration: Readonly<Record<string, unknown>>,
): WorkspaceCapabilityManifestValue {
  return {
    connectionIds: [],
    controlPlaneToolIds: [],
    financialToolIds: [],
    hardDeniedCapabilityIds: [...pack.capabilities.hardDenied].sort(),
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: pack.capabilities.required
      .filter((id) => !id.startsWith("skill."))
      .sort(),
    skills: pack.skills.map(({ id, version }) => ({ id, version })),
    sources: resolveParameterizedStrategyPackSources(pack, configuration).map((source) => ({
      allowedOrigins: [...source.allowedOrigins],
      contractDigest: source.contractDigest,
      contractVersion: source.contractVersion,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
    workerModelPolicy: {
      allowedModelIds: ["google/gemini-3.6-flash"],
      maximumOutputTokens: 2_000,
    },
  };
}

function installPackWorkspace(input: {
  catalog: ReturnType<typeof createStrategyPackCatalog>;
  client: MemoryStore;
  generation: number;
  id: "alpha-pack" | "beta-pack";
  workspaceId: string;
}) {
  const pack = input.catalog.resolve({ id: input.id, version: "1.0.0" });
  assert.ok(pack);
  const scope = authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: input.workspaceId },
    environment,
  );
  const monitorDefinition = pack.monitors[0]!;
  const configuration = Object.fromEntries(pack.configuration.map((field) => [
    field.key,
    Array.isArray(field.default) ? [...field.default] : field.default,
  ]));
  const sources = resolveParameterizedStrategyPackSources(
    pack,
    configuration,
    monitorDefinition.sourceIds,
  );
  const monitor = prepareWorkspaceMonitorCreate({
    activateManagedMonitor: true,
    deliverySubscriptionId: `delivery.${pack.id}`,
    idempotencyKey: `${pack.id}:${monitorDefinition.resourceId}`,
    instruction: monitorDefinition.instruction,
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: pack.contentDigest,
      packId: pack.id,
      packVersion: pack.version,
      resourceId: monitorDefinition.resourceId,
    },
    name: monitorDefinition.displayName,
    nextOccurrenceAt: now.toISOString(),
    now,
    requiredCapabilityIds: [...monitorDefinition.requiredCapabilityIds],
    schedule: { anchor: now.toISOString(), everyMinutes: 60, kind: "interval" },
    scope,
    sources: sources.map((source) => ({
      accessClassification: source.accessClassification,
      canonicalUrl: source.canonicalUrl,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
  });
  const snapshot = {
    bindingRevision: 1,
    capabilityManifestRevision: 1,
    packContentDigest: pack.contentDigest,
    packId: pack.id,
    packVersion: pack.version,
    workspaceGeneration: input.generation,
  };
  const strategy: WorkspaceStrategyBindingValue = {
    bindingRevision: 1,
    configuration,
    effectiveCapabilityManifestRevision: 1,
    health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
    lastActiveSnapshot: null,
    lifecycleState: "active",
    managedResources: {
      [monitorDefinition.resourceId]: {
        monitorId: monitor.monitor.monitorId,
        sourceIds: sources.map(({ sourceId }) => sourceId).sort(),
      },
    },
    ownerOverrides: {},
    pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version },
    pendingSnapshot: snapshot,
    timestamps: {
      activatedAt: now.toISOString(),
      configuredAt: now.toISOString(),
      generationRolloverAt: now.toISOString(),
      installedAt: now.toISOString(),
    },
  };
  for (const prepared of [
    prepareInitialWorkspaceDocument("brief", {
      now,
      scope,
      value: {
        currentFindingsSummary: "",
        goal: pack.description,
        lastMaterialChange: "",
        openQuestions: [],
        promotedFacts: [],
        sourcePolicy: {
          allowedSourceIds: resolveParameterizedStrategyPackSources(pack, configuration)
            .map(({ sourceId }) => sourceId),
          maximumAccessClassification: "public",
        },
        strategyConfigurationRevision: 1,
        thesis: "",
        watchlist: [],
      },
    }),
    prepareInitialWorkspaceDocument("budget", {
      now,
      scope,
      value: {
        effectiveAt: now.toISOString(),
        maximumConcurrentWorkers: 1,
        maximumInputTokensPerDay: 10_000,
        maximumInputTokensPerRun: 5_000,
        maximumOutputTokensPerDay: 2_000,
        maximumOutputTokensPerRun: 1_000,
        maximumPaidPerCall: null,
        maximumPaidPerDay: null,
        maximumPaidPerMonth: null,
        maximumScheduledRunsPerDay: 2,
        ownerTimezone: "UTC",
        unknownPriceFallbackCeiling: "0",
      },
    }),
    prepareInitialWorkspaceDocument("capabilities", {
      now,
      scope,
      value: capabilitiesFor(pack, configuration),
    }),
    prepareInitialWorkspaceStrategyBinding({ now, scope, value: strategy }),
  ]) {
    input.client.values.set(prepared.key, prepared.raw);
  }
  input.client.values.set(monitor.recordKey, monitor.raw);
  return { monitor: monitor.monitor, pack, scope, snapshot };
}

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "eve-pack-runtime-"));
try {
  const generated = await generateStrategyPackCatalog({
    outputPath: resolve(temporaryRoot, "catalog.generated.ts"),
    packRoot: fixtureRoot,
    references,
  });
  const catalog = createStrategyPackCatalog(generated.entries);
  const client = new MemoryStore();
  const alpha = installPackWorkspace({
    catalog,
    client,
    generation: 3,
    id: "alpha-pack",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  });
  const beta = installPackWorkspace({
    catalog,
    client,
    generation: 7,
    id: "beta-pack",
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  });
  const generalScope = authorizeDeploymentWorkspaceStore({
    ownerId: "owner_fixture",
    workspaceId: "323e4567-e89b-42d3-a456-426614174000",
  }, environment);
  await writeWorkspaceDocument("strategy", {
    expectedRevision: 0,
    now,
    scope: generalScope,
    value: { configuration: {}, strategyPack: null },
  }, client);

  const [generalRuntime, alphaRuntime, betaRuntime] = await Promise.all([
    resolveInteractiveStrategyPackRuntime({
      catalog,
      environment,
      scope: generalScope,
      stateClient: client,
      workspaceGeneration: 1,
    }),
    resolveInteractiveStrategyPackRuntime({
      catalog,
      environment,
      scope: alpha.scope,
      stateClient: client,
      workspaceGeneration: 3,
    }),
    resolveInteractiveStrategyPackRuntime({
      catalog,
      environment,
      scope: beta.scope,
      stateClient: client,
      workspaceGeneration: 7,
    }),
  ]);
  assert.deepEqual(generalRuntime, { state: "unbound" });
  assert.equal(alphaRuntime.state, "active");
  assert.equal(betaRuntime.state, "active");
  if (alphaRuntime.state !== "active" || betaRuntime.state !== "active") {
    assert.fail("fixture packs must resolve as active");
  }
  assert.match(alphaRuntime.workspaceInstruction, /Alpha Pack/u);
  assert.doesNotMatch(JSON.stringify(alphaRuntime), /Beta Pack|beta-playbook/u);
  assert.deepEqual(alphaRuntime.skills.map((skill) => skill.id), ["alpha-playbook"]);
  assert.match(betaRuntime.workspaceInstruction, /Beta Pack/u);
  assert.doesNotMatch(JSON.stringify(betaRuntime), /Alpha Pack|alpha-playbook/u);
  assert.deepEqual(betaRuntime.skills.map((skill) => skill.id), ["beta-playbook"]);
  const photonScope = projectPhotonWorkspaceRuntimeScope({
    generation: 3,
    principalId: "imessage:fixture-owner",
    threadId: "imessage:fixture-thread",
    workspaceId: alpha.scope.workspaceId,
  }, environment);
  const sessionRuntime = await resolveSessionStrategyPackRuntime({
    catalog,
    ctx: {
      session: {
        auth: {
          current: photonAuth(
            "fixture-owner",
            "imessage:fixture-thread",
            photonScope,
          ),
        },
      },
    },
    environment,
    stateClient: client,
  });
  assert.equal(sessionRuntime?.state, "active");
  assert.doesNotMatch(JSON.stringify(sessionRuntime), /Beta Pack|beta-playbook/u);
  assert.equal(await resolveSessionStrategyPackRuntime({
    catalog,
    ctx: {
      session: {
        auth: {
          current: photonAuth("fixture-owner", "imessage:fixture-thread"),
        },
      },
    },
    environment,
    stateClient: client,
  }), null);

  const [alphaWorker, betaWorker] = await Promise.all([
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 1,
        strategyPack: { ...alpha.snapshot, resourceId: "detect-alpha" },
        sources: alpha.monitor.sources,
      },
      environment,
      monitor: alpha.monitor,
      scope: alpha.scope,
      stateClient: client,
    }),
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 1,
        strategyPack: { ...beta.snapshot, resourceId: "detect-beta" },
        sources: beta.monitor.sources,
      },
      environment,
      monitor: beta.monitor,
      scope: beta.scope,
      stateClient: client,
    }),
  ]);
  assert.equal(alphaWorker?.resource.resourceId, "detect-alpha");
  assert.match(alphaWorker?.resource.instruction ?? "", /alpha events/iu);
  assert.doesNotMatch(JSON.stringify(alphaWorker), /Beta Pack|beta-playbook/u);
  assert.equal(betaWorker?.resource.resourceId, "detect-beta");
  assert.doesNotMatch(JSON.stringify(betaWorker), /Alpha Pack|alpha-playbook/u);
  assert.equal(await requireWorkspaceWorkerStrategyPackRuntime({
    catalog,
    envelope: {
      capabilityRevision: 1,
      strategyPack: null,
      sources: alpha.monitor.sources,
    },
    environment,
    monitor: {
      ...alpha.monitor,
      managedBy: null,
      monitorId: "423e4567-e89b-42d3-a456-426614174000",
    },
    scope: alpha.scope,
    stateClient: client,
  }), null);

  const scheduledFor = new Date(now.getTime() + 60 * 60_000).toISOString();
  const occurrenceKey = "c".repeat(64);
  const runId = `${occurrenceKey}:attempt:1`;
  const claimed: ClaimedWorkspaceMonitor = {
    leaseExpiresAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
    leaseToken: "alpha-lease",
    monitor: alpha.monitor,
    occurrence: {
      attempt: 1,
      configurationRevision: alpha.monitor.configurationRevision,
      leaseTokenDigest: "d".repeat(64),
      monitorId: alpha.monitor.monitorId,
      occurrenceIdentity: `interval:${scheduledFor}`,
      occurrenceKey,
      scheduledFor,
      schemaVersion: 1,
      status: "leased",
      updatedAt: now.toISOString(),
    },
    scope: alpha.scope,
    skippedOccurrenceIdentities: [],
  };
  const commonReservation = {
    calendarDay: now.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    runId,
    state: "reserved" as const,
    updatedAt: now.toISOString(),
  };
  const dispatchBudget: WorkspaceDispatchReservation = {
    global: commonReservation,
    runId,
    workspace: {
      ...commonReservation,
      calendarMonth: now.toISOString().slice(0, 7),
      inputTokens: 5_000,
      outputTokens: 1_000,
      paidMicros: "0",
      policyRevision: 1,
      reconciledInputTokens: null,
      reconciledOutputTokens: null,
      reconciledPaidMicros: null,
    },
  };
  const prepared = await prepareWorkspaceWorkerRun({
    claimed,
    clients: { sourceCoverage: client, state: client, strategyPackCatalog: catalog },
    dispatchBudget,
    environment,
    now,
  });
  assert.deepEqual(prepared.envelope.strategyPack, alphaWorker?.snapshot);
  assert.match(prepared.prompt, /detect-alpha/u);
  assert.doesNotMatch(prepared.prompt, /Beta Pack|beta-playbook/u);
  for (const source of alpha.monitor.sources) {
    await reserveWorkspaceSourceAttempt({
      now,
      runId,
      scope: alpha.scope,
      sourceId: source.sourceId,
    }, client);
    await markWorkspaceSourceSuccess({
      contentDigest: "e".repeat(64),
      now,
      runId,
      scope: alpha.scope,
      sourceId: source.sourceId,
    }, client);
  }
  const coverage = await completeWorkspaceSourceCoverage({
    checkpoint: { contentDigest: "e".repeat(64), watermark: scheduledFor },
    now,
    runId,
    scope: alpha.scope,
  }, client);
  const stored = await stageWorkspaceFinding({
    coverage,
    envelope: prepared.envelope,
    finding: {
      accessClassification: "public",
      artifactRefs: [],
      asOf: scheduledFor,
      factIdentities: [],
      provenance: [alpha.monitor.sources[0]!],
      summary: "Alpha pack fixture finding.",
    },
    now,
    scope: alpha.scope,
  }, {
    async createOutcomeWithIdentityClaims(input) {
      return { status: "created", value: input.outcomeValue } as const;
    },
    async createOrRead(_key, value) { return value; },
    async get() { return null; },
  });
  assert.deepEqual(stored.strategyPack, prepared.envelope.strategyPack);
  assert.deepEqual(stored.finding?.strategyPack, prepared.envelope.strategyPack);

  await assert.rejects(
    resolveInteractiveStrategyPackRuntime({
      catalog,
      environment,
      scope: alpha.scope,
      stateClient: client,
      workspaceGeneration: 4,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_stale",
  );
  await assert.rejects(
    resolveInteractiveStrategyPackRuntime({
      catalog,
      environment: { ...environment, EVE_STRATEGY_PACK_RUNTIME_ENABLED: "0" },
      scope: alpha.scope,
      stateClient: client,
      workspaceGeneration: 3,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_unavailable",
  );
  const blockedCatalog = createStrategyPackCatalog(generated.entries, {
    blockedVersions: [{ id: "alpha-pack", version: "1.0.0" }],
  });
  await assert.rejects(
    resolveInteractiveStrategyPackRuntime({
      catalog: blockedCatalog,
      environment,
      scope: alpha.scope,
      stateClient: client,
      workspaceGeneration: 3,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_unavailable",
  );
  await assert.rejects(
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 1,
        strategyPack: {
          ...alpha.snapshot,
          packContentDigest: "f".repeat(64),
          resourceId: "detect-alpha",
        },
        sources: alpha.monitor.sources,
      },
      environment,
      monitor: alpha.monitor,
      scope: alpha.scope,
      stateClient: client,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_stale",
  );
  await assert.rejects(
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 2,
        strategyPack: { ...alpha.snapshot, resourceId: "detect-alpha" },
        sources: beta.monitor.sources,
      },
      environment,
      monitor: alpha.monitor,
      scope: alpha.scope,
      stateClient: client,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_stale",
  );
  await assert.rejects(
    requireWorkspaceWorkerStrategyPackRuntime({
      catalog,
      envelope: {
        capabilityRevision: 1,
        strategyPack: { ...alpha.snapshot, resourceId: "detect-beta" },
        sources: alpha.monitor.sources,
      },
      environment,
      monitor: alpha.monitor,
      scope: alpha.scope,
      stateClient: client,
    }),
    (error) => error instanceof StrategyPackRuntimeError &&
      error.code === "strategy_pack_runtime_stale",
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

console.info("Strategy pack runtime isolation verification passed.");
