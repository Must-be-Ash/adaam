import assert from "node:assert/strict";

import { Redis } from "@upstash/redis";

import {
  createPublicCommentaryResearchDefinition,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
} from "../agent/lib/public-commentary-research";
import {
  createPublicCommentaryImpactDefinition,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
  QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS,
} from "../agent/lib/public-commentary-semantics";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveStrategyPackWorkerModelPolicy } from "../agent/lib/strategy-pack-service";
import {
  listWorkspaceMonitors,
  prepareWorkspaceManagedMonitorUpdate,
  validateWorkspaceMonitorValue,
  workspaceMonitorInflightStorageKey,
  workspaceMonitorLeaseStorageKey,
} from "../agent/lib/workspace-monitor-store";
import {
  prepareWorkspaceDocumentUpdate,
  prepareWorkspaceStrategyBindingUpdate,
  readWorkspaceDocument,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const workspaceId = argument("workspace");
assert.ok(workspaceId, "--workspace=<uuid> is required");
const apply = process.argv.includes("--apply");
const ownerId = process.env.EVE_DEPLOYMENT_OWNER_ID;
assert.ok(ownerId, "EVE_DEPLOYMENT_OWNER_ID is required");

const rollback = process.argv.includes("--rollback");
const sourcePack = strategyPackCatalog.resolve({
  id: "public-commentary-tracker",
  version: rollback ? "1.5.4" : "1.5.3",
});
const targetPack = strategyPackCatalog.resolve({
  id: "public-commentary-tracker",
  version: rollback ? "1.5.3" : "1.5.4",
});
assert.ok(sourcePack && targetPack);
const qualifiedPack = rollback ? sourcePack : targetPack;
assert.equal(
  qualifiedPack.evidenceContracts?.find(({ id }) => id === PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID)?.digest,
  createPublicCommentaryResearchDefinition(["openai/gpt-5.4-mini"], "1.0.1").definitionDigest,
);
assert.equal(
  qualifiedPack.evidenceContracts?.find(({ id }) => id === PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID)?.digest,
  createPublicCommentaryImpactDefinition(
    ["google/gemini-3.7-flash"],
    { allowedAdapterIds: QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS },
    "1.0.3",
  ).definitionDigest,
);
const withoutCompact = (pack: typeof sourcePack) => pack.evidenceContracts
  ?.filter(({ id }) => id !== PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID);
assert.deepEqual(withoutCompact(targetPack), withoutCompact(sourcePack));
assert.deepEqual(targetPack.sources, sourcePack.sources);
assert.deepEqual(targetPack.monitors, sourcePack.monitors);

const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, process.env);
const [strategy, capabilities, monitors] = await Promise.all([
  readWorkspaceDocument("strategy", scope),
  readWorkspaceDocument("capabilities", scope),
  listWorkspaceMonitors(scope),
]);
assert.ok(strategy?.schemaVersion === 2 && capabilities);
assert.equal(strategy.value.lifecycleState, "active");
assert.deepEqual(strategy.value.pack, {
  contentDigest: sourcePack.contentDigest,
  id: sourcePack.id,
  version: sourcePack.version,
});
assert.equal(monitors.length, 1);
const monitor = monitors[0]!;
assert.equal(monitor.managedBy?.packId, sourcePack.id);
assert.equal(monitor.managedBy?.packVersion, sourcePack.version);
assert.equal(monitor.managedBy?.packContentDigest, sourcePack.contentDigest);
assert.ok(
  monitor.lifecycleState === "enabled" ||
  monitor.lifecycleState === "paused" ||
  (rollback && monitor.lifecycleState === "paused_failure"),
);

const nextBindingRevision = strategy.value.bindingRevision + 1;
const targetPackReference = Object.freeze({
  contentDigest: targetPack.contentDigest,
  id: targetPack.id,
  version: targetPack.version,
});
const updateSnapshot = (snapshot: typeof strategy.value.lastActiveSnapshot) => snapshot
  ? {
      ...snapshot,
      bindingRevision: nextBindingRevision,
      capabilityManifestRevision: capabilities.revision + 1,
      packContentDigest: targetPack.contentDigest,
      packId: targetPack.id,
      packVersion: targetPack.version,
    }
  : null;
