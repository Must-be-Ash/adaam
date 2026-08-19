import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  readPublicSourceFactRevision,
  type PublicSourceAcquisitionStoreClient,
} from "../agent/lib/public-source-acquisition-store";
import {
  createOfficialWebStatementFetch,
  parseOfficialWebStatementFeed,
  runSharedOfficialWebStatementAcquisition,
} from "../agent/lib/official-web-statement-adapter";
import { publicStatementSchema } from "../agent/lib/public-commentary-schema";
import type { RevocableEvidenceStoreClient } from "../agent/lib/revocable-evidence-store";
import { PUBLIC_COMMENTARY_TRACKER_SOURCE_ID } from "../agent/lib/strategy-pack-reference-catalog";

class MemoryStore implements PublicSourceAcquisitionStoreClient, RevocableEvidenceStoreClient {
  readonly records = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    const current = this.records.get(key) ?? null;
    if (current !== expected) return false;
    this.records.set(key, next);
    return true;
  }
  async delete(key: string) { return this.records.delete(key); }
  async get(key: string) { return this.records.get(key) ?? null; }
}

const feed = (text: string) => `<?xml version="1.0"?><rss><channel><item>
  <title>Statement on Iran</title>
  <link>https://www.whitehouse.gov/briefings-statements/2026/08/statement-on-iran/</link>
  <pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
  <description><![CDATA[<p>${text}</p>]]></description>
</item></channel></rss>`;
assert.deepEqual(parseOfficialWebStatementFeed(feed("We agreed to a ceasefire and negotiations with Iran.")).map(({ text }) => text), [
  "We agreed to a ceasefire and negotiations with Iran.",
]);
assert.deepEqual(parseOfficialWebStatementFeed(feed("safe").replace(
  "https://www.whitehouse.gov/",
  "https://www.whitehouse.gov.evil.example/",
)), []);
await assert.rejects(
  createOfficialWebStatementFetch({
    fetchImpl: async () => new Response("", { headers: { "content-length": String(2 * 1_024 * 1_024 + 1) } }),
  })(),
  /official_web_response_oversized/u,
);

const store = new MemoryStore();
const evidence = { client: store, encryptionKey: randomBytes(32), keyReference: "kms://fixture/official-web" };
const window = { endAt: "2026-08-18T13:00:00.000Z", startAt: "2026-08-18T01:00:00.000Z" };
const response = (body: string) => async () => ({
  body,
  finalUrl: "https://www.whitehouse.gov/briefings-statements/feed/",
  observedAt: window.endAt,
  requestedUrl: "https://www.whitehouse.gov/briefings-statements/feed/",
  status: 200,
});
const first = await runSharedOfficialWebStatementAcquisition({
  client: store,
  evidence,
  fetchResponse: response(feed("We agreed to a ceasefire and negotiations with Iran.")),
  sourceId: PUBLIC_COMMENTARY_TRACKER_SOURCE_ID,
  window,
});
assert.equal(first.acquisition.status, "complete");
assert.equal(first.acquisition.candidateFactRevisionIds.length, 1);
const fact = await readPublicSourceFactRevision(first.acquisition.candidateFactRevisionIds[0]!, store);
assert.ok(fact);
assert.equal(fact.adapterId, "official-web-statements");
assert.equal(publicStatementSchema.parse(fact.payload.statement).provider, "web");
const replay = await runSharedOfficialWebStatementAcquisition({
  client: store,
  evidence,
  fetchResponse: async () => { throw new Error("replay_must_not_fetch"); },
  sourceId: PUBLIC_COMMENTARY_TRACKER_SOURCE_ID,
  window,
});
assert.equal(replay.reused, true);
assert.equal(replay.acquisition.acquisitionId, first.acquisition.acquisitionId);

const correctionWindow = { endAt: "2026-08-18T15:00:00.000Z", startAt: "2026-08-18T13:00:00.000Z" };
const correctedFeed = (text: string) => `<?xml version="1.0"?><rss><channel><item>
  <title>Updated statement on Iran</title>
  <link>https://www.whitehouse.gov/briefings-statements/2026/08/statement-on-iran/</link>
  <pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
  <description><![CDATA[<p>${text}</p>]]></description>
</item></channel></rss>`;
const corrected = await runSharedOfficialWebStatementAcquisition({
  client: store,
  evidence,
  fetchResponse: async () => ({
    body: correctedFeed("We ended the ceasefire and resumed maximum pressure against Iran."),
    finalUrl: "https://www.whitehouse.gov/briefings-statements/feed/",
    observedAt: correctionWindow.endAt,
    requestedUrl: "https://www.whitehouse.gov/briefings-statements/feed/",
    status: 200,
  }),
  sourceId: PUBLIC_COMMENTARY_TRACKER_SOURCE_ID,
  window: correctionWindow,
});
assert.equal(corrected.acquisition.status, "complete");
assert.equal(corrected.acquisition.correctionIds.length, 1);
const correctedFact = await readPublicSourceFactRevision(corrected.acquisition.candidateFactRevisionIds[0]!, store);
assert.ok(correctedFact);
const correctedStatement = publicStatementSchema.parse(correctedFact.payload.statement);
assert.equal(correctedStatement.lifecycle, "edited");
assert.equal(correctedStatement.revision, 2);
assert.equal(correctedStatement.document.revisionIds.length, 2);

console.info("Official White House public-statement source verification passed.");
