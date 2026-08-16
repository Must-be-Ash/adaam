import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

const KEY_PREFIX = "eve:strategy-pack:v1:mutation:";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const strategyPackMutationReceiptSchema = z
  .object({
    bindingRevision: z.number().int().positive().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    monitorIds: z.array(z.string().uuid()).max(16),
    mutationId: digestSchema,
    outcome: z.enum(["configured", "created", "rejected", "removed"]),
    payloadDigest: digestSchema,
    recordType: z.literal("strategy_pack_mutation_receipt"),
    registryRevision: z.number().int().positive().nullable(),
    rejectionCode: z.enum(["capacity_exhausted", "duplicate_name"]).nullable(),
    requestIdentityDigest: digestSchema,
    schemaVersion: z.literal(1),
    targetWorkspaceId: z.string().uuid().nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const succeeded = receipt.outcome !== "rejected";
    if (
      (succeeded &&
        (receipt.bindingRevision === null ||
          receipt.registryRevision === null ||
          receipt.rejectionCode !== null ||
          receipt.targetWorkspaceId === null)) ||
      (!succeeded &&
        (receipt.bindingRevision !== null ||
          receipt.monitorIds.length > 0 ||
          receipt.registryRevision !== null ||
          receipt.rejectionCode === null ||
          receipt.targetWorkspaceId !== null)) ||
      new Set(receipt.monitorIds).size !== receipt.monitorIds.length
    ) {
      context.addIssue({ code: "custom", message: "strategy_pack_receipt_invalid" });
    }
  });

export type StrategyPackMutationReceipt = z.infer<
  typeof strategyPackMutationReceiptSchema
>;

export interface StrategyPackCreateTransactionInput {
  readonly approvalGuardKey: string;
  readonly expectedRegistryRaw: string;
  readonly expectedRegistryRevision: number;
  readonly mappingKey: string;
  readonly mappingRaw: string;
  readonly monitors: readonly {
    readonly dueAtMs: number | null;
    readonly dueKey: string;
    readonly raw: string;
    readonly recordKey: string;
    readonly workspaceIndexKey: string;
  }[];
  readonly nextRegistryRaw: string | null;
  readonly receiptKey: string;
  readonly receiptRaw: string;
  readonly records: readonly { readonly key: string; readonly raw: string }[];
  readonly registryKey: string;
}

export interface StrategyPackLifecycleTransactionInput {
  readonly approvalGuardKey: string;
  readonly expectedRegistryRaw: string;
  readonly expectedRegistryRevision: number;
  readonly mappingKey: string;
  readonly mappingRaw: string;
  readonly monitors: readonly {
    readonly dueAtMs: number | null;
    readonly dueKey: string;
    readonly expectedRaw: string;
    readonly nextRaw: string;
    readonly recordKey: string;
  }[];
  readonly nextRegistryRaw: string;
  readonly receiptKey: string;
  readonly receiptRaw: string;
  readonly records: readonly {
    readonly expectedRaw: string;
    readonly key: string;
    readonly nextRaw: string;
  }[];
  readonly registryKey: string;
}

export type StrategyPackReplayResult =
  | { readonly status: "blocked" | "corrupt" | "missing" | "payload_conflict" }
  | { readonly receiptRaw: string; readonly status: "replayed" };

export type StrategyPackCommitResult =
  | StrategyPackReplayResult
  | { readonly status: "conflict" }
  | { readonly receiptRaw: string; readonly status: "committed" };

export interface StrategyPackTransactionClient {
  commitCreate(input: StrategyPackCreateTransactionInput): Promise<StrategyPackCommitResult>;
  commitLifecycle(input: StrategyPackLifecycleTransactionInput): Promise<StrategyPackCommitResult>;
  get(key: string): Promise<unknown>;
  readReplay(input: Pick<
    StrategyPackCreateTransactionInput | StrategyPackLifecycleTransactionInput,
    "approvalGuardKey" | "mappingKey" | "mappingRaw" | "receiptKey"
  >): Promise<StrategyPackReplayResult>;
}

const READ_REPLAY_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
  return "blocked"
