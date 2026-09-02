import { z } from "zod";

import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "./strategy-pack-source-resolution";
import {
  workspaceSemanticValidationRegistry,
  type WorkspaceSemanticValidationRegistry,
} from "./hybrid-evidence-definition-registry";
import {
  reconcileHybridEvidenceAttempt,
  reserveHybridEvidenceAttempt,
  type HybridEvidenceBudgetReservation,
} from "./hybrid-evidence-budget";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import {
  acceptHybridEvidenceJob,
  markHybridEvidenceJobUncertain,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  readHybridEvidenceRecoveryObservations,
  waitForHybridEvidenceJobSettlement,
  type HybridEvidenceJobRecord,
  type HybridEvidenceJobStoreClient,
} from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import type { HybridModelReasoning } from "./hybrid-evidence-model-routing";
import {
  acknowledgeWorkspaceSemanticHealthNotification,
  advanceWorkspaceSemanticHead,
  createWorkspaceSemanticEvidenceMember,
  createWorkspaceSemanticSource,
  invalidateWorkspaceSemanticHead,
  listWorkspaceSemanticJobSummaries,
  readCurrentWorkspaceSemanticEvidence as readCurrentSemanticEvidence,
  recordWorkspaceSemanticJob,
  stageWorkspaceSemanticQuarantineHealth,
  workspaceSemanticEvidenceRoleSchema,
  writeWorkspaceSemanticEvidence,
  writeWorkspaceSemanticEvidenceBundle,
  type WorkspaceSemanticEvidence,
  type WorkspaceSemanticEvidenceMember,
  type WorkspaceSemanticEvidenceRole,
  type WorkspaceSemanticEvidenceStoreClient,
  type WorkspaceSemanticHealthNotification,
  type WorkspaceSemanticSource,
} from "./hybrid-evidence-semantic-store";
import {
  HYBRID_EVIDENCE_LIMITS,
  digestHybridEvidenceValue,
  evidenceArtifactManifestSchema,
  evidenceLocatorSchema,
  hybridAcceptedResultSchema,
  hybridEvidenceJobDefinitionSchema,
  type EvidenceArtifactManifest,
  type EvidenceLocator,
  type HybridAcceptedResult,
  type HybridEvidenceJobDefinition,
  type HybridInvalidationRecord,
} from "./hybrid-evidence-schema";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import {
  prepareHybridEvidenceWorkerRun,
  type PreparedHybridEvidenceWorkerRun,
} from "./hybrid-evidence-worker";
import { resolveHybridEvidenceWorkerContract } from "./hybrid-evidence-worker-contract-registry";
import type {
  CanonicalPublicFactRevision,
  PublicSourceProjection,
  PublicSourceSubscription,
} from "./public-source-adapter-schema";
import {
  readAuthorizedPublicSourceProjection,
  readPublicSourceSubscription,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import { reconcileWorkspaceRunBudget } from "./workspace-budget-ledger";
import {
  getWorkspaceMonitor,
  recordWorkspaceMonitorFailure,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import {
  readPublicSourceWorkspaceHealth,
  unavailablePublicSourceWorkspaceHealth,
  type PublicSourceWorkspaceHealth,
} from "./public-source-health";
import type { PublicSourceWorkspaceReference } from "./public-source-workspace-reference";

const WORKER_DISPATCH_ERROR_SETTLEMENT_GRACE_MS = 15_000;

const semanticCandidateSchema = z.object({
  citations: z.array(evidenceLocatorSchema).min(1).max(HYBRID_EVIDENCE_LIMITS.maximumCitations),
  disposition: z.enum(["accepted", "abstained", "quarantined"]),
  fields: z.record(z.string().min(1).max(120), z.unknown()),
  unknowns: z.array(z.string().min(1).max(200)).max(HYBRID_EVIDENCE_LIMITS.maximumUnknowns),
}).strict();

type SemanticPack = Pick<StrategyPackCatalogEntry,
  "availability" | "contentDigest" | "evidenceContracts" | "id" | "sources" | "version">;
type SemanticPackCatalog = Pick<typeof strategyPackCatalog, "resolve">;

export interface WorkspaceSemanticAuthorizationProjection {
  readonly fact: CanonicalPublicFactRevision;
  readonly projection: PublicSourceProjection;
  readonly sourceId: string;
  readonly subscription: PublicSourceSubscription;
}

export interface PreparedWorkspaceSemanticEvidenceJob {
  readonly artifact: EvidenceArtifactManifest;
  readonly definition: HybridEvidenceJobDefinition;
  readonly lineageKey: string;
  readonly locators: readonly EvidenceLocator[];
  readonly pack: SemanticPack;
  readonly projection: WorkspaceSemanticAuthorizationProjection;
  readonly record: HybridEvidenceJobRecord;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly source: WorkspaceSemanticSource;
}

export interface WorkspaceSemanticEvidenceRunResult extends PreparedWorkspaceSemanticEvidenceJob {
  readonly evidence: WorkspaceSemanticEvidence | null;
  readonly invalidation: HybridInvalidationRecord | null;
  readonly strategyEvidence: WorkspaceSemanticEvidence | null;
}

export interface WorkspaceSemanticEvidenceBundleInputMember {
  readonly artifact: EvidenceArtifactManifest;
  readonly locators: readonly EvidenceLocator[];
  readonly memberId: string;
  readonly projectionReference: {
    readonly factRevisionId: string;
    readonly sourceId: string;
    readonly subscriptionId: string;
  };
  readonly role: WorkspaceSemanticEvidenceRole;
  readonly semanticContext: Readonly<Record<string, unknown>>;
}

export interface PreparedWorkspaceSemanticEvidenceBundleMember extends
  WorkspaceSemanticEvidenceBundleInputMember {
  readonly authorizationRecord: HybridEvidenceJobRecord;
  readonly pack: SemanticPack;
  readonly projection: WorkspaceSemanticAuthorizationProjection;
  readonly source: WorkspaceSemanticEvidenceMember;
}

export interface PreparedWorkspaceSemanticEvidenceBundleJob {
  readonly artifacts: readonly EvidenceArtifactManifest[];
  readonly definition: HybridEvidenceJobDefinition;
  readonly inputProjection: Readonly<Record<string, unknown>>;
  readonly lineageKey: string;
  readonly locators: readonly EvidenceLocator[];
  readonly members: readonly PreparedWorkspaceSemanticEvidenceBundleMember[];
  readonly pack: SemanticPack;
  readonly record: HybridEvidenceJobRecord;
  readonly scope: AuthorizedWorkspaceStoreScope;
}

export interface WorkspaceSemanticEvidenceBundleRunResult extends
  PreparedWorkspaceSemanticEvidenceBundleJob {
  readonly evidence: WorkspaceSemanticEvidence | null;
  readonly invalidation: HybridInvalidationRecord | null;
  readonly strategyEvidence: WorkspaceSemanticEvidence | null;
}

export interface WorkspaceSemanticModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly paidCostUsd: string;
}

/*
 * What an `execute` drain may report back about a child session. Tokens are the
 * child's actual model usage (accumulated from its `step.completed` events);
 * `paidCostUsd` is optional because a session-stream drain cannot see the child's
 * paid (Exa) cost - that is reconciled separately through the research receipt.
 * `accountedUsage` fills any field left undefined from the definition maximum, so
 * reporting only tokens reconciles them at actual while paid stays conservative.
 */
export interface WorkspaceSemanticModelUsageReport {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly paidCostUsd?: string;
}

export class WorkspaceSemanticEvidenceError extends Error {
  constructor(readonly code:
    | "citation_invalid"
    | "definition_digest_mismatch"
    | "input_projection_invalid"
    | "model_output_invalid"
    | "prompt_injection_detected"
    | "workspace_scope_mismatch") {
    super(code);
    this.name = "WorkspaceSemanticEvidenceError";
  }
}

async function defaultProjection(input: {
  factRevisionId: string;
  scope: AuthorizedWorkspaceStoreScope;
  sourceId: string;
  subscriptionId: string;
}, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
}): Promise<WorkspaceSemanticAuthorizationProjection | null> {
  const [authorized, subscription] = await Promise.all([
    readAuthorizedPublicSourceProjection(input, clients),
    readPublicSourceSubscription(input.scope, input.subscriptionId, clients.subscription),
  ]);
  if (!authorized || !subscription) return null;
  return {
    fact: authorized.fact,
    projection: authorized.projection,
    sourceId: input.sourceId,
    subscription,
  };
}