const nextCapabilities = {
  ...capabilities.value,
  workerModelPolicy: resolveStrategyPackWorkerModelPolicy({
    environment: process.env,
    fallback: capabilities.value.workerModelPolicy,
    pack: targetPack,
  }),
};
if (rollback) {
  assert.ok(nextCapabilities.workerModelPolicy.allowedModelIds.includes("openai/gpt-5.4"));
  assert.ok(nextCapabilities.workerModelPolicy.allowedModelIds.includes("openai/gpt-5.4-mini"));
  assert.ok(!nextCapabilities.workerModelPolicy.allowedModelIds.includes("google/gemini-3.7-flash"));
} else {
  assert.deepEqual(nextCapabilities.workerModelPolicy.allowedModelIds, [
    "google/gemini-3.7-flash",
    "openai/gpt-5.4-mini",
  ]);
}
const now = new Date();
const nextStrategy = {
  ...strategy.value,
  bindingRevision: nextBindingRevision,
  effectiveCapabilityManifestRevision: capabilities.revision + 1,
  lastActiveSnapshot: updateSnapshot(strategy.value.lastActiveSnapshot),
  pack: targetPackReference,
  pendingSnapshot: updateSnapshot(strategy.value.pendingSnapshot),
  timestamps: { ...strategy.value.timestamps, configuredAt: now.toISOString() },
};
assert.ok(nextStrategy.lastActiveSnapshot || nextStrategy.pendingSnapshot);
const preparedCapabilities = prepareWorkspaceDocumentUpdate("capabilities", {
  current: capabilities,
  now,
  scope,
  value: nextCapabilities,
});
const preparedStrategy = prepareWorkspaceStrategyBindingUpdate({
  current: strategy,
  now,
  scope,
  value: nextStrategy,
});
const monitorKeys = prepareWorkspaceManagedMonitorUpdate({
  current: monitor,
  lifecycleState: "paused",
  managedBy: monitor.managedBy,
  now,
  pauseReason: "strategy_pack_configuration",
  scope,
});
const nextMonitor = validateWorkspaceMonitorValue({
  ...monitor,
  configurationRevision: monitor.configurationRevision + 1,
  managedBy: {
    ...monitor.managedBy!,
    bindingRevision: nextBindingRevision,
    packContentDigest: targetPack.contentDigest,
    packId: targetPack.id,
    packVersion: targetPack.version,
  },
  updatedAt: now.toISOString(),
}, scope);
const nextMonitorRaw = JSON.stringify(nextMonitor);

console.info(JSON.stringify({
  apply,
  direction: rollback ? "rollback" : "forward",
  checkpointPreserved: monitor.sourceCheckpoint,
  from: `${sourcePack.id}@${sourcePack.version}`,
  lifecycleState: monitor.lifecycleState,
  modelPolicy: nextCapabilities.workerModelPolicy,
  monitorId: monitor.monitorId,
  nextOccurrenceAt: monitor.nextOccurrenceAt,
  to: `${targetPack.id}@${targetPack.version}`,
  workspaceGeneration: (nextStrategy.pendingSnapshot ?? nextStrategy.lastActiveSnapshot)?.workspaceGeneration,
  workspaceId,
}, null, 2));

if (apply) {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.ok(url && token, "workspace storage is not configured");
  const redis = new Redis({ automaticDeserialization: false, token, url });
  const keys = [
    preparedCapabilities.key,
    preparedStrategy.key,
    monitorKeys.recordKey,
    monitorKeys.dueKey,
    workspaceMonitorLeaseStorageKey(scope, monitor.monitorId),
    workspaceMonitorInflightStorageKey,
  ];
  const currentRaws = [
    JSON.stringify(capabilities),
    JSON.stringify(strategy),
    JSON.stringify(monitor),
  ];
  const nextRaws = [preparedCapabilities.raw, preparedStrategy.raw, nextMonitorRaw];
  const dueAtMs = nextMonitor.lifecycleState === "enabled" && nextMonitor.nextOccurrenceAt
    ? Date.parse(nextMonitor.nextOccurrenceAt)
    : null;
  assert.ok(dueAtMs === null || Number.isFinite(dueAtMs));
  const result = await redis.eval<string[], string>(`
local current = {}
if redis.call("EXISTS", KEYS[5]) == 1 or redis.call("ZSCORE", KEYS[6], KEYS[3]) then
  return "busy"
end
local replayed = true
local expected = true
for index = 1, 3 do
  current[index] = redis.call("GET", KEYS[index])
  if current[index] ~= ARGV[index + 3] then replayed = false end
  if current[index] ~= ARGV[index] then expected = false end
end
if replayed then return "replayed" end
if not expected then return "conflict" end
for index = 1, 3 do redis.call("SET", KEYS[index], ARGV[index + 3]) end
if ARGV[7] == "" then
  redis.call("ZREM", KEYS[4], KEYS[3])
else
  redis.call("ZADD", KEYS[4], ARGV[7], KEYS[3])
end
return "committed"
`, keys, [
    ...currentRaws,
    ...nextRaws,
    dueAtMs === null ? "" : String(dueAtMs),
  ]);
  assert.ok(result === "committed" || result === "replayed", `migration ${result}`);
  console.info("public commentary compact-model migration committed");
}
