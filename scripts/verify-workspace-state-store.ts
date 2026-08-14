import assert from "node:assert/strict";

import {
  readWorkspaceDocument,
  WORKSPACE_DOCUMENT_BYTE_LIMITS,
  WorkspaceStateConflictError,
  WorkspaceStateValidationError,
  writeWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";

class MemoryStore implements WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const client = new MemoryStore();
const scope = {
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
};
const otherScope = {
  ownerId: "owner_fixture",
  workspaceId: "223e4567-e89b-42d3-a456-426614174000",
};
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
const brief = await writeWorkspaceDocument(
  "brief",
  { ...scope, expectedRevision: 0, now, value: briefValue },
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
    ...scope,
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

const capabilities = await writeWorkspaceDocument(
  "capabilities",
  {
    ...scope,
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
      sources: [{ origin: "https://www.sec.gov", sourceId: "source.sec" }],
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

const budget = await writeWorkspaceDocument(
  "budget",
  {
    ...scope,
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
    ...scope,
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
    { ...scope, expectedRevision: 1, now, value: briefValue },
    client,
  ),
  WorkspaceStateConflictError,
);

const raceClient = new MemoryStore();
const raceResults = await Promise.allSettled([
  writeWorkspaceDocument(
    "brief",
    { ...scope, expectedRevision: 0, now, value: briefValue },
    raceClient,
  ),
  writeWorkspaceDocument(
    "brief",
    { ...scope, expectedRevision: 0, now, value: briefValue },
    raceClient,
  ),
]);
assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1);

await assert.rejects(
  writeWorkspaceDocument(
    "brief",
    {
      ...otherScope,
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
      ...otherScope,
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
      ...otherScope,
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
      ...otherScope,
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
      ...scope,
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

const corruptClient = new MemoryStore();
await writeWorkspaceDocument(
  "brief",
  { ...scope, expectedRevision: 0, now, value: briefValue },
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

console.log("Bounded workspace state store verification passed.");
