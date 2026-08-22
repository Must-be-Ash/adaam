import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { resolveManagedMonitorLifecycleContract } from "./workspace-monitor-lifecycle-contract";

import { photonApprovalGuardKey } from "./photon-approval-store";
import { resolvePhotonOwnerConversationIdentity } from "./owner-identity";
import {
  activePhotonWorkspaceCount,
  normalizePhotonWorkspaceName,
  normalizePhotonWorkspaceNameKey,
  PHOTON_WORKSPACE_LIMIT,
  PHOTON_WORKSPACE_RETAINED_LIMIT,
  photonWorkspaceRegistryStorageKey,
  photonWorkspaceStoreClient,
  preparePhotonWorkspaceGenerationRollover,
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
  assertCatalogBackedValues,
  resolveCatalogBackedOptions,
} from "./catalog-backed-configuration";
import {
  emitStrategyPackObservation,
  safeStrategyPackReasonCode,
  type StrategyPackObservationSink,
} from "./strategy-pack-observability";
import {
  classifyStrategyPackTransactionStorageError,
  strategyPackMutationStorageKeys,
  strategyPackMutationReceiptSchema,
  strategyPackTransactionClient,
  StrategyPackTransactionStorageError,
  type StrategyPackCreateTransactionInput,
  type StrategyPackLifecycleTransactionInput,
  type StrategyPackMutationReceipt,
  type StrategyPackTransactionClient,
} from "./strategy-pack-transaction";
import {
  prepareWorkspaceMonitorCreate,
  listWorkspaceMonitors,
  prepareWorkspaceManagedMonitorUpdate,
  resolveWorkspaceStrategyManagedMonitors,
  workspaceMonitorRecordStorageKey,
  type PreparedWorkspaceMonitorCreate,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import { nextWorkspaceMonitorOccurrence } from "./workspace-monitor-schedule";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  prepareWorkspaceDocumentUpdate,
  prepareWorkspaceStrategyBindingUpdate,
  readWorkspaceDocument,
  validateWorkspaceDocumentValue,
  workspaceDocumentStorageKey,
  type WorkspaceBudgetPolicyValue,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceDocument,
  type WorkspaceStateStoreClient,
  type WorkspaceStrategyBindingValue,
} from "./workspace-state-store";
import {
  hasExactStrategyPackCapabilities,
  resolveInteractiveStrategyPackRuntime,
  StrategyPackRuntimeError,
} from "./strategy-pack-runtime";
import {
  authorizePhotonWorkspaceControlPlaneStore,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import { isReviewedPublicSource } from "./public-source-registry";
import { resolveParameterizedStrategyPackSources } from "./strategy-pack-source-resolution";
import { inspectWorkspaceHybridEvidence } from "./hybrid-evidence-semantic";
import { resolveHybridTaskModelRoute } from "./hybrid-evidence-model-routing";
import { resolveStrategyPackResearchWorkerContract } from "./hybrid-evidence-worker-contract-registry";
import type { WorkspaceSemanticEvidenceStoreClient } from "./hybrid-evidence-semantic-store";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import type { PublicSourceSubscriptionStoreClient } from "./public-source-subscription-store";
import { marketSymbolSchema, strategyPackIntervalMinutes } from "./strategy-pack-schema";
import {
  parseConfirmedXPublicIdentity,
  verifyXPublicIdentityResolutionReceipt,
  xPublicIdentityResolutionReceiptSchema,
} from "./x-public-identity";

const REQUEST_BYTE_LIMIT = 16_384;
const SHARED_HARD_DENIALS = Object.freeze([
  "broker.mutation",
  "filesystem",
  "financial.mutation",
  "provider.mutation",
  "shell",
]);
// An occurrence reserves its whole per-run allowance as the parent envelope and
// every nested semantic child draws from it, so these ceilings must fund a
// strategy's fan-out across the statements in one cadence window rather than a
// single model call. Real money stays bounded by the unchanged paid-per-run,
// paid-per-day, and paid-per-month ceilings; the daily token ceilings are
// coupled to the per-run ceiling because a run whose reservation exceeds the
// daily allowance can never dispatch.
const DEFAULT_BUDGET_CEILINGS = Object.freeze({
  maximumInputTokensPerDay: 1_400_000,
  maximumInputTokensPerRun: 280_000,
  maximumOutputTokensPerDay: 280_000,
  maximumOutputTokensPerRun: 56_000,
  maximumScheduledRunsPerDay: 144,
});

export const strategyPackMutationConfigurationSchema = z.record(
  z.string().min(1).max(80),
  z.union([
    z.string().max(2_000),
    z.array(z.string().max(400)).max(32),
  ]),
).refine((value) => Object.keys(value).length <= 16);

const mutationRequestSchema = z
  .object({
    activateMonitorResourceIds: z.array(z.string().min(2).max(80)).max(16).optional(),
    configuration: strategyPackMutationConfigurationSchema.optional(),
    expectedRegistryRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(80),
    xIdentityResolutionReceipt: xPublicIdentityResolutionReceiptSchema.optional(),
    pack: z
      .object({
        contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        id: z.string().min(1).max(160),
        version: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
      })
      .strict(),
  })
  .strict();

const lifecycleConfirmationSchema = z.literal(true);
const configureRequestSchema = z.object({
  confirmedConsequences: lifecycleConfirmationSchema,
  configuration: strategyPackMutationConfigurationSchema
    .refine((value) => Object.keys(value).length > 0),
  expectedBindingRevision: z.number().int().positive(),
  expectedRegistryRevision: z.number().int().nonnegative(),
}).strict();
const removeRequestSchema = z.object({
  confirmedConsequences: lifecycleConfirmationSchema,
  expectedBindingRevision: z.number().int().positive(),
  expectedRegistryRevision: z.number().int().nonnegative(),
}).strict();

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
    expectedRegistryRevision: z.number().int().nonnegative(),
    issuedAt: z.string().datetime({ offset: true }),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    routingScopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    signature: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceWorkspaceGeneration: z.number().int().positive(),
    sourceWorkspaceId: z.string().uuid(),
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
  readonly monitorClient?: WorkspaceMonitorStoreClient;
  readonly observationSink?: StrategyPackObservationSink;
  readonly stateClient?: WorkspaceStateStoreClient;
  readonly transactionClient?: StrategyPackTransactionClient;
  readonly workspaceClient?: PhotonWorkspaceStoreClient;
  readonly workerModelPolicy?: WorkspaceCapabilityManifestValue["workerModelPolicy"];
}