function exactPackBinding(input: {
  bindingRevision: number;
  contentDigest: string;
  id: string;
  version: string;
}, candidate: PublicSourceSubscription["packBinding"]): boolean {
  return candidate !== null &&
    candidate.bindingRevision === input.bindingRevision &&
    candidate.packContentDigest === input.contentDigest &&
    candidate.packId === input.id &&
    candidate.packVersion === input.version;
}

function authorizationError(): never {
  throw new WorkspaceSemanticEvidenceError("workspace_scope_mismatch");
}

export async function prepareWorkspaceSemanticEvidenceJob(input: {
  artifact: EvidenceArtifactManifest;
  definition: HybridEvidenceJobDefinition;
  locators: readonly EvidenceLocator[];
  modelId: string;
  reasoning?: HybridModelReasoning;
  now?: Date;
  pack: { contentDigest: string; id: string; version: string };
  projectionReference: { factRevisionId: string; sourceId: string; subscriptionId: string };
  scope: AuthorizedWorkspaceStoreScope;
  workspaceGeneration: number;
}, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  catalog?: SemanticPackCatalog;
  jobs?: HybridEvidenceJobStoreClient;
  resolveProjection?: typeof defaultProjection;
  state?: WorkspaceStateStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
} = {}): Promise<PreparedWorkspaceSemanticEvidenceJob> {
  const artifact = evidenceArtifactManifestSchema.parse(input.artifact);
  const definition = hybridEvidenceJobDefinitionSchema.parse(input.definition);
  const locators = input.locators.map((locator) => evidenceLocatorSchema.parse(locator));
  const pack = (clients.catalog ?? strategyPackCatalog).resolve(input.pack);
  const [strategy, capabilities] = await Promise.all([
    readWorkspaceDocument("strategy", input.scope, clients.state),
    readWorkspaceDocument("capabilities", input.scope, clients.state),
  ]);
  const activeSnapshot = strategy?.schemaVersion === 2
    ? strategy.value.pendingSnapshot ?? strategy.value.lastActiveSnapshot
    : null;
  if (
    !strategy || strategy.schemaVersion !== 2 || !capabilities ||
    strategy.value.lifecycleState !== "active" ||
    strategy.value.pack === null || strategy.value.pack.contentDigest === null ||
    !pack ||
    strategy.value.pack.id !== pack.id ||
    strategy.value.pack.version !== pack.version ||
    strategy.value.pack.contentDigest !== pack.contentDigest ||
    strategy.value.bindingRevision !== activeSnapshot?.bindingRevision ||
    activeSnapshot?.packContentDigest !== pack.contentDigest ||
    activeSnapshot?.packId !== pack.id ||
    activeSnapshot?.packVersion !== pack.version ||
    activeSnapshot?.workspaceGeneration !== input.workspaceGeneration ||
    strategy.value.effectiveCapabilityManifestRevision !== capabilities.revision ||
    activeSnapshot?.capabilityManifestRevision !== capabilities.revision ||
    !capabilities.value.workerModelPolicy.allowedModelIds.includes(input.modelId) ||
    definition.limits.maximumOutputTokens > capabilities.value.workerModelPolicy.maximumOutputTokens ||
    pack.availability !== "available" ||
    definition.purpose !== "semantic_interpretation" ||
    definition.resultScope !== "workspace" ||
    definition.triggeringParserCodes.length !== 0 ||
    !definition.allowedModelIds.includes(input.modelId) ||
    !definition.allowedMediaTypes.includes(artifact.mediaType) ||
    !pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest)
  ) authorizationError();

  const resolved = await (clients.resolveProjection ?? defaultProjection)({
    factRevisionId: input.projectionReference.factRevisionId,
    scope: input.scope,
    sourceId: input.projectionReference.sourceId,
    subscriptionId: input.projectionReference.subscriptionId,
  }, clients);
  const projection = resolved;
  if (!projection) authorizationError();
  let resolvedSources;
  try {
    resolvedSources = resolveParameterizedStrategyPackSources(
      pack,
      strategy.value.configuration,
    );
  } catch {
    return authorizationError();
  }
  const source = resolvedSources.find(({ sourceId }) => sourceId === projection.sourceId);
  const capabilitySource = capabilities.value.sources.find((candidate) =>
    candidate.sourceId === projection.sourceId);
  let artifactOrigin: string;
  try {
    artifactOrigin = new URL(artifact.canonicalPublicUrl).origin;
  } catch {
    return authorizationError();
  }
  const exactFactPublicUrl = projection.fact.provenance.publicUrl === artifact.canonicalPublicUrl;
  if (
    projection.sourceId !== input.projectionReference.sourceId ||
    !source || !capabilitySource || !("contractDigest" in capabilitySource) ||
    capabilitySource.contractDigest !== source.contractDigest ||
    capabilitySource.contractVersion !== source.contractVersion ||
    JSON.stringify(capabilitySource.allowedOrigins) !== JSON.stringify(source.allowedOrigins) ||
    (source.sourceInstanceId !== undefined &&
      source.sourceInstanceId !== projection.fact.sourceInstanceId) ||
    (!source.allowedOrigins.includes(artifactOrigin) && !exactFactPublicUrl) ||
    artifact.accessClassification !== "public" ||
    artifact.sourceInstanceId !== projection.fact.sourceInstanceId ||
    artifact.sourceInstanceId !== projection.projection.sourceInstanceId ||
    artifact.sourceInstanceId !== projection.subscription.sourceInstanceId ||
    projection.projection.workspaceId !== input.scope.workspaceId ||
    projection.subscription.workspaceId !== input.scope.workspaceId ||
    projection.projection.subscriptionId !== projection.subscription.subscriptionId ||
    projection.projection.factRevisionId !== projection.fact.revisionId ||
    projection.projection.monitorId !== projection.subscription.monitorId ||
    projection.subscription.lifecycleState !== "active" ||
    !exactPackBinding({
      bindingRevision: strategy.value.bindingRevision,
      contentDigest: pack.contentDigest,
      id: pack.id,
      version: pack.version,
    }, projection.subscription.packBinding) ||
    !definition.allowedAdapterIds.includes(projection.fact.adapterId) ||
    locators.filter(({ kind }) => kind === "text_span").length === 0 ||
    locators.some((locator) => locator.kind === "text_span" && locator.artifactDigest !== artifact.contentDigest) ||
    !locators.some((locator) => locator.kind === "source_fact" &&
      locator.factRevisionId === projection!.fact.revisionId &&
      locator.payloadDigest === projection!.fact.payloadDigest)
  ) authorizationError();

  const scope = {
    bindingRevision: strategy.value.bindingRevision,
    kind: "workspace" as const,
    ownerId: input.scope.ownerId,
    packContentDigest: pack.contentDigest,
    packId: pack.id,
    packVersion: pack.version,
    workspaceId: input.scope.workspaceId,
  };
  const record = await prepareHybridEvidenceJob({
    artifacts: [artifact],
    definition,
    inputContextDigest: digestHybridEvidenceValue({
      capabilityRevision: capabilities.revision,
      factPayloadDigest: projection.fact.payloadDigest,
      factRevisionId: projection.fact.revisionId,
      projectionId: projection.projection.projectionId,
      subscriptionRevision: projection.subscription.deliveryCursor.revision,
    }),
    locators,
    modelId: input.modelId,
    now: input.now,
    scope,
  }, clients.jobs);
  const semanticSource = createWorkspaceSemanticSource({
    artifact,
    authority: projection.fact.provenance.authority,
    factLogicalKey: projection.fact.logicalKey,
    factPayloadDigest: projection.fact.payloadDigest,
    factRevisionId: projection.fact.revisionId,
    projectionId: projection.projection.projectionId,
    sourceId: projection.sourceId,
    sourceInstanceId: projection.fact.sourceInstanceId,
    subscriptionId: projection.subscription.subscriptionId,
  });
  return Object.freeze({
    artifact,
    definition,
    lineageKey: `semantic-lineage.${digestHybridEvidenceValue([
      projection.fact.sourceInstanceId,
      projection.subscription.subscriptionId,
      definition.definitionId,
    ])}`,
    locators: Object.freeze(locators),
    pack,
    projection,
    record,
    scope: input.scope,
    source: semanticSource,
  });
}

