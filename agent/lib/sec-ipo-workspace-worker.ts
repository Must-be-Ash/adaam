import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";
import { z } from "zod";

import { publishReportArtifact } from "./artifact-store";
import { artifactReferenceForId } from "./artifact-reference";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactStore,
} from "./hybrid-evidence-artifact-store";
import { resolveHybridTaskModelRoute } from "./hybrid-evidence-model-routing";
import {
  runWorkspaceSemanticEvidenceBundleJob,
  type WorkspaceSemanticModelUsage,
} from "./hybrid-evidence-semantic";
import { startHybridEvidenceWorkerTask, type PreparedHybridEvidenceWorkerRun } from "./hybrid-evidence-worker";
import {
  evaluateSecIpoPage,
  deriveSecIpoSignalId,
  normalizeSecIpoFetch,
  type SecIpoCheckpoint,
  type SecIpoEvaluation,
} from "./sec-ipo-evaluation";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
  type SecIpoFiling,
} from "./sec-ipo-reference";
import {
  readWorkspaceRunOutcome,
  selectUnseenWorkspaceFindingIdentities,
  type WorkspaceFindingCandidate,
  type WorkspaceFindingStoreClient,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import {
  getWorkspaceMonitor,
  type WorkspaceMonitor,
} from "./workspace-monitor-store";
import {
  authorizeWorkspaceSourceFetch,
  markWorkspaceSourceSuccess,
  reserveWorkspaceSourceAttempt,
} from "./workspace-source-coverage";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  finalizePriorWorkspaceRunOutcomeForControlPlane,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import {
  SEC_IPO_NORMALIZER_VERSION,
  type SecIpoFilingFact,
} from "./workspace-finding-facts";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import { resolveSecPublicSourceRuntimePath } from "./public-source-flags";
import { coordinatePublicSourceOccurrence } from "./public-source-coordinator";
import { migrateSecPublicSourceWorkspace } from "./sec-public-source-migration";
import {
  type AuthorizedPublicSourceProjection,
  type PublicSourceSubscriptionStoreClient,
} from "./public-source-subscription-store";
import {
  fetchOfficialPublicSourceText,
  type OfficialPublicSourceResponse,
} from "../tools/fetch_public_source";
import {
  createSecIpoResearchDefinition,
  isSecIpoAgenticResearchPack,
  SEC_IPO_RESEARCH_DEFINITION_ID,
} from "./sec-ipo-semantics";
import { strategyPackCatalog, type StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import { readWorkspaceDocument } from "./workspace-state-store";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";
import {
  buildSecIpoSignalReport,
  secIpoAlertPresentationForBrief,
  secIpoAlertPresentationForFacts,
  secIpoReportArtifactId,
} from "./sec-ipo-signal-report";
import {
  shouldPublishWorkspaceExecutiveArtifact,
  workspaceExecutiveBriefSchema,
  type WorkspaceExecutiveBrief,
} from "./workspace-executive-brief";

export { EVALUATE_SEC_IPO_SOURCE_TOOL_ID } from "./sec-ipo-reference";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0] & {
  readonly abortSignal?: AbortSignal;
};

export interface SecIpoWorkspaceWorkerClients
  extends WorkspaceWorkerControlPlaneClients {
  readonly acquisition?: PublicSourceAcquisitionStoreClient;
  readonly artifacts?: HybridEvidenceArtifactStore;
  readonly fetchSource?: (
    requestedUrl: string,
  ) => Promise<OfficialPublicSourceResponse>;
  readonly publishReport?: typeof publishReportArtifact;
  readonly semantic?: {
    readonly acquisition?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["acquisition"];
    readonly budget?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["budget"];
    readonly catalog?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["catalog"];
    readonly execute?: (
      prepared: PreparedHybridEvidenceWorkerRun,
    ) => Promise<WorkspaceSemanticModelUsage | void>;
    readonly jobs?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["jobs"];
    readonly lineage?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["lineage"];
    readonly semantic?: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1]["semantic"];
  };
  readonly subscription?: PublicSourceSubscriptionStoreClient;
}

