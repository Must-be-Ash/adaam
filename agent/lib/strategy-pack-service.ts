import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { photonApprovalGuardKey } from "./photon-approval-store";
import {
  normalizePhotonWorkspaceName,
  normalizePhotonWorkspaceNameKey,
  PHOTON_WORKSPACE_LIMIT,
  photonWorkspaceRegistryStorageKey,
  photonWorkspaceStoreClient,
  preparePhotonWorkspaceRegistryCreation,
  readPhotonWorkspaceRegistryRecord,
  type PhotonWorkspaceStoreClient,
} from "./photon-workspace-store";
import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
import { resolveStrategyPackFlags } from "./strategy-pack-flags";
import {
  strategyPackMutationStorageKeys,
  strategyPackMutationReceiptSchema,
  strategyPackTransactionClient,
  type StrategyPackCreateTransactionInput,
  type StrategyPackMutationReceipt,
  type StrategyPackTransactionClient,
} from "./strategy-pack-transaction";
import {
  prepareWorkspaceMonitorCreate,
  type PreparedWorkspaceMonitorCreate,
} from "./workspace-monitor-store";
import { nextWorkspaceMonitorOccurrence } from "./workspace-monitor-schedule";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceBudgetPolicyValue,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceStrategyBindingValue,
} from "./workspace-state-store";
import {
  authorizePhotonWorkspaceControlPlaneStore,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";

const REQUEST_BYTE_LIMIT = 16_384;
const SHARED_HARD_DENIALS = Object.freeze([
  "broker.mutation",
  "filesystem",
  "financial.mutation",
  "provider.mutation",
  "shell",
]);
const DEFAULT_BUDGET_CEILINGS = Object.freeze({
  maximumInputTokensPerDay: 100_000,
  maximumInputTokensPerRun: 25_000,
  maximumOutputTokensPerDay: 20_000,
  maximumOutputTokensPerRun: 4_000,
  maximumScheduledRunsPerDay: 8,
});

const mutationRequestSchema = z
  .object({
    activateMonitorResourceIds: z.array(z.string().min(2).max(80)).max(16).optional(),
    configuration: z.record(z.string().min(1).max(80), z.unknown()).optional(),
    expectedRegistryRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(80),
    pack: z
      .object({
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        id: z.string().min(1).max(160),
        version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
      })
      .strict(),
  })
  .strict();

const eveIdentitySchema = z
  .object({
    ingressId: z.string().min(1).max(200),
    operationOrdinal: z.number().int().nonnegative().max(1_000),
    stepId: z.string().min(1).max(200),
    transport: z.literal("eve"),
    turnId: z.string().min(1).max(200),
  })
  .strict();
const spectrumIdentitySchema = z
  .object({
    actionId: z.string().min(1).max(200),
    issuedAt: z.string().datetime({ offset: true }),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    signature: z.string().regex(/^[a-f0-9]{64}$/u),
    transport: z.literal("spectrum"),
  })
  .strict();
const sourceAssignmentSchema = z
  .object({
    generation: z.number().int().positive(),
    workspaceId: z.string().uuid(),
  })
  .strict();

export type StrategyPackMutationIdentity =
  | z.infer<typeof eveIdentitySchema>
  | z.infer<typeof spectrumIdentitySchema>;

const trustedIdentities = new WeakSet<object>();

export interface StrategyPackCapabilityInventoryEntry {
  readonly available?: boolean;
  readonly category: "control" | "financial" | "provider" | "research";
  readonly id: string;
}

export interface StrategyPackServiceDependencies {
  readonly budgetCeilings?: typeof DEFAULT_BUDGET_CEILINGS;
  readonly capabilityInventory: readonly StrategyPackCapabilityInventoryEntry[];
  readonly catalog?: typeof strategyPackCatalog;
  readonly environment?: NodeJS.ProcessEnv;
  readonly idFactory?: () => string;
  readonly transactionClient?: StrategyPackTransactionClient;
  readonly workspaceClient?: PhotonWorkspaceStoreClient;
  readonly workerModelPolicy?: WorkspaceCapabilityManifestValue["workerModelPolicy"];
}

export class StrategyPackServiceError extends Error {
  readonly code:
    | "strategy_pack_authority_expansion"
    | "strategy_pack_financial_approval_pending"
    | "strategy_pack_invalid_request"
    | "strategy_pack_mutation_conflict"
    | "strategy_pack_mutation_corrupt"
    | "strategy_pack_mutation_payload_conflict"
    | "strategy_pack_mutations_disabled"
    | "strategy_pack_source_assignment_stale"
    | "strategy_pack_unavailable";

  constructor(code: StrategyPackServiceError["code"], options?: ErrorOptions) {
    super(code, options);
    this.code = code;
    this.name = "StrategyPackServiceError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object") throw new TypeError("Value is not JSON serializable.");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function trusted<T extends StrategyPackMutationIdentity>(identity: T): T {
  const value = Object.freeze(identity);
  trustedIdentities.add(value);
  return value;
}

export function deriveEveStrategyPackMutationIdentity(input: {
  ingressId: string;
  operationOrdinal: number;
  stepId: string;
  turnId: string;
}): StrategyPackMutationIdentity {
  const parsed = eveIdentitySchema.safeParse({ ...input, transport: "eve" });
  if (!parsed.success) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  return trusted(parsed.data);
}

function spectrumUnsigned(input: {
  actionId: string;
  issuedAt: string;
  nonce: string;
}): string {
  return canonicalJson({
    actionId: input.actionId,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    transport: "spectrum",
  });
}

export function mintSpectrumStrategyPackMutationIdentity(
  input: { actionId: string; issuedAt: Date; nonce: string },
  secret: string,
): StrategyPackMutationIdentity {
  if (secret.length < 32) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  const unsigned = {
    actionId: input.actionId,
    issuedAt: input.issuedAt.toISOString(),
    nonce: input.nonce,
  };
  const signature = createHmac("sha256", secret).update(spectrumUnsigned(unsigned)).digest("hex");
  const parsed = spectrumIdentitySchema.safeParse({ ...unsigned, signature, transport: "spectrum" });
  if (!parsed.success) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  return trusted(parsed.data);
}

export function verifySpectrumStrategyPackMutationIdentity(
  value: unknown,
  secret: string,
): StrategyPackMutationIdentity {
  const parsed = spectrumIdentitySchema.safeParse(value);
  if (!parsed.success || secret.length < 32) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const expected = createHmac("sha256", secret)
    .update(spectrumUnsigned(parsed.data))
    .digest("hex");
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parsed.data.signature))) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  return trusted(parsed.data);
}

