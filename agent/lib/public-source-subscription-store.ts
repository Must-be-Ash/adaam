import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";

import {
  readPublicSourceAcquisitionJournal,
  readPublicSourceFactRevision,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import {
  digestPublicSourceValue,
  publicSourceAcquisitionResultSchema,
  publicSourceProjectionSchema,
  publicSourceSubscriptionSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceAcquisitionResult,
  type PublicSourceProjection,
  type PublicSourceSubscription,
} from "./public-source-adapter-schema";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:public-source:v1:workspace:";
const MAX_RECORD_BYTES = 64 * 1_024;
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

export interface PublicSourceSubscriptionStoreClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export interface AuthorizedPublicSourceProjection {
  readonly fact: CanonicalPublicFactRevision;
  readonly projection: PublicSourceProjection;
}

export interface PublicSourceProjectionCommit {
  readonly projections: readonly AuthorizedPublicSourceProjection[];
  readonly projectionsCreated: number;
  readonly projectionsReused: number;
  readonly replayed: boolean;
  readonly subscription: PublicSourceSubscription;
}

export class PublicSourceSubscriptionStoreError extends Error {
  readonly code:
    | "projection_conflict"
    | "public_source_subscription_corrupt"
    | "subscription_conflict"
    | "subscription_inactive"
    | "subscription_scope_mismatch";

  constructor(code: PublicSourceSubscriptionStoreError["code"]) {
    super(code);
    this.code = code;
    this.name = "PublicSourceSubscriptionStoreError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: PublicSourceSubscriptionStoreClient | undefined;

function store(): PublicSourceSubscriptionStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Public-source subscription storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) => redisClient!.evalsha<
        [string, string],
        number
      >(candidate, [key], [expected ?? "", next]);
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

function scopeDigest(scope: AuthorizedWorkspaceStoreScope): string {
  return createHash("sha256")
    .update(`public-source-workspace\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
}

function recordKey(
  kind: "projection" | "subscription",
  id: string,
  scope: AuthorizedWorkspaceStoreScope,
): string {
  const digest = createHash("sha256").update(id).digest("hex");
  return `${KEY_PREFIX}${scopeDigest(scope)}:${kind}:${digest}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function serialize(value: unknown): string {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new PublicSourceSubscriptionStoreError("public_source_subscription_corrupt");
  }
  return raw;
}

function parseRaw<T>(raw: string, parse: (value: unknown) => T): T {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new PublicSourceSubscriptionStoreError("public_source_subscription_corrupt");
  }
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof PublicSourceSubscriptionStoreError) throw error;
    throw new PublicSourceSubscriptionStoreError("public_source_subscription_corrupt");
  }
}

function assertSubscriptionScope(
  subscription: PublicSourceSubscription,
  scope: AuthorizedWorkspaceStoreScope,
): void {
  if (subscription.workspaceId !== scope.workspaceId) {
    throw new PublicSourceSubscriptionStoreError("subscription_scope_mismatch");
  }
}

export function derivePublicSourceSubscriptionId(input: {
  readonly monitorId: string;
  readonly sourceInstanceId: string;
  readonly workspaceId: string;
}): string {
  return `subscription.${digestPublicSourceValue([
    input.workspaceId,
    input.monitorId,
    input.sourceInstanceId,
  ])}`;
}

export async function readPublicSourceSubscription(
  scope: AuthorizedWorkspaceStoreScope,
  subscriptionId: string,
  client: PublicSourceSubscriptionStoreClient = store(),
): Promise<PublicSourceSubscription | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(recordKey("subscription", subscriptionId, scope)));
  if (raw === null) return null;
  const subscription = parseRaw(raw, (value) => publicSourceSubscriptionSchema.parse(value));
  assertSubscriptionScope(subscription, scope);
  return subscription;
}

