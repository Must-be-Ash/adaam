import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  runSecIpoReadOnlyLiveSmoke,
  SecIpoLiveSmokeError,
} from "../agent/lib/sec-ipo-live-smoke";
import { SEC_IPO_SOURCE_URL } from "../agent/lib/sec-ipo-reference";

const body = await readFile(
  new URL("./fixtures/sec-ipo/initial.atom", import.meta.url),
  "utf8",
);
let requests = 0;
const result = await runSecIpoReadOnlyLiveSmoke({
  async fetch(url, init) {
    requests += 1;
    assert.equal(url, SEC_IPO_SOURCE_URL);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("user-agent"), "Adaam Smoke ops@adaam.dev");
    return new Response(body, {
      headers: { "content-type": "application/atom+xml; charset=UTF-8" },
      status: 200,
    });
  },
  now: new Date("2026-08-14T17:05:00.000Z"),
  userAgent: "Adaam Smoke ops@adaam.dev",
});
assert.equal(requests, 1);
assert.equal(result.evaluation.baselineEstablished, true);
assert.equal(result.evaluation.findings.length, 0);
assert.equal(result.evaluation.alerts.length, 0);
assert.equal(result.page.filings.length, 2);
assert.equal(result.evaluation.checkpoint.watermark, "2026-08-14T17:00:00.000Z");

for (const userAgent of [undefined, "bot", "Adaam Smoke local@example.invalid"]) {
  await assert.rejects(
    runSecIpoReadOnlyLiveSmoke({ fetch: async () => { throw new Error("must not fetch"); }, userAgent }),
    (error) =>
      error instanceof SecIpoLiveSmokeError &&
      error.code === "sec_user_agent_invalid",
  );
}
await assert.rejects(
  runSecIpoReadOnlyLiveSmoke({
    fetch: async () => new Response("x".repeat(2 * 1_024 * 1_024 + 1), {
      headers: { "content-type": "application/atom+xml" },
      status: 200,
    }),
    userAgent: "Adaam Smoke ops@adaam.dev",
  }),
  (error) =>
    error instanceof SecIpoLiveSmokeError &&
    error.code === "sec_live_response_oversized",
);

console.info("SEC IPO read-only live-smoke contract verification passed.");
