import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { photonApprovalGuardKey } from "../agent/lib/photon-approval-store.ts";
import { getPhotonWorkspaceState } from "../agent/lib/photon-workspace-store.ts";
import { createStrategyPackCatalog } from "../agent/lib/strategy-pack-catalog.ts";
import { STRATEGY_PACK_REFERENCE_CATALOG } from "../agent/lib/strategy-pack-reference-catalog.ts";
import {
  configureStrategyPackWorkspaceFromSelection,
  createStrategyPackWorkspace,
  deriveEveStrategyPackMutationIdentity,
  removeStrategyPackWorkspaceFromSelection,
  StrategyPackServiceError,
} from "../agent/lib/strategy-pack-service.ts";
import {
  classifyStrategyPackTransactionStorageError,
  STRATEGY_PACK_TRANSACTION_REDIS_SCRIPTS,
  StrategyPackTransactionStorageError,
} from "../agent/lib/strategy-pack-transaction.ts";
import { listWorkspaceMonitors } from "../agent/lib/workspace-monitor-store.ts";
import { readWorkspaceDocument } from "../agent/lib/workspace-state-store.ts";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization.ts";
import { generateStrategyPackCatalog } from "./generate-strategy-pack-catalog.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(scriptDirectory, "fixtures", "strategy-packs", "valid");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "eve-pack-redis-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);

const redactedStorageError = classifyStrategyPackTransactionStorageError(new Error(
  'ERR Error running script (call to f_abc): @user_script:42: WRONGTYPE Operation against a key, command was: ["EVAL","owner-secret"]',
));
assert.ok(redactedStorageError instanceof StrategyPackTransactionStorageError);
assert.equal(redactedStorageError.providerReasonCode, "wrong_type");
assert.equal(redactedStorageError.scriptLine, 42);
assert.equal(redactedStorageError.message, "Strategy pack transaction storage failed.");
assert.doesNotMatch(redactedStorageError.message, /owner-secret|command was/iu);

function redis(...args) {
  return new Promise((resolvePromise, reject) => {
    const process = spawn("redis-cli", ["--raw", "-p", String(port), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.replace(/\n$/u, ""));
      else reject(new Error(stderr || `redis-cli exited ${code}`));
    });
  });
}

async function waitForRedis() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (await redis("PING") === "PONG") return;
    } catch {
      // Redis is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Local Redis did not start.");
}

class RedisCliStore {
  async compareAndSet(key, expected, next) {
    const script = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2])
