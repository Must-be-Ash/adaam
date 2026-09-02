import assert from "node:assert/strict";

import { getPublicFeed } from "../agent/lib/public-feeds";
import { resolveWorkspaceRuntimeCapabilities } from "../agent/lib/workspace-runtime-capabilities";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  IPO_FILINGS_CAPABILITY_MANIFEST,
  normalizeSecIpoAtom,
  SEC_IPO_NORMALIZER_VERSION,
  SEC_IPO_SOURCE_ALLOWED_ORIGINS,
  SEC_IPO_SOURCE_CONTRACT_DIGEST,
  SEC_IPO_SOURCE_CONTRACT_VERSION,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
  SecIpoNormalizerError,
} from "../agent/lib/sec-ipo-reference";
import { writeWorkspaceDocument, type WorkspaceStateStoreClient } from "../agent/lib/workspace-state-store";
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

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Latest S-1 filings</title>
  <entry>
    <title>S-1 - Fixture Corp (0001234567) (Filer)</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/fixture-s1-index.htm" />
    <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000001</id>
    <updated>2026-08-14T20:00:00-04:00</updated>
    <published>2026-08-14T19:59:00-04:00</published>
    <category term="S-1" label="form type" />
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-14 &lt;b&gt;File No.:&lt;/b&gt; 333-123456</summary>
  </entry>
  <entry>
    <title>S-1/A - Fixture Corp (0001234567) (Filer)</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000002/fixture-s1a-index.html" />
    <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000002</id>
    <updated>2026-08-14T21:00:00-04:00</updated>
    <category term="S-1/A" label="form type" />
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-14 &lt;b&gt;File Number:&lt;/b&gt; 333-123456</summary>
  </entry>
  <entry>
    <title>S-1 - Fixture Corp (0001234567) (Filer)</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/fixture-s1-index.htm" />
    <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000001</id>
    <updated>2026-08-14T20:00:00-04:00</updated>
    <published>2026-08-14T19:59:00-04:00</published>
    <category term="S-1" label="form type" />
    <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-08-14 &lt;b&gt;File No.:&lt;/b&gt; 333-123456</summary>
  </entry>
</feed>`;

const observedAt = "2026-08-15T01:05:00.000Z";
const page = normalizeSecIpoAtom(atom, { observedAt });
assert.equal(page.sourceId, SEC_IPO_SOURCE_ID);
assert.equal(page.sourceUrl, SEC_IPO_SOURCE_URL);
assert.equal(page.normalizerVersion, SEC_IPO_NORMALIZER_VERSION);
assert.equal(page.filings.length, 2);
const [registration, amendment] = page.filings;
assert.ok(registration);
assert.ok(amendment);
assert.deepEqual({
  accessionNumber: registration.accessionNumber,
  cik: registration.cik,
  classification: registration.classification,
  companyName: registration.companyName,
  fileNumber: registration.fileNumber,
  formType: registration.formType,
  observedAt: registration.observedAt,
}, {
  accessionNumber: "0001234567-26-000001",
  cik: "0001234567",
  classification: "new_registration",
  companyName: "Fixture Corp",
  fileNumber: "333-123456",
  formType: "S-1",
  observedAt,
});
assert.equal(amendment.classification, "amendment");
assert.equal(amendment.registrationKey, registration.registrationKey);
assert.notEqual(amendment.dedupeKey, registration.dedupeKey);
assert.match(registration.contentHash, /^[a-f0-9]{64}$/u);
assert.equal(Object.isFrozen(page.filings), true);
assert.equal(Object.isFrozen(registration), true);
assert.equal(
  normalizeSecIpoAtom(atom, { observedAt: "2026-08-15T02:05:00.000Z" }).filings[0]?.contentHash,
  registration.contentHash,
);

const feed = getPublicFeed(SEC_IPO_SOURCE_ID);
assert.equal(feed?.url, SEC_IPO_SOURCE_URL);
assert.equal(feed?.format, "atom");
assert.equal(feed?.authentication, "none");
assert.deepEqual(IPO_FILINGS_CAPABILITY_MANIFEST.connectionIds, []);
assert.equal(IPO_FILINGS_CAPABILITY_MANIFEST.paidResearchAllowed, false);
assert.equal(IPO_FILINGS_CAPABILITY_MANIFEST.maximumDataAccessClassification, "public");
for (const denied of [
  "bash",
  "coinbase_mcp",
  "filesystem.write",
  "agentcash_x402",
  "private.history",
  "web_search",
]) {
  assert.equal(IPO_FILINGS_CAPABILITY_MANIFEST.hardDeniedCapabilityIds.includes(denied), true);
}
const stateClient = new MemoryStateStore();
const scope = authorizeDeploymentWorkspaceStore({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
}, { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" });
const storedManifest = await writeWorkspaceDocument("capabilities", {
  expectedRevision: 0,
  now: new Date(observedAt),
  scope,
  value: IPO_FILINGS_CAPABILITY_MANIFEST,
}, stateClient);
assert.deepEqual(storedManifest.value.sources, [
  {
    allowedOrigins: [...SEC_IPO_SOURCE_ALLOWED_ORIGINS],
    contractDigest: SEC_IPO_SOURCE_CONTRACT_DIGEST,
    contractVersion: SEC_IPO_SOURCE_CONTRACT_VERSION,
    origin: "https://www.sec.gov",
    sourceId: SEC_IPO_SOURCE_ID,
  },
]);
assert.deepEqual(storedManifest.value.researchToolIds, []);
assert.deepEqual(resolveWorkspaceRuntimeCapabilities({
  catalog: [
    {
      category: "control_plane",
      id: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
    },
    { category: "control_plane", id: "complete_workspace_run" },
    { category: "control_plane", id: "stage_workspace_alert" },
    { category: "control_plane", id: "write_workspace_finding" },
    { category: "research", id: "fetch_public_source" },
    { category: "research", id: "agentcash_x402" },
    { category: "research", id: "web_search" },
    { category: "financial", id: "coinbase_create_order" },
  ],
  expectedCapabilityRevision: storedManifest.revision,
  manifest: storedManifest,
  ownerId: scope.ownerId,
  workspaceId: scope.workspaceId,
}).toolIds, [
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
]);

for (const invalid of [
  atom.replace("<feed", "<rss").replace("</feed>", "</rss>"),
  atom.replace("000123456726000001", "999999999926000001"),
  atom.replace("https://www.sec.gov/Archives", "https://sec.gov.evil.example/Archives"),
  `<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${atom}`,
]) {
  assert.throws(
    () => normalizeSecIpoAtom(invalid, { observedAt }),
    SecIpoNormalizerError,
  );
}

console.info("IPO Filings manifest and SEC Atom normalizer verification passed.");
