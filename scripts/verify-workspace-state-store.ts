import assert from "node:assert/strict";

import {
  migrateWorkspaceStrategyDocument,
  readWorkspaceDocument,
  validateWorkspaceCapabilitySourceContract,
  workspaceStrategyBindingValueSchema,
  WORKSPACE_DOCUMENT_BYTE_LIMITS,
  WorkspaceStateConflictError,
  WorkspaceStateValidationError,
  writeWorkspaceDocument,
  writeWorkspaceStrategyBinding,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import {
  authorizePhotonWorkspaceControlPlaneStore,
  authorizePhotonWorkspaceToolStore,
  WorkspaceStoreAuthorizationError,
} from "../agent/lib/workspace-store-authorization";
import { photonAuth } from "../agent/lib/photon-auth";
import { projectPhotonWorkspaceRuntimeScope } from "../agent/lib/workspace-runtime-scope";

class MemoryStore implements WorkspaceStateStoreClient {
  compareAndSetCalls = 0;
  rejectNextCompareAndSet = false;
  getCalls = 0;
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    this.compareAndSetCalls += 1;
    if (this.rejectNextCompareAndSet) {
      this.rejectNextCompareAndSet = false;
      return false;
    }
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    this.getCalls += 1;
    return this.values.get(key) ?? null;
  }
}

const client = new MemoryStore();
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};
const scope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const otherScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const runtimeScope = projectPhotonWorkspaceRuntimeScope(
  {
    generation: 1,
    principalId: "imessage:fixture-owner",
    threadId: "imessage:fixture-thread",
    workspaceId: scope.workspaceId,
  },
  environment,
);
const toolScope = authorizePhotonWorkspaceToolStore(
  {
    session: {
      auth: {
        current: photonAuth(
          "fixture-owner",
          "imessage:fixture-thread",
          runtimeScope,
        ),
      },
    },
  },
  { generation: 1, workspaceId: scope.workspaceId },
  environment,
);
assert.deepEqual(toolScope, scope);

const deniedClient = new MemoryStore();
for (const kind of ["brief", "strategy", "capabilities", "budget"] as const) {
  await assert.rejects(
    readWorkspaceDocument(
      kind,
      { ownerId: scope.ownerId, workspaceId: scope.workspaceId },
      deniedClient,
    ),
    WorkspaceStoreAuthorizationError,
  );
}
assert.equal(deniedClient.getCalls, 0);
assert.throws(
  () =>
    authorizePhotonWorkspaceControlPlaneStore(
      {
        principalId: "imessage:authenticated-but-unmapped",
        resource: "worker",
        workspaceId: scope.workspaceId,
      },
      environment,
    ),
  /not mapped/u,
);
const now = new Date("2026-08-14T12:00:00.000Z");

const briefValue = {
  currentFindingsSummary: "No promoted findings yet.",
  goal: "Track evidence relevant to public-market research.",
  lastMaterialChange: "Workspace initialized.",
  openQuestions: ["Which issuers should be prioritized?"],
  promotedFacts: [
    {
      fact: "The source policy currently permits official SEC material.",
      provenanceRefs: ["source.sec"],
    },
  ],
  sourcePolicy: {
    allowedSourceIds: ["source.sec"],
    maximumAccessClassification: "public" as const,
  },
  strategyConfigurationRevision: 0,
  thesis: "Evidence must remain attributable to reviewed public sources.",
  watchlist: ["Example Corp"],
};
await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    {
      expectedRevision: 0,
      now,
      scope: { ownerId: scope.ownerId, workspaceId: scope.workspaceId },
      value: briefValue,
    },
    deniedClient,
  ),
  WorkspaceStoreAuthorizationError,
);
assert.equal(deniedClient.getCalls, 0);
assert.equal(deniedClient.compareAndSetCalls, 0);
assert.throws(
  () =>
    authorizePhotonWorkspaceToolStore(
      {
        session: {
          auth: {
            current: photonAuth(
              "fixture-owner",
              "imessage:fixture-thread",
              runtimeScope,
            ),
          },
        },
      },
      { workspaceId: otherScope.workspaceId },
      environment,
    ),
  /scope is missing or does not match/u,
);
const brief = await writeWorkspaceDocument(
  "brief",
  { scope, expectedRevision: 0, now, value: briefValue },
  client,
);
assert.equal(brief.recordType, "workspace_brief");
assert.equal(brief.schemaVersion, 1);
assert.equal(brief.revision, 1);
assert.deepEqual(await readWorkspaceDocument("brief", scope, client), brief);
assert.equal(await readWorkspaceDocument("brief", otherScope, client), null);