function parseIdentity(value: unknown): StrategyPackMutationIdentity {
  if (typeof value !== "object" || value === null || !trustedIdentities.has(value)) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const eve = eveIdentitySchema.safeParse(value);
  if (eve.success) return eve.data;
  const spectrum = spectrumIdentitySchema.safeParse(value);
  if (spectrum.success) return spectrum.data;
  throw new StrategyPackServiceError("strategy_pack_invalid_request");
}

function parseRequest(value: unknown) {
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  if (Buffer.byteLength(encoded, "utf8") > REQUEST_BYTE_LIMIT) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const parsed = mutationRequestSchema.safeParse(value);
  if (!parsed.success) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  return { payloadDigest: sha256(encoded), request: parsed.data };
}

function effectiveConfiguration(
  pack: StrategyPackCatalogEntry,
  requested: Record<string, unknown> | undefined,
): { configuration: Record<string, string | string[]>; ownerOverrides: Record<string, string | string[]> } {
  const provided = requested ?? {};
  const known = new Set(pack.configuration.map((field) => field.key));
  if (Object.keys(provided).some((key) => !known.has(key))) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const configuration: Record<string, string | string[]> = {};
  const ownerOverrides: Record<string, string | string[]> = {};
  for (const field of pack.configuration) {
    const supplied = Object.prototype.hasOwnProperty.call(provided, field.key);
    const value = supplied ? provided[field.key] : field.default;
    if (field.kind === "iana_timezone") {
      if (typeof value !== "string") throw new StrategyPackServiceError("strategy_pack_invalid_request");
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        throw new StrategyPackServiceError("strategy_pack_invalid_request");
      }
      configuration[field.key] = value;
      if (supplied) ownerOverrides[field.key] = value;
      continue;
    }
    if (
      !Array.isArray(value) ||
      value.length < field.minimumItems ||
      value.length > field.maximumItems ||
      value.some((entry) => typeof entry !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(entry)) ||
      new Set(value).size !== value.length ||
      value.some((entry, index) => index > 0 && value[index - 1]! > entry)
    ) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
    configuration[field.key] = value as string[];
    if (supplied) ownerOverrides[field.key] = value as string[];
  }
  return { configuration, ownerOverrides };
}