export interface SecIpoWorkspaceWorkerResult {
  readonly baselineEstablished: boolean;
  readonly checkpoint: SecIpoCheckpoint;
  readonly factCount: number;
  readonly outcome: WorkspaceRunOutcome;
  readonly replayed: boolean;
}

export class SecIpoWorkspaceWorkerError extends Error {
  readonly code:
    | "sec_ipo_capability_denied"
    | "sec_ipo_monitor_invalid"
    | "sec_ipo_monitor_not_found"
    | "sec_ipo_public_source_misconfigured";

  constructor(code: SecIpoWorkspaceWorkerError["code"]) {
    super(code);
    this.code = code;
    this.name = "SecIpoWorkspaceWorkerError";
  }
}

function assertIpoMonitor(
  monitor: WorkspaceMonitor | null,
  envelope: ReturnType<typeof requireWorkspaceWorkerAuth>,
): asserts monitor is WorkspaceMonitor {
  if (!monitor) throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_not_found");
  if (
    monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    monitor.sources.length !== 1 ||
    monitor.sources[0]?.accessClassification !== "public" ||
    monitor.sources[0].canonicalUrl !== SEC_IPO_SOURCE_URL ||
    monitor.sources[0].origin !== "https://www.sec.gov" ||
    monitor.sources[0].sourceId !== SEC_IPO_SOURCE_ID
  ) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
}

function currentCheckpoint(monitor: WorkspaceMonitor): SecIpoCheckpoint | null {
  const { contentDigest, watermark } = monitor.sourceCheckpoint;
  if (contentDigest === null && watermark === null) return null;
  if (contentDigest === null || watermark === null) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  return { contentDigest, watermark };
}

function findingCandidate(
  evaluation: SecIpoEvaluation,
  artifactRefs: readonly string[] = [],
  executiveSummary?: string,
): WorkspaceFindingCandidate | null {
  if (evaluation.findings.length === 0) return null;
  const facts = evaluation.findings.map(({ fact }) => fact);
  const latest = facts.reduce(
    (timestamp, fact) => fact.updatedAt > timestamp ? fact.updatedAt : timestamp,
    facts[0]!.updatedAt,
  );
  const summary = executiveSummary ?? (evaluation.findings.length === 1
    ? evaluation.findings[0]!.summary
    : `${evaluation.findings.length} new or amended SEC S-1 filings were observed in the configured window.`);
  return {
    accessClassification: "public",
    artifactRefs: [...artifactRefs],
    asOf: latest,
    factIdentities: facts.map((fact) => fact.filingIdentity),
    facts,
    provenance: [{
      accessClassification: "public",
      canonicalUrl: SEC_IPO_SOURCE_URL,
      origin: "https://www.sec.gov",
      sourceId: SEC_IPO_SOURCE_ID,
    }],
    summary,
  };
}

type SecIpoResearchRuntime = Readonly<{
  definition: ReturnType<typeof createSecIpoResearchDefinition>;
  modelId: string;
  pack: StrategyPackCatalogEntry;
  reasoning: ReturnType<typeof resolveHybridTaskModelRoute>["reasoning"];
  workspaceGeneration: number;
}>;

