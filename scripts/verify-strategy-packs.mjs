import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StrategyPackGenerationError,
  generateStrategyPackCatalog,
} from "./generate-strategy-pack-catalog.mjs";
import {
  createStrategyPackCatalog,
} from "../agent/lib/strategy-pack-catalog.ts";
import {
  resolveStrategyPackBindingAvailability,
  resolveStrategyPackFlags,
} from "../agent/lib/strategy-pack-flags.ts";
import {
  CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  STRATEGY_PACK_REFERENCE_CATALOG,
} from "../agent/lib/strategy-pack-reference-catalog.ts";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  SEC_IPO_SOURCE_ALLOWED_ORIGINS,
  SEC_IPO_SOURCE_CONTRACT_DIGEST,
  SEC_IPO_SOURCE_CONTRACT_VERSION,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
} from "../agent/lib/sec-ipo-reference.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(scriptDirectory, "fixtures", "strategy-packs", "valid");
const productionRoot = resolve(scriptDirectory, "..", "strategy-packs");
const committedOutput = resolve(
  scriptDirectory,
  "..",
  "agent",
  "lib",
  "strategy-pack-catalog.generated.ts",
);

const references = Object.freeze({
  alertPresentationIds: Object.freeze([
    "alert.beta/v1",
    "alert.public-event/v1",
  ]),
  capabilityIds: Object.freeze([
    "skill.alpha-playbook",
    "skill.beta-playbook",
    "tool.alpha.fetch",
    "tool.beta.fetch",
  ]),
  evalSuites: Object.freeze({
    "eval.alpha/v1": Object.freeze([
      "fixture.alpha.forbidden",
      "fixture.alpha.malformed",
      "fixture.alpha.no-match",
      "fixture.alpha.positive",
      "fixture.alpha.replay",
    ]),
    "eval.beta/v1": Object.freeze([
      "fixture.beta.forbidden",
      "fixture.beta.malformed",
      "fixture.beta.no-match",
      "fixture.beta.positive",
      "fixture.beta.replay",
    ]),
  }),
  findingSchemaIds: Object.freeze(["finding.alpha/v1", "finding.beta/v1"]),
  parameterizedSourceContracts: STRATEGY_PACK_REFERENCE_CATALOG.parameterizedSourceContracts,
  sourceContracts: Object.freeze({
    "source.alpha": Object.freeze({
      allowedOrigins: Object.freeze(["https://alpha.example.gov"]),
      canonicalUrl: "https://alpha.example.gov/events.json",
      contractDigest: "a".repeat(64),
      contractVersion: "1.0.0",
    }),
    "source.beta": Object.freeze({
      allowedOrigins: Object.freeze(["https://beta.example.gov"]),
      canonicalUrl: "https://beta.example.gov/notices.atom",
      contractDigest: "b".repeat(64),
      contractVersion: "1.0.0",
    }),
  }),
});

