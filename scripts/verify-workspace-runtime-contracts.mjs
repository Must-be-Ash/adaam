import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { z } from "zod";

const fixtureRoot = new URL(
  "../specs/fixtures/01-independent-workspace-runtimes/",
  import.meta.url,
);

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

const recordTypes = [
  "owner_mapping",
  "photon_ingress",
  "workspace_assignment",
  "dispatch",
  "workspace",
  "monitor",
  "run",
  "budget",
  "finding",
  "alert",
  "delivery",
  "routing_decision",
];

const [jsonSchema, records, machineManifest, diagrams] = await Promise.all([
  readJson("records.schema.json"),
  readJson("records.valid.json"),
  readJson("state-machines.json"),
  readFile(new URL("state-diagrams.md", fixtureRoot), "utf8"),
]);

const fixtureSchema = z.fromJSONSchema(jsonSchema);
assert.deepEqual(fixtureSchema.parse(records), records);
assert.deepEqual(
  records.map((record) => record.recordType),
  recordTypes,
  "The fixture corpus must contain one stable example of every required record in contract order.",
);
assert.equal(new Set(records.map((record) => record.recordType)).size, 12);
for (const recordType of recordTypes) {
  assert.ok(jsonSchema.$defs[recordType], `Missing schema for ${recordType}.`);
  assert.equal(
    diagrams.includes(`\`${recordType}\``),
    true,
    `Missing diagram heading for ${recordType}.`,
  );
}

const byType = Object.fromEntries(
  records.map((record) => [record.recordType, record]),
);
const ownerId = byType.owner_mapping.ownerId;
for (const record of records.filter((record) => "ownerId" in record)) {
  assert.equal(record.ownerId, ownerId, `${record.recordType} crossed owner scope.`);
}

const workspaceId = byType.workspace.workspaceId;
for (const record of records.filter((record) => "workspaceId" in record)) {
  assert.equal(
    record.workspaceId,
    workspaceId,
    `${record.recordType} crossed workspace scope.`,
  );
}
assert.equal(byType.workspace_assignment.ingressId, byType.photon_ingress.ingressId);
assert.equal(byType.dispatch.ingressId, byType.photon_ingress.ingressId);
assert.equal(byType.dispatch.assignmentId, byType.workspace_assignment.assignmentId);
assert.equal(byType.run.monitorId, byType.monitor.monitorId);
assert.equal(byType.finding.runId, byType.run.runId);
assert.equal(byType.finding.findingId, byType.alert.findingId);
assert.equal(byType.alert.alertId, byType.delivery.alertId);
assert.equal(byType.routing_decision.candidateAlertId, byType.alert.alertId);
assert.equal(byType.monitor.sources.length, 1);
assert.deepEqual(byType.monitor.schedule.times, ["09:00", "16:00"]);
assert.equal(byType.monitor.workspaceBindingImmutable, true);
assert.equal(byType.workspace_assignment.immutable, true);

const serialized = JSON.stringify(records);
for (const forbiddenField of [
  "messageBody",
  "alertBody",
  "principalId",
  "threadId",
  "phoneNumber",
]) {
  assert.equal(
    serialized.includes(`\"${forbiddenField}\"`),
    false,
    `Fixture indexes must not contain ${forbiddenField}.`,
  );
}

for (const mutate of [
  (copy) => {
    copy[0].unexpected = true;
  },
  (copy) => {
    copy[2].immutable = false;
  },
  (copy) => {
    copy[5].workspaceBindingImmutable = false;
  },
  (copy) => {
    copy[5].sources = Array.from({ length: 9 }, () => copy[5].sources[0]);
  },
  (copy) => {
    copy[7].limits.unknownPriceCeiling = 0;
  },
]) {
  const invalid = structuredClone(records);
  mutate(invalid);
  assert.equal(fixtureSchema.safeParse(invalid).success, false);
}

const machineSchema = z.object({
  schemaVersion: z.literal(1),
  machines: z.array(
    z.object({
      recordType: z.enum(recordTypes),
      initial: z.string().min(1),
      terminal: z.array(z.string().min(1)).min(1),
      transitions: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1),
      forbidden: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1),
    }),
  ),
});
const machines = machineSchema.parse(machineManifest).machines;
assert.deepEqual(
  machines.map((machine) => machine.recordType),
  recordTypes,
  "Every durable record must have one state-machine contract.",
);

for (const machine of machines) {
  const transitionKeys = new Set(
    machine.transitions.map(([from, to]) => `${from}->${to}`),
  );
  const forbiddenKeys = new Set(
    machine.forbidden.map(([from, to]) => `${from}->${to}`),
  );
  assert.equal(transitionKeys.size, machine.transitions.length);
  assert.equal(forbiddenKeys.size, machine.forbidden.length);
  for (const key of forbiddenKeys) {
    assert.equal(
      transitionKeys.has(key),
      false,
      `${machine.recordType} marks ${key} both allowed and forbidden.`,
    );
  }
  const states = new Set([
    machine.initial,
    ...machine.terminal,
    ...machine.transitions.flat(),
    ...machine.forbidden.flat(),
  ]);
  for (const terminal of machine.terminal) {
    assert.ok(states.has(terminal));
  }
}

console.log("Workspace runtime contract fixtures passed.");