async function resolveSecIpoResearchRuntime(input: {
  capabilities: Awaited<ReturnType<typeof resolveWorkspaceWorkerCapabilitySnapshot>>;
  clients?: SecIpoWorkspaceWorkerClients;
  environment: NodeJS.ProcessEnv;
  monitor: WorkspaceMonitor;
  scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
}): Promise<SecIpoResearchRuntime | null> {
  const managed = input.monitor.managedBy;
  if (
    !managed || managed.packId !== "ipo-filings"
  ) {
    return null;
  }
  const strategy = await readWorkspaceDocument("strategy", input.scope, input.clients?.state);
  const pack = strategyPackCatalog.resolve({
    contentDigest: managed.packContentDigest,
    id: managed.packId,
    version: managed.packVersion,
  });
  const snapshot = strategy?.schemaVersion === 2
    ? strategy.value.pendingSnapshot ?? strategy.value.lastActiveSnapshot
    : null;
  if (
    !pack || !isSecIpoAgenticResearchPack(pack) ||
    strategy?.schemaVersion !== 2 || strategy.value.lifecycleState !== "active" ||
    strategy.value.pack?.id !== pack.id ||
    strategy.value.pack.version !== pack.version ||
    strategy.value.pack.contentDigest !== pack.contentDigest ||
    snapshot?.workspaceGeneration === undefined
  ) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  const configured = resolveHybridTaskModelRoute("semantic_interpretation", input.environment);
  const candidates = input.capabilities.resolved.workerModelIds
    .flatMap((modelId) => (pack.evidenceContracts ?? []).flatMap((contract) =>
      contract.id === SEC_IPO_RESEARCH_DEFINITION_ID &&
          (contract.version === "1.0.0" || contract.version === "1.0.1")
        ? [createSecIpoResearchDefinition([modelId], contract.version)]
        : []
    ))
    .filter((definition) => pack.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest
    ));
  if (candidates.length !== 1 || candidates[0]?.allowedModelIds[0] !== configured.modelId) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  return Object.freeze({
    definition: candidates[0]!,
    modelId: configured.modelId,
    pack,
    reasoning: configured.reasoning,
    workspaceGeneration: snapshot.workspaceGeneration,
  });
}

async function drainHybridWorker(
  prepared: PreparedHybridEvidenceWorkerRun,
): Promise<void> {
  const handle = await startHybridEvidenceWorkerTask(prepared.request);
  const reader = handle.events.getReader();
  try {
    while (!(await reader.read()).done) {
      // The compiled completion tool durably owns the result commit.
    }
  } finally {
    reader.releaseLock();
  }
}

async function selectUnseenEvaluationFindings(input: {
  client?: WorkspaceFindingStoreClient;
  evaluation: SecIpoEvaluation;
  monitorId: string;
  scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
}): Promise<SecIpoEvaluation> {
  const unseen = new Set(
    await selectUnseenWorkspaceFindingIdentities({
      factIdentities: input.evaluation.findings.map(
        ({ fact }) => fact.filingIdentity,
      ),
      monitorId: input.monitorId,
      scope: input.scope,
    }, input.client),
  );
  const findings = input.evaluation.findings.filter(
    ({ fact }) => unseen.has(fact.filingIdentity),
  );
  const findingIds = new Set(findings.map(({ findingId }) => findingId));
  return Object.freeze({
    ...input.evaluation,
    alerts: Object.freeze(
      input.evaluation.alerts.filter(({ findingId }) =>
        findingIds.has(findingId)
      ),
    ),
    findings: Object.freeze(findings),
  });
}

function alertPresentation(evaluation: SecIpoEvaluation) {
  return secIpoAlertPresentationForFacts(
    evaluation.findings.map(({ fact }) => fact),
  );
}

