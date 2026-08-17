import assert from "node:assert/strict";

import {
  createEarningsCallPublicSourceFetch,
  isPublicEarningsCallAddress,
} from "../agent/lib/earnings-call-source-transport";
import {
  createEarningsCallSourceLifecycleStore,
} from "../agent/lib/earnings-call-source-lifecycle-store";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryCas implements HybridEvidenceArtifactIndexClient {
  readonly values = new Map<string, string>();
  compareAndSetCalls = 0;
  async compareAndSet(key: string, expected: string | null, next: string) {
    this.compareAndSetCalls += 1;
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) { this.values.set(key, Uint8Array.from(bytes)); }
}

for (const forbiddenAddress of [
  "127.0.0.1",
  "169.254.169.254",
  "::1",
  "::ffff:7f00:1",
  "fd00:ec2::254",
  "fe80::1",
]) assert.equal(isPublicEarningsCallAddress(forbiddenAddress), false);
assert.equal(isPublicEarningsCallAddress("93.184.216.34"), true);

let requests = 0;
const reviewedListing = "https://www.jpmorganchase.com/services/json/v1/investor-relations/quarterly-earnings.json";
const blockedRedirect = createEarningsCallPublicSourceFetch({
  fetch: async () => {
    requests += 1;
    return new Response(null, {
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      status: 302,
    });
  },
  resolveAddresses: async () => ["93.184.216.34"],
});
await assert.rejects(() => blockedRedirect({
  headers: { Accept: "application/json" },
  kind: "issuer_discovery",
  maximumBytes: 1024,
  url: reviewedListing,
}), /transport_origin_forbidden/u);
assert.equal(requests, 1, "the untrusted redirect destination must never be requested");

requests = 0;
let resolutions = 0;
const reboundRedirect = createEarningsCallPublicSourceFetch({
  fetch: async () => {
    requests += 1;
    return new Response(null, { headers: { location: "/services/json/v1/investor-relations/quarterly-earnings.json" }, status: 302 });
  },
  resolveAddresses: async () => {
    resolutions += 1;
    return resolutions === 1 ? ["93.184.216.34"] : ["169.254.169.254"];
  },
});
await assert.rejects(() => reboundRedirect({
  headers: { Accept: "application/json" },
  kind: "issuer_discovery",
  maximumBytes: 1024,
  url: reviewedListing,
}), /transport_address_forbidden/u);
assert.equal(requests, 1, "a redirect whose reviewed host resolves privately must not be requested");

requests = 0;
const blockedResolution = createEarningsCallPublicSourceFetch({
  fetch: async () => {
    requests += 1;
    return new Response("unexpected", { status: 200 });
  },
  resolveAddresses: async () => ["127.0.0.1"],
});
await assert.rejects(() => blockedResolution({
  headers: { Accept: "application/json" },
  kind: "issuer_discovery",
  maximumBytes: 1024,
  url: reviewedListing,
}), /transport_address_forbidden/u);
assert.equal(requests, 0, "private DNS resolution must fail before the first request");

const priorArtifact = "https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/1st-quarter/1q26-earnings-transcript.pdf";
const currentArtifact = "https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/2nd-quarter/2Q26-earnings-transcript.pdf";
requests = 0;
const reviewedRedirect = createEarningsCallPublicSourceFetch({
  fetch: async (url) => {
    requests += 1;
    return url.toString() === priorArtifact
      ? new Response(null, { headers: { location: currentArtifact }, status: 302 })
      : new Response("%PDF-1.7\nfixture", { headers: { "content-type": "application/pdf" }, status: 200 });
  },
  resolveAddresses: async () => ["93.184.216.34"],
});
const redirected = await reviewedRedirect({
  headers: { Accept: "application/pdf" },
  kind: "transcript_artifact",
  maximumBytes: 1024,
  url: priorArtifact,
});
assert.equal(requests, 2);
assert.deepEqual(redirected.redirectChain, [priorArtifact, currentArtifact]);

