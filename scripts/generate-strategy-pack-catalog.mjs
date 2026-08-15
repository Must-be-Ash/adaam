import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EMPTY_STRATEGY_PACK_REFERENCE_CATALOG,
  STRATEGY_PACK_CATALOG_ENTRY_LIMIT,
  STRATEGY_PACK_CORE_SCHEMA_VERSION,
  STRATEGY_PACK_FILE_LIMITS,
  STRATEGY_PACK_SCHEMA_VERSION,
  STRATEGY_PACK_WORKSPACE_SCHEMA_VERSION,
  compareStrategyPackVersions,
  compareStrategyPackText,
  strategyPackEvaluationsSchema,
  strategyPackManifestSchema,
} from "../agent/lib/strategy-pack-schema.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPackRoot = resolve(projectRoot, "strategy-packs");
const defaultOutputPath = resolve(
  projectRoot,
  "agent",
  "lib",
  "strategy-pack-catalog.generated.ts",
);
const DIGEST_HEADER_PREFIX = "// Strategy pack digests: ";
const FORBIDDEN_CAPABILITY =
  /(?:broker|coinbase|credential|filesystem|leverage|margin|shell|transfer|withdrawal)/iu;

export class StrategyPackGenerationError extends Error {
  constructor(code, packPath = null) {
    super(code);
    this.code = code;
    this.name = "StrategyPackGenerationError";
    this.packPath = packPath;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function normalizedText(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function sameStrings(left, right) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

async function boundedRead(path, maximumBytes, code) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new StrategyPackGenerationError("pack_reference_missing", path);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new StrategyPackGenerationError(
      stat.isSymbolicLink() ? "pack_path_escape" : "pack_reference_missing",
      path,
    );
  }
  if (stat.size > maximumBytes) {
    throw new StrategyPackGenerationError(code, path);
  }
  const value = await readFile(path, "utf8");
  if (value.includes("\0")) {
    throw new StrategyPackGenerationError("pack_manifest_invalid", path);
  }
  return normalizedText(value);
}

function confinedPath(versionDirectory, referencePath) {
  if (
    isAbsolute(referencePath) ||
    referencePath.includes("\\") ||
    referencePath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new StrategyPackGenerationError("pack_path_escape", referencePath);
  }
  const path = resolve(versionDirectory, referencePath);
  const local = relative(versionDirectory, path);
  if (local === "" || local.startsWith(`..${sep}`) || local === "..") {
    throw new StrategyPackGenerationError("pack_path_escape", referencePath);
  }
  return path;
}

async function readConfinedText(versionDirectory, referencePath, limit) {
  const path = confinedPath(versionDirectory, referencePath);
  let resolvedPath;
  try {
    resolvedPath = await realpath(path);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new StrategyPackGenerationError("pack_reference_missing", referencePath);
    }
    throw error;
  }
  const resolvedDirectory = await realpath(versionDirectory);
  const local = relative(resolvedDirectory, resolvedPath);
  if (local === "" || local.startsWith(`..${sep}`) || local === "..") {
    throw new StrategyPackGenerationError("pack_path_escape", referencePath);
  }
  return boundedRead(path, limit, "pack_file_oversized");
}

function parseJson(value, schema, path) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StrategyPackGenerationError("pack_manifest_invalid", path);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new StrategyPackGenerationError("pack_manifest_invalid", path);
  }
  return result.data;
}

function validateCompatibility(manifest, path) {
  if (
    manifest.compatibility.coreSchemaVersion !== STRATEGY_PACK_CORE_SCHEMA_VERSION ||
    manifest.compatibility.workspaceSchemaVersion !==
      STRATEGY_PACK_WORKSPACE_SCHEMA_VERSION ||
    manifest.compatibility.strategyPackSchemaVersion !== STRATEGY_PACK_SCHEMA_VERSION
  ) {
    throw new StrategyPackGenerationError("pack_incompatible", path);
  }
}

function validateUniqueAndCapabilities(manifest, path) {
  for (const values of [
    manifest.capabilities.hardDenied,
    manifest.capabilities.required,
    manifest.configuration.map((field) => field.key),
    manifest.skills.map((skill) => skill.id),
    manifest.sources.map((source) => source.sourceId),
  ]) {
    if (new Set(values).size !== values.length) {
      throw new StrategyPackGenerationError("pack_duplicate_id", path);
    }
  }
  const resources = manifest.monitors.map((monitor) => monitor.resourceId);
  if (new Set(resources).size !== resources.length) {
    throw new StrategyPackGenerationError("pack_duplicate_resource_id", path);
  }
  const required = new Set(manifest.capabilities.required);
  const denied = new Set(manifest.capabilities.hardDenied);
  if (
    manifest.capabilities.required.some(
      (id) => denied.has(id) || FORBIDDEN_CAPABILITY.test(id),
    )
  ) {
    throw new StrategyPackGenerationError("pack_capability_conflict", path);
  }
  const configuration = new Map(
    manifest.configuration.map((field) => [field.key, field.kind]),
  );
  const sources = new Set(manifest.sources.map((source) => source.sourceId));
  for (const monitor of manifest.monitors) {
    if (
      configuration.get(monitor.timezoneConfigurationKey) !== "iana_timezone" ||
      configuration.get(monitor.dailyTimesConfigurationKey) !== "daily_local_times" ||
      monitor.sourceIds.some((id) => !sources.has(id)) ||
      monitor.requiredCapabilityIds.some((id) => !required.has(id))
    ) {
      throw new StrategyPackGenerationError("pack_reference_unknown", path);
    }
  }
  for (const skill of manifest.skills) {
    if (!required.has(`skill.${skill.id}`)) {
      throw new StrategyPackGenerationError("pack_reference_unknown", path);
    }
  }
}