async function expectGenerationError(mutator, code) {
  const root = await mkdtemp(resolve(tmpdir(), "eve-pack-invalid-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    await mutator(root);
    await assert.rejects(
      generateStrategyPackCatalog({
        outputPath: resolve(root, "catalog.generated.ts"),
        packRoot: root,
        references,
      }),
      (error) =>
        error instanceof StrategyPackGenerationError && error.code === code,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const temporaryRoot = await mkdtemp(resolve(tmpdir(), "eve-pack-catalog-"));
try {
  const firstOutput = resolve(temporaryRoot, "first.generated.ts");
  const secondOutput = resolve(temporaryRoot, "second.generated.ts");
  const first = await generateStrategyPackCatalog({
    outputPath: firstOutput,
    packRoot: fixtureRoot,
    references,
  });
  const second = await generateStrategyPackCatalog({
    outputPath: secondOutput,
    packRoot: fixtureRoot,
    references,
  });

  assert.deepEqual(first.entries.map((entry) => entry.id), ["alpha-pack", "beta-pack"]);
  assert.equal(first.entries[0]?.workspaceInstruction.includes("Alpha Pack"), true);
  assert.equal(first.entries[1]?.workspaceInstruction.includes("Beta Pack"), true);
  assert.notEqual(first.entries[0]?.contentDigest, first.entries[1]?.contentDigest);
  assert.equal(await readFile(firstOutput, "utf8"), await readFile(secondOutput, "utf8"));

  const catalog = createStrategyPackCatalog(first.entries, {
    blockedVersions: [{ id: "beta-pack", version: "1.0.0" }],
  });
  const listing = catalog.listModelSafe();
  assert.deepEqual(listing.map((entry) => entry.id), ["alpha-pack", "beta-pack"]);
  assert.equal(listing[0]?.availability, "available");
  assert.equal(listing[1]?.availability, "blocked");
  assert.equal(JSON.stringify(listing).includes("Alpha Pack workspace"), false);
  assert.equal(JSON.stringify(listing).includes("09:00"), false);
  assert.equal(Object.isFrozen(catalog.entries), true);
  assert.equal(Object.isFrozen(catalog.entries[0]?.monitors), true);
  assert.equal(
    catalog.resolve({ id: "alpha-pack", version: "1.0.0" })?.contentDigest,
    first.entries[0]?.contentDigest,
  );
  assert.equal(
    catalog.resolve({ id: "beta-pack", version: "1.0.0" })?.availability,
    "blocked",
  );
  assert.equal(
    catalog.resolve({
      contentDigest: "f".repeat(64),
      id: "alpha-pack",
      version: "1.0.0",
    }),
    null,
  );
  const versionOrdering = createStrategyPackCatalog([
    { ...first.entries[0], version: "1.10.0" },
    { ...first.entries[0], version: "1.2.0" },
  ]);
  assert.deepEqual(
    versionOrdering.entries.map((entry) => entry.version),
    ["1.2.0", "1.10.0"],
  );

  const driftRoot = resolve(temporaryRoot, "drift");
  await cp(fixtureRoot, driftRoot, { recursive: true });
  const driftOutput = resolve(temporaryRoot, "drift.generated.ts");
  await generateStrategyPackCatalog({
    outputPath: driftOutput,
    packRoot: driftRoot,
    references,
  });
  await writeFile(
    resolve(driftRoot, "alpha-pack", "1.0.0", "workspace.md"),
    "Changed immutable version bytes.\n",
    "utf8",
  );
  await assert.rejects(
    generateStrategyPackCatalog({
      outputPath: driftOutput,
      packRoot: driftRoot,
      references,
    }),
    (error) =>
      error instanceof StrategyPackGenerationError &&
      error.code === "pack_digest_drift",
  );

  const historicalRoot = resolve(temporaryRoot, "historical");
  await cp(fixtureRoot, historicalRoot, { recursive: true });
  const historicalOutput = resolve(temporaryRoot, "historical.generated.ts");
  await generateStrategyPackCatalog({
    outputPath: historicalOutput,
    packRoot: historicalRoot,
    references,
  });
  await rm(resolve(historicalRoot, "beta-pack"), { recursive: true });
  await assert.rejects(
    generateStrategyPackCatalog({
      outputPath: historicalOutput,
      packRoot: historicalRoot,
      references,
    }),
    (error) =>
      error instanceof StrategyPackGenerationError &&
      error.code === "pack_historical_version_missing",
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.monitors.push({ ...manifest.monitors[0] });
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_duplicate_resource_id");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.workspaceInstructionPath = "workspace/../../workspace.md";
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_path_escape");

await expectGenerationError(async (root) => {
  await writeFile(
    resolve(root, "alpha-pack", "1.0.0", "workspace.md"),
    "x".repeat(8_193),
    "utf8",
  );
}, "pack_file_oversized");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const instructionPath = "monitors/detect-alpha.md";
  await writeFile(
    resolve(root, "alpha-pack", "1.0.0", instructionPath),
    "x".repeat(8_000),
    "utf8",
  );
  manifest.monitors = Array.from({ length: 16 }, (_, index) => ({
    ...manifest.monitors[0],
    resourceId: `detect-alpha-${String(index).padStart(2, "0")}`,
  }));
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_aggregate_oversized");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.skills[0].instructionPath = "missing.md";
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_reference_missing");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.compatibility.workspaceSchemaVersion = 2;
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_incompatible");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.sources[0].sourceId = "source.unknown";
  manifest.monitors[0].sourceIds = ["source.unknown"];
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_reference_unknown");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.sources[0].canonicalUrl =
    "https://alpha.example.gov/events.json?access_token=secret";
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_manifest_invalid");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "evals.json");
  const evaluations = JSON.parse(await readFile(path, "utf8"));
  evaluations.cases = evaluations.cases.filter(
    (entry) => entry.kind !== "forbidden_capability",
  );
  await writeFile(path, JSON.stringify(evaluations, null, 2), "utf8");
}, "pack_manifest_invalid");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "pack.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.capabilities.required.push("shell");
  manifest.capabilities.hardDenied.push("tool.alpha.fetch");
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}, "pack_capability_conflict");

await expectGenerationError(async (root) => {
  const path = resolve(root, "alpha-pack", "1.0.0", "workspace.md");
  await rm(path);
  await symlink(resolve(root, "beta-pack", "1.0.0", "workspace.md"), path);
}, "pack_path_escape");

const defaults = resolveStrategyPackFlags({});
assert.deepEqual(defaults, {
  catalog: false,
  managedDispatch: false,
  mutations: false,
  runtimeComposition: false,
});
assert.equal(Object.isFrozen(defaults), true);
assert.deepEqual(
  resolveStrategyPackFlags({
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
    EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
    EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
    EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  }),
  {
    catalog: true,
    managedDispatch: true,
    mutations: true,
    runtimeComposition: true,
  },
);
assert.deepEqual(
  resolveStrategyPackFlags({
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "true",
    EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
    EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
    EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  }),
  defaults,
);
assert.deepEqual(
  resolveStrategyPackFlags({
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
    EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
    EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
    EVE_STRATEGY_PACK_RUNTIME_ENABLED: "0",
    EVE_WORKSPACE_DISPATCH_ENABLED: "1",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "0",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  }),
  {
    catalog: true,
    managedDispatch: false,
    mutations: false,
    runtimeComposition: false,
  },
);
assert.deepEqual(
  resolveStrategyPackBindingAvailability({
    hasBinding: true,
    flags: resolveStrategyPackFlags({
      EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
      EVE_WORKSPACE_STATE_ENABLED: "1",
    }),
  }),
  { reason: "strategy_pack_runtime_disabled", state: "unavailable" },
);
assert.deepEqual(
  resolveStrategyPackBindingAvailability({ hasBinding: false, flags: defaults }),
  { reason: null, state: "unbound" },
);

const productionCheck = await generateStrategyPackCatalog({
  checkOnly: true,
  outputPath: committedOutput,
  packRoot: productionRoot,
  references: STRATEGY_PACK_REFERENCE_CATALOG,
});
assert.equal(productionCheck.outputMatches, true);
assert.deepEqual(
  productionCheck.entries.map(({ id, version }) => `${id}@${version}`),
  [
    "congressional-signals@1.0.0",
    "congressional-signals@1.1.0",
    "congressional-signals@1.2.0",
    "congressional-signals@1.3.0",
    "congressional-signals@1.4.0",
    "congressional-signals@1.5.0",
    "congressional-signals@1.6.0",
    "earnings-call-changes@1.0.0",
    "earnings-call-changes@1.0.1",
    "earnings-call-changes@1.1.0",
    "earnings-call-changes@1.2.0",
    "inverse-cramer@1.0.0",
    "inverse-cramer@1.1.0",
    "inverse-cramer@1.2.0",
    "inverse-cramer@1.3.0",
    "inverse-cramer@1.4.0",
    "inverse-cramer@1.4.1",
    "inverse-cramer@1.4.2",
    "inverse-cramer@1.4.3",
    "inverse-cramer@1.4.4",
    "inverse-cramer@1.4.5",
    "inverse-cramer@1.4.6",
    "inverse-cramer@1.4.7",
    "inverse-cramer@1.4.8",
    "inverse-cramer@1.4.9",
    "inverse-cramer@1.5.0",
    "ipo-filings@1.0.0",
    "ipo-filings@1.1.0",
    "ipo-filings@1.1.1",
    "ipo-filings@1.1.2",
    "public-commentary-tracker@1.0.0",
    "public-commentary-tracker@1.1.0",
    "public-commentary-tracker@1.2.0",
    "public-commentary-tracker@1.3.0",
    "public-commentary-tracker@1.3.1",
    "public-commentary-tracker@1.4.0",
    "public-commentary-tracker@1.5.0",
    "public-commentary-tracker@1.5.1",
    "public-commentary-tracker@1.5.2",
  ],
);
const productionPack = productionCheck.entries.find(
  ({ id, version }) => id === "ipo-filings" && version === "1.0.0",
);
const agenticProductionPack = productionCheck.entries.find(
  ({ id, version }) => id === "ipo-filings" && version === "1.1.0",
);
assert.equal(productionPack?.maturity, "reference");
assert.equal(agenticProductionPack?.maturity, "experimental");
assert.equal(agenticProductionPack?.sources[0]?.sourceId, "sec-latest-s1-filings");
assert.equal(agenticProductionPack?.monitors[0]?.resourceId, "detect-new-s1");
assert.equal(agenticProductionPack?.evaluations.suiteId, "eval.sec-ipo/v1");
const { publicSource, ...legacySourceContract } =
  STRATEGY_PACK_REFERENCE_CATALOG.sourceContracts[SEC_IPO_SOURCE_ID];
assert.deepEqual(
  legacySourceContract,
  {
    allowedOrigins: SEC_IPO_SOURCE_ALLOWED_ORIGINS,
    canonicalUrl: SEC_IPO_SOURCE_URL,
    contractDigest: SEC_IPO_SOURCE_CONTRACT_DIGEST,
    contractVersion: SEC_IPO_SOURCE_CONTRACT_VERSION,
  },
);
assert.equal(publicSource.adapterDefinition.adapterId, "sec-latest-filings");
assert.equal(publicSource.sourceInstance.sourceInstanceId, "source.sec-latest-s1-filings");
assert.equal(
  STRATEGY_PACK_REFERENCE_CATALOG.capabilityIds.includes(
    EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  ),
  true,
);
assert.equal(
  STRATEGY_PACK_REFERENCE_CATALOG.capabilityIds.includes(
    CONGRESSIONAL_SIGNALS_EVALUATION_TOOL_ID,
  ),
  true,
);

const [environmentExample, packageJson] = await Promise.all([
  readFile(resolve(scriptDirectory, "..", ".env.example"), "utf8"),
  readFile(resolve(scriptDirectory, "..", "package.json"), "utf8").then(JSON.parse),
]);
for (const flag of [
  "EVE_STRATEGY_PACK_CATALOG_ENABLED",
  "EVE_STRATEGY_PACK_MUTATIONS_ENABLED",
  "EVE_STRATEGY_PACK_RUNTIME_ENABLED",
  "EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED",
]) {
  assert.match(environmentExample, new RegExp(`^${flag}=0$`, "mu"));
}
for (const hook of ["predev", "pretypecheck", "prebuild", "prebuild:agent"]) {
  assert.match(packageJson.scripts[hook], /prepare:strategy-packs/u);
}
assert.match(packageJson.scripts.prebuild, /verify:strategy-packs/u);

console.log("Strategy-pack catalog and feature-flag contract passed.");
