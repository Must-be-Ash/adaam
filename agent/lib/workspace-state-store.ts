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
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
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

const strategyMetadataV2Schema = metadataSchema.extend({
  schemaVersion: z.literal(2),
});

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

const legacyStrategyValueDocumentSchema = z
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

const strategyConfigurationSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u),
    strategyValueSchema,
  )
  .refine((value) => Object.keys(value).length <= 64, {
    message: "Too many strategy fields.",
  });

const strategyPackReferenceSchema = z
  .object({
    contentDigest: digestSchema.nullable(),
    id: identifierSchema,
    version: semverSchema,
  })
  .strict();

export const workspaceStrategySnapshotSchema = z
  .object({
    bindingRevision: revisionSchema,
    capabilityManifestRevision: revisionSchema,
    packContentDigest: digestSchema,
    packId: identifierSchema,
    packVersion: semverSchema,
    workspaceGeneration: revisionSchema,
  })
  .strict();

const strategyManagedResourceSchema = z
  .object({
    monitorId: z.string().uuid(),
    sourceIds: z.array(identifierSchema).min(1).max(8),
  })
  .strict()
  .superRefine((resource, context) => {
    if (
      new Set(resource.sourceIds).size !== resource.sourceIds.length ||
      resource.sourceIds.some(
        (sourceId, index) => index > 0 && resource.sourceIds[index - 1]! > sourceId,
      )
    ) {
      context.addIssue({ code: "custom", message: "Managed source IDs must be sorted and unique." });
    }
  });

const strategyHealthSchema = z
  .object({
    checkedAt: timestampSchema,
    code: z
      .enum([
        "catalog_blocked",
        "catalog_incompatible",
        "catalog_missing",
        "legacy_unverified",
        "pack_digest_mismatch",
        "runtime_disabled",
        "source_contract_mismatch",
      ])
      .nullable(),
    status: z.enum(["healthy", "unavailable", "unbound"]),
  })
  .strict();

