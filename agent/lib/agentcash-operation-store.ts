import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import { normalizeAgentcashFetchInput } from "#agentcash-policy";

import {
  agentcashRequestHash,
  legacyAgentcashRequestHash,
} from "#agentcash-request";

const KEY_PREFIX = "eve:agentcash:v1:operation:";
const OPERATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_OPERATION_BYTES = 1_000_000;
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return 1
`;

const operationSchema = z
  .object({
    createdAtMs: z.number().int().nonnegative(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
    result: z.unknown().optional(),
    schemaVersion: z.literal(1),
    state: z.enum(["started", "succeeded", "uncertain"]),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export interface AgentcashOperationStoreClient {
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
    ttlSeconds?: number,
  ): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

let redisClient: Redis | undefined;
let defaultStore: AgentcashOperationStoreClient | undefined;

function operationStore(): AgentcashOperationStoreClient {
  if (defaultStore) return defaultStore;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "AgentCash payment safety storage is not configured. Connect the isolated Upstash Redis resource before allowing paid calls.",
    );
  }
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha: Promise<string> | undefined;
  const loadScript = (): Promise<string> => {
    scriptSha ??= redisClient!.scriptLoad(COMPARE_AND_SET_SCRIPT).catch((error) => {
      scriptSha = undefined;
      throw error;
    });
    return scriptSha;
  };
  defaultStore = {
    async compareAndSet(key, expected, next, ttlSeconds = OPERATION_TTL_SECONDS) {
      const execute = (candidate: string) =>
        redisClient!.evalsha<[string, string, string], number>(
          candidate,
          [key],
          [expected ?? "", next, String(ttlSeconds)],
        );
      try {
        const sha = await loadScript();
        return (await execute(sha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
          throw error;
        }
        scriptSha = undefined;
        const sha = await loadScript();
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultStore;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationKey(principalId: string, callId: string): string {
  return `${KEY_PREFIX}${sha256(`${principalId}\0${callId}`)}`;
}

function parseOperation(value: unknown) {
  if (value === null || value === undefined) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_OPERATION_BYTES) return null;
  try {
    return operationSchema.parse(JSON.parse(serialized));
  } catch {
    return null;
  }
}

function existingResult(
  operation: z.infer<typeof operationSchema>,
  acceptedInputHashes: ReadonlySet<string>,
): unknown {
  if (!acceptedInputHashes.has(operation.inputHash)) {
    throw new Error(
      "This AgentCash tool-call identity conflicts with a different request. Start a new request.",
    );
  }
  if (operation.state === "succeeded" && "result" in operation) {
    return operation.result;
  }
  throw new Error(
    "This AgentCash payment was already attempted and its completion is uncertain. Do not repay; inspect the provider or wallet history first.",
  );
}

interface AttemptIdentity {
  readonly attemptScope: string;
  readonly principalId: string;
  readonly toolInput: Record<string, unknown>;
  readonly store?: AgentcashOperationStoreClient;
}

function attemptKey(input: AttemptIdentity): string {
  // Changing payment options must not turn a failed purchase into a new attempt.
  const normalized = normalizeAgentcashFetchInput(input.toolInput);
  const { maxAmount, paymentNetwork, paymentProtocol, timeout, ...resource } = normalized;
  resource.headers = Object.fromEntries(new Headers(normalized.headers).entries());
  return `${KEY_PREFIX}attempt:${sha256(`${input.principalId}\0${input.attemptScope}\0${agentcashRequestHash(resource)}`)}`;
}

export async function assertAgentcashRetryAllowed(input: AttemptIdentity): Promise<void> {
  const previous = parseOperation(await (input.store ?? operationStore()).get(attemptKey(input)));
  if (previous && previous.state !== "succeeded") {
    throw new Error("This AgentCash purchase was already attempted in this turn. Do not retry or switch payment protocols; report the failure and check payment history first.");
  }
}

function hasFailedPaymentResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  // A price-cap rejection is explicitly before payment, so a newly approved
  // higher cap can proceed. HTTP errors after the SDK payment flow are not.
  if (record.type === "before_payment") return false;
  if (record.isError === true || record.success === false ||
      (record.surface === "fetch" && typeof record.cause === "string")) return true;
  return Array.isArray(record.content) && record.content.some((entry) => {
    if (entry?.type !== "text" || typeof entry.text !== "string") return false;
    try { return hasFailedPaymentResult(JSON.parse(entry.text)); } catch { return false; }
  });
}

export async function executeAgentcashPayment(input: {
  readonly attemptScope?: string;
  readonly callId: string;
  readonly operation: () => Promise<unknown>;
  readonly principalId: string;
  readonly store?: AgentcashOperationStoreClient;
  readonly toolInput: Record<string, unknown>;
}): Promise<unknown> {
  const store = input.store ?? operationStore();
  const key = operationKey(input.principalId, input.callId);
  const inputHash = agentcashRequestHash(input.toolInput);
  const acceptedInputHashes = new Set([
    inputHash,
    legacyAgentcashRequestHash(input.toolInput),
  ]);
  const existing = parseOperation(await store.get(key));
  if (existing) return existingResult(existing, acceptedInputHashes);

  const now = Date.now();
  const started = JSON.stringify(
    operationSchema.parse({
      createdAtMs: now,
      inputHash,
      schemaVersion: 1,
      state: "started",
      updatedAtMs: now,
    }),
  );
  if (!(await store.compareAndSet(key, null, started))) {
    const raced = parseOperation(await store.get(key));
    if (raced) return existingResult(raced, acceptedInputHashes);
    throw new Error("The AgentCash payment safety receipt could not be created.");
  }

  const scopedIdentity = input.attemptScope ? { ...input, attemptScope: input.attemptScope } : null;
  let scopedKey: string | undefined;
  if (scopedIdentity) {
    await assertAgentcashRetryAllowed(scopedIdentity);
    scopedKey = attemptKey(scopedIdentity);
    const previous = await store.get(scopedKey);
    const previousAttempt = parseOperation(previous);
    if (previousAttempt && previousAttempt.state !== "succeeded") {
      throw new Error("This AgentCash purchase was already attempted. Do not retry.");
    }
    const expected = previous === null ? null : typeof previous === "string" ? previous : JSON.stringify(previous);
    if (!(await store.compareAndSet(scopedKey, expected, started))) {
      throw new Error("This AgentCash purchase is already being attempted. Do not retry.");
    }
  }
  try {
    const result = (await input.operation()) ?? null;
    if (hasFailedPaymentResult(result)) {
      throw new Error("AgentCash could not complete the payment request. Do not retry or switch payment protocols. Payment completion is unconfirmed; report the blocker and inspect provider or wallet history first.");
    }
    const succeeded = JSON.stringify(
      operationSchema.parse({
        createdAtMs: now,
        inputHash,
        result,
        schemaVersion: 1,
        state: "succeeded",
        updatedAtMs: Date.now(),
      }),
    );
    await store.compareAndSet(key, started, succeeded).catch(() => false);
    if (scopedKey) {
      const completedAttempt = JSON.stringify({
        createdAtMs: now, inputHash, schemaVersion: 1,
        state: "succeeded", updatedAtMs: Date.now(),
      });
      await store.compareAndSet(scopedKey, started, completedAttempt).catch(() => false);
    }
    return result;
  } catch (error) {
    const uncertain = JSON.stringify(
      operationSchema.parse({
        createdAtMs: now,
        inputHash,
        schemaVersion: 1,
        state: "uncertain",
        updatedAtMs: Date.now(),
      }),
    );
    await store.compareAndSet(key, started, uncertain).catch(() => false);
    if (scopedKey) await store.compareAndSet(scopedKey, started, uncertain).catch(() => false);
    throw error;
  }
}
