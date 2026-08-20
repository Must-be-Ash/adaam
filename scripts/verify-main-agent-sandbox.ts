import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

Object.assign(process.env, {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: "B".repeat(43),
  KV_REST_API_TOKEN: "fixture",
  KV_REST_API_URL: "https://fixture.invalid",
  REDIS_URL: "redis://fixture.invalid:6379",
});

const expectedBackend = process.env.EVE_MAIN_AGENT_SANDBOX_EXPECTED;

if (expectedBackend) {
  const eveEntry = import.meta.resolve("eve");
  const { compileAgent } = await import(
    new URL("./compiler/compile-agent.js", eveEntry).href
  ) as typeof import("../node_modules/eve/dist/src/compiler/compile-agent.js");
  const compilation = await compileAgent({ startPath: process.cwd() });
  assert.equal(
    compilation.manifest.sandbox?.backendName,
    expectedBackend,
    `The main agent must use ${expectedBackend} in this environment.`,
  );
} else {
  const jitiEntry = import.meta.resolve("jiti");
  const jitiCli = fileURLToPath(new URL("./jiti-cli.mjs", jitiEntry));
  const verificationScript = fileURLToPath(import.meta.url);

  for (const fixture of [
    { backend: "vercel", hosted: true },
    { backend: "just-bash", hosted: false },
  ] as const) {
    const environment = {
      ...process.env,
      EVE_MAIN_AGENT_SANDBOX_EXPECTED: fixture.backend,
    };
    if (fixture.hosted) environment.VERCEL = "1";
    else delete environment.VERCEL;

    const result = spawnSync(process.execPath, [jitiCli, verificationScript], {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${fixture.backend} verification failed.`);
  }
}

if (!expectedBackend) {
  console.log("Main agent sandbox selection verification passed.");
}