const semanticRoleOrder = Object.freeze(Object.fromEntries(
  workspaceSemanticEvidenceRoleSchema.options.map((role, index) => [role, index]),
) as Record<WorkspaceSemanticEvidenceRole, number>);

function canonicalBundleMembers(
  members: readonly WorkspaceSemanticEvidenceBundleInputMember[],
): readonly WorkspaceSemanticEvidenceBundleInputMember[] {
  const sorted = [...members].sort((left, right) =>
    semanticRoleOrder[left.role] - semanticRoleOrder[right.role] ||
    left.memberId.localeCompare(right.memberId));
  const ids = sorted.map(({ memberId }) => memberId);
  const nonSectionRoles = sorted.filter(({ role }) => role !== "section").map(({ role }) => role);
  let serialized: string;
  try {
    serialized = JSON.stringify(sorted.map(({ semanticContext }) => semanticContext));
  } catch {
    return authorizationError();
  }
  if (
    sorted.length === 0 || sorted.length > 16 ||
    new Set(ids).size !== ids.length ||
    new Set(nonSectionRoles).size !== nonSectionRoles.length ||
    Buffer.byteLength(serialized, "utf8") > HYBRID_EVIDENCE_LIMITS.maximumPayloadBytes
  ) authorizationError();
  return Object.freeze(sorted);
}

export async function prepareWorkspaceSemanticEvidenceBundleJob(input: {
  additionalLocators?: readonly EvidenceLocator[];
  definition: HybridEvidenceJobDefinition;
  members: readonly WorkspaceSemanticEvidenceBundleInputMember[];
  modelId: string;
  reasoning?: HybridModelReasoning;
  now?: Date;
  pack: { contentDigest: string; id: string; version: string };
  scope: AuthorizedWorkspaceStoreScope;
  workspaceGeneration: number;
}, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  catalog?: SemanticPackCatalog;
  jobs?: HybridEvidenceJobStoreClient;
  resolveProjection?: typeof defaultProjection;
  state?: WorkspaceStateStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
} = {}): Promise<PreparedWorkspaceSemanticEvidenceBundleJob> {
  const members = canonicalBundleMembers(input.members);
  const authorizationRecords = new Map<string, string>();
  const authorizationJobs: HybridEvidenceJobStoreClient = {
    async compareAndSet(key, expected, next) {
      if ((authorizationRecords.get(key) ?? null) !== expected) return false;
      authorizationRecords.set(key, next);
      return true;
    },
    async get(key) {
      return authorizationRecords.get(key) ?? null;
    },
  };
  const preparedMembers = await Promise.all(members.map(async (member) => {
    const authorized = await prepareWorkspaceSemanticEvidenceJob({
      artifact: member.artifact,
      definition: input.definition,
      locators: member.locators,
      modelId: input.modelId,
      reasoning: input.reasoning,
      now: input.now,
      pack: input.pack,
      projectionReference: member.projectionReference,
      scope: input.scope,
      workspaceGeneration: input.workspaceGeneration,
    }, { ...clients, jobs: authorizationJobs });
    return Object.freeze({
      ...member,
      artifact: authorized.artifact,
      authorizationRecord: authorized.record,
      locators: authorized.locators,
      pack: authorized.pack,
      projection: authorized.projection,
      source: createWorkspaceSemanticEvidenceMember({
        memberId: member.memberId,
        role: member.role,
        source: authorized.source,
      }),
    });
  }));
  const locators = [
    ...preparedMembers.flatMap((member) => member.locators),
    ...(input.additionalLocators ?? []).map((locator) => evidenceLocatorSchema.parse(locator)),
  ].filter((locator, index, values) => values.findIndex((candidate) =>
    digestHybridEvidenceValue(candidate) === digestHybridEvidenceValue(locator)) === index)
    .sort((left, right) => digestHybridEvidenceValue(left).localeCompare(digestHybridEvidenceValue(right)));
  const artifacts = preparedMembers.map(({ artifact }) => artifact)
    .filter((artifact, index, values) => values.findIndex(({ contentDigest }) =>
      contentDigest === artifact.contentDigest) === index);
  const inputProjection = Object.freeze({
    members: Object.freeze(preparedMembers.map((member) => Object.freeze({
      artifactDigest: member.artifact.contentDigest,
      factPayloadDigest: member.projection.fact.payloadDigest,
      factRevisionId: member.projection.fact.revisionId,
      locatorDigests: Object.freeze(member.locators.map(digestHybridEvidenceValue).sort()),
      memberId: member.memberId,
      projectionId: member.projection.projection.projectionId,
      role: member.role,
      semanticContext: member.semanticContext,
      sourceId: member.projection.sourceId,
      sourceInstanceId: member.projection.fact.sourceInstanceId,
      subscriptionId: member.projection.subscription.subscriptionId,
      subscriptionRevision: member.projection.subscription.deliveryCursor.revision,
    }))),
    recordType: "workspace_semantic_role_bound_projection" as const,
    schemaVersion: 2 as const,
  });
  const definition = hybridEvidenceJobDefinitionSchema.parse(input.definition);
  if (
    definition.inputProjection.schemaId !== "workspace-semantic-role-bound-projection" ||
    definition.inputProjection.schemaVersion !== "2.0.0"
  ) authorizationError();
  const first = preparedMembers[0];
  if (!first) authorizationError();
  const scope = first.authorizationRecord.job.scope;
  if (scope.kind !== "workspace") authorizationError();
  const record = await prepareHybridEvidenceJob({
    artifacts,
    definition,
    inputContextDigest: digestHybridEvidenceValue(inputProjection),
    inputProjection,
    locators,
    modelId: input.modelId,
    now: input.now,
    scope,
  }, clients.jobs);
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    definition,
    inputProjection,
    lineageKey: `semantic-lineage.${digestHybridEvidenceValue(preparedMembers.map((member) => ({
      factLogicalKey: member.source.source.factLogicalKey,
      memberId: member.memberId,
      role: member.role,
      sourceId: member.source.source.sourceId,
      subscriptionId: member.source.source.subscriptionId,
    })))}`,
    locators: Object.freeze(locators),
    members: Object.freeze(preparedMembers),
    pack: first.pack,
    record,
    scope: input.scope,
  });
}

export function detectUntrustedEvidencePromptInjection(texts: readonly string[]): boolean {
  return texts.some((text) =>
    /(?:^|\b)(?:system\s*:|ignore (?:all |the )?(?:previous |above )?(?:instructions?|schema|policy)|reveal (?:another workspace|secrets?|credentials?|tokens?)|call (?:a )?(?:broker|tools?)|(?:submit|place|execute) (?:a )?(?:trade|order))/iu.test(text));
}

function sameLocator(left: EvidenceLocator, right: EvidenceLocator): boolean {
  return digestHybridEvidenceValue(left) === digestHybridEvidenceValue(right);
}