export const workspaceStrategyBindingValueSchema = z
  .object({
    bindingRevision: revisionSchema,
    configuration: strategyConfigurationSchema,
    effectiveCapabilityManifestRevision: revisionSchema.nullable(),
    health: strategyHealthSchema,
    lastActiveSnapshot: workspaceStrategySnapshotSchema.nullable(),
    lifecycleState: z.enum(["active", "unavailable", "unbound"]),
    managedResources: z.record(identifierSchema, strategyManagedResourceSchema),
    ownerOverrides: strategyConfigurationSchema,
    pack: strategyPackReferenceSchema.nullable(),
    pendingSnapshot: workspaceStrategySnapshotSchema.nullable(),
    timestamps: z
      .object({
        activatedAt: timestampSchema.nullable(),
        configuredAt: timestampSchema.nullable(),
        generationRolloverAt: timestampSchema.nullable(),
        installedAt: timestampSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const resourceEntries = Object.entries(value.managedResources);
    if (
      resourceEntries.length > 16 ||
      new Set(resourceEntries.map(([, resource]) => resource.monitorId)).size !==
        resourceEntries.length
    ) {
      context.addIssue({ code: "custom", message: "Managed resources must be bounded and unique." });
    }
    if (
      Object.keys(value.ownerOverrides).some(
        (key) => !Object.prototype.hasOwnProperty.call(value.configuration, key),
      )
    ) {
      context.addIssue({ code: "custom", message: "Overrides must name effective configuration fields." });
    }

    if (value.lifecycleState === "unbound") {
      if (
        value.pack !== null ||
        value.effectiveCapabilityManifestRevision !== null ||
        value.pendingSnapshot !== null ||
        Object.keys(value.configuration).length > 0 ||
        Object.keys(value.ownerOverrides).length > 0 ||
        resourceEntries.length > 0 ||
        value.health.status !== "unbound" ||
        value.health.code !== null
      ) {
        context.addIssue({ code: "custom", message: "Unbound strategy state must be empty." });
      }
      return;
    }

    if (value.pack === null) {
      context.addIssue({ code: "custom", message: "Bound strategy state needs a pack reference." });
      return;
    }
    if (value.lifecycleState === "active") {
      const activeSnapshot = value.pendingSnapshot ?? value.lastActiveSnapshot;
      if (
        value.pack.contentDigest === null ||
        value.effectiveCapabilityManifestRevision === null ||
        activeSnapshot === null ||
        value.health.status !== "healthy" ||
        value.health.code !== null
      ) {
        context.addIssue({ code: "custom", message: "Active strategy state needs an exact healthy snapshot." });
      }
    } else if (
      value.health.status !== "unavailable" ||
      value.health.code === null ||
      value.pendingSnapshot !== null
    ) {
      context.addIssue({ code: "custom", message: "Unavailable strategy state needs a bounded reason." });
    }
    if (
      value.pack.contentDigest === null &&
      (value.health.code !== "legacy_unverified" ||
        value.effectiveCapabilityManifestRevision !== null ||
        value.lastActiveSnapshot !== null ||
        resourceEntries.length > 0)
    ) {
      context.addIssue({ code: "custom", message: "Only isolated legacy bindings may omit a digest." });
    }
    const currentSnapshot = value.pendingSnapshot ??
      (value.lifecycleState === "active" ? value.lastActiveSnapshot : null);
    if (
      currentSnapshot &&
      (currentSnapshot.bindingRevision !== value.bindingRevision ||
        currentSnapshot.packContentDigest !== value.pack.contentDigest ||
        currentSnapshot.packId !== value.pack.id ||
        currentSnapshot.packVersion !== value.pack.version ||
        currentSnapshot.capabilityManifestRevision !== value.effectiveCapabilityManifestRevision)
    ) {
      context.addIssue({ code: "custom", message: "Current strategy snapshot does not match its binding." });
    }
  });

const exactCapabilitySourceSchema = z.object({
  allowedOrigins: z.array(z.string().url().max(500).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  })).min(1).max(4),
  contractDigest: digestSchema,
  contractVersion: semverSchema,
  origin: z.string().url().max(500).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }),
  sourceId: identifierSchema,
}).strict().superRefine((source, context) => {
  if (
    !source.allowedOrigins.includes(source.origin) ||
    new Set(source.allowedOrigins).size !== source.allowedOrigins.length ||
    source.allowedOrigins.some(
      (origin, index) => index > 0 && source.allowedOrigins[index - 1]! > origin,
    )
  ) {
    context.addIssue({ code: "custom", message: "Source contract origins must be sorted, unique, and include the primary origin." });
  }
});

const legacyCapabilitySourceSchema = z.object({
  origin: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  }),
  sourceId: identifierSchema,
}).strict();

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
    .array(z.union([exactCapabilitySourceSchema, legacyCapabilitySourceSchema]))
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

const legacyStrategyDocumentSchema = metadataSchema.extend({
  recordType: z.literal("workspace_strategy_configuration"),
  value: legacyStrategyValueDocumentSchema,
});
export const workspaceStrategyBindingDocumentSchema = strategyMetadataV2Schema.extend({
  recordType: z.literal("workspace_strategy_binding"),
  value: workspaceStrategyBindingValueSchema,
});

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
  strategy: z.union([workspaceStrategyBindingDocumentSchema, legacyStrategyDocumentSchema]),
} as const;

const recordTypes = Object.freeze({
  brief: "workspace_brief",
  budget: "workspace_budget_policy",
  capabilities: "workspace_capability_manifest",
  strategy: "workspace_strategy_configuration",
} as const);

export type WorkspaceDocumentKind = keyof typeof schemas;
export type WorkspaceBriefValue = z.infer<typeof briefValueSchema>;
export type WorkspaceBudgetPolicyValue = z.infer<typeof budgetValueSchema>;
export type WorkspaceCapabilityManifestValue = z.infer<typeof capabilityValueSchema>;
export type WorkspaceStrategyConfigurationValue = z.infer<
  typeof legacyStrategyValueDocumentSchema
>;
export type WorkspaceStrategyBindingValue = z.infer<
  typeof workspaceStrategyBindingValueSchema
>;
export type WorkspaceDocument<K extends WorkspaceDocumentKind> = z.infer<
  (typeof schemas)[K]
>;
type WorkspaceLegacyWriteValue<K extends WorkspaceDocumentKind> =
  K extends "strategy"
    ? WorkspaceStrategyConfigurationValue
    : WorkspaceDocument<K>["value"];