function validateApplicationReferences(manifest, evaluations, references, path) {
  const capabilities = new Set(references.capabilityIds);
  const findingSchemas = new Set(references.findingSchemaIds);
  const alertPresentations = new Set(references.alertPresentationIds);
  const evalFixtureIds = references.evalSuites[evaluations.suiteId];
  if (
    manifest.capabilities.required.some((id) => !capabilities.has(id)) ||
    !evalFixtureIds ||
    evaluations.cases.some((entry) => !evalFixtureIds.includes(entry.fixtureId))
  ) {
    throw new StrategyPackGenerationError("pack_reference_unknown", path);
  }
  for (const source of manifest.sources) {
    const reviewed = references.sourceContracts[source.sourceId];
    if (
      !reviewed ||
      reviewed.contractVersion !== source.contractVersion ||
      reviewed.contractDigest !== source.contractDigest ||
      reviewed.canonicalUrl !== source.canonicalUrl ||
      !sameStrings(reviewed.allowedOrigins, source.allowedOrigins)
    ) {
      throw new StrategyPackGenerationError("pack_reference_unknown", path);
    }
  }
  for (const monitor of manifest.monitors) {
    if (
      !findingSchemas.has(monitor.findingSchemaId) ||
      !alertPresentations.has(monitor.alertPresentationId)
    ) {
      throw new StrategyPackGenerationError("pack_reference_unknown", path);
    }
  }
}