export class StrategyPackServiceError extends Error {
  readonly code:
    | "strategy_pack_authority_expansion"
    | "strategy_pack_catalog_disabled"
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

type StrategyPackCatalog = typeof strategyPackCatalog;

export interface StrategyPackServiceReadDependencies {
  readonly catalog?: StrategyPackCatalog;
  readonly environment?: NodeJS.ProcessEnv;
}

function requireStrategyPackCatalog(
  dependencies: StrategyPackServiceReadDependencies,
): StrategyPackCatalog {
  if (!resolveStrategyPackFlags(dependencies.environment ?? process.env).catalog) {
    throw new StrategyPackServiceError("strategy_pack_catalog_disabled");
  }
  return dependencies.catalog ?? strategyPackCatalog;
}

export function listStrategyPacks(
  dependencies: StrategyPackServiceReadDependencies = {},
): {
  readonly count: number;
  readonly packs: ReturnType<StrategyPackCatalog["listModelSafe"]>;
} {
  const packs = requireStrategyPackCatalog(dependencies).listModelSafe();
  return Object.freeze({ count: packs.length, packs });
}

export function listLatestStrategyPacks(
  dependencies: StrategyPackServiceReadDependencies = {},
): {
  readonly count: number;
  readonly packs: ReturnType<StrategyPackCatalog["listLatestModelSafe"]>;
} {
  const packs = requireStrategyPackCatalog(dependencies).listLatestModelSafe();
  return Object.freeze({ count: packs.length, packs });
}

function packInspection(pack: StrategyPackCatalogEntry) {
  return Object.freeze({
    availability: pack.availability,
    capabilities: Object.freeze({
      hardDenied: Object.freeze([...pack.capabilities.hardDenied]),
      required: Object.freeze([...pack.capabilities.required]),
    }),
    configuration: Object.freeze(pack.configuration.map((field) =>
      Object.freeze({
        ...("allowedValues" in field
          ? { allowedValues: Object.freeze([...field.allowedValues]) }
          : {}),
        ...(field.kind === "catalog_id_list"
          ? { options: resolveCatalogBackedOptions(field) }
          : {}),
        ...("maximumItems" in field ? {
          maximumItems: field.maximumItems,
          minimumItems: field.minimumItems,
        } : {}),
        ...("maximumCharacters" in field ? {
          maximumCharacters: field.maximumCharacters,
          minimumCharacters: field.minimumCharacters,
        } : {}),
        ...(field.kind === "bounded_token_list" ? { tokenFormat: field.tokenFormat } : {}),
        default: Array.isArray(field.default)
          ? Object.freeze([...field.default])
          : field.default,
        description: field.description,
        key: field.key,
        kind: field.kind,
        label: field.label,
        required: field.required,
      }))),
    contentDigest: pack.contentDigest,
    description: pack.description,
    displayName: pack.displayName,
    evidenceContracts: Object.freeze((pack.evidenceContracts ?? []).map((contract) => Object.freeze({
      digest: contract.digest,
      id: contract.id,
      version: contract.version,
    }))),
    evaluations: Object.freeze({ suiteId: pack.evaluations.suiteId }),
    id: pack.id,
    instructionsIncluded: false as const,
    maturity: pack.maturity,
    monitors: Object.freeze(pack.monitors.map((monitor) => Object.freeze({
      activationDefault: monitor.activationDefault,
      displayName: monitor.displayName,
      resourceId: monitor.resourceId,
      sourceIds: Object.freeze([...monitor.sourceIds]),
    }))),
    sources: Object.freeze(pack.sources.map((source) => Object.freeze({
      accessClassification: source.accessClassification,
      allowedOrigins: Object.freeze([...source.allowedOrigins]),
      canonicalUrl: source.canonicalUrl,
      contractDigest: source.contractDigest,
      contractVersion: source.contractVersion,
      sourceId: source.sourceId,
    }))),
    version: pack.version,
  });
}

export function inspectStrategyPack(
  input: { readonly id: string; readonly version: string },
  dependencies: StrategyPackServiceReadDependencies = {},
): { readonly pack: ReturnType<typeof packInspection> } {
  const pack = requireStrategyPackCatalog(dependencies).resolve(input);
  if (!pack) throw new StrategyPackServiceError("strategy_pack_unavailable");
  return Object.freeze({ pack: packInspection(pack) });
}

export function strategyPackCreateSelectionRequest(
  input: {
    readonly activateMonitorResourceIds?: readonly string[];
    readonly configuration?: Readonly<Record<string, unknown>>;
    readonly expectedRegistryRevision: number;
    readonly name: string;
    readonly packId: string;
    readonly packVersion: string;
    readonly xIdentityResolutionReceipt?: unknown;
  },
  dependencies: StrategyPackServiceReadDependencies = {},
) {
  const pack = requireStrategyPackCatalog(dependencies).resolve({
    id: input.packId,
    version: input.packVersion,
  });
  if (!pack || pack.availability !== "available") {
    throw new StrategyPackServiceError("strategy_pack_unavailable");
  }
  return Object.freeze({
    ...(input.activateMonitorResourceIds
      ? { activateMonitorResourceIds: [...input.activateMonitorResourceIds] }
      : {}),
    ...(input.configuration ? { configuration: { ...input.configuration } } : {}),
    expectedRegistryRevision: input.expectedRegistryRevision,
    name: normalizeStrategyPackWorkspaceName(input.name),
    pack: Object.freeze({
      contentDigest: pack.contentDigest,
      id: pack.id,
      version: pack.version,
    }),
    ...(input.xIdentityResolutionReceipt
      ? { xIdentityResolutionReceipt: input.xIdentityResolutionReceipt }
      : {}),
  });
}

function normalizeStrategyPackWorkspaceName(name: string): string {
  try {
    return normalizePhotonWorkspaceName(name);
  } catch (cause) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request", { cause });
  }
}

export function strategyPackConfigureSelectionRequest(input: {
  readonly confirmedConsequences: true;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly expectedBindingRevision: number;
  readonly expectedRegistryRevision: number;
}) {
  const parsed = configureRequestSchema.safeParse({
    confirmedConsequences: input.confirmedConsequences,
    configuration: input.configuration,
    expectedBindingRevision: input.expectedBindingRevision,
    expectedRegistryRevision: input.expectedRegistryRevision,
  });
  if (!parsed.success) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  return Object.freeze({
    ...parsed.data,
    configuration: Object.freeze({ ...parsed.data.configuration }),
  });
}

export function strategyPackRemoveSelectionRequest(input: {
  readonly confirmedConsequences: true;
  readonly expectedBindingRevision: number;
  readonly expectedRegistryRevision: number;
}) {
  const parsed = removeRequestSchema.safeParse({
    confirmedConsequences: input.confirmedConsequences,
    expectedBindingRevision: input.expectedBindingRevision,
    expectedRegistryRevision: input.expectedRegistryRevision,
  });
  if (!parsed.success) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  return Object.freeze(parsed.data);
}

export async function createStrategyPackWorkspaceFromSelection(
  input: {
    readonly activateMonitorResourceIds?: readonly string[];
    readonly configuration?: Readonly<Record<string, unknown>>;
    readonly expectedRegistryRevision: number;
    readonly name: string;
    readonly now?: Date;
    readonly packId: string;
    readonly packVersion: string;
    readonly principalId: string;
    readonly requestIdentity: unknown;
    readonly sourceAssignment: { readonly generation: number; readonly workspaceId: string };
    readonly threadId: string;
    readonly xIdentityResolutionReceipt?: unknown;
  },
  dependencies: StrategyPackServiceDependencies,
): Promise<{ receipt: StrategyPackMutationReceipt; replayed: boolean }> {
  const request = strategyPackCreateSelectionRequest(input, dependencies);
  return createStrategyPackWorkspace({
    now: input.now,
    principalId: input.principalId,
    request,
    requestIdentity: input.requestIdentity,
    sourceAssignment: input.sourceAssignment,
    threadId: input.threadId,
  }, dependencies);
}

export interface StrategyPackWorkspaceInspectionDependencies
  extends StrategyPackServiceReadDependencies {
  readonly hybridSemanticClient?: WorkspaceSemanticEvidenceStoreClient;
  readonly monitorClient?: WorkspaceMonitorStoreClient;
  readonly publicSourceAcquisitionClient?: PublicSourceAcquisitionStoreClient;
  readonly publicSourceSubscriptionClient?: PublicSourceSubscriptionStoreClient;
  readonly stateClient?: WorkspaceStateStoreClient;
}

function availableCapabilityIds(
  capabilities: WorkspaceCapabilityManifestValue | null,
): Set<string> {
  if (!capabilities) return new Set();
  return new Set([
    ...capabilities.controlPlaneToolIds,
    ...capabilities.financialToolIds,
    ...capabilities.researchToolIds,
    ...capabilities.providerTools.map(({ toolId }) => toolId),
    ...capabilities.skills.map(({ id }) => `skill.${id}`),
  ]);
}

