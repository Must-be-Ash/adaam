import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
  SecIpoEvaluationError,
  type SecIpoCheckpoint,
} from "../agent/lib/sec-ipo-evaluation";
import {
  SEC_IPO_SOURCE_URL,
  SecIpoNormalizerError,
} from "../agent/lib/sec-ipo-reference";

const fixtureRoot = new URL("./fixtures/sec-ipo/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, fixtureRoot), "utf8");
const observed = {
  amendment: "2026-08-14T19:05:00.000Z",
  initial: "2026-08-14T17:05:00.000Z",
  later: "2026-08-14T18:05:00.000Z",
};
const contentType = "application/atom+xml; charset=UTF-8";
const normalize = async (name: string, observedAt: string) => normalizeSecIpoFetch({
  body: await fixture(name),
  contentType,
  finalUrl: SEC_IPO_SOURCE_URL,
  observedAt,
  requestedUrl: SEC_IPO_SOURCE_URL,
  status: 200,
});
const ownerId = "owner_fixture";
const workspaceA = { ownerId, workspaceId: "123e4567-e89b-42d3-a456-426614174000" };
const workspaceB = { ownerId, workspaceId: "223e4567-e89b-42d3-a456-426614174000" };

const initialPage = await normalize("initial.atom", observed.initial);
assert.equal(initialPage.filings.length, 2);
const initial = evaluateSecIpoPage(initialPage, null, workspaceA);
assert.equal(initial.baselineEstablished, true);
assert.equal(initial.findings.length, 0);
assert.equal(initial.alerts.length, 0);
assert.equal(initial.checkpoint.watermark, "2026-08-14T17:00:00.000Z");
const replayInitial = evaluateSecIpoPage(initialPage, initial.checkpoint, workspaceA);
assert.deepEqual(replayInitial.findings, []);
assert.deepEqual(replayInitial.alerts, []);
assert.deepEqual(replayInitial.checkpoint, initial.checkpoint);

const laterPage = await normalize("later-s1.atom", observed.later);
const later = evaluateSecIpoPage(laterPage, initial.checkpoint, workspaceA);
assert.equal(later.baselineEstablished, false);
assert.equal(later.findings.length, 1);
assert.equal(later.alerts.length, 1);
assert.equal(later.findings[0]?.filing.companyName, "New Candidate Corp");
assert.equal(later.findings[0]?.filing.classification, "new_registration");
assert.match(later.findings[0]?.summary ?? "", /potential IPO registration/u);
assert.equal(later.alerts[0]?.findingId, later.findings[0]?.findingId);
const replayLater = evaluateSecIpoPage(laterPage, later.checkpoint, workspaceA);
assert.deepEqual(replayLater.findings, []);
assert.deepEqual(replayLater.alerts, []);

const amendmentPage = await normalize("amendment.atom", observed.amendment);
const amendment = evaluateSecIpoPage(amendmentPage, later.checkpoint, workspaceA);
assert.equal(amendment.findings.length, 1);
assert.equal(amendment.alerts.length, 1);
assert.equal(amendment.findings[0]?.filing.classification, "amendment");
assert.match(amendment.alerts[0]?.title ?? "", /registration update/u);
assert.equal(
  amendment.findings[0]?.filing.registrationKey,
  later.findings[0]?.filing.registrationKey,
);
assert.notEqual(
  amendment.findings[0]?.filing.dedupeKey,
  later.findings[0]?.filing.dedupeKey,
);

await assert.rejects(
  normalize("malformed.atom", observed.later),
  SecIpoNormalizerError,
);
await assert.rejects(
  normalize("incomplete.atom", "2026-08-14T20:05:00.000Z"),
  (error) =>
    error instanceof SecIpoNormalizerError &&
    error.code === "sec_atom_incomplete",
);
assert.throws(
  () => normalizeSecIpoFetch({
    body: `${" ".repeat(2 * 1_024 * 1_024)}x`,
    contentType,
    finalUrl: SEC_IPO_SOURCE_URL,
    observedAt: observed.later,
    requestedUrl: SEC_IPO_SOURCE_URL,
    status: 200,
  }),
  (error) =>
    error instanceof SecIpoNormalizerError &&
    error.code === "sec_atom_oversized",
);
assert.throws(
  () => normalizeSecIpoFetch({
    body: "",
    contentType,
    finalUrl: "https://www.sec.gov/redirected-feed",
    observedAt: observed.later,
    requestedUrl: SEC_IPO_SOURCE_URL,
    status: 200,
  }),
  (error) =>
    error instanceof SecIpoEvaluationError &&
    error.code === "sec_atom_redirected",
);
for (const incomplete of [
  { status: 503, truncated: false, contentType },
  { status: 200, truncated: true, contentType },
  { status: 200, truncated: false, contentType: "text/html" },
]) {
  assert.throws(
    () => normalizeSecIpoFetch({
      body: "",
      finalUrl: SEC_IPO_SOURCE_URL,
      observedAt: observed.later,
      requestedUrl: SEC_IPO_SOURCE_URL,
      ...incomplete,
    }),
    (error) =>
      error instanceof SecIpoEvaluationError &&
      error.code === "sec_atom_fetch_incomplete",
  );
}
assert.throws(
  () => evaluateSecIpoPage(initialPage, later.checkpoint, workspaceA),
  (error) =>
    error instanceof SecIpoEvaluationError &&
    error.code === "sec_atom_stale",
);

class FixtureWorkspaceRuntime {
  readonly checkpoints = new Map<string, SecIpoCheckpoint>();
  run(workspace: typeof workspaceA, page: typeof initialPage) {
    const result = evaluateSecIpoPage(
      page,
      this.checkpoints.get(workspace.workspaceId) ?? null,
      workspace,
    );
    this.checkpoints.set(workspace.workspaceId, result.checkpoint);
    return result;
  }
}
const runtime = new FixtureWorkspaceRuntime();
const workspaceFixtures = JSON.parse(await fixture("workspaces.json"));
assert.equal(workspaceFixtures.length, 2);
assert.equal(workspaceFixtures[0].dueAt, workspaceFixtures[1].dueAt);
assert.deepEqual(
  workspaceFixtures.map((workspace: { workspaceId: string }) => workspace.workspaceId),
  [workspaceA.workspaceId, workspaceB.workspaceId],
);
const [baselineA, baselineB] = await Promise.all([
  Promise.resolve().then(() => runtime.run(workspaceA, initialPage)),
  Promise.resolve().then(() => runtime.run(workspaceB, initialPage)),
]);
assert.equal(baselineA.baselineEstablished, true);
assert.equal(baselineB.baselineEstablished, true);
const [concurrentA, concurrentB] = await Promise.all([
  Promise.resolve().then(() => runtime.run(workspaceA, laterPage)),
  Promise.resolve().then(() => runtime.run(workspaceB, laterPage)),
]);
assert.equal(concurrentA.findings.length, 1);
assert.equal(concurrentB.findings.length, 1);
assert.notEqual(concurrentA.findings[0]?.findingId, concurrentB.findings[0]?.findingId);
assert.notEqual(concurrentA.alerts[0]?.alertId, concurrentB.alerts[0]?.alertId);
assert.notStrictEqual(
  runtime.checkpoints.get(workspaceA.workspaceId),
  runtime.checkpoints.get(workspaceB.workspaceId),
);
assert.deepEqual(runtime.checkpoints.get(workspaceA.workspaceId), concurrentA.checkpoint);
assert.deepEqual(runtime.checkpoints.get(workspaceB.workspaceId), concurrentB.checkpoint);

const scenarios = JSON.parse(await fixture("scenarios.json"));
assert.deepEqual(scenarios.failures, [
  "malformed",
  "oversized",
  "stale",
  "redirected",
  "incomplete",
]);

console.info("SEC IPO reference fixture verification passed.");