const lifecycleMemory = new MemoryCas();
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174490",
}, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const lifecycle = createEarningsCallSourceLifecycleStore(lifecycleMemory);
await lifecycle.recordAcknowledgement({
  acquisitionId: "acquisition.fixture.committed",
  expectedDeliveryRevision: 0,
  monitorId: "223e4567-e89b-42d3-a456-426614174490",
  occurrenceKey: "occurrence.fixture.committed",
  scope,
  sourceId: "earnings-call-transcripts.0000019617",
  subscriptionId: "subscription.fixture.committed",
});
assert.equal((await lifecycle.listAcknowledgements({
  occurrenceKey: "occurrence.fixture.committed",
  scope,
})).length, 1);
await lifecycle.completeAcknowledgement({
  acquisitionId: "acquisition.fixture.committed",
  occurrenceKey: "occurrence.fixture.committed",
  scope,
  subscriptionId: "subscription.fixture.committed",
});
assert.equal((await lifecycle.listAcknowledgements({
  occurrenceKey: "occurrence.fixture.committed",
  scope,
})).length, 0);
await lifecycle.recordRetry({
  acquisitionId: "acquisition.fixture.retry",
  monitorId: "223e4567-e89b-42d3-a456-426614174490",
  occurrenceKey: "occurrence.fixture.retry",
  retryAfterSeconds: 60,
  runId: "run.fixture.retry",
  scope,
  sourceId: "earnings-call-transcripts.0000019617",
  now: new Date("2026-08-17T20:00:00.000Z"),
});
const retry = await lifecycle.readRetry({
  occurrenceKey: "occurrence.fixture.retry",
  scope,
});
assert.equal(retry?.retryAt, "2026-08-17T20:01:00.000Z");
await lifecycle.clearRetry({ occurrenceKey: "occurrence.fixture.retry", scope });
assert.equal(await lifecycle.readRetry({ occurrenceKey: "occurrence.fixture.retry", scope }), null);

const artifactMemory = new MemoryCas();
const blobs = new MemoryBlob();
const ephemeral = createHybridEvidenceEphemeralArtifactStore({
  blob: blobs,
  index: artifactMemory,
  quota: {
    deploymentBytesPerDay: 10_000,
    deploymentCountPerDay: 10,
    sourceBytesPerDay: 10_000,
    sourceCountPerDay: 10,
  },
});
const bytes = Buffer.from("bounded transcript evidence", "utf8");
const manifest = await ephemeral.persist({
  acquisitionId: "acquisition.fixture.ephemeral",
  authority: "Issuer IR",
  bytes,
  canonicalPublicUrl: reviewedListing,
  mediaType: "text/plain",
  observedAt: "2026-08-17T20:00:00.000Z",
  parserEligibility: null,
  sourceInstanceId: "source.fixture.ephemeral",
  structure: {
    characterCount: bytes.toString("utf8").length,
    columnCount: null,
    pageCount: null,
    rowCount: null,
    sheetCount: null,
  },
});
await ephemeral.setReference({
  active: true,
  artifactDigest: manifest.contentDigest,
  kind: "current_lineage",
  referenceId: "earnings-job.fixture",
});
await ephemeral.setReference({
  active: true,
  artifactDigest: manifest.contentDigest,
  kind: "accepted_result",
  referenceId: "semantic-result.fixture",
});
assert.equal(
  await ephemeral.deleteUnreferenced(manifest.contentDigest),
  false,
  "job-scoped lineage must keep evidence available while semantic work is active",
);
const compareAndSetCallsAfterActiveDelete = artifactMemory.compareAndSetCalls;
assert.equal(
  await ephemeral.deleteUnreferenced(manifest.contentDigest),
  false,
  "repeated active cleanup remains inert",
);
assert.equal(
  artifactMemory.compareAndSetCalls,
  compareAndSetCallsAfterActiveDelete,
  "inert cleanup must preserve the same-reference no-change signal without a CAS write",
);
await ephemeral.setReference({
  active: false,
  artifactDigest: manifest.contentDigest,
  kind: "current_lineage",
  referenceId: "earnings-job.fixture",
});
await ephemeral.deleteUnreferenced(manifest.contentDigest);
assert.equal(await ephemeral.readManifest(manifest.contentDigest), null);
assert.equal(blobs.values.size, 0, "ephemeral transcript bytes must be deterministically removed");

console.log("earnings call source lifecycle verification passed");