async function publishSignalReport(input: {
  brief?: WorkspaceExecutiveBrief;
  clients?: SecIpoWorkspaceWorkerClients;
  evaluation: SecIpoEvaluation;
  signal?: AbortSignal;
  scope: { ownerId: string; workspaceId: string };
}): Promise<string | null> {
  const facts = input.evaluation.findings.map(({ fact }) => fact);
  if (facts.length === 0) return null;
  const artifactId = secIpoReportArtifactId({ facts, ...input.scope });
  const published = await (input.clients?.publishReport ?? publishReportArtifact)({
    artifactId,
    report: buildSecIpoSignalReport({
      asOf: input.evaluation.checkpoint.watermark,
      brief: input.brief,
      facts,
    }),
    signal: input.signal,
  });
  if (published.artifactId !== artifactId || published.kind !== "report") {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  return artifactReferenceForId(artifactId);
}

export async function materializeSecIpoExecutiveOutput(input: {
  approvedSupplementaryUrls: readonly string[];
  brief: WorkspaceExecutiveBrief;
  clients?: SecIpoWorkspaceWorkerClients;
  evaluation: SecIpoEvaluation;
  signal?: AbortSignal;
  scope: { ownerId: string; workspaceId: string };
}): Promise<{
  readonly artifactRefs: readonly string[];
  readonly presentation: { title: string; whyMatched: string };
}> {
  const brief = workspaceExecutiveBriefSchema.parse(input.brief);
  const officialUrls = new Set(
    brief.sources.filter(({ role }) => role === "official").map(({ url }) => url),
  );
  const filingUrls = new Set(
    input.evaluation.findings.map(({ fact }) => fact.canonicalFilingUrl),
  );
  const approvedSupplementaryUrls = new Set(input.approvedSupplementaryUrls);
  const supplementaryUrls = brief.sources
    .filter(({ role }) => role === "supplementary")
    .map(({ url }) => url);
  if (
    officialUrls.size !== filingUrls.size ||
    [...officialUrls].some((url) => !filingUrls.has(url)) ||
    supplementaryUrls.some((url) => !approvedSupplementaryUrls.has(url)) ||
    brief.materialFacts.some(({ sourceUrls }) =>
      !sourceUrls.some((url) => officialUrls.has(url))
    )
  ) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  const presentation = secIpoAlertPresentationForBrief(brief);
  if (!shouldPublishWorkspaceExecutiveArtifact({
    alertText: `${presentation.title}\n\n${presentation.whyMatched}`,
    brief,
  })) {
    return Object.freeze({ artifactRefs: Object.freeze([]), presentation });
  }
  const artifactRef = await publishSignalReport({ ...input, brief });
  if (artifactRef === null) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
  }
  return Object.freeze({
    artifactRefs: Object.freeze([artifactRef]),
    presentation,
  });
}

function evaluationFromProjections(input: {
  checkpoint: SecIpoCheckpoint;
  previousCheckpoint: SecIpoCheckpoint | null;
  projections: readonly AuthorizedPublicSourceProjection[];
  scope: { ownerId: string; workspaceId: string };
  sourceBaselineEstablished: boolean;
}): SecIpoEvaluation {
  const eligibleProjections = input.previousCheckpoint === null
    ? input.projections
    : input.projections.filter(({ fact }) =>
        fact.payload.schemaVersion === "sec-filing/v1" &&
        fact.payload.updatedAt > input.previousCheckpoint!.watermark
      );
  const baselineEstablished = input.previousCheckpoint === null &&
    (input.sourceBaselineEstablished || eligibleProjections.length === 0);
  const findings = baselineEstablished
    ? []
    : eligibleProjections.map(({ fact }) => {
        if (fact.payload.schemaVersion !== "sec-filing/v1") {
          throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
        }
        const payload = fact.payload;
        const filingIdentity = `${payload.accessionNumber}:${payload.formType}`;
        const registrationIdentity = `${payload.cik}:${payload.fileNumber ?? payload.accessionNumber}`;
        const normalizedFilingHash = fact.provenance.rowEvidenceDigest;
        if (normalizedFilingHash === null) {
          throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
        }
        const classification = payload.formType === "S-1"
          ? "new_registration" as const
          : "amendment" as const;
        const typedFact: SecIpoFilingFact = {
          accessionNumber: payload.accessionNumber,
          amendmentIdentity: classification === "amendment"
            ? `${registrationIdentity}:${filingIdentity}`
            : null,
          canonicalFilingUrl: payload.filingUrl,
          cik: payload.cik,
          classification,
          companyName: payload.companyName,
          contentEvidence: {
            feedContentHash: input.checkpoint.contentDigest,
            normalizedFilingHash,
          },
          fileNumber: payload.fileNumber,
          filedAt: payload.publishedAt,
          filingIdentity,
          formType: payload.formType,
          kind: "sec_ipo_filing",
          normalizerVersion: SEC_IPO_NORMALIZER_VERSION,
          observedAt: fact.createdObservedAt,
          registrationIdentity,
          schemaVersion: 1,
          source: {
            accessClassification: "public",
            canonicalUrl: SEC_IPO_SOURCE_URL,
            origin: "https://www.sec.gov",
            sourceId: SEC_IPO_SOURCE_ID,
          },
          updatedAt: payload.updatedAt,
        };
        const filing: SecIpoFiling = {
          accessionNumber: payload.accessionNumber,
          canonicalFilingUrl: payload.filingUrl,
          cik: payload.cik,
          classification,
          companyName: payload.companyName,
          contentHash: normalizedFilingHash,
          dedupeKey: filingIdentity,
          fileNumber: payload.fileNumber,
          formType: payload.formType,
          normalizerVersion: SEC_IPO_NORMALIZER_VERSION,
          observedAt: fact.createdObservedAt,
          publishedAt: payload.publishedAt,
          registrationKey: registrationIdentity,
          updatedAt: payload.updatedAt,
        };
        const findingId = deriveSecIpoSignalId("finding", filing, input.scope);
        return Object.freeze({
          fact: typedFact,
          findingId,
          filing,
          summary: classification === "new_registration"
            ? `${payload.companyName} filed Form S-1, a potential IPO registration; this does not prove an IPO will occur.`
            : `${payload.companyName} filed Form S-1/A, an update to registration ${payload.fileNumber ?? payload.accessionNumber}.`,
        });
      });
  return Object.freeze({
    alerts: Object.freeze(findings.map((finding) => Object.freeze({
      alertId: deriveSecIpoSignalId("alert", finding.filing, input.scope),
      findingId: finding.findingId,
      title: finding.fact.classification === "new_registration"
        ? "New SEC S-1 registration"
        : "SEC S-1 registration update",
      whyMatched: finding.fact.classification === "new_registration"
        ? "A newly observed S-1 is a potential IPO registration, not confirmation of an IPO."
        : "A newly observed S-1/A amends an existing registration and is not a new IPO candidate.",
    }))),
    baselineEstablished,
    checkpoint: input.checkpoint,
    findings: Object.freeze(findings),
  });
}

