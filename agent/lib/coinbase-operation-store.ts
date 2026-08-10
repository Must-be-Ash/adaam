import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

const KEY_PREFIX = "eve:coinbase:v1:operation:";
const OPERATION_TTL_SECONDS = 30 * 24 * 60 * 60;

const operationSchema = z.object({
  schemaVersion: z.literal(1),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/u),
  state: z.enum(["started", "succeeded", "uncertain"]),
  toolName: z.string().min(1).max(120),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
});

interface OperationReceipt {
  createdAtMs: number;
  inputHash: string;
  key: string;
  toolName: string;
}

let redisClient: Redis | undefined;

function redis(): Redis {
  if (redisClient) return redisClient;
  const url =
    process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Coinbase mutation safety storage is not configured. Connect the isolated Upstash Redis resource before changing Coinbase state.",
    );
  }
  redisClient = new Redis({
    url,
    token,
    automaticDeserialization: false,
  });
  return redisClient;
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  throw new Error("The Coinbase operation contains a non-JSON input.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationKey(principalId: string, callId: string): string {
  return `${KEY_PREFIX}${sha256(`${principalId}\u0000${callId}`)}`;
}

function parseStoredOperation(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return operationSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function beginCoinbaseMutation(input: {
  callId: string;
  principalId: string;
  toolInput: Record<string, unknown>;
  toolName: string;
}): Promise<OperationReceipt> {
  const key = operationKey(input.principalId, input.callId);
  const inputHash = sha256(
    JSON.stringify(
      canonicalValue({
        input: input.toolInput,
        tool: input.toolName,
      }),
    ),
  );
  const now = Date.now();
  const record = {
    schemaVersion: 1,
    inputHash,
    state: "started",
    toolName: input.toolName,
    createdAtMs: now,
    updatedAtMs: now,
  } as const;
  const created = await redis().set(key, JSON.stringify(record), {
    ex: OPERATION_TTL_SECONDS,
    nx: true,
  });
  if (created) {
    return {
      createdAtMs: now,
      inputHash,
      key,
      toolName: input.toolName,
    };
  }

  const existing = parseStoredOperation(await redis().get(key));
  if (!existing || existing.inputHash !== inputHash) {
    throw new Error(
      "This Coinbase tool-call identity conflicts with an existing operation. Start a new request.",
    );
  }
  if (existing.state === "succeeded") {
    throw new Error(
      "This Coinbase operation already succeeded. Inspect its resulting state instead of repeating it.",
    );
  }
  throw new Error(
    "This Coinbase operation was already attempted and its completion is uncertain. Inspect Coinbase state before trying a new operation.",
  );
}

async function settleCoinbaseMutation(
  receipt: OperationReceipt,
  state: "succeeded" | "uncertain",
): Promise<void> {
  const record = {
    schemaVersion: 1,
    inputHash: receipt.inputHash,
    state,
    toolName: receipt.toolName,
    createdAtMs: receipt.createdAtMs,
    updatedAtMs: Date.now(),
  } as const;
  await redis().set(receipt.key, JSON.stringify(record), {
    ex: OPERATION_TTL_SECONDS,
    xx: true,
  });
}

export async function executeCoinbaseMutation<T>(input: {
  callId: string;
  operation: () => Promise<T>;
  principalId: string;
  toolInput: Record<string, unknown>;
  toolName: string;
}): Promise<T> {
  const receipt = await beginCoinbaseMutation(input);
  try {
    const result = await input.operation();
    await settleCoinbaseMutation(receipt, "succeeded").catch(() => undefined);
    return result;
  } catch (error) {
    await settleCoinbaseMutation(receipt, "uncertain").catch(() => undefined);
    throw error;
  }
}
