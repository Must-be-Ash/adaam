import assert from "node:assert/strict";

import {
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import { photonAuth } from "../agent/lib/photon-auth";
import { resolveWorkspaceRuntimeCapabilities } from "../agent/lib/workspace-runtime-capabilities";
import {
  projectPhotonWorkspaceRuntimeScope,
  WorkspaceRuntimeScopeError,
} from "../agent/lib/workspace-runtime-scope";
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import {
  authorizePhotonWorkspaceControlPlaneStore,
  authorizePhotonWorkspaceToolStore,
} from "../agent/lib/workspace-store-authorization";

class MemoryCasStore
  implements WorkspaceStateStoreClient, WorkspaceBudgetLedgerClient
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

const ownerEnvironment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};
const otherOwnerEnvironment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_other",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-other-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "B".repeat(43),
};
const workspaceA = "123e4567-e89b-42d3-a456-426614174000";
const workspaceB = "223e4567-e89b-42d3-a456-426614174000";
const scopeA = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "worker",
    workspaceId: workspaceA,
  },
  ownerEnvironment,
);
const scopeB = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-owner",
    resource: "worker",
    workspaceId: workspaceB,
  },
  ownerEnvironment,
);
const otherOwnerScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: "imessage:fixture-other-owner",
    resource: "worker",
    workspaceId: workspaceA,
  },
  otherOwnerEnvironment,
);
const stateClient = new MemoryCasStore();
const now = new Date("2026-08-14T12:00:00.000Z");

function brief(goal: string, sourceId: string) {
  return {
    currentFindingsSummary: "",
    goal,
    lastMaterialChange: "Initialized.",
    openQuestions: [],
    promotedFacts: [],
    sourcePolicy: {
      allowedSourceIds: [sourceId],
      maximumAccessClassification: "public" as const,
    },
    strategyConfigurationRevision: 0,
    thesis: `${goal} with attributable evidence.`,
    watchlist: [],
  };
}

function capabilities(input: {
  digest: string;
  skillId: string;
  sourceId: string;
  toolId: string;
}) {
  return {
    connectionIds: ["fixture-provider"],
    controlPlaneToolIds: ["workspace.complete_run"],
    financialToolIds: [],
    hardDeniedCapabilityIds: ["broker.mutation"],
    maximumDataAccessClassification: "public" as const,
    paidResearchAllowed: false,
    providerTools: [
      {
        kind: "read" as const,
        providerId: "fixture-provider",
        schemaDigest: input.digest,
        toolId: input.toolId,
      },
    ],
    researchToolIds: [input.toolId],
    skills: [{ id: input.skillId, version: "1.0.0" }],
    sources: [
      { origin: "https://example.gov", sourceId: input.sourceId },
    ],
    workerModelPolicy: {
      allowedModelIds: ["openai/gpt-5.5"],
      maximumOutputTokens: 2_000,
    },
  };
}

function budget(maximumScheduledRunsPerDay: number) {
  return {
    effectiveAt: now.toISOString(),
    maximumConcurrentWorkers: 1,
    maximumInputTokensPerDay: 2_000,
    maximumInputTokensPerRun: 1_000,
    maximumOutputTokensPerDay: 1_000,
    maximumOutputTokensPerRun: 500,
    maximumPaidPerCall: "0.00",
    maximumPaidPerDay: "0.00",
    maximumPaidPerMonth: "0.00",
    maximumScheduledRunsPerDay,
    ownerTimezone: "UTC",
    unknownPriceFallbackCeiling: "0.00",
  };
}

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const briefA = await writeWorkspaceDocument(
  "brief",
  { expectedRevision: 0, now, scope: scopeA, value: brief("Workspace A", "source.a") },
  stateClient,
);
const briefB = await writeWorkspaceDocument(
  "brief",
  { expectedRevision: 0, now, scope: scopeB, value: brief("Workspace B", "source.b") },
  stateClient,
);
const capabilityA = await writeWorkspaceDocument(
  "capabilities",
  {
    expectedRevision: 0,
    now,
    scope: scopeA,
    value: capabilities({
      digest: digestA,
      skillId: "skill-a",
      sourceId: "source.a",
      toolId: "provider.tool_a",
    }),
  },
  stateClient,
);
const capabilityB = await writeWorkspaceDocument(
  "capabilities",
  {
    expectedRevision: 0,
    now,
    scope: scopeB,
    value: capabilities({
      digest: digestB,
      skillId: "skill-b",
      sourceId: "source.b",
      toolId: "provider.tool_b",
    }),
  },
  stateClient,
);
const budgetA = await writeWorkspaceDocument(
  "budget",
  { expectedRevision: 0, now, scope: scopeA, value: budget(1) },
  stateClient,
);
const budgetB = await writeWorkspaceDocument(
  "budget",
  { expectedRevision: 0, now, scope: scopeB, value: budget(2) },
  stateClient,
);

