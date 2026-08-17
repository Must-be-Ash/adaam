import { z } from "zod";

import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
import {
  reconcileHybridEvidenceAttempt,
  reserveHybridEvidenceAttempt,
  type HybridEvidenceBudgetReservation,
} from "./hybrid-evidence-budget";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import {
  acceptHybridEvidenceJob,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  type HybridEvidenceJobRecord,
  type HybridEvidenceJobStoreClient,
} from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import {
  advanceWorkspaceSemanticHead,
  createWorkspaceSemanticSource,
  invalidateWorkspaceSemanticHead,
  listWorkspaceSemanticJobSummaries,
  readCurrentWorkspaceSemanticEvidence as readCurrentSemanticEvidence,
  readWorkspaceSemanticEvidence,
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

const semanticCitationSchema = evidenceLocatorSchema.refine(
  (locator) => locator.kind === "text_span",
  "semantic_claim_requires_text_span",
);
const semanticAssertionSchema = z.object({
  citations: z.array(semanticCitationSchema).min(1).max(8),
  summary: z.string().trim().min(1).max(500),
}).strict();
const semanticPayloadSchema = z.object({
  claims: z.array(semanticAssertionSchema).min(1).max(16),
  counterevidence: z.array(semanticAssertionSchema).max(16),
  label: z.enum(["improving", "mixed", "more_cautious", "unknown"]),
}).strict();
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
  locators: readonly EvidenceLocator[];
}): Promise<{
  disposition: "accepted" | "abstained";
  payload: z.infer<typeof semanticPayloadSchema>;
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
  const payload = semanticPayloadSchema.parse(candidate.fields);
  const assertions = [...payload.claims, ...payload.counterevidence];
  if (
    assertions.some(({ citations }) => citations.some((citation) =>
      !candidate.citations.some((candidateCitation) => sameLocator(candidateCitation, citation)) ||
      !textLocators.some((allowed) => sameLocator(allowed, citation)))) ||
    candidate.citations.some((citation) =>
      !input.locators.some((allowed) => sameLocator(allowed, citation)))
  ) throw new WorkspaceSemanticEvidenceError("citation_invalid");
  await Promise.all(assertions.flatMap(({ citations }) => citations).map((locator) =>
    input.artifacts.readSlice({ locator, maximumBytes: 64 * 1_024 })));
  const accepted = candidate.disposition === "accepted";
  if (
    (accepted && (
      !["improving", "more_cautious"].includes(payload.label) ||
      payload.counterevidence.length > 0 ||
      candidate.unknowns.length > 0
    )) ||
    (!accepted && (
      !["mixed", "unknown"].includes(payload.label) ||
      candidate.unknowns.length === 0
    ))
  ) throw new WorkspaceSemanticEvidenceError("model_output_invalid");
  return Object.freeze({
    citations: Object.freeze(candidate.citations),
    disposition: candidate.disposition,
    payload: Object.freeze(payload),
    unknowns: Object.freeze(candidate.unknowns),
  });
}

