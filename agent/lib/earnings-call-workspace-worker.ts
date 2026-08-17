import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  buildEarningsCallEvidenceTimeline,
  type EarningsCallEvidenceRecord,
} from "./earnings-call-comparison";
import {
  persistEarningsCallFinding,
  type EarningsCallFindingStoreClient,
} from "./earnings-call-finding-store";
import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import { createEarningsCallFinding } from "./earnings-call-materiality";
import { createEarningsCallComparisonDefinitions } from "./hybrid-evidence-definition-registry";
import { resolveEarningsCallFlags } from "./earnings-call-policy";
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
  createHybridEvidenceArtifactStore,
  type HybridEvidenceArtifactStore,
} from "./hybrid-evidence-artifact-store";
import { startHybridEvidenceWorkerTask } from "./hybrid-evidence-worker";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import { coordinatePublicSourceOccurrence } from "./public-source-coordinator";
import type {
  EarningsCallPublicSourceRequest,
  EarningsCallPublicSourceResponse,
  EarningsCallTransientArtifact,
} from "./earnings-call-public-source-adapter";
import {
  readAuthorizedPublicSourceProjection,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID,
} from "./strategy-pack-reference-catalog";
import { strategyPackCatalog } from "./strategy-pack-catalog";
import {
  readWorkspaceRunOutcome,
  type WorkspaceFindingCandidate,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import type { EarningsCallChangeFact } from "./workspace-finding-facts";
import { getWorkspaceMonitor, type WorkspaceMonitor } from "./workspace-monitor-store";
import {
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "./workspace-source-coverage";
import { readWorkspaceDocument } from "./workspace-state-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  finalizePriorWorkspaceRunOutcomeForControlPlane,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";

export { EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];
type SemanticClients = Parameters<typeof runEarningsCallSemanticComparison>[1];

export interface EarningsCallWorkspaceWorkerClients extends WorkspaceWorkerControlPlaneClients {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly artifacts?: HybridEvidenceArtifactStore;
  readonly earningsFindings?: EarningsCallFindingStoreClient;
  readonly fetchResponse?: (request: EarningsCallPublicSourceRequest) => Promise<EarningsCallPublicSourceResponse>;
  readonly semantic?: Omit<SemanticClients, "artifacts"> & { readonly artifacts?: HybridEvidenceArtifactStore };
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

function assertMonitor(
  monitor: WorkspaceMonitor | null,
  envelope: ReturnType<typeof requireWorkspaceWorkerAuth>,
): asserts monitor is WorkspaceMonitor {
  const pack = envelope.strategyPack;
  if (
    !monitor || monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    monitor.managedBy?.packId !== "earnings-call-changes" ||
    monitor.managedBy.packVersion !== "1.0.0" ||
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

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<{ readonly body: Uint8Array; readonly truncated: boolean }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { body: new Uint8Array(), truncated: true };
  }
  if (!response.body) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maximumBytes) {
      await reader.cancel();
      return { body: new Uint8Array(), truncated: true };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, truncated: false };
}

async function defaultFetchResponse(
  request: EarningsCallPublicSourceRequest,
): Promise<EarningsCallPublicSourceResponse> {
  let url = request.url;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(url, {
      headers: request.headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 3) throw new Error("transport_redirect_forbidden");
      url = new URL(location, url).toString();
      continue;
    }
    const { body, truncated } = await readBoundedResponseBody(response, request.maximumBytes);
    return Object.freeze({
      body,
      contentType: response.headers.get("content-type") ?? "",
      finalUrl: url,
      observedAt: new Date().toISOString(),
      redirectCount,
      requestedUrl: request.url,
      status: response.status,
      truncated: truncated || undefined,
    });
  }
  throw new Error("transport_redirect_forbidden");
}

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
  const forecast = dominant.record.finding.forecast!;
  const recommendation = dominant.record.finding.recommendation!;
  return Object.freeze({
    title: `${dominant.record.ticker} ${dominant.current.event.fiscalPeriod} earnings-call change`,
    whyMatched: `${inference} Forecast: ${forecast.direction} over ${forecast.horizon.replaceAll("_", " ")}. Stance: ${recommendation.stance}; confidence: ${dominant.record.finding.confidence}.`,
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
  readonly clients?: EarningsCallWorkspaceWorkerClients;
  readonly envelope: ReturnType<typeof requireWorkspaceWorkerAuth>;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelId: string;
  readonly monitor: WorkspaceMonitor;
  readonly now: Date;
  readonly pack: { readonly contentDigest: string; readonly id: "earnings-call-changes"; readonly version: string };
  readonly scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
  readonly source: WorkspaceMonitor["sources"][number];
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
    deferProjectionAcknowledgement: false,
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
  const cursor = coordinated.acquisition.proposedNextCursor;
  if (!coordinated.projection || !cursor) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
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
  if (coordinated.baselineEstablished || coordinated.acquisition.status === "no_change") {
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  if (transientArtifacts.length === 0) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
  const normalized: Array<{
    evidence: EarningsCallSemanticEvidenceInput;
    record: EarningsCallEvidenceRecord;
    sourceUrl: string;
  }> = [];
  for (const artifact of transientArtifacts) {
    const event = eventForArtifact(artifact);
    const transcript = await normalizeEarningsCallTranscript({
      artifactBytes: artifact.artifactBytes,
      artifactDigest: artifact.artifactDigest,
      artifactMediaType: artifact.artifactMediaType,
      eventRevisionId: event.revisionId,
      fiscalPeriod: event.fiscalPeriod,
    });
    if (transcript.state !== "accepted") continue;
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
    throw new EarningsCallWorkspaceWorkerError("earnings_call_source_unavailable");
  }
  const timeline = buildEarningsCallEvidenceTimeline({
    activationWatermark: input.monitor.activationWatermark!,
    baselineBackfill: false,
    records: normalized.map(({ record }) => record),
  });
  const comparison = [...timeline.comparisons].reverse().find((candidate) =>
    timeline.alertEligibleRevisionIds.includes(candidate.current.eventRevisionId));
  if (!comparison) return Object.freeze({ checkpoint, material: null, persisted: null });
  const current = normalized.find(({ record }) =>
    record.event.revisionId === comparison.current.eventRevisionId)!;
  const prior = normalized.find(({ record }) =>
    record.event.revisionId === comparison.prior.eventRevisionId)!;
  const yearAgo = comparison.secondaryYearAgo
    ? normalized.find(({ record }) => record.event.revisionId === comparison.secondaryYearAgo!.eventRevisionId)
    : undefined;
  const semantic = await runEarningsCallSemanticComparison({
    comparison,
    environment: input.environment,
    evidence: [
      { ...current.evidence, role: "current" },
      { ...prior.evidence, role: "prior" },
      ...(yearAgo ? [{ ...yearAgo.evidence, role: "year_ago" as const }] : []),
    ],
    modelId: input.modelId,
    now: input.now,
    pack: input.pack,
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
  if (!semantic.final?.evidence || semantic.state === "quarantined") {
    return Object.freeze({ checkpoint, material: null, persisted: null });
  }
  const finding = createEarningsCallFinding({
    activationWatermark: input.monitor.activationWatermark!,
    comparison,
    configurationRevision: input.envelope.configurationRevision,
    currentPublishedAt: current.record.event.publishedAt,
    monitorId: input.monitor.monitorId,
    ownerId: input.scope.ownerId,
    pack: input.pack,
    semantic: semantic.final,
    threshold: input.threshold,
    workspaceId: input.scope.workspaceId,
  });
  const issuer = EARNINGS_CALL_ISSUER_CATALOG.entries.find(({ cik }) => cik === comparison.cik);
  if (!issuer) throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  const record = {
    cik: issuer.cik,
    companyName: issuer.companyName,
    createdAt: semantic.final.record.job.createdAt,
    finding,
    recordType: "earnings_call_finding_record" as const,
    schemaVersion: 1 as const,
    sources: [
      { canonicalUrl: current.sourceUrl, eventRevisionId: current.record.event.revisionId, fiscalPeriod: current.record.event.fiscalPeriod, role: "current" as const },
      { canonicalUrl: prior.sourceUrl, eventRevisionId: prior.record.event.revisionId, fiscalPeriod: prior.record.event.fiscalPeriod, role: "prior" as const },
      ...(yearAgo ? [{ canonicalUrl: yearAgo.sourceUrl, eventRevisionId: yearAgo.record.event.revisionId, fiscalPeriod: yearAgo.record.event.fiscalPeriod, role: "year_ago" as const }] : []),
    ],
    ticker: issuer.ticker,
  };
  await persistEarningsCallFinding({ record, scope: input.scope }, input.clients?.earningsFindings);
  return Object.freeze({
    checkpoint,
    material: finding.materiality.alertEligible ? { current: current.record, record } : null,
    persisted: record,
  });
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
    return { evaluatedIssuers: facts.length, materialFindings: facts.length, outcome, replayed: true };
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
    strategy.value.pack.version !== "1.0.0" ||
    strategy.value.pack.contentDigest !== monitor.managedBy!.packContentDigest
  ) throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  const pack = strategyPackCatalog.resolve({
    contentDigest: monitor.managedBy!.packContentDigest,
    id: "earnings-call-changes",
    version: "1.0.0",
  });
  const selected = strategy.value.configuration.selectedIssuerCiks;
  if (!pack || !Array.isArray(selected) || selected.length < 1 || selected.length > 8) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const expectedSources = selected.map((cik) => `earnings-call-transcripts.${cik}`).sort();
  if (JSON.stringify(expectedSources) !== JSON.stringify(monitor.sources.map(({ sourceId }) => sourceId).sort())) {
    throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  }
  const threshold = thresholdValue(strategy.value.configuration.materialityThreshold);
  const modelId = capabilities.resolved.workerModelIds.find((candidate) => {
    const definitions = createEarningsCallComparisonDefinitions([candidate]);
    return definitions.every((definition) => pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest));
  });
  if (!modelId) throw new EarningsCallWorkspaceWorkerError("earnings_call_strategy_invalid");
  const artifacts = input.clients?.artifacts ?? input.clients?.semantic?.artifacts ?? createHybridEvidenceArtifactStore();
  const issuerResults = [];
  for (const source of monitor.sources) {
    issuerResults.push(await processIssuer({
      artifacts,
      clients: input.clients,
      envelope,
      environment,
      modelId,
      monitor,
      now,
      pack: { contentDigest: pack.contentDigest, id: "earnings-call-changes", version: pack.version },
      scope,
      source,
      threshold,
    }));
  }
  const material = issuerResults.flatMap((result) => result.material ? [result.material] : []);
  const presentation = alertPresentation(issuerResults);
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
    artifactRefs: material.flatMap(({ current, record }) => [
      record.finding.findingId,
      record.finding.comparisonId,
      current.event.revisionId,
    ]).slice(0, 8),
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
