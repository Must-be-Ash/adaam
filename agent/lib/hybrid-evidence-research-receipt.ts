import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import type { BoundedPublicResearchDocument } from "./hybrid-evidence-research";
import { normalizeHybridEvidenceResearchUrl } from "./hybrid-evidence-research";
import {
  digestHybridEvidenceValue,
} from "./hybrid-evidence-schema";
import {
  webCorroborationSearchSchema,
  type WebCorroborationSearch,
} from "./public-commentary-schema";
import type { WebCorroborationProvider, WebCorroborationQuery } from "./web-corroboration-search";
import {
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  WorkspaceBudgetError,
  type WorkspaceBudgetLedgerClient,
} from "./workspace-budget-ledger";
import type { WorkspaceBudgetPolicyValue } from "./workspace-state-store";
import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:hybrid-evidence:v1:research-attempt:";
const MAX_CAS_ATTEMPTS = 8;
const MAX_RECORD_BYTES = 96 * 1_024;
const WAIT_FOR_OWNER_MS = 12_000;
const POLL_INTERVAL_MS = 100;
const EXA_RESERVED_COST_USD = "0.010000";
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

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const microsSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const publicDocumentSchema = z.object({
  byteCount: z.number().int().nonnegative().max(64 * 1_024),
  content: z.string().max(64 * 1_024),
  contentType: z.string().min(1).max(100),
  url: z.string().url().max(2_048),
}).strict();
const resultSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("exa_search"),
    value: webCorroborationSearchSchema,
  }).strict(),
  z.object({
    operation: z.literal("public_document_fetch"),
    value: publicDocumentSchema,
  }).strict(),
]);
const receiptSchema = z.object({
  actualPaidMicros: microsSchema.nullable(),
  attemptId: z.string().min(1).max(160),
  budgetReservationRunId: z.string().min(1).max(160).nullable(),
  claimTokenDigest: digestSchema,
  createdAt: z.string().datetime({ offset: true }),
  jobId: z.string().min(1).max(200),
  operation: z.enum(["exa_search", "public_document_fetch"]),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  parentRunId: z.string().min(1).max(160),
  providerRequestId: z.string().min(1).max(200).nullable(),
  recordType: z.literal("hybrid_evidence_research_attempt"),
  requestDigest: digestSchema,
  reservedPaidMicros: microsSchema,
  result: resultSchema.nullable(),
  resultDigest: digestSchema.nullable(),
  schemaVersion: z.literal(1),
  state: z.enum(["claimed", "executing", "settled", "uncertain", "denied"]),
  updatedAt: z.string().datetime({ offset: true }),
  workspaceId: z.string().uuid(),
}).strict();

export type HybridEvidenceResearchAttemptReceipt = Readonly<
  z.infer<typeof receiptSchema>
>;
export type HybridEvidenceResearchOperation =
  HybridEvidenceResearchAttemptReceipt["operation"];