function createAcceptedSemanticResult(input: {
  candidate: Awaited<ReturnType<typeof validateSemanticCandidate>>;
  definition: HybridEvidenceJobDefinition;
  now: Date;
  record: HybridEvidenceJobRecord;
  usage?: { inputTokens: number; outputTokens: number; paidCostUsd: string };
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
    usage: input.usage ?? { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" },
    validatedAt: input.now.toISOString(),
    validationTrace: [{
      errorCode: null,
      outcome: "passed",
      validatorId: input.definition.requiredValidator.validatorId,
      validatorVersion: input.definition.requiredValidator.version,
    }],
  });
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

export async function runWorkspaceSemanticEvidenceJob(input: Parameters<
  typeof prepareWorkspaceSemanticEvidenceJob
>[0] & { environment?: NodeJS.ProcessEnv }, clients: {
  artifacts: HybridEvidenceArtifactStore;
  budget?: WorkspaceBudgetLedgerClient;
  catalog?: SemanticPackCatalog;
  execute(prepared: PreparedHybridEvidenceWorkerRun): Promise<void>;
  jobs?: HybridEvidenceJobStoreClient;
  lineage?: HybridEvidenceLineageStoreClient;
  monitor?: WorkspaceMonitorStoreClient;
  notifyHealth?(notification: WorkspaceSemanticHealthNotification): Promise<void>;
  resolveProjection?: typeof defaultProjection;
  semantic?: WorkspaceSemanticEvidenceStoreClient;
  state?: WorkspaceStateStoreClient;
}): Promise<WorkspaceSemanticEvidenceRunResult> {
  const flags = resolveHybridEvidenceFlags(input.environment);
  if (!flags.semanticReasoning) throw new WorkspaceSemanticEvidenceError("workspace_scope_mismatch");
  const prepared = await prepareWorkspaceSemanticEvidenceJob(input, {
    catalog: clients.catalog,
    jobs: clients.jobs,
    resolveProjection: clients.resolveProjection,
    state: clients.state,
  });
  await recordWorkspaceSemanticJob({
    job: prepared.record.job,
    quarantineCodes: prepared.record.quarantineCodes,
    result: prepared.record.acceptedResult,
    scope: input.scope,
    source: prepared.source,
  }, clients.semantic);
  if (prepared.record.job.state === "accepted" && prepared.record.acceptedResult) {
    const evidence = await readWorkspaceSemanticEvidence({
      resultId: prepared.record.acceptedResult.resultId,
      scope: input.scope,
    }, clients.semantic);
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation: null,
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
      if (clients.notifyHealth) await clients.notifyHealth(notification);
      else await defaultHealthNotification({ notification, scope: input.scope }, clients.monitor);
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
      await clients.execute(worker);
      record = (await readHybridEvidenceJob(record.job.jobId, clients.jobs)) ?? record;
    }
    if (record.job.state !== "completed" || !record.candidate) {
      throw new WorkspaceSemanticEvidenceError("model_output_invalid");
    }
    let validated: Awaited<ReturnType<typeof validateSemanticCandidate>>;
    try {
      validated = await validateSemanticCandidate({
        artifacts: clients.artifacts,
        candidate: record.candidate,
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
      }, clients.semantic);
      if (reservation) {
        await reconcileHybridEvidenceAttempt({
          actualInputTokens: 0,
          actualOutputTokens: 0,
          actualPaidCost: "0",
          now: input.now,
          outcome: "reconciled",
          reservation,
        }, { workspace: clients.budget });
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
        if (clients.notifyHealth) await clients.notifyHealth(notification);
        else await defaultHealthNotification({ notification, scope: input.scope }, clients.monitor);
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
    });
    const accepted = await acceptHybridEvidenceJob({
      jobId: record.job.jobId,
      now: input.now,
      result,
    }, clients.jobs);
    const previous = await readCurrentSemanticEvidence({
      lineageKey: prepared.lineageKey,
      scope: input.scope,
    }, clients.semantic);
    const evidence = await writeWorkspaceSemanticEvidence({
      lineageKey: prepared.lineageKey,
      now: input.now ?? new Date(),
      result,
      scope: input.scope,
      source: prepared.source,
    }, clients.semantic);
    const invalidation = await advanceWorkspaceSemanticHead({
      cause: invalidationCause(previous, result, prepared.source),
      lineageKey: prepared.lineageKey,
      now: input.now ?? new Date(),
      resultId: result.resultId,
      scope: input.scope,
    }, { lineage: clients.lineage, semantic: clients.semantic });
    await clients.artifacts.setReference({
      active: true,
      artifactDigest: prepared.artifact.contentDigest,
      kind: "accepted_result",
      referenceId: result.resultId,
    });
    await recordWorkspaceSemanticJob({ job: accepted.job, result, scope: input.scope, source: prepared.source }, clients.semantic);
    if (reservation) {
      await reconcileHybridEvidenceAttempt({
        actualInputTokens: result.usage.inputTokens,
        actualOutputTokens: result.usage.outputTokens,
        actualPaidCost: result.usage.paidCostUsd,
        now: input.now,
        outcome: "reconciled",
        reservation,
      }, { workspace: clients.budget });
    }
    return Object.freeze({
      ...prepared,
      evidence,
      invalidation,
      record: accepted,
      strategyEvidence: result.disposition === "accepted" ? evidence : null,
    });
  } catch (error) {
    if (reservation) {
      await reconcileHybridEvidenceAttempt({
        now: input.now,
        outcome: record.job.state === "running" ? "uncertain" : "released",
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
}, clients: {
  semantic?: WorkspaceSemanticEvidenceStoreClient;
  state?: WorkspaceStateStoreClient;
} = {}) {
  const flags = resolveHybridEvidenceFlags(input.environment);
  if (!flags.enabled || !flags.semanticReasoning) {
    return Object.freeze({
      counts: { accepted: 0, completed: 0, failed: 0, prepared: 0, quarantined: 0, running: 0, uncertain: 0 },
      quarantines: Object.freeze([]),
      reasonCode: flags.configuration === "misconfigured" ? "hybrid_configuration_invalid" : null,
      results: Object.freeze([]),
      state: flags.configuration === "misconfigured" ? "blocked" as const : "disabled" as const,
      usage: { inputTokens: 0, outputTokens: 0, paidCostUsd: "0" },
    });
  }
  const [budget, capabilities, jobs] = await Promise.all([
    readWorkspaceDocument("budget", input.scope, clients.state),
    readWorkspaceDocument("capabilities", input.scope, clients.state),
    listWorkspaceSemanticJobSummaries(input.scope, clients.semantic),
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
  const blocked = !budget || !capabilities || capabilities.value.workerModelPolicy.allowedModelIds.length === 0;
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
  return Object.freeze({
    counts: Object.freeze(counts),
    quarantines: Object.freeze(quarantines),
    reasonCode: blocked ? "hybrid_workspace_policy_unavailable" : null,
    results: Object.freeze(results),
    state: blocked
      ? "blocked" as const
      : counts.quarantined > 0
        ? "degraded" as const
        : "available" as const,
    usage: Object.freeze({ inputTokens, outputTokens, paidCostUsd }),
  });
}
