import { z } from "zod";

import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
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
  type HybridEvidenceJobRecord,
  type HybridEvidenceJobStoreClient,
} from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import {
  acknowledgeWorkspaceSemanticHealthNotification,
  advanceWorkspaceSemanticHead,
  createWorkspaceSemanticSource,
  invalidateWorkspaceSemanticHead,
  listWorkspaceSemanticJobSummaries,
  readCurrentWorkspaceSemanticEvidence as readCurrentSemanticEvidence,
  recordWorkspaceSemanticJob,
  stageWorkspaceSemanticQuarantineHealth,
  writeWorkspaceSemanticEvidence,
  type WorkspaceSemanticEvidence,
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

export interface WorkspaceSemanticModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly paidCostUsd: string;
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
    sourceId: "unknown",
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
  if (
    !strategy || strategy.schemaVersion !== 2 || !capabilities ||
    strategy.value.lifecycleState !== "active" ||
    strategy.value.pack === null || strategy.value.pack.contentDigest === null ||
    !pack ||
    strategy.value.pack.id !== pack.id ||
    strategy.value.pack.version !== pack.version ||
    strategy.value.pack.contentDigest !== pack.contentDigest ||
    strategy.value.bindingRevision !== strategy.value.lastActiveSnapshot?.bindingRevision ||
    strategy.value.lastActiveSnapshot?.packContentDigest !== pack.contentDigest ||
    strategy.value.lastActiveSnapshot?.packId !== pack.id ||
    strategy.value.lastActiveSnapshot?.packVersion !== pack.version ||
    strategy.value.lastActiveSnapshot?.workspaceGeneration !== input.workspaceGeneration ||
    strategy.value.effectiveCapabilityManifestRevision !== capabilities.revision ||
    strategy.value.lastActiveSnapshot?.capabilityManifestRevision !== capabilities.revision ||
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
    subscriptionId: input.projectionReference.subscriptionId,
  }, clients);
  const projection = resolved
    ? { ...resolved, sourceId: input.projectionReference.sourceId }
    : null;
  if (!projection) authorizationError();
  const source = pack.sources.find(({ sourceId }) => sourceId === projection.sourceId);
  const capabilitySource = capabilities.value.sources.find((candidate) =>
    candidate.sourceId === projection.sourceId);
  let artifactOrigin: string;
  try {
    artifactOrigin = new URL(artifact.canonicalPublicUrl).origin;
  } catch {
    return authorizationError();
  }
  if (
    !source || !capabilitySource || !("contractDigest" in capabilitySource) ||
    capabilitySource.contractDigest !== source.contractDigest ||
    capabilitySource.contractVersion !== source.contractVersion ||
    JSON.stringify(capabilitySource.allowedOrigins) !== JSON.stringify(source.allowedOrigins) ||
    !source.allowedOrigins.includes(artifactOrigin) ||
    artifact.accessClassification !== "public" ||
    artifact.sourceInstanceId !== projection.fact.sourceInstanceId ||
    artifact.sourceInstanceId !== projection.projection.sourceInstanceId ||
    artifact.sourceInstanceId !== projection.subscription.sourceInstanceId ||
    projection.projection.workspaceId !== input.scope.workspaceId ||
    projection.subscription.workspaceId !== input.scope.workspaceId ||
    projection.projection.subscriptionId !== projection.subscription.subscriptionId ||
    projection.projection.factRevisionId !== projection.fact.revisionId ||
    projection.projection.acquisitionId !== projection.subscription.deliveryCursor.lastAcquisitionId ||
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

function injectionDetected(texts: readonly string[]): boolean {
  return texts.some((text) =>
    /(?:^|\b)(?:system\s*:|ignore (?:all |the )?(?:previous |above )?(?:instructions?|schema)|reveal another workspace|call (?:a )?broker|submit (?:a )?trade)/iu.test(text));
}

function sameLocator(left: EvidenceLocator, right: EvidenceLocator): boolean {
  return digestHybridEvidenceValue(left) === digestHybridEvidenceValue(right);
}

async function validateSemanticCandidate(input: {
  artifacts: HybridEvidenceArtifactStore;
  candidate: unknown;
  contractRegistry: WorkspaceSemanticValidationRegistry;
  definition: HybridEvidenceJobDefinition;
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
  const texts = await Promise.all(textLocators.map(async (locator) =>
    (await input.artifacts.readSlice({ locator, maximumBytes: 64 * 1_024 })).content));
  if (injectionDetected(texts)) throw new WorkspaceSemanticEvidenceError("prompt_injection_detected");
  if (candidate.disposition === "quarantined") {
    throw new WorkspaceSemanticEvidenceError("model_output_invalid");
  }
  const contract = input.contractRegistry.resolve(input.definition);
  if (!contract) throw new WorkspaceSemanticEvidenceError("definition_digest_mismatch");
  let validated: {
    readonly assertionCitations: readonly EvidenceLocator[];
    readonly payload: Readonly<Record<string, unknown>>;
  };
  try {
    validated = contract.validate({
      disposition: candidate.disposition,
      fields: candidate.fields,
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
  paidCostUsd: z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,4})?$/u),
}).strict();

function accountedUsage(
  definition: HybridEvidenceJobDefinition,
  usage: WorkspaceSemanticModelUsage | void,
): WorkspaceSemanticModelUsage {
  return Object.freeze(semanticUsageSchema.parse(usage ?? {
    inputTokens: definition.limits.maximumInputTokens,
    outputTokens: definition.limits.maximumOutputTokens,
    paidCostUsd: definition.limits.maximumPaidCostUsd,
  }));
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
>[0] & { environment?: NodeJS.ProcessEnv }, clients: {
  acquisition?: PublicSourceAcquisitionStoreClient;
  artifacts: HybridEvidenceArtifactStore;
  budget?: WorkspaceBudgetLedgerClient;
  catalog?: SemanticPackCatalog;
  execute(prepared: PreparedHybridEvidenceWorkerRun): Promise<WorkspaceSemanticModelUsage | void>;
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
  let executionUsage: WorkspaceSemanticModelUsage | void = undefined;
  let modelAttempted = false;
  let budgetSettled = false;
  try {
    if (record.job.state === "prepared") {
      reservation = await reserveHybridEvidenceAttempt({
        definition: prepared.definition,
        environment: input.environment,
        job: record.job,
        now: input.now,
        scope: input.scope,
      }, { state: clients.state, workspace: clients.budget });
      const worker = await prepareHybridEvidenceWorkerRun({
        budget: reservation,
        definition: prepared.definition,
        environment: input.environment,
        jobClient: clients.jobs,
        locators: prepared.locators,
        now: input.now,
        prepared: record,
      });
      record = worker.record;
      await recordWorkspaceSemanticJob({ job: record.job, scope: input.scope, source: prepared.source }, clients.semantic);
      try {
        modelAttempted = true;
        executionUsage = await clients.execute(worker);
      } catch (error) {
        record = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
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
      record = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
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
  const [budget, capabilities, jobs, sourceHealth] = await Promise.all([
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