assert.notEqual(briefA.value.goal, briefB.value.goal);
assert.notEqual(
  capabilityA.value.skills[0]?.id,
  capabilityB.value.skills[0]?.id,
);
assert.notEqual(
  capabilityA.value.researchToolIds[0],
  capabilityB.value.researchToolIds[0],
);
assert.notEqual(
  capabilityA.value.sources[0]?.sourceId,
  capabilityB.value.sources[0]?.sourceId,
);
assert.notEqual(
  budgetA.value.maximumScheduledRunsPerDay,
  budgetB.value.maximumScheduledRunsPerDay,
);
assert.equal(await readWorkspaceDocument("brief", otherOwnerScope, stateClient), null);

const catalog = [
  {
    category: "research" as const,
    id: "provider.tool_a",
    providerId: "fixture-provider",
    schemaDigest: digestA,
  },
  {
    category: "research" as const,
    id: "provider.tool_b",
    providerId: "fixture-provider",
    schemaDigest: digestB,
  },
];
assert.deepEqual(
  resolveWorkspaceRuntimeCapabilities({
    catalog,
    expectedCapabilityRevision: capabilityA.revision,
    manifest: capabilityA,
    ownerId: scopeA.ownerId,
    workspaceId: scopeA.workspaceId,
  }).toolIds,
  ["provider.tool_a"],
);
assert.deepEqual(
  resolveWorkspaceRuntimeCapabilities({
    catalog,
    expectedCapabilityRevision: capabilityB.revision,
    manifest: capabilityB,
    ownerId: scopeB.ownerId,
    workspaceId: scopeB.workspaceId,
  }).toolIds,
  ["provider.tool_b"],
);
assert.throws(
  () =>
    resolveWorkspaceRuntimeCapabilities({
      catalog,
      expectedCapabilityRevision: capabilityA.revision,
      manifest: capabilityA,
      ownerId: scopeA.ownerId,
      workspaceId: scopeB.workspaceId,
    }),
  /capability_scope_mismatch/u,
);

const runtimeScopeA = projectPhotonWorkspaceRuntimeScope(
  {
    generation: 1,
    principalId: "imessage:fixture-owner",
    threadId: "imessage:fixture-thread",
    workspaceId: workspaceA,
  },
  ownerEnvironment,
);
assert.throws(
  () =>
    authorizePhotonWorkspaceToolStore(
      {
        session: {
          auth: {
            current: photonAuth(
              "fixture-owner",
              "imessage:fixture-thread",
              runtimeScopeA,
            ),
          },
        },
      },
      { workspaceId: workspaceB },
      ownerEnvironment,
    ),
  WorkspaceRuntimeScopeError,
);

const budgetClient = new MemoryCasStore();
await reserveWorkspaceRunBudget(
  {
    inputTokens: 100,
    now,
    outputTokens: 50,
    policy: budgetA.value,
    policyRevision: budgetA.revision,
    runId: "run_workspace_a",
    scope: scopeA,
  },
  budgetClient,
);
await assert.rejects(
  reserveWorkspaceRunBudget(
    {
      inputTokens: 100,
      now,
      outputTokens: 50,
      policy: budgetA.value,
      policyRevision: budgetA.revision,
      runId: "run_workspace_a_over_budget",
      scope: scopeA,
    },
    budgetClient,
  ),
  /budget_exhausted/u,
);
await reserveWorkspaceRunBudget(
  {
    inputTokens: 100,
    now,
    outputTokens: 50,
    policy: budgetB.value,
    policyRevision: budgetB.revision,
    runId: "run_workspace_b",
    scope: scopeB,
  },
  budgetClient,
);

console.log("Cross-owner and cross-workspace isolation verification passed.");
