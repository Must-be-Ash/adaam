import assert from "node:assert/strict";

import { fetchOfficialPublicSourceText } from "../agent/tools/fetch_public_source";

const initialUrl = "https://www.fda.gov/source.json";
const source = { origin: "https://www.fda.gov" } as const;

async function fetchThroughRedirect(location: string): Promise<{
  readonly requests: readonly string[];
  readonly result?: Awaited<ReturnType<typeof fetchOfficialPublicSourceText>>;
  readonly thrown?: unknown;
}> {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    assert.equal(init?.redirect, "manual");
    if (requests.length === 1) {
      return new Response(null, {
        headers: { location },
        status: 302,
      });
    }
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  };

  try {
    return {
      requests,
      result: await fetchOfficialPublicSourceText(initialUrl, source),
    };
  } catch (thrown) {
    return { requests, thrown };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const sameOrigin = await fetchThroughRedirect("/redirected.json");
assert.equal(sameOrigin.thrown, undefined);
assert.deepEqual(sameOrigin.requests, [
  initialUrl,
  "https://www.fda.gov/redirected.json",
]);
assert.equal(
  sameOrigin.result?.finalUrl,
  "https://www.fda.gov/redirected.json",
);

const undeclaredGovernmentOrigin = await fetchThroughRedirect(
  "https://www.cdc.gov/undeclared.json",
);
assert.match(
  String(undeclaredGovernmentOrigin.thrown),
  /exact configured origin fence/u,
);
assert.deepEqual(undeclaredGovernmentOrigin.requests, [initialUrl]);

for (const destination of [
  "https://127.0.0.1/private",
  "http://www.fda.gov/insecure",
  "https://user:password@www.fda.gov/credential-bearing",
]) {
  const invalid = await fetchThroughRedirect(destination);
  assert.match(
    String(invalid.thrown),
    /accepts only official HTTPS \.gov URLs/u,
  );
  assert.deepEqual(invalid.requests, [initialUrl]);
}

console.info("Workspace source redirect fence verification passed.");
