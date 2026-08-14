import assert from "node:assert/strict";

import {
  emptyWorkspaceRuntimeCapabilities,
  resolveWorkspaceRuntimeCapabilities,
  WORKSPACE_RUNTIME_CAPABILITY_EVENT,
  WorkspaceRuntimeCapabilityError,
} from "../agent/lib/workspace-runtime-capabilities";

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
      "sec.get_filing",
      "sec.write_note",
      "workspace.read_findings",
    ],
    skills: [{ id: "filing-review", version: "1.0.0" }],
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
  "sec.get_filing",
  "workspace.complete_run",
  "workspace.read_findings",
]);
assert.equal(resolved.toolIds.includes("web.search"), false);
assert.equal(resolved.toolIds.includes("sec.write_note"), false);
assert.equal(resolved.toolIds.includes("coinbase_create_order"), false);
assert.deepEqual(resolved.skillIds, ["filing-review"]);
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