function effectiveCapabilities(
  pack: StrategyPackCatalogEntry,
  inventory: readonly StrategyPackCapabilityInventoryEntry[],
  workerModelPolicy: WorkspaceCapabilityManifestValue["workerModelPolicy"],
): WorkspaceCapabilityManifestValue {
  const skills = new Map(pack.skills.map((skill) => [`skill.${skill.id}`, skill]));
  const capabilities = new Map(inventory.map((entry) => [entry.id, entry]));
  const controlPlaneToolIds: string[] = [];
  const researchToolIds: string[] = [];
  for (const id of pack.capabilities.required) {
    if (skills.has(id)) continue;
    const capability = capabilities.get(id);
    if (!capability || capability.available === false) {
      throw new StrategyPackServiceError("strategy_pack_unavailable");
    }
    if (capability.category === "financial" || capability.category === "provider") {
      throw new StrategyPackServiceError("strategy_pack_authority_expansion");
    }
    (capability.category === "control" ? controlPlaneToolIds : researchToolIds).push(id);
  }
  return {
    connectionIds: [],
    controlPlaneToolIds: controlPlaneToolIds.sort(),
    financialToolIds: [],
    hardDeniedCapabilityIds: [...new Set([...SHARED_HARD_DENIALS, ...pack.capabilities.hardDenied])].sort(),
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: researchToolIds.sort(),
    skills: pack.skills.map(({ id, version }) => ({ id, version })),
    sources: pack.sources.map((source) => ({
      allowedOrigins: [...source.allowedOrigins],
      contractDigest: source.contractDigest,
      contractVersion: source.contractVersion,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
    workerModelPolicy,
  };
}

function budgetForPack(
  pack: StrategyPackCatalogEntry,
  configuration: Record<string, string | string[]>,
  now: string,
  ceilings: typeof DEFAULT_BUDGET_CEILINGS,
): WorkspaceBudgetPolicyValue {
  const requestedRunsPerDay = Math.min(
    ceilings.maximumScheduledRunsPerDay,
    pack.monitors.reduce((sum, monitor) => sum + monitor.suggestedBudget.maximumRunsPerDay, 0),
  );
  const inputPerRun = Math.min(
    ceilings.maximumInputTokensPerRun,
    Math.max(...pack.monitors.map((monitor) => monitor.suggestedBudget.maximumInputTokensPerRun)),
  );
  const outputPerRun = Math.min(
    ceilings.maximumOutputTokensPerRun,
    Math.max(...pack.monitors.map((monitor) => monitor.suggestedBudget.maximumOutputTokensPerRun)),
  );
  const timezoneField = pack.configuration.find((field) => field.kind === "iana_timezone");
  const ownerTimezone = timezoneField ? configuration[timezoneField.key] : "UTC";
  return {
    effectiveAt: now,
    maximumConcurrentWorkers: 1,
    maximumInputTokensPerDay: Math.min(
      ceilings.maximumInputTokensPerDay,
      inputPerRun * requestedRunsPerDay,
    ),
    maximumInputTokensPerRun: inputPerRun,
    maximumOutputTokensPerDay: Math.min(
      ceilings.maximumOutputTokensPerDay,
      outputPerRun * requestedRunsPerDay,
    ),
    maximumOutputTokensPerRun: outputPerRun,
    maximumPaidPerCall: null,
    maximumPaidPerDay: null,
    maximumPaidPerMonth: null,
    maximumScheduledRunsPerDay: requestedRunsPerDay,
    ownerTimezone: typeof ownerTimezone === "string" ? ownerTimezone : "UTC",
    unknownPriceFallbackCeiling: "0",
  };
}

function parseReceipt(
  raw: string,
  expected: {
    mutationId: string;
    payloadDigest: string;
    requestIdentityDigest: string;
  },
): StrategyPackMutationReceipt {
  try {
    const value = strategyPackMutationReceiptSchema.parse(JSON.parse(raw));
    if (
      value.mutationId !== expected.mutationId ||
      value.payloadDigest !== expected.payloadDigest ||
      value.requestIdentityDigest !== expected.requestIdentityDigest
    ) throw new Error("invalid receipt");
    return Object.freeze(value);
  } catch (cause) {
    throw new StrategyPackServiceError("strategy_pack_mutation_corrupt", { cause });
  }
}

function receiptResult(
  raw: string,
  replayed: boolean,
  expected: {
    mutationId: string;
    payloadDigest: string;
    requestIdentityDigest: string;
  },
) {
  return Object.freeze({ receipt: parseReceipt(raw, expected), replayed });
}

function transactionError(status: string): never {
  if (status === "blocked") throw new StrategyPackServiceError("strategy_pack_financial_approval_pending");
  if (status === "payload_conflict") throw new StrategyPackServiceError("strategy_pack_mutation_payload_conflict");
  if (status === "corrupt") throw new StrategyPackServiceError("strategy_pack_mutation_corrupt");
  throw new StrategyPackServiceError("strategy_pack_mutation_conflict");
}

function rejectionReceipt(input: {
  code: "capacity_exhausted" | "duplicate_name";
  createdAt: string;
  mutationId: string;
  payloadDigest: string;
  requestIdentityDigest: string;
}): StrategyPackMutationReceipt {
  return Object.freeze({
    bindingRevision: null,
    createdAt: input.createdAt,
    monitorIds: [],
    mutationId: input.mutationId,
    outcome: "rejected",
    payloadDigest: input.payloadDigest,
    recordType: "strategy_pack_mutation_receipt",
    registryRevision: null,
    rejectionCode: input.code,
    requestIdentityDigest: input.requestIdentityDigest,
    schemaVersion: 1,
    targetWorkspaceId: null,
  });
}

function monitorPreparations(input: {
  activate: Set<string>;
  budget: WorkspaceBudgetPolicyValue;
  configuration: Record<string, string | string[]>;
  now: Date;
  pack: StrategyPackCatalogEntry;
  scope: AuthorizedWorkspaceStoreScope;
}): PreparedWorkspaceMonitorCreate[] {
  return input.pack.monitors.map((monitor) => {
    const timezone = input.configuration[monitor.timezoneConfigurationKey];
    const times = input.configuration[monitor.dailyTimesConfigurationKey];
    if (typeof timezone !== "string" || !Array.isArray(times)) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
    const schedule = { kind: "daily_local" as const, times: times as string[], timezone };
    const next = nextWorkspaceMonitorOccurrence(schedule, input.now);
    const sources = monitor.sourceIds.map((sourceId) => {
      const source = input.pack.sources.find((candidate) => candidate.sourceId === sourceId);
      if (!source) throw new StrategyPackServiceError("strategy_pack_unavailable");
      return {
        accessClassification: source.accessClassification,
        canonicalUrl: source.canonicalUrl,
        origin: new URL(source.canonicalUrl).origin,
        sourceId,
      };
    });
    return prepareWorkspaceMonitorCreate({
      activateManagedMonitor: input.activate.has(monitor.resourceId),
      deliverySubscriptionId: `strategy-pack:${monitor.resourceId}`,
      idempotencyKey: `strategy-pack:${input.pack.contentDigest}:${monitor.resourceId}`,
      instruction: monitor.instruction,
      managedBy: {
        bindingRevision: 1,
        kind: "strategy_pack",
        packContentDigest: input.pack.contentDigest,
        packId: input.pack.id,
        packVersion: input.pack.version,
        resourceId: monitor.resourceId,
      },
      name: monitor.displayName,
      nextOccurrenceAt: next?.scheduledAt ?? null,
      now: input.now,
      requiredCapabilityIds: [...monitor.requiredCapabilityIds],
      schedule,
      scope: input.scope,
      sources,
      tighteningLimits: {
        inputTokensPerRun: Math.min(
          monitor.suggestedBudget.maximumInputTokensPerRun,
          input.budget.maximumInputTokensPerRun,
        ),
        outputTokensPerRun: Math.min(
          monitor.suggestedBudget.maximumOutputTokensPerRun,
          input.budget.maximumOutputTokensPerRun,
        ),
        paidPerRun: null,
      },
    });
  });
}

export async function createStrategyPackWorkspace(
  input: {
    now?: Date;
    principalId: string;
    request: unknown;
    requestIdentity: unknown;
    sourceAssignment: { generation: number; workspaceId: string };
    threadId: string;
  },
  dependencies: StrategyPackServiceDependencies,
): Promise<{ receipt: StrategyPackMutationReceipt; replayed: boolean }> {
  const environment = dependencies.environment ?? process.env;
  if (!resolveStrategyPackFlags(environment).mutations) {
    throw new StrategyPackServiceError("strategy_pack_mutations_disabled");
  }
  const transactionClient = dependencies.transactionClient ?? strategyPackTransactionClient(environment);
  const approvalGuardKey = photonApprovalGuardKey(input);
  if (await transactionClient.get(approvalGuardKey)) {
    throw new StrategyPackServiceError("strategy_pack_financial_approval_pending");
  }
  const sourceAssignment = sourceAssignmentSchema.safeParse(input.sourceAssignment);
  if (!sourceAssignment.success) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const sourceScope = authorizePhotonWorkspaceControlPlaneStore({
    principalId: input.principalId,
    resource: "manager",
    workspaceId: sourceAssignment.data.workspaceId,
  }, environment);
  const { payloadDigest, request } = parseRequest(input.request);
  const identity = parseIdentity(input.requestIdentity);
  const requestIdentityDigest = sha256(canonicalJson(identity));
  const sourceAssignmentDigest = sha256(canonicalJson(sourceAssignment.data));
  const mutationId = sha256(
    `strategy-pack-create\0${requestIdentityDigest}\0${payloadDigest}\0${sourceAssignmentDigest}`,
  );
  const keys = strategyPackMutationStorageKeys({
    ownerId: sourceScope.ownerId,
    principalId: input.principalId,
    requestIdentityDigest,
    threadId: input.threadId,
  });
  const mappingRaw = canonicalJson({
    mutationId,
    payloadDigest,
    requestIdentityDigest,
    schemaVersion: 1,
    sourceAssignmentDigest,
  });
  const receiptKey = keys.receiptKey(mutationId);
  const replayInput = { approvalGuardKey, mappingKey: keys.mappingKey, mappingRaw, receiptKey };
  const replay = await transactionClient.readReplay(replayInput);
  const expectedReceipt = { mutationId, payloadDigest, requestIdentityDigest };
  if (replay.status === "replayed") {
    return receiptResult(replay.receiptRaw, true, expectedReceipt);
  }
  if (replay.status !== "missing") transactionError(replay.status);

  const client = dependencies.workspaceClient ?? photonWorkspaceStoreClient();
  const registryRecord = await readPhotonWorkspaceRegistryRecord(input, client);
  if (registryRecord.registry.revision !== request.expectedRegistryRevision) {
    throw new StrategyPackServiceError("strategy_pack_mutation_conflict");
  }
  const source = registryRecord.registry.workspaces.find(
    (workspace) => workspace.id === sourceAssignment.data.workspaceId,
  );
  if (
    !source ||
    source.status !== "active" ||
    source.generation !== sourceAssignment.data.generation
  ) {
    throw new StrategyPackServiceError("strategy_pack_source_assignment_stale");
  }
  const catalog = dependencies.catalog ?? strategyPackCatalog;
  const pack = catalog.resolve(request.pack);
  if (!pack || pack.availability !== "available") {
    throw new StrategyPackServiceError("strategy_pack_unavailable");
  }
  const configuration = effectiveConfiguration(pack, request.configuration);
  const requestedActivation = request.activateMonitorResourceIds ?? [];
  if (
    new Set(requestedActivation).size !== requestedActivation.length ||
    requestedActivation.some(
      (resourceId) => !pack.monitors.some((monitor) => monitor.resourceId === resourceId),
    )
  ) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  for (const resourceId of requestedActivation) {
    const monitor = pack.monitors.find((candidate) => candidate.resourceId === resourceId)!;
    if (
      !request.configuration ||
      !Object.prototype.hasOwnProperty.call(
        request.configuration,
        monitor.timezoneConfigurationKey,
      ) ||
      !Object.prototype.hasOwnProperty.call(
        request.configuration,
        monitor.dailyTimesConfigurationKey,
      )
    ) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
  }
  const capabilities = effectiveCapabilities(
    pack,
    dependencies.capabilityInventory,
    dependencies.workerModelPolicy ?? {
      allowedModelIds: [environment.EVE_STRATEGY_PACK_WORKER_MODEL_ID ?? "google/gemini-3.6-flash"],
      maximumOutputTokens: 4_000,
    },
  );
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const targetWorkspaceId = (dependencies.idFactory ?? randomUUID)();
  let rejectionCode: "capacity_exhausted" | "duplicate_name" | null = null;
  if (registryRecord.registry.workspaces.length >= PHOTON_WORKSPACE_LIMIT) {
    rejectionCode = "capacity_exhausted";
  } else {
    const normalizedName = normalizePhotonWorkspaceNameKey(
      normalizePhotonWorkspaceName(request.name),
    );
    if (registryRecord.registry.workspaces.some((workspace) => workspace.normalizedName === normalizedName)) {
      rejectionCode = "duplicate_name";
    }
  }
  if (rejectionCode) {
    const receipt = rejectionReceipt({
      code: rejectionCode,
      createdAt: nowIso,
      mutationId,
      payloadDigest,
      requestIdentityDigest,
    });
    const transactionInput: StrategyPackCreateTransactionInput = {
      ...replayInput,
      expectedRegistryRaw: registryRecord.raw,
      expectedRegistryRevision: request.expectedRegistryRevision,
      monitors: [],
      nextRegistryRaw: null,
      receiptRaw: JSON.stringify(receipt),
      records: [],
      registryKey: photonWorkspaceRegistryStorageKey(input.principalId, input.threadId),
    };
    try {
      const committed = await transactionClient.commitCreate(transactionInput);
      if (committed.status === "committed") {
        return receiptResult(committed.receiptRaw, false, expectedReceipt);
      }
      if (committed.status === "replayed") {
        return receiptResult(committed.receiptRaw, true, expectedReceipt);
      }
      transactionError(committed.status);
    } catch (error) {
      const recovered = await transactionClient.readReplay(replayInput);
      if (recovered.status === "replayed") {
        return receiptResult(recovered.receiptRaw, true, expectedReceipt);
      }
      throw error;
    }
  }

  const targetScope = authorizePhotonWorkspaceControlPlaneStore({
    principalId: input.principalId,
    resource: "manager",
    workspaceId: targetWorkspaceId,
  }, environment);
  const preparedRegistry = preparePhotonWorkspaceRegistryCreation({
    current: registryRecord.registry,
    name: request.name,
    now,
    select: true,
    workspaceId: targetWorkspaceId,
  });
  const budget = budgetForPack(
    pack,
    configuration.configuration,
    nowIso,
    dependencies.budgetCeilings ?? DEFAULT_BUDGET_CEILINGS,
  );
  const monitors = monitorPreparations({
    activate: new Set(requestedActivation),
    budget,
    configuration: configuration.configuration,
    now,
    pack,
    scope: targetScope,
  });
  const managedResources = Object.fromEntries(
    pack.monitors.map((monitor, index) => [
      monitor.resourceId,
      {
        monitorId: monitors[index]!.monitor.monitorId,
        sourceIds: [...monitor.sourceIds].sort(),
      },
    ]),
  );
  const snapshot = {
    bindingRevision: 1,
    capabilityManifestRevision: 1,
    packContentDigest: pack.contentDigest,
    packId: pack.id,
    packVersion: pack.version,
    workspaceGeneration: preparedRegistry.workspace.generation,
  };
  const strategyValue: WorkspaceStrategyBindingValue = {
    bindingRevision: 1,
    configuration: configuration.configuration,
    effectiveCapabilityManifestRevision: 1,
    health: { checkedAt: nowIso, code: null, status: "healthy" },
    lastActiveSnapshot: null,
    lifecycleState: "active",
    managedResources,
    ownerOverrides: configuration.ownerOverrides,
    pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version },
    pendingSnapshot: snapshot,
    timestamps: {
      activatedAt: nowIso,
      configuredAt: nowIso,
      generationRolloverAt: nowIso,
      installedAt: nowIso,
    },
  };
  const records = [
    prepareInitialWorkspaceDocument("brief", {
      now,
      scope: targetScope,
      value: {
        currentFindingsSummary: "",
        goal: pack.description,
        lastMaterialChange: "",
        openQuestions: [],
        promotedFacts: [],
        sourcePolicy: {
          allowedSourceIds: pack.sources.map((source) => source.sourceId),
          maximumAccessClassification: "public",
        },
        strategyConfigurationRevision: 1,
        thesis: "",
        watchlist: [],
      },
    }),
    prepareInitialWorkspaceDocument("budget", {
      now,
      scope: targetScope,
      value: budget,
    }),
    prepareInitialWorkspaceDocument("capabilities", { now, scope: targetScope, value: capabilities }),
    prepareInitialWorkspaceStrategyBinding({ now, scope: targetScope, value: strategyValue }),
  ];
  const receipt: StrategyPackMutationReceipt = Object.freeze({
    bindingRevision: 1,
    createdAt: nowIso,
    monitorIds: monitors.map((monitor) => monitor.monitor.monitorId),
    mutationId,
    outcome: "created",
    payloadDigest,
    recordType: "strategy_pack_mutation_receipt",
    registryRevision: preparedRegistry.registry.revision,
    rejectionCode: null,
    requestIdentityDigest,
    schemaVersion: 1,
    targetWorkspaceId,
  });
  const transactionInput: StrategyPackCreateTransactionInput = {
    ...replayInput,
    expectedRegistryRaw: registryRecord.raw,
    expectedRegistryRevision: request.expectedRegistryRevision,
    monitors,
    nextRegistryRaw: JSON.stringify(preparedRegistry.registry),
    receiptRaw: JSON.stringify(receipt),
    records: records.map((record) => ({ key: record.key, raw: record.raw })),
    registryKey: photonWorkspaceRegistryStorageKey(input.principalId, input.threadId),
  };
  try {
    const committed = await transactionClient.commitCreate(transactionInput);
    if (committed.status === "committed") {
      return receiptResult(committed.receiptRaw, false, expectedReceipt);
    }
    if (committed.status === "replayed") {
      return receiptResult(committed.receiptRaw, true, expectedReceipt);
    }
    transactionError(committed.status);
  } catch (error) {
    const recovered = await transactionClient.readReplay(replayInput);
    if (recovered.status === "replayed") {
      return receiptResult(recovered.receiptRaw, true, expectedReceipt);
    }
    throw error;
  }
}