export async function inspectStrategyPackWorkspace(
  input: {
    readonly scope: AuthorizedWorkspaceStoreScope;
    readonly workspaceGeneration: number;
  },
  dependencies: StrategyPackWorkspaceInspectionDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  const catalog = requireStrategyPackCatalog({
    catalog: dependencies.catalog,
    environment,
  });
  const monitors = await listWorkspaceMonitors(input.scope, dependencies.monitorClient);
  const [strategy, capabilities, hybridEvidence] = await Promise.all([
    readWorkspaceDocument("strategy", input.scope, dependencies.stateClient),
    readWorkspaceDocument("capabilities", input.scope, dependencies.stateClient),
    inspectWorkspaceHybridEvidence({
      environment,
      scope: input.scope,
      sourceReferences: monitors.flatMap((monitor) => monitor.publicSourceSubscriptions ?? []),
    }, {
      acquisition: dependencies.publicSourceAcquisitionClient,
      semantic: dependencies.hybridSemanticClient,
      state: dependencies.stateClient,
      subscription: dependencies.publicSourceSubscriptionClient,
    }),
  ]);
  if (!strategy) {
    return Object.freeze({
      reasonCode: "strategy_pack_state_missing" as const,
      state: "unavailable" as const,
    });
  }
  if (strategy.schemaVersion === 1) {
    if (
      strategy.value.strategyPack === null &&
      Object.keys(strategy.value.configuration).length === 0
    ) {
      return Object.freeze({ reasonCode: null, state: "unbound" as const });
    }
    return Object.freeze({
      legacyPack: strategy.value.strategyPack,
      reasonCode: "legacy_unverified" as const,
      state: "unavailable" as const,
    });
  }
  const binding = strategy.value;
  if (binding.lifecycleState === "unbound") {
    return Object.freeze({ reasonCode: null, state: "unbound" as const });
  }
  const packReference = binding.pack;
  const exactPack = packReference?.contentDigest
    ? catalog.resolve({
        contentDigest: packReference.contentDigest,
        id: packReference.id,
        version: packReference.version,
      })
    : null;
  let runtimeReason: string | null = null;
  try {
    await resolveInteractiveStrategyPackRuntime({
      catalog,
      environment,
      scope: input.scope,
      stateClient: dependencies.stateClient,
      workspaceGeneration: input.workspaceGeneration,
    });
  } catch (error) {
    if (!(error instanceof StrategyPackRuntimeError)) throw error;
    runtimeReason = error.code;
  }
  const capabilityIds = availableCapabilityIds(capabilities?.value ?? null);
  const monitorById = new Map(monitors.map((monitor) => [monitor.monitorId, monitor]));
  const managedMonitors = Object.entries(binding.managedResources).map(
    ([resourceId, resource]) => {
      const monitor = monitorById.get(resource.monitorId);
      return Object.freeze({
        configurationRevision: monitor?.configurationRevision ?? null,
        lastCompletedAt: monitor?.lastCompletedAt ?? null,
        lastErrorCode: monitor?.lastErrorCode ?? "managed_monitor_missing",
        lastRunAt: monitor?.lastRunAt ?? null,
        lifecycleState: monitor?.lifecycleState ?? "unavailable",
        monitorId: resource.monitorId,
        name: monitor?.name ?? resourceId,
        nextOccurrenceAt: monitor?.nextOccurrenceAt ?? null,
        resourceId,
        schedule: monitor?.schedule ?? null,
        sourceIds: Object.freeze([...resource.sourceIds]),
      });
    },
  );
  const healthy =
    binding.lifecycleState === "active" &&
    binding.health.status === "healthy" &&
    binding.health.code === null &&
    exactPack?.availability === "available" &&
    runtimeReason === null;
  return Object.freeze({
    bindingRevision: binding.bindingRevision,
    capabilities: Object.freeze((exactPack?.capabilities.required ?? []).map((id) =>
      Object.freeze({ id, status: capabilityIds.has(id) ? "available" as const : "denied" as const }))),
    configuration: Object.freeze(structuredClone(binding.configuration)),
    health: Object.freeze({
      checkedAt: binding.health.checkedAt,
      status: healthy ? "healthy" as const : "unavailable" as const,
    }),
    hybridEvidence,
    managedMonitors: Object.freeze(managedMonitors),
    pack: exactPack
      ? packInspection(exactPack)
      : packReference
        ? Object.freeze({
            contentDigest: packReference.contentDigest,
            id: packReference.id,
            version: packReference.version,
          })
        : null,
    reasonCode: healthy
      ? null
      : binding.health.code ?? runtimeReason ?? "strategy_pack_exact_version_unavailable",
    sources: Object.freeze((exactPack?.sources ?? []).map((source) => {
      const available = capabilities?.value.sources.some((candidate) =>
        candidate.sourceId === source.sourceId &&
        "contractDigest" in candidate &&
        candidate.contractDigest === source.contractDigest,
      ) ?? false;
      return Object.freeze({
        canonicalUrl: source.canonicalUrl,
        sourceId: source.sourceId,
        status: available ? "available" as const : "denied" as const,
      });
    })),
    state: healthy ? "active" as const : "unavailable" as const,
  });
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
  expectedRegistryRevision: number;
  issuedAt: string;
  nonce: string;
  routingScopeDigest: string;
  sourceWorkspaceGeneration: number;
  sourceWorkspaceId: string;
}): string {
  return canonicalJson({
    actionId: input.actionId,
    expectedRegistryRevision: input.expectedRegistryRevision,
    issuedAt: input.issuedAt,
    nonce: input.nonce,
    routingScopeDigest: input.routingScopeDigest,
    sourceWorkspaceGeneration: input.sourceWorkspaceGeneration,
    sourceWorkspaceId: input.sourceWorkspaceId,
    transport: "spectrum",
  });
}

export function mintSpectrumStrategyPackMutationIdentity(
  input: {
    actionId: string;
    expectedRegistryRevision: number;
    issuedAt: Date;
    nonce: string;
    principalId: string;
    sourceWorkspaceGeneration: number;
    sourceWorkspaceId: string;
    threadId: string;
  },
  secret: string,
): StrategyPackMutationIdentity {
  if (secret.length < 32) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  const unsigned = {
    actionId: input.actionId,
    expectedRegistryRevision: input.expectedRegistryRevision,
    issuedAt: input.issuedAt.toISOString(),
    nonce: input.nonce,
    routingScopeDigest: sha256(`strategy-pack-spectrum\0${input.principalId}\0${input.threadId}`),
    sourceWorkspaceGeneration: input.sourceWorkspaceGeneration,
    sourceWorkspaceId: input.sourceWorkspaceId,
  };
  const signature = createHmac("sha256", secret).update(spectrumUnsigned(unsigned)).digest("hex");
  const parsed = spectrumIdentitySchema.safeParse({ ...unsigned, signature, transport: "spectrum" });
  if (!parsed.success) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  return trusted(parsed.data);
}

