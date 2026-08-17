import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:workspace-runtime:v1:earnings-source-lifecycle:";
const MAX_RECORD_BYTES = 32 * 1_024;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

const idSchema = z.string().min(3).max(200);
const acknowledgementSchema = z.object({
  acquisitionId: idSchema,
  expectedDeliveryRevision: z.number().int().nonnegative(),
  sourceId: idSchema,
  subscriptionId: idSchema,
}).strict();
const retrySchema = z.object({
  acquisitionId: idSchema,
  retryAfterSeconds: z.number().int().positive().max(86_400),
  retryAt: z.string().datetime({ offset: true }),
  runId: idSchema,
  sourceId: idSchema,
}).strict();
const lifecycleSchema = z.object({
  acknowledgements: z.array(acknowledgementSchema).max(8),
  monitorId: idSchema,
  occurrenceKey: idSchema,
  ownerId: idSchema,
  retry: retrySchema.nullable(),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

type LifecycleRecord = z.infer<typeof lifecycleSchema>;
export type EarningsCallSourceRetry = z.infer<typeof retrySchema>;
export type EarningsCallProjectionAcknowledgement = z.infer<typeof acknowledgementSchema>;

export interface EarningsCallSourceLifecycleClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface EarningsCallSourceLifecycleStore {
  clearRetry(input: {
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }): Promise<void>;
  completeAcknowledgement(input: {
    acquisitionId: string;
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
    subscriptionId: string;
  }): Promise<void>;
  listAcknowledgements(input: {
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }): Promise<readonly EarningsCallProjectionAcknowledgement[]>;
  readRetry(input: {
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }): Promise<EarningsCallSourceRetry | null>;
  recordAcknowledgement(input: EarningsCallProjectionAcknowledgement & {
    monitorId: string;
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }): Promise<void>;
  recordRetry(input: {
    acquisitionId: string;
    monitorId: string;
    now?: Date;
    occurrenceKey: string;
    retryAfterSeconds: number;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sourceId: string;
  }): Promise<void>;
}

let redisClient: Redis | undefined;
let defaultClient: EarningsCallSourceLifecycleClient | undefined;

function redisStore(): EarningsCallSourceLifecycleClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Earnings-call source lifecycle storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<[string, string], number>(
        candidate,
        [key],
        [expected ?? "", next],
      );
      try {
        return (await execute(sha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        scriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await scriptSha;
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse(raw: string | null): LifecycleRecord | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) throw new Error("earnings_source_lifecycle_corrupt");
  try {
    return lifecycleSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("earnings_source_lifecycle_corrupt");
  }
}

function key(input: { occurrenceKey: string; scope: AuthorizedWorkspaceStoreScope }): string {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  return `${KEY_PREFIX}${createHash("sha256").update(JSON.stringify([
    input.scope.ownerId,
    input.scope.workspaceId,
    input.occurrenceKey,
  ])).digest("hex")}`;
}

function assertScope(record: LifecycleRecord, scope: AuthorizedWorkspaceStoreScope): void {
  if (record.ownerId !== scope.ownerId || record.workspaceId !== scope.workspaceId) {
    throw new Error("earnings_source_lifecycle_scope_mismatch");
  }
}

export function createEarningsCallSourceLifecycleStore(
  client: EarningsCallSourceLifecycleClient = redisStore(),
): EarningsCallSourceLifecycleStore {
  const update = async (input: {
    monitorId?: string;
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }, mutate: (record: LifecycleRecord) => LifecycleRecord): Promise<void> => {
    const recordKey = key(input);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const currentRaw = rawValue(await client.get(recordKey));
      const current = parse(currentRaw) ?? lifecycleSchema.parse({
        acknowledgements: [],
        monitorId: input.monitorId,
        occurrenceKey: input.occurrenceKey,
        ownerId: input.scope.ownerId,
        retry: null,
        schemaVersion: 1,
        workspaceId: input.scope.workspaceId,
      });
      assertScope(current, input.scope);
      if (
        current.occurrenceKey !== input.occurrenceKey ||
        (input.monitorId !== undefined && current.monitorId !== input.monitorId)
      ) throw new Error("earnings_source_lifecycle_conflict");
      const next = lifecycleSchema.parse(mutate(current));
      const nextRaw = JSON.stringify(next);
      if (Buffer.byteLength(nextRaw, "utf8") > MAX_RECORD_BYTES) {
        throw new Error("earnings_source_lifecycle_corrupt");
      }
      if (await client.compareAndSet(recordKey, currentRaw, nextRaw)) return;
    }
    throw new Error("earnings_source_lifecycle_conflict");
  };

  const read = async (input: {
    occurrenceKey: string;
    scope: AuthorizedWorkspaceStoreScope;
  }): Promise<LifecycleRecord | null> => {
    const record = parse(rawValue(await client.get(key(input))));
    if (record) {
      assertScope(record, input.scope);
      if (record.occurrenceKey !== input.occurrenceKey) throw new Error("earnings_source_lifecycle_conflict");
    }
    return record;
  };

  const lifecycleStore: EarningsCallSourceLifecycleStore = {
    async clearRetry(input) {
      if (!(await read(input))) return;
      await update(input, (record) => ({ ...record, retry: null }));
    },
    async completeAcknowledgement(input) {
      if (!(await read(input))) return;
      await update(input, (record) => ({
        ...record,
        acknowledgements: record.acknowledgements.filter((candidate) =>
          candidate.acquisitionId !== input.acquisitionId ||
          candidate.subscriptionId !== input.subscriptionId),
      }));
    },
    async listAcknowledgements(input) {
      return Object.freeze([...(await read(input))?.acknowledgements ?? []]);
    },
    async readRetry(input) {
      return (await read(input))?.retry ?? null;
    },
    async recordAcknowledgement(input) {
      await update(input, (record) => {
        const acknowledgement = acknowledgementSchema.parse({
          acquisitionId: input.acquisitionId,
          expectedDeliveryRevision: input.expectedDeliveryRevision,
          sourceId: input.sourceId,
          subscriptionId: input.subscriptionId,
        });
        const existing = record.acknowledgements.find((candidate) =>
          candidate.subscriptionId === acknowledgement.subscriptionId);
        if (existing && JSON.stringify(existing) !== JSON.stringify(acknowledgement)) {
          throw new Error("earnings_source_lifecycle_conflict");
        }
        return existing ? record : {
          ...record,
          acknowledgements: [...record.acknowledgements, acknowledgement],
        };
      });
    },
    async recordRetry(input) {
      const retry = retrySchema.parse({
        acquisitionId: input.acquisitionId,
        retryAfterSeconds: input.retryAfterSeconds,
        retryAt: new Date((input.now ?? new Date()).getTime() + input.retryAfterSeconds * 1_000).toISOString(),
        runId: input.runId,
        sourceId: input.sourceId,
      });
      await update(input, (record) => ({ ...record, retry }));
    },
  };
  return Object.freeze(lifecycleStore);
}

const defaultStore = () => createEarningsCallSourceLifecycleStore();

export const readEarningsCallSourceRetry = (input: Parameters<EarningsCallSourceLifecycleStore["readRetry"]>[0]) =>
  defaultStore().readRetry(input);
export const clearEarningsCallSourceRetry = (input: Parameters<EarningsCallSourceLifecycleStore["clearRetry"]>[0]) =>
  defaultStore().clearRetry(input);