export function validateWorkspaceBudgetPolicyValue(
  value: unknown,
): WorkspaceBudgetPolicyValue {
  const parsed = budgetValueSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  return parsed.data;
}

export function validateWorkspaceCapabilitySourceContract(
  source: unknown,
  expected?: {
    allowedOrigins: readonly string[];
    contractDigest: string;
    contractVersion: string;
    sourceId: string;
  },
): Extract<WorkspaceCapabilityManifestValue["sources"][number], { contractDigest: string }> {
  const parsed = exactCapabilitySourceSchema.safeParse(source);
  if (
    !parsed.success ||
    (expected !== undefined &&
      (parsed.data.sourceId !== expected.sourceId ||
        parsed.data.contractVersion !== expected.contractVersion ||
        parsed.data.contractDigest !== expected.contractDigest ||
        JSON.stringify(parsed.data.allowedOrigins) !== JSON.stringify(expected.allowedOrigins)))
  ) {
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

export function workspaceDocumentStorageKey(
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
  const raw = serializedValue(await client.get(workspaceDocumentStorageKey(kind, scope)));
  return raw === null ? null : parseDocument(kind, raw, scope);
}

export async function writeWorkspaceDocument<K extends WorkspaceDocumentKind>(
  kind: K,
  input: {
    expectedRevision: number;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
    value: WorkspaceLegacyWriteValue<K>;
  },
  client: WorkspaceStateStoreClient = store(),
): Promise<WorkspaceDocument<K>> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const scope = input.scope;
  assertAuthorizedWorkspaceStoreScope(scope);
  const key = workspaceDocumentStorageKey(kind, scope);
  const currentRaw = serializedValue(await client.get(key));
  const current = currentRaw === null ? null : parseDocument(kind, currentRaw, scope);
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw new WorkspaceStateConflictError();
  }
  const now = (input.now ?? new Date()).toISOString();
  const candidate = {
    createdAt: current?.createdAt ?? now,
    ownerId: scope.ownerId,
    recordType: recordTypes[kind],
    revision: input.expectedRevision + 1,
    schemaVersion: 1,
    updatedAt: now,
    value: input.value,
    workspaceId: scope.workspaceId,
  };
  if (kind === "strategy" && current?.schemaVersion === 2) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const writeSchema = kind === "strategy" ? legacyStrategyDocumentSchema : schemas[kind];
  const parsed = writeSchema.safeParse(candidate);
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

export function prepareInitialWorkspaceDocument<
  K extends Exclude<WorkspaceDocumentKind, "strategy">,
>(
  kind: K,
  input: {
    now: Date;
    scope: AuthorizedWorkspaceStoreScope;
    value: WorkspaceDocument<K>["value"];
  },
): { document: WorkspaceDocument<K>; key: string; raw: string } {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const now = input.now.toISOString();
  const parsed = schemas[kind].safeParse({
    createdAt: now,
    ownerId: input.scope.ownerId,
    recordType: recordTypes[kind],
    revision: 1,
    schemaVersion: 1,
    updatedAt: now,
    value: input.value,
    workspaceId: input.scope.workspaceId,
  });
  if (!parsed.success) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const raw = JSON.stringify(parsed.data);
  if (Buffer.byteLength(raw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS[kind]) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  return {
    document: parsed.data as WorkspaceDocument<K>,
    key: workspaceDocumentStorageKey(kind, input.scope),
    raw,
  };
}

function strategyBindingCandidate(input: {
  current: WorkspaceDocument<"strategy"> | null;
  now: string;
  scope: AuthorizedWorkspaceStoreScope;
  value: WorkspaceStrategyBindingValue;
}) {
  return workspaceStrategyBindingDocumentSchema.safeParse({
    createdAt: input.current?.createdAt ?? input.now,
    ownerId: input.scope.ownerId,
    recordType: "workspace_strategy_binding",
    revision: (input.current?.revision ?? 0) + 1,
    schemaVersion: 2,
    updatedAt: input.now,
    value: input.value,
    workspaceId: input.scope.workspaceId,
  });
}

export function prepareInitialWorkspaceStrategyBinding(input: {
  now: Date;
  scope: AuthorizedWorkspaceStoreScope;
  value: WorkspaceStrategyBindingValue;
}): {
  document: z.infer<typeof workspaceStrategyBindingDocumentSchema>;
  key: string;
  raw: string;
} {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const candidate = strategyBindingCandidate({
    current: null,
    now: input.now.toISOString(),
    scope: input.scope,
    value: input.value,
  });
  if (!candidate.success) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const raw = JSON.stringify(candidate.data);
  if (Buffer.byteLength(raw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS.strategy) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  return {
    document: candidate.data,
    key: workspaceDocumentStorageKey("strategy", input.scope),
    raw,
  };
}

export async function writeWorkspaceStrategyBinding(
  input: {
    expectedRevision: number;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
    value: WorkspaceStrategyBindingValue;
  },
  client: WorkspaceStateStoreClient = store(),
): Promise<z.infer<typeof workspaceStrategyBindingDocumentSchema>> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  const key = workspaceDocumentStorageKey("strategy", input.scope);
  const currentRaw = serializedValue(await client.get(key));
  const current = currentRaw === null
    ? null
    : parseDocument("strategy", currentRaw, input.scope);
  if ((current?.revision ?? 0) !== input.expectedRevision) {
    throw new WorkspaceStateConflictError();
  }
  const candidate = strategyBindingCandidate({
    current,
    now: (input.now ?? new Date()).toISOString(),
    scope: input.scope,
    value: input.value,
  });
  if (!candidate.success) throw new WorkspaceStateValidationError("workspace_state_invalid");
  const nextRaw = JSON.stringify(candidate.data);
  if (Buffer.byteLength(nextRaw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS.strategy) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  if (!(await client.compareAndSet(key, currentRaw, nextRaw))) {
    throw new WorkspaceStateConflictError();
  }
  return candidate.data;
}

export async function migrateWorkspaceStrategyDocument(
  input: {
    expectedRevision?: number;
    now?: Date;
    scope: AuthorizedWorkspaceStoreScope;
  },
  client: WorkspaceStateStoreClient = store(),
): Promise<z.infer<typeof workspaceStrategyBindingDocumentSchema> | null> {
  assertAuthorizedWorkspaceStoreScope(input.scope);
  const key = workspaceDocumentStorageKey("strategy", input.scope);
  const currentRaw = serializedValue(await client.get(key));
  if (currentRaw === null) return null;
  const current = parseDocument("strategy", currentRaw, input.scope);
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
    throw new WorkspaceStateConflictError();
  }
  if (current.schemaVersion === 2) return current;
  const now = (input.now ?? new Date()).toISOString();
  const pack = current.value.strategyPack;
  const candidate = strategyBindingCandidate({
    current,
    now,
    scope: input.scope,
    value: pack === null
      ? {
          bindingRevision: 1,
          configuration: {},
          effectiveCapabilityManifestRevision: null,
          health: { checkedAt: now, code: null, status: "unbound" },
          lastActiveSnapshot: null,
          lifecycleState: "unbound",
          managedResources: {},
          ownerOverrides: {},
          pack: null,
          pendingSnapshot: null,
          timestamps: {
            activatedAt: null,
            configuredAt: null,
            generationRolloverAt: null,
            installedAt: null,
          },
        }
      : {
          bindingRevision: 1,
          configuration: current.value.configuration,
          effectiveCapabilityManifestRevision: null,
          health: { checkedAt: now, code: "legacy_unverified", status: "unavailable" },
          lastActiveSnapshot: null,
          lifecycleState: "unavailable",
          managedResources: {},
          ownerOverrides: {},
          pack: { ...pack, contentDigest: null },
          pendingSnapshot: null,
          timestamps: {
            activatedAt: null,
            configuredAt: null,
            generationRolloverAt: null,
            installedAt: current.createdAt,
          },
        },
  });
  if (!candidate.success) throw new WorkspaceStateValidationError("workspace_state_invalid");
  const nextRaw = JSON.stringify(candidate.data);
  if (Buffer.byteLength(nextRaw, "utf8") > WORKSPACE_DOCUMENT_BYTE_LIMITS.strategy) {
    throw new WorkspaceStateValidationError("workspace_state_invalid");
  }
  if (!(await client.compareAndSet(key, currentRaw, nextRaw))) {
    throw new WorkspaceStateConflictError();
  }
  return candidate.data;
}
