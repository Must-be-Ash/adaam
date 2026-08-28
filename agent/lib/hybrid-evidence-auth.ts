import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Redis } from "@upstash/redis";
import type { SessionAuthContext, SessionContext } from "eve/context";
import { z } from "zod";

import {
  evidenceLocatorSchema,
  hybridEvidenceScopeSchema,
  type EvidenceLocator,
  type HybridEvidenceJob,
} from "./hybrid-evidence-schema";
import type { HybridEvidenceBudgetReservation } from "./hybrid-evidence-budget";
import { normalizeHybridEvidenceResearchUrl } from "./hybrid-evidence-research";
import { resolveHybridEvidenceWorkerContract } from "./hybrid-evidence-worker-contract-registry";
import { fixtureRuntimeAllowed as hybridEvidenceWorkerFixtureRuntimeAllowed } from "./hybrid-evidence-worker-test-fixtures";
import {
  HYBRID_MODEL_REASONING_VALUES,
  type HybridModelReasoning,
} from "./hybrid-evidence-model-routing";

export const HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SESSION_CAPABILITY_PREFIX = "eve:hybrid-evidence:v1:session-capability:";
const SESSION_CAPABILITY_TTL_SECONDS = 20 * 60;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,}$/u;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const envelopeSchema = z.object({
  allowedLocators: z.array(evidenceLocatorSchema).min(1).max(64),
  approvedResearchUrls: z.array(z.string().url().max(2_048)).max(8).default([]),
  artifactDigests: z.array(digestSchema).min(1).max(16),
  authVersion: z.literal(1),
  budget: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    paidMicros: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    parentRunId: z.string().min(1).max(160).nullable().default(null),
    reservationKey: z.string().min(3).max(160),
    scope: z.enum(["deployment_source_recovery", "workspace"]),
  }).strict(),
  capabilityRevision: z.number().int().positive(),
  definitionDigest: digestSchema,
  definitionId: z.string().min(3).max(200),
  definitionVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  evidenceLimits: z.object({
    maximumBytes: z.number().int().positive().max(10 * 1_024 * 1_024),
    maximumPages: z.number().int().nonnegative().max(8),
    maximumRows: z.number().int().nonnegative().max(2_000),
  }).strict(),
  expiresAt: timestampSchema,
  inputDigest: digestSchema,
  issuedAt: timestampSchema,
  jobId: z.string().min(3).max(200),
  modelId: z.string().min(3).max(200),
  reasoning: z.enum(HYBRID_MODEL_REASONING_VALUES).default("high"),
  schemaVersion: z.literal(1),
  scope: hybridEvidenceScopeSchema,
}).strict().superRefine((value, context) => {
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.expiresAt);
  const expectedBudgetScope = value.scope.kind === "source_global"
    ? "deployment_source_recovery"
    : "workspace";
  const workerContract = resolveHybridEvidenceWorkerContract(value.definitionId);
  if (
    expires <= issued ||
    expires - issued > HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS ||
    value.budget.scope !== expectedBudgetScope ||
    (workerContract?.research?.requiresParentRunId === true &&
      value.budget.parentRunId === null) ||
    value.allowedLocators.some((locator) =>
      ("artifactDigest" in locator &&
        !value.artifactDigests.includes(locator.artifactDigest)) ||
      (locator.kind === "pdf_page" && locator.page > value.evidenceLimits.maximumPages) ||
      (locator.kind === "spreadsheet_range" &&
        Number(locator.range.match(/:?[A-Z]{1,3}([1-9]\d*)$/u)?.[1] ?? Number.MAX_SAFE_INTEGER) >
          value.evidenceLimits.maximumRows)
    )
  ) context.addIssue({ code: "custom", message: "hybrid_evidence_auth_invalid" });
});

export type HybridEvidenceWorkerEnvelope = Readonly<z.infer<typeof envelopeSchema>>;

