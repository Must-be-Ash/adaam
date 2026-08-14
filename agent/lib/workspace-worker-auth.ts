import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionAuthContext, SessionContext } from "eve/context";
import { z } from "zod";

import type { WorkspaceDispatchReservation } from "./workspace-dispatch-budget";
import { workspaceMonitorSourcesSchema } from "./workspace-monitor-input";
import type { ClaimedWorkspaceMonitor } from "./workspace-monitor-store";

const MAX_AUTH_LIFETIME_MS = 2 * 60 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43,}$/u;
const timestampSchema = z.string().datetime({ offset: true });
const envelopeSchema = z.object({
  authVersion: z.literal(1),
  budgetRevision: z.number().int().positive(),
  capabilityRevision: z.number().int().positive(),
  configurationRevision: z.number().int().positive(),
  expiresAt: timestampSchema,
  issuedAt: timestampSchema,
  leaseExpiresAt: timestampSchema,
  leaseTokenDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  monitorId: z.string().uuid(),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/u),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  reservedBudget: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    paidMicros: z.string().regex(/^(?:0|[1-9]\d*)$/u),
    runId: z.string().min(1).max(160),
  }).strict(),
  runId: z.string().min(1).max(160),
  scheduledFor: timestampSchema,
  schemaVersion: z.literal(1),
  sources: workspaceMonitorSourcesSchema,
  stateRevision: z.object({
    brief: z.number().int().positive(),
    strategy: z.number().int().positive(),
  }).strict(),
  window: z.object({ endAt: timestampSchema, startAt: timestampSchema }).strict(),
  workspaceId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  const issued = Date.parse(value.issuedAt);
  const expires = Date.parse(value.expiresAt);
  const leaseExpires = Date.parse(value.leaseExpiresAt);
  if (
    expires <= issued ||
    expires - issued > MAX_AUTH_LIFETIME_MS ||
    expires > leaseExpires ||
    Date.parse(value.window.startAt) >= Date.parse(value.window.endAt) ||
    value.reservedBudget.runId !== value.runId
  ) {
    context.addIssue({ code: "custom", message: "workspace_worker_auth_invalid" });
  }
});

export type WorkspaceWorkerEnvelope = Readonly<z.infer<typeof envelopeSchema>>;

export class WorkspaceWorkerAuthError extends Error {
  readonly code = "workspace_worker_auth_invalid";

  constructor() {
    super("workspace_worker_auth_invalid");
    this.name = "WorkspaceWorkerAuthError";
  }
}

function invalid(): never {
  throw new WorkspaceWorkerAuthError();
}

function secret(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.EVE_WORKSPACE_RUNTIME_AUTH_SECRET;
  if (!encoded || !SECRET_PATTERN.test(encoded)) return invalid();
  const value = Buffer.from(encoded, "base64url");
  if (value.byteLength < 32) return invalid();
  return value;
}

function signature(payload: string, environment: NodeJS.ProcessEnv): Buffer {
  return createHmac("sha256", secret(environment))
    .update(`eve-workspace-worker-auth-v1\0${payload}`)
    .digest();
}