export interface HybridEvidenceResearchAttemptStoreClient {
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
  ): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class HybridEvidenceResearchAttemptError extends Error {
  constructor(readonly code:
    | "research_attempt_conflict"
    | "research_attempt_in_progress"
    | "research_budget_denied"
    | "research_completion_uncertain"
    | "research_receipt_corrupt") {
    super(code);
    this.name = "HybridEvidenceResearchAttemptError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: HybridEvidenceResearchAttemptStoreClient | undefined;

function store(): HybridEvidenceResearchAttemptStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
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
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
          throw error;
        }
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

function parseReceipt(raw: string | null): HybridEvidenceResearchAttemptReceipt | null {
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
  try {
    return Object.freeze(receiptSchema.parse(JSON.parse(raw)));
  } catch {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
}

function serialize(receipt: HybridEvidenceResearchAttemptReceipt): string {
  const parsed = receiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
  const raw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
  return raw;
}

function attemptIdentity(input: {
  jobId: string;
  operation: HybridEvidenceResearchOperation;
  parentRunId: string;
  requestDigest: string;
  scope: AuthorizedWorkspaceStoreScope;
}): string {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const digest = createHash("sha256").update([
    "hybrid-evidence-research-attempt-v1",
    input.scope.ownerId,
    input.scope.workspaceId,
    input.parentRunId,
    input.jobId,
    input.operation,
  ].join("\0")).digest("hex");
  return `hybrid-research.${digest}`;
}

function receiptKey(attemptId: string): string {
  return `${KEY_PREFIX}${createHash("sha256").update(attemptId).digest("hex")}`;
}

function claimDigest(claimToken: string): string {
  return createHash("sha256").update(claimToken).digest("hex");
}

async function updateReceipt<T>(input: {
  attemptId: string;
  client: HybridEvidenceResearchAttemptStoreClient;
  mutate: (receipt: HybridEvidenceResearchAttemptReceipt | null) => {
    receipt: HybridEvidenceResearchAttemptReceipt;
    result: T;
  };
}): Promise<T> {
  const key = receiptKey(input.attemptId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await input.client.get(key));
    const mutation = input.mutate(parseReceipt(currentRaw));
    if (await input.client.compareAndSet(
      key,
      currentRaw,
      serialize(mutation.receipt),
    )) return mutation.result;
  }
  throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
}

function sameIdentity(
  receipt: HybridEvidenceResearchAttemptReceipt,
  input: {
    attemptId: string;
    jobId: string;
    operation: HybridEvidenceResearchOperation;
    parentRunId: string;
    requestDigest: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
): boolean {
  return receipt.attemptId === input.attemptId &&
    receipt.jobId === input.jobId &&
    receipt.operation === input.operation &&
    receipt.ownerId === input.scope.ownerId &&
    receipt.parentRunId === input.parentRunId &&
    receipt.requestDigest === input.requestDigest &&
    receipt.workspaceId === input.scope.workspaceId;
}

async function claimAttempt(input: {
  claimToken: string;
  jobId: string;
  now: Date;
  operation: HybridEvidenceResearchOperation;
  parentRunId: string;
  requestDigest: string;
  reservedPaidMicros: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: HybridEvidenceResearchAttemptStoreClient) {
  const attemptId = attemptIdentity(input);
  const tokenDigest = claimDigest(input.claimToken);
  const timestamp = input.now.toISOString();
  const receipt = await updateReceipt({
    attemptId,
    client,
    mutate(current) {
      if (current) {
        if (!sameIdentity(current, { ...input, attemptId })) {
          throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
        }
        return { receipt: current, result: current };
      }
      const created = receiptSchema.parse({
        actualPaidMicros: null,
        attemptId,
        budgetReservationRunId: input.operation === "exa_search" ? attemptId : null,
        claimTokenDigest: tokenDigest,
        createdAt: timestamp,
        jobId: input.jobId,
        operation: input.operation,
        ownerId: input.scope.ownerId,
        parentRunId: input.parentRunId,
        providerRequestId: null,
        recordType: "hybrid_evidence_research_attempt",
        requestDigest: input.requestDigest,
        reservedPaidMicros: input.reservedPaidMicros,
        result: null,
        resultDigest: null,
        schemaVersion: 1,
        state: "claimed",
        updatedAt: timestamp,
        workspaceId: input.scope.workspaceId,
      });
      return { receipt: created, result: created };
    },
  });
  return { attemptId, receipt, tokenDigest };
}

async function beginAttempt(input: {
  attemptId: string;
  now: Date;
  tokenDigest: string;
}, client: HybridEvidenceResearchAttemptStoreClient): Promise<boolean> {
  return updateReceipt({
    attemptId: input.attemptId,
    client,
    mutate(current) {
      if (!current) {
        throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
      }
      if (current.state !== "claimed") {
        return { receipt: current, result: false };
      }
      if (current.claimTokenDigest !== input.tokenDigest) {
        return { receipt: current, result: false };
      }
      const executing = receiptSchema.parse({
        ...current,
        state: "executing",
        updatedAt: input.now.toISOString(),
      });
      return { receipt: executing, result: true };
    },
  });
}

async function finishAttempt(input: {
  actualPaidMicros: string | null;
  attemptId: string;
  now: Date;
  providerRequestId: string | null;
  result: z.infer<typeof resultSchema> | null;
  state: "denied" | "settled" | "uncertain";
}, client: HybridEvidenceResearchAttemptStoreClient) {
  const result = input.result === null ? null : resultSchema.parse(input.result);
  const resultDigest = result === null ? null : digestHybridEvidenceValue(result);
  return updateReceipt({
    attemptId: input.attemptId,
    client,
    mutate(current) {
      if (!current) {
        throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
      }
      if (current.state === input.state) {
        if (
          current.actualPaidMicros !== input.actualPaidMicros ||
          current.providerRequestId !== input.providerRequestId ||
          current.resultDigest !== resultDigest
        ) {
          throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
        }
        return { receipt: current, result: current };
      }
      if (
        (input.state === "denied" && current.state !== "claimed") ||
        (input.state !== "denied" && current.state !== "executing")
      ) {
        throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
      }
      const finished = receiptSchema.parse({
        ...current,
        actualPaidMicros: input.actualPaidMicros,
        providerRequestId: input.providerRequestId,
        result,
        resultDigest,
        state: input.state,
        updatedAt: input.now.toISOString(),
      });
      return { receipt: finished, result: finished };
    },
  });
}

function microsToUsd(micros: string): string {
  const value = BigInt(micros);
  return `${value / 1_000_000n}.${(value % 1_000_000n)
    .toString()
    .padStart(6, "0")}`;
}

function usdToMicros(value: string): string {
  const match = /^(?<whole>0|[1-9]\d*)(?:\.(?<fraction>\d{1,6}))?$/u.exec(value);
  if (!match?.groups) {
    throw new HybridEvidenceResearchAttemptError("research_receipt_corrupt");
  }
  return (
    BigInt(match.groups.whole!) * 1_000_000n +
    BigInt((match.groups.fraction ?? "").padEnd(6, "0"))
  ).toString();
}

async function waitForTerminal(input: {
  attemptId: string;
  client: HybridEvidenceResearchAttemptStoreClient;
  signal?: AbortSignal;
}): Promise<HybridEvidenceResearchAttemptReceipt> {
  const deadline = Date.now() + WAIT_FOR_OWNER_MS;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw input.signal.reason;
    const receipt = parseReceipt(rawValue(await input.client.get(receiptKey(input.attemptId))));
    if (!receipt) {
      throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
    }
    if (["settled", "uncertain", "denied"].includes(receipt.state)) return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new HybridEvidenceResearchAttemptError("research_attempt_in_progress");
}

function terminalError(receipt: HybridEvidenceResearchAttemptReceipt): never {
  throw new HybridEvidenceResearchAttemptError(
    receipt.state === "denied"
      ? "research_budget_denied"
      : "research_completion_uncertain",
  );
}

function exaResult(receipt: HybridEvidenceResearchAttemptReceipt): WebCorroborationSearch {
  if (receipt.state !== "settled" || receipt.result?.operation !== "exa_search") {
    return terminalError(receipt);
  }
  return webCorroborationSearchSchema.parse(receipt.result.value);
}

async function reconcileExaReceipt(input: {
  budget?: WorkspaceBudgetLedgerClient;
  receipt: HybridEvidenceResearchAttemptReceipt;
  scope: AuthorizedWorkspaceStoreScope;
}): Promise<WebCorroborationSearch> {
  if (input.receipt.state === "uncertain") {
    await reconcileWorkspaceRunBudget({
      outcome: "uncertain",
      runId: input.receipt.attemptId,
      scope: input.scope,
    }, input.budget);
    return terminalError(input.receipt);
  }
  const result = exaResult(input.receipt);
  await reconcileWorkspaceRunBudget({
    actualPaidCost: result.cost.amountUsd,
    outcome: result.status === "not_run" ? "released" : "reconciled",
    runId: input.receipt.attemptId,
    scope: input.scope,
  }, input.budget);
  return result;
}

function documentResult(
  receipt: HybridEvidenceResearchAttemptReceipt,
): BoundedPublicResearchDocument {
  if (
    receipt.state !== "settled" ||
    receipt.result?.operation !== "public_document_fetch"
  ) return terminalError(receipt);
  return Object.freeze(publicDocumentSchema.parse(receipt.result.value));
}

export async function readHybridEvidenceResearchAttemptReceipt(input: {
  jobId: string;
  operation: HybridEvidenceResearchOperation;
  parentRunId: string;
  requestDigest: string;
  scope: AuthorizedWorkspaceStoreScope;
}, client: HybridEvidenceResearchAttemptStoreClient = store()) {
  const attemptId = attemptIdentity(input);
  const receipt = parseReceipt(rawValue(await client.get(receiptKey(attemptId))));
  if (receipt && !sameIdentity(receipt, { ...input, attemptId })) {
    throw new HybridEvidenceResearchAttemptError("research_attempt_conflict");
  }
  return receipt;
}

export async function executeReplaySafeExaResearch(input: {
  budget: {
    policy: WorkspaceBudgetPolicyValue;
    policyRevision: number;
  };
  claimToken: string;
  clients?: {
    budget?: WorkspaceBudgetLedgerClient;
    receipts?: HybridEvidenceResearchAttemptStoreClient;
  };
  jobId: string;
  now?: Date;
  parentRunId: string;
  provider: WebCorroborationProvider;
  query: WebCorroborationQuery;
  scope: AuthorizedWorkspaceStoreScope;
  signal?: AbortSignal;
}): Promise<WebCorroborationSearch> {
  const now = input.now ?? new Date();
  const receiptClient = input.clients?.receipts ?? store();
  const reservedPaidMicros = usdToMicros(EXA_RESERVED_COST_USD);
  const claimed = await claimAttempt({
    claimToken: input.claimToken,
    jobId: input.jobId,
    now,
    operation: "exa_search",
    parentRunId: input.parentRunId,
    requestDigest: input.query.queryDigest,
    reservedPaidMicros,
    scope: input.scope,
  }, receiptClient);
  if (claimed.receipt.state === "settled") {
    return reconcileExaReceipt({
      budget: input.clients?.budget,
      receipt: claimed.receipt,
      scope: input.scope,
    });
  }
  if (claimed.receipt.state === "uncertain" || claimed.receipt.state === "denied") {
    if (claimed.receipt.state === "uncertain") {
      await reconcileWorkspaceRunBudget({
        outcome: "uncertain",
        runId: claimed.attemptId,
        scope: input.scope,
      }, input.clients?.budget);
    }
    return terminalError(claimed.receipt);
  }
  try {
    await reserveWorkspaceRunBudget({
      inputTokens: 0,
      kind: "paid_source_attempt",
      now,
      outputTokens: 0,
      paidCostCeiling: { amount: EXA_RESERVED_COST_USD, kind: "known" },
      parentRunId: input.parentRunId,
      policy: input.budget.policy,
      policyRevision: input.budget.policyRevision,
      runId: claimed.attemptId,
      scope: input.scope,
    }, input.clients?.budget);
  } catch (error) {
    if (!(error instanceof WorkspaceBudgetError) || error.code !== "budget_exhausted") {
      throw error;
    }
    const denied = await finishAttempt({
      actualPaidMicros: null,
      attemptId: claimed.attemptId,
      now,
      providerRequestId: null,
      result: null,
      state: "denied",
    }, receiptClient);
    return terminalError(denied);
  }
  if (!await beginAttempt({
    attemptId: claimed.attemptId,
    now,
    tokenDigest: claimed.tokenDigest,
  }, receiptClient)) {
    const terminal = await waitForTerminal({
      attemptId: claimed.attemptId,
      client: receiptClient,
      signal: input.signal,
    });
    return reconcileExaReceipt({
      budget: input.clients?.budget,
      receipt: terminal,
      scope: input.scope,
    });
  }
  let result: WebCorroborationSearch;
  try {
    result = webCorroborationSearchSchema.parse(await input.provider.search({
      budgetAuthorized: true,
      enabled: true,
      now,
      query: input.query,
      signal: input.signal,
    }));
  } catch (error) {
    await finishAttempt({
      actualPaidMicros: null,
      attemptId: claimed.attemptId,
      now,
      providerRequestId: null,
      result: null,
      state: "uncertain",
    }, receiptClient);
    await reconcileWorkspaceRunBudget({
      outcome: "uncertain",
      runId: claimed.attemptId,
      scope: input.scope,
    }, input.clients?.budget);
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    throw new HybridEvidenceResearchAttemptError("research_completion_uncertain");
  }
  const actualPaidMicros = usdToMicros(result.cost.amountUsd);
  const settled = await finishAttempt({
    actualPaidMicros,
    attemptId: claimed.attemptId,
    now,
    providerRequestId: result.requestId,
    result: { operation: "exa_search", value: result },
    state: "settled",
  }, receiptClient);
  await reconcileWorkspaceRunBudget({
    actualPaidCost: microsToUsd(actualPaidMicros),
    outcome: result.status === "not_run" ? "released" : "reconciled",
    runId: claimed.attemptId,
    scope: input.scope,
  }, input.clients?.budget);
  return exaResult(settled);
}

export async function executeReplaySafePublicDocumentResearch(input: {
  allowedUrls: readonly string[];
  claimToken: string;
  clients?: { receipts?: HybridEvidenceResearchAttemptStoreClient };
  fetchDocument: (input: {
    allowedUrls: readonly string[];
    signal?: AbortSignal;
    url: string;
  }) => Promise<BoundedPublicResearchDocument>;
  jobId: string;
  now?: Date;
  parentRunId: string;
  scope: AuthorizedWorkspaceStoreScope;
  signal?: AbortSignal;
  url: string;
}): Promise<BoundedPublicResearchDocument> {
  const now = input.now ?? new Date();
  const receiptClient = input.clients?.receipts ?? store();
  const url = normalizeHybridEvidenceResearchUrl(input.url);
  const requestDigest = digestHybridEvidenceValue({ url });
  const claimed = await claimAttempt({
    claimToken: input.claimToken,
    jobId: input.jobId,
    now,
    operation: "public_document_fetch",
    parentRunId: input.parentRunId,
    requestDigest,
    reservedPaidMicros: "0",
    scope: input.scope,
  }, receiptClient);
  if (claimed.receipt.state === "settled") return documentResult(claimed.receipt);
  if (claimed.receipt.state === "uncertain" || claimed.receipt.state === "denied") {
    return terminalError(claimed.receipt);
  }
  if (!await beginAttempt({
    attemptId: claimed.attemptId,
    now,
    tokenDigest: claimed.tokenDigest,
  }, receiptClient)) {
    return documentResult(await waitForTerminal({
      attemptId: claimed.attemptId,
      client: receiptClient,
      signal: input.signal,
    }));
  }
  let result: BoundedPublicResearchDocument;
  try {
    result = publicDocumentSchema.parse(await input.fetchDocument({
      allowedUrls: input.allowedUrls,
      signal: input.signal,
      url,
    }));
  } catch (error) {
    await finishAttempt({
      actualPaidMicros: null,
      attemptId: claimed.attemptId,
      now,
      providerRequestId: null,
      result: null,
      state: "uncertain",
    }, receiptClient);
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    throw new HybridEvidenceResearchAttemptError("research_completion_uncertain");
  }
  const settled = await finishAttempt({
    actualPaidMicros: "0",
    attemptId: claimed.attemptId,
    now,
    providerRequestId: claimed.attemptId,
    result: { operation: "public_document_fetch", value: result },
    state: "settled",
  }, receiptClient);
  return documentResult(settled);
}