export async function evaluateSecIpoSourceForWorker(input: {
  clients?: SecIpoWorkspaceWorkerClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<SecIpoWorkspaceWorkerResult> {
  const now = input.now ?? new Date();
  const environment = input.environment ?? process.env;
  const envelope = requireWorkspaceWorkerAuth(
    input.ctx,
    {},
    environment,
  );
  const scope = authorizeWorkspaceWorkerStore(input.ctx, environment);
  const existing = await readWorkspaceRunOutcome(
    scope,
    envelope.occurrenceKey,
    input.clients?.finding,
  );
  if (existing) {
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      alertPresentation: secIpoAlertPresentationForFacts(
        existing.finding?.facts?.filter(
          (fact): fact is SecIpoFilingFact => fact.kind === "sec_ipo_filing",
        ) ?? [],
      ),
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
    });
    return Object.freeze({
      baselineEstablished: false,
      checkpoint: {
        contentDigest: outcome.checkpoint.contentDigest,
        watermark: outcome.checkpoint.watermark,
      },
      factCount: outcome.finding?.facts?.length ?? 0,
      outcome,
      replayed: true,
    });
  }
  const capabilities = await resolveWorkspaceWorkerCapabilitySnapshot({
    envelope,
    registry: [{
      definition: true,
      metadata: {
        category: "control_plane",
        id: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
      },
    }],
    scope,
    stateClient: input.clients?.state,
  });
  if (!(EVALUATE_SEC_IPO_SOURCE_TOOL_ID in capabilities.tools)) {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_capability_denied");
  }
  const monitor = await getWorkspaceMonitor(
    scope,
    envelope.monitorId,
    input.clients?.monitor,
  );
  assertIpoMonitor(monitor, envelope);
  const researchRuntime = await resolveSecIpoResearchRuntime({
    capabilities,
    clients: input.clients,
    environment,
    monitor,
    scope,
  });
  const publicSourcePath = resolveSecPublicSourceRuntimePath(environment);
  if (publicSourcePath === "public_source_misconfigured") {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_public_source_misconfigured");
  }
  if (researchRuntime && publicSourcePath !== "public_source_adapter") {
    throw new SecIpoWorkspaceWorkerError("sec_ipo_public_source_misconfigured");
  }
  const source = await authorizeWorkspaceSourceFetch({
    runId: envelope.runId,
    scope,
    sourceId: SEC_IPO_SOURCE_ID,
    url: SEC_IPO_SOURCE_URL,
  }, input.clients?.sourceCoverage);
  await reserveWorkspaceSourceAttempt({
    now,
    runId: envelope.runId,
    scope,
    sourceId: source.sourceId,
  }, input.clients?.sourceCoverage);
  let evaluated: SecIpoEvaluation;
  let researchProjection: Readonly<{
    acquisitionId: string;
    projections: readonly AuthorizedPublicSourceProjection[];
    subscriptionId: string;
  }> | null = null;
  if (publicSourcePath === "public_source_adapter") {
    const migrated = await migrateSecPublicSourceWorkspace({
      monitor,
      monitorId: monitor.monitorId,
      now,
      scope,
    }, {
      monitor: input.clients?.monitor,
      state: input.clients?.state,
      subscription: input.clients?.subscription,
    });
    const previousCheckpoint = currentCheckpoint(migrated.monitor);
    const coordinated = await coordinatePublicSourceOccurrence({
      clients: {
        acquisition: input.clients?.acquisition,
        subscription: input.clients?.subscription,
      },
      environment,
      fetch: {
        adapterId: "sec-latest-filings",
        fetchResponse: async () => ({
          ...(input.clients?.fetchSource
            ? await input.clients.fetchSource(SEC_IPO_SOURCE_URL)
            : await fetchOfficialPublicSourceText(SEC_IPO_SOURCE_URL, source)),
          observedAt: now.toISOString(),
        }),
      },
      monitor: migrated.monitor,
      observedAt: now,
      scope,
      sourceId: SEC_IPO_SOURCE_ID,
      window: envelope.window,
    });
    const nextCursor = coordinated.acquisition.proposedNextCursor;
    if (!coordinated.projection || nextCursor === null) {
      throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
    }
    evaluated = evaluationFromProjections({
      checkpoint: {
        contentDigest: nextCursor.contentDigest,
        watermark: nextCursor.watermark,
      },
      previousCheckpoint,
      projections: coordinated.projection.projections,
      scope,
      sourceBaselineEstablished: coordinated.baselineEstablished,
    });
    researchProjection = Object.freeze({
      acquisitionId: coordinated.acquisition.acquisitionId,
      projections: coordinated.projection.projections,
      subscriptionId: coordinated.subscription.subscriptionId,
    });
  } else {
    const fetched = input.clients?.fetchSource
      ? await input.clients.fetchSource(SEC_IPO_SOURCE_URL)
      : await fetchOfficialPublicSourceText(SEC_IPO_SOURCE_URL, source);
    const page = normalizeSecIpoFetch({
      ...fetched,
      observedAt: now.toISOString(),
    });
    evaluated = evaluateSecIpoPage(
      page,
      currentCheckpoint(monitor),
      scope,
      { windowEndAt: envelope.window.endAt },
    );
  }
  await markWorkspaceSourceSuccess({
    contentDigest: evaluated.checkpoint.contentDigest,
    now,
    runId: envelope.runId,
    scope,
    sourceId: source.sourceId,
  }, input.clients?.sourceCoverage);
  const evaluation = await selectUnseenEvaluationFindings({
    client: input.clients?.finding,
    evaluation: evaluated,
    monitorId: envelope.monitorId,
    scope,
  });
  let presentation = alertPresentation(evaluation);
  let artifactRefs: readonly string[] = Object.freeze([]);
  let summary: string | undefined;
  if (researchRuntime && evaluation.findings.length > 0) {
    if (!researchProjection || evaluation.findings.length > 16) {
      throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
    }
    const artifacts = input.clients?.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
    const persisted = [];
    try {
      for (const finding of evaluation.findings) {
        const projection = researchProjection.projections.find(({ fact }) =>
          fact.payload.schemaVersion === "sec-filing/v1" &&
          fact.payload.accessionNumber === finding.fact.accessionNumber &&
          fact.payload.formType === finding.fact.formType
        );
        if (!projection) {
          throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
        }
        const content = JSON.stringify({
          accessionNumber: finding.fact.accessionNumber,
          canonicalFilingUrl: finding.fact.canonicalFilingUrl,
          cik: finding.fact.cik,
          classification: finding.fact.classification,
          companyName: finding.fact.companyName,
          filedAt: finding.fact.filedAt,
          fileNumber: finding.fact.fileNumber,
          formType: finding.fact.formType,
          summary: finding.summary,
          updatedAt: finding.fact.updatedAt,
        });
        const artifact = await artifacts.persist({
          acquisitionId: researchProjection.acquisitionId,
          authority: "SEC",
          bytes: Buffer.from(content, "utf8"),
          canonicalPublicUrl: finding.fact.canonicalFilingUrl,
          mediaType: "text/plain",
          now,
          observedAt: finding.fact.observedAt,
          parserEligibility: null,
          sourceInstanceId: projection.fact.sourceInstanceId,
          structure: {
            characterCount: content.length,
            columnCount: null,
            pageCount: null,
            rowCount: null,
            sheetCount: null,
          },
        });
        persisted.push({ artifact, content, projection });
      }
      const semantic = await runWorkspaceSemanticEvidenceBundleJob({
        definition: researchRuntime.definition,
        environment,
        members: persisted.map(({ artifact, content, projection }) => ({
          artifact,
          locators: [{
            factRevisionId: projection.fact.revisionId,
            kind: "source_fact" as const,
            payloadDigest: projection.fact.payloadDigest,
          }, {
            artifactDigest: artifact.contentDigest,
            end: content.length,
            kind: "text_span" as const,
            spanDigest: createHash("sha256").update(content).digest("hex"),
            start: 0,
          }],
          memberId: projection.fact.revisionId,
          projectionReference: {
            factRevisionId: projection.fact.revisionId,
            sourceId: SEC_IPO_SOURCE_ID,
            subscriptionId: researchProjection!.subscriptionId,
          },
          role: "section" as const,
          semanticContext: Object.freeze({ normalizedSecFiling: true }),
        })),
        modelId: researchRuntime.modelId,
        now,
        pack: {
          contentDigest: researchRuntime.pack.contentDigest,
          id: researchRuntime.pack.id,
          version: researchRuntime.pack.version,
        },
        parentBudgetRunId: envelope.runId,
        reasoning: researchRuntime.reasoning,
        scope,
        workspaceGeneration: researchRuntime.workspaceGeneration,
      }, {
        acquisition: input.clients?.semantic?.acquisition ?? input.clients?.acquisition,
        artifacts,
        budget: input.clients?.semantic?.budget,
        catalog: input.clients?.semantic?.catalog,
        execute: input.clients?.semantic?.execute ?? drainHybridWorker,
        jobs: input.clients?.semantic?.jobs,
        lineage: input.clients?.semantic?.lineage,
        monitor: input.clients?.monitor,
        semantic: input.clients?.semantic?.semantic,
        state: input.clients?.state,
        subscription: input.clients?.subscription,
      });
      const accepted = semantic.record.acceptedResult;
      if (!accepted) {
        throw new SecIpoWorkspaceWorkerError("sec_ipo_monitor_invalid");
      }
      const brief = workspaceExecutiveBriefSchema.parse(accepted.payload);
      const output = await materializeSecIpoExecutiveOutput({
        approvedSupplementaryUrls: semantic.record.researchUrlGrants,
        brief,
        clients: input.clients,
        evaluation,
        signal: input.ctx.abortSignal,
        scope,
      });
      artifactRefs = output.artifactRefs;
      presentation = output.presentation;
      summary = output.presentation.whyMatched;
    } finally {
      for (const { artifact } of persisted) {
        await artifacts.deleteUnreferenced(artifact.contentDigest);
      }
    }
  } else if (!researchRuntime) {
    const reportArtifactRef = await publishSignalReport({
      clients: input.clients,
      evaluation,
      signal: input.ctx.abortSignal,
      scope,
    });
    artifactRefs = reportArtifactRef ? Object.freeze([reportArtifactRef]) : Object.freeze([]);
  }
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    alertPresentation: presentation,
    checkpoint: evaluation.checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment,
    finding: findingCandidate(
      evaluation,
      artifactRefs,
      summary,
    ),
    initialBaseline: evaluation.baselineEstablished,
    now,
    toolId: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  });
  return Object.freeze({
    baselineEstablished: evaluation.baselineEstablished,
    checkpoint: evaluation.checkpoint,
    factCount: evaluation.findings.length,
    outcome,
    replayed: false,
  });
}

