import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import type { WorkspaceSourceCoverage } from "./workspace-source-coverage";
import type { WorkspaceWorkerEnvelope } from "./workspace-worker-auth";

const KEY_PREFIX = "eve:workspace-runtime:v1:run-outcome:";
const MAX_RECORD_BYTES = 32 * 1_024;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const provenanceSchema = z.object({
  accessClassification: z.enum(["public", "owner_private"]),
  canonicalUrl: z.string().url().max(2_048),
  origin: z.string().url().max(500),
  sourceId: idSchema,
}).strict().superRefine((source, context) => {
  const canonical = new URL(source.canonicalUrl);
  if (
    canonical.protocol !== "https:" ||
    canonical.username !== "" ||
    canonical.password !== "" ||
    canonical.hash !== "" ||
    canonical.toString() !== source.canonicalUrl ||
    canonical.origin !== source.origin ||
    new URL(source.origin).origin !== source.origin
  ) {
    context.addIssue({ code: "custom", message: "finding_provenance_invalid" });
  }
});

export const workspaceFindingInputSchema = z.object({
  accessClassification: z.enum(["public", "owner_private"]),
  artifactRefs: z.array(idSchema).max(8).default([]),
  asOf: timestampSchema,
  provenance: z.array(provenanceSchema).min(1).max(8),
  summary: z.string().trim().min(1).max(2_000),
}).strict().superRefine((value, context) => {
  const provenanceKeys = value.provenance.map(
    (source) => `${source.sourceId}\0${source.canonicalUrl}`,
  );
  if (new Set(provenanceKeys).size !== provenanceKeys.length) {
    context.addIssue({ code: "custom", message: "finding_provenance_duplicate" });
  }
  if (
    value.accessClassification === "public" &&
    value.provenance.some((source) => source.accessClassification === "owner_private")
  ) {
    context.addIssue({ code: "custom", message: "finding_classification_invalid" });
  }
});

const findingSchema = workspaceFindingInputSchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  findingId: idSchema,
  monitorId: z.string().uuid(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("finding"),
  runId: z.string().min(1).max(160),
  schemaVersion: z.literal(1),
  state: z.literal("staged"),
  workspaceId: z.string().uuid(),
}).strict();

const checkpointSchema = z.object({
  completedAt: timestampSchema,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  watermark: timestampSchema,
}).strict();

const outcomeSchema = z.object({
  checkpoint: checkpointSchema,
  configurationRevision: z.number().int().positive(),
  createdAt: timestampSchema,
  finding: findingSchema.nullable(),
  monitorId: z.string().uuid(),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(["finding_staged", "no_match"]),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("workspace_run_outcome"),
  runId: z.string().min(1).max(160),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "finding_staged") !== (value.finding !== null)) {
    context.addIssue({ code: "custom", message: "finding_outcome_invalid" });
  }
});

export type WorkspaceFindingInput = z.input<typeof workspaceFindingInputSchema>;
export type WorkspaceFinding = z.infer<typeof findingSchema>;
export type WorkspaceRunOutcome = z.infer<typeof outcomeSchema>;