export function createWorkspaceWorkerEnvelope(input: {
  budgetRevision: number;
  capabilityRevision: number;
  claimed: ClaimedWorkspaceMonitor;
  dispatchBudget: WorkspaceDispatchReservation;
  expiresAt: Date;
  issuedAt: Date;
  stateRevision: { brief: number; strategy: number };
  window: { endAt: string; startAt: string };
}): WorkspaceWorkerEnvelope {
  const candidate = envelopeSchema.safeParse({
    authVersion: 1,
    budgetRevision: input.budgetRevision,
    capabilityRevision: input.capabilityRevision,
    configurationRevision: input.claimed.monitor.configurationRevision,
    expiresAt: input.expiresAt.toISOString(),
    issuedAt: input.issuedAt.toISOString(),
    leaseExpiresAt: input.claimed.leaseExpiresAt,
    leaseTokenDigest: input.claimed.occurrence.leaseTokenDigest,
    monitorId: input.claimed.monitor.monitorId,
    occurrenceKey: input.claimed.occurrence.occurrenceKey,
    ownerId: input.claimed.scope.ownerId,
    reservedBudget: {
      inputTokens: input.dispatchBudget.workspace.inputTokens,
      outputTokens: input.dispatchBudget.workspace.outputTokens,
      paidMicros: input.dispatchBudget.workspace.paidMicros,
      runId: input.dispatchBudget.runId,
    },
    runId: input.dispatchBudget.runId,
    scheduledFor: input.claimed.occurrence.scheduledFor,
    schemaVersion: 1,
    sources: input.claimed.monitor.sources,
    stateRevision: input.stateRevision,
    window: input.window,
    workspaceId: input.claimed.scope.workspaceId,
  });
  if (
    !candidate.success ||
    input.claimed.monitor.ownerId !== input.claimed.scope.ownerId ||
    input.claimed.monitor.workspaceId !== input.claimed.scope.workspaceId ||
    input.claimed.occurrence.monitorId !== input.claimed.monitor.monitorId ||
    input.claimed.occurrence.configurationRevision !== input.claimed.monitor.configurationRevision
  ) {
    return invalid();
  }
  return Object.freeze(candidate.data);
}

export function signWorkspaceWorkerEnvelope(
  envelope: WorkspaceWorkerEnvelope,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) return invalid();
  const payload = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  return `${payload}.${signature(payload, environment).toString("base64url")}`;
}

export function verifyWorkspaceWorkerToken(
  token: string,
  options: { now?: Date } = {},
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceWorkerEnvelope {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(token);
  if (!match) return invalid();
  const expected = signature(match[1]!, environment);
  const supplied = Buffer.from(match[2]!, "base64url");
  if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
    return invalid();
  }
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
  ) {
    return invalid();
  }
  return Object.freeze(parsed.data);
}

function stringAttribute(auth: SessionAuthContext, name: string): string | undefined {
  const value = auth.attributes[name];
  return typeof value === "string" ? value : undefined;
}

export function workspaceWorkerExecutionAuth(
  envelope: WorkspaceWorkerEnvelope,
  token: string,
): SessionAuthContext {
  return {
    attributes: {
      workspace_id: envelope.workspaceId,
      workspace_run_id: envelope.runId,
      workspace_runtime_token: token,
    },
    authenticator: "workspace-monitor-runtime",
    issuer: "eve-workspace-dispatch",
    principalId: `workspace-run:${envelope.runId}`,
    principalType: "runtime",
    subject: envelope.runId,
  };
}

export function requireWorkspaceWorkerAuth(
  ctx: { readonly session: { readonly auth: SessionContext["session"]["auth"] } },
  expected: Partial<Pick<WorkspaceWorkerEnvelope, "monitorId" | "ownerId" | "runId" | "workspaceId">> = {},
  environment: NodeJS.ProcessEnv = process.env,
): WorkspaceWorkerEnvelope {
  const auth = ctx.session.auth.current;
  if (
    !auth ||
    auth.authenticator !== "workspace-monitor-runtime" ||
    auth.issuer !== "eve-workspace-dispatch" ||
    auth.principalType !== "runtime"
  ) {
    return invalid();
  }
  const token = stringAttribute(auth, "workspace_runtime_token");
  if (!token) return invalid();
  const envelope = verifyWorkspaceWorkerToken(token, {}, environment);
  if (
    auth.principalId !== `workspace-run:${envelope.runId}` ||
    auth.subject !== envelope.runId ||
    stringAttribute(auth, "workspace_id") !== envelope.workspaceId ||
    stringAttribute(auth, "workspace_run_id") !== envelope.runId
  ) {
    return invalid();
  }
  for (const [key, value] of Object.entries(expected)) {
    if (envelope[key as keyof typeof expected] !== value) return invalid();
  }
  return envelope;
}