end
local mapping = redis.call("GET", KEYS[2])
if not mapping then return "missing" end
if mapping ~= ARGV[1] then return "payload_conflict" end
local receipt = redis.call("GET", KEYS[3])
if not receipt then return "corrupt" end
return "replayed:" .. receipt
`;

const COMMIT_CREATE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then return "blocked" end
local mapping = redis.call("GET", KEYS[2])
if mapping then
  if mapping ~= ARGV[1] then return "payload_conflict" end
  local receipt = redis.call("GET", KEYS[3])
  if not receipt then return "corrupt" end
  return "replayed:" .. receipt
end
if redis.call("EXISTS", KEYS[3]) == 1 then return "conflict" end
local registry = redis.call("GET", KEYS[4])
if registry ~= ARGV[3] then return "conflict" end
local ok, decoded = pcall(cjson.decode, registry)
if not ok or tonumber(decoded.revision) ~= tonumber(ARGV[4]) then return "conflict" end
local record_count = tonumber(ARGV[6])
local monitor_count = tonumber(ARGV[7])
for index = 1, record_count do
  if redis.call("EXISTS", KEYS[4 + index]) == 1 then return "conflict" end
end
local monitor_key_offset = 4 + record_count
for index = 1, monitor_count do
  local base = monitor_key_offset + ((index - 1) * 3)
  if redis.call("EXISTS", KEYS[base + 1]) == 1 then return "conflict" end
  local index_type = redis.call("TYPE", KEYS[base + 2])
  local index_type_name = index_type["ok"] or index_type
  if index_type_name ~= "none" and index_type_name ~= "set" then return "conflict" end
  local due_type = redis.call("TYPE", KEYS[base + 3])
  local due_type_name = due_type["ok"] or due_type
  if due_type_name ~= "none" and due_type_name ~= "zset" then return "conflict" end
  local due = ARGV[7 + record_count + ((index - 1) * 2) + 2]
  if due ~= "" and tonumber(due) == nil then return "conflict" end
end
if ARGV[5] ~= "" then redis.call("SET", KEYS[4], ARGV[5]) end
local argument_offset = 7
for index = 1, record_count do
  redis.call("SET", KEYS[4 + index], ARGV[argument_offset + index])
end
argument_offset = argument_offset + record_count
for index = 1, monitor_count do
  local base = monitor_key_offset + ((index - 1) * 3)
  local raw = ARGV[argument_offset + ((index - 1) * 2) + 1]
  local due = ARGV[argument_offset + ((index - 1) * 2) + 2]
  redis.call("SET", KEYS[base + 1], raw)
  redis.call("SADD", KEYS[base + 2], KEYS[base + 1])
  if due ~= "" then redis.call("ZADD", KEYS[base + 3], due, KEYS[base + 1]) end
end
redis.call("SET", KEYS[2], ARGV[1])
redis.call("SET", KEYS[3], ARGV[2])
return "committed:" .. ARGV[2]
`;

const COMMIT_LIFECYCLE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then return "blocked" end
local mapping = redis.call("GET", KEYS[2])
if mapping then
  if mapping ~= ARGV[1] then return "payload_conflict" end
  local receipt = redis.call("GET", KEYS[3])
  if not receipt then return "corrupt" end
  return "replayed:" .. receipt
end
if redis.call("EXISTS", KEYS[3]) == 1 then return "conflict" end
local registry = redis.call("GET", KEYS[4])
if registry ~= ARGV[3] then return "conflict" end
local ok, decoded = pcall(cjson.decode, registry)
if not ok or tonumber(decoded.revision) ~= tonumber(ARGV[4]) then return "conflict" end
local record_count = tonumber(ARGV[6])
local monitor_count = tonumber(ARGV[7])
local argument_offset = 7
for index = 1, record_count do
  if redis.call("GET", KEYS[4 + index]) ~= ARGV[argument_offset + ((index - 1) * 2) + 1] then
    return "conflict"
  end
end
local monitor_key_offset = 4 + record_count
argument_offset = argument_offset + (record_count * 2)
for index = 1, monitor_count do
  local base = monitor_key_offset + ((index - 1) * 2)
  if redis.call("GET", KEYS[base + 1]) ~= ARGV[argument_offset + ((index - 1) * 3) + 1] then
    return "conflict"
  end
  local due_type = redis.call("TYPE", KEYS[base + 2])
  local due_type_name = due_type["ok"] or due_type
  if due_type_name ~= "none" and due_type_name ~= "zset" then return "conflict" end
  local due = ARGV[argument_offset + ((index - 1) * 3) + 3]
  if due ~= "" and tonumber(due) == nil then return "conflict" end
end
redis.call("SET", KEYS[4], ARGV[5])
argument_offset = 7
for index = 1, record_count do
  redis.call("SET", KEYS[4 + index], ARGV[argument_offset + ((index - 1) * 2) + 2])