async function validateSemanticCandidate(input: {
  artifacts: HybridEvidenceArtifactStore;
  candidate: unknown;
  contractRegistry: WorkspaceSemanticValidationRegistry;
  definition: HybridEvidenceJobDefinition;
  inputProjection?: unknown;
  locators: readonly EvidenceLocator[];
}): Promise<{
  disposition: "accepted" | "abstained";
  payload: Readonly<Record<string, unknown>>;
  citations: readonly EvidenceLocator[];
  unknowns: readonly string[];
}> {
  const candidate = semanticCandidateSchema.parse(input.candidate);
  const textLocators = input.locators.filter(
    (locator): locator is Extract<EvidenceLocator, { kind: "text_span" }> => locator.kind === "text_span",
  );
  const evidenceTexts = await Promise.all(textLocators.map(async (locator) => Object.freeze({
    content: (await input.artifacts.readSlice({ locator, maximumBytes: 64 * 1_024 })).content,
    locator,
  })));
  if (detectUntrustedEvidencePromptInjection(evidenceTexts.map(({ content }) => content))) {
    throw new WorkspaceSemanticEvidenceError("prompt_injection_detected");
  }
  if (candidate.disposition === "quarantined") {
    throw new WorkspaceSemanticEvidenceError("model_output_invalid");
  }
  const contract = input.contractRegistry.resolve(input.definition);
  if (!contract) throw new WorkspaceSemanticEvidenceError("definition_digest_mismatch");
  let validated: {
    readonly assertionCitations: readonly EvidenceLocator[];
    readonly payload: Readonly<Record<string, unknown>>;
    readonly requireExactCitations?: boolean;
  };
  try {
    validated = contract.validate({
      disposition: candidate.disposition,
      evidenceTexts,
      fields: candidate.fields,
      inputProjection: input.inputProjection,
      unknowns: candidate.unknowns,
    });
  } catch {
    throw new WorkspaceSemanticEvidenceError("model_output_invalid");
  }
  if (
    validated.assertionCitations.some((citation) =>
      !candidate.citations.some((candidateCitation) => sameLocator(candidateCitation, citation)) ||
      !textLocators.some((allowed) => sameLocator(allowed, citation))) ||
    candidate.citations.some((citation) =>
      !input.locators.some((allowed) => sameLocator(allowed, citation)))
  ) throw new WorkspaceSemanticEvidenceError("citation_invalid");
  if (validated.requireExactCitations) {
    const candidateDigests = candidate.citations.map(digestHybridEvidenceValue).sort();
    const assertionDigests = [...new Set(
      validated.assertionCitations.map(digestHybridEvidenceValue),
    )].sort();
    if (
      new Set(candidateDigests).size !== candidateDigests.length ||
      JSON.stringify(candidateDigests) !== JSON.stringify(assertionDigests)
    ) throw new WorkspaceSemanticEvidenceError("citation_invalid");
  }
  await Promise.all(validated.assertionCitations.map((locator) =>
    input.artifacts.readSlice({ locator, maximumBytes: 64 * 1_024 })));
  return Object.freeze({
    citations: Object.freeze(candidate.citations),
    disposition: candidate.disposition,
    payload: Object.freeze(validated.payload),
    unknowns: Object.freeze(candidate.unknowns),
  });
}

function createAcceptedSemanticResult(input: {
  candidate: Awaited<ReturnType<typeof validateSemanticCandidate>>;
  definition: HybridEvidenceJobDefinition;
  now: Date;
  record: HybridEvidenceJobRecord;
  usage: WorkspaceSemanticModelUsage;
}): HybridAcceptedResult {
  if (input.record.job.state !== "completed" || !input.record.candidateDigest) {
    throw new WorkspaceSemanticEvidenceError("input_projection_invalid");
  }
  const payload = input.candidate.payload;
  return hybridAcceptedResultSchema.parse({
    citations: input.candidate.citations,
    definition: {
      definitionDigest: input.definition.definitionDigest,
      definitionId: input.definition.definitionId,
      definitionVersion: input.definition.definitionVersion,
    },
    disposition: input.candidate.disposition,
    inputDigest: input.record.job.inputDigest,
    jobId: input.record.job.jobId,
    model: {
      modelId: input.record.job.modelId,
      modelOutputDigest: input.record.candidateDigest,
      promptTemplateDigest: input.definition.instructionTemplate.digest,
    },
    outputDigest: digestHybridEvidenceValue(payload),
    payload,
    purpose: "semantic_interpretation",
    recordType: "hybrid_evidence_accepted_result",
    resultId: `hybrid-result.${digestHybridEvidenceValue([
      input.record.job.jobId,
      input.record.candidateDigest,
      payload,
    ])}`,
    schemaVersion: 1,
    scope: input.record.job.scope,
    uncertainty: {
      confidence: null,
      coverage: input.candidate.disposition === "accepted" ? "complete" : "partial",
      unknowns: input.candidate.unknowns,
    },
    usage: input.usage,
    validatedAt: input.now.toISOString(),
    validationTrace: [{
      errorCode: null,
      outcome: "passed",
      validatorId: input.definition.requiredValidator.validatorId,
      validatorVersion: input.definition.requiredValidator.version,
    }],
  });
}

const semanticUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(200_000),
  outputTokens: z.number().int().nonnegative().max(20_000),
  paidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/u),
}).strict();

function accountedUsage(
  definition: HybridEvidenceJobDefinition,
  usage: WorkspaceSemanticModelUsageReport | void,
): WorkspaceSemanticModelUsage {
  // Reconcile each field at what the child actually reported, falling back to the
  // definition maximum per field for anything it could not report. A drain that
  // reports only its actual tokens therefore reconciles tokens at actual (freeing
  // the over-reservation that used to reconcile every child at its 24k maximum)
  // while paid stays at the conservative ceiling, never under-reporting spend.
  const accounted = semanticUsageSchema.parse({
    inputTokens: usage?.inputTokens ?? definition.limits.maximumInputTokens,
    outputTokens: usage?.outputTokens ?? definition.limits.maximumOutputTokens,
    paidCostUsd: usage?.paidCostUsd ?? definition.limits.maximumPaidCostUsd,
  });
  if (
    accounted.inputTokens > definition.limits.maximumInputTokens ||
    accounted.outputTokens > definition.limits.maximumOutputTokens
  ) throw new WorkspaceSemanticEvidenceError("model_output_invalid");
  return Object.freeze(accounted);
}

function invalidationCause(
  previous: WorkspaceSemanticEvidence | null,
  current: HybridAcceptedResult,
  source: WorkspaceSemanticSource,
): HybridInvalidationRecord["cause"] {
  if (!previous) {
    return { digest: source.factPayloadDigest, kind: "source_revision", revision: source.factRevisionId };
  }
  const priorScope = previous.result.scope;
  const currentScope = current.scope;
  if (priorScope.kind !== "workspace" || currentScope.kind !== "workspace") {
    throw new WorkspaceSemanticEvidenceError("workspace_scope_mismatch");
  }
  if (
    priorScope.packContentDigest !== currentScope.packContentDigest ||
    priorScope.packVersion !== currentScope.packVersion
  ) {
    return {
      digest: currentScope.packContentDigest,
      kind: "pack_revision",
      revision: `${currentScope.packId}@${currentScope.packVersion}`,
    };
  }
  if (priorScope.bindingRevision !== currentScope.bindingRevision) {
    return {
      digest: digestHybridEvidenceValue(currentScope.bindingRevision),
      kind: "binding_revision",
      revision: `binding.${currentScope.bindingRevision}`,
    };
  }
  if (previous.result.definition.definitionDigest !== current.definition.definitionDigest) {
    return {
      digest: current.definition.definitionDigest,
      kind: "definition_revision",
      revision: `${current.definition.definitionId}@${current.definition.definitionVersion}`,
    };
  }
  if (
    previous.source.factRevisionId !== source.factRevisionId ||
    previous.source.factPayloadDigest !== source.factPayloadDigest ||
    previous.source.artifactDigest !== source.artifactDigest
  ) {
    return { digest: source.factPayloadDigest, kind: "source_revision", revision: source.factRevisionId };
  }
  return {
    digest: digestHybridEvidenceValue(current.validationTrace),
    kind: "validator_revision",
    revision: current.validationTrace[0]!.validatorVersion,
  };
}

async function defaultHealthNotification(input: {
  notification: WorkspaceSemanticHealthNotification;
  scope: AuthorizedWorkspaceStoreScope;
}, monitorClient?: WorkspaceMonitorStoreClient): Promise<void> {
  const monitor = await getWorkspaceMonitor(input.scope, input.notification.monitorId, monitorClient);
  if (!monitor || monitor.lifecycleState === "retired") return;
  await recordWorkspaceMonitorFailure({
    errorCode: input.notification.kind === "blocking"
      ? "hybrid_quarantine_blocking"
      : "hybrid_quarantine_persistent",
    expectedRevision: monitor.configurationRevision,
    monitorId: monitor.monitorId,
    scope: input.scope,
  }, monitorClient);
}

