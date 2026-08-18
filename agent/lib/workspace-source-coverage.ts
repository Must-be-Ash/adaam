import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const KEY_PREFIX = "eve:workspace-runtime:v1:source-coverage:";
const MAX_CAS_ATTEMPTS = 8;
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

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const sourceSchema = z.object({
  canonicalUrl: z.string().url().max(2_048),
  origin: z.string().url().max(500),
  sourceId: idSchema,
}).strict().superRefine((source, context) => {
  const url = new URL(source.canonicalUrl);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.toString() !== source.canonicalUrl ||
    url.origin !== source.origin ||
    new URL(source.origin).origin !== source.origin
  ) {
    context.addIssue({ code: "custom", message: "Source must be canonical HTTPS." });
  }
});
const successSchema = z.object({
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceId: idSchema,
  succeededAt: timestampSchema,
}).strict();
const checkpointSchema = z.object({
  completedAt: timestampSchema,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  watermark: timestampSchema,
}).strict();
const recordSchema = z.object({
  attempts: z.array(idSchema).max(8),
  checkpoint: checkpointSchema.nullable(),
  configurationRevision: z.number().int().positive(),
  createdAt: timestampSchema,
  monitorId: z.string().uuid(),
  ownerId: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
  runId: z.string().min(1).max(160),
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema).min(1).max(8),
  state: z.enum(["evaluating", "complete"]),
  successes: z.array(successSchema).max(8),
  updatedAt: timestampSchema,
  window: z.object({
    endAt: timestampSchema,
    startAt: timestampSchema,
  }).strict(),
  workspaceId: z.string().uuid(),
}).strict().superRefine((record, context) => {
  const sourceIds = record.sources.map((source) => source.sourceId);
  const urls = record.sources.map((source) => source.canonicalUrl);
  const attempts = new Set(record.attempts);
  const successes = new Set(record.successes.map((success) => success.sourceId));
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    new Set(urls).size !== urls.length ||
    attempts.size !== record.attempts.length ||
    successes.size !== record.successes.length ||
    [...attempts].some((sourceId) => !sourceIds.includes(sourceId)) ||
    [...successes].some((sourceId) => !attempts.has(sourceId))
  ) {
    context.addIssue({ code: "custom", message: "Invalid source coverage sets." });
  }
  if (
    Date.parse(record.window.startAt) >= Date.parse(record.window.endAt) ||
    (record.state === "evaluating" && record.checkpoint !== null) ||
    (record.state === "complete" &&
      (record.checkpoint === null || successes.size !== sourceIds.length))
  ) {
    context.addIssue({ code: "custom", message: "Invalid source checkpoint state." });
  }
});

export type WorkspaceSourceCoverage = z.infer<typeof recordSchema>;
export type WorkspaceSourceDefinition = z.infer<typeof sourceSchema>;