function contentDigest(files) {
  const hash = createHash("sha256");
  for (const [path, contents] of [...files].sort(([left], [right]) =>
    compareStrategyPackText(left, right))) {
    const pathBytes = Buffer.from(path, "utf8");
    const contentBytes = Buffer.from(contents, "utf8");
    hash.update(String(pathBytes.byteLength));
    hash.update(":");
    hash.update(pathBytes);
    hash.update(":");
    hash.update(String(contentBytes.byteLength));
    hash.update(":");
    hash.update(contentBytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function compileVersion(versionDirectory, directoryId, directoryVersion, references) {
  const manifestPath = resolve(versionDirectory, "pack.json");
  const manifestText = await boundedRead(
    manifestPath,
    STRATEGY_PACK_FILE_LIMITS.manifest,
    "pack_file_oversized",
  );
  const manifest = parseJson(manifestText, strategyPackManifestSchema, manifestPath);
  if (manifest.id !== directoryId || manifest.version !== directoryVersion) {
    throw new StrategyPackGenerationError("pack_manifest_invalid", manifestPath);
  }
  validateCompatibility(manifest, manifestPath);
  validateUniqueAndCapabilities(manifest, manifestPath);

  const workspaceInstruction = await readConfinedText(
    versionDirectory,
    manifest.workspaceInstructionPath,
    STRATEGY_PACK_FILE_LIMITS.workspaceInstruction,
  );
  const skills = [];
  for (const skill of manifest.skills) {
    skills.push({
      ...skill,
      instruction: await readConfinedText(
        versionDirectory,
        skill.instructionPath,
        STRATEGY_PACK_FILE_LIMITS.playbookInstruction,
      ),
    });
  }
  const monitors = [];
  for (const monitor of manifest.monitors) {
    monitors.push({
      ...monitor,
      instruction: await readConfinedText(
        versionDirectory,
        monitor.instructionPath,
        STRATEGY_PACK_FILE_LIMITS.monitorInstruction,
      ),
    });
  }
  const evaluationsText = await readConfinedText(
    versionDirectory,
    manifest.evaluationsPath,
    STRATEGY_PACK_FILE_LIMITS.evaluations,
  );
  const evaluations = parseJson(
    evaluationsText,
    strategyPackEvaluationsSchema,
    manifest.evaluationsPath,
  );
  validateApplicationReferences(manifest, evaluations, references, manifestPath);

  const files = [
    ["pack.json", canonicalJson(manifest)],
    [manifest.workspaceInstructionPath, workspaceInstruction],
    [manifest.evaluationsPath, canonicalJson(evaluations)],
    ...skills.map((skill) => [skill.instructionPath, skill.instruction]),
    ...monitors.map((monitor) => [monitor.instructionPath, monitor.instruction]),
  ];
  const aggregateBytes = files.reduce(
    (total, [path, contents]) =>
      total + Buffer.byteLength(path, "utf8") + Buffer.byteLength(contents, "utf8"),
    0,
  );
  if (aggregateBytes > STRATEGY_PACK_FILE_LIMITS.aggregate) {
    throw new StrategyPackGenerationError("pack_aggregate_oversized", manifestPath);
  }
  return {
    ...manifest,
    contentDigest: contentDigest(files),
    evaluations,
    monitors,
    skills,
    workspaceInstruction,
  };
}

async function directories(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new StrategyPackGenerationError("pack_path_escape", resolve(path, entry.name));
    }
    if (entry.isDirectory()) result.push(entry.name);
  }
  return result.sort();
}

function generatedSource(entries) {
  const digests = Object.fromEntries(
    entries.map((entry) => [`${entry.id}@${entry.version}`, entry.contentDigest]),
  );
  return `// Generated by scripts/generate-strategy-pack-catalog.mjs. Do not edit.\n${DIGEST_HEADER_PREFIX}${JSON.stringify(digests)}\nimport type { StrategyPackDefinition } from "./strategy-pack-schema";\n\nexport const STRATEGY_PACK_CATALOG_GENERATED: readonly StrategyPackDefinition[] = ${JSON.stringify(entries, null, 2)};\n`;
}

async function existingDigests(outputPath) {
  try {
    const source = await readFile(outputPath, "utf8");
    const line = source.split("\n").find((candidate) => candidate.startsWith(DIGEST_HEADER_PREFIX));
    if (!line) {
      throw new StrategyPackGenerationError(
        "pack_generated_catalog_invalid",
        outputPath,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(line.slice(DIGEST_HEADER_PREFIX.length));
    } catch {
      throw new StrategyPackGenerationError(
        "pack_generated_catalog_invalid",
        outputPath,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.entries(parsed).some(
        ([key, value]) =>
          !/^[a-z][a-z0-9-]*@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(key) ||
          typeof value !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value),
      )
    ) {
      throw new StrategyPackGenerationError(
        "pack_generated_catalog_invalid",
        outputPath,
      );
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function generateStrategyPackCatalog({
  checkOnly = false,
  outputPath = defaultOutputPath,
  packRoot = defaultPackRoot,
  references = EMPTY_STRATEGY_PACK_REFERENCE_CATALOG,
} = {}) {
  const entries = [];
  const seen = new Set();
  for (const directoryId of await directories(packRoot)) {
    const packDirectory = resolve(packRoot, directoryId);
    for (const directoryVersion of await directories(packDirectory)) {
      const entry = await compileVersion(
        resolve(packDirectory, directoryVersion),
        directoryId,
        directoryVersion,
        references,
      );
      const key = `${entry.id}@${entry.version}`;
      if (seen.has(key)) {
        throw new StrategyPackGenerationError("pack_duplicate_id", key);
      }
      seen.add(key);
      entries.push(entry);
      if (entries.length > STRATEGY_PACK_CATALOG_ENTRY_LIMIT) {
        throw new StrategyPackGenerationError("pack_catalog_oversized", packRoot);
      }
    }
  }
  entries.sort(
    (left, right) =>
      compareStrategyPackText(left.id, right.id) ||
      compareStrategyPackVersions(left.version, right.version),
  );

  const previous = await existingDigests(outputPath);
  const current = Object.fromEntries(
    entries.map((entry) => [`${entry.id}@${entry.version}`, entry.contentDigest]),
  );
  for (const [key, digest] of Object.entries(previous)) {
    if (!(key in current)) {
      throw new StrategyPackGenerationError("pack_historical_version_missing", key);
    }
    if (current[key] !== digest) {
      throw new StrategyPackGenerationError("pack_digest_drift", key);
    }
  }

  const source = generatedSource(entries);
  let outputMatches = false;
  try {
    outputMatches = (await readFile(outputPath, "utf8")) === source;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  if (!checkOnly && !outputMatches) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source, "utf8");
    outputMatches = true;
  }
  return Object.freeze({ entries: Object.freeze(entries), outputMatches, source });
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--check") options.checkOnly = true;
    else if (argument === "--root") options.packRoot = resolve(argumentsList[++index]);
    else if (argument === "--output") options.outputPath = resolve(argumentsList[++index]);
    else throw new StrategyPackGenerationError("pack_generator_argument_invalid", argument);
  }
  return options;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await generateStrategyPackCatalog(parseArguments(process.argv.slice(2)));
    if (result.outputMatches) {
      console.log(`Generated ${result.entries.length} strategy-pack catalog entries.`);
    } else {
      console.error("strategy_pack_catalog_out_of_date");
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof StrategyPackGenerationError) {
      console.error(`${error.code}${error.packPath ? `: ${error.packPath}` : ""}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