return 1`;
    return await redis("EVAL", script, "1", key, expected ?? "", next) === "1";
  }

  async get(key) {
    const value = await redis("GET", key);
    return value === "" ? null : value;
  }

  async set(key, value, options) {
    const args = ["SET", key, value];
    if (options?.nx) args.push("NX");
    return redis(...args);
  }

  async list(indexKey) {
    const members = (await redis("SMEMBERS", indexKey)).split("\n").filter(Boolean);
    return Promise.all(members.map((member) => this.get(member)));
  }

  async readReplay(input) {
    const result = await redis(
      "EVAL",
      STRATEGY_PACK_TRANSACTION_REDIS_SCRIPTS.readReplay,
      "3",
      input.approvalGuardKey,
      input.mappingKey,
      input.receiptKey,
      input.mappingRaw,
    );
    if (result.startsWith("replayed:")) {
      return { receiptRaw: result.slice("replayed:".length), status: "replayed" };
    }
    return { status: result };
  }

  async commitCreate(input) {
    const keys = [
      input.approvalGuardKey,
      input.mappingKey,
      input.receiptKey,
      input.registryKey,
      ...input.records.map((record) => record.key),
      ...input.monitors.flatMap((monitor) => [monitor.recordKey, monitor.workspaceIndexKey, monitor.dueKey]),
    ];
    const args = [
      input.mappingRaw,
      input.receiptRaw,
      input.expectedRegistryRaw,
      String(input.expectedRegistryRevision),
      input.nextRegistryRaw ?? "",
      String(input.records.length),
      String(input.monitors.length),
      ...input.records.map((record) => record.raw),
      ...input.monitors.flatMap((monitor) => [monitor.raw, monitor.dueAtMs === null ? "" : String(monitor.dueAtMs)]),
    ];
    const result = await redis(
      "EVAL",
      STRATEGY_PACK_TRANSACTION_REDIS_SCRIPTS.commitCreate,
      String(keys.length),
      ...keys,
      ...args,
    );
    if (result.startsWith("committed:")) {
      return { receiptRaw: result.slice("committed:".length), status: "committed" };
    }
    if (result.startsWith("replayed:")) {
      return { receiptRaw: result.slice("replayed:".length), status: "replayed" };
    }
    return { status: result };
  }

  async commitLifecycle(input) {
    const keys = [
      input.approvalGuardKey,
      input.mappingKey,
      input.receiptKey,
      input.registryKey,
      ...input.records.map((record) => record.key),
      ...input.monitors.flatMap((monitor) => [monitor.recordKey, monitor.dueKey]),
    ];
    const args = [
      input.mappingRaw,
      input.receiptRaw,
      input.expectedRegistryRaw,
      String(input.expectedRegistryRevision),
      input.nextRegistryRaw,
      String(input.records.length),
      String(input.monitors.length),
      ...input.records.flatMap((record) => [record.expectedRaw, record.nextRaw]),
      ...input.monitors.flatMap((monitor) => [
        monitor.expectedRaw,
        monitor.nextRaw,
        monitor.dueAtMs === null ? "" : String(monitor.dueAtMs),
      ]),
    ];
    const result = await redis(
      "EVAL",
      STRATEGY_PACK_TRANSACTION_REDIS_SCRIPTS.commitLifecycle,
      String(keys.length),
      ...keys,
      ...args,
    );
    if (result.startsWith("committed:")) {
      return { receiptRaw: result.slice("committed:".length), status: "committed" };
    }
    if (result.startsWith("replayed:")) {
      return { receiptRaw: result.slice("replayed:".length), status: "replayed" };
    }
    return { status: result };
  }
}

const server = spawn("redis-server", [
  "--port", String(port),
  "--bind", "127.0.0.1",
  "--dir", temporaryRoot,
  "--save", "",
  "--appendonly", "no",
], { stdio: "ignore" });

try {
  await waitForRedis();
  const generated = await generateStrategyPackCatalog({
    outputPath: resolve(temporaryRoot, "catalog.generated.ts"),
    packRoot: fixtureRoot,
    references: {
      alertPresentationIds: ["alert.beta/v1", "alert.public-event/v1"],
      capabilityIds: ["skill.alpha-playbook", "skill.beta-playbook", "tool.alpha.fetch", "tool.beta.fetch"],
      evalSuites: {
        "eval.alpha/v1": ["fixture.alpha.forbidden", "fixture.alpha.malformed", "fixture.alpha.no-match", "fixture.alpha.positive", "fixture.alpha.replay"],
        "eval.beta/v1": ["fixture.beta.forbidden", "fixture.beta.malformed", "fixture.beta.no-match", "fixture.beta.positive", "fixture.beta.replay"],
      },
      findingSchemaIds: ["finding.alpha/v1", "finding.beta/v1"],
      parameterizedSourceContracts: STRATEGY_PACK_REFERENCE_CATALOG.parameterizedSourceContracts,
      sourceContracts: {
        "source.alpha": { allowedOrigins: ["https://alpha.example.gov"], canonicalUrl: "https://alpha.example.gov/events.json", contractDigest: "a".repeat(64), contractVersion: "1.0.0" },
        "source.beta": { allowedOrigins: ["https://beta.example.gov"], canonicalUrl: "https://beta.example.gov/notices.atom", contractDigest: "b".repeat(64), contractVersion: "1.0.0" },
      },
    },
  });
  const catalog = createStrategyPackCatalog(generated.entries);
  const alpha = catalog.resolve({ id: "alpha-pack", version: "1.0.0" });
  assert.ok(alpha);
  const client = new RedisCliStore();
  const atomicPrefix = "verification:atomic-failure";
  const atomicRegistryRaw = JSON.stringify({ revision: 0 });
  await redis("SET", `${atomicPrefix}:registry`, atomicRegistryRaw);
  await redis("SET", `${atomicPrefix}:index`, "wrong-type");
  const atomicFailure = await client.commitCreate({
    approvalGuardKey: `${atomicPrefix}:guard`,
    expectedRegistryRaw: atomicRegistryRaw,
    expectedRegistryRevision: 0,
    mappingKey: `${atomicPrefix}:mapping`,
    mappingRaw: "mapping",
    monitors: [{
      dueAtMs: Date.now(),
      dueKey: `${atomicPrefix}:due`,
      raw: "monitor",
      recordKey: `${atomicPrefix}:monitor`,
      workspaceIndexKey: `${atomicPrefix}:index`,
    }],
    nextRegistryRaw: JSON.stringify({ revision: 1 }),
    receiptKey: `${atomicPrefix}:receipt`,
    receiptRaw: "receipt",
    records: [{ key: `${atomicPrefix}:document`, raw: "document" }],
    registryKey: `${atomicPrefix}:registry`,
  });
  assert.equal(atomicFailure.status, "conflict");
  assert.equal(await redis("GET", `${atomicPrefix}:registry`), atomicRegistryRaw);
  for (const suffix of ["document", "mapping", "monitor", "receipt"]) {
    assert.equal(await redis("EXISTS", `${atomicPrefix}:${suffix}`), "0");
  }
  const environment = {
    EVE_DEPLOYMENT_OWNER_ID: "owner_fixture",
    EVE_OWNER_ALIAS_HMAC_SECRET: "A".repeat(43),
    EVE_PHOTON_OWNER_PRINCIPALS: "imessage:redis-owner",
    EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
    EVE_STRATEGY_PACK_MUTATIONS_ENABLED: "1",
    EVE_WORKSPACE_MONITOR_WRITES_ENABLED: "1",
    EVE_WORKSPACE_STATE_ENABLED: "1",
  };
  const routing = { principalId: "imessage:redis-owner", threadId: "imessage:redis-thread" };
  const initial = await getPhotonWorkspaceState(routing, client);
  const identity = deriveEveStrategyPackMutationIdentity({
    ingressId: `ingress_${"7".repeat(64)}`,
    operationOrdinal: 0,
    stepId: "step_redis_create",
    turnId: "turn_redis_create",
  });
  const request = {
    activateMonitorResourceIds: ["detect-alpha"],
    configuration: { dailyTimes: ["09:00"], timezone: "UTC" },
    expectedRegistryRevision: initial.revision,
    name: "Redis Alpha",
    pack: { contentDigest: alpha.contentDigest, id: alpha.id, version: alpha.version },
  };
  const dependencies = {
    capabilityInventory: [{ category: "research", id: "tool.alpha.fetch" }],
    catalog,
    environment,
    idFactory: () => "723e4567-e89b-42d3-a456-426614174000",
    monitorClient: client,
    observationSink() {},
    stateClient: client,
    transactionClient: client,
    workspaceClient: client,
  };
  const created = await createStrategyPackWorkspace({
    ...routing,
    now: new Date("2026-08-15T17:00:00.000Z"),
    request,
    requestIdentity: identity,
    sourceAssignment: { generation: 1, workspaceId: initial.activeWorkspace.id },
  }, dependencies);
  assert.equal(created.receipt.outcome, "created");
  assert.equal((await createStrategyPackWorkspace({
    ...routing,
    request,
    requestIdentity: identity,
    sourceAssignment: { generation: 1, workspaceId: initial.activeWorkspace.id },
  }, dependencies)).replayed, true);
  const scope = authorizeDeploymentWorkspaceStore({
    ownerId: environment.EVE_DEPLOYMENT_OWNER_ID,
    workspaceId: created.receipt.targetWorkspaceId,
  }, environment);
  assert.equal((await readWorkspaceDocument("strategy", scope, client))?.revision, 1);
  assert.equal((await listWorkspaceMonitors(scope, client))[0]?.lifecycleState, "enabled");

  const configured = await configureStrategyPackWorkspaceFromSelection({
    ...routing,
    confirmedConsequences: true,
    configuration: { dailyTimes: ["10:00"], timezone: "UTC" },
    expectedBindingRevision: 1,
    expectedRegistryRevision: 1,
    now: new Date("2026-08-15T17:01:00.000Z"),
    requestIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId: `ingress_${"8".repeat(64)}`,
      operationOrdinal: 0,
      stepId: "step_redis_configure",
      turnId: "turn_redis_configure",
    }),
    sourceAssignment: { generation: 1, workspaceId: created.receipt.targetWorkspaceId },
  }, dependencies);
  assert.equal(configured.receipt.outcome, "configured");
  assert.equal((await listWorkspaceMonitors(scope, client))[0]?.lifecycleState, "paused");
  const removed = await removeStrategyPackWorkspaceFromSelection({
    ...routing,
    confirmedConsequences: true,
    expectedBindingRevision: 2,
    expectedRegistryRevision: 2,
    now: new Date("2026-08-15T17:02:00.000Z"),
    requestIdentity: deriveEveStrategyPackMutationIdentity({
      ingressId: `ingress_${"9".repeat(64)}`,
      operationOrdinal: 0,
      stepId: "step_redis_remove",
      turnId: "turn_redis_remove",
    }),
    sourceAssignment: { generation: 2, workspaceId: created.receipt.targetWorkspaceId },
  }, dependencies);
  assert.equal(removed.receipt.outcome, "removed");
  assert.equal((await readWorkspaceDocument("strategy", scope, client))?.value.lifecycleState, "unbound");
  assert.equal((await listWorkspaceMonitors(scope, client))[0]?.lifecycleState, "retired");

  await redis("SET", photonApprovalGuardKey(routing), "pending");
  await assert.rejects(
    createStrategyPackWorkspace({
      ...routing,
      request: { invalid: true },
      requestIdentity: { invalid: true },
      sourceAssignment: { generation: 1, workspaceId: created.receipt.targetWorkspaceId },
    }, dependencies),
    (error) => error instanceof StrategyPackServiceError && error.code === "strategy_pack_financial_approval_pending",
  );
  console.log("Strategy pack real Redis mutation verification passed.");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolvePromise) => server.once("close", resolvePromise));
  await rm(temporaryRoot, { force: true, recursive: true });
}