end
argument_offset = argument_offset + (record_count * 2)
for index = 1, monitor_count do
  local base = monitor_key_offset + ((index - 1) * 2)
  local next_raw = ARGV[argument_offset + ((index - 1) * 3) + 2]
  local due = ARGV[argument_offset + ((index - 1) * 3) + 3]
  redis.call("SET", KEYS[base + 1], next_raw)
  if due == "" then
    redis.call("ZREM", KEYS[base + 2], KEYS[base + 1])
  else
    redis.call("ZADD", KEYS[base + 2], due, KEYS[base + 1])
  end
end
redis.call("SET", KEYS[2], ARGV[1])
redis.call("SET", KEYS[3], ARGV[2])
return "committed:" .. ARGV[2]
`;

export const STRATEGY_PACK_TRANSACTION_REDIS_SCRIPTS = Object.freeze({
  commitCreate: COMMIT_CREATE_SCRIPT,
  commitLifecycle: COMMIT_LIFECYCLE_SCRIPT,
  readReplay: READ_REPLAY_SCRIPT,
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function strategyPackMutationStorageKeys(input: {
  ownerId: string;
  principalId: string;
  requestIdentityDigest: string;
  threadId: string;
}): { mappingKey: string; receiptKey: (mutationId: string) => string } {
  const scope = digest(
    `strategy-pack-mutation\0${input.ownerId}\0${input.principalId}\0${input.threadId}`,
  );
  return {
    mappingKey: `${KEY_PREFIX}request:${scope}:${input.requestIdentityDigest}`,
    receiptKey: (mutationId) => `${KEY_PREFIX}receipt:${scope}:${digest(mutationId)}`,
  };
}

function decodeResult(value: string): StrategyPackCommitResult {
  if (value.startsWith("committed:")) {
    return { receiptRaw: value.slice("committed:".length), status: "committed" };
  }
  if (value.startsWith("replayed:")) {
    return { receiptRaw: value.slice("replayed:".length), status: "replayed" };
  }
  if (
    value === "blocked" ||
    value === "conflict" ||
    value === "corrupt" ||
    value === "missing" ||
    value === "payload_conflict"
  ) {
    return { status: value };
  }
  return { status: "corrupt" };
}

let redisClient: Redis | undefined;
let defaultClient: StrategyPackTransactionClient | undefined;

export function strategyPackTransactionClient(
  environment: NodeJS.ProcessEnv = process.env,
): StrategyPackTransactionClient {
  if (defaultClient) return defaultClient;
  const url = environment.KV_REST_API_URL ?? environment.UPSTASH_REDIS_REST_URL;
  const token = environment.KV_REST_API_TOKEN ?? environment.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Strategy pack mutation storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  defaultClient = {
    async commitCreate(input) {
      if (
        input.records.length > 4 ||
        input.monitors.length > 16 ||
        new Set(input.records.map((record) => record.key)).size !== input.records.length ||
        new Set(input.monitors.map((monitor) => monitor.recordKey)).size !== input.monitors.length
      ) {
        return { status: "conflict" };
      }
      const keys = [
        input.approvalGuardKey,
        input.mappingKey,
        input.receiptKey,
        input.registryKey,
        ...input.records.map((record) => record.key),
        ...input.monitors.flatMap((monitor) => [
          monitor.recordKey,
          monitor.workspaceIndexKey,
          monitor.dueKey,
        ]),
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
        ...input.monitors.flatMap((monitor) => [
          monitor.raw,
          monitor.dueAtMs === null ? "" : String(monitor.dueAtMs),
        ]),
      ];
      const result = await redisClient!.eval<string[], string>(
        COMMIT_CREATE_SCRIPT,
        keys,
        args,
      );
      return decodeResult(result);
    },
    async commitLifecycle(input) {
      if (
        input.records.length > 4 ||
        input.monitors.length > 16 ||
        new Set(input.records.map((record) => record.key)).size !== input.records.length ||
        new Set(input.monitors.map((monitor) => monitor.recordKey)).size !== input.monitors.length
      ) {
        return { status: "conflict" };
      }
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
      const result = await redisClient!.eval<string[], string>(
        COMMIT_LIFECYCLE_SCRIPT,
        keys,
        args,
      );
      return decodeResult(result);
    },
    get: (key) => redisClient!.get(key),
    async readReplay(input) {
      const result = await redisClient!.eval<[string], string>(
        READ_REPLAY_SCRIPT,
        [input.approvalGuardKey, input.mappingKey, input.receiptKey],
        [input.mappingRaw],
      );
      const decoded = decodeResult(result);
      if (decoded.status === "committed" || decoded.status === "conflict") {
        return { status: "corrupt" };
      }
      return decoded;
    },
  };
  return defaultClient;
}