export interface WorkspaceSourceCoverageClient {
  compareAndSet(key: string, expected: string | null, next: string): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceSourceCoverageError extends Error {
  readonly code:
    | "source_already_attempted"
    | "source_coverage_conflict"
    | "source_coverage_corrupt"
    | "source_coverage_incomplete"
    | "source_not_attempted"
    | "source_outside_fence";

  constructor(code: WorkspaceSourceCoverageError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceSourceCoverageError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceSourceCoverageClient | undefined;

function store(): WorkspaceSourceCoverageClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace source coverage storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(CAS_SCRIPT);
  defaultClient = {
    async compareAndSet(key, expected, next) {
      let sha = await scriptSha;
      const execute = (candidate: string) =>
        redisClient!.evalsha<[string, string], number>(
          candidate,
          [key],
          [expected ?? "", next],
        );
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

function key(scope: AuthorizedWorkspaceStoreScope, runId: string): string {
  const digest = createHash("sha256")
    .update(`source-coverage\0${scope.ownerId}\0${scope.workspaceId}\0${runId}`)
    .digest("hex");
  return `${KEY_PREFIX}${digest}`;
}

function rawValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseRecord(
  raw: string,
  scope: AuthorizedWorkspaceStoreScope,
): WorkspaceSourceCoverage {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) {
    throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
  }
  try {
    const parsed = recordSchema.parse(JSON.parse(raw));
    if (parsed.ownerId !== scope.ownerId || parsed.workspaceId !== scope.workspaceId) {
      throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
    }
    return parsed;
  } catch (error) {
    if (error instanceof WorkspaceSourceCoverageError) throw error;
    throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
  }
}

async function update<T>(
  scope: AuthorizedWorkspaceStoreScope,
  runId: string,
  client: WorkspaceSourceCoverageClient,
  mutate: (record: WorkspaceSourceCoverage) => {
    record: WorkspaceSourceCoverage;
    result: T;
  },
): Promise<T> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const recordKey = key(scope, runId);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const currentRaw = rawValue(await client.get(recordKey));
    if (currentRaw === null) {
      throw new WorkspaceSourceCoverageError("source_coverage_conflict");
    }
    const mutation = mutate(parseRecord(currentRaw, scope));
    const next = recordSchema.safeParse(mutation.record);
    if (!next.success) throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
    const nextRaw = JSON.stringify(next.data);
    if (Buffer.byteLength(nextRaw, "utf8") > MAX_RECORD_BYTES) {
      throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
    }
    if (await client.compareAndSet(recordKey, currentRaw, nextRaw)) {
      return mutation.result;
    }
  }
  throw new WorkspaceSourceCoverageError("source_coverage_conflict");
}

export async function createWorkspaceSourceCoverage(
  input: {
    configurationRevision: number;
    monitorId: string;
    now?: Date;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sources: readonly WorkspaceSourceDefinition[];
    window: { endAt: string; startAt: string };
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceCoverage> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const timestamp = (input.now ?? new Date()).toISOString();
  const candidate = recordSchema.safeParse({
    attempts: [],
    checkpoint: null,
    configurationRevision: input.configurationRevision,
    createdAt: timestamp,
    monitorId: input.monitorId,
    ownerId: input.scope.ownerId,
    runId: input.runId,
    schemaVersion: 1,
    sources: input.sources,
    state: "evaluating",
    successes: [],
    updatedAt: timestamp,
    window: input.window,
    workspaceId: input.scope.workspaceId,
  });
  if (!candidate.success) {
    throw new WorkspaceSourceCoverageError("source_coverage_corrupt");
  }
  const raw = JSON.stringify(candidate.data);
  if (!(await client.compareAndSet(key(input.scope, input.runId), null, raw))) {
    const existing = await readWorkspaceSourceCoverage(input.scope, input.runId, client);
    if (
      existing &&
      existing.runId === candidate.data.runId &&
      existing.monitorId === candidate.data.monitorId &&
      existing.configurationRevision === candidate.data.configurationRevision &&
      existing.ownerId === candidate.data.ownerId &&
      existing.workspaceId === candidate.data.workspaceId &&
      JSON.stringify(existing.sources) === JSON.stringify(candidate.data.sources) &&
      existing.window.startAt === candidate.data.window.startAt &&
      existing.window.endAt === candidate.data.window.endAt
    ) {
      return existing;
    }
    throw new WorkspaceSourceCoverageError("source_coverage_conflict");
  }
  return candidate.data;
}

export async function readWorkspaceSourceCoverage(
  scope: AuthorizedWorkspaceStoreScope,
  runId: string,
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceCoverage | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = rawValue(await client.get(key(scope, runId)));
  return raw === null ? null : parseRecord(raw, scope);
}

function assertSourceAllowed(
  record: WorkspaceSourceCoverage,
  input: { sourceId?: string; url: string },
): WorkspaceSourceDefinition {
  let requested: URL;
  try {
    requested = new URL(input.url);
  } catch {
    throw new WorkspaceSourceCoverageError("source_outside_fence");
  }
  if (
    requested.protocol !== "https:" ||
    requested.username !== "" ||
    requested.password !== "" ||
    requested.hash !== ""
  ) {
    throw new WorkspaceSourceCoverageError("source_outside_fence");
  }
  const match = record.sources.find(
    (source) =>
      source.canonicalUrl === requested.toString() &&
      (input.sourceId === undefined || source.sourceId === input.sourceId),
  );
  if (!match) throw new WorkspaceSourceCoverageError("source_outside_fence");
  return match;
}

export async function authorizeWorkspaceSourceFetch(
  input: {
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sourceId?: string;
    url: string;
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceDefinition> {
  const record = await readWorkspaceSourceCoverage(input.scope, input.runId, client);
  if (!record || record.state !== "evaluating") {
    throw new WorkspaceSourceCoverageError("source_outside_fence");
  }
  return assertSourceAllowed(record, input);
}

export async function authorizeWorkspaceXExactPostFetch(
  input: {
    providerPostId: string;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sourceId: string;
    url: string;
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceDefinition> {
  const record = await readWorkspaceSourceCoverage(input.scope, input.runId, client);
  const source = record?.sources.find(({ sourceId }) => sourceId === input.sourceId);
  let requested: URL;
  try {
    requested = new URL(input.url);
  } catch {
    throw new WorkspaceSourceCoverageError("source_outside_fence");
  }
  const allowedParameters = new Set(["expansions", "tweet.fields"]);
  if (
    !record || record.state !== "evaluating" || !source ||
    !/^\d{1,20}$/u.test(input.providerPostId) ||
    requested.protocol !== "https:" || requested.origin !== source.origin ||
    requested.username !== "" || requested.password !== "" || requested.hash !== "" ||
    requested.pathname !== `/2/tweets/${input.providerPostId}` ||
    [...requested.searchParams.keys()].some((name) => !allowedParameters.has(name))
  ) throw new WorkspaceSourceCoverageError("source_outside_fence");
  return source;
}

export function buildWorkspaceSourcePrompt(
  record: WorkspaceSourceCoverage,
): string {
  const sources = record.sources.map(
    (source) => `- ${source.sourceId}: ${source.canonicalUrl}`,
  );
  return [
    "Configured sources (exact fence):",
    ...sources,
    "Fetch each listed source exactly once and do not access any other URL.",
    "Completion is accepted only after every listed source succeeds.",
  ].join("\n");
}

export async function reserveWorkspaceSourceAttempt(
  input: {
    now?: Date;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sourceId: string;
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceCoverage> {
  return update(input.scope, input.runId, client, (record) => {
    if (record.state !== "evaluating" || !record.sources.some((source) => source.sourceId === input.sourceId)) {
      throw new WorkspaceSourceCoverageError("source_outside_fence");
    }
    if (record.attempts.includes(input.sourceId)) {
      throw new WorkspaceSourceCoverageError("source_already_attempted");
    }
    const next = recordSchema.parse({
      ...record,
      attempts: [...record.attempts, input.sourceId],
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    return { record: next, result: next };
  });
}

export async function markWorkspaceSourceSuccess(
  input: {
    contentDigest: string;
    now?: Date;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
    sourceId: string;
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceCoverage> {
  return update(input.scope, input.runId, client, (record) => {
    if (!record.attempts.includes(input.sourceId)) {
      throw new WorkspaceSourceCoverageError("source_not_attempted");
    }
    const existing = record.successes.find((entry) => entry.sourceId === input.sourceId);
    if (existing) {
      if (existing.contentDigest !== input.contentDigest) {
        throw new WorkspaceSourceCoverageError("source_coverage_conflict");
      }
      return { record, result: record };
    }
    const timestamp = (input.now ?? new Date()).toISOString();
    const next = recordSchema.parse({
      ...record,
      successes: [
        ...record.successes,
        { contentDigest: input.contentDigest, sourceId: input.sourceId, succeededAt: timestamp },
      ],
      updatedAt: timestamp,
    });
    return { record: next, result: next };
  });
}

export async function completeWorkspaceSourceCoverage(
  input: {
    allowCheckpointBeforeWindow?: boolean;
    checkpoint?: { contentDigest: string; watermark: string };
    now?: Date;
    runId: string;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceSourceCoverageClient = store(),
): Promise<WorkspaceSourceCoverage> {
  return update(input.scope, input.runId, client, (record) => {
    if (record.state === "complete") {
      if (
        input.checkpoint &&
        (record.checkpoint?.contentDigest !== input.checkpoint.contentDigest ||
          record.checkpoint.watermark !== input.checkpoint.watermark)
      ) {
        throw new WorkspaceSourceCoverageError("source_coverage_conflict");
      }
      return { record, result: record };
    }
    if (
      record.sources.some(
        (source) => !record.successes.some((success) => success.sourceId === source.sourceId),
      )
    ) {
      throw new WorkspaceSourceCoverageError("source_coverage_incomplete");
    }
    const coverageContentDigest = createHash("sha256")
      .update(
        record.sources
          .map((source) => {
            const success = record.successes.find((entry) => entry.sourceId === source.sourceId)!;
            return `${source.sourceId}\0${source.canonicalUrl}\0${success.contentDigest}`;
          })
          .join("\0"),
      )
      .digest("hex");
    const timestamp = (input.now ?? new Date()).toISOString();
    const checkpoint = checkpointSchema.safeParse({
      completedAt: timestamp,
      contentDigest: input.checkpoint?.contentDigest ?? coverageContentDigest,
      watermark: input.checkpoint?.watermark ?? record.window.endAt,
    });
    if (
      !checkpoint.success ||
      (!input.allowCheckpointBeforeWindow &&
        Date.parse(checkpoint.data.watermark) < Date.parse(record.window.startAt)) ||
      Date.parse(checkpoint.data.watermark) > Date.parse(record.window.endAt)
    ) {
      throw new WorkspaceSourceCoverageError("source_coverage_conflict");
    }
    const next = recordSchema.parse({
      ...record,
      checkpoint: checkpoint.data,
      state: "complete",
      updatedAt: timestamp,
    });
    return { record: next, result: next };
  });
}