const strategy = await writeWorkspaceDocument(
  "strategy",
  {
    scope,
    expectedRevision: 0,
    now,
    value: {
      configuration: {
        minimumEvidenceCount: 2,
        watchlists: ["primary", "secondary"],
      },
      strategyPack: { id: "fixture-strategy", version: "1.0.0" },
    },
  },
  client,
);
assert.equal(strategy.recordType, "workspace_strategy_configuration");
assert.equal(strategy.revision, 1);
const readsBeforeMigration = client.compareAndSetCalls;
assert.equal((await readWorkspaceDocument("strategy", scope, client))?.schemaVersion, 1);
assert.equal(client.compareAndSetCalls, readsBeforeMigration);

const migratedLegacyStrategy = await migrateWorkspaceStrategyDocument(
  { expectedRevision: 1, now: new Date("2026-08-14T12:00:30.000Z"), scope },
  client,
);
assert.equal(migratedLegacyStrategy?.schemaVersion, 2);
assert.equal(migratedLegacyStrategy?.revision, 2);
assert.equal(migratedLegacyStrategy?.value.lifecycleState, "unavailable");
assert.equal(migratedLegacyStrategy?.value.health.code, "legacy_unverified");
assert.equal(migratedLegacyStrategy?.value.pack?.contentDigest, null);
assert.deepEqual(migratedLegacyStrategy?.value.managedResources, {});
const callsAfterMigration = client.compareAndSetCalls;
assert.deepEqual(
  await migrateWorkspaceStrategyDocument({ scope }, client),
  migratedLegacyStrategy,
);
assert.equal(client.compareAndSetCalls, callsAfterMigration);