async function deliverHealthNotification(input: {
  notification: WorkspaceSemanticHealthNotification;
  scope: AuthorizedWorkspaceStoreScope;
}, clients: {
  monitor?: WorkspaceMonitorStoreClient;
  notifyHealth?(notification: WorkspaceSemanticHealthNotification): Promise<void>;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
}): Promise<void> {
  if (clients.notifyHealth) await clients.notifyHealth(input.notification);
  else await defaultHealthNotification(input, clients.monitor);
  await acknowledgeWorkspaceSemanticHealthNotification({
    notificationId: input.notification.notificationId,
    scope: input.scope,
  }, clients.semantic);
}

async function reconcileAcceptedSemanticUsage(input: {
  job: HybridEvidenceJobRecord["job"];
  now?: Date;
  scope: AuthorizedWorkspaceStoreScope;
  usage: WorkspaceSemanticModelUsage;
}, client?: WorkspaceBudgetLedgerClient): Promise<void> {
  await reconcileWorkspaceRunBudget({
    actualInputTokens: input.usage.inputTokens,
    actualOutputTokens: input.usage.outputTokens,
    actualPaidCost: input.usage.paidCostUsd,
    now: input.now,
    outcome: "reconciled",
    runId: input.job.budgetReservation.key,
    scope: input.scope,
  }, client);
}

export async function runWorkspaceSemanticEvidenceJob(input: Parameters<
  typeof prepareWorkspaceSemanticEvidenceJob
>[0] & { environment?: NodeJS.ProcessEnv; parentBudgetRunId?: string }, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  artifacts: HybridEvidenceArtifactStore;
  budget?: WorkspaceBudgetLedgerClient;
  catalog?: SemanticPackCatalog;
  execute(prepared: PreparedHybridEvidenceWorkerRun): Promise<WorkspaceSemanticModelUsageReport | void>;
  jobs?: HybridEvidenceJobStoreClient;
  lineage?: HybridEvidenceLineageStoreClient;
  monitor?: WorkspaceMonitorStoreClient;
  notifyHealth?(notification: WorkspaceSemanticHealthNotification): Promise<void>;
  resolveProjection?: typeof defaultProjection;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
  state?: WorkspaceStateStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
  validationRegistry?: WorkspaceSemanticValidationRegistry;
}): Promise<WorkspaceSemanticEvidenceRunResult> {
  const flags = resolveHybridEvidenceFlags(input.environment);
  if (!flags.semanticReasoning) throw new WorkspaceSemanticEvidenceError("workspace_scope_mismatch");
  const prepared = await prepareWorkspaceSemanticEvidenceJob(input, {
    acquisition: clients.acquisition,
    catalog: clients.catalog,
    jobs: clients.jobs,
    resolveProjection: clients.resolveProjection,
    state: clients.state,
    subscription: clients.subscription,
  });
  const revalidate = async () => {
    const current = await prepareWorkspaceSemanticEvidenceJob(input, {
      acquisition: clients.acquisition,
      catalog: clients.catalog,
      jobs: clients.jobs,
      resolveProjection: clients.resolveProjection,
      state: clients.state,
      subscription: clients.subscription,
    });
    if (
      current.record.job.jobId !== prepared.record.job.jobId ||
      current.source.artifactDigest !== prepared.source.artifactDigest ||
      current.source.factPayloadDigest !== prepared.source.factPayloadDigest ||
      current.source.factRevisionId !== prepared.source.factRevisionId ||
      current.source.projectionId !== prepared.source.projectionId ||
      current.source.subscriptionId !== prepared.source.subscriptionId
    ) authorizationError();
    return current;
  };
  const convergeAccepted = async (
    accepted: HybridEvidenceJobRecord,
    result: HybridAcceptedResult,
  ) => {
    await revalidate();
    const committedAt = new Date(result.validatedAt);
    const previous = await readCurrentSemanticEvidence({
      lineageKey: prepared.lineageKey,
      scope: input.scope,
    }, clients.semantic);
    const evidence = await writeWorkspaceSemanticEvidence({
      lineageKey: prepared.lineageKey,
      now: committedAt,
      result,
      scope: input.scope,
      source: prepared.source,
    }, clients.semantic);
    await revalidate();
    const invalidation = await advanceWorkspaceSemanticHead({
      cause: invalidationCause(previous, result, prepared.source),
      lineageKey: prepared.lineageKey,
      now: committedAt,
      resultId: result.resultId,
      scope: input.scope,
    }, { lineage: clients.lineage, semantic: clients.semantic });
    await clients.artifacts.setReference({
      active: true,
      artifactDigest: prepared.artifact.contentDigest,
      kind: "accepted_result",
      referenceId: result.resultId,
    });
    await recordWorkspaceSemanticJob({
      job: accepted.job,
      result,
      scope: input.scope,
      source: prepared.source,
    }, clients.semantic);
    await reconcileAcceptedSemanticUsage({
      job: accepted.job,
      now: input.now,
      scope: input.scope,
      usage: result.usage,
    }, clients.budget);
    return { evidence, invalidation };
  };
  await recordWorkspaceSemanticJob({
    job: prepared.record.job,
    quarantineCodes: prepared.record.quarantineCodes,
    result: prepared.record.acceptedResult,
    scope: input.scope,
    source: prepared.source,
  }, clients.semantic);
  if (prepared.record.job.state === "accepted" && prepared.record.acceptedResult) {
    const { evidence, invalidation } = await convergeAccepted(
      prepared.record,
      prepared.record.acceptedResult,
    );
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation,
      record: prepared.record,
      strategyEvidence: evidence?.result.disposition === "accepted" ? evidence : null,
    });
  }
  if (prepared.record.job.state === "quarantined") {
    const notification = await stageWorkspaceSemanticQuarantineHealth({
      definitionVersion: prepared.definition.definitionVersion,
      jobId: prepared.record.job.jobId,
      monitorId: prepared.projection.subscription.monitorId,
      reasonCodes: prepared.record.quarantineCodes,
      scope: input.scope,
      sourceInstanceId: prepared.source.sourceInstanceId,
    }, clients.semantic);
    if (notification) {
      await deliverHealthNotification({ notification, scope: input.scope }, clients);
    }
    return Object.freeze({
      ...prepared,
      evidence: null,
      invalidation: null,
      record: prepared.record,
      strategyEvidence: null,
    });
  }

  let reservation: HybridEvidenceBudgetReservation | null = null;
  let record = prepared.record;
  let executionUsage: WorkspaceSemanticModelUsageReport | void = undefined;
  let modelAttempted = false;
  let budgetSettled = false;
  try {
    if (record.job.state === "prepared") {
      reservation = await reserveHybridEvidenceAttempt({
        definition: prepared.definition,
        environment: input.environment,
        job: record.job,
        now: input.now,
        parentRunId: input.parentBudgetRunId,
        scope: input.scope,
      }, { state: clients.state, workspace: clients.budget });
      const worker = await prepareHybridEvidenceWorkerRun({
        approvedResearchUrls: resolveHybridEvidenceWorkerContract(
            prepared.definition.definitionId,
          )?.research?.approvedUrlPolicy === "evidence_sources"
          ? [
              prepared.artifact.canonicalPublicUrl,
              prepared.projection.fact.provenance.publicUrl,
            ]
          : undefined,
        budget: reservation,
        definition: prepared.definition,
        environment: input.environment,
        issuedAt: new Date(),
        jobClient: clients.jobs,
        locators: prepared.locators,
        now: input.now,
        prepared: record,
        reasoning: input.reasoning,
      });
      record = worker.record;
      await recordWorkspaceSemanticJob({ job: record.job, scope: input.scope, source: prepared.source }, clients.semantic);
      const workerSettlementDeadline = Date.now() + prepared.definition.limits.maximumRuntimeMs;
      try {
        modelAttempted = true;
        executionUsage = await clients.execute(worker);
      } catch (error) {
        record = (await waitForHybridEvidenceJobSettlement({
          jobId: record.job.jobId,
          maximumWaitMs: Math.min(
            Math.max(0, workerSettlementDeadline - Date.now()),
            WORKER_DISPATCH_ERROR_SETTLEMENT_GRACE_MS,
          ),
        }, clients.jobs)) ?? record;
        if (record.job.state !== "completed") {
          if (record.job.state === "running" || record.job.state === "prepared") {
            record = await markHybridEvidenceJobUncertain({
              jobId: record.job.jobId,
              now: input.now,
            }, clients.jobs);
          }
          const usage = accountedUsage(prepared.definition, executionUsage);
          await recordWorkspaceSemanticJob({
            job: record.job,
            scope: input.scope,
            source: prepared.source,
            usage,
          }, clients.semantic);
          if (reservation) {
            await reconcileHybridEvidenceAttempt({
              ...(executionUsage ? {
                actualInputTokens: usage.inputTokens,
                actualOutputTokens: usage.outputTokens,
                actualPaidCost: usage.paidCostUsd,
              } : {}),
              now: input.now,
              outcome: executionUsage ? "reconciled" : "uncertain",
              reservation,
            }, { workspace: clients.budget });
            budgetSettled = true;
          }
          throw error;
        }
      }
      record = (await waitForHybridEvidenceJobSettlement({
        jobId: record.job.jobId,
        maximumWaitMs: Math.max(0, workerSettlementDeadline - Date.now()),
      }, clients.jobs)) ?? record;
    }
    if (record.job.state !== "completed" || !record.candidate) {
      if (record.job.state === "running" || record.job.state === "prepared") {
        record = await markHybridEvidenceJobUncertain({ jobId: record.job.jobId, now: input.now }, clients.jobs);
        await recordWorkspaceSemanticJob({
          job: record.job,
          scope: input.scope,
          source: prepared.source,
          usage: accountedUsage(prepared.definition, executionUsage),
        }, clients.semantic);
      }
      throw new WorkspaceSemanticEvidenceError("model_output_invalid");
    }
    const persistedUsage = executionUsage === undefined
      ? (await listWorkspaceSemanticJobSummaries(input.scope, clients.semantic)).find(({ jobId }) =>
          jobId === record.job.jobId)?.usage
      : undefined;
    const usage = accountedUsage(
      prepared.definition,
      executionUsage ?? (persistedUsage && (
        persistedUsage.inputTokens > 0 ||
        persistedUsage.outputTokens > 0 ||
        persistedUsage.paidCostUsd !== "0"
      ) ? persistedUsage : undefined),
    );
    await recordWorkspaceSemanticJob({
      job: record.job,
      scope: input.scope,
      source: prepared.source,
      usage,
    }, clients.semantic);
    let validated: Awaited<ReturnType<typeof validateSemanticCandidate>>;
    try {
      validated = await validateSemanticCandidate({
        artifacts: clients.artifacts,
        candidate: record.candidate,
        contractRegistry: clients.validationRegistry ?? workspaceSemanticValidationRegistry,
        definition: prepared.definition,
        locators: prepared.locators,
      });
    } catch (error) {
      const code = error instanceof WorkspaceSemanticEvidenceError
        ? error.code
        : "model_output_invalid";
      const quarantined = await quarantineHybridEvidenceJob({
        codes: [code],
        jobId: record.job.jobId,
        now: input.now,
      }, clients.jobs);
      await recordWorkspaceSemanticJob({
        job: quarantined.job,
        quarantineCodes: quarantined.quarantineCodes,
        scope: input.scope,
        source: prepared.source,
        usage,
      }, clients.semantic);
      if (reservation) {
        await reconcileHybridEvidenceAttempt({
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          actualPaidCost: usage.paidCostUsd,
          now: input.now,
          outcome: "reconciled",
          reservation,
        }, { workspace: clients.budget });
        budgetSettled = true;
      }
      const notification = await stageWorkspaceSemanticQuarantineHealth({
        definitionVersion: prepared.definition.definitionVersion,
        jobId: quarantined.job.jobId,
        monitorId: prepared.projection.subscription.monitorId,
        reasonCodes: quarantined.quarantineCodes,
        scope: input.scope,
        sourceInstanceId: prepared.source.sourceInstanceId,
      }, clients.semantic);
      if (notification) {
        await deliverHealthNotification({ notification, scope: input.scope }, clients);
      }
      return Object.freeze({
        ...prepared,
        evidence: null,
        invalidation: null,
        record: quarantined,
        strategyEvidence: null,
      });
    }
    const result = createAcceptedSemanticResult({
      candidate: validated,
      definition: prepared.definition,
      now: input.now ?? new Date(),
      record,
      usage,
    });
    await revalidate();
    const accepted = await acceptHybridEvidenceJob({
      jobId: record.job.jobId,
      now: input.now,
      result,
    }, clients.jobs);
    const { evidence, invalidation } = await convergeAccepted(accepted, result);
    budgetSettled = true;
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation,
      record: accepted,
      strategyEvidence: result.disposition === "accepted" ? evidence : null,
    });
  } catch (error) {
    if (reservation && !budgetSettled) {
      const latest = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
      record = latest.job.state === "running" || latest.job.state === "prepared"
        ? await markHybridEvidenceJobUncertain({ jobId: latest.job.jobId, now: input.now }, clients.jobs)
        : latest;
      if (record.job.state === "uncertain") {
        await recordWorkspaceSemanticJob({
          job: record.job,
          scope: input.scope,
          source: prepared.source,
          usage: accountedUsage(prepared.definition, executionUsage),
        }, clients.semantic);
      }
      await reconcileHybridEvidenceAttempt({
        ...(modelAttempted && executionUsage ? {
          actualInputTokens: executionUsage.inputTokens,
          actualOutputTokens: executionUsage.outputTokens,
          actualPaidCost: executionUsage.paidCostUsd,
        } : {}),
        now: input.now,
        outcome: modelAttempted
          ? executionUsage ? "reconciled" : "uncertain"
          : "released",
        reservation,
      }, { workspace: clients.budget });
    }
    throw error;
  }
}