export type SecIpoWorkspaceRunRecoveryResult =
  | {
      readonly outcome: WorkspaceRunOutcome;
      readonly status: "already_completed" | "recovered";
    }
  | { readonly status: "missing" | "not_applicable" };

export async function recoverSecIpoWorkspaceRunForControlPlane(input: {
  clients?: SecIpoWorkspaceWorkerClients;
  now?: Date;
  prepared: PreparedWorkspaceWorkerRecovery;
}): Promise<SecIpoWorkspaceRunRecoveryResult> {
  const sources = input.prepared.monitor.sources;
  if (
    sources.length !== 1 ||
    sources[0]?.sourceId !== SEC_IPO_SOURCE_ID ||
    sources[0].canonicalUrl !== SEC_IPO_SOURCE_URL
  ) {
    return Object.freeze({ status: "not_applicable" });
  }
  const existing = await readWorkspaceRunOutcome(
    input.prepared.scope,
    input.prepared.claimed.occurrence.occurrenceKey,
    input.clients?.finding,
  );
  if (!existing) return Object.freeze({ status: "missing" });
  return finalizePriorWorkspaceRunOutcomeForControlPlane({
    alertPresentation: secIpoAlertPresentationForFacts(
      existing.finding?.facts?.filter(
        (fact): fact is SecIpoFilingFact => fact.kind === "sec_ipo_filing",
      ) ?? [],
    ),
    clients: input.clients,
    now: input.now,
    outcome: existing,
    prepared: input.prepared,
    toolId: EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  });
}