export type HybridEvidenceWorkerAuthFailureReason =
  | "claim_mismatch"
  | "envelope_invalid"
  | "expected_claim_mismatch"
  | "secret_invalid"
  | "token_expired"
  | "token_format_invalid"
  | "token_not_yet_valid"
  | "token_payload_invalid"
  | "token_schema_invalid"
  | "token_signature_invalid"
  | "unknown";

export class HybridEvidenceWorkerAuthError extends Error {
  readonly code = "hybrid_evidence_auth_invalid";

  constructor(readonly reason: HybridEvidenceWorkerAuthFailureReason = "unknown") {
    super(`hybrid_evidence_auth_invalid:${reason}`);
    this.name = "HybridEvidenceWorkerAuthError";
  }
}

interface SessionCapabilityStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { ex: number }): Promise<unknown>;
}

let sessionCapabilityRedis: Redis | undefined;

/*
 * The compiled-worker acceptance runs the real worker launch - which binds a
 * session capability - while injecting in-memory data clients and pointing KV
 * at an unresolvable host. Reuse the worker's own fail-closed fixture gate (the
 * same one that redirects its data clients) to keep the bind and its later
 * authorization read on one in-process map, so the launch never reaches real
 * DNS. Production (VERCEL/VERCEL_ENV set) never takes this branch and uses KV.
 */
const fixtureSessionCapabilities = new Map<string, string>();
const fixtureSessionCapabilityStore: SessionCapabilityStore = {
  get: async (key) => fixtureSessionCapabilities.get(key) ?? null,
  set: async (key, value) => {
    fixtureSessionCapabilities.set(key, value);
    return "OK";
  },
};

function sessionCapabilityStore(
  environment: NodeJS.ProcessEnv = process.env,
): SessionCapabilityStore {
  if (hybridEvidenceWorkerFixtureRuntimeAllowed()) return fixtureSessionCapabilityStore;
  if (sessionCapabilityRedis) return sessionCapabilityRedis;
  const url = environment.KV_REST_API_URL ?? environment.UPSTASH_REDIS_REST_URL;
  const token = environment.KV_REST_API_TOKEN ?? environment.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return invalid();
  sessionCapabilityRedis = new Redis({ automaticDeserialization: false, token, url });
  return sessionCapabilityRedis;
}

function sessionCapabilityKey(sessionId: string): string {
  return `${SESSION_CAPABILITY_PREFIX}${createHash("sha256").update(sessionId).digest("hex")}`;
}

export async function bindHybridEvidenceWorkerSessionCapability(input: {
  sessionId: string;
  token: string;
}, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  decodeHybridEvidenceWorkerToken(input.token);
  await sessionCapabilityStore(environment).set(
    sessionCapabilityKey(input.sessionId),
    input.token,
    { ex: SESSION_CAPABILITY_TTL_SECONDS },
  );
}

async function readHybridEvidenceWorkerSessionCapability(
  sessionId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const value = await sessionCapabilityStore(environment).get(sessionCapabilityKey(sessionId));
  return typeof value === "string" ? value : undefined;
}

function invalid(reason: HybridEvidenceWorkerAuthFailureReason = "unknown"): never {
  throw new HybridEvidenceWorkerAuthError(reason);
}

function secret(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.EVE_HYBRID_EVIDENCE_AUTH_SECRET;
  if (!encoded || !SECRET_PATTERN.test(encoded)) return invalid("secret_invalid");
  const value = Buffer.from(encoded, "base64url");
  if (value.byteLength < 32) return invalid("secret_invalid");
  return value;
}

function signature(payload: string, environment: NodeJS.ProcessEnv): Buffer {
  return createHmac("sha256", secret(environment))
    .update(`eve-hybrid-evidence-worker-auth-v1\0${payload}`)
    .digest();
}