function bundleInvalidationCause(
  previous: WorkspaceSemanticEvidence | null,
  current: HybridAcceptedResult,
  members: readonly WorkspaceSemanticEvidenceMember[],
): HybridInvalidationRecord["cause"] {
  const primary = members.find(({ role }) => role === "current") ?? members[0];
  if (!primary) throw new WorkspaceSemanticEvidenceError("input_projection_invalid");
  const currentSignature = members.map(({ memberId, role, source }) => ({
    artifactDigest: source.artifactDigest,
    factPayloadDigest: source.factPayloadDigest,
    factRevisionId: source.factRevisionId,
    memberId,
    role,
  }));
  const previousSignature = previous?.schemaVersion === 2
    ? previous.members.map(({ memberId, role, source }) => ({
        artifactDigest: source.artifactDigest,
        factPayloadDigest: source.factPayloadDigest,
        factRevisionId: source.factRevisionId,
        memberId,
        role,
      }))
    : null;
  if (previous && digestHybridEvidenceValue(previousSignature) !== digestHybridEvidenceValue(currentSignature)) {
    const digest = digestHybridEvidenceValue(currentSignature);
    return { digest, kind: "source_revision", revision: `bundle.${digest}` };
  }
  if (previous && previous.result.inputDigest !== current.inputDigest) {
    return {
      digest: current.inputDigest,
      kind: "input_revision",
      revision: current.jobId,
    };
  }
  return invalidationCause(previous, current, primary.source);
}

