import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { z } from "zod";

import {
  assertAuthorizedWorkspaceStoreScope,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

export const WORKSPACE_DOCUMENT_BYTE_LIMITS = Object.freeze({
  brief: 32_768,
  budget: 8_192,
  capabilities: 32_768,
  strategy: 16_384,
});

const KEY_PREFIX = "eve:workspace-runtime:v1:state:";
const COMPARE_AND_SET_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "" then
  if current then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
redis.call("SET", KEYS[1], ARGV[2])
return 1
`;

const opaqueIdSchema = z.string().regex(/^[a-z][a-z0-9_:-]{2,127}$/u);
const workspaceIdSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const revisionSchema = z.number().int().positive();
const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const decimalSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u);
const identifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);
const stringList = (maximum: number, length: number) =>
  z.array(z.string().trim().min(1).max(length)).max(maximum);

type StrategyValue =
  | null
  | boolean
  | number
  | string
  | StrategyValue[]
  | { [key: string]: StrategyValue };

const strategyValueSchema: z.ZodType<StrategyValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(2_000),
    z.array(strategyValueSchema).max(32),
    z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u), strategyValueSchema)
      .refine((value) => Object.keys(value).length <= 32),
  ]),
);

const metadataSchema = z.object({
  createdAt: timestampSchema,
  ownerId: opaqueIdSchema,
  revision: revisionSchema,
  schemaVersion: z.literal(1),
  updatedAt: timestampSchema,
  workspaceId: workspaceIdSchema,
}).strict();

const briefValueSchema = z.object({
  currentFindingsSummary: z.string().max(8_000),
  goal: z.string().trim().min(1).max(2_000),
  lastMaterialChange: z.string().max(2_000),
  openQuestions: stringList(20, 500),
  promotedFacts: z
    .array(
      z.object({
        fact: z.string().trim().min(1).max(1_000),
        provenanceRefs: z.array(identifierSchema).min(1).max(16),
      }).strict(),
    )
    .max(100),
  sourcePolicy: z.object({
    allowedSourceIds: z.array(identifierSchema).max(32),
    maximumAccessClassification: z.enum(["public", "owner_private"]),
  }).strict(),
  strategyConfigurationRevision: z.number().int().nonnegative(),
  thesis: z.string().max(4_000),
  watchlist: stringList(100, 120),
}).strict();

const strategyValueDocumentSchema = z
  .object({
    configuration: z.record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u),
      strategyValueSchema,
    ),
    strategyPack: z
      .object({ id: identifierSchema, version: semverSchema })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.configuration).length > 64) {
      context.addIssue({ code: "custom", message: "Too many strategy fields." });
    }
    if (!value.strategyPack && Object.keys(value.configuration).length > 0) {
      context.addIssue({
        code: "custom",
        message: "Unconfigured workspaces cannot retain strategy parameters.",
      });
    }
  });

const capabilityValueSchema = z.object({
  connectionIds: z.array(identifierSchema).max(16),
  controlPlaneToolIds: z.array(identifierSchema).max(32),
  financialToolIds: z.array(identifierSchema).max(16),
  hardDeniedCapabilityIds: z.array(identifierSchema).min(1).max(64),
  maximumDataAccessClassification: z.enum(["public", "owner_private"]),
  paidResearchAllowed: z.boolean(),
  providerTools: z
    .array(
      z.object({
        kind: z.enum(["read", "mutation"]),
        providerId: identifierSchema,
        schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        toolId: identifierSchema,
      }).strict(),
    )
    .max(64),
  researchToolIds: z.array(identifierSchema).max(64),
  skills: z
    .array(z.object({ id: identifierSchema, version: semverSchema }).strict())
    .max(16),
  sources: z
    .array(
      z.object({
        origin: z.string().url().refine((value) => {
          const url = new URL(value);
          return url.protocol === "https:" && url.origin === value;
        }),
        sourceId: identifierSchema,
      }).strict(),
    )
    .max(32),
  workerModelPolicy: z.object({
    allowedModelIds: z.array(identifierSchema).max(8),
    maximumOutputTokens: z.number().int().positive().max(100_000),
  }).strict(),
}).strict();

const budgetValueSchema = z.object({
  effectiveAt: timestampSchema,
  maximumConcurrentWorkers: z.number().int().positive().max(32),
  maximumInputTokensPerDay: z.number().int().positive().max(100_000_000),
  maximumInputTokensPerRun: z.number().int().positive().max(10_000_000),
  maximumOutputTokensPerDay: z.number().int().positive().max(100_000_000),
  maximumOutputTokensPerRun: z.number().int().positive().max(10_000_000),
  maximumPaidPerCall: decimalSchema.nullable(),
  maximumPaidPerDay: decimalSchema.nullable(),
  maximumPaidPerMonth: decimalSchema.nullable(),
  maximumScheduledRunsPerDay: z.number().int().positive().max(32),
  ownerTimezone: z.string().min(1).max(80).refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  unknownPriceFallbackCeiling: decimalSchema,
}).strict();

const schemas = {
  brief: metadataSchema.extend({
    recordType: z.literal("workspace_brief"),
    value: briefValueSchema,
  }),
  budget: metadataSchema.extend({
    recordType: z.literal("workspace_budget_policy"),
    value: budgetValueSchema,
  }),
  capabilities: metadataSchema.extend({
    recordType: z.literal("workspace_capability_manifest"),
    value: capabilityValueSchema,
  }),
  strategy: metadataSchema.extend({
    recordType: z.literal("workspace_strategy_configuration"),
    value: strategyValueDocumentSchema,
  }),
} as const;

export type WorkspaceDocumentKind = keyof typeof schemas;
export type WorkspaceBriefValue = z.infer<typeof briefValueSchema>;
export type WorkspaceBudgetPolicyValue = z.infer<typeof budgetValueSchema>;
export type WorkspaceCapabilityManifestValue = z.infer<typeof capabilityValueSchema>;
export type WorkspaceStrategyConfigurationValue = z.infer<
  typeof strategyValueDocumentSchema
>;
export type WorkspaceDocument<K extends WorkspaceDocumentKind> = z.infer<
  (typeof schemas)[K]
>;

export function validateWorkspaceBudgetPolicyValue(
  value: unknown,
): WorkspaceBudgetPolicyValue {
  const parsed = budgetValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  return parsed.data;
}

export interface WorkspaceStateStoreClient {
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
  ): Promise<boolean>;
  get(key: string): Promise<unknown>;
}

export class WorkspaceStateConflictError extends Error {
  readonly code = "workspace_revision_conflict";

  constructor() {
    super("Workspace state changed. Read the latest revision and retry.");
    this.name = "WorkspaceStateConflictError";
  }
}

export class WorkspaceStateValidationError extends Error {
  readonly code: "workspace_state_corrupt" | "workspace_state_invalid";

  constructor(code: WorkspaceStateValidationError["code"]) {
    super(
      code === "workspace_state_corrupt"
        ? "Stored workspace state is invalid."
        : "Workspace state does not satisfy its bounded schema.",
    );
    this.code = code;
    this.name = "WorkspaceStateValidationError";
  }
}

let redisClient: Redis | undefined;
let defaultClient: WorkspaceStateStoreClient | undefined;

function store(): WorkspaceStateStoreClient {
  if (defaultClient) return defaultClient;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Workspace state storage is not configured.");
  redisClient ??= new Redis({ automaticDeserialization: false, token, url });
  let scriptSha = redisClient.scriptLoad(COMPARE_AND_SET_SCRIPT);
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
        if (!(error instanceof Error) || !error.message.includes("NOSCRIPT")) {
          throw error;
        }
        scriptSha = redisClient!.scriptLoad(COMPARE_AND_SET_SCRIPT);
        sha = await scriptSha;
        return (await execute(sha)) === 1;
      }
    },
    get: (key) => redisClient!.get(key),
  };
  return defaultClient;
}

function documentKey(
  kind: WorkspaceDocumentKind,
  scope: AuthorizedWorkspaceStoreScope,
): string {
  const digest = createHash("sha256")
    .update(`workspace-state\0${scope.ownerId}\0${scope.workspaceId}`)
    .digest("hex");
  return `${KEY_PREFIX}${kind}:${digest}`;
}

function serializedValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}

function parseDocument<K extends WorkspaceDocumentKind>(
  kind: K,
  raw: string,
  scope: AuthorizedWorkspaceStoreScope,
): WorkspaceDocument<K> {
  if (Buffer.byteLength(raw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS[kind]) {
    throw new WorkspaceStateValidationError("workspace_state_corrupt");
  }
  try {
    const parsed = schemas[kind].parse(JSON.parse(raw));
    if (parsed.ownerId !== scope.ownerId || parsed.workspaceId !== scope.workspaceId) {
      throw new WorkspaceStateValidationError("workspace_state_corrupt");
    }
    return parsed as WorkspaceDocument<K>;
  } catch (error) {
    if (error instanceof WorkspaceStateValidationError) throw error;
    throw new WorkspaceStateValidationError("workspace_state_corrupt");
  }
}

export async function readWorkspaceDocument<K extends WorkspaceDocumentKind>(
  kind: K,
  scope: AuthorizedWorkspaceStoreScope,
  client: WorkspaceStateStoreClient = store(),
): Promise<WorkspaceDocument<K> | null> {
  assertAuthorizedWorkspaceStoreScope(scope);
  const raw = serializedValue(await client.get(documentKey(kind, scope)));
  return raw === null ? null : parseDocument(kind, raw, scope);
}

export async function writeWorkspaceDocument<K extends WorkspaceDocumentKind>(
  kind: K,
  input: {
    expectedRevision: number;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
    value: z.input<(typeof schemas)[K]> extends { value: infer V } ? V : never;
  },
  client: WorkspaceStateStoreClient = store(),
): Promise<WorkspaceDocument<K>> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const scope = input.scope;
  assertAuthorizedWorkspaceStoreScope(scope);
  const key = documentKey(kind, scope);
  const currentRaw = serializedValue(await client.get(key));
  const current = currentRaw === null ? null : parseDocument(kind, currentRaw, scope);
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw new WorkspaceStateConflictError();
  }
  const now = (input.now ?? new Date()).toISOString();
  const candidate = {
    createdAt: current?.createdAt ?? now,
    ownerId: scope.ownerId,
    recordType: schemas[kind].shape.recordType.value,
    revision: input.expectedRevision + 1,
    schemaVersion: 1,
    updatedAt: now,
    value: input.value,
    workspaceId: scope.workspaceId,
  };
  const parsed = schemas[kind].safeParse(candidate);
  if (!parsed.success) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const nextRaw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(nextRaw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS[kind]) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  if (!(await client.compareAndSet(key, currentRaw, nextRaw))) {
    throw new WorkspaceStateConflictError();
  }
  return parsed.data as WorkspaceDocument<K>;
}
