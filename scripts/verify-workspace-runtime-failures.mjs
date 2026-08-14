import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const fixtureRoot = new URL(
  "../specs/fixtures/01-independent-workspace-runtimes/",
  import.meta.url,
);
const fixtureUrl = new URL(
  "failure-cases.json",
  fixtureRoot,
);

const guardNames = [
  "scope",
  "unique_key",
  "immutable_assignment",
  "uncertain_replay",
  "revision",
  "capability",
  "budget",
  "workspace_route",
  "restore_resume",
  "generation",
  "alert_reply",
];

const requiredCases = [
  "cross_workspace_access",
  "duplicate_dispatch",
  "duplicate_webhook",
  "immutable_assignment",
  "dispatch_uncertainty",
  "delivery_uncertainty",
  "duplicate_alert_delivery",
  "stale_configuration",
  "capability_drift",
  "budget_exhaustion",
  "archive_routing",
  "restore_auto_resume",
  "start_fresh_stale_generation",
  "ambiguous_alert_reply",
];

const fixtureSchema = z.array(
  z.object({
    caseId: z.enum(requiredCases),
    guard: z.enum(guardNames),
    input: z.record(z.string(), z.unknown()),
    expectedFailure: z.enum(guardNames),
  }).strict(),
);

const fixtures = fixtureSchema.parse(
  JSON.parse(await readFile(fixtureUrl, "utf8")),
);
assert.deepEqual(fixtures.map((fixture) => fixture.caseId), requiredCases);
assert.equal(new Set(fixtures.map((fixture) => fixture.caseId)).size, requiredCases.length);

class ContractFailure extends Error {
  constructor(boundary) {
    super(`Pre-implementation contract rejected ${boundary}.`);
    this.boundary = boundary;
    this.name = "ContractFailure";
  }
}

function deny(boundary) {
  throw new ContractFailure(boundary);
}

const guards = {
  scope(input) {
    if (
      input.authorizedOwnerId !== input.targetOwnerId ||
      input.authorizedWorkspaceId !== input.targetWorkspaceId
    ) deny("scope");
  },
  unique_key(input) {
    if (input.seenKeys.includes(input.candidateKey)) deny("unique_key");
  },
  immutable_assignment(input) {
    if (
      input.currentWorkspaceId !== input.proposedWorkspaceId ||
      input.currentGeneration !== input.proposedGeneration
    ) deny("immutable_assignment");
  },
  uncertain_replay(input) {
    if (input.replayRequested && input.state.endsWith("_uncertain")) {
      deny("uncertain_replay");
    }
  },
  revision(input) {
    if (input.snapshottedRevision !== input.authoritativeRevision) deny("revision");
  },
  capability(input) {
    if (
      !input.toolReviewed ||
      input.hardDenied ||
      input.reviewedSchemaDigest !== input.currentSchemaDigest
    ) deny("capability");
  },
  budget(input) {
    if (input.reserved + input.requested > input.limit) deny("budget");
  },
  workspace_route(input) {
    if (input.workspaceState !== "active") deny("workspace_route");
  },
  restore_resume(input) {
    if (
      input.previousMonitorState === "suspended_archived" &&
      input.proposedMonitorState !== "paused"
    ) deny("restore_resume");
  },
  generation(input) {
    if (input.currentGeneration !== input.claimedGeneration) deny("generation");
  },
  alert_reply(input) {
    if (
      input.confidence === "high" &&
      input.candidateWorkspaceId !== input.selectedWorkspaceId &&
      input.explicitChoiceWorkspaceId === null
    ) deny("alert_reply");
  },
};

for (const fixture of fixtures) {
  assert.throws(
    () => guards[fixture.guard](fixture.input),
    (error) =>
      error instanceof ContractFailure &&
      error.boundary === fixture.expectedFailure,
    `${fixture.caseId} must be a deterministic pre-implementation failure.`,
  );
}

for (const [guard, input] of [
  ["scope", { authorizedOwnerId: "owner", authorizedWorkspaceId: "workspace", targetOwnerId: "owner", targetWorkspaceId: "workspace" }],
  ["unique_key", { seenKeys: ["existing"], candidateKey: "new" }],
  ["immutable_assignment", { currentWorkspaceId: "workspace", currentGeneration: 2, proposedWorkspaceId: "workspace", proposedGeneration: 2 }],
  ["uncertain_replay", { state: "completed", replayRequested: false }],
  ["revision", { snapshottedRevision: 5, authoritativeRevision: 5 }],
  ["capability", { reviewedSchemaDigest: "same", currentSchemaDigest: "same", toolReviewed: true, hardDenied: false }],
  ["budget", { limit: 8, reserved: 7, requested: 1 }],
  ["workspace_route", { workspaceState: "active" }],
  ["restore_resume", { previousMonitorState: "suspended_archived", proposedMonitorState: "paused" }],
  ["generation", { currentGeneration: 3, claimedGeneration: 3 }],
  ["alert_reply", { selectedWorkspaceId: "workspace_a", candidateWorkspaceId: "workspace_b", explicitChoiceWorkspaceId: "workspace_b", confidence: "high" }],
]) {
  assert.doesNotThrow(() => guards[guard](input), `${guard} rejected its safe control.`);
}

const transitionManifest = z.object({
  schemaVersion: z.literal(1),
  machines: z.array(
    z.object({
      recordType: z.string().min(1),
      transitions: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
      forbidden: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
    }).passthrough(),
  ),
}).parse(
  JSON.parse(
    await readFile(new URL("state-machines.json", fixtureRoot), "utf8"),
  ),
);

for (const machine of transitionManifest.machines) {
  const allowed = new Set(
    machine.transitions.map(([from, to]) => `${from}->${to}`),
  );
  const transition = (from, to) => {
    if (!allowed.has(`${from}->${to}`)) deny("transition");
  };
  for (const [from, to] of machine.transitions) {
    assert.doesNotThrow(
      () => transition(from, to),
      `${machine.recordType} must allow ${from}->${to}.`,
    );
  }
  for (const [from, to] of machine.forbidden) {
    assert.throws(
      () => transition(from, to),
      (error) =>
        error instanceof ContractFailure && error.boundary === "transition",
      `${machine.recordType} must deny ${from}->${to}.`,
    );
  }
}

console.log("Workspace runtime pre-implementation failure fixtures passed.");
