import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalPublicFactRevisionSchema,
  publicSourceCorrectionSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceCorrection,
} from "./public-source-adapter-schema";
import type { RevocableEvidenceStoreClient } from "./revocable-evidence-store";

const MAX_ITEMS = 500;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z.string().min(3).max(200);
const itemSchema = z.object({
  correctionId: identifierSchema.nullable(),
  factRevisionId: identifierSchema,
  recordDigest: digestSchema,
}).strict();
const indexSchema = z.object({
  excludeReplies: z.boolean().optional(),
  expectedCursorRevision: z.number().int().nonnegative(),
  firstRunStartAt: z.string().datetime({ offset: true }).nullable().optional(),
  items: z.array(itemSchema).max(MAX_ITEMS),
  nextToken: z.string().min(1).max(500),
  pagesRead: z.number().int().positive().max(500),
  postsRead: z.number().int().nonnegative().max(50_000),
  recordType: z.literal("x_public_statement_pagination_continuation"),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
  sourceInstanceId: identifierSchema,
}).strict();
const recordSchema = z.object({
  correction: publicSourceCorrectionSchema.nullable(),
  fact: canonicalPublicFactRevisionSchema,
  recordType: z.literal("x_public_statement_pagination_item"),
  schemaVersion: z.literal(1),
}).strict();

export type XPublicStatementPaginationContinuation = z.infer<typeof indexSchema>;
export interface XPublicStatementPaginationItem {
  readonly correction: PublicSourceCorrection | null;
  readonly fact: CanonicalPublicFactRevision;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function indexKey(sourceInstanceId: string): string {
  return `x-pagination:v1:index:${digest(sourceInstanceId)}`;
}

function itemKey(sourceInstanceId: string, factRevisionId: string): string {
  return `x-pagination:v1:item:${digest([sourceInstanceId, factRevisionId])}`;
}

function raw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export async function readXPublicStatementPaginationContinuation(
  sourceInstanceId: string,
  client: RevocableEvidenceStoreClient,
): Promise<XPublicStatementPaginationContinuation | null> {
  const value = raw(await client.get(indexKey(sourceInstanceId)));
  return value === null ? null : indexSchema.parse(JSON.parse(value));
}

export async function readXPublicStatementPaginationItems(
  continuation: XPublicStatementPaginationContinuation,
  client: RevocableEvidenceStoreClient,
): Promise<readonly XPublicStatementPaginationItem[]> {
  return Object.freeze(await Promise.all(continuation.items.map(async (item) => {
    const value = raw(await client.get(itemKey(continuation.sourceInstanceId, item.factRevisionId)));
    if (value === null || digest(JSON.parse(value)) !== item.recordDigest) {
      throw new Error("x_pagination_continuation_corrupt");
    }
    return recordSchema.parse(JSON.parse(value));
  })));
}

export async function appendXPublicStatementPaginationContinuation(input: {
  readonly excludeReplies?: boolean;
  readonly expectedCursorRevision: number;
  readonly firstRunStartAt?: string | null;
  readonly items: readonly XPublicStatementPaginationItem[];
  readonly nextToken: string;
  readonly pagesRead: number;
  readonly postsRead: number;
  readonly sourceInstanceId: string;
}, client: RevocableEvidenceStoreClient): Promise<XPublicStatementPaginationContinuation> {
  const key = indexKey(input.sourceInstanceId);
  for (let offset = 0; offset < input.items.length; offset += 8) {
    await Promise.all(input.items.slice(offset, offset + 8).map(async (item) => {
      const record = recordSchema.parse({ ...item, recordType: "x_public_statement_pagination_item", schemaVersion: 1 });
      const serialized = JSON.stringify(record);
      const recordKey = itemKey(input.sourceInstanceId, record.fact.revisionId);
      if (!(await client.compareAndSet(recordKey, null, serialized)) && raw(await client.get(recordKey)) !== serialized) {
        throw new Error("x_pagination_continuation_conflict");
      }
    }));
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const currentRaw = raw(await client.get(key));
    const current = currentRaw === null ? null : indexSchema.parse(JSON.parse(currentRaw));
    if (current && current.expectedCursorRevision !== input.expectedCursorRevision) {
      throw new Error("x_pagination_continuation_stale");
    }
    if (current && (current.firstRunStartAt ?? null) !== (input.firstRunStartAt ?? null)) {
      throw new Error("x_pagination_continuation_conflict");
    }
    if (current && (current.excludeReplies ?? false) !== (input.excludeReplies ?? false)) {
      throw new Error("x_pagination_continuation_conflict");
    }
    const byRevision = new Map((current?.items ?? []).map((item) => [item.factRevisionId, item]));
    for (const item of input.items) {
      const record = recordSchema.parse({ ...item, recordType: "x_public_statement_pagination_item", schemaVersion: 1 });
      const reference = itemSchema.parse({
        correctionId: record.correction?.correctionId ?? null,
        factRevisionId: record.fact.revisionId,
        recordDigest: digest(record),
      });
      const existing = byRevision.get(reference.factRevisionId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(reference)) {
        throw new Error("x_pagination_continuation_conflict");
      }
      byRevision.set(reference.factRevisionId, reference);
    }
    const next = indexSchema.parse({
      expectedCursorRevision: input.expectedCursorRevision,
      excludeReplies: input.excludeReplies ?? false,
      firstRunStartAt: input.firstRunStartAt ?? null,
      items: [...byRevision.values()],
      nextToken: input.nextToken,
      pagesRead: (current?.pagesRead ?? 0) + input.pagesRead,
      postsRead: (current?.postsRead ?? 0) + input.postsRead,
      recordType: "x_public_statement_pagination_continuation",
      revision: (current?.revision ?? 0) + 1,
      schemaVersion: 1,
      sourceInstanceId: input.sourceInstanceId,
    });
    if (await client.compareAndSet(key, currentRaw, JSON.stringify(next))) return next;
  }
  throw new Error("x_pagination_continuation_conflict");
}

export async function clearXPublicStatementPaginationContinuation(
  continuation: XPublicStatementPaginationContinuation,
  client: RevocableEvidenceStoreClient,
): Promise<void> {
  for (let offset = 0; offset < continuation.items.length; offset += 8) {
    await Promise.all(continuation.items.slice(offset, offset + 8).map((item) =>
      client.delete(itemKey(continuation.sourceInstanceId, item.factRevisionId))));
  }
  await client.delete(indexKey(continuation.sourceInstanceId));
}
