import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type { RevocableEvidenceStoreClient } from "./revocable-evidence-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const MAX_ATTEMPTS = 8;
const SHARD_COUNT = 32;
const MAX_ENTRIES_PER_SHARD = 512;
const MAX_CONSUMERS = 64;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 30 * DAY_MS;
const LEASE_MS = 10 * 60 * 1_000;
const timestampSchema = z.string().datetime({ offset: true });
const numericIdSchema = z.string().regex(/^\d{1,20}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const outcomeSchema = z.object({
  amountUsd: z.string().regex(/^(?:0|[1-9]\d*)\.\d{6}$/u),
  billablePostReads: z.number().int().min(0).max(2),
  canonicalAcquisitionId: z.string().min(3).max(200).nullable(),
  canonicalFactRevisionId: z.string().min(3).max(200).nullable(),
  correctionRequired: z.boolean(),
  lifecycle: z.enum(["deleted", "edited", "final", "protected", "provisional", "purged", "tombstoned", "unavailable", "withheld"]),
  observedAt: timestampSchema,
  outcomeId: digestSchema,
  sourceFactRevisionId: z.string().min(3).max(200),
}).strict();

const consumerSchema = z.object({
  acknowledgedOutcomeId: digestSchema.nullable(),
  scopeId: digestSchema,
}).strict();

const leaseSchema = z.object({
  expiresAt: timestampSchema,
  generation: z.number().int().positive(),
  token: z.string().uuid(),
}).strict();

const pendingRevisionSchema = z.object({
  editableUntil: timestampSchema,
  factRevisionId: z.string().min(3).max(200),
  nextCheckAt: timestampSchema,
  providerPostId: numericIdSchema,
}).strict();

const entrySchema = z.object({
  consumers: z.array(consumerSchema).max(MAX_CONSUMERS),
  editableUntil: timestampSchema,
  factRevisionId: z.string().min(3).max(200),
  generation: z.number().int().positive(),
  lease: leaseSchema.nullable(),
  nextCheckAt: timestampSchema,
  outcome: outcomeSchema.nullable(),
  pendingRevision: pendingRevisionSchema.nullable(),
  providerPostId: numericIdSchema,
  retentionExpiresAt: timestampSchema,
  stablePostId: numericIdSchema,
}).strict();

const indexSchema = z.object({
  entries: z.array(entrySchema).max(MAX_ENTRIES_PER_SHARD),
  recordType: z.literal("x_public_statement_rehydration_index"),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(2),
}).strict();

type Entry = z.infer<typeof entrySchema>;
export type XPublicStatementRehydrationOutcome = z.infer<typeof outcomeSchema>;
export type XPublicStatementRehydrationCandidate = Readonly<Entry & {
  disposition: "expire" | "fetch" | "replay";
  leaseToken: string | null;
}>;

function scopeId(scope: AuthorizedWorkspaceStoreScope): string {
  assertAuthorizedWorkspaceStoreScope(scope);
  return createHash("sha256")
    .update(`x-rehydration-scope\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
}

function shardFor(stablePostId: string): number {
  return Number(BigInt(stablePostId) % BigInt(SHARD_COUNT));
}

function indexKey(shard: number): string {
  if (!Number.isInteger(shard) || shard < 0 || shard >= SHARD_COUNT) {
    throw new Error("x_rehydration_shard_invalid");
  }
  return `revocable-rehydration:x:v2:${shard}`;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parse(value: string | null) {
  return value === null
    ? indexSchema.parse({
        entries: [],
        recordType: "x_public_statement_rehydration_index",
        revision: 0,
        schemaVersion: 2,
      })
    : indexSchema.parse(JSON.parse(value));
}

async function update<T>(
  client: RevocableEvidenceStoreClient,
  shard: number,
  mutate: (current: z.infer<typeof indexSchema>) => {
    readonly entries: readonly Entry[];
    readonly result: T;
  },
): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const key = indexKey(shard);
    const currentRaw = raw(await client.get(key));
    const current = parse(currentRaw);
    const mutation = mutate(current);
    const next = indexSchema.parse({
      ...current,
      entries: mutation.entries,
      revision: current.revision + 1,
    });
    if (await client.compareAndSet(key, currentRaw, JSON.stringify(next))) {
      return mutation.result;
    }
  }
  throw new Error("x_rehydration_index_conflict");
}

export async function trackXPublicStatementForRehydration(input: {
  readonly editableUntil: string;
  readonly factRevisionId: string;
  readonly lifecycle: "edited" | "final" | "provisional";
  readonly observedAt: string;
  readonly providerPostId: string;
  readonly stablePostId: string;
}, client: RevocableEvidenceStoreClient): Promise<void> {
  await update(client, shardFor(input.stablePostId), (current) => {
    const existing = current.entries.find(({ stablePostId }) => stablePostId === input.stablePostId);
    if (!existing && current.entries.length >= MAX_ENTRIES_PER_SHARD) {
      throw new Error("x_rehydration_capacity_exceeded");
    }
    const changed = !existing || existing.factRevisionId !== input.factRevisionId ||
      existing.providerPostId !== input.providerPostId;
    const nextCheckAt = input.lifecycle === "provisional"
      ? new Date(Math.max(Date.parse(input.editableUntil), Date.parse(input.observedAt))).toISOString()
      : new Date(Date.parse(input.observedAt) + DAY_MS).toISOString();
    const pendingRevision = Object.freeze({
      editableUntil: input.editableUntil,
      factRevisionId: input.factRevisionId,
      nextCheckAt,
      providerPostId: input.providerPostId,
    });
    const outcomePending = existing?.outcome !== null && existing?.outcome !== undefined &&
      existing.consumers.some(({ acknowledgedOutcomeId }) =>
        acknowledgedOutcomeId !== existing.outcome!.outcomeId);
    const candidate = entrySchema.parse(outcomePending && changed ? {
      ...existing,
      pendingRevision,
    } : {
      consumers: existing?.consumers ?? [],
      editableUntil: input.editableUntil,
      factRevisionId: input.factRevisionId,
      generation: changed ? (existing?.generation ?? 0) + 1 : existing!.generation,
      lease: changed ? null : existing!.lease,
      nextCheckAt: existing && existing.nextCheckAt < nextCheckAt
        ? existing.nextCheckAt
        : nextCheckAt,
      outcome: changed ? null : existing?.outcome ?? null,
      pendingRevision: null,
      providerPostId: input.providerPostId,
      retentionExpiresAt: existing?.retentionExpiresAt ??
        new Date(Date.parse(input.observedAt) + RETENTION_MS).toISOString(),
      stablePostId: input.stablePostId,
    });
    return {
      entries: [
        ...current.entries.filter(({ stablePostId }) => stablePostId !== candidate.stablePostId),
        candidate,
      ].sort((left, right) => left.nextCheckAt.localeCompare(right.nextCheckAt)),
      result: undefined,
    };
  });
}

export async function registerWorkspaceXPublicStatementForRehydration(input: {
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly stablePostId: string;
}, client: RevocableEvidenceStoreClient): Promise<void> {
  const consumerId = scopeId(input.scope);
  await update(client, shardFor(input.stablePostId), (current) => {
    const entry = current.entries.find(({ stablePostId }) => stablePostId === input.stablePostId);
    if (!entry) throw new Error("x_rehydration_candidate_missing");
    if (entry.consumers.some(({ scopeId: id }) => id === consumerId)) {
      return { entries: current.entries, result: undefined };
    }
    if (entry.consumers.length >= MAX_CONSUMERS) {
      throw new Error("x_rehydration_consumer_capacity_exceeded");
    }
    return {
      entries: current.entries.map((candidate) => candidate.stablePostId === entry.stablePostId
        ? entrySchema.parse({
            ...candidate,
            consumers: [...candidate.consumers, {
              acknowledgedOutcomeId: null,
              scopeId: consumerId,
            }],
          })
        : candidate),
      result: undefined,
    };
  });
}

export async function claimDueXPublicStatementsForRehydration(input: {
  readonly limit?: number;
  readonly now: Date;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, client: RevocableEvidenceStoreClient): Promise<readonly XPublicStatementRehydrationCandidate[]> {
  const consumerId = scopeId(input.scope);
  const limit = Math.min(8, Math.max(1, input.limit ?? 8));
  const selected: XPublicStatementRehydrationCandidate[] = [];
  const startShard = Math.floor(input.now.getTime() / DAY_MS) % SHARD_COUNT;
  for (let offset = 0; offset < SHARD_COUNT && selected.length < limit; offset += 1) {
    const shard = (startShard + offset) % SHARD_COUNT;
    const claimed = await update(client, shard, (current) => {
      const now = input.now.toISOString();
      const shardSelected: XPublicStatementRehydrationCandidate[] = [];
      const entries = current.entries.map((entry) => {
      const consumer = entry.consumers.find(({ scopeId: id }) => id === consumerId);
      if (!consumer || selected.length + shardSelected.length >= limit) return entry;
      if (entry.outcome && consumer.acknowledgedOutcomeId !== entry.outcome.outcomeId) {
        shardSelected.push(Object.freeze({ ...entry, disposition: "replay", leaseToken: null }));
        return entry;
      }
      if (
        entry.outcome &&
        entry.consumers.some(({ acknowledgedOutcomeId }) => acknowledgedOutcomeId !== entry.outcome!.outcomeId)
      ) return entry;
      if (entry.retentionExpiresAt <= now) {
        const token = randomUUID();
        const leased = entrySchema.parse({
          ...entry,
          lease: { expiresAt: new Date(input.now.getTime() + LEASE_MS).toISOString(), generation: entry.generation, token },
        });
        shardSelected.push(Object.freeze({ ...leased, disposition: "expire", leaseToken: token }));
        return leased;
      }
      if (entry.nextCheckAt > now || entry.lease && entry.lease.expiresAt > now) return entry;
      const token = randomUUID();
      const leased = entrySchema.parse({
        ...entry,
        lease: { expiresAt: new Date(input.now.getTime() + LEASE_MS).toISOString(), generation: entry.generation, token },
      });
      shardSelected.push(Object.freeze({ ...leased, disposition: "fetch", leaseToken: token }));
      return leased;
    });
      return { entries, result: Object.freeze(shardSelected) };
    });
    selected.push(...claimed);
  }
  return Object.freeze(selected);
}

export async function completeXPublicStatementRehydration(input: {
  readonly amountUsd: string;
  readonly billablePostReads: number;
  readonly candidate: XPublicStatementRehydrationCandidate;
  readonly canonicalAcquisitionId?: string;
  readonly canonicalFactRevisionId?: string;
  readonly correctionRequired: boolean;
  readonly lifecycle: XPublicStatementRehydrationOutcome["lifecycle"];
  readonly now: Date;
  readonly replacementFactRevisionId?: string;
  readonly replacementProviderPostId?: string;
}, client: RevocableEvidenceStoreClient): Promise<XPublicStatementRehydrationOutcome> {
  if (!input.candidate.leaseToken) throw new Error("x_rehydration_claim_invalid");
  return update(client, shardFor(input.candidate.stablePostId), (current) => {
    const existing = current.entries.find(({ stablePostId }) =>
      stablePostId === input.candidate.stablePostId);
    if (
      !existing || existing.lease?.token !== input.candidate.leaseToken ||
      existing.lease.generation !== input.candidate.generation ||
      existing.generation !== input.candidate.generation
    ) throw new Error("x_rehydration_claim_stale");
    const outcome = outcomeSchema.parse({
      amountUsd: input.amountUsd,
      billablePostReads: input.billablePostReads,
      canonicalAcquisitionId: input.canonicalAcquisitionId ?? null,
      canonicalFactRevisionId: input.canonicalFactRevisionId ?? null,
      correctionRequired: input.correctionRequired,
      lifecycle: input.lifecycle,
      observedAt: input.now.toISOString(),
      outcomeId: createHash("sha256").update(JSON.stringify([
        existing.stablePostId,
        existing.generation,
        input.lifecycle,
        input.now.toISOString(),
        input.canonicalFactRevisionId ?? null,
      ])).digest("hex"),
      sourceFactRevisionId: existing.factRevisionId,
    });
    const terminal = ["deleted", "protected", "purged", "tombstoned", "withheld"].includes(input.lifecycle);
    const next = entrySchema.parse({
      ...existing,
      factRevisionId: input.replacementFactRevisionId ?? existing.factRevisionId,
      generation: input.replacementFactRevisionId || input.replacementProviderPostId
        ? existing.generation + 1
        : existing.generation,
      lease: null,
      nextCheckAt: terminal
        ? existing.nextCheckAt
        : new Date(input.lifecycle === "provisional"
            ? Math.max(Date.parse(existing.editableUntil), input.now.getTime() + LEASE_MS)
            : input.now.getTime() + DAY_MS).toISOString(),
      outcome,
      pendingRevision: existing.pendingRevision,
      providerPostId: input.replacementProviderPostId ?? existing.providerPostId,
    });
    return {
      entries: current.entries.map((entry) => entry.stablePostId === existing.stablePostId ? next : entry),
      result: outcome,
    };
  });
}

export async function deferXPublicStatementRehydration(input: {
  readonly candidate: XPublicStatementRehydrationCandidate;
  readonly now: Date;
}, client: RevocableEvidenceStoreClient): Promise<void> {
  if (!input.candidate.leaseToken) throw new Error("x_rehydration_claim_invalid");
  await update(client, shardFor(input.candidate.stablePostId), (current) => {
    const existing = current.entries.find(({ stablePostId }) =>
      stablePostId === input.candidate.stablePostId);
    if (
      !existing || existing.lease?.token !== input.candidate.leaseToken ||
      existing.lease.generation !== input.candidate.generation ||
      existing.generation !== input.candidate.generation
    ) throw new Error("x_rehydration_claim_stale");
    return {
      entries: current.entries.map((entry) => entry.stablePostId === existing.stablePostId
        ? entrySchema.parse({
            ...entry,
            lease: null,
            nextCheckAt: new Date(input.now.getTime() + LEASE_MS).toISOString(),
            outcome: null,
          })
        : entry),
      result: undefined,
    };
  });
}

export async function acknowledgeXPublicStatementRehydration(input: {
  readonly outcomeId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly stablePostId: string;
}, client: RevocableEvidenceStoreClient): Promise<void> {
  const consumerId = scopeId(input.scope);
  await update(client, shardFor(input.stablePostId), (current) => {
    const existing = current.entries.find(({ stablePostId }) => stablePostId === input.stablePostId);
    if (!existing || existing.outcome?.outcomeId !== input.outcomeId) {
      throw new Error("x_rehydration_outcome_stale");
    }
    const consumers = existing.consumers.map((consumer) => consumer.scopeId === consumerId
      ? consumerSchema.parse({ ...consumer, acknowledgedOutcomeId: input.outcomeId })
      : consumer);
    if (!consumers.some(({ scopeId: id }) => id === consumerId)) {
      throw new Error("x_rehydration_consumer_missing");
    }
    const terminal = ["deleted", "protected", "purged", "tombstoned", "withheld"].includes(existing.outcome.lifecycle);
    const allAcknowledged = consumers.every(({ acknowledgedOutcomeId }) => acknowledgedOutcomeId === input.outcomeId);
    const pending = allAcknowledged ? existing.pendingRevision : null;
    const advanced = pending ? entrySchema.parse({
      ...existing,
      consumers: consumers.map((consumer) => consumerSchema.parse({
        ...consumer,
        acknowledgedOutcomeId: null,
      })),
      editableUntil: pending.editableUntil,
      factRevisionId: pending.factRevisionId,
      generation: existing.generation + 1,
      lease: null,
      nextCheckAt: pending.nextCheckAt,
      outcome: null,
      pendingRevision: null,
      providerPostId: pending.providerPostId,
    }) : null;
    return {
      entries: terminal && allAcknowledged && !advanced
        ? current.entries.filter(({ stablePostId }) => stablePostId !== existing.stablePostId)
        : current.entries.map((entry) => entry.stablePostId === existing.stablePostId
            ? advanced ?? entrySchema.parse({ ...entry, consumers })
            : entry),
      result: undefined,
    };
  });
}