export async function ensurePublicSourceSubscription(
  scope: AuthorizedWorkspaceStoreScope,
  seed: PublicSourceSubscription,
  client: PublicSourceSubscriptionStoreClient = store(),
): Promise<PublicSourceSubscription> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const subscription = publicSourceSubscriptionSchema.parse(seed);
  assertSubscriptionScope(subscription, scope);
  const key = recordKey("subscription", subscription.subscriptionId, scope);
  const raw = serialize(subscription);
  if (await client.compareAndSet(key, null, raw)) return subscription;
  const existingRaw = rawValue(await client.get(key));
  if (existingRaw === null) {
    throw new PublicSourceSubscriptionStoreError("subscription_conflict");
  }
  const existing = parseRaw(existingRaw, (value) => publicSourceSubscriptionSchema.parse(value));
  assertSubscriptionScope(existing, scope);
  const {
    deliveryCursor: _existingCursor,
    lifecycleState: _existingLifecycle,
    packBinding: _existingBinding,
    ...existingIdentity
  } = existing;
  const {
    deliveryCursor: _seedCursor,
    lifecycleState: _seedLifecycle,
    packBinding: _seedBinding,
    ...seedIdentity
  } = subscription;
  if (JSON.stringify(existingIdentity) !== JSON.stringify(seedIdentity)) {
    throw new PublicSourceSubscriptionStoreError("subscription_conflict");
  }
  if (
    existing.lifecycleState === subscription.lifecycleState &&
    JSON.stringify(existing.packBinding) === JSON.stringify(subscription.packBinding)
  ) {
    return existing;
  }
  const synchronized = publicSourceSubscriptionSchema.parse({
    ...existing,
    lifecycleState: subscription.lifecycleState,
    packBinding: subscription.packBinding,
  });
  if (await client.compareAndSet(key, existingRaw, serialize(synchronized))) {
    return synchronized;
  }
  const current = await readPublicSourceSubscription(scope, subscription.subscriptionId, client);
  if (
    current &&
    current.lifecycleState === subscription.lifecycleState &&
    JSON.stringify(current.packBinding) === JSON.stringify(subscription.packBinding)
  ) {
    return current;
  }
  throw new PublicSourceSubscriptionStoreError("subscription_conflict");
}

export async function readAuthorizedPublicSourceProjection(input: {
  readonly factRevisionId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly subscriptionId: string;
}, clients: {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
} = {}): Promise<AuthorizedPublicSourceProjection | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const subscription = await readPublicSourceSubscription(
    input.scope,
    input.subscriptionId,
    clients.subscription,
  );
  if (!subscription) return null;
  const projectionId = `projection.${digestPublicSourceValue([
    input.subscriptionId,
    input.factRevisionId,
  ])}`;
  const raw = rawValue(await (clients.subscription ?? store()).get(
    recordKey("projection", projectionId, input.scope),
  ));
  if (raw === null) return null;
  const projection = parseRaw(raw, (value) => publicSourceProjectionSchema.parse(value));
  if (
    projection.workspaceId !== input.scope.workspaceId ||
    projection.subscriptionId !== subscription.subscriptionId ||
    projection.monitorId !== subscription.monitorId ||
    projection.sourceInstanceId !== subscription.sourceInstanceId ||
    projection.factRevisionId !== input.factRevisionId
  ) {
    throw new PublicSourceSubscriptionStoreError("public_source_subscription_corrupt");
  }
  const fact = await readPublicSourceFactRevision(input.factRevisionId, clients.acquisition);
  if (!fact || fact.sourceInstanceId !== subscription.sourceInstanceId) {
    throw new PublicSourceSubscriptionStoreError("public_source_subscription_corrupt");
  }
  return Object.freeze({ fact, projection });
}

function matchesFilter(
  subscription: PublicSourceSubscription,
  fact: CanonicalPublicFactRevision,
): boolean {
  if (!subscription.factSchemaVersions.includes(fact.factSchemaVersion)) return false;
  if (subscription.filter.kind === "all") return true;
  return fact.payload.schemaVersion === "sec-filing/v1" &&
    subscription.filter.forms.includes(fact.payload.formType);
}

