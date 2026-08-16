import { Redis } from "@upstash/redis";

import {
  congressionalFilingSignalSchema,
  congressionalSignalContractDigest,
  houseStrategyTransactionSchema,
  type CongressionalFilingSignal,
  type HouseStrategyTransaction,
} from "./congressional-signal-schema";
import type { CongressionalFilingEvaluation } from "./congressional-strategy";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:congressional-signals:v1:";
const MAX_RECORD_BYTES = 256 * 1_024;
const CREATE_OR_READ_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then
  return {0, current}
end
redis.call("SET", KEYS[1], ARGV[1])
return {1, ARGV[1]}
`;

export interface CongressionalSignalStoreClient {
  createOrRead(key: string, value: string): Promise<{ readonly created: boolean; readonly value: unknown }>;
  get(key: string): Promise<unknown>;
}

export interface CongressionalFilingPersistenceResult {
  readonly signalCreated: boolean;
  readonly signalReused: boolean;
  readonly transactionsCreated: number;
  readonly transactionsReused: number;
}

export class CongressionalSignalStoreError extends Error {
  constructor(readonly code: "congressional_record_conflict" | "congressional_record_corrupt") {
    super(code);
    this.name = "CongressionalSignalStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: CongressionalSignalStoreClient | undefined;

function store(): CongressionalSignalStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Congressional signal storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CREATE_OR_READ_SCRIPT);
  defaultClient = {
    async createOrRead(key, value) {
      let sha = await scriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<[string], [number, unknown]>(
        candidate,
        [key],
        [value],
      );
      let result: [number, unknown];
      try {
        result = await execute(sha);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        scriptSha = redisClient!.scriptLoad(CREATE_OR_READ_SCRIPT);
        sha = await scriptSha;
        result = await execute(sha);
      }
      return { created: result[0] === 1, value: result[1] };
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function recordKey(
  scope: AuthorizedWorkspaceStoreScope,
  kind: "signal" | "transaction",
  id: string,
): string {
  const digest = congressionalSignalContractDigest([scope.ownerId, scope.workspaceId, id]);
  return `${KEY_PREFIX}${kind}:${digest}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new CongressionalSignalStoreError("congressional_record_corrupt");
  }
  return raw;
}

function parseRecord<T>(raw: string, parse: (value: unknown) => T): T {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new CongressionalSignalStoreError("congressional_record_corrupt");
  }
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CongressionalSignalStoreError) throw error;
    throw new CongressionalSignalStoreError("congressional_record_corrupt");
  }
}

async function createOrReuse<T>(input: {
  client: CongressionalSignalStoreClient;
  key: string;
  parse: (value: unknown) => T;
  value: T;
}): Promise<"created" | "reused"> {
  const candidateRaw = serialize(input.value);
  const observed = await input.client.createOrRead(input.key, candidateRaw);
  const existingRaw = rawValue(observed.value);
  if (existingRaw === null) throw new CongressionalSignalStoreError("congressional_record_conflict");
  const existing = parseRecord(existingRaw, input.parse);
  if (serialize(existing) !== candidateRaw) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
  return observed.created ? "created" : "reused";
}

function assertScopedRecord(
  scope: AuthorizedWorkspaceStoreScope,
  record: HouseStrategyTransaction | CongressionalFilingSignal,
): void {
  if (record.workspaceId !== scope.workspaceId) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
}

export async function persistCongressionalFilingEvaluation(
  input: {
    readonly evaluation: CongressionalFilingEvaluation;
    readonly scope: AuthorizedWorkspaceStoreScope;
  },
  client: CongressionalSignalStoreClient = store(),
): Promise<CongressionalFilingPersistenceResult> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  assertScopedRecord(input.scope, input.evaluation.signal);
  if (
    JSON.stringify(input.evaluation.transactions.map(({ transactionRevisionId }) =>
      transactionRevisionId)) !== JSON.stringify(
      input.evaluation.signal.transactionEvaluations.map(({ transactionRevisionId }) =>
        transactionRevisionId),
    )
  ) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
  const transactionResults: ("created" | "reused")[] = [];
  for (let offset = 0; offset < input.evaluation.transactions.length; offset += 16) {
    const batch = input.evaluation.transactions.slice(offset, offset + 16);
    transactionResults.push(...await Promise.all(batch.map((transaction) => {
      assertScopedRecord(input.scope, transaction);
      return createOrReuse({
        client,
        key: recordKey(input.scope, "transaction", transaction.transactionRevisionId),
        parse: (value) => houseStrategyTransactionSchema.parse(value),
        value: transaction,
      });
    })));
  }
  const signalResult = await createOrReuse({
    client,
    key: recordKey(input.scope, "signal", input.evaluation.signal.signalRevisionId),
    parse: (value) => congressionalFilingSignalSchema.parse(value),
    value: input.evaluation.signal,
  });
  return Object.freeze({
    signalCreated: signalResult === "created",
    signalReused: signalResult === "reused",
    transactionsCreated: transactionResults.filter((result) => result === "created").length,
    transactionsReused: transactionResults.filter((result) => result === "reused").length,
  });
}

export async function readCongressionalFilingSignal(
  scope: AuthorizedWorkspaceStoreScope,
  signalRevisionId: string,
  client: CongressionalSignalStoreClient = store(),
): Promise<CongressionalFilingSignal | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(recordKey(scope, "signal", signalRevisionId)));
  if (raw === null) return null;
  const signal = parseRecord(raw, (value) => congressionalFilingSignalSchema.parse(value));
  assertScopedRecord(scope, signal);
  return signal;
}
