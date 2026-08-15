import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createJiti } from "jiti";

const WORKER_NODE_ID = "subagents/workspace-worker";
const EXPECTED_WORKER_DYNAMIC_TOOL_SLOTS = ["capabilities"];
const EXPECTED_WORKER_MODEL_TOOLS = ["load_skill"];

const fixtureEnvironment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
  EVE_OWNER_ALIAS_HMAC_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  EVE_PHOTON_OWNER_PRINCIPALS: "imessage:fixture",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  KV_REST_API_TOKEN: "fixture",
  KV_REST_API_URL: "https://fixture.invalid",
  REDIS_URL: "redis://localhost:6379",
} as const;

Object.assign(process.env, fixtureEnvironment);

const appRoot = process.cwd();
const eveEntry = import.meta.resolve("eve");
const [{ compileAgent }, { resolveRuntimeAgentGraph }, { buildToolSetWithProviderTools }] =
  await Promise.all([
    import(new URL("./compiler/compile-agent.js", eveEntry).href) as Promise<
      typeof import("../node_modules/eve/dist/src/compiler/compile-agent.js")
    >,
    import(new URL("./runtime/resolve-agent-graph.js", eveEntry).href) as Promise<
      typeof import("../node_modules/eve/dist/src/runtime/resolve-agent-graph.js")
    >,
    import(new URL("./harness/tools.js", eveEntry).href) as Promise<
      typeof import("../node_modules/eve/dist/src/harness/tools.js")
    >,
  ]);

const compilation = await compileAgent({ startPath: appRoot });
const serializedManifest = await readFile(compilation.paths.compiledManifestPath, "utf8");
const manifest = JSON.parse(serializedManifest) as typeof compilation.manifest;
const compiledWorker = manifest.subagents.find(({ nodeId }) => nodeId === WORKER_NODE_ID);
assert.ok(compiledWorker, `Compiled worker ${WORKER_NODE_ID} was not found.`);
assert.equal(compiledWorker.agent.config.model.routing.kind, "gateway");
assert.deepEqual(
  compiledWorker.agent.dynamicTools.map(({ slug }) => slug).sort(),
  EXPECTED_WORKER_DYNAMIC_TOOL_SLOTS,
);

const jiti = createJiti(import.meta.url, { interopDefault: false });
const moduleMapPath = join(appRoot, ".eve/compile/module-map.mjs");
const moduleMapModule = await jiti.import<{ moduleMap: unknown }>(
  pathToFileURL(moduleMapPath).href,
);
const graph = await resolveRuntimeAgentGraph({
  manifest,
  moduleMap: moduleMapModule.moduleMap as Parameters<typeof resolveRuntimeAgentGraph>[0]["moduleMap"],
});
const worker = graph.nodesByNodeId.get(WORKER_NODE_ID);
assert.ok(worker, `Resolved worker ${WORKER_NODE_ID} was not found.`);

const resolvedDefinitions = new Map(
  [...worker.toolRegistry.toolsByName].map(([name, registered]) => [
    name,
    registered.definition,
  ]),
);
assert.ok(worker.turnAgent.model, "The compiled worker must resolve a concrete model.");
const modelTools = await buildToolSetWithProviderTools({
  capabilities: { requestInput: false },
  modelReference: worker.turnAgent.model,
  tools: resolvedDefinitions,
  webSearchProvider: worker.agent.webSearchProvider,
});

assert.deepEqual(
  Object.keys(modelTools).sort(),
  EXPECTED_WORKER_MODEL_TOOLS,
  "The compiled worker exposed an undeclared built-in or provider-managed tool.",
);

console.info("Compiled workspace worker tool-surface verification passed.");
