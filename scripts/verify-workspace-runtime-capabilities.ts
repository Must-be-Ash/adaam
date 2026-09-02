import assert from "node:assert/strict";

import {
  emptyWorkspaceRuntimeCapabilities,
  resolveWorkspaceRuntimeCapabilities,
  SHARED_RUNTIME_HARD_DENIED_CAPABILITIES,
  WORKSPACE_RUNTIME_CAPABILITY_EVENT,
  WorkspaceRuntimeCapabilityError,
} from "../agent/lib/workspace-runtime-capabilities";
import {
  resolveWorkspaceWorkerCapabilitySnapshot,
} from "../agent/lib/workspace-worker-capabilities";
import {
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStateStore implements WorkspaceStateStoreClient {
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

const ownerId = "owner_fixture";
const workspaceId = "123e4567-e89b-42d3-a456-426614174000";
const manifest = {
  createdAt: "2026-08-14T12:00:00.000Z",
  ownerId,
  recordType: "workspace_capability_manifest" as const,
  revision: 4,
  schemaVersion: 1 as const,
  updatedAt: "2026-08-14T12:00:00.000Z",
  value: {
    connectionIds: ["sec"],
    controlPlaneToolIds: ["workspace.complete_run"],
    financialToolIds: ["coinbase_create_order"],
    hardDeniedCapabilityIds: ["filesystem.write"],
    maximumDataAccessClassification: "public" as const,
    paidResearchAllowed: true,
    providerTools: [
      {
        kind: "read" as const,
        providerId: "sec",
        schemaDigest: "a".repeat(64),
        toolId: "sec.get_filing",
      },
      {
        kind: "mutation" as const,
        providerId: "sec",
        schemaDigest: "b".repeat(64),
        toolId: "sec.write_note",
      },
    ],
    researchToolIds: [
      "fetch_public_source",
      "sec.get_filing",
      "sec.write_note",
      "workspace.read_findings",
    ],
    skills: [{ id: "public-event-monitoring", version: "1.0.0" }],
    sources: [{ origin: "https://www.sec.gov", sourceId: "source.sec" }],
    workerModelPolicy: {
      allowedModelIds: ["openai/gpt-5.5"],
      maximumOutputTokens: 8_000,
    },
  },
  workspaceId,
};
const catalog = [
  { category: "control_plane" as const, id: "workspace.complete_run" },
  { category: "research" as const, id: "fetch_public_source" },
  { category: "research" as const, id: "workspace.read_findings" },
  {
    category: "research" as const,
    id: "sec.get_filing",
    providerId: "sec",
    schemaDigest: "a".repeat(64),
  },
  {
    category: "research" as const,
    id: "sec.write_note",
    providerId: "sec",
    schemaDigest: "b".repeat(64),
  },
  { category: "financial" as const, id: "coinbase_create_order" },
  { category: "research" as const, id: "web.search" },
];

assert.equal(WORKSPACE_RUNTIME_CAPABILITY_EVENT, "step.started");
for (const toolId of [
  "agentcash_access_status",
  "agentcash_check_endpoint_schema",
  "agentcash_discover_api_endpoints",
  "agentcash_fetch",
  "agentcash_fetch_free",
  "agentcash_get_balance",
  "agentcash_get_settings",
  "agentcash_list_accounts",
  "agentcash_search",
  "agentcash_x402",
]) {
  assert.equal(
    SHARED_RUNTIME_HARD_DENIED_CAPABILITIES.includes(toolId as never),
    true,
    `${toolId} must remain denied in workspace workers`,
  );
}
assert.deepEqual(emptyWorkspaceRuntimeCapabilities(), {
  capabilityRevision: 0,
  connectionIds: [],
  paidResearchAllowed: false,
  skillIds: [],
  sourceIds: [],
  toolIds: [],
  workerModelIds: [],
});
assert.deepEqual(
  resolveWorkspaceRuntimeCapabilities({
    catalog,
    expectedCapabilityRevision: 4,
    manifest: null,
    ownerId,
    workspaceId,
  }).toolIds,
  [],
);

const resolved = resolveWorkspaceRuntimeCapabilities({
  catalog,
  expectedCapabilityRevision: 4,
  manifest,
  ownerId,
  workspaceId,
});
assert.deepEqual(resolved.toolIds, [
  "fetch_public_source",
  "sec.get_filing",
  "workspace.complete_run",
  "workspace.read_findings",
]);
assert.equal(resolved.toolIds.includes("web.search"), false);
assert.equal(resolved.toolIds.includes("sec.write_note"), false);
assert.equal(resolved.toolIds.includes("coinbase_create_order"), false);
assert.deepEqual(resolved.skillIds, ["public-event-monitoring"]);
assert.deepEqual(resolved.sourceIds, ["source.sec"]);
assert.equal(resolved.paidResearchAllowed, true);
assert.equal(Object.isFrozen(resolved), true);

const discoveredCatalog = [
  ...catalog,
  { category: "research" as const, id: "sec.new_read" },
  { category: "financial" as const, id: "sec.new_mutation" },
];
assert.deepEqual(
  resolveWorkspaceRuntimeCapabilities({
    catalog: discoveredCatalog,
    expectedCapabilityRevision: 4,
    manifest,
    ownerId,
    workspaceId,
  }).toolIds,
  resolved.toolIds,
);
assert.equal(
  resolveWorkspaceRuntimeCapabilities({
    catalog: catalog.map((tool) =>
      tool.id === "sec.get_filing"
        ? { ...tool, schemaDigest: "c".repeat(64) }
        : tool,
    ),
    expectedCapabilityRevision: 4,
    manifest,
    ownerId,
    workspaceId,
  }).toolIds.includes("sec.get_filing"),
  false,
);
assert.equal(
  resolveWorkspaceRuntimeCapabilities({
    catalog,
    deploymentHardDeniedIds: ["workspace.read_findings"],
    expectedCapabilityRevision: 4,
    manifest,
    ownerId,
    workspaceId,
  }).toolIds.includes("workspace.read_findings"),
  false,
);

for (const candidate of [
  { ...manifest, ownerId: "owner_other" },
  { ...manifest, workspaceId: "223e4567-e89b-42d3-a456-426614174000" },
]) {
  assert.throws(
    () =>
      resolveWorkspaceRuntimeCapabilities({
        catalog,
        expectedCapabilityRevision: 4,
        manifest: candidate,
        ownerId,
        workspaceId,
      }),
    (error) =>
      error instanceof WorkspaceRuntimeCapabilityError &&
      error.code === "capability_scope_mismatch",
  );
}
assert.throws(
  () =>
    resolveWorkspaceRuntimeCapabilities({
      catalog,
      expectedCapabilityRevision: 3,
      manifest,
      ownerId,
      workspaceId,
    }),
  (error) =>
    error instanceof WorkspaceRuntimeCapabilityError &&
    error.code === "capability_manifest_stale",
);

const stateClient = new MemoryStateStore();
const authorizedScope = authorizeDeploymentWorkspaceStore(
  { ownerId, workspaceId },
  { EVE_DEPLOYMENT_OWNER_ID: ownerId },
);
await writeWorkspaceDocument(
  "capabilities",
  {
    expectedRevision: 0,
    now: new Date("2026-08-14T12:00:00.000Z"),
    scope: authorizedScope,
    value: manifest.value,
  },
  stateClient,
);
const registrations = catalog.map((metadata) => ({
  definition: Object.freeze({ implementation: metadata.id }),
  metadata,
}));
registrations.push({
  definition: Object.freeze({ implementation: "sec.new_read" }),
  metadata: { category: "research" as const, id: "sec.new_read" },
});
const stepCapabilities = await resolveWorkspaceWorkerCapabilitySnapshot({
  envelope: {
    capabilityRevision: 1,
    ownerId,
    sources: [{
      accessClassification: "public" as const,
      canonicalUrl: "https://www.sec.gov/Archives/edgar/data/",
      origin: "https://www.sec.gov",
      sourceId: "source.sec",
    }],
    workspaceId,
  },
  registry: registrations,
  scope: authorizedScope,
  stateClient,
});
assert.deepEqual(Object.keys(stepCapabilities.tools), [
  "workspace.complete_run",
  "fetch_public_source",
  "workspace.read_findings",
  "sec.get_filing",
]);
assert.equal(Object.isFrozen(stepCapabilities.tools), true);
assert.deepEqual(stepCapabilities.skillIds, ["public-event-monitoring"]);
assert.equal("sec.new_read" in stepCapabilities.tools, false);

await assert.rejects(
  resolveWorkspaceWorkerCapabilitySnapshot({
    envelope: {
      capabilityRevision: 1,
      ownerId,
      sources: [{
        accessClassification: "public",
        canonicalUrl: "https://www.sec.gov/Archives/edgar/data/",
        origin: "https://www.sec.gov.evil.example",
        sourceId: "source.sec",
      }],
      workspaceId,
    },
    registry: registrations,
    scope: authorizedScope,
    stateClient,
  }),
  (error) =>
    error instanceof WorkspaceRuntimeCapabilityError &&
    error.code === "capability_scope_mismatch",
);

await writeWorkspaceDocument(
  "capabilities",
  {
    expectedRevision: 1,
    now: new Date("2026-08-14T12:01:00.000Z"),
    scope: authorizedScope,
    value: { ...manifest.value, researchToolIds: [] },
  },
  stateClient,
);
await assert.rejects(
  resolveWorkspaceWorkerCapabilitySnapshot({
    envelope: {
      capabilityRevision: 1,
      ownerId,
      sources: [{
        accessClassification: "public",
        canonicalUrl: "https://www.sec.gov/Archives/edgar/data/",
        origin: "https://www.sec.gov",
        sourceId: "source.sec",
      }],
      workspaceId,
    },
    registry: registrations,
    scope: authorizedScope,
    stateClient,
  }),
  (error) =>
    error instanceof WorkspaceRuntimeCapabilityError &&
    error.code === "capability_manifest_stale",
);

const refreshedCapabilities = await resolveWorkspaceWorkerCapabilitySnapshot({
  envelope: {
    capabilityRevision: 2,
    ownerId,
    sources: [{
      accessClassification: "public",
      canonicalUrl: "https://www.sec.gov/Archives/edgar/data/",
      origin: "https://www.sec.gov",
      sourceId: "source.sec",
    }],
    workspaceId,
  },
  registry: registrations,
  scope: authorizedScope,
  stateClient,
});
assert.deepEqual(Object.keys(refreshedCapabilities.tools), [
  "workspace.complete_run",
]);
assert.throws(
  () =>
    resolveWorkspaceRuntimeCapabilities({
      catalog: [...catalog, catalog[0]!],
      expectedCapabilityRevision: 4,
      manifest,
      ownerId,
      workspaceId,
    }),
  (error) =>
    error instanceof WorkspaceRuntimeCapabilityError &&
    error.code === "capability_catalog_invalid",
);

console.log("Default-deny workspace runtime capability verification passed.");