export async function runWorkspaceSemanticEvidenceBundleJob(input: Parameters<
  typeof prepareWorkspaceSemanticEvidenceBundleJob
>[0] & { environment?: NodeJS.ProcessEnv; parentBudgetRunId?: string }, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  artifacts: HybridEvidenceArtifactStore;
  budget?: WorkspaceBudgetLedgerClient;
  catalog?: SemanticPackCatalog;
  execute(prepared: PreparedHybridEvidenceWorkerRun): Promise<WorkspaceSemanticModelUsageReport | void>;
  jobs?: HybridEvidenceJobStoreClient;
  lineage?: HybridEvidenceLineageStoreClient;
  monitor?: WorkspaceMonitorStoreClient;
  notifyHealth?(notification: WorkspaceSemanticHealthNotification): Promise<void>;
  resolveProjection?: typeof defaultProjection;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
  state?: WorkspaceStateStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
  validationRegistry?: WorkspaceSemanticValidationRegistry;
}): Promise<WorkspaceSemanticEvidenceBundleRunResult> {
  const flags = resolveHybridEvidenceFlags(input.environment);
  if (!flags.semanticReasoning) throw new WorkspaceSemanticEvidenceError("workspace_scope_mismatch");
  const preparationClients = {
    acquisition: clients.acquisition,
    catalog: clients.catalog,
    jobs: clients.jobs,
    resolveProjection: clients.resolveProjection,
    state: clients.state,
    subscription: clients.subscription,
  };
  const prepared = await prepareWorkspaceSemanticEvidenceBundleJob(input, preparationClients);
  const primary = prepared.members.find(({ role }) => role === "current") ?? prepared.members[0];
  if (!primary) throw new WorkspaceSemanticEvidenceError("input_projection_invalid");
  const primarySource = primary.source.source;
  const sources = prepared.members.map(({ source }) => source);
  const revalidate = async () => {
    const current = await prepareWorkspaceSemanticEvidenceBundleJob(input, preparationClients);
    if (
      current.record.job.jobId !== prepared.record.job.jobId ||
      digestHybridEvidenceValue(current.inputProjection) !== digestHybridEvidenceValue(prepared.inputProjection)
    ) authorizationError();
    return current;
  };
  const recordJob = (record: HybridEvidenceJobRecord, usage?: WorkspaceSemanticModelUsage) =>
    recordWorkspaceSemanticJob({
      job: record.job,
      quarantineCodes: record.quarantineCodes,
      result: record.acceptedResult,
      scope: input.scope,
      source: primarySource,
      ...(usage ? { usage } : {}),
    }, clients.semantic);
  const convergeAccepted = async (accepted: HybridEvidenceJobRecord, result: HybridAcceptedResult) => {
    await revalidate();
    const committedAt = new Date(result.validatedAt);
    const previous = await readCurrentSemanticEvidence({
      lineageKey: prepared.lineageKey,
      scope: input.scope,
    }, clients.semantic);
    const evidence = await writeWorkspaceSemanticEvidenceBundle({
      lineageKey: prepared.lineageKey,
      members: sources,
      now: committedAt,
      result,
      scope: input.scope,
    }, clients.semantic);
    await revalidate();
    const invalidation = await advanceWorkspaceSemanticHead({
      cause: bundleInvalidationCause(previous, result, sources),
      lineageKey: prepared.lineageKey,
      now: committedAt,
      resultId: result.resultId,
      scope: input.scope,
    }, { lineage: clients.lineage, semantic: clients.semantic });
    await Promise.all(prepared.artifacts.map((artifact) => clients.artifacts.setReference({
      active: true,
      artifactDigest: artifact.contentDigest,
      kind: "accepted_result",
      referenceId: result.resultId,
    })));
    await recordJob(accepted);
    await reconcileAcceptedSemanticUsage({
      job: accepted.job,
      now: input.now,
      scope: input.scope,
      usage: result.usage,
    }, clients.budget);
    return { evidence, invalidation };
  };
  await recordJob(prepared.record);
  if (prepared.record.job.state === "accepted" && prepared.record.acceptedResult) {
    const { evidence, invalidation } = await convergeAccepted(prepared.record, prepared.record.acceptedResult);
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation,
      record: prepared.record,
      strategyEvidence: evidence.result.disposition === "accepted" ? evidence : null,
    });
  }
  if (prepared.record.job.state === "quarantined") {
    const notification = await stageWorkspaceSemanticQuarantineHealth({
      definitionVersion: prepared.definition.definitionVersion,
      jobId: prepared.record.job.jobId,
      monitorId: primary.projection.subscription.monitorId,
      reasonCodes: prepared.record.quarantineCodes,
      scope: input.scope,
      sourceInstanceId: primarySource.sourceInstanceId,
    }, clients.semantic);
    if (notification) await deliverHealthNotification({ notification, scope: input.scope }, clients);
    return Object.freeze({
      ...prepared,
      evidence: null,
      invalidation: null,
      record: prepared.record,
      strategyEvidence: null,
    });
  }

  let reservation: HybridEvidenceBudgetReservation | null = null;
  let record = prepared.record;
  let executionUsage: WorkspaceSemanticModelUsageReport | void = undefined;
  let modelAttempted = false;
  let budgetSettled = false;
  try {
    if (record.job.state === "prepared") {
      reservation = await reserveHybridEvidenceAttempt({
        definition: prepared.definition,
        environment: input.environment,
        job: record.job,
        now: input.now,
        parentRunId: input.parentBudgetRunId,
        scope: input.scope,
      }, { state: clients.state, workspace: clients.budget });
      const worker = await prepareHybridEvidenceWorkerRun({
        approvedResearchUrls: resolveHybridEvidenceWorkerContract(
            prepared.definition.definitionId,
          )?.research?.approvedUrlPolicy === "evidence_sources"
          ? [...new Set([
              ...prepared.artifacts.map(({ canonicalPublicUrl }) => canonicalPublicUrl),
              ...prepared.members.map(({ projection }) => projection.fact.provenance.publicUrl),
            ])]
          : undefined,
        budget: reservation,
        definition: prepared.definition,
        environment: input.environment,
        issuedAt: new Date(),
        inputProjection: prepared.inputProjection,
        jobClient: clients.jobs,
        locators: prepared.locators,
        now: input.now,
        prepared: record,
        reasoning: input.reasoning,
      });
      record = worker.record;
      await recordJob(record);
      try {
        modelAttempted = true;
        executionUsage = await clients.execute(worker);
      } catch (error) {
        record = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
        if (record.job.state !== "completed") {
          if (record.job.state === "running" || record.job.state === "prepared") {
            record = await markHybridEvidenceJobUncertain({ jobId: record.job.jobId, now: input.now }, clients.jobs);
          }
          const usage = accountedUsage(prepared.definition, executionUsage);
          await recordJob(record, usage);
          if (reservation) {
            await reconcileHybridEvidenceAttempt({
              ...(executionUsage ? {
                actualInputTokens: usage.inputTokens,
                actualOutputTokens: usage.outputTokens,
                actualPaidCost: usage.paidCostUsd,
              } : {}),
              now: input.now,
              outcome: executionUsage ? "reconciled" : "uncertain",
              reservation,
            }, { workspace: clients.budget });
            budgetSettled = true;
          }
          throw error;
        }
      }
      record = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
    }
    if (record.job.state !== "completed" || !record.candidate) {
      if (record.job.state === "running" || record.job.state === "prepared") {
        record = await markHybridEvidenceJobUncertain({ jobId: record.job.jobId, now: input.now }, clients.jobs);
        await recordJob(record, accountedUsage(prepared.definition, executionUsage));
      }
      throw new WorkspaceSemanticEvidenceError("model_output_invalid");
    }
    const persistedUsage = executionUsage === undefined
      ? (await listWorkspaceSemanticJobSummaries(input.scope, clients.semantic)).find(({ jobId }) =>
          jobId === record.job.jobId)?.usage
      : undefined;
    const usage = accountedUsage(
      prepared.definition,
      executionUsage ?? (persistedUsage && (
        persistedUsage.inputTokens > 0 || persistedUsage.outputTokens > 0 || persistedUsage.paidCostUsd !== "0"
      ) ? persistedUsage : undefined),
    );
    await recordJob(record, usage);
    let validated: Awaited<ReturnType<typeof validateSemanticCandidate>>;
    try {
      validated = await validateSemanticCandidate({
        artifacts: clients.artifacts,
        candidate: record.candidate,
        contractRegistry: clients.validationRegistry ?? workspaceSemanticValidationRegistry,
        definition: prepared.definition,
        inputProjection: prepared.inputProjection,
        locators: prepared.locators,
      });
    } catch (error) {
      const code = error instanceof WorkspaceSemanticEvidenceError ? error.code : "model_output_invalid";
      const quarantined = await quarantineHybridEvidenceJob({
        codes: [code],
        jobId: record.job.jobId,
        now: input.now,
      }, clients.jobs);
      await recordJob(quarantined, usage);
      if (reservation) {
        await reconcileHybridEvidenceAttempt({
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          actualPaidCost: usage.paidCostUsd,
          now: input.now,
          outcome: "reconciled",
          reservation,
        }, { workspace: clients.budget });
        budgetSettled = true;
      }
      const notification = await stageWorkspaceSemanticQuarantineHealth({
        definitionVersion: prepared.definition.definitionVersion,
        jobId: quarantined.job.jobId,
        monitorId: primary.projection.subscription.monitorId,
        reasonCodes: quarantined.quarantineCodes,
        scope: input.scope,
        sourceInstanceId: primarySource.sourceInstanceId,
      }, clients.semantic);
      if (notification) await deliverHealthNotification({ notification, scope: input.scope }, clients);
      return Object.freeze({
        ...prepared,
        evidence: null,
        invalidation: null,
        record: quarantined,
        strategyEvidence: null,
      });
    }
    const result = createAcceptedSemanticResult({
      candidate: validated,
      definition: prepared.definition,
      now: input.now ?? new Date(),
      record,
      usage,
    });
    await revalidate();
    const accepted = await acceptHybridEvidenceJob({ jobId: record.job.jobId, now: input.now, result }, clients.jobs);
    const { evidence, invalidation } = await convergeAccepted(accepted, result);
    budgetSettled = true;
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation,
      record: accepted,
      strategyEvidence: result.disposition === "accepted" ? evidence : null,
    });
  } catch (error) {
    if (reservation && !budgetSettled) {
      const latest = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
      record = latest.job.state === "running" || latest.job.state === "prepared"
        ? await markHybridEvidenceJobUncertain({ jobId: latest.job.jobId, now: input.now }, clients.jobs)
        : latest;
      if (record.job.state === "uncertain") {
        await recordJob(record, accountedUsage(prepared.definition, executionUsage));
      }
      await reconcileHybridEvidenceAttempt({
        ...(modelAttempted && executionUsage ? {
          actualInputTokens: executionUsage.inputTokens,
          actualOutputTokens: executionUsage.outputTokens,
          actualPaidCost: executionUsage.paidCostUsd,
        } : {}),
        now: input.now,
        outcome: modelAttempted ? executionUsage ? "reconciled" : "uncertain" : "released",
        reservation,
      }, { workspace: clients.budget });
    }
    throw error;
  }
}

