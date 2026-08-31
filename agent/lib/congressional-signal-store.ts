import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  congressionalFilingSignalSchema,
  congressionalSignalContractDigest,
  houseStrategyTransactionSchema,
  type CongressionalFilingSignal,
  type HouseStrategyTransaction,
} from "./congressional-signal-schema";
import {
  congressionalHistoryRevisionSchema,
  type CongressionalHistoryRevision,
} from "./congressional-history";
import type { CongressionalFilingEvaluation } from "./congressional-strategy";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:congressional-signals:v1:";
const MAX_RECORD_BYTES = 256 * 1_024;
const MAX_SIGNAL_RECORD_BYTES = 2 * 1_024 * 1_024;
const MAX_HISTORY_RECORD_BYTES = 2 * 1_024 * 1_024;
const CREATE_OR_READ_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then
  return {0, current}
end
redis.call("SET", KEYS[1], ARGV[1])
return {1, ARGV[1]}
`;
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

export interface CongressionalSignalStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
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
  let casScriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await casScriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<[string, string], number>(
        candidate,
        [key],
        [expected ?? "", next],
      );
      try {
        return (await execute(sha)) === 1;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        casScriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await casScriptSha;
        return (await execute(sha)) === 1;
      }
    },
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
  kind: "history" | "history-head" | "occurrence-history" | "signal" | "transaction",
  id: string,
): string {
  const digest = congressionalSignalContractDigest([scope.ownerId, scope.workspaceId, id]);
  return `${KEY_PREFIX}${kind}:${digest}`;
}

function historyHeadKey(scope: AuthorizedWorkspaceStoreScope): string {
  return recordKey(scope, "history-head", "current");
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown, maximumBytes = MAX_RECORD_BYTES): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
    throw new CongressionalSignalStoreError("congressional_record_corrupt");
  }
  return raw;
}

function parseRecord<T>(
  raw: string,
  parse: (value: unknown) => T,
  maximumBytes = MAX_RECORD_BYTES,
): T {
  if (Buffer.byteLength(raw, "utf8") > maximumBytes) {
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
  maximumBytes?: number;
  parse: (value: unknown) => T;
  value: T;
}): Promise<"created" | "reused"> {
  const candidateRaw = serialize(input.value, input.maximumBytes);
  const observed = await input.client.createOrRead(input.key, candidateRaw);
  const existingRaw = rawValue(observed.value);
  if (existingRaw === null) throw new CongressionalSignalStoreError("congressional_record_conflict");
  const existing = parseRecord(existingRaw, input.parse, input.maximumBytes);
  if (serialize(existing, input.maximumBytes) !== candidateRaw) {
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

async function persistSignalRecords(input: {
  readonly client: CongressionalSignalStoreClient;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly signal: CongressionalFilingSignal;
  readonly transactions: readonly HouseStrategyTransaction[];
}): Promise<CongressionalFilingPersistenceResult> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  assertScopedRecord(input.scope, input.signal);
  if (
    JSON.stringify(input.transactions.map(({ transactionRevisionId }) => transactionRevisionId)) !==
    JSON.stringify(input.signal.transactionEvaluations.map(({ transactionRevisionId }) =>
      transactionRevisionId))
  ) throw new CongressionalSignalStoreError("congressional_record_conflict");
  const transactionResults: ("created" | "reused")[] = [];
  for (let offset = 0; offset < input.transactions.length; offset += 16) {
    const batch = input.transactions.slice(offset, offset + 16);
    transactionResults.push(...await Promise.all(batch.map((transaction) => {
      assertScopedRecord(input.scope, transaction);
      return createOrReuse({
        client: input.client,
        key: recordKey(input.scope, "transaction", transaction.transactionRevisionId),
        parse: (value) => houseStrategyTransactionSchema.parse(value),
        value: transaction,
      });
    })));
  }
  const signalResult = await createOrReuse({
    client: input.client,
    key: recordKey(input.scope, "signal", input.signal.signalRevisionId),
    maximumBytes: MAX_SIGNAL_RECORD_BYTES,
    parse: (value) => congressionalFilingSignalSchema.parse(value),
    value: input.signal,
  });
  return Object.freeze({
    signalCreated: signalResult === "created",
    signalReused: signalResult === "reused",
    transactionsCreated: transactionResults.filter((result) => result === "created").length,
    transactionsReused: transactionResults.filter((result) => result === "reused").length,
  });
}

export async function persistCongressionalSignalRecords(input: {
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly signal: CongressionalFilingSignal;
  readonly transactions: readonly HouseStrategyTransaction[];
}, client: CongressionalSignalStoreClient = store()): Promise<CongressionalFilingPersistenceResult> {
  return persistSignalRecords({ ...input, client });
}

export async function persistCongressionalFilingEvaluation(
  input: {
    readonly evaluation: CongressionalFilingEvaluation;
    readonly scope: AuthorizedWorkspaceStoreScope;
  },
  client: CongressionalSignalStoreClient = store(),
): Promise<CongressionalFilingPersistenceResult> {
  return persistSignalRecords({
    client,
    scope: input.scope,
    signal: input.evaluation.signal,
    transactions: input.evaluation.transactions,
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
  const signal = parseRecord(
    raw,
    (value) => congressionalFilingSignalSchema.parse(value),
    MAX_SIGNAL_RECORD_BYTES,
  );
  assertScopedRecord(scope, signal);
  return signal;
}

export async function readCongressionalHistory(
  scope: AuthorizedWorkspaceStoreScope,
  client: CongressionalSignalStoreClient = store(),
): Promise<CongressionalHistoryRevision | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const headRaw = rawValue(await client.get(historyHeadKey(scope)));
  if (headRaw === null) return null;
  const head = parseRecord(headRaw, (value) => z.object({
    historyRevisionId: z.string().min(2).max(240),
  }).strict().parse(value));
  const revisionRaw = rawValue(await client.get(recordKey(scope, "history", head.historyRevisionId)));
  if (revisionRaw === null) throw new CongressionalSignalStoreError("congressional_record_corrupt");
  const history = parseRecord(
    revisionRaw,
    (value) => congressionalHistoryRevisionSchema.parse(value),
    MAX_HISTORY_RECORD_BYTES,
  );
  if (history.workspaceId !== scope.workspaceId) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
  return history;
}

// Pin the pre-occurrence history before mutating its head. A crash after the
// history write must not erase the prior alert/correction evidence on retry.
export async function snapshotCongressionalHistoryForOccurrence(input: {
  scope: AuthorizedWorkspaceStoreScope; occurrenceKey: string;
}, client: CongressionalSignalStoreClient = store()): Promise<CongressionalHistoryRevision | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const current = await readCongressionalHistory(input.scope, client);
  const observed = await client.createOrRead(recordKey(input.scope, "occurrence-history", input.occurrenceKey),
    serialize({ historyRevisionId: current?.historyRevisionId ?? null }));
  const raw = rawValue(observed.value);
  if (raw === null) throw new CongressionalSignalStoreError("congressional_record_corrupt");
  const snapshot = parseRecord(raw, (value) => z.object({ historyRevisionId: z.string().min(2).max(240).nullable() }).strict().parse(value));
  if (observed.created) {
    if (snapshot.historyRevisionId !== (current?.historyRevisionId ?? null)) throw new CongressionalSignalStoreError("congressional_record_conflict");
    return current;
  }
  if (snapshot.historyRevisionId === null) return null;
  const revisionRaw = rawValue(await client.get(recordKey(input.scope, "history", snapshot.historyRevisionId)));
  if (revisionRaw === null) throw new CongressionalSignalStoreError("congressional_record_corrupt");
  const history = parseRecord(revisionRaw, (value) => congressionalHistoryRevisionSchema.parse(value), MAX_HISTORY_RECORD_BYTES);
  if (history.workspaceId !== input.scope.workspaceId || history.historyRevisionId !== snapshot.historyRevisionId) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
  return history;
}

export async function persistCongressionalHistory(input: {
  readonly expectedHistoryRevisionId: string | null;
  readonly history: CongressionalHistoryRevision;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, client: CongressionalSignalStoreClient = store()): Promise<"created" | "reused"> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (input.history.workspaceId !== input.scope.workspaceId) {
    throw new CongressionalSignalStoreError("congressional_record_conflict");
  }
  const history = congressionalHistoryRevisionSchema.parse(input.history);
  await createOrReuse({
    client,
    key: recordKey(input.scope, "history", history.historyRevisionId),
    maximumBytes: MAX_HISTORY_RECORD_BYTES,
    parse: (value) => congressionalHistoryRevisionSchema.parse(value),
    value: history,
  });
  const expectedHead = input.expectedHistoryRevisionId === null
    ? null
    : serialize({ historyRevisionId: input.expectedHistoryRevisionId });
  const nextHead = serialize({ historyRevisionId: history.historyRevisionId });
  if (await client.compareAndSet(historyHeadKey(input.scope), expectedHead, nextHead)) return "created";
  const currentRaw = rawValue(await client.get(historyHeadKey(input.scope)));
  if (currentRaw === nextHead) return "reused";
  throw new CongressionalSignalStoreError("congressional_record_conflict");
}
