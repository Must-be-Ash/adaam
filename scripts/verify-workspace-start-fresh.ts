import assert from "node:assert/strict";

import { photonAuth } from "../agent/lib/photon-auth";
import {
  photonApprovalWorkspace,
} from "../agent/lib/photon-workspace";
import {
  getPhotonWorkspaceState,
  savePhotonWorkspaceSession,
  startFreshPhotonWorkspace,
  type PhotonWorkspaceStoreClient,
} from "../agent/lib/photon-workspace-store";
import {
  projectPhotonWorkspaceRuntimeScope,
  requirePhotonWorkspaceToolScope,
  WorkspaceRuntimeScopeError,
} from "../agent/lib/workspace-runtime-scope";
import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizePhotonWorkspaceControlPlaneStore } from "../agent/lib/workspace-store-authorization";

class WorkspaceRegistryMemoryStore implements PhotonWorkspaceStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(
    key: string,
    expected: string,
    next: string,
    approvalGuardKey?: string,
  ) {
    if (approvalGuardKey && this.values.has(approvalGuardKey)) return "blocked" as const;
    if (this.values.get(key) !== expected) return "conflict" as const;
    this.values.set(key, next);
    return "swapped" as const;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { nx?: true }) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
}

class WorkspaceStateMemoryStore implements WorkspaceStateStoreClient {
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
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture-owner",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
};
const route = {
  principalId: "imessage:fixture-owner",
  threadId: "imessage:fixture-thread",
};
const registryClient = new WorkspaceRegistryMemoryStore();
const before = await getPhotonWorkspaceState(route, registryClient);
await savePhotonWorkspaceSession(
  {
    ...route,
    generation: before.activeWorkspace.generation,
    sessionId: "session_before_start_fresh",
    workspaceId: before.activeWorkspace.id,
  },
  registryClient,
);
const stateBefore = await getPhotonWorkspaceState(route, registryClient);
const workspace = stateBefore.activeWorkspace;
const authorizedScope = authorizePhotonWorkspaceControlPlaneStore(
  {
    principalId: route.principalId,
    resource: "manager",
    workspaceId: workspace.id,
  },
  environment,
);
const stateClient = new WorkspaceStateMemoryStore();
const now = new Date("2026-08-14T12:00:00.000Z");
const documents = {
  brief: await writeWorkspaceDocument(
    "brief",
    {
      expectedRevision: 0,
      now,
      scope: authorizedScope,
      value: {
        currentFindingsSummary: "One retained finding.",
        goal: "Retain durable state across conversation resets.",
        lastMaterialChange: "Initialized.",
        openQuestions: [],
        promotedFacts: [],
        sourcePolicy: {
          allowedSourceIds: ["source.sec"],
          maximumAccessClassification: "public",
        },
        strategyConfigurationRevision: 1,
        thesis: "Session history is not durable workspace state.",
        watchlist: ["Example Corp"],
      },
    },
    stateClient,
  ),
  budget: await writeWorkspaceDocument(
    "budget",
    {
      expectedRevision: 0,
      now,
      scope: authorizedScope,
      value: {
        effectiveAt: now.toISOString(),
        maximumConcurrentWorkers: 1,
        maximumInputTokensPerDay: 10_000,
        maximumInputTokensPerRun: 5_000,
        maximumOutputTokensPerDay: 5_000,
        maximumOutputTokensPerRun: 2_000,
        maximumPaidPerCall: null,
        maximumPaidPerDay: null,
        maximumPaidPerMonth: null,
        maximumScheduledRunsPerDay: 2,
        ownerTimezone: "America/Vancouver",
        unknownPriceFallbackCeiling: "0.00",
      },
    },
    stateClient,
  ),
  capabilities: await writeWorkspaceDocument(
    "capabilities",
    {
      expectedRevision: 0,
      now,
      scope: authorizedScope,
      value: {
        connectionIds: [],
        controlPlaneToolIds: ["workspace.complete_run"],
        financialToolIds: [],
        hardDeniedCapabilityIds: ["broker.mutation"],
        maximumDataAccessClassification: "public",
        paidResearchAllowed: false,
        providerTools: [],
        researchToolIds: [],
        skills: [{ id: "fixture-skill", version: "1.0.0" }],
        sources: [{ origin: "https://www.sec.gov", sourceId: "source.sec" }],
        workerModelPolicy: {
          allowedModelIds: ["openai/gpt-5.5"],
          maximumOutputTokens: 2_000,
        },
      },
    },
    stateClient,
  ),
  strategy: await writeWorkspaceDocument(
    "strategy",
    {
      expectedRevision: 0,
      now,
      scope: authorizedScope,
      value: {
        configuration: { threshold: 2 },
        strategyPack: { id: "fixture-strategy", version: "1.0.0" },
      },
    },
    stateClient,
  ),
};

const oldRuntimeScope = projectPhotonWorkspaceRuntimeScope(
  {
    generation: workspace.generation,
    principalId: route.principalId,
    threadId: route.threadId,
    workspaceId: workspace.id,
  },
  environment,
);
const refreshed = await startFreshPhotonWorkspace(
  { ...route, workspaceId: workspace.id },
  registryClient,
);
assert.equal(refreshed.retiredSessionId, "session_before_start_fresh");
assert.equal(refreshed.state.activeWorkspace.id, workspace.id);
assert.equal(refreshed.state.activeWorkspace.generation, workspace.generation + 1);

for (const kind of ["brief", "strategy", "capabilities", "budget"] as const) {
  assert.deepEqual(
    await readWorkspaceDocument(kind, authorizedScope, stateClient),
    documents[kind],
  );
}

const staleApproval = {
  sessionId: "session_before_start_fresh",
  workspaceGeneration: workspace.generation,
  workspaceId: workspace.id,
};
assert.equal(photonApprovalWorkspace(refreshed.state, staleApproval), null);
assert.equal(
  photonApprovalWorkspace(refreshed.state, {
    ...staleApproval,
    sessionId: "session_after_start_fresh",
    workspaceGeneration: refreshed.state.activeWorkspace.generation,
  })?.id,
  workspace.id,
);
assert.throws(
  () =>
    requirePhotonWorkspaceToolScope(
      {
        session: {
          auth: {
            current: photonAuth(
              "fixture-owner",
              route.threadId,
              oldRuntimeScope,
            ),
          },
        },
      },
      {
        generation: refreshed.state.activeWorkspace.generation,
        workspaceId: workspace.id,
      },
      environment,
    ),
  WorkspaceRuntimeScopeError,
);

console.log("Start-fresh workspace lifecycle verification passed.");