export function createHybridEvidenceWorkerEnvelope(input: {
  approvedResearchUrls?: readonly string[];
  budget: HybridEvidenceBudgetReservation;
  capabilityRevision: number;
  expiresAt: Date;
  issuedAt: Date;
  job: HybridEvidenceJob;
  locators: readonly EvidenceLocator[];
  reasoning?: HybridModelReasoning;
  evidenceLimits: {
    maximumBytes: number;
    maximumPages: number;
    maximumRows: number;
  };
}): HybridEvidenceWorkerEnvelope {
  const reservation = input.budget.reservation;
  const parsed = envelopeSchema.safeParse({
    allowedLocators: input.locators,
    approvedResearchUrls: [...new Set(
      (input.approvedResearchUrls ?? []).map(normalizeHybridEvidenceResearchUrl),
    )].sort(),
    artifactDigests: input.job.artifactDigests,
    authVersion: 1,
    budget: {
      inputTokens: reservation.inputTokens,
      outputTokens: reservation.outputTokens,
      paidMicros: reservation.paidMicros,
      parentRunId: input.budget.lane === "workspace_semantic"
        ? input.budget.parentRunId
        : null,
      reservationKey: input.budget.reservationKey,
      scope: input.job.budgetReservation.scope,
    },
    capabilityRevision: input.capabilityRevision,
    definitionDigest: input.job.definitionDigest,
    definitionId: input.job.definitionId,
    definitionVersion: input.job.definitionVersion,
    evidenceLimits: input.evidenceLimits,
    expiresAt: input.expiresAt.toISOString(),
    inputDigest: input.job.inputDigest,
    issuedAt: input.issuedAt.toISOString(),
    jobId: input.job.jobId,
    modelId: input.job.modelId,
    reasoning: input.reasoning ?? "high",
    schemaVersion: 1,
    scope: input.job.scope,
  });
  if (
    !parsed.success ||
    input.budget.reservationKey !== input.job.budgetReservation.key ||
    input.locators.length !== input.job.locatorDigests.length
  ) return invalid("envelope_invalid");
  return Object.freeze(parsed.data);
}

export function signHybridEvidenceWorkerEnvelope(
  envelope: HybridEvidenceWorkerEnvelope,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) return invalid("envelope_invalid");
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  return `${payload}.${signature(payload, environment).toString("base64url")}`;
}

export function verifyHybridEvidenceWorkerToken(
  token: string,
  options: { now?: Date } = {},
  environment: NodeJS.ProcessEnv = process.env,
): HybridEvidenceWorkerEnvelope {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return invalid("token_format_invalid");
  const expected = signature(match[1]!, environment);
  const supplied = Buffer.from(match[2]!, "base64url");
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return invalid("token_signature_invalid");
  }
  return decodeHybridEvidenceWorkerToken(token, options);
}

/**
 * Decode a worker capability after its opaque token has crossed Eve's durable
 * workflow boundary. Authorization at that boundary is the token's durable
 * SHA-256 claim plus the immutable job fields, not access to the issuer's
 * process-local signing secret.
 */