export function verifySpectrumStrategyPackMutationIdentity(
  value: unknown,
  secret: string,
  now: Date = new Date(),
): StrategyPackMutationIdentity {
  const parsed = spectrumIdentitySchema.safeParse(value);
  if (
    !parsed.success ||
    secret.length < 32 ||
    now.getTime() - new Date(parsed.data.issuedAt).getTime() > 15 * 60 * 1_000 ||
    new Date(parsed.data.issuedAt).getTime() - now.getTime() > 60 * 1_000
  ) {
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

function assertMutationIdentityScope(input: {
  identity: StrategyPackMutationIdentity;
  principalId: string;
  sourceAssignment: { generation: number; workspaceId: string };
  threadId: string;
  expectedRegistryRevision: number;
}): void {
  if (input.identity.transport !== "spectrum") return;
  if (
    input.identity.routingScopeDigest !==
      sha256(`strategy-pack-spectrum\0${input.principalId}\0${input.threadId}`) ||
    input.identity.sourceWorkspaceId !== input.sourceAssignment.workspaceId ||
    input.identity.sourceWorkspaceGeneration !== input.sourceAssignment.generation ||
    input.identity.expectedRegistryRevision !== input.expectedRegistryRevision
  ) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
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
  return {
    payloadDigest: sha256(encoded),
    request: {
      ...parsed.data,
      name: normalizeStrategyPackWorkspaceName(parsed.data.name),
    },
  };
}

function parseLifecycleRequest<T>(value: unknown, schema: z.ZodType<T>) {
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  if (Buffer.byteLength(encoded, "utf8") > REQUEST_BYTE_LIMIT) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  return { payloadDigest: sha256(encoded), request: parsed.data };
}

export function resolveStrategyPackConfiguration(
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
    if (field.kind === "bounded_enum") {
      if (typeof value !== "string" || !field.allowedValues.includes(value)) {
        throw new StrategyPackServiceError("strategy_pack_invalid_request");
      }
      configuration[field.key] = value;
      if (supplied) ownerOverrides[field.key] = value;
      continue;
    }
    if (field.kind === "bounded_text") {
      if (
        typeof value !== "string" ||
        value.trim() !== value ||
        value.length < field.minimumCharacters ||
        value.length > field.maximumCharacters
      ) throw new StrategyPackServiceError("strategy_pack_invalid_request");
      configuration[field.key] = value;
      if (supplied) ownerOverrides[field.key] = value;
      continue;
    }
    if (field.kind === "x_public_identity") {
      let identity;
      try {
        identity = parseConfirmedXPublicIdentity(value);
      } catch {
        throw new StrategyPackServiceError("strategy_pack_invalid_request");
      }
      const storedIdentity = [
        identity.profileUrl,
        identity.username,
        identity.displayName,
        identity.numericUserId,
        "confirmed",
      ];
      configuration[field.key] = storedIdentity;
      if (supplied) ownerOverrides[field.key] = storedIdentity;
      continue;
    }
    const normalizedValue = field.kind === "bounded_token_list" && Array.isArray(value)
      ? value.map((entry) => typeof entry === "string" ? entry.trim().toUpperCase() : entry)
        .sort((left, right) => typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right)
          : 0)
      : value;
    if (
      !Array.isArray(normalizedValue) ||
      normalizedValue.length < field.minimumItems ||
      normalizedValue.length > field.maximumItems ||
      normalizedValue.some((entry) => typeof entry !== "string") ||
      new Set(normalizedValue).size !== normalizedValue.length ||
      normalizedValue.some((entry, index) => index > 0 && normalizedValue[index - 1]! > entry)
    ) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
    if (
      field.kind === "daily_local_times"
        ? normalizedValue.some((entry) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(entry))
        : field.kind === "catalog_id_list"
          ? (() => {
              try {
                assertCatalogBackedValues(field, normalizedValue as string[]);
                return false;
              } catch {
                return true;
              }
            })()
          : field.kind === "bounded_token_list"
            ? normalizedValue.some((entry) => !marketSymbolSchema.safeParse(entry).success)
            : field.kind === "impact_hypothesis_list"
              ? normalizedValue.some((entry) => !/^.{1,200}\|[A-Z][A-Z0-9.-]{0,15}\|(?:up|down)$/u.test(entry))
              : field.kind === "bounded_text_list"
                ? normalizedValue.some((entry) => entry.trim() !== entry || entry.length < 1 || entry.length > 400)
            : normalizedValue.some((entry) => !field.allowedValues.includes(entry))
    ) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
    configuration[field.key] = normalizedValue as string[];
    if (supplied) ownerOverrides[field.key] = normalizedValue as string[];
  }
  return { configuration, ownerOverrides };
}

export function resolveStrategyPackSourceInstances(
  pack: StrategyPackCatalogEntry,
  configuration: Readonly<Record<string, string | string[]>>,
  logicalSourceIds: readonly string[] = pack.sources.map(({ sourceId }) => sourceId),
): readonly Readonly<{
  accessClassification: "public";
  allowedOrigins: readonly string[];
  canonicalUrl: string;
  contractDigest: string;
  contractVersion: string;
  sourceId: string;
}>[] {
  try {
    return resolveParameterizedStrategyPackSources(pack, configuration, logicalSourceIds);
  } catch (cause) {
    throw new StrategyPackServiceError("strategy_pack_unavailable", { cause });
  }
}

