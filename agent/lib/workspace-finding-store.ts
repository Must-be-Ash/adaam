import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import type { WorkspaceSourceCoverage } from "./workspace-source-coverage";
import type { WorkspaceWorkerEnvelope } from "./workspace-worker-auth";
import { workspaceFindingFactSchema } from "./workspace-finding-facts";
import { strategyPackWorkerSnapshotSchema } from "./strategy-pack-runtime-schema";

const KEY_PREFIX = "eve:workspace-runtime:v1:run-outcome:";
// The official SEC monitor requests up to 40 entries. Keep the record bounded
// while allowing a fully typed outcome at every accepted field maximum to
// commit atomically; the schema-maximum fixture remains below 512 KiB.
const MAX_RECORD_BYTES = 512 * 1_024;
const CAS_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return current end
redis.call("SET", KEYS[1], ARGV[1])
return ARGV[1]
`;
const OUTCOME_WITH_IDENTITIES_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current then return {"existing", current} end
for index = 2, #KEYS do
  local identity = redis.call("GET", KEYS[index])
  if identity and identity ~= ARGV[index] then
    return {"identity_conflict", identity}
  end
end
for index = 2, #KEYS do
  if redis.call("EXISTS", KEYS[index]) ~= 1 then
    redis.call("SET", KEYS[index], ARGV[index])
  end
end
redis.call("SET", KEYS[1], ARGV[1])
return {"created", ARGV[1]}
`;

export const WORKSPACE_FINDING_REDIS_SCRIPTS = Object.freeze({
  createOutcomeWithIdentityClaims: OUTCOME_WITH_IDENTITIES_SCRIPT,
});

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

export const workspaceFindingCandidateSchema = workspaceFindingInputSchema.extend({
  factIdentities: z.array(z.string().min(1).max(160)).max(50).default([]),
  facts: z.array(workspaceFindingFactSchema).min(1).max(50).optional(),
}).strict().superRefine((value, context) => {
  const expected = value.facts?.map((fact) => fact.filingIdentity) ?? [];
  if (
    new Set(value.factIdentities).size !== value.factIdentities.length ||
    JSON.stringify(value.factIdentities) !== JSON.stringify(expected)
  ) {
    context.addIssue({ code: "custom", message: "finding_fact_identity_invalid" });
  }
});

const findingSchema = workspaceFindingCandidateSchema.extend({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  findingId: idSchema,
  monitorId: z.string().uuid(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("finding"),
  runId: z.string().min(1).max(160),
  schemaVersion: z.literal(1),
  state: z.literal("staged"),
  strategyPack: strategyPackWorkerSnapshotSchema.nullable().default(null),
  workspaceId: z.string().uuid(),
}).strict();

const checkpointSchema = z.object({
  completedAt: timestampSchema,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  watermark: timestampSchema,
}).strict();

export function workspaceRunAttemptForOccurrence(
  occurrenceKey: string,
  runId: string,
): number | null {
  if (!/^[a-f0-9]{64}$/u.test(occurrenceKey)) return null;
  const prefix = `${occurrenceKey}:attempt:`;
  if (!runId.startsWith(prefix)) return null;
  const rawAttempt = runId.slice(prefix.length);
  if (!/^[1-9]\d*$/u.test(rawAttempt)) return null;
  const attempt = Number(rawAttempt);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
}

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
  strategyPack: strategyPackWorkerSnapshotSchema.nullable().default(null),
  workspaceId: z.string().uuid(),
}).strict().superRefine((value, context) => {
  if ((value.outcome === "finding_staged") !== (value.finding !== null)) {
    context.addIssue({ code: "custom", message: "finding_outcome_invalid" });
  }
  if (workspaceRunAttemptForOccurrence(value.occurrenceKey, value.runId) === null) {
    context.addIssue({ code: "custom", message: "finding_run_id_invalid" });
  }
  if (
    value.finding &&
    (value.finding.ownerId !== value.ownerId ||
      value.finding.workspaceId !== value.workspaceId ||
      value.finding.monitorId !== value.monitorId ||
      value.finding.runId !== value.runId ||
      JSON.stringify(value.finding.strategyPack) !==
        JSON.stringify(value.strategyPack))
  ) {
    context.addIssue({ code: "custom", message: "finding_parent_mismatch" });
  }
});

const identityClaimSchema = z.object({
  factIdentity: z.string().min(1).max(160),
  findingId: idSchema,
  monitorId: z.string().uuid(),
  occurrenceKey: z.string().regex(/^[a-f0-9]{64}$/u),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  recordType: z.literal("workspace_finding_identity"),
  runId: z.string().min(1).max(160),
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
}).strict();

