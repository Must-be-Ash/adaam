import assert from "node:assert/strict";

import {
  reportProviderToolDrift,
  UNAVAILABLE_CAPABILITY_REASONS,
  workspaceCapabilityAvailability,
} from "../agent/lib/workspace-capability-drift";

const reviewed = [
  {
    kind: "read" as const,
    providerId: "fixture",
    schemaDigest: "a".repeat(64),
    toolId: "fixture.removed",
  },
  {
    kind: "read" as const,
    providerId: "fixture",
    schemaDigest: "b".repeat(64),
    toolId: "fixture.changed",
  },
  {
    kind: "read" as const,
    providerId: "fixture",
    schemaDigest: "c".repeat(64),
    toolId: "fixture.allowed",
  },
];
const current = [
  {
    kind: "read" as const,
    providerId: "fixture",
    schemaDigest: "d".repeat(64),
    toolId: "fixture.changed",
  },
  reviewed[2]!,
  {
    kind: "read" as const,
    providerId: "fixture",
    schemaDigest: "e".repeat(64),
    toolId: "fixture.new_read",
  },
  {
    kind: "mutation" as const,
    providerId: "fixture",
    schemaDigest: "f".repeat(64),
    toolId: "fixture.new_mutation",
  },
];
const report = reportProviderToolDrift({ current, reviewed });
assert.equal(report.status, "drifted");
assert.deepEqual(
  report.entries.map((entry) => entry.kind).sort(),
  ["new_mutation", "new_read", "removed", "schema_changed"].sort(),
);
assert.equal(Object.isFrozen(report.entries), true);
assert.equal(
  report.entries.find((entry) => entry.kind === "new_mutation")
    ?.reviewedSchemaDigest,
  null,
);
assert.deepEqual(
  reportProviderToolDrift({ current: reviewed, reviewed }),
  { entries: [], status: "clean" },
);

assert.deepEqual(UNAVAILABLE_CAPABILITY_REASONS, [
  "authorization",
  "safety_policy",
  "runtime_restriction",
  "missing_integration",
  "provider_drift",
]);
const manifest = {
  connectionIds: ["fixture"],
  controlPlaneToolIds: ["workspace.complete_run"],
  financialToolIds: ["coinbase_create_order"],
  hardDeniedCapabilityIds: ["filesystem.write"],
  maximumDataAccessClassification: "public" as const,
  paidResearchAllowed: false,
  providerTools: reviewed,
  researchToolIds: ["fixture.allowed"],
  skills: [],
  sources: [],
  workerModelPolicy: {
    allowedModelIds: ["openai/gpt-5.5"],
    maximumOutputTokens: 8_000,
  },
};
const catalog = [
  {
    category: "research" as const,
    id: "fixture.allowed",
    providerId: "fixture",
    schemaDigest: "c".repeat(64),
  },
  { category: "financial" as const, id: "coinbase_create_order" },
  { category: "control_plane" as const, id: "workspace.complete_run" },
  { category: "control_plane" as const, id: "workspace.ungranted" },
];
assert.deepEqual(
  workspaceCapabilityAvailability({
    authorizedConnectionIds: ["fixture"],
    catalog,
    manifest,
    providerId: "fixture",
    toolId: "fixture.allowed",
  }),
  { available: true, reason: null },
);
for (const [expected, input] of [
  [
    "authorization",
    { catalog, manifest, providerId: "fixture", toolId: "fixture.allowed" },
  ],
  [
    "safety_policy",
    { catalog, manifest, toolId: "filesystem.write" },
  ],
  [
    "runtime_restriction",
    { catalog, manifest, toolId: "workspace.ungranted" },
  ],
  ["missing_integration", { catalog, manifest, toolId: "missing.tool" }],
  [
    "provider_drift",
    { catalog, manifest, providerId: "fixture", toolId: "fixture.new_read" },
  ],
] as const) {
  const availability = workspaceCapabilityAvailability(input);
  assert.equal(availability.available, false);
  assert.equal(availability.reason?.code, expected);
}

console.log("Provider capability drift verification passed.");
