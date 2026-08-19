import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionAuthContext, SessionContext } from "eve/context";
import { z } from "zod";

import {
  evidenceLocatorSchema,
  hybridEvidenceScopeSchema,
  type EvidenceLocator,
  type HybridEvidenceJob,
} from "./hybrid-evidence-schema";
import type { HybridEvidenceBudgetReservation } from "./hybrid-evidence-budget";
import {
  HYBRID_MODEL_REASONING_VALUES,
  type HybridModelReasoning,
} from "./hybrid-evidence-model-routing";

export const HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,}$/u;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const envelopeSchema = z.object({
  allowedLocators: z.array(evidenceLocatorSchema).min(1).max(64),
  artifactDigests: z.array(digestSchema).min(1).max(16),
  authVersion: z.literal(1),
  budget: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    paidMicros: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    reservationKey: z.string().min(3).max(160),
    scope: z.enum(["deployment_source_recovery", "workspace"]),
  }).strict(),
  capabilityRevision: z.number().int().positive(),
  definitionDigest: digestSchema,
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
  if (
    expires <= issued ||
    expires - issued > HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS ||
    value.budget.scope !== expectedBudgetScope ||
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

export class HybridEvidenceWorkerAuthError extends Error {
  readonly code = "hybrid_evidence_auth_invalid";

  constructor() {
    super("hybrid_evidence_auth_invalid");
    this.name = "HybridEvidenceWorkerAuthError";
  }
}

function invalid(): never {
  throw new HybridEvidenceWorkerAuthError();
}

function secret(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.EVE_HYBRID_EVIDENCE_AUTH_SECRET;
  if (!encoded || !SECRET_PATTERN.test(encoded)) return invalid();
  const value = Buffer.from(encoded, "base64url");
  if (value.byteLength < 32) return invalid();
  return value;
}

function signature(payload: string, environment: NodeJS.ProcessEnv): Buffer {
  return createHmac("sha256", secret(environment))
    .update(`eve-hybrid-evidence-worker-auth-v1\0${payload}`)
    .digest();
}

export function createHybridEvidenceWorkerEnvelope(input: {
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
    artifactDigests: input.job.artifactDigests,
    authVersion: 1,
    budget: {
      inputTokens: reservation.inputTokens,
      outputTokens: reservation.outputTokens,
      paidMicros: reservation.paidMicros,
      reservationKey: input.budget.reservationKey,
      scope: input.job.budgetReservation.scope,
    },
    capabilityRevision: input.capabilityRevision,
    definitionDigest: input.job.definitionDigest,
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
  ) return invalid();
  return Object.freeze(parsed.data);
}

export function signHybridEvidenceWorkerEnvelope(
  envelope: HybridEvidenceWorkerEnvelope,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) return invalid();
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  return `${payload}.${signature(payload, environment).toString("base64url")}`;
}

export function verifyHybridEvidenceWorkerToken(
  token: string,
  options: { now?: Date } = {},
  environment: NodeJS.ProcessEnv = process.env,
): HybridEvidenceWorkerEnvelope {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return invalid();
  const expected = signature(match[1]!, environment);
  const supplied = Buffer.from(match[2]!, "base64url");
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return invalid();
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
  if (!match) return invalid();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch {
    return invalid();
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const now = (options.now ?? new Date()).getTime();
  if (
    now < Date.parse(parsed.data.issuedAt) - CLOCK_SKEW_MS ||
    now >= Date.parse(parsed.data.expiresAt)
  ) return invalid();
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

export function requireHybridEvidenceWorkerAuth(
  ctx: { readonly session: { readonly auth: SessionContext["session"]["auth"] } },
  expected: Partial<Pick<HybridEvidenceWorkerEnvelope, "jobId" | "inputDigest">> = {},
  environment: NodeJS.ProcessEnv = process.env,
): { envelope: HybridEvidenceWorkerEnvelope; token: string } {
  const auth = ctx.session.auth.current;
  if (
    !auth ||
    auth.authenticator !== "hybrid-evidence-runtime" ||
    auth.issuer !== "eve-hybrid-evidence-dispatch" ||
    auth.principalType !== "runtime"
  ) return invalid();
  const token = stringAttribute(auth, "hybrid_evidence_runtime_token");
  if (!token) return invalid();
  // Eve may resume the worker in a different durable invocation from the
  // issuer. Decode here; each privileged worker operation compares the opaque
  // token's digest with the claim stored when the signed job was issued.
  void environment;
  const envelope = decodeHybridEvidenceWorkerToken(token);
  if (
    auth.principalId !== `hybrid-evidence-job:${envelope.jobId}` ||
    auth.subject !== envelope.jobId ||
    stringAttribute(auth, "hybrid_evidence_job_id") !== envelope.jobId
  ) return invalid();
  for (const [key, value] of Object.entries(expected)) {
    if (envelope[key as keyof typeof expected] !== value) return invalid();
  }
  return { envelope, token };
}
