import assert from "node:assert/strict";

import {
  authorizeWorkspaceSourceFetch,
  buildWorkspaceSourcePrompt,
  completeWorkspaceSourceCoverage,
  createWorkspaceSourceCoverage,
  markWorkspaceSourceSuccess,
  readWorkspaceSourceCoverage,
  reserveWorkspaceSourceAttempt,
  WorkspaceSourceCoverageError,
  type WorkspaceSourceCoverageClient,
} from "../agent/lib/workspace-source-coverage";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryStore implements WorkspaceSourceCoverageClient {
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

const environment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scope = authorizeDeploymentWorkspaceStore(
  {
    ownerId: "owner_fixture",
    workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const otherScope = authorizeDeploymentWorkspaceStore(
  {
    ownerId: "owner_fixture",
    workspaceId: "223e4567-e89b-42d3-a456-426614174000",
  },
  environment,
);
const now = new Date("2026-08-14T17:00:00.000Z");
const runId = "run_source_fixture";
const sources = [
  {
    canonicalUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
    origin: "https://www.sec.gov",
    sourceId: "sec.latest",
  },
  {
    canonicalUrl: "https://www.federalregister.gov/api/v1/documents.json",
    origin: "https://www.federalregister.gov",
    sourceId: "federal_register.latest",
  },
];
const client = new MemoryStore();
const initial = await createWorkspaceSourceCoverage(
  {
    configurationRevision: 3,
    monitorId: "423e4567-e89b-42d3-a456-426614174000",
    now,
    runId,
    scope,
    sources,
    window: {
      endAt: "2026-08-14T17:00:00.000Z",
      startAt: "2026-08-14T16:00:00.000Z",
    },
  },
  client,
);
assert.equal(initial.state, "evaluating");
assert.deepEqual(
  await createWorkspaceSourceCoverage(
    {
      configurationRevision: 3,
      monitorId: "423e4567-e89b-42d3-a456-426614174000",
      now,
      runId,
      scope,
      sources,
      window: {
        endAt: "2026-08-14T17:00:00.000Z",
        startAt: "2026-08-14T16:00:00.000Z",
      },
    },
    client,
  ),
  initial,
);
assert.equal(
  (await authorizeWorkspaceSourceFetch({
    runId,
    scope,
    sourceId: "sec.latest",
    url: sources[0]!.canonicalUrl,
  }, client)).sourceId,
  "sec.latest",
);
const prompt = buildWorkspaceSourcePrompt(initial);
assert.match(prompt, /sec\.latest: https:\/\/www\.sec\.gov/u);
assert.match(prompt, /Fetch each listed source exactly once/u);
for (const request of [
  { sourceId: "sec.latest", url: `${sources[0]!.canonicalUrl}&count=100` },
  { sourceId: "federal_register.latest", url: sources[0]!.canonicalUrl },
  { url: "https://www.sec.gov/Archives/edgar/data/1/fixture.txt" },
  { url: `${sources[0]!.canonicalUrl}#fragment` },
]) {
  await assert.rejects(
    authorizeWorkspaceSourceFetch({ runId, scope, ...request }, client),
    (error) =>
      error instanceof WorkspaceSourceCoverageError &&
      error.code === "source_outside_fence",
  );
}

const competingAttempts = await Promise.allSettled([
  reserveWorkspaceSourceAttempt(
    { now, runId, scope, sourceId: "sec.latest" },
    client,
  ),
  reserveWorkspaceSourceAttempt(
    { now, runId, scope, sourceId: "sec.latest" },
    client,
  ),
]);
assert.equal(competingAttempts.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(competingAttempts.filter((result) => result.status === "rejected").length, 1);
await assert.rejects(
  markWorkspaceSourceSuccess(
    {
      contentDigest: "b".repeat(64),
      now,
      runId,
      scope,
      sourceId: "federal_register.latest",
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_not_attempted",
);
await markWorkspaceSourceSuccess(
  {
    contentDigest: "a".repeat(64),
    now,
    runId,
    scope,
    sourceId: "sec.latest",
  },
  client,
);
await assert.rejects(
  completeWorkspaceSourceCoverage({ now, runId, scope }, client),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_coverage_incomplete",
);
await reserveWorkspaceSourceAttempt(
  { now, runId, scope, sourceId: "federal_register.latest" },
  client,
);
await markWorkspaceSourceSuccess(
  {
    contentDigest: "b".repeat(64),
    now,
    runId,
    scope,
    sourceId: "federal_register.latest",
  },
  client,
);
await markWorkspaceSourceSuccess(
  {
    contentDigest: "b".repeat(64),
    now,
    runId,
    scope,
    sourceId: "federal_register.latest",
  },
  client,
);
await assert.rejects(
  markWorkspaceSourceSuccess(
    {
      contentDigest: "c".repeat(64),
      now,
      runId,
      scope,
      sourceId: "federal_register.latest",
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_coverage_conflict",
);

const complete = await completeWorkspaceSourceCoverage({ now, runId, scope }, client);
assert.equal(complete.state, "complete");
assert.equal(complete.checkpoint?.watermark, "2026-08-14T17:00:00.000Z");
assert.match(complete.checkpoint?.contentDigest ?? "", /^[a-f0-9]{64}$/u);
assert.deepEqual(
  await completeWorkspaceSourceCoverage({ now, runId, scope }, client),
  complete,
);
assert.deepEqual(
  await completeWorkspaceSourceCoverage({
    checkpoint: {
      contentDigest: complete.checkpoint!.contentDigest,
      watermark: complete.checkpoint!.watermark,
    },
    now,
    runId,
    scope,
  }, client),
  complete,
);
await assert.rejects(
  completeWorkspaceSourceCoverage({
    checkpoint: {
      contentDigest: "c".repeat(64),
      watermark: complete.checkpoint!.watermark,
    },
    now,
    runId,
    scope,
  }, client),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_coverage_conflict",
);
assert.deepEqual(
  await createWorkspaceSourceCoverage(
    {
      configurationRevision: 3,
      monitorId: "423e4567-e89b-42d3-a456-426614174000",
      now,
      runId,
      scope,
      sources,
      window: {
        endAt: "2026-08-14T17:00:00.000Z",
        startAt: "2026-08-14T16:00:00.000Z",
      },
    },
    client,
  ),
  complete,
);
assert.deepEqual(await readWorkspaceSourceCoverage(scope, runId, client), complete);
assert.equal(await readWorkspaceSourceCoverage(otherScope, runId, client), null);
await assert.rejects(
  authorizeWorkspaceSourceFetch(
    { runId, scope, url: sources[0]!.canonicalUrl },
    client,
  ),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_outside_fence",
);

await assert.rejects(
  createWorkspaceSourceCoverage(
    {
      configurationRevision: 4,
      monitorId: "423e4567-e89b-42d3-a456-426614174000",
      now,
      runId,
      scope,
      sources,
      window: {
        endAt: "2026-08-14T17:00:00.000Z",
        startAt: "2026-08-14T16:00:00.000Z",
      },
    },
    client,
  ),
  (error) =>
    error instanceof WorkspaceSourceCoverageError &&
    error.code === "source_coverage_conflict",
);

console.info("Workspace source coverage verification passed.");