export function decodeHybridEvidenceWorkerToken(
  token: string,
  options: { now?: Date } = {},
): HybridEvidenceWorkerEnvelope {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return invalid("token_format_invalid");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch {
    return invalid("token_payload_invalid");
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return invalid("token_schema_invalid");
  const now = (options.now ?? new Date()).getTime();
  if (now < Date.parse(parsed.data.issuedAt) - CLOCK_SKEW_MS) {
    return invalid("token_not_yet_valid");
  }
  if (now >= Date.parse(parsed.data.expiresAt)) return invalid("token_expired");
  return Object.freeze(parsed.data);
}

export function hybridEvidenceWorkerExecutionAuth(
  envelope: HybridEvidenceWorkerEnvelope,
  token: string,
): SessionAuthContext {
  return {
    attributes: {
      hybrid_evidence_job_id: envelope.jobId,
      hybrid_evidence_runtime_token: token,
    },
    authenticator: "hybrid-evidence-runtime",
    issuer: "eve-hybrid-evidence-dispatch",
    principalId: `hybrid-evidence-job:${envelope.jobId}`,
    principalType: "runtime",
    subject: envelope.jobId,
  };
}

function stringAttribute(auth: SessionAuthContext, name: string): string | undefined {
  const value = auth.attributes[name];
  return typeof value === "string" ? value : undefined;
}

export function hybridEvidenceWorkerTokenFromSessionAuth(
  auth: SessionContext["session"]["auth"],
): string | undefined {
  // A durable tool turn may replace `current`; `initiator` remains the caller
  // that created this single-job worker session and therefore owns its bearer
  // capability for the session's lifetime.
  return (auth.initiator
    ? stringAttribute(auth.initiator, "hybrid_evidence_runtime_token")
    : undefined) ?? (auth.current
    ? stringAttribute(auth.current, "hybrid_evidence_runtime_token")
    : undefined);
}

export async function requireHybridEvidenceWorkerAuth(
  ctx: { readonly session: { readonly auth: SessionContext["session"]["auth"]; readonly id: string } },
  expected: Partial<Pick<HybridEvidenceWorkerEnvelope, "jobId" | "inputDigest">> = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ envelope: HybridEvidenceWorkerEnvelope; token: string }> {
  const auth = ctx.session.auth;
  const authTokens = [auth.initiator, auth.current]
    .flatMap((principal) => principal
      ? [stringAttribute(principal, "hybrid_evidence_runtime_token")]
      : [])
    .filter((value): value is string => value !== undefined);
  const assertedJobIds = [auth.current, auth.initiator]
    .flatMap((principal) => principal
      ? [stringAttribute(principal, "hybrid_evidence_job_id")]
      : [])
    .filter((value): value is string => value !== undefined);
  let failure = new HybridEvidenceWorkerAuthError("token_format_invalid");
  let storedToken: string | undefined;
  let sessionCapabilityReadFailed = false;
  try {
    storedToken = await readHybridEvidenceWorkerSessionCapability(
      ctx.session.id,
      environment,
    );
  } catch {
    // The immutable Eve session binding is authoritative when available, but
    // a transient KV read must not deny a still-valid auth-context capability.
    sessionCapabilityReadFailed = true;
  }
  const authorize = (token: string): {
    envelope: HybridEvidenceWorkerEnvelope;
    token: string;
  } | null => {
    let envelope: HybridEvidenceWorkerEnvelope;
    try {
      // Eve may resume the worker in a different durable invocation from the
      // issuer. Decode here; each privileged worker operation compares the
      // opaque token's digest with the claim stored when the signed job was issued.
      envelope = decodeHybridEvidenceWorkerToken(token);
    } catch (error) {
      if (!(error instanceof HybridEvidenceWorkerAuthError)) throw error;
      failure = error;
      return null;
    }
    // The token is a bearer capability; privileged operations separately
    // require its SHA-256 claim to match the running job and verify every
    // immutable envelope field.
    if (assertedJobIds.some((value) => value !== envelope.jobId)) {
      failure = new HybridEvidenceWorkerAuthError("claim_mismatch");
      return null;
    }
    if (Object.entries(expected).some(([key, value]) =>
      envelope[key as keyof typeof expected] !== value
    )) {
      failure = new HybridEvidenceWorkerAuthError("expected_claim_mismatch");
      return null;
    }
    return { envelope, token };
  };
  // Eve can preserve more than one valid token-shaped principal across durable
  // turns. Only the token bound when this exact worker session was launched is
  // guaranteed to equal the job's stored claim digest, so prefer it before the
  // auth-context fallbacks. Every candidate still has to pass the signed
  // envelope and asserted-job checks below.
  const candidates = [...new Set([
    ...(storedToken ? [storedToken] : []),
    ...authTokens,
  ])];
  for (const token of candidates) {
    const authorized = authorize(token);
    if (authorized) return authorized;
  }
  console.warn("[hybrid-evidence-auth] authorization failed", {
    authCandidateCount: new Set(authTokens).size,
    reason: failure.reason,
    sessionCapabilityReadFailed,
    sessionCapabilityPresent: storedToken !== undefined,
    sessionIdDigest: createHash("sha256").update(ctx.session.id).digest("hex"),
  });
  throw failure;
}