const exactDigest = "c".repeat(64);
const activeStrategy = await writeWorkspaceStrategyBinding(
  {
    expectedRevision: 2,
    now: new Date("2026-08-14T12:00:40.000Z"),
    scope,
    value: {
      bindingRevision: 2,
      configuration: {
        minimumEvidenceCount: 2,
        watchlists: ["primary", "secondary"],
      },
      effectiveCapabilityManifestRevision: 1,
      health: {
        checkedAt: "2026-08-14T12:00:40.000Z",
        code: null,
        status: "healthy",
      },
      lastActiveSnapshot: {
        bindingRevision: 2,
        capabilityManifestRevision: 1,
        packContentDigest: exactDigest,
        packId: "fixture-strategy",
        packVersion: "1.0.0",
        workspaceGeneration: 2,
      },
      lifecycleState: "active",
      managedResources: {
        "fixture-monitor": {
          monitorId: "323e4567-e89b-42d3-a456-426614174000",
          sourceIds: ["source.sec"],
        },
      },
      ownerOverrides: { minimumEvidenceCount: 2 },
      pack: {
        contentDigest: exactDigest,
        id: "fixture-strategy",
        version: "1.0.0",
      },
      pendingSnapshot: null,
      timestamps: {
        activatedAt: "2026-08-14T12:00:40.000Z",
        configuredAt: null,
        generationRolloverAt: "2026-08-14T12:00:40.000Z",
        installedAt: "2026-08-14T12:00:40.000Z",
      },
    },
  },
  client,
);
assert.equal(activeStrategy.schemaVersion, 2);
assert.equal(activeStrategy.recordType, "workspace_strategy_binding");
assert.equal(activeStrategy.value.pack.id, "fixture-strategy");
assert.ok(
  Buffer.byteLength(JSON.stringify(activeStrategy), "utf8") <
    WORKSPACE_DOCUMENT_BYTE_LIMITS.strategy,
);
assert.deepEqual(await readWorkspaceDocument("strategy", scope, client), activeStrategy);
assert.equal(workspaceStrategyBindingValueSchema.safeParse({
  ...activeStrategy.value,
  bindingRevision: 3,
  pendingSnapshot: {
    bindingRevision: 3,
    capabilityManifestRevision: 1,
    packContentDigest: exactDigest,
    packId: "fixture-strategy",
    packVersion: "1.0.0",
    workspaceGeneration: 3,
  },
}).success, true);
assert.equal(workspaceStrategyBindingValueSchema.safeParse({
  bindingRevision: 3,
  configuration: {},
  effectiveCapabilityManifestRevision: null,
  health: {
    checkedAt: "2026-08-14T12:00:40.000Z",
    code: null,
    status: "unbound",
  },
  lastActiveSnapshot: activeStrategy.value.lastActiveSnapshot,
  lifecycleState: "unbound",
  managedResources: {},
  ownerOverrides: {},
  pack: null,
  pendingSnapshot: null,
  timestamps: {
    activatedAt: null,
    configuredAt: null,
    generationRolloverAt: "2026-08-14T12:00:40.000Z",
    installedAt: null,
  },
}).success, true);
await assert.rejects(
  writeWorkspaceDocument(
    "strategy",
    {
      expectedRevision: activeStrategy.revision,
      now,
      scope,
      value: { configuration: {}, strategyPack: null },
    },
    client,
  ),
  WorkspaceStateValidationError,
);

const capabilities = await writeWorkspaceDocument(
  "capabilities",
  {
    scope,
    expectedRevision: 0,
    now,
    value: {
      connectionIds: [],
      controlPlaneToolIds: ["workspace.complete_run"],
      financialToolIds: [],
      hardDeniedCapabilityIds: ["broker.mutation", "filesystem.write"],
      maximumDataAccessClassification: "public",
      paidResearchAllowed: false,
      providerTools: [
        {
          kind: "read",
          providerId: "sec",
          schemaDigest: "a".repeat(64),
          toolId: "sec.get_filing",
        },
      ],
      researchToolIds: ["sec.get_filing"],
      skills: [{ id: "filing-review", version: "1.0.0" }],
      sources: [{
        allowedOrigins: ["https://www.sec.gov"],
        contractDigest: "a".repeat(64),
        contractVersion: "1.0.0",
        origin: "https://www.sec.gov",
        sourceId: "source.sec",
      }],
      workerModelPolicy: {
        allowedModelIds: ["openai/gpt-5.5"],
        maximumOutputTokens: 8_000,
      },
    },
  },
  client,
);
assert.equal(capabilities.recordType, "workspace_capability_manifest");
assert.equal(capabilities.value.paidResearchAllowed, false);
assert.equal(capabilities.value.financialToolIds.length, 0);
assert.equal(capabilities.value.researchToolIds.includes("web.search"), false);
const exactSource = capabilities.value.sources[0]!;
assert.deepEqual(
  validateWorkspaceCapabilitySourceContract(exactSource, {
    allowedOrigins: ["https://www.sec.gov"],
    contractDigest: "a".repeat(64),
    contractVersion: "1.0.0",
    sourceId: "source.sec",
  }),
  exactSource,
);
assert.throws(
  () => validateWorkspaceCapabilitySourceContract(exactSource, {
    allowedOrigins: ["https://www.sec.gov"],
    contractDigest: "b".repeat(64),
    contractVersion: "1.0.0",
    sourceId: "source.sec",
  }),
  WorkspaceStateValidationError,
);
assert.throws(
  () => validateWorkspaceCapabilitySourceContract({
    origin: "https://www.sec.gov",
    sourceId: "source.sec",
  }),
  WorkspaceStateValidationError,
);