export function readCurrentWorkspaceSemanticEvidence(
  input: { lineageKey: string; scope: AuthorizedWorkspaceStoreScope },
  client?: WorkspaceSemanticEvidenceStoreClient,
) {
  return readCurrentSemanticEvidence(input, client);
}

export function invalidateCurrentWorkspaceSemanticEvidence(input: {
  cause: HybridInvalidationRecord["cause"];
  lineageKey: string;
  now: Date;
  scope: AuthorizedWorkspaceStoreScope;
}, clients: {
  lineage?: HybridEvidenceLineageStoreClient;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
} = {}) {
  return invalidateWorkspaceSemanticHead(input, clients);
}

function addPaid(left: string, right: string): string {
  const micros = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
  };
  const total = micros(left) + micros(right);
  const fraction = (total % 10_000n).toString().padStart(4, "0").replace(/0+$/u, "");
  return `${total / 10_000n}${fraction ? `.${fraction}` : ""}`;
}

export async function inspectWorkspaceHybridEvidence(input: {
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  scope: AuthorizedWorkspaceStoreScope;
  sourceReferences?: readonly PublicSourceWorkspaceReference[];
}, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
  state?: WorkspaceStateStoreClient;
  subscription?: PublicSourceSubscriptionStoreClient;
} = {}) {
  const flags = resolveHybridEvidenceFlags(input.environment);
  const references = [...new Map((input.sourceReferences ?? []).map((reference) => [
    `${reference.sourceInstanceId}\0${reference.subscriptionId}`,
    reference,
  ])).values()];
  const [budget, capabilities, jobs, sourceHealth, recoveryReceipts] = await Promise.all([
    readWorkspaceDocument("budget", input.scope, clients.state),
    readWorkspaceDocument("capabilities", input.scope, clients.state),
    listWorkspaceSemanticJobSummaries(input.scope, clients.semantic),
    Promise.all(references.map((reference) =>
      readPublicSourceWorkspaceHealth({
        clients: { acquisition: clients.acquisition, subscription: clients.subscription },
        environment: input.environment,
        reference,
        scope: input.scope,
      }).catch(() => unavailablePublicSourceWorkspaceHealth(reference, input.environment)))),
    readHybridEvidenceRecoveryObservations(input.scope, clients.state),
  ]);
  const counts = { accepted: 0, completed: 0, failed: 0, prepared: 0, quarantined: 0, running: 0, uncertain: 0 };
  let paidCostUsd = "0";
  let inputTokens = 0;
  let outputTokens = 0;
  for (const job of jobs) {
    counts[job.state] += 1;
    inputTokens += job.usage.inputTokens;
    outputTokens += job.usage.outputTokens;
    paidCostUsd = addPaid(paidCostUsd, job.usage.paidCostUsd);
  }
  const blocked = flags.semanticReasoning && (
    !budget || !capabilities || capabilities.value.workerModelPolicy.allowedModelIds.length === 0
  );
  const quarantines = jobs.filter(({ state }) => state === "quarantined").slice(0, 16).map((job) => Object.freeze({
    definitionVersion: job.definitionVersion,
    reasonCodes: Object.freeze(job.quarantineCodes),
    source: Object.freeze({ authority: job.source.authority, sourceId: job.source.sourceId }),
    validationStatus: "quarantined" as const,
  }));
  const results = jobs.filter(({ state }) => state === "accepted").slice(0, 16).map((job) => Object.freeze({
    citations: Object.freeze(job.citations),
    definitionVersion: job.definitionVersion,
    disposition: job.disposition,
    label: job.label,
    source: Object.freeze({
      authority: job.source.authority,
      factRevisionId: job.source.factRevisionId,
      projectionId: job.source.projectionId,
      sourceId: job.source.sourceId,
    }),
    unknowns: Object.freeze(job.unknowns),
    validationStatus: "accepted" as const,
  }));
  const semanticState = flags.configuration === "misconfigured"
    ? "blocked" as const
    : !flags.semanticReasoning
      ? "disabled" as const
      : blocked
        ? "blocked" as const
        : counts.quarantined > 0
          ? "degraded" as const
          : "available" as const;
  const sourceHistory = sourceHealth.slice(0, 16).map((health: PublicSourceWorkspaceHealth) => Object.freeze({
    adapterId: health.adapterId,
    adapterVersion: health.adapterVersion,
    extraction: Object.freeze({ ...health.extraction }),
    healthState: health.healthState,
    lastOutcome: health.lastOutcome ? Object.freeze({ ...health.lastOutcome }) : null,
    sourceId: health.sourceId,
  }));
  const sourceState = flags.configuration === "misconfigured"
    ? "blocked" as const
    : !flags.extractionRecovery
      ? "disabled" as const
      : sourceHealth.some(({ healthState }) => healthState === "degraded" || healthState === "unavailable")
        ? "degraded" as const
        : "available" as const;
  const state = flags.configuration === "misconfigured" || semanticState === "blocked" || sourceState === "blocked"
    ? "blocked" as const
    : semanticState === "disabled" && sourceState === "disabled"
      ? "disabled" as const
      : semanticState === "degraded" || sourceState === "degraded"
        ? "degraded" as const
        : "available" as const;
  return Object.freeze({
    counts: Object.freeze(counts),
    history: Object.freeze({
      recoveryReceipts: Object.freeze(recoveryReceipts),
      sourceGlobalExtraction: Object.freeze(sourceHistory),
      workspaceSemantic: Object.freeze([...results, ...quarantines].slice(0, 16)),
    }),
    lanes: Object.freeze({
      sourceGlobalExtraction: Object.freeze({ history: Object.freeze(sourceHistory), state: sourceState }),
      workspaceSemantic: Object.freeze({
        counts: Object.freeze({ ...counts }),
        history: Object.freeze([...results, ...quarantines].slice(0, 16)),
        state: semanticState,
        usage: Object.freeze({ inputTokens, outputTokens, paidCostUsd }),
      }),
    }),
    quarantines: Object.freeze(quarantines),
    reasonCode: flags.configuration === "misconfigured"
      ? "hybrid_configuration_invalid"
      : blocked ? "hybrid_workspace_policy_unavailable" : null,
    results: Object.freeze(results),
    state,
    usage: Object.freeze({ inputTokens, outputTokens, paidCostUsd }),
  });
}