export const secIpoWorkspaceWorkerOutputSchema = z.object({
  baselineEstablished: z.boolean(),
  checkpoint: z.object({
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    watermark: z.string().datetime({ offset: true }),
  }).strict(),
  factCount: z.number().int().min(0).max(50),
  outcome: z.enum(["finding_staged", "no_match"]),
  replayed: z.boolean(),
  runId: z.string().min(1).max(160),
}).strict();

export const evaluateSecIpoSourceTool = defineTool({
  description:
    "Evaluate the one exact configured SEC IPO feed deterministically. This tool owns source fetching, S-1/S-1/A classification, typed facts, checkpointing, and alert staging; do not use generic finding tools for this source.",
  inputSchema: z.object({}).strict(),
  outputSchema: secIpoWorkspaceWorkerOutputSchema,
  async execute(_input, ctx) {
    const { resolveSecIpoWorkspaceWorkerFixtureClients } = await import(
      "./workspace-worker-test-fixtures"
    );
    const result = await evaluateSecIpoSourceForWorker({
      clients: resolveSecIpoWorkspaceWorkerFixtureClients(),
      ctx,
    });
    return {
      baselineEstablished: result.baselineEstablished,
      checkpoint: result.checkpoint,
      factCount: result.factCount,
      outcome: result.outcome.outcome,
      replayed: result.replayed,
      runId: result.outcome.runId,
    };
  },
});