function effectiveCapabilities(
  pack: StrategyPackCatalogEntry,
  configuration: Readonly<Record<string, string | string[]>>,
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
    paidResearchAllowed: resolveStrategyPackResearchWorkerContract(pack) !== null,
    providerTools: [],
    researchToolIds: researchToolIds.sort(),
    skills: pack.skills.map(({ id, version }) => ({ id, version })),
    sources: resolveStrategyPackSourceInstances(pack, configuration).map((source) => ({
      allowedOrigins: [...source.allowedOrigins],
      contractDigest: source.contractDigest,
      contractVersion: source.contractVersion,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
    workerModelPolicy,
  };
}

export function resolveStrategyPackWorkerModelPolicy(input: {
  environment: NodeJS.ProcessEnv;
  fallback?: WorkspaceCapabilityManifestValue["workerModelPolicy"];
  pack: StrategyPackCatalogEntry;
}): WorkspaceCapabilityManifestValue["workerModelPolicy"] {
  if (
    input.pack.capabilities.required.includes("evaluate_public_commentary_signals") ||
    resolveStrategyPackResearchWorkerContract(input.pack) !== null
  ) {
    const workerModelId =
      input.environment.EVE_STRATEGY_PACK_WORKER_MODEL_ID ?? "google/gemini-3.6-flash";
    const semanticModelId = resolveHybridTaskModelRoute(
      "semantic_interpretation",
      input.environment,
    ).modelId;
    return {
      allowedModelIds: [...new Set([workerModelId, semanticModelId])],
      maximumOutputTokens: input.fallback?.maximumOutputTokens ?? 12_000,
    };
  }
  return input.fallback ?? {
    allowedModelIds: [
      input.environment.EVE_STRATEGY_PACK_WORKER_MODEL_ID ?? "google/gemini-3.6-flash",
    ],
    maximumOutputTokens: 12_000,
  };
}

/*
 * A pack that declares a pinned public X identity may never install on its
 * default: the owner must have resolved that handle in this same thread and
 * confirmed the numeric user ID, and the create request must carry the receipt
 * that proves it. The declared configuration kind selects that rule, so any
 * pack pinning an identity is covered without naming the pack.
 */
export function strategyPackPinnedXIdentityFields(
  pack: Pick<StrategyPackCatalogEntry, "configuration">,
): readonly StrategyPackCatalogEntry["configuration"][number][] {
  return pack.configuration.filter((field) => field.kind === "x_public_identity");
}

export function resolveStrategyPackInitialBudgetPolicy(
  pack: StrategyPackCatalogEntry,
  configuration: Record<string, string | string[]>,
  now: string,
  ceilings: typeof DEFAULT_BUDGET_CEILINGS = DEFAULT_BUDGET_CEILINGS,
): WorkspaceBudgetPolicyValue {
  /*
   * A pack's declared source can be a placeholder that configuration resolves
   * elsewhere: the commentary tracker declares a first-party feed but resolves
   * to a paid X timeline whenever the sensitive-event gate does not divert it.
   * Size the paid ceilings from the sources this configuration actually
   * resolves, or the first occurrence reserves a paid timeline read against a
   * policy with no paid ceiling and fails as budget_policy_unresolved.
   */
  const resolvedSources = (() => {
    try {
      return resolveStrategyPackSourceInstances(pack, configuration);
    } catch {
      return pack.sources;
    }
  })();
  const usesPaidXTimeline = resolvedSources.some((source) =>
    source.allowedOrigins.includes("https://api.x.com")
  );
  const researchBudget = resolveStrategyPackResearchWorkerContract(pack)?.research?.budget ?? null;
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
    maximumConcurrentWorkers: usesPaidXTimeline ? 2 : 1,
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
    maximumPaidPerCall: usesPaidXTimeline
      ? "1.000000"
      : researchBudget
        ? researchBudget.maximumPaidPerCall
        : null,
    maximumPaidPerDay: usesPaidXTimeline
      ? researchBudget
        ? (Number(researchBudget.maximumPaidPerDay) > 2
            ? researchBudget.maximumPaidPerDay
            : "2.000000")
        : "2.000000"
      : researchBudget
        ? researchBudget.maximumPaidPerDay
        : null,
    maximumPaidPerMonth: usesPaidXTimeline
      ? "10.000000"
      : researchBudget
        ? researchBudget.maximumPaidPerMonth
        : null,
    maximumScheduledRunsPerDay: requestedRunsPerDay,
    ownerTimezone: typeof ownerTimezone === "string" ? ownerTimezone : "UTC",
    unknownPriceFallbackCeiling: researchBudget
      ? researchBudget.unknownPriceFallbackCeiling
      : "0",
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

function normalizeStrategyPackTransactionError(error: unknown): Error {
  return error instanceof StrategyPackServiceError ||
      error instanceof StrategyPackTransactionStorageError
    ? error
    : classifyStrategyPackTransactionStorageError(error);
}

async function readStrategyPackCreateReplay(
  transactionClient: StrategyPackTransactionClient,
  input: Parameters<StrategyPackTransactionClient["readReplay"]>[0],
) {
  try {
    return await transactionClient.readReplay(input);
  } catch (error) {
    throw normalizeStrategyPackTransactionError(error);
  }
}

async function recoverStrategyPackCreateReplay(
  transactionClient: StrategyPackTransactionClient,
  input: Parameters<StrategyPackTransactionClient["readReplay"]>[0],
  primaryError: Error,
) {
  try {
    return await readStrategyPackCreateReplay(transactionClient, input);
  } catch {
    throw primaryError;
  }
}

function rejectionReceipt(input: {
  code:
    | "capacity_exhausted"
    | "duplicate_name"
    | "retained_capacity_exhausted";
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

export function resolveStrategyPackIntervalMinutes(value: string): number {
  const minutes = strategyPackIntervalMinutes(value);
  if (minutes === null) throw new StrategyPackServiceError("strategy_pack_invalid_request");
  return minutes;
}

function strategyPackMonitorSchedule(
  monitor: StrategyPackCatalogEntry["monitors"][number],
  configuration: Record<string, string | string[]>,
  now: Date,
) {
  if ("intervalMinutesConfigurationKey" in monitor) {
    const configured = configuration[monitor.intervalMinutesConfigurationKey];
    if (typeof configured !== "string") throw new StrategyPackServiceError("strategy_pack_invalid_request");
    return {
      anchor: now.toISOString(),
      everyMinutes: resolveStrategyPackIntervalMinutes(configured),
      kind: "interval" as const,
    };
  }
  const timezone = configuration[monitor.timezoneConfigurationKey];
  const times = configuration[monitor.dailyTimesConfigurationKey];
  if (typeof timezone !== "string" || !Array.isArray(times)) {
    throw new StrategyPackServiceError("strategy_pack_invalid_request");
  }
  return { kind: "daily_local" as const, times: [...times], timezone };
}

export function resolveStrategyPackInitialMonitorDueAt(input: Readonly<{
  activate: boolean;
  lifecycleContractId?: string | null;
  managedBy?: Readonly<{ packId: string; packVersion: string; resourceId: string }> | null;
  now: Date;
  scheduledAt: string | null;
}>): string | null {
  return input.activate &&
      resolveManagedMonitorLifecycleContract({
        lifecycleContractId: input.lifecycleContractId,
        managedBy: input.managedBy,
      })
        ?.initialOccurrence === "immediate"
    ? input.now.toISOString()
    : input.scheduledAt;
}

function monitorPreparations(input: {
  activate: Set<string>;
  budget: WorkspaceBudgetPolicyValue;
  configuration: Record<string, string | string[]>;
  deliverySubscriptionId: string;
  now: Date;
  pack: StrategyPackCatalogEntry;
  scope: AuthorizedWorkspaceStoreScope;
}): PreparedWorkspaceMonitorCreate[] {
  return input.pack.monitors.map((monitor) => {
    const lifecycle = resolveManagedMonitorLifecycleContract({
      lifecycleContractId: monitor.lifecycleContractId,
      managedBy: {
        packId: input.pack.id,
        packVersion: input.pack.version,
        resourceId: monitor.resourceId,
      },
    });
    if (monitor.lifecycleContractId && lifecycle?.id !== monitor.lifecycleContractId) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
    const schedule = strategyPackMonitorSchedule(
      monitor,
      input.configuration,
      input.now,
    );
    const next = nextWorkspaceMonitorOccurrence(schedule, input.now);
    const sources = resolveStrategyPackSourceInstances(
      input.pack,
      input.configuration,
      monitor.sourceIds,
    ).map((source) => {
      return {
        accessClassification: source.accessClassification,
        canonicalUrl: source.canonicalUrl,
        origin: new URL(source.canonicalUrl).origin,
        sourceId: source.sourceId,
      };
    });
    return prepareWorkspaceMonitorCreate({
      activateManagedMonitor: input.activate.has(monitor.resourceId),
      deliverySubscriptionId: input.deliverySubscriptionId,
      idempotencyKey: `strategy-pack:${input.pack.contentDigest}:${monitor.resourceId}`,
      instruction: monitor.instruction,
      ...(lifecycle ? { lifecycleContractId: lifecycle.id } : {}),
      managedBy: {
        bindingRevision: 1,
        kind: "strategy_pack",
        packContentDigest: input.pack.contentDigest,
        packId: input.pack.id,
        packVersion: input.pack.version,
        resourceId: monitor.resourceId,
      },
      name: monitor.displayName,
      nextOccurrenceAt: resolveStrategyPackInitialMonitorDueAt({
        activate: input.activate.has(monitor.resourceId),
        lifecycleContractId: lifecycle?.id,
        managedBy: {
          packId: input.pack.id,
          packVersion: input.pack.version,
          resourceId: monitor.resourceId,
        },
        now: input.now,
        scheduledAt: next?.scheduledAt ?? null,
      }),
      now: input.now,
      publicSourceIds: sources.map(({ sourceId }) => sourceId).filter(isReviewedPublicSource),
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
        paidPerRun: resolveStrategyPackResearchWorkerContract(input.pack)?.research?.budget.paidPerRun ?? null,
      },
    });
  });
}

async function executeCreateStrategyPackWorkspace(
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
  let approvalPending: unknown;
  try {
    approvalPending = await transactionClient.get(approvalGuardKey);
  } catch (error) {
    throw normalizeStrategyPackTransactionError(error);
  }
  if (approvalPending) {
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
  assertMutationIdentityScope({
    expectedRegistryRevision: request.expectedRegistryRevision,
    identity,
    principalId: input.principalId,
    sourceAssignment: sourceAssignment.data,
    threadId: input.threadId,
  });
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
  const replay = await readStrategyPackCreateReplay(transactionClient, replayInput);
  const expectedReceipt = { mutationId, payloadDigest, requestIdentityDigest };
  if (replay.status === "replayed") {
    return receiptResult(replay.receiptRaw, true, expectedReceipt);
  }
  if (replay.status !== "missing") transactionError(replay.status);

  const client = dependencies.workspaceClient ?? photonWorkspaceStoreClient();
  let registryRecord: Awaited<ReturnType<typeof readPhotonWorkspaceRegistryRecord>>;
  try {
    registryRecord = await readPhotonWorkspaceRegistryRecord(input, client);
  } catch (error) {
    throw normalizeStrategyPackTransactionError(error);
  }
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
  const configuration = resolveStrategyPackConfiguration(pack, request.configuration);
  for (const field of strategyPackPinnedXIdentityFields(pack)) {
    if (
      !request.configuration ||
      !Object.prototype.hasOwnProperty.call(request.configuration, field.key)
    ) throw new StrategyPackServiceError("strategy_pack_invalid_request");
    const identity = parseConfirmedXPublicIdentity(configuration.configuration[field.key]);
    const secret = environment.EVE_OWNER_ALIAS_HMAC_SECRET;
    if (!secret || secret.length < 32) throw new StrategyPackServiceError("strategy_pack_mutations_disabled");
    try {
      verifyXPublicIdentityResolutionReceipt(
        request.xIdentityResolutionReceipt,
        identity,
        { now: input.now, principalId: input.principalId, threadId: input.threadId },
        secret,
      );
    } catch {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
  }
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
    const requiredScheduleKeys = "intervalMinutesConfigurationKey" in monitor
      ? [monitor.intervalMinutesConfigurationKey]
      : [monitor.timezoneConfigurationKey, monitor.dailyTimesConfigurationKey];
    if (!request.configuration || requiredScheduleKeys.some((key) =>
      !Object.prototype.hasOwnProperty.call(request.configuration, key))) {
      throw new StrategyPackServiceError("strategy_pack_invalid_request");
    }
  }
  const capabilities = effectiveCapabilities(
    pack,
    configuration.configuration,
    dependencies.capabilityInventory,
    dependencies.workerModelPolicy ?? resolveStrategyPackWorkerModelPolicy({
      environment,
      pack,
    }),
  );
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const targetWorkspaceId = (dependencies.idFactory ?? randomUUID)();
  let rejectionCode:
    | "capacity_exhausted"
    | "duplicate_name"
    | "retained_capacity_exhausted"
    | null = null;
  if (
    activePhotonWorkspaceCount(registryRecord.registry) >= PHOTON_WORKSPACE_LIMIT
  ) {
    rejectionCode = "capacity_exhausted";
  } else if (
    registryRecord.registry.workspaces.length >= PHOTON_WORKSPACE_RETAINED_LIMIT
  ) {
    rejectionCode = "retained_capacity_exhausted";
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
      const primaryError = normalizeStrategyPackTransactionError(error);
      const recovered = await recoverStrategyPackCreateReplay(
        transactionClient,
        replayInput,
        primaryError,
      );
      if (recovered.status === "replayed") {
        return receiptResult(recovered.receiptRaw, true, expectedReceipt);
      }
      throw primaryError;
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
  const budget = resolveStrategyPackInitialBudgetPolicy(
    pack,
    configuration.configuration,
    nowIso,
    dependencies.budgetCeilings ?? DEFAULT_BUDGET_CEILINGS,
  );
  const monitors = monitorPreparations({
    activate: new Set(requestedActivation),
    budget,
    configuration: configuration.configuration,
    deliverySubscriptionId: resolvePhotonOwnerConversationIdentity({
      principalId: input.principalId,
      threadId: input.threadId,
    }, environment).conversationId,
    now,
    pack,
    scope: targetScope,
  });
  const managedResources = Object.fromEntries(
    pack.monitors.map((monitor, index) => [
      monitor.resourceId,
      {
        monitorId: monitors[index]!.monitor.monitorId,
        ...(monitors[index]!.monitor.publicSourceSubscriptions === undefined
          ? {}
          : {
              publicSourceSubscriptions:
                monitors[index]!.monitor.publicSourceSubscriptions,
            }),
        sourceIds: resolveStrategyPackSourceInstances(
          pack,
          configuration.configuration,
          monitor.sourceIds,
        ).map(({ sourceId }) => sourceId).sort(),
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
          allowedSourceIds: resolveStrategyPackSourceInstances(
            pack,
            configuration.configuration,
          ).map(({ sourceId }) => sourceId),
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
    const primaryError = normalizeStrategyPackTransactionError(error);
    const recovered = await recoverStrategyPackCreateReplay(
      transactionClient,
      replayInput,
      primaryError,
    );
    if (recovered.status === "replayed") {
      return receiptResult(recovered.receiptRaw, true, expectedReceipt);
    }
    throw primaryError;
  }
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
  try {
    const result = await executeCreateStrategyPackWorkspace(input, dependencies);
    emitStrategyPackObservation({
      counter: "strategy_pack_install_total",
      outcome: result.replayed
        ? "replayed"
        : result.receipt.outcome === "rejected"
          ? "rejected"
          : "committed",
    }, dependencies.observationSink);
    return result;
  } catch (error) {
    emitStrategyPackObservation({
      counter: error instanceof StrategyPackServiceError &&
          (error.code === "strategy_pack_mutation_conflict" ||
            error.code === "strategy_pack_mutation_payload_conflict" ||
            error.code === "strategy_pack_source_assignment_stale")
        ? "strategy_pack_mutation_conflict_total"
        : "strategy_pack_mutation_failure_total",
      reasonCode: safeStrategyPackReasonCode(error),
    }, dependencies.observationSink);
    throw error;
  }
}

type StrategyPackLifecycleAction = "configure" | "remove";

function storedRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function lifecycleMonitorSchedule(
  pack: StrategyPackCatalogEntry,
  configuration: Record<string, string | string[]>,
  resourceId: string,
  now: Date,
) {
  const resource = pack.monitors.find((monitor) => monitor.resourceId === resourceId);
  if (!resource) throw new StrategyPackServiceError("strategy_pack_unavailable");
  return strategyPackMonitorSchedule(resource, configuration, now);
}

function unboundCapabilities(
  current: WorkspaceCapabilityManifestValue,
): WorkspaceCapabilityManifestValue {
  return {
    connectionIds: [],
    controlPlaneToolIds: [],
    financialToolIds: [],
    hardDeniedCapabilityIds: [...new Set([
      ...SHARED_HARD_DENIALS,
      ...current.hardDeniedCapabilityIds,
    ])].sort(),
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: [],
    skills: [],
    sources: [],
    workerModelPolicy: current.workerModelPolicy,
  };
}

async function mutateStrategyPackWorkspace(
  action: StrategyPackLifecycleAction,
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
  const parsed = action === "configure"
    ? parseLifecycleRequest(input.request, configureRequestSchema)
    : parseLifecycleRequest(input.request, removeRequestSchema);
  const request = parsed.request;
  const identity = parseIdentity(input.requestIdentity);
  assertMutationIdentityScope({
    expectedRegistryRevision: request.expectedRegistryRevision,
    identity,
    principalId: input.principalId,
    sourceAssignment: sourceAssignment.data,
    threadId: input.threadId,
  });
  const requestIdentityDigest = sha256(canonicalJson(identity));
  const sourceAssignmentDigest = sha256(canonicalJson(sourceAssignment.data));
  const mutationId = sha256(
    `strategy-pack-${action}\0${requestIdentityDigest}\0${parsed.payloadDigest}\0${sourceAssignmentDigest}`,
  );
  const scope = authorizePhotonWorkspaceControlPlaneStore({
    principalId: input.principalId,
    resource: "manager",
    workspaceId: sourceAssignment.data.workspaceId,
  }, environment);
  const keys = strategyPackMutationStorageKeys({
    ownerId: scope.ownerId,
    principalId: input.principalId,
    requestIdentityDigest,
    threadId: input.threadId,
  });
  const mappingRaw = canonicalJson({
    mutationId,
    payloadDigest: parsed.payloadDigest,
    requestIdentityDigest,
    schemaVersion: 1,
    sourceAssignmentDigest,
  });
  const receiptKey = keys.receiptKey(mutationId);
  const replayInput = { approvalGuardKey, mappingKey: keys.mappingKey, mappingRaw, receiptKey };
  const expectedReceipt = {
    mutationId,
    payloadDigest: parsed.payloadDigest,
    requestIdentityDigest,
  };
  const replay = await transactionClient.readReplay(replayInput);
  if (replay.status === "replayed") {
    return receiptResult(replay.receiptRaw, true, expectedReceipt);
  }
  if (replay.status !== "missing") transactionError(replay.status);

  const registryRecord = await readPhotonWorkspaceRegistryRecord(
    input,
    dependencies.workspaceClient ?? photonWorkspaceStoreClient(),
  );
  if (registryRecord.registry.revision !== request.expectedRegistryRevision) {
    throw new StrategyPackServiceError("strategy_pack_mutation_conflict");
  }
  const workspace = registryRecord.registry.workspaces.find(
    (candidate) => candidate.id === sourceAssignment.data.workspaceId,
  );
  if (
    !workspace ||
    workspace.status !== "active" ||
    workspace.generation !== sourceAssignment.data.generation
  ) {
    throw new StrategyPackServiceError("strategy_pack_source_assignment_stale");
  }

  const documentKinds = ["strategy", "capabilities", "brief", "budget"] as const;
  const documentRaws = await Promise.all(documentKinds.map(async (kind) => ({
    kind,
    key: workspaceDocumentStorageKey(kind, scope),
    raw: storedRaw(await transactionClient.get(workspaceDocumentStorageKey(kind, scope))),
  })));
  if (documentRaws.some(({ raw }) => raw === null)) {
    throw new StrategyPackServiceError("strategy_pack_unavailable");
  }
  const rawByKind = Object.fromEntries(
    documentRaws.map(({ kind, raw }) => [kind, raw!]),
  ) as Record<(typeof documentKinds)[number], string>;
  let strategy: WorkspaceDocument<"strategy">;
  let capabilities: WorkspaceDocument<"capabilities">;
  let brief: WorkspaceDocument<"brief">;
  let budget: WorkspaceDocument<"budget">;
  try {
    strategy = validateWorkspaceDocumentValue("strategy", rawByKind.strategy, scope);
    capabilities = validateWorkspaceDocumentValue("capabilities", rawByKind.capabilities, scope);
    brief = validateWorkspaceDocumentValue("brief", rawByKind.brief, scope);
    budget = validateWorkspaceDocumentValue("budget", rawByKind.budget, scope);
  } catch (cause) {
    throw new StrategyPackServiceError("strategy_pack_unavailable", { cause });
  }
  if (
    strategy.schemaVersion !== 2 ||
    strategy.value.lifecycleState === "unbound" ||
    strategy.value.bindingRevision !== request.expectedBindingRevision
  ) {
    throw new StrategyPackServiceError("strategy_pack_mutation_conflict");
  }
  const binding = strategy.value;
  const allMonitors = await listWorkspaceMonitors(scope, dependencies.monitorClient);
  let managedMonitors: WorkspaceMonitor[];
  try {
    managedMonitors = resolveWorkspaceStrategyManagedMonitors(binding, allMonitors);
  } catch (cause) {
    throw new StrategyPackServiceError("strategy_pack_unavailable", { cause });
  }
  const monitorRaws = new Map<string, string>();
  for (const monitor of managedMonitors) {
    const raw = storedRaw(await transactionClient.get(
      workspaceMonitorRecordStorageKey(scope, monitor.monitorId),
    ));
    if (raw === null || raw !== JSON.stringify(monitor)) {
      throw new StrategyPackServiceError("strategy_pack_mutation_conflict");
    }
    monitorRaws.set(monitor.monitorId, raw);
  }

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const nextBindingRevision = binding.bindingRevision + 1;
  const rolled = preparePhotonWorkspaceGenerationRollover({
    current: registryRecord.registry,
    expectedGeneration: sourceAssignment.data.generation,
    now,
    workspaceId: sourceAssignment.data.workspaceId,
  });
  let nextBinding: WorkspaceStrategyBindingValue;
  let nextCapabilities: WorkspaceCapabilityManifestValue;
  let nextBrief = brief.value;
  let nextBudget = budget.value;
  let preparedMonitors;

  if (action === "configure") {
    if (
      binding.lifecycleState !== "active" ||
      !binding.pack?.contentDigest ||
      binding.effectiveCapabilityManifestRevision !== capabilities.revision
    ) {
      throw new StrategyPackServiceError("strategy_pack_unavailable");
    }
    const pack = (dependencies.catalog ?? strategyPackCatalog).resolve({
      contentDigest: binding.pack.contentDigest,
      id: binding.pack.id,
      version: binding.pack.version,
    });
    if (
      !pack ||
      pack.availability !== "available" ||
      !hasExactStrategyPackCapabilities(capabilities.value, pack, binding.configuration)
    ) {
      throw new StrategyPackServiceError("strategy_pack_unavailable");
    }
    const suppliedConfiguration = (request as z.infer<typeof configureRequestSchema>).configuration;
    for (const key of Object.keys(suppliedConfiguration)) {
      const field = pack.configuration.find((candidate) => candidate.key === key);
      if (!field?.mutableAfterInstall) {
        throw new StrategyPackServiceError("strategy_pack_invalid_request");
      }
    }
    const configured = resolveStrategyPackConfiguration(pack, {
      ...binding.ownerOverrides,
      ...suppliedConfiguration,
    });
    const currentSnapshot = binding.pendingSnapshot ?? binding.lastActiveSnapshot;
    if (!currentSnapshot) {
      throw new StrategyPackServiceError("strategy_pack_unavailable");
    }
    const snapshot = {
      bindingRevision: nextBindingRevision,
      capabilityManifestRevision: capabilities.revision + 1,
      packContentDigest: pack.contentDigest,
      packId: pack.id,
      packVersion: pack.version,
      workspaceGeneration: rolled.workspace.generation,
    };
    const resolvedSources = resolveStrategyPackSourceInstances(pack, configured.configuration);
    const sourceIdsByResource = new Map(pack.monitors.map((monitor) => [
      monitor.resourceId,
      resolveStrategyPackSourceInstances(pack, configured.configuration, monitor.sourceIds),
    ]));
    nextBinding = {
      ...binding,
      bindingRevision: nextBindingRevision,
      configuration: configured.configuration,
      effectiveCapabilityManifestRevision: capabilities.revision + 1,
      health: { checkedAt: nowIso, code: null, status: "healthy" },
      lastActiveSnapshot: currentSnapshot,
      managedResources: Object.fromEntries(Object.entries(binding.managedResources).map(
        ([resourceId, resource]) => [resourceId, {
          ...resource,
          sourceIds: (sourceIdsByResource.get(resourceId) ?? [])
            .map(({ sourceId }) => sourceId)
            .sort(),
        }],
      )),
      ownerOverrides: configured.ownerOverrides,
      pendingSnapshot: snapshot,
      timestamps: {
        ...binding.timestamps,
        configuredAt: nowIso,
        generationRolloverAt: nowIso,
      },
    };
    nextCapabilities = effectiveCapabilities(
      pack,
      configured.configuration,
      dependencies.capabilityInventory,
      dependencies.workerModelPolicy ?? resolveStrategyPackWorkerModelPolicy({
        environment,
        fallback: capabilities.value.workerModelPolicy,
        pack,
      }),
    );
    nextBrief = {
      ...brief.value,
      sourcePolicy: {
        allowedSourceIds: resolvedSources.map(({ sourceId }) => sourceId),
        maximumAccessClassification: "public",
      },
      strategyConfigurationRevision: nextBindingRevision,
    };
    const timezoneField = pack.configuration.find((field) => field.kind === "iana_timezone");
    const ownerTimezone = timezoneField
      ? configured.configuration[timezoneField.key]
      : budget.value.ownerTimezone;
    nextBudget = {
      ...budget.value,
      effectiveAt: nowIso,
      ownerTimezone: typeof ownerTimezone === "string" ? ownerTimezone : budget.value.ownerTimezone,
    };
    preparedMonitors = managedMonitors.map((monitor) => {
      const resourceId = monitor.managedBy!.resourceId;
      const monitorSources = sourceIdsByResource.get(resourceId) ?? [];
      const prepared = prepareWorkspaceManagedMonitorUpdate({
        current: monitor,
        lifecycleState: "paused",
        managedBy: {
          ...monitor.managedBy!,
          bindingRevision: nextBindingRevision,
        },
        now,
        pauseReason: "strategy_pack_configuration",
        publicSourceIds: monitorSources.map(({ sourceId }) => sourceId)
          .filter(isReviewedPublicSource),
        schedule: lifecycleMonitorSchedule(pack, configured.configuration, resourceId, now),
        scope,
        sources: monitorSources.map((source) => ({
          accessClassification: source.accessClassification,
          canonicalUrl: source.canonicalUrl,
          origin: new URL(source.canonicalUrl).origin,
          sourceId: source.sourceId,
        })),
      });
      return { ...prepared, expectedRaw: monitorRaws.get(monitor.monitorId)! };
    });
    nextBinding = {
      ...nextBinding,
      managedResources: Object.fromEntries(preparedMonitors.map(({ monitor }) => [
        monitor.managedBy!.resourceId,
        {
          monitorId: monitor.monitorId,
          ...(monitor.publicSourceSubscriptions === undefined
            ? {}
            : { publicSourceSubscriptions: monitor.publicSourceSubscriptions }),
          sourceIds: monitor.sources.map(({ sourceId }) => sourceId).sort(),
        },
      ])),
    };
  } else {
    nextCapabilities = unboundCapabilities(capabilities.value);
    nextBrief = {
      ...brief.value,
      sourcePolicy: {
        allowedSourceIds: [],
        maximumAccessClassification: "public",
      },
      strategyConfigurationRevision: nextBindingRevision,
    };
    nextBinding = {
      bindingRevision: nextBindingRevision,
      configuration: {},
      effectiveCapabilityManifestRevision: null,
      health: { checkedAt: nowIso, code: null, status: "unbound" },
      lastActiveSnapshot: binding.pendingSnapshot ?? binding.lastActiveSnapshot,
      lifecycleState: "unbound",
      managedResources: {},
      ownerOverrides: {},
      pack: null,
      pendingSnapshot: null,
      timestamps: {
        ...binding.timestamps,
        generationRolloverAt: nowIso,
      },
    };
    preparedMonitors = managedMonitors.map((monitor) => {
      const prepared = prepareWorkspaceManagedMonitorUpdate({
        current: monitor,
        lifecycleState: "retired",
        now,
        pauseReason: "strategy_pack_removed",
        scope,
      });
      return { ...prepared, expectedRaw: monitorRaws.get(monitor.monitorId)! };
    });
  }

  const preparedStrategy = prepareWorkspaceStrategyBindingUpdate({
    current: strategy,
    now,
    scope,
    value: nextBinding,
  });
  const preparedBrief = prepareWorkspaceDocumentUpdate("brief", {
    current: brief,
    now,
    scope,
    value: nextBrief,
  });
  const preparedRecords = action === "configure"
    ? [
        { expectedRaw: rawByKind.strategy, key: preparedStrategy.key, nextRaw: preparedStrategy.raw },
        (() => {
          const prepared = prepareWorkspaceDocumentUpdate("capabilities", {
            current: capabilities,
            now,
            scope,
            value: nextCapabilities,
          });
          return { expectedRaw: rawByKind.capabilities, key: prepared.key, nextRaw: prepared.raw };
        })(),
        { expectedRaw: rawByKind.brief, key: preparedBrief.key, nextRaw: preparedBrief.raw },
        (() => {
          const prepared = prepareWorkspaceDocumentUpdate("budget", {
            current: budget,
            now,
            scope,
            value: nextBudget,
          });
          return { expectedRaw: rawByKind.budget, key: prepared.key, nextRaw: prepared.raw };
        })(),
      ]
    : [
        { expectedRaw: rawByKind.strategy, key: preparedStrategy.key, nextRaw: preparedStrategy.raw },
        (() => {
          const prepared = prepareWorkspaceDocumentUpdate("capabilities", {
            current: capabilities,
            now,
            scope,
            value: nextCapabilities,
          });
          return { expectedRaw: rawByKind.capabilities, key: prepared.key, nextRaw: prepared.raw };
        })(),
        { expectedRaw: rawByKind.brief, key: preparedBrief.key, nextRaw: preparedBrief.raw },
        { expectedRaw: rawByKind.budget, key: workspaceDocumentStorageKey("budget", scope), nextRaw: rawByKind.budget },
      ];
  const outcome = action === "configure" ? "configured" as const : "removed" as const;
  const receipt: StrategyPackMutationReceipt = Object.freeze({
    bindingRevision: nextBindingRevision,
    createdAt: nowIso,
    monitorIds: preparedMonitors.map(({ monitor }) => monitor.monitorId),
    mutationId,
    outcome,
    payloadDigest: parsed.payloadDigest,
    recordType: "strategy_pack_mutation_receipt",
    registryRevision: rolled.registry.revision,
    rejectionCode: null,
    requestIdentityDigest,
    schemaVersion: 1,
    targetWorkspaceId: workspace.id,
  });
  const transactionInput: StrategyPackLifecycleTransactionInput = {
    ...replayInput,
    expectedRegistryRaw: registryRecord.raw,
    expectedRegistryRevision: request.expectedRegistryRevision,
    monitors: preparedMonitors.map((monitor) => ({
      dueAtMs: monitor.dueAtMs,
      dueKey: monitor.dueKey,
      expectedRaw: monitor.expectedRaw,
      nextRaw: monitor.nextRaw,
      recordKey: monitor.recordKey,
    })),
    nextRegistryRaw: JSON.stringify(rolled.registry),
    receiptRaw: JSON.stringify(receipt),
    records: preparedRecords,
    registryKey: photonWorkspaceRegistryStorageKey(input.principalId, input.threadId),
  };
  try {
    const committed = await transactionClient.commitLifecycle(transactionInput);
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

export async function configureStrategyPackWorkspace(
  input: {
    now?: Date;
    principalId: string;
    request: unknown;
    requestIdentity: unknown;
    sourceAssignment: { generation: number; workspaceId: string };
    threadId: string;
  },
  dependencies: StrategyPackServiceDependencies,
) {
  try {
    const result = await mutateStrategyPackWorkspace("configure", input, dependencies);
    emitStrategyPackObservation({
      counter: "strategy_pack_configuration_total",
      outcome: result.replayed ? "replayed" : "committed",
    }, dependencies.observationSink);
    return result;
  } catch (error) {
    emitStrategyPackObservation({
      counter: error instanceof StrategyPackServiceError &&
          (error.code === "strategy_pack_mutation_conflict" ||
            error.code === "strategy_pack_mutation_payload_conflict" ||
            error.code === "strategy_pack_source_assignment_stale")
        ? "strategy_pack_mutation_conflict_total"
        : error instanceof StrategyPackServiceError && error.code === "strategy_pack_unavailable"
          ? "strategy_pack_binding_unavailable_total"
          : "strategy_pack_mutation_failure_total",
      reasonCode: safeStrategyPackReasonCode(error),
    }, dependencies.observationSink);
    throw error;
  }
}

export async function configureStrategyPackWorkspaceFromSelection(
  input: {
    confirmedConsequences: true;
    configuration: Readonly<Record<string, unknown>>;
    expectedBindingRevision: number;
    expectedRegistryRevision: number;
    now?: Date;
    principalId: string;
    requestIdentity: unknown;
    sourceAssignment: { generation: number; workspaceId: string };
    threadId: string;
  },
  dependencies: StrategyPackServiceDependencies,
) {
  return configureStrategyPackWorkspace({
    ...input,
    request: strategyPackConfigureSelectionRequest(input),
  }, dependencies);
}

export async function removeStrategyPackWorkspace(
  input: {
    now?: Date;
    principalId: string;
    request: unknown;
    requestIdentity: unknown;
    sourceAssignment: { generation: number; workspaceId: string };
    threadId: string;
  },
  dependencies: StrategyPackServiceDependencies,
) {
  try {
    const result = await mutateStrategyPackWorkspace("remove", input, dependencies);
    emitStrategyPackObservation({
      counter: "strategy_pack_removal_total",
      outcome: result.replayed ? "replayed" : "committed",
    }, dependencies.observationSink);
    return result;
  } catch (error) {
    emitStrategyPackObservation({
      counter: error instanceof StrategyPackServiceError &&
          (error.code === "strategy_pack_mutation_conflict" ||
            error.code === "strategy_pack_mutation_payload_conflict" ||
            error.code === "strategy_pack_source_assignment_stale")
        ? "strategy_pack_mutation_conflict_total"
        : error instanceof StrategyPackServiceError && error.code === "strategy_pack_unavailable"
          ? "strategy_pack_binding_unavailable_total"
          : "strategy_pack_mutation_failure_total",
      reasonCode: safeStrategyPackReasonCode(error),
    }, dependencies.observationSink);
    throw error;
  }
}

export async function removeStrategyPackWorkspaceFromSelection(
  input: {
    confirmedConsequences: true;
    expectedBindingRevision: number;
    expectedRegistryRevision: number;
    now?: Date;
    principalId: string;
    requestIdentity: unknown;
    sourceAssignment: { generation: number; workspaceId: string };
    threadId: string;
  },
  dependencies: StrategyPackServiceDependencies,
) {
  return removeStrategyPackWorkspace({
    ...input,
    request: strategyPackRemoveSelectionRequest(input),
  }, dependencies);
}