export async function projectPublicSourceAcquisition(input: {
  readonly acquisition: PublicSourceAcquisitionResult;
  readonly projectedAt?: Date;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly subscriptionId: string;
}, clients: {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
} = {}): Promise<PublicSourceProjectionCommit> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const acquisition = publicSourceAcquisitionResultSchema.parse(input.acquisition);
  if (acquisition.status !== "complete" && acquisition.status !== "no_change") {
    throw new PublicSourceSubscriptionStoreError("projection_conflict");
  }
  const client = clients.subscription ?? store();
  const key = recordKey("subscription", input.subscriptionId, input.scope);
  const initialRaw = rawValue(await client.get(key));
  if (initialRaw === null) throw new PublicSourceSubscriptionStoreError("subscription_conflict");
  const initial = parseRaw(initialRaw, (value) => publicSourceSubscriptionSchema.parse(value));
  assertSubscriptionScope(initial, input.scope);
  if (initial.lifecycleState !== "active") {
    throw new PublicSourceSubscriptionStoreError("subscription_inactive");
  }
  if (
    initial.sourceInstanceId !== acquisition.sourceInstanceId ||
    initial.adapterDefinitionDigest !== acquisition.adapterDefinitionDigest ||
    initial.adapterVersion !== acquisition.adapterVersion
  ) {
    throw new PublicSourceSubscriptionStoreError("subscription_conflict");
  }
  const journal = await readPublicSourceAcquisitionJournal(
    acquisition.acquisitionId,
    clients.acquisition,
  );
  if (!journal || journal.status !== "committed") {
    throw new PublicSourceSubscriptionStoreError("projection_conflict");
  }
  if (
    journal.sourceInstanceId !== acquisition.sourceInstanceId ||
    journal.adapterDefinitionDigest !== acquisition.adapterDefinitionDigest ||
    JSON.stringify(journal.factRevisionIds) !==
      JSON.stringify(acquisition.candidateFactRevisionIds) ||
    JSON.stringify(journal.correctionIds) !== JSON.stringify(acquisition.correctionIds)
  ) {
    throw new PublicSourceSubscriptionStoreError("projection_conflict");
  }
  const facts = (await Promise.all(acquisition.candidateFactRevisionIds.map(
    (revisionId) => readPublicSourceFactRevision(revisionId, clients.acquisition),
  ))).filter((fact): fact is CanonicalPublicFactRevision => fact !== null);
  if (
    facts.length !== acquisition.candidateFactRevisionIds.length ||
    facts.some((fact) => fact.sourceInstanceId !== initial.sourceInstanceId)
  ) {
    throw new PublicSourceSubscriptionStoreError("projection_conflict");
  }
  const matching = facts.filter((fact) => matchesFilter(initial, fact));
  const projectedAt = (input.projectedAt ?? new Date()).toISOString();
  let projectionsCreated = 0;
  let projectionsReused = 0;
  const projections: AuthorizedPublicSourceProjection[] = [];
  for (const fact of matching) {
    const projection = publicSourceProjectionSchema.parse({
      acquisitionId: acquisition.acquisitionId,
      factRevisionId: fact.revisionId,
      factSchemaVersion: fact.factSchemaVersion,
      monitorId: initial.monitorId,
      projectedAt,
      projectionId: `projection.${digestPublicSourceValue([
        initial.subscriptionId,
        fact.revisionId,
      ])}`,
      recordType: "public_source_fact_projection",
      schemaVersion: 1,
      sourceInstanceId: initial.sourceInstanceId,
      subscriptionId: initial.subscriptionId,
      workspaceId: input.scope.workspaceId,
    });
    const projectionKey = recordKey("projection", projection.projectionId, input.scope);
    const raw = serialize(projection);
    let durable = projection;
    if (await client.compareAndSet(projectionKey, null, raw)) {
      projectionsCreated += 1;
    } else {
      const existingRaw = rawValue(await client.get(projectionKey));
      if (existingRaw === null) {
        throw new PublicSourceSubscriptionStoreError("projection_conflict");
      }
      const existing = parseRaw(existingRaw, (value) => publicSourceProjectionSchema.parse(value));
      const { projectedAt: _existingAt, ...existingIdentity } = existing;
      const { projectedAt: _candidateAt, ...candidateIdentity } = projection;
      if (JSON.stringify(existingIdentity) !== JSON.stringify(candidateIdentity)) {
        throw new PublicSourceSubscriptionStoreError("projection_conflict");
      }
      durable = existing;
      projectionsReused += 1;
    }
    projections.push(Object.freeze({ fact, projection: durable }));
  }
  const replayed = initial.deliveryCursor.lastAcquisitionId === acquisition.acquisitionId;
  let subscription = initial;
  if (!replayed) {
    const next = publicSourceSubscriptionSchema.parse({
      ...initial,
      deliveryCursor: {
        lastAcquisitionId: acquisition.acquisitionId,
        revision: initial.deliveryCursor.revision + 1,
      },
    });
    if (await client.compareAndSet(key, initialRaw, serialize(next))) {
      subscription = next;
    } else {
      const current = await readPublicSourceSubscription(
        input.scope,
        input.subscriptionId,
        client,
      );
      if (current?.deliveryCursor.lastAcquisitionId !== acquisition.acquisitionId) {
        throw new PublicSourceSubscriptionStoreError("subscription_conflict");
      }
      subscription = current;
    }
  }
  return Object.freeze({
    projections: Object.freeze(projections),
    projectionsCreated,
    projectionsReused,
    replayed,
    subscription,
  });
}
