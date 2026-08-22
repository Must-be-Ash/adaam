import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  buildEarningsCallEvidenceTimeline,
  type EarningsCallEvidenceRecord,
} from "./earnings-call-comparison";
import {
  persistEarningsCallFinding,
  readEarningsCallFindingByEventRevision,
  type EarningsCallFindingStoreClient,
} from "./earnings-call-finding-store";
import { assessEarningsCallSourceCorrection } from "./earnings-call-correction-policy";
import { runEarningsCallTranscriptLayoutRecovery } from "./earnings-call-hybrid-evidence-recovery";
import {
  persistEarningsCallIssuerStatus,
  readEarningsCallIssuerStatus,
  type EarningsCallIssuerStatusStoreClient,
} from "./earnings-call-status-store";
import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import { createEarningsCallFinding } from "./earnings-call-materiality";
import {
  createEarningsCallComparisonDefinitions,
  EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
  EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
} from "./hybrid-evidence-definition-registry";
import { EARNINGS_CALL_POLICY, resolveEarningsCallFlags } from "./earnings-call-policy";
import {
  EARNINGS_CALL_SCHEMA_VERSION,
  digestEarningsCallValue,
  earningsEventSchema,
} from "./earnings-call-schema";
import {
  runEarningsCallSemanticComparison,
  type EarningsCallSemanticEvidenceInput,
} from "./earnings-call-semantic";
import { normalizeEarningsCallTranscript } from "./earnings-call-transcript";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactStore,
} from "./hybrid-evidence-artifact-store";
import {
  createEarningsCallResearchDefinition,
  EARNINGS_CALL_RESEARCH_DEFINITION_ID,
  EARNINGS_CALL_RESEARCH_DEFINITION_VERSIONS,
  earningsCallResearchEvidenceContent,
  isEarningsCallAgenticResearchPack,
  type EarningsCallResearchDefinitionVersion,
} from "./earnings-call-research";
import {
  buildEarningsCallSignalReport,
  earningsCallAlertPresentationForBrief,
  earningsCallReportArtifactId,
} from "./earnings-call-signal-report";
import { runWorkspaceSemanticEvidenceBundleJob } from "./hybrid-evidence-semantic";
import {
  shouldPublishWorkspaceExecutiveArtifact,
  workspaceExecutiveBriefSchema,
  type WorkspaceExecutiveBrief,
} from "./workspace-executive-brief";
import { publishReportArtifact } from "./artifact-store";
import { artifactReferenceForId } from "./artifact-reference";
import { startHybridEvidenceWorkerTask } from "./hybrid-evidence-worker";
import { resolveHybridEvidenceFlags } from "./hybrid-evidence-flags";
import {
  assertHybridModelRouteAllowed,
  resolveHybridTaskModelRoute,
} from "./hybrid-evidence-model-routing";
import {
  readPublicSourceCorrection,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import { coordinatePublicSourceOccurrence } from "./public-source-coordinator";
import type {
  EarningsCallPublicSourceRequest,
  EarningsCallPublicSourceResponse,
  EarningsCallTransientArtifact,
} from "./earnings-call-public-source-adapter";
import {
  acknowledgePublicSourceProjection,
  readAuthorizedPublicSourceProjection,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  createEarningsCallSourceLifecycleStore,
  type EarningsCallSourceLifecycleStore,
} from "./earnings-call-source-lifecycle-store";
import {
  EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
} from "./strategy-pack-reference-catalog";
import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "./strategy-pack-source-resolution";
import {
  readWorkspaceFindingIdentityClaim,
  readWorkspaceRunOutcome,
  type WorkspaceFindingCandidate,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import { readWorkspaceAlert } from "./workspace-alert-store";
import type { EarningsCallChangeFact } from "./workspace-finding-facts";
import { getWorkspaceMonitor, type WorkspaceMonitor } from "./workspace-monitor-store";
import {
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "./workspace-source-coverage";
import { readWorkspaceDocument } from "./workspace-state-store";
import {
  authorizeWorkspaceWorkerStore,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  finalizePriorWorkspaceRunOutcomeForControlPlane,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";
import { createEarningsCallPublicSourceFetch } from "./earnings-call-source-transport";
import type { WorkspaceGlobalBudgetClient } from "./workspace-dispatch-budget";

export { EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];
type SemanticClients = Parameters<typeof runEarningsCallSemanticComparison>[1];
type EarningsCallSemanticResult = Awaited<ReturnType<
  typeof runEarningsCallSemanticComparison
>>["sections"][number];

export function resolveEarningsCallAcceptedArtifactReferences(
  results: readonly Pick<EarningsCallSemanticResult, "artifacts" | "evidence">[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const referenceIdsByArtifact = new Map<string, Set<string>>();
  for (const result of results) {
    if (!result.evidence) continue;
    for (const artifact of result.artifacts) {
      const referenceIds = referenceIdsByArtifact.get(artifact.contentDigest) ?? new Set();
      referenceIds.add(result.evidence.result.resultId);
      referenceIdsByArtifact.set(artifact.contentDigest, referenceIds);
    }
  }
  return referenceIdsByArtifact;
}

export interface EarningsCallWorkspaceWorkerClients extends WorkspaceWorkerControlPlaneClients {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly artifacts?: HybridEvidenceArtifactStore;
  readonly earningsFindings?: EarningsCallFindingStoreClient;
  readonly earningsStatus?: EarningsCallIssuerStatusStoreClient;
  readonly fetchResponse?: (request: EarningsCallPublicSourceRequest) => Promise<EarningsCallPublicSourceResponse>;
  readonly hybridGlobalBudget?: WorkspaceGlobalBudgetClient;
  readonly semantic?: Omit<SemanticClients, "artifacts"> & { readonly artifacts?: HybridEvidenceArtifactStore };
  readonly publishReport?: typeof publishReportArtifact;
  readonly sourceLifecycle?: EarningsCallSourceLifecycleStore;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
}

export interface EarningsCallWorkspaceWorkerResult {
  readonly evaluatedIssuers: number;
  readonly materialFindings: number;
  readonly outcome: WorkspaceRunOutcome;
  readonly replayed: boolean;
}

export class EarningsCallWorkspaceWorkerError extends Error {
  constructor(readonly code:
    | "earnings_call_capability_denied"
    | "earnings_call_execution_disabled"
    | "earnings_call_monitor_invalid"
    | "earnings_call_source_unavailable"
    | "earnings_call_strategy_invalid"
  ) {
    super(code);
    this.name = "EarningsCallWorkspaceWorkerError";
  }
}

export class EarningsCallWorkspaceWorkerRetryableError extends Error {
  constructor(
    readonly acquisitionId: string,
    readonly retryAfterSeconds: number,
  ) {
    super("earnings_call_source_retryable");
    this.name = "EarningsCallWorkspaceWorkerRetryableError";
  }
}

function assertMonitor(
  monitor: WorkspaceMonitor | null,
  envelope: ReturnType<typeof requireWorkspaceWorkerAuth>,
): asserts monitor is WorkspaceMonitor {
  const pack = envelope.strategyPack;
  if (
    !monitor || monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    monitor.managedBy?.packId !== "earnings-call-changes" ||
    !pack ||
    pack.packId !== monitor.managedBy.packId ||
    pack.packVersion !== monitor.managedBy.packVersion ||
    pack.packContentDigest !== monitor.managedBy.packContentDigest ||
    pack.bindingRevision !== monitor.managedBy.bindingRevision ||
    pack.resourceId !== monitor.managedBy.resourceId ||
    !monitor.activationWatermark ||
    monitor.sources.length < 1 || monitor.sources.length > 8 ||
    monitor.sources.some(({ sourceId }) => !/^earnings-call-transcripts\.\d{10}$/u.test(sourceId))
  ) throw new EarningsCallWorkspaceWorkerError("earnings_call_monitor_invalid");
}

function hasMatchingSemanticDefinitions(
  pack: Pick<StrategyPackCatalogEntry, "evidenceContracts" | "version">,
  modelId: string,
): boolean {
  return createEarningsCallComparisonDefinitions(
    [modelId],
    // 1.0.0 signed the comparison children at the policy envelope's own
    // defaults. Every version after it signs the sized session, and this
    // migration does not change that reviewed comparison contract.
    pack.version === "1.0.0"
      ? {}
      : {
          maximumRuntimeMs: EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
          maximumSessionInputTokens: EARNINGS_CALL_POLICY.semanticEnvelope.maximumAggregateInputTokens,
          maximumSessionOutputTokens: EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
        },
  ).every((definition) =>
    pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest)
  );
}

export function resolveEarningsCallSemanticRoute(input: {
  readonly allowedModelIds: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly pack: Pick<StrategyPackCatalogEntry, "evidenceContracts" | "version">;
}) {
  const configured = resolveHybridTaskModelRoute(
    "semantic_interpretation",
    input.environment,
  );
  const matches = [...new Set(input.allowedModelIds)]
    .filter((modelId) => hasMatchingSemanticDefinitions(input.pack, modelId));
  if (matches.length !== 1) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const route = Object.freeze({
    ...configured,
    modelId: matches[0]!,
  });
  assertHybridModelRouteAllowed(route, input.allowedModelIds);
  return route;
}

type EarningsCallResearchRuntime = Readonly<{
  definition: ReturnType<typeof createEarningsCallResearchDefinition>;
  modelId: string;
  pack: StrategyPackCatalogEntry;
  reasoning: ReturnType<typeof resolveHybridTaskModelRoute>["reasoning"];
  workspaceGeneration: number;
}>;

/*
 * The frontier research lane is selected only by what the bound pack declares.
 * A pack version that does not declare the research contract keeps the reviewed
 * comparison result exactly as it shipped, and no occurrence of it reaches
 * frontier reasoning, paid research, or artifact publication.
 */
export function resolveEarningsCallResearchRuntime(input: {
  readonly allowedModelIds: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly pack: StrategyPackCatalogEntry;
  readonly workspaceGeneration: number;
}): EarningsCallResearchRuntime | null {
  if (!isEarningsCallAgenticResearchPack(input.pack)) return null;
  const configured = resolveHybridTaskModelRoute(
    "semantic_interpretation",
    input.environment,
  );
  const candidates = [...new Set(input.allowedModelIds)]
    .flatMap((modelId) => (input.pack.evidenceContracts ?? []).flatMap((contract) =>
      contract.id === EARNINGS_CALL_RESEARCH_DEFINITION_ID &&
          EARNINGS_CALL_RESEARCH_DEFINITION_VERSIONS.includes(
            contract.version as EarningsCallResearchDefinitionVersion,
          )
        ? [createEarningsCallResearchDefinition(
            [modelId],
            contract.version as EarningsCallResearchDefinitionVersion,
          )]
        : []
    ))
    .filter((definition) => input.pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest));
  if (candidates.length !== 1) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const route = Object.freeze({ ...configured, modelId: candidates[0]!.allowedModelIds[0]! });
  assertHybridModelRouteAllowed(route, input.allowedModelIds);
  return Object.freeze({
    definition: candidates[0]!,
    modelId: route.modelId,
    pack: input.pack,
    reasoning: route.reasoning,
    workspaceGeneration: input.workspaceGeneration,
  });
}

export async function materializeEarningsCallExecutiveOutput(input: {
  asOf: string;
  approvedSupplementaryUrls: readonly string[];
  brief: WorkspaceExecutiveBrief;
  clients?: EarningsCallWorkspaceWorkerClients;
  factIdentities: readonly string[];
  officialUrls: readonly string[];
  scope: AuthorizedWorkspaceStoreScope;
  signal?: AbortSignal;
}): Promise<Readonly<{
  artifactRefs: readonly string[];
  presentation: { title: string; whyMatched: string };
}>> {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const officialUrls = new Set(input.officialUrls);
  const briefOfficialUrls = new Set(
    brief.sources.filter(({ role }) => role === "official").map(({ url }) => url),
  );
  const approvedSupplementaryUrls = new Set(input.approvedSupplementaryUrls);
  if (
    officialUrls.size !== briefOfficialUrls.size ||
    [...officialUrls].some((url) => !briefOfficialUrls.has(url)) ||
    brief.sources.some(({ role, url }) =>
      role === "supplementary" && !approvedSupplementaryUrls.has(url)
    ) ||
    brief.materialFacts.some(({ sourceUrls }) =>
      !sourceUrls.some((url) => officialUrls.has(url))
    )
  ) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const presentation = earningsCallAlertPresentationForBrief(brief);
  if (!shouldPublishWorkspaceExecutiveArtifact({
    alertText: `${presentation.title}\n\n${presentation.whyMatched}`,
    brief,
  })) {
    return Object.freeze({ artifactRefs: Object.freeze([]), presentation });
  }
  const artifactId = earningsCallReportArtifactId({
    factIdentities: input.factIdentities,
    ownerId: input.scope.ownerId,
    workspaceId: input.scope.workspaceId,
  });
  const published = await (input.clients?.publishReport ?? publishReportArtifact)({
    artifactId,
    report: buildEarningsCallSignalReport({ asOf: input.asOf, brief }),
    signal: input.signal,
  });
  if (published.artifactId !== artifactId || published.kind !== "report") {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  return Object.freeze({
    artifactRefs: Object.freeze([artifactReferenceForId(artifactId)]),
    presentation,
  });
}

type EarningsCallMaterialResult = NonNullable<
  Awaited<ReturnType<typeof processIssuer>>["material"]
>;

/*
 * One bounded frontier pass over the already-material findings of this
 * occurrence. It never re-decides the reviewed comparison; it decides whether
 * one supplementary research pass helps the owner understand it, then commits
 * one executive brief. A no-new-facts occurrence never reaches this function,
 * so it records no frontier, research, or artifact spend.
 */
async function runEarningsCallExecutiveResearch(input: {
  readonly clients?: EarningsCallWorkspaceWorkerClients;
  readonly environment: NodeJS.ProcessEnv;
  readonly material: readonly EarningsCallMaterialResult[];
  readonly now: Date;
  readonly parentRunId: string;
  readonly runtime: EarningsCallResearchRuntime;
  readonly scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
  readonly signal?: AbortSignal;
}): Promise<Readonly<{
  artifactRefs: readonly string[];
  presentation: { title: string; whyMatched: string };
}>> {
  if (input.material.length === 0 || input.material.length > 8) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const artifacts = input.clients?.artifacts ?? input.clients?.semantic?.artifacts ??
    createHybridEvidenceEphemeralArtifactStore();
  const persisted: Array<Readonly<{
    artifact: Awaited<ReturnType<HybridEvidenceArtifactStore["persist"]>>;
    content: string;
    material: EarningsCallMaterialResult;
  }>> = [];
  try {
    for (const material of input.material) {
      const { finding } = material.record;
      const content = earningsCallResearchEvidenceContent({
        canonicalUrl: material.research.sourceUrl,
        cik: material.record.cik,
        companyName: material.record.companyName,
        confidence: finding.confidence,
        counterevidence: finding.counterevidence.map(({ statement }) => statement),
        currentFiscalPeriod: material.current.event.fiscalPeriod,
        findingId: finding.findingId,
        inferences: finding.inferences.map(({ statement }) => statement),
        materialFacts: finding.facts.map(({ statement }) => statement),
        priorFiscalPeriod: material.research.priorFiscalPeriod,
        ticker: material.record.ticker,
        uncertainty: [...finding.unknowns],
      });
      const artifact = await artifacts.persist({
        acquisitionId: material.research.acquisitionId,
        authority: "ISSUER",
        bytes: Buffer.from(content, "utf8"),
        canonicalPublicUrl: material.research.sourceUrl,
        mediaType: "text/plain",
        now: input.now,
        observedAt: material.research.observedAt,
        parserEligibility: null,
        sourceInstanceId: material.research.sourceInstanceId,
        structure: {
          characterCount: content.length,
          columnCount: null,
          pageCount: null,
          rowCount: null,
          sheetCount: null,
        },
      });
      persisted.push(Object.freeze({ artifact, content, material }));
    }
    const semantic = await runWorkspaceSemanticEvidenceBundleJob({
      definition: input.runtime.definition,
      environment: input.environment,
      members: persisted.map(({ artifact, content, material }) => ({
        artifact,
        locators: [{
          factRevisionId: material.research.factRevisionId,
          kind: "source_fact" as const,
          payloadDigest: material.research.factPayloadDigest,
        }, {
          artifactDigest: artifact.contentDigest,
          end: content.length,
          kind: "text_span" as const,
          spanDigest: createHash("sha256").update(content).digest("hex"),
          start: 0,
        }],
        memberId: material.research.factRevisionId,
        projectionReference: material.research.projectionReference,
        role: "section" as const,
        semanticContext: Object.freeze({ earningsCallFinding: true }),
      })),
      modelId: input.runtime.modelId,
      now: input.now,
      pack: {
        contentDigest: input.runtime.pack.contentDigest,
        id: input.runtime.pack.id,
        version: input.runtime.pack.version,
      },
      parentBudgetRunId: input.parentRunId,
      reasoning: input.runtime.reasoning,
      scope: input.scope,
      workspaceGeneration: input.runtime.workspaceGeneration,
    }, {
      acquisition: input.clients?.acquisition,
      artifacts,
      budget: input.clients?.semantic?.budget,
      catalog: input.clients?.semantic?.catalog,
      execute: input.clients?.semantic?.execute ??
        (async (prepared) => drainHybridWorker(prepared.request)),
      jobs: input.clients?.semantic?.jobs,
      lineage: input.clients?.semantic?.lineage,
      monitor: input.clients?.monitor,
      semantic: input.clients?.semantic?.semantic,
      state: input.clients?.state,
      subscription: input.clients?.subscription,
    });
    const accepted = semantic.record.acceptedResult;
    if (!accepted) {
      throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
    }
    return materializeEarningsCallExecutiveOutput({
      approvedSupplementaryUrls: semantic.record.researchUrlGrants,
      asOf: input.material.map(({ current }) => current.event.publishedAt).sort().at(-1)!,
      brief: workspaceExecutiveBriefSchema.parse(accepted.payload),
      clients: input.clients,
      factIdentities: input.material.map(({ record }) => record.finding.findingId),
      officialUrls: input.material.map(({ research }) => research.sourceUrl),
      scope: input.scope,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } finally {
    for (const { artifact } of persisted) {
      await artifacts.deleteUnreferenced(artifact.contentDigest);
    }
  }
}

const defaultFetchResponse = createEarningsCallPublicSourceFetch();

async function drainHybridWorker(
  request: Parameters<typeof startHybridEvidenceWorkerTask>[0],
): Promise<void> {
  const handle = await startHybridEvidenceWorkerTask(request);
  const reader = handle.events.getReader();
  try {
    while (!(await reader.read()).done) {
      // Completion is durably recorded by the compiled hybrid worker tool.
    }
  } finally {
    reader.releaseLock();
  }
}

function eventForArtifact(artifact: EarningsCallTransientArtifact) {
  const payload = artifact.fact.payload;
  if (payload.schemaVersion !== "earnings-call-event/v1") {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
  const publishedAt = payload.secContext?.acceptanceDateTime ?? `${payload.callDate}T00:00:00.000Z`;
  return earningsEventSchema.parse({
    artifactByteCount: payload.artifactByteCount,
    artifactDigest: payload.artifactDigest,
    callDate: payload.callDate,
    cik: payload.cik,
    eventId: artifact.fact.logicalKey,
    fiscalPeriod: payload.fiscalPeriod,
    observedAt: artifact.fact.createdObservedAt,
    publishedAt,
    recordType: "earnings_call_event",
    revision: 1,
    revisionId: artifact.fact.revisionId,
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    secAccession: payload.secContext?.accessionNumber ?? null,
    sourceInstanceId: artifact.fact.sourceInstanceId,
  });
}

function thresholdValue(value: unknown): number {
  if (value === "threshold_50") return 50;
  if (value === "threshold_65") return 65;
  if (value === "threshold_80") return 80;
  throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
}

function aggregateCheckpoint(values: readonly { contentDigest: string; watermark: string }[]) {
  return Object.freeze({
    contentDigest: digestEarningsCallValue(values),
    watermark: values.map(({ watermark }) => watermark).sort().at(-1)!,
  });
}

function alertPresentation(facts: readonly Awaited<ReturnType<typeof processIssuer>>[]) {
  const material = facts.flatMap(({ material }) => material ? [material] : []);
  if (material.length === 0) return undefined;
  const dominant = material[0]!;
  const inference = dominant.record.finding.inferences[0]?.statement ??
    dominant.record.finding.facts[0]!.statement;
  const forecast = dominant.record.finding.forecast;
  const recommendation = dominant.record.finding.recommendation;
  const correction = dominant.record.sourceCorrection;
  return Object.freeze({
    title: `${dominant.record.ticker} ${dominant.current.event.fiscalPeriod} earnings-call ${correction ? "correction" : "change"}`,
    whyMatched: `${correction ? "A previously alerted conclusion changed after an official source correction. " : ""}${inference}${forecast ? ` Forecast: ${forecast.direction} over ${forecast.horizon.replaceAll("_", " ")}.` : ""}${recommendation ? ` Stance: ${recommendation.stance};` : ""} confidence: ${dominant.record.finding.confidence}.`,
  });
}

function alertPresentationFromEarningsFact(
  fact: EarningsCallChangeFact,
  summary: string,
) {
  return Object.freeze({
    title: `${fact.ticker} ${fact.currentFiscalPeriod} earnings-call change`,
    whyMatched: summary,
  });
}

async function processIssuer(input: {
  readonly artifacts: HybridEvidenceArtifactStore;
  readonly allowedSemanticModelIds: readonly string[];
  readonly clients?: EarningsCallWorkspaceWorkerClients;
  readonly envelope: ReturnType<typeof requireWorkspaceWorkerAuth>;
  readonly environment: NodeJS.ProcessEnv;
  readonly monitor: WorkspaceMonitor;
  readonly now: Date;
  readonly pack: Pick<
    StrategyPackCatalogEntry,
    "contentDigest" | "evidenceContracts" | "version"
  > & {
    readonly id: "earnings-call-changes";
  };
  readonly scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
  readonly source: WorkspaceMonitor["sources"][number];
  readonly sourceLifecycle: EarningsCallSourceLifecycleStore;
  readonly threshold: number;
}) {
  let transientArtifacts: readonly EarningsCallTransientArtifact[] = Object.freeze([]);
  const authorizedSource = await authorizeWorkspaceSourceFetch({
    runId: input.envelope.runId,
    scope: input.scope,
    sourceId: input.source.sourceId,
    url: input.source.canonicalUrl,
  }, input.clients?.sourceCoverage);
  await reserveWorkspaceSourceAttempt({
    now: input.now,
    runId: input.envelope.runId,
    scope: input.scope,
    sourceId: authorizedSource.sourceId,
  }, input.clients?.sourceCoverage);
  const coordinated = await coordinatePublicSourceOccurrence({
    clients: {
      acquisition: input.clients?.acquisition,
      subscription: input.clients?.subscription,
    },
    deferProjectionAcknowledgement: true,
    environment: input.environment,
    fetch: {
      adapterId: "earnings-call-transcripts",
      fetchResponse: input.clients?.fetchResponse ?? defaultFetchResponse,
      onTransientArtifacts: (artifacts) => {
        transientArtifacts = artifacts;
      },
      userAgent: input.environment.SEC_USER_AGENT ?? "Adaam Earnings Research https://adaam.example",
    },
    monitor: input.monitor,
    observedAt: input.now,
    scope: input.scope,
    sourceId: input.source.sourceId,
    window: input.envelope.window,
  });
  if (
    coordinated.acquisition.status === "retryable_failure" &&
    coordinated.acquisition.retryAfterSeconds !== null
  ) {
    await input.sourceLifecycle.recordRetry({
      acquisitionId: coordinated.acquisition.acquisitionId,
      monitorId: input.monitor.monitorId,
      now: input.now,
      occurrenceKey: input.envelope.occurrenceKey,
      retryAfterSeconds: coordinated.acquisition.retryAfterSeconds,
      runId: input.envelope.runId,
      scope: input.scope,
      sourceId: input.source.sourceId,
    });
    throw new EarningsCallWorkspaceWorkerRetryableError(
      coordinated.acquisition.acquisitionId,
      coordinated.acquisition.retryAfterSeconds,
    );
  }
  const cursor = coordinated.acquisition.proposedNextCursor;
  if (!coordinated.projection || !cursor) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
  await input.sourceLifecycle.recordAcknowledgement({
    acquisitionId: coordinated.acquisition.acquisitionId,
    expectedDeliveryRevision: coordinated.subscription.deliveryCursor.revision,
    monitorId: input.monitor.monitorId,
    occurrenceKey: input.envelope.occurrenceKey,
    scope: input.scope,
    sourceId: input.source.sourceId,
    subscriptionId: coordinated.subscription.subscriptionId,
  });
  await markWorkspaceSourceSuccess({
    contentDigest: cursor.contentDigest,
    now: input.now,
    runId: input.envelope.runId,
    scope: input.scope,
    sourceId: authorizedSource.sourceId,
  }, input.clients?.sourceCoverage);
  const checkpoint = {
    contentDigest: cursor.contentDigest,
    watermark: `${cursor.watermark.slice(0, 10)}T00:00:00.000Z`,
  };
  if (coordinated.baselineEstablished) {
    await persistEarningsCallIssuerStatus({
      cik: authorizedSource.sourceId.slice(-10),
      coverage: { lastSuccessfulEventAt: checkpoint.watermark, reasonCode: null, state: "baseline_ready" },
      scope: input.scope,
      updatedAt: input.now.toISOString(),
    }, input.clients?.earningsStatus);
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  if (coordinated.acquisition.status === "no_change") {
    const cik = authorizedSource.sourceId.slice(-10);
    const existing = await readEarningsCallIssuerStatus(input.scope, cik, input.clients?.earningsStatus);
    await persistEarningsCallIssuerStatus({
      cik,
      coverage: {
        lastSuccessfulEventAt: checkpoint.watermark,
        reasonCode: null,
        state: existing?.coverage.state === "current" ? "current" : "baseline_ready",
      },
      scope: input.scope,
      updatedAt: input.now.toISOString(),
    }, input.clients?.earningsStatus);
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  if (transientArtifacts.length === 0) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
  const artifactDigests: string[] = [];
  let acceptedReferenceIdsByArtifact: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  const lifecycleReferenceId = `earnings-source.${digestEarningsCallValue([
    input.envelope.occurrenceKey,
    input.source.sourceId,
  ])}`;
  try {
  const normalized: Array<{
    evidence: EarningsCallSemanticEvidenceInput;
    record: EarningsCallEvidenceRecord;
    sourceUrl: string;
  }> = [];
  let terminalCoverage: Readonly<{
    reasonCode: "artifact_oversized" | "missing_qa" | "release_only" | "transcript_ambiguous";
    state: "coverage_unavailable" | "degraded";
  }> | null = null;
  for (const artifact of transientArtifacts) {
    const event = eventForArtifact(artifact);
    const deterministic = await normalizeEarningsCallTranscript({
      artifactBytes: artifact.artifactBytes,
      artifactDigest: artifact.artifactDigest,
      artifactMediaType: artifact.artifactMediaType,
      eventRevisionId: event.revisionId,
      fiscalPeriod: event.fiscalPeriod,
    });
    let transcript = deterministic;
    if (deterministic.state === "recovery_required") {
      const flags = resolveHybridEvidenceFlags(input.environment);
      const execute = input.clients?.semantic?.execute ??
        (async (prepared: Parameters<NonNullable<SemanticClients["execute"]>>[0]) =>
          drainHybridWorker(prepared.request));
      const recovered = flags.extractionRecovery
        ? await runEarningsCallTranscriptLayoutRecovery({
            acquisitionId: coordinated.acquisition.acquisitionId,
            artifactDigest: deterministic.artifactDigest,
            artifactMediaType: artifact.artifactMediaType,
            artifactUrl: artifact.artifactUrl,
            clients: {
              artifacts: input.artifacts,
              globalBudget: input.clients?.hybridGlobalBudget,
              jobs: input.clients?.semantic?.jobs,
              lineage: input.clients?.semantic?.lineage,
              workspaceBudget: input.clients?.semantic?.budget,
            },
            dispatch: ({ prepared }) => execute(prepared),
            environment: input.environment,
            eventRevisionId: event.revisionId,
            initiatingWorkspaceId: input.scope.workspaceId,
            observedAt: event.observedAt,
            sourceInstanceId: event.sourceInstanceId,
            sourceLogicalKey: artifact.fact.logicalKey,
            sourceText: deterministic.sourceText,
          })
        : null;
      transcript = recovered?.state === "accepted"
        ? {
            artifactDigest: deterministic.artifactDigest,
            normalizedText: recovered.normalizedText,
            state: "accepted" as const,
            transcript: recovered.transcript,
          }
        : deterministic;
    }
    if (transcript.state !== "accepted") {
      terminalCoverage = transcript.state === "coverage_unavailable"
        ? { reasonCode: transcript.reason, state: "coverage_unavailable" }
        : {
            reasonCode: transcript.state === "quarantined" && transcript.reason === "artifact_oversized"
              ? "artifact_oversized"
              : "transcript_ambiguous",
            state: "degraded",
          };
      continue;
    }
    const projection = await readAuthorizedPublicSourceProjection({
      factRevisionId: artifact.factRevisionId,
      scope: input.scope,
      subscriptionId: coordinated.subscription.subscriptionId,
    }, {
      acquisition: input.clients?.acquisition,
      subscription: input.clients?.subscription,
    });
    if (!projection) continue;
    const manifest = await input.artifacts.persist({
      acquisitionId: coordinated.acquisition.acquisitionId,
      authority: artifact.fact.provenance.authority,
      bytes: Buffer.from(transcript.normalizedText, "utf8"),
      canonicalPublicUrl: artifact.artifactUrl,
      mediaType: "text/plain",
      now: input.now,
      observedAt: event.observedAt,
      parserEligibility: null,
      sourceInstanceId: event.sourceInstanceId,
      structure: {
        characterCount: transcript.normalizedText.length,
        columnCount: null,
        pageCount: null,
        rowCount: null,
        sheetCount: null,
      },
    });
    artifactDigests.push(manifest.contentDigest);
    await input.artifacts.setReference({
      active: true,
      artifactDigest: manifest.contentDigest,
      kind: "current_lineage",
      referenceId: lifecycleReferenceId,
    });
    normalized.push({
      evidence: {
        artifact: manifest,
        normalizedText: transcript.normalizedText,
        projectionReference: {
          factRevisionId: artifact.factRevisionId,
          sourceId: input.source.sourceId,
          subscriptionId: coordinated.subscription.subscriptionId,
        },
        role: "current",
        sourceFactLocator: {
          factRevisionId: artifact.factRevisionId,
          kind: "source_fact",
          payloadDigest: artifact.fact.payloadDigest,
        },
        transcript: transcript.transcript,
      },
      record: { event, normalizedText: transcript.normalizedText, transcript: transcript.transcript },
      sourceUrl: artifact.artifactUrl,
    });
  }
  if (normalized.length < 2) {
    await persistEarningsCallIssuerStatus({
      cik: authorizedSource.sourceId.slice(-10),
      coverage: terminalCoverage
        ? { ...terminalCoverage, lastSuccessfulEventAt: checkpoint.watermark }
        : {
            lastSuccessfulEventAt: checkpoint.watermark,
            reasonCode: "awaiting_comparable_call",
            state: "awaiting_comparable_call",
          },
      scope: input.scope,
      updatedAt: input.now.toISOString(),
    }, input.clients?.earningsStatus);
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  const timeline = buildEarningsCallEvidenceTimeline({
    activationWatermark: input.monitor.activationWatermark!,
    baselineBackfill: false,
    records: normalized.map(({ record }) => record),
  });
  const comparison = [...timeline.comparisons].reverse().find((candidate) =>
    timeline.alertEligibleRevisionIds.includes(candidate.current.eventRevisionId));
  if (!comparison) {
    await persistEarningsCallIssuerStatus({
      cik: authorizedSource.sourceId.slice(-10),
      coverage: { lastSuccessfulEventAt: checkpoint.watermark, reasonCode: null, state: "baseline_ready" },
      scope: input.scope,
      updatedAt: input.now.toISOString(),
    }, input.clients?.earningsStatus);
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  const current = normalized.find(({ record }) =>
    record.event.revisionId === comparison.current.eventRevisionId)!;
  const prior = normalized.find(({ record }) =>
    record.event.revisionId === comparison.prior.eventRevisionId)!;
  const yearAgo = comparison.secondaryYearAgo
    ? normalized.find(({ record }) => record.event.revisionId === comparison.secondaryYearAgo!.eventRevisionId)
    : undefined;
  const semanticRoute = resolveEarningsCallSemanticRoute({
    allowedModelIds: input.allowedSemanticModelIds,
    environment: input.environment,
    pack: input.pack,
  });
  const packBinding = Object.freeze({
    contentDigest: input.pack.contentDigest,
    id: input.pack.id,
    version: input.pack.version,
  });
  const semantic = await runEarningsCallSemanticComparison({
    comparison,
    environment: input.environment,
    evidence: [
      { ...current.evidence, role: "current" },
      { ...prior.evidence, role: "prior" },
      ...(yearAgo ? [{ ...yearAgo.evidence, role: "year_ago" as const }] : []),
    ],
    modelId: semanticRoute.modelId,
    now: input.now,
    pack: packBinding,
    reasoning: semanticRoute.reasoning,
    scope: input.scope,
    workspaceGeneration: input.envelope.strategyPack!.workspaceGeneration,
  }, {
    acquisition: input.clients?.acquisition,
    artifacts: input.artifacts,
    execute: input.clients?.semantic?.execute ?? (async (prepared) => drainHybridWorker(prepared.request)),
    jobs: input.clients?.semantic?.jobs,
    lineage: input.clients?.semantic?.lineage,
    monitor: input.clients?.monitor,
    notifyHealth: input.clients?.semantic?.notifyHealth,
    resolveProjection: input.clients?.semantic?.resolveProjection,
    semantic: input.clients?.semantic?.semantic,
    state: input.clients?.state,
    subscription: input.clients?.subscription,
    budget: input.clients?.semantic?.budget,
    catalog: input.clients?.semantic?.catalog,
    validationRegistry: input.clients?.semantic?.validationRegistry,
  });
  acceptedReferenceIdsByArtifact = resolveEarningsCallAcceptedArtifactReferences([
    ...semantic.sections,
    ...(semantic.final ? [semantic.final] : []),
  ]);
  if (!semantic.final?.evidence || semantic.state === "quarantined") {
    await persistEarningsCallIssuerStatus({
      cik: authorizedSource.sourceId.slice(-10),
      coverage: {
        lastSuccessfulEventAt: current.record.event.observedAt,
        reasonCode: "transcript_ambiguous",
        state: "degraded",
      },
      scope: input.scope,
      updatedAt: input.now.toISOString(),
    }, input.clients?.earningsStatus);
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  let finding = createEarningsCallFinding({
    activationWatermark: input.monitor.activationWatermark!,
    comparison,
    configurationRevision: input.envelope.configurationRevision,
    currentPublishedAt: current.record.event.publishedAt,
    monitorId: input.monitor.monitorId,
    ownerId: input.scope.ownerId,
    pack: {
      contentDigest: input.pack.contentDigest,
      id: input.pack.id,
      version: input.pack.version,
    },
    semantic: semantic.final,
    threshold: input.threshold,
    workspaceId: input.scope.workspaceId,
  });
  const issuer = EARNINGS_CALL_ISSUER_CATALOG.entries.find(({ cik }) => cik === comparison.cik);
  if (!issuer) throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  let sourceCorrection: ReturnType<typeof assessEarningsCallSourceCorrection>["lineage"] | undefined;
  for (const correctionId of coordinated.acquisition.correctionIds) {
    const correction = await readPublicSourceCorrection(correctionId, input.clients?.acquisition);
    if (!correction || correction.toRevisionId !== current.record.event.revisionId) continue;
    const prior = await readEarningsCallFindingByEventRevision(
      input.scope,
      correction.fromRevisionId,
      input.clients?.earningsFindings,
    );
    const claim = prior
      ? await readWorkspaceFindingIdentityClaim({
          factIdentity: prior.finding.findingId,
          monitorId: input.monitor.monitorId,
          scope: input.scope,
        }, input.clients?.finding)
      : null;
    const priorAlert = claim
      ? await readWorkspaceAlert(input.scope, claim.findingId, input.clients?.alert)
      : null;
    const assessment = assessEarningsCallSourceCorrection({
      correction,
      current: finding,
      prior: prior?.finding ?? null,
      priorAlerted: priorAlert !== null,
    });
    finding = assessment.finding;
    sourceCorrection = assessment.lineage;
    break;
  }
  const record = {
    cik: issuer.cik,
    companyName: issuer.companyName,
    createdAt: semantic.final.record.job.createdAt,
    finding,
    recordType: "earnings_call_finding_record" as const,
    schemaVersion: 1 as const,
    ...(sourceCorrection ? { sourceCorrection } : {}),
    sources: [
      { canonicalUrl: current.sourceUrl, eventRevisionId: current.record.event.revisionId, fiscalPeriod: current.record.event.fiscalPeriod, role: "current" as const },
      { canonicalUrl: prior.sourceUrl, eventRevisionId: prior.record.event.revisionId, fiscalPeriod: prior.record.event.fiscalPeriod, role: "prior" as const },
      ...(yearAgo ? [{ canonicalUrl: yearAgo.sourceUrl, eventRevisionId: yearAgo.record.event.revisionId, fiscalPeriod: yearAgo.record.event.fiscalPeriod, role: "year_ago" as const }] : []),
    ],
    ticker: issuer.ticker,
  };
  await persistEarningsCallFinding({ record, scope: input.scope }, input.clients?.earningsFindings);
  await persistEarningsCallIssuerStatus({
    cik: issuer.cik,
    coverage: {
      lastSuccessfulEventAt: current.record.event.observedAt,
      reasonCode: null,
      state: "current",
    },
    scope: input.scope,
    updatedAt: input.now.toISOString(),
  }, input.clients?.earningsStatus);
  return Object.freeze({
    checkpoint,
    material: (sourceCorrection
      ? sourceCorrection.correctiveAlertEligible
      : finding.materiality.alertEligible)
      ? {
          current: current.record,
          record,
          // Everything the bounded research child needs to read this already
          // material finding as one signed member, without re-acquiring the
          // transcript or widening the monitor's authorized sources.
          research: Object.freeze({
            acquisitionId: coordinated.acquisition.acquisitionId,
            factPayloadDigest: current.evidence.sourceFactLocator.payloadDigest,
            factRevisionId: current.evidence.sourceFactLocator.factRevisionId,
            observedAt: current.record.event.observedAt,
            priorFiscalPeriod: prior.record.event.fiscalPeriod,
            projectionReference: current.evidence.projectionReference,
            sourceInstanceId: current.record.event.sourceInstanceId,
            sourceUrl: current.sourceUrl,
          }),
        }
      : null,
    persisted: record,
  });
  } finally {
    for (const artifactDigest of artifactDigests) {
      for (const referenceId of acceptedReferenceIdsByArtifact.get(artifactDigest) ?? []) {
        await input.artifacts.setReference({
          active: false,
          artifactDigest,
          kind: "accepted_result",
          referenceId,
        });
      }
      await input.artifacts.setReference({
        active: false,
        artifactDigest,
        kind: "current_lineage",
        referenceId: lifecycleReferenceId,
      });
      await input.artifacts.deleteUnreferenced(artifactDigest);
    }
  }
}

async function finalizeEarningsCallSourceLifecycle(input: {
  readonly lifecycle: EarningsCallSourceLifecycleStore;
  readonly occurrenceKey: string;
  readonly scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
  readonly subscription?: PublicSourceSubscriptionStoreClient;
}): Promise<void> {
  const acknowledgements = await input.lifecycle.listAcknowledgements({
    occurrenceKey: input.occurrenceKey,
    scope: input.scope,
  });
  for (const acknowledgement of acknowledgements) {
    await acknowledgePublicSourceProjection({
      acquisitionId: acknowledgement.acquisitionId,
      expectedDeliveryRevision: acknowledgement.expectedDeliveryRevision,
      scope: input.scope,
      subscriptionId: acknowledgement.subscriptionId,
    }, input.subscription);
    await input.lifecycle.completeAcknowledgement({
      acquisitionId: acknowledgement.acquisitionId,
      occurrenceKey: input.occurrenceKey,
      scope: input.scope,
      subscriptionId: acknowledgement.subscriptionId,
    });
  }
  await input.lifecycle.clearRetry({ occurrenceKey: input.occurrenceKey, scope: input.scope });
}

export async function evaluateEarningsCallChangesForWorker(input: {
  readonly clients?: EarningsCallWorkspaceWorkerClients;
  readonly ctx: WorkerContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}): Promise<EarningsCallWorkspaceWorkerResult> {
  const now = input.now ?? new Date();
  const environment = input.environment ?? process.env;
  const envelope = requireWorkspaceWorkerAuth(input.ctx, {}, environment);
  const scope = authorizeWorkspaceWorkerStore(input.ctx, environment);
  const sourceLifecycle = input.clients?.sourceLifecycle ?? createEarningsCallSourceLifecycleStore();
  const existing = await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, input.clients?.finding);
  if (existing) {
    const facts = existing.finding?.facts?.filter(
      (fact): fact is EarningsCallChangeFact =>
        fact.kind === "earnings_call_change",
    ) ?? [];
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      alertPresentation: facts.length
        ? alertPresentationFromEarningsFact(facts[0]!, existing.finding!.summary)
        : undefined,
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
    });
    await finalizeEarningsCallSourceLifecycle({
      lifecycle: sourceLifecycle,
      occurrenceKey: envelope.occurrenceKey,
      scope,
      subscription: input.clients?.subscription,
    });
    return {
      evaluatedIssuers: envelope.sources.length,
      materialFindings: facts.length,
      outcome,
      replayed: true,
    };
  }
  if (!resolveEarningsCallFlags(environment).execution) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_execution_disabled");
  }
  const [capabilities, monitor, strategy] = await Promise.all([
    resolveWorkspaceWorkerCapabilitySnapshot({
      envelope,
      registry: [{ definition: true, metadata: { category: "control_plane", id: EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID } }],
      scope,
      stateClient: input.clients?.state,
    }),
    getWorkspaceMonitor(scope, envelope.monitorId, input.clients?.monitor),
    readWorkspaceDocument("strategy", scope, input.clients?.state),
  ]);
  if (!(EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID in capabilities.tools)) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_capability_denied");
  }
  assertMonitor(monitor, envelope);
  if (
    strategy?.schemaVersion !== 2 || strategy.value.pack?.id !== "earnings-call-changes" ||
    strategy.value.pack.version !== monitor.managedBy!.packVersion ||
    strategy.value.pack.contentDigest !== monitor.managedBy!.packContentDigest
  ) throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  const pack = strategyPackCatalog.resolve({
    contentDigest: monitor.managedBy!.packContentDigest,
    id: "earnings-call-changes",
    version: monitor.managedBy!.packVersion,
  });
  const selected = strategy.value.configuration.selectedIssuerCiks;
  if (!pack || !Array.isArray(selected) || selected.length < 1 || selected.length > 8) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const expectedSources = resolveParameterizedStrategyPackSources(
    pack,
    strategy.value.configuration,
    pack.monitors.find(({ resourceId }) => resourceId === monitor.managedBy!.resourceId)?.sourceIds,
  ).map(({ sourceId }) => sourceId).sort();
  if (JSON.stringify(expectedSources) !== JSON.stringify(monitor.sources.map(({ sourceId }) => sourceId).sort())) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const threshold = thresholdValue(strategy.value.configuration.materialityThreshold);
  const artifacts = input.clients?.artifacts ?? input.clients?.semantic?.artifacts ??
    createHybridEvidenceEphemeralArtifactStore();
  // A prior delayed attempt authorizes only the next fresh acquisition. Clear
  // that authority before work starts so a terminal/uncertain result cannot be
  // mistaken for another retryable failure by the control plane.
  await sourceLifecycle.clearRetry({ occurrenceKey: envelope.occurrenceKey, scope });
  const issuerResults = [];
  for (const source of monitor.sources) {
    try {
      issuerResults.push(await processIssuer({
        artifacts,
        allowedSemanticModelIds: capabilities.resolved.workerModelIds,
        clients: input.clients,
        envelope,
        environment,
        monitor,
        now,
        pack: {
          contentDigest: pack.contentDigest,
          evidenceContracts: pack.evidenceContracts,
          id: "earnings-call-changes",
          version: pack.version,
        },
        scope,
        source,
        sourceLifecycle,
        threshold,
      }));
    } catch (error) {
      const cik = source.sourceId.slice(-10);
      const existing = await readEarningsCallIssuerStatus(scope, cik, input.clients?.earningsStatus);
      await persistEarningsCallIssuerStatus({
        cik,
        coverage: {
          lastSuccessfulEventAt: existing?.coverage.lastSuccessfulEventAt ?? null,
          reasonCode: "source_failed",
          state: "degraded",
        },
        scope,
        updatedAt: now.toISOString(),
      }, input.clients?.earningsStatus);
      throw error;
    }
  }
  const material = issuerResults.flatMap((result) => result.material ? [result.material] : []);
  let presentation: Readonly<{ title: string; whyMatched: string }> | undefined =
    alertPresentation(issuerResults);
  let researchArtifactRefs: readonly string[] = Object.freeze([]);
  const researchRuntime = material.length === 0
    ? null
    : resolveEarningsCallResearchRuntime({
        allowedModelIds: capabilities.resolved.workerModelIds,
        environment,
        pack,
        workspaceGeneration: envelope.strategyPack!.workspaceGeneration,
      });
  if (researchRuntime) {
    const research = await runEarningsCallExecutiveResearch({
      clients: input.clients,
      environment,
      material,
      now,
      parentRunId: envelope.runId,
      runtime: researchRuntime,
      scope,
    });
    presentation = research.presentation;
    researchArtifactRefs = research.artifactRefs;
  }
  const provenance = material.map(({ record }) => {
    const source = monitor.sources.find(({ sourceId }) => sourceId === `earnings-call-transcripts.${record.cik}`)!;
    return {
      accessClassification: "public" as const,
      canonicalUrl: source.canonicalUrl,
      origin: source.origin,
      sourceId: source.sourceId,
    };
  });
  const facts = material.map(({ current, record }) => ({
    cik: record.cik,
    companyName: record.companyName,
    currentFiscalPeriod: current.event.fiscalPeriod,
    filingIdentity: record.finding.findingId,
    finding: record.finding,
    kind: "earnings_call_change" as const,
    observedAt: record.createdAt,
    schemaVersion: 1 as const,
    source: provenance.find(({ sourceId }) => sourceId === `earnings-call-transcripts.${record.cik}`)!,
    ticker: record.ticker,
  }));
  const finding: WorkspaceFindingCandidate | null = facts.length === 0 ? null : {
    accessClassification: "public",
    artifactRefs: [
      ...researchArtifactRefs,
      ...material.flatMap(({ current, record }) => [
        record.finding.findingId,
        record.finding.comparisonId,
        current.event.revisionId,
      ]),
    ].slice(0, 8),
    asOf: material.map(({ current }) => current.event.publishedAt).sort().at(-1)!,
    factIdentities: facts.map(({ filingIdentity }) => filingIdentity),
    facts,
    provenance: provenance.filter((source, index, values) => values.findIndex((candidate) =>
      candidate.sourceId === source.sourceId && candidate.canonicalUrl === source.canonicalUrl) === index).slice(0, 8),
    summary: presentation!.whyMatched,
  };
  const checkpoint = aggregateCheckpoint(issuerResults.map(({ checkpoint }) => checkpoint));
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    alertPresentation: presentation,
    checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment,
    finding,
    initialBaseline: issuerResults.every(({ persisted }) => persisted === null) &&
      monitor.sourceCheckpoint.watermark === null,
    now,
    toolId: EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
  });
  await finalizeEarningsCallSourceLifecycle({
    lifecycle: sourceLifecycle,
    occurrenceKey: envelope.occurrenceKey,
    scope,
    subscription: input.clients?.subscription,
  });
  return Object.freeze({
    evaluatedIssuers: issuerResults.length,
    materialFindings: material.length,
    outcome,
    replayed: false,
  });
}

export const earningsCallWorkspaceWorkerOutputSchema = z.object({
  evaluatedIssuers: z.number().int().min(1).max(8),
  materialFindings: z.number().int().min(0).max(8),
  outcome: z.enum(["finding_staged", "no_match"]),
  replayed: z.boolean(),
  runId: z.string().min(1).max(160),
}).strict();

export const evaluateEarningsCallChangesTool = defineTool({
  description: "Evaluate selected reviewed earnings-call sources exactly once, preserve baseline silence, run bounded cited comparison, persist the exact finding, and stage only deterministically material alerts.",
  inputSchema: z.object({}).strict(),
  outputSchema: earningsCallWorkspaceWorkerOutputSchema,
  async execute(_input, ctx) {
    const result = await evaluateEarningsCallChangesForWorker({ ctx });
    return {
      evaluatedIssuers: result.evaluatedIssuers,
      materialFindings: result.materialFindings,
      outcome: result.outcome.outcome,
      replayed: result.replayed,
      runId: result.outcome.runId,
    };
  },
});

export async function recoverEarningsCallWorkspaceRunForControlPlane(input: {
  readonly clients?: WorkspaceWorkerControlPlaneClients;
  readonly now?: Date;
  readonly prepared: PreparedWorkspaceWorkerRecovery;
}) {
  if (input.prepared.monitor.managedBy?.packId !== "earnings-call-changes") {
    return Object.freeze({ status: "not_applicable" as const });
  }
  const outcome = await readWorkspaceRunOutcome(
    input.prepared.scope,
    input.prepared.claimed.occurrence.occurrenceKey,
    input.clients?.finding,
  );
  if (!outcome) return Object.freeze({ status: "missing" as const });
  const fact = outcome.finding?.facts?.find(
    (candidate): candidate is EarningsCallChangeFact =>
      candidate.kind === "earnings_call_change",
  );
  return finalizePriorWorkspaceRunOutcomeForControlPlane({
    alertPresentation: fact
      ? alertPresentationFromEarningsFact(fact, outcome.finding!.summary)
      : undefined,
    clients: input.clients,
    now: input.now,
    outcome,
    prepared: input.prepared,
    toolId: EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
  });
}