export type WorkspaceFindingInput = z.input<typeof workspaceFindingInputSchema>;
export type WorkspaceFindingCandidate = z.input<typeof workspaceFindingCandidateSchema>;
export type WorkspaceFinding = z.infer<typeof findingSchema>;
export type WorkspaceRunOutcome = z.infer<typeof outcomeSchema>;
export type WorkspaceFindingIdentityClaim = z.infer<typeof identityClaimSchema>;

export interface WorkspaceFindingStoreClient {
  createOutcomeWithIdentityClaims(input: {
    identityClaims: readonly { key: string; value: string }[];
    outcomeKey: string;
    outcomeValue: string;
  }): Promise<{
    status: "created" | "existing" | "identity_conflict";
    value: unknown;
  }>;
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
  let identityScriptSha = redisClient.scriptLoad(OUTCOME_WITH_IDENTITIES_SCRIPT);
  defaultClient = {
    async createOutcomeWithIdentityClaims(input) {
      const execute = (candidate: string) =>
        redisClient!.evalsha<string[], string[]>(
          candidate,
          [input.outcomeKey, ...input.identityClaims.map(({ key }) => key)],
          [input.outcomeValue, ...input.identityClaims.map(({ value }) => value)],
        );
      let sha = await identityScriptSha;
      let result: string[];
      try {
        result = await execute(sha);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) throw error;
        identityScriptSha = redisClient!.scriptLoad(OUTCOME_WITH_IDENTITIES_SCRIPT);
        sha = await identityScriptSha;
        result = await execute(sha);
      }
      return {
        status: result[0] as "created" | "existing" | "identity_conflict",
        value: result[1],
      };
    },
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

function key(scope: AuthorizedWorkspaceStoreScope, occurrenceKey: string): string {
  const digest = createHash("sha256")
    .update(`run-outcome\0${scope.ownerId}\0${scope.workspaceId}\0${occurrenceKey}`)
    .digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function identityKey(
  scope: AuthorizedWorkspaceStoreScope,
  monitorId: string,
  factIdentity: string,
): string {
  const digest = createHash("sha256")
    .update(
      `finding-identity\0${scope.ownerId}\0${scope.workspaceId}\0${monitorId}\0${factIdentity}`,
    )
    .digest("hex");
  return `${KEY_PREFIX}identity:${digest}`;
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

function parseIdentityClaim(
  raw: string,
  scope: AuthorizedWorkspaceStoreScope,
  monitorId: string,
  factIdentity: string,
): WorkspaceFindingIdentityClaim {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceFindingError("finding_invalid");
  }
  try {
    const parsed = identityClaimSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.ownerId !== scope.ownerId ||
      parsed.data.workspaceId !== scope.workspaceId ||
      parsed.data.monitorId !== monitorId ||
      parsed.data.factIdentity !== factIdentity
    ) {
      throw new WorkspaceFindingError("finding_invalid");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof WorkspaceFindingError) throw error;
    throw new WorkspaceFindingError("finding_invalid");
  }
}

export async function selectUnseenWorkspaceFindingIdentities(
  input: {
    factIdentities: readonly string[];
    monitorId: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceFindingStoreClient = store(),
): Promise<readonly string[]> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (
    !z.string().uuid().safeParse(input.monitorId).success ||
    input.factIdentities.length > 50 ||
    new Set(input.factIdentities).size !== input.factIdentities.length ||
    input.factIdentities.some(
      (identity) => identity.length < 1 || identity.length > 160,
    )
  ) {
    throw new WorkspaceFindingError("finding_invalid");
  }
  const unseen: string[] = [];
  for (const factIdentity of input.factIdentities) {
    const raw = rawValue(
      await client.get(
        identityKey(input.scope, input.monitorId, factIdentity),
      ),
    );
    if (raw === null) {
      unseen.push(factIdentity);
      continue;
    }
    parseIdentityClaim(raw, input.scope, input.monitorId, factIdentity);
  }
  return Object.freeze(unseen);
}

export async function readWorkspaceFindingIdentityClaim(
  input: {
    readonly factIdentity: string;
    readonly monitorId: string;
    readonly scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceFindingIdentityClaim | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const value = rawValue(await client.get(
    identityKey(input.scope, input.monitorId, input.factIdentity),
  ));
  return value === null
    ? null
    : parseIdentityClaim(value, input.scope, input.monitorId, input.factIdentity);
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

function assertFacts(
  envelope: WorkspaceWorkerEnvelope,
  facts: readonly z.infer<typeof workspaceFindingFactSchema>[] | undefined,
): void {
  for (const fact of facts ?? []) {
    const allowed = envelope.sources.find(
      (candidate) => candidate.sourceId === fact.source.sourceId,
    );
    if (
      !allowed ||
      allowed.accessClassification !== "public" ||
      allowed.canonicalUrl !== fact.source.canonicalUrl ||
      allowed.origin !== fact.source.origin
    ) {
      throw new WorkspaceFindingError("finding_source_outside_fence");
    }
  }
}

function contentHash(input: z.output<typeof workspaceFindingCandidateSchema>): string {
  return createHash("sha256").update(JSON.stringify({
    accessClassification: input.accessClassification,
    artifactRefs: [...input.artifactRefs].sort(),
    asOf: input.asOf,
    factIdentities: input.factIdentities,
    facts: input.facts ?? [],
    provenance: [...input.provenance].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) || left.canonicalUrl.localeCompare(right.canonicalUrl)),
    summary: input.summary,
  })).digest("hex");
}

async function createOutcome(
  scope: AuthorizedWorkspaceStoreScope,
  candidate: WorkspaceRunOutcome,
  client: WorkspaceFindingStoreClient,
  identityClaims: readonly WorkspaceFindingIdentityClaim[] = [],
): Promise<WorkspaceRunOutcome> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const parsed = outcomeSchema.safeParse(candidate);
  if (!parsed.success) throw new WorkspaceFindingError("finding_invalid");
  const raw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceFindingError("finding_invalid");
  }
  const outcomeKey = key(scope, candidate.occurrenceKey);
  const storedValue = identityClaims.length === 0
    ? await client.createOrRead(outcomeKey, raw)
    : await client.createOutcomeWithIdentityClaims({
        identityClaims: identityClaims.map((claim) => ({
          key: identityKey(scope, claim.monitorId, claim.factIdentity),
          value: JSON.stringify(claim),
        })),
        outcomeKey,
        outcomeValue: raw,
      });
  if (
    typeof storedValue === "object" &&
    storedValue !== null &&
    "status" in storedValue &&
    storedValue.status === "identity_conflict"
  ) {
    throw new WorkspaceFindingError("finding_conflict");
  }
  const value =
    typeof storedValue === "object" &&
      storedValue !== null &&
      "status" in storedValue &&
      "value" in storedValue
      ? storedValue.value
      : storedValue;
  const stored = parseOutcome(rawValue(value) ?? "", scope);
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
    finding: WorkspaceFindingCandidate;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceRunOutcome> {
  assertCoverage(input.envelope, input.coverage, input.scope);
  const findingInput = workspaceFindingCandidateSchema.safeParse(input.finding);
  if (!findingInput.success) throw new WorkspaceFindingError("finding_invalid");
  assertProvenance(input.envelope, findingInput.data.provenance);
  assertFacts(input.envelope, findingInput.data.facts);
  const hash = contentHash(findingInput.data);
  const findingId = `finding_${createHash("sha256")
    .update(
      findingInput.data.factIdentities.length === 0
        ? `finding\0${input.scope.ownerId}\0${input.scope.workspaceId}\0${input.envelope.runId}`
        : `finding-facts\0${input.scope.ownerId}\0${input.scope.workspaceId}\0${input.envelope.monitorId}\0${[
            ...findingInput.data.factIdentities,
          ].sort().join("\0")}`,
    )
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
    strategyPack: input.envelope.strategyPack,
    workspaceId: input.scope.workspaceId,
  });
  const outcome = {
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
    strategyPack: input.envelope.strategyPack,
    workspaceId: input.scope.workspaceId,
  } satisfies WorkspaceRunOutcome;
  const identityClaims = findingInput.data.factIdentities.map((factIdentity) =>
    identityClaimSchema.parse({
      factIdentity,
      findingId,
      monitorId: input.envelope.monitorId,
      occurrenceKey: input.envelope.occurrenceKey,
      ownerId: input.scope.ownerId,
      recordType: "workspace_finding_identity",
      runId: input.envelope.runId,
      schemaVersion: 1,
      workspaceId: input.scope.workspaceId,
    })
  );
  return createOutcome(input.scope, outcome, client, identityClaims);
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
    strategyPack: input.envelope.strategyPack,
    workspaceId: input.scope.workspaceId,
  }, client);
}

export async function readWorkspaceRunOutcome(
  scope: AuthorizedWorkspaceStoreScope,
  occurrenceKey: string,
  client: WorkspaceFindingStoreClient = store(),
): Promise<WorkspaceRunOutcome | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(key(scope, occurrenceKey)));
  return raw === null ? null : parseOutcome(raw, scope);
}
