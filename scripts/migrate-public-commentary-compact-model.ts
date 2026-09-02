import assert from "node:assert/strict";

import { Redis } from "@upstash/redis";

import {
  createPublicCommentaryResearchDefinition,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
} from "../agent/lib/public-commentary-research";
import {
  createInverseCramerActionabilityDefinition,
  createPublicCommentaryImpactDefinition,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
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
const strategyId = argument("strategy") ?? "public-commentary-tracker";
assert.ok(
  strategyId === "public-commentary-tracker" || strategyId === "inverse-cramer",
  "--strategy must be public-commentary-tracker or inverse-cramer",
);
const inverseCramer = strategyId === "inverse-cramer";
const sourceVersion = inverseCramer
  ? (rollback ? "1.5.1" : "1.5.0")
  : (rollback ? "1.5.4" : "1.5.3");
const targetVersion = inverseCramer
  ? (rollback ? "1.5.0" : "1.5.1")
  : (rollback ? "1.5.3" : "1.5.4");
const sourcePack = strategyPackCatalog.resolve({
  id: strategyId,
  version: sourceVersion,
});
const targetPack = strategyPackCatalog.resolve({
  id: strategyId,
  version: targetVersion,
});
assert.ok(sourcePack && targetPack);
const qualifiedPack = rollback ? sourcePack : targetPack;
if (!inverseCramer) {
  assert.equal(
    qualifiedPack.evidenceContracts?.find(({ id }) => id === PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID)?.digest,
    createPublicCommentaryResearchDefinition(["openai/gpt-5.4-mini"], "1.0.1").definitionDigest,
  );
}
const compactDefinitionId = inverseCramer
  ? INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID
  : PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID;
const qualifiedCompactDefinition = inverseCramer
  ? createInverseCramerActionabilityDefinition(
      ["google/gemini-3.7-flash"],
      {},
      "1.0.1",
    )
  : createPublicCommentaryImpactDefinition(
      ["google/gemini-3.7-flash"],
      { allowedAdapterIds: QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS },
      "1.0.3",
    );
assert.equal(
  qualifiedPack.evidenceContracts?.find(({ id }) => id === compactDefinitionId)?.digest,
  qualifiedCompactDefinition.definitionDigest,
);
const withoutCompact = (pack: typeof sourcePack) => pack.evidenceContracts
  ?.filter(({ id }) => id !== compactDefinitionId);
assert.deepEqual(withoutCompact(targetPack), withoutCompact(sourcePack));
assert.deepEqual(targetPack.sources, sourcePack.sources);
const withoutInstruction = ({ instruction: _instruction, ...definition }: (typeof sourcePack.monitors)[number]) =>
  definition;
assert.deepEqual(
  targetPack.monitors.map(withoutInstruction),
  sourcePack.monitors.map(withoutInstruction),
);

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
const targetMonitor = targetPack.monitors.find(
  ({ resourceId }) => resourceId === monitor.managedBy?.resourceId,
);
assert.ok(targetMonitor, "target strategy pack must contain the managed monitor");
assert.ok(targetMonitor.instruction.trim().length > 0);
assert.ok(
  monitor.lifecycleState === "enabled" ||
  monitor.lifecycleState === "paused" ||
  monitor.lifecycleState === "paused_failure",
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
  workerModelPolicy: rollback
    ? {
        ...capabilities.value.workerModelPolicy,
        allowedModelIds: inverseCramer
          ? ["openai/gpt-5.4"]
          : ["openai/gpt-5.4", "openai/gpt-5.4-mini"],
      }
    : resolveStrategyPackWorkerModelPolicy({
        environment: process.env,
        fallback: capabilities.value.workerModelPolicy,
        pack: targetPack,
      }),
};
if (rollback) {
  assert.ok(nextCapabilities.workerModelPolicy.allowedModelIds.includes("openai/gpt-5.4"));
  assert.equal(
    nextCapabilities.workerModelPolicy.allowedModelIds.includes("openai/gpt-5.4-mini"),
    !inverseCramer,
  );
  assert.ok(!nextCapabilities.workerModelPolicy.allowedModelIds.includes("google/gemini-3.7-flash"));
} else {
  assert.deepEqual(
    nextCapabilities.workerModelPolicy.allowedModelIds,
    inverseCramer
      ? ["google/gemini-3.7-flash"]
      : ["google/gemini-3.7-flash", "openai/gpt-5.4-mini"],
  );
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
  instruction: targetMonitor.instruction,
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
  console.info(`${strategyId} compact-model migration committed`);
}