const budget = await writeWorkspaceDocument(
  "budget",
  {
    scope,
    expectedRevision: 0,
    now,
    value: {
      effectiveAt: now.toISOString(),
      maximumConcurrentWorkers: 2,
      maximumInputTokensPerDay: 100_000,
      maximumInputTokensPerRun: 20_000,
      maximumOutputTokensPerDay: 40_000,
      maximumOutputTokensPerRun: 8_000,
      maximumPaidPerCall: null,
      maximumPaidPerDay: "5.00",
      maximumPaidPerMonth: "50.00",
      maximumScheduledRunsPerDay: 16,
      ownerTimezone: "America/Vancouver",
      unknownPriceFallbackCeiling: "1.00",
    },
  },
  client,
);
assert.equal(budget.recordType, "workspace_budget_policy");
assert.equal(typeof budget.value.maximumPaidPerDay, "string");

const updatedBrief = await writeWorkspaceDocument(
  "brief",
  {
    scope,
    expectedRevision: brief.revision,
    now: new Date("2026-08-14T12:01:00.000Z"),
    value: { ...briefValue, lastMaterialChange: "Owner updated the goal." },
  },
  client,
);
assert.equal(updatedBrief.revision, 2);
assert.equal(updatedBrief.createdAt, brief.createdAt);
assert.notEqual(updatedBrief.updatedAt, brief.updatedAt);
await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    { scope, expectedRevision: 1, now, value: briefValue },
    client,
  ),
  WorkspaceStateConflictError,
);

const raceClient = new MemoryStore();
const raceResults = await Promise.allSettled([
  writeWorkspaceDocument(
    "brief",
    { scope, expectedRevision: 0, now, value: briefValue },
    raceClient,
  ),
  writeWorkspaceDocument(
    "brief",
    { scope, expectedRevision: 0, now, value: briefValue },
    raceClient,
  ),
]);
assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1);

await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    {
      scope: otherScope,
      expectedRevision: 0,
      now,
      value: { ...briefValue, goal: "x".repeat(2_001) },
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceStateValidationError &&
    error.code === "workspace_state_invalid",
);
await assert.rejects(
  writeWorkspaceDocument(
    "strategy",
    {
      scope: otherScope,
      expectedRevision: 0,
      now,
      value: { configuration: { unsafe: true }, strategyPack: null },
    },
    client,
  ),
  WorkspaceStateValidationError,
);
await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    {
      scope: otherScope,
      expectedRevision: 0,
      now,
      value: { ...briefValue, budget: budget.value },
    },
    client,
  ),
  WorkspaceStateValidationError,
);
await assert.rejects(
  writeWorkspaceDocument(
    "budget",
    {
      scope: otherScope,
      expectedRevision: 0,
      now,
      value: {
        ...budget.value,
        maximumPaidPerDay: 1.25,
        ownerTimezone: "Not/A_Timezone",
      },
    },
    client,
  ),
  WorkspaceStateValidationError,
);

const oversizeClient = new MemoryStore();
await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    {
      scope,
      expectedRevision: 0,
      now,
      value: {
        ...briefValue,
        promotedFacts: Array.from({ length: 100 }, (_, index) => ({
          fact: `${index}:${"x".repeat(995)}`,
          provenanceRefs: ["source.sec"],
        })),
      },
    },
    oversizeClient,
  ),
  WorkspaceStateValidationError,
);
assert.equal(oversizeClient.values.size, 0);

const oversizeStrategyScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "623e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const oversizeStrategyClient = new MemoryStore();
await assert.rejects(
  writeWorkspaceStrategyBinding(
    {
      expectedRevision: 0,
      now,
      scope: oversizeStrategyScope,
      value: {
        bindingRevision: 1,
        configuration: Object.fromEntries(
          Array.from({ length: 10 }, (_, index) => [`field${index}`, "x".repeat(2_000)]),
        ),
        effectiveCapabilityManifestRevision: 1,
        health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
        lastActiveSnapshot: {
          bindingRevision: 1,
          capabilityManifestRevision: 1,
          packContentDigest: "f".repeat(64),
          packId: "oversize-pack",
          packVersion: "1.0.0",
          workspaceGeneration: 1,
        },
        lifecycleState: "active",
        managedResources: {},
        ownerOverrides: {},
        pack: {
          contentDigest: "f".repeat(64),
          id: "oversize-pack",
          version: "1.0.0",
        },
        pendingSnapshot: null,
        timestamps: {
          activatedAt: now.toISOString(),
          configuredAt: null,
          generationRolloverAt: now.toISOString(),
          installedAt: now.toISOString(),
        },
      },
    },
    oversizeStrategyClient,
  ),
  WorkspaceStateValidationError,
);
assert.equal(oversizeStrategyClient.values.size, 0);

const corruptClient = new MemoryStore();
await writeWorkspaceDocument(
  "brief",
  { scope, expectedRevision: 0, now, value: briefValue },
  corruptClient,
);
const [briefKey] = corruptClient.values.keys();
assert.ok(briefKey);
corruptClient.values.set(briefKey, "{" + "x".repeat(WORKSPACE_DOCUMENT_BYTE_LIMITS.brief));
await assert.rejects(
  readWorkspaceDocument("brief", scope, corruptClient),
  (error) =>
    error instanceof WorkspaceStateValidationError &&
    error.code === "workspace_state_corrupt",
);

const nullBindingScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "423e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const nullBindingClient = new MemoryStore();
const legacyNull = await writeWorkspaceDocument(
  "strategy",
  {
    expectedRevision: 0,
    now,
    scope: nullBindingScope,
    value: { configuration: {}, strategyPack: null },
  },
  nullBindingClient,
);
const writesBeforeNullRead = nullBindingClient.compareAndSetCalls;
assert.equal(
  (await readWorkspaceDocument("strategy", nullBindingScope, nullBindingClient))?.schemaVersion,
  1,
);
assert.equal(nullBindingClient.compareAndSetCalls, writesBeforeNullRead);
const migratedNull = await migrateWorkspaceStrategyDocument(
  { expectedRevision: legacyNull.revision, now, scope: nullBindingScope },
  nullBindingClient,
);
assert.equal(migratedNull?.value.lifecycleState, "unbound");
assert.equal(migratedNull?.value.pack, null);
assert.deepEqual(migratedNull?.value.configuration, {});

const interruptedScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "manager",
    workspaceId: "523e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const interruptedClient = new MemoryStore();
await writeWorkspaceDocument(
  "strategy",
  {
    expectedRevision: 0,
    now,
    scope: interruptedScope,
    value: { configuration: {}, strategyPack: null },
  },
  interruptedClient,
);
interruptedClient.rejectNextCompareAndSet = true;
await assert.rejects(
  migrateWorkspaceStrategyDocument(
    { expectedRevision: 1, now, scope: interruptedScope },
    interruptedClient,
  ),
  WorkspaceStateConflictError,
);
// Mixed deployments retain readable v1 and v2 records without read-time writes.
assert.equal(
  (await readWorkspaceDocument("strategy", interruptedScope, interruptedClient))?.schemaVersion,
  1,
);
assert.equal(
  (await readWorkspaceDocument("strategy", scope, client))?.schemaVersion,
  2,
);
assert.equal(
  (await migrateWorkspaceStrategyDocument(
    { expectedRevision: 1, now, scope: interruptedScope },
    interruptedClient,
  ))?.schemaVersion,
  2,
);
assert.equal(
  (await readWorkspaceDocument("strategy", interruptedScope, interruptedClient))?.schemaVersion,
  2,
);

console.log("Bounded workspace state store verification passed.");