export interface WorkspaceFindingStoreClient {
  createOrRead(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceFindingError extends Error {
  readonly code:
    | "finding_conflict"
    | "finding_invalid"
    | "finding_source_outside_fence"
    | "run_source_coverage_incomplete";

  constructor(code: WorkspaceFindingError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceFindingError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceFindingStoreClient | undefined;

function store(): WorkspaceFindingStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace finding storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async createOrRead(key, value) {
      let sha = await scriptSha;
      const execute = (candidate: string) =>
        redisClient!.evalsha<[string], string>(candidate, [key], [value]);
      try {
        return await execute(sha);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        scriptSha = redisClient!.scriptLoad(CAS_SCRIPT);
        sha = await scriptSha;
        return execute(sha);
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function key(scope: AuthorizedWorkspaceStoreScope, runId: string): string {
  const digest = createHash("sha256")
    .update(`run-outcome\0${scope.ownerId}\0${scope.workspaceId}\0${runId}`)
    .digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseOutcome(raw: string, scope: AuthorizedWorkspaceStoreScope): WorkspaceRunOutcome {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceFindingError("finding_invalid");
  }
  try {
    const parsed = outcomeSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.ownerId !== scope.ownerId ||
      parsed.data.workspaceId !== scope.workspaceId
    ) {
      throw new WorkspaceFindingError("finding_invalid");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof WorkspaceFindingError) throw error;
    throw new WorkspaceFindingError("finding_invalid");
  }
}

function assertCoverage(
  envelope: WorkspaceWorkerEnvelope,
  coverage: WorkspaceSourceCoverage,
  scope: AuthorizedWorkspaceStoreScope,
): asserts coverage is WorkspaceSourceCoverage & { checkpoint: NonNullable<WorkspaceSourceCoverage["checkpoint"]> } {
  if (
    coverage.state !== "complete" ||
    coverage.checkpoint === null ||
    coverage.ownerId !== envelope.ownerId ||
    coverage.workspaceId !== envelope.workspaceId ||
    coverage.monitorId !== envelope.monitorId ||
    coverage.runId !== envelope.runId ||
    coverage.configurationRevision !== envelope.configurationRevision ||
    coverage.window.startAt !== envelope.window.startAt ||
    coverage.window.endAt !== envelope.window.endAt ||
    scope.ownerId !== envelope.ownerId ||
    scope.workspaceId !== envelope.workspaceId ||
    JSON.stringify(coverage.sources) !== JSON.stringify(
      envelope.sources.map(({ canonicalUrl, origin, sourceId }) => ({ canonicalUrl, origin, sourceId })),
    )
  ) {
    throw new WorkspaceFindingError("run_source_coverage_incomplete");
  }
}

function assertProvenance(
  envelope: WorkspaceWorkerEnvelope,
  provenance: readonly z.infer<typeof provenanceSchema>[],
): void {
  for (const source of provenance) {
    const allowed = envelope.sources.find((candidate) => candidate.sourceId === source.sourceId);
    if (
      !allowed ||
      allowed.origin !== source.origin ||
      (allowed.accessClassification === "public" && source.accessClassification !== "public")
    ) {
      throw new WorkspaceFindingError("finding_source_outside_fence");
    }
  }
}

function contentHash(input: z.output<typeof workspaceFindingInputSchema>): string {
  return createHash("sha256").update(JSON.stringify({
    accessClassification: input.accessClassification,
    artifactRefs: [...input.artifactRefs].sort(),
    asOf: input.asOf,
    provenance: [...input.provenance].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.canonicalUrl.localeCompare(right.canonicalUrl)),
    summary: input.summary,
  })).digest("hex");
}

async function createOutcome(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: WorkspaceRunOutcome,
  client: WorkspaceFindingStoreClient,
): Promise<WorkspaceRunOutcome> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const parsed = outcomeSchema.safeParse(candidate);
  if (!parsed.success) throw new WorkspaceFindingError("finding_invalid");
  const raw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceFindingError("finding_invalid");
  }
  const stored = parseOutcome(rawValue(await client.createOrRead(key(scope, candidate.runId), raw)) ?? "", scope);
  const same =
    stored.outcome === candidate.outcome &&
    stored.occurrenceKey === candidate.occurrenceKey &&
    stored.finding?.contentHash === candidate.finding?.contentHash;
  if (!same) throw new WorkspaceFindingError("finding_conflict");
  return stored;
}

export async function stageWorkspaceFinding(
  input: {
    coverage: WorkspaceSourceCoverage;
    envelope: WorkspaceWorkerEnvelope;
    finding: WorkspaceFindingInput;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceRunOutcome> {
  assertCoverage(input.envelope, input.coverage, input.scope);
  const findingInput = workspaceFindingInputSchema.safeParse(input.finding);
  if (!findingInput.success) throw new WorkspaceFindingError("finding_invalid");
  assertProvenance(input.envelope, findingInput.data.provenance);
  const hash = contentHash(findingInput.data);
  const findingId = `finding_${createHash("sha256")
    .update(`finding\0${input.scope.ownerId}\0${input.scope.workspaceId}\0${input.envelope.runId}`)
    .digest("hex")}`;
  const finding = findingSchema.parse({
    ...findingInput.data,
    contentHash: hash,
    findingId,
    monitorId: input.envelope.monitorId,
    ownerId: input.scope.ownerId,
    recordType: "finding",
    runId: input.envelope.runId,
    schemaVersion: 1,
    state: "staged",
    workspaceId: input.scope.workspaceId,
  });
  return createOutcome(input.scope, {
    checkpoint: input.coverage.checkpoint,
    configurationRevision: input.envelope.configurationRevision,
    createdAt: (input.now ?? new Date()).toISOString(),
    finding,
    monitorId: input.envelope.monitorId,
    occurrenceKey: input.envelope.occurrenceKey,
    outcome: "finding_staged",
    ownerId: input.scope.ownerId,
    recordType: "workspace_run_outcome",
    runId: input.envelope.runId,
    schemaVersion: 1,
    workspaceId: input.scope.workspaceId,
  }, client);
}

export async function completeWorkspaceRunNoMatch(
  input: {
    coverage: WorkspaceSourceCoverage;
    envelope: WorkspaceWorkerEnvelope;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceRunOutcome> {
  assertCoverage(input.envelope, input.coverage, input.scope);
  return createOutcome(input.scope, {
    checkpoint: input.coverage.checkpoint,
    configurationRevision: input.envelope.configurationRevision,
    createdAt: (input.now ?? new Date()).toISOString(),
    finding: null,
    monitorId: input.envelope.monitorId,
    occurrenceKey: input.envelope.occurrenceKey,
    outcome: "no_match",
    ownerId: input.scope.ownerId,
    recordType: "workspace_run_outcome",
    runId: input.envelope.runId,
    schemaVersion: 1,
    workspaceId: input.scope.workspaceId,
  }, client);
}

export async function readWorkspaceRunOutcome(
  scope: AuthorizedWorkspaceStoreScope,
  runId: string,
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceRunOutcome | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(key(scope, runId)));
  return raw === null ? null : parseOutcome(raw, scope);
}
