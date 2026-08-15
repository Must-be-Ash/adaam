import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
  type SecIpoCheckpoint,
  type SecIpoEvaluation,
} from "./sec-ipo-evaluation";
import {
  EVALUATE_SEC_IPO_SOURCE_TOOL_ID,
  SEC_IPO_SOURCE_ID,
  SEC_IPO_SOURCE_URL,
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
import type { SecIpoFilingFact } from "./workspace-finding-facts";
import {
  fetchOfficialPublicSourceText,
  type OfficialPublicSourceResponse,
} from "../tools/fetch_public_source";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";

export { EVALUATE_SEC_IPO_SOURCE_TOOL_ID } from "./sec-ipo-reference";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];

export interface SecIpoWorkspaceWorkerClients
  extends WorkspaceWorkerControlPlaneClients {
  readonly fetchSource?: (
    requestedUrl: string,
  ) => Promise<OfficialPublicSourceResponse>;
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
    | "sec_ipo_monitor_not_found";

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
): WorkspaceFindingCandidate | null {
  if (evaluation.findings.length === 0) return null;
  const facts = evaluation.findings.map(({ fact }) => fact);
  const latest = facts.reduce(
    (timestamp, fact) => fact.updatedAt > timestamp ? fact.updatedAt : timestamp,
    facts[0]!.updatedAt,
  );
  const summary = evaluation.findings.length === 1
    ? evaluation.findings[0]!.summary
    : `${evaluation.findings.length} new or amended SEC S-1 filings were observed in the configured window.`;
  return {
    accessClassification: "public",
    artifactRefs: [],
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

function alertPresentationForFacts(facts: readonly SecIpoFilingFact[]):
  | { title: string; whyMatched: string }
  | undefined {
  if (facts.length === 0) return undefined;
  if (facts.length === 1) {
    const fact = facts[0]!;
    return {
      title: fact.classification === "new_registration"
        ? "New SEC S-1 registration"
        : "SEC S-1 registration update",
      whyMatched: fact.classification === "new_registration"
        ? "A newly observed S-1 is a potential IPO registration, not confirmation of an IPO."
        : "A newly observed S-1/A amends an existing registration and is not a new IPO candidate.",
    };
  }
  return {
    title: `${facts.length} new SEC S-1 filings`,
    whyMatched:
      "The configured SEC feed contained multiple newly observed S-1 registrations or amendments.",
  };
}

function alertPresentation(evaluation: SecIpoEvaluation) {
  return alertPresentationForFacts(
    evaluation.findings.map(({ fact }) => fact),
  );
}

export async function evaluateSecIpoSourceForWorker(input: {
  clients?: SecIpoWorkspaceWorkerClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<SecIpoWorkspaceWorkerResult> {
  const now = input.now ?? new Date();
  const envelope = requireWorkspaceWorkerAuth(
    input.ctx,
    {},
    input.environment,
  );
  const scope = authorizeWorkspaceWorkerStore(input.ctx, input.environment);
  const existing = await readWorkspaceRunOutcome(
    scope,
    envelope.occurrenceKey,
    input.clients?.finding,
  );
  if (existing) {
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      alertPresentation: alertPresentationForFacts(
        existing.finding?.facts?.filter(
          (fact): fact is SecIpoFilingFact => fact.kind === "sec_ipo_filing",
        ) ?? [],
      ),
      clients: input.clients,
      ctx: input.ctx,
      environment: input.environment,
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
  const fetched = input.clients?.fetchSource
    ? await input.clients.fetchSource(SEC_IPO_SOURCE_URL)
    : await fetchOfficialPublicSourceText(SEC_IPO_SOURCE_URL, source);
  const page = normalizeSecIpoFetch({
    ...fetched,
    observedAt: now.toISOString(),
  });
  const evaluated = evaluateSecIpoPage(
    page,
    currentCheckpoint(monitor),
    scope,
    { windowEndAt: envelope.window.endAt },
  );
  await markWorkspaceSourceSuccess({
    contentDigest: page.contentHash,
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
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    alertPresentation: alertPresentation(evaluation),
    checkpoint: evaluation.checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment: input.environment,
    finding: findingCandidate(evaluation),
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
    alertPresentation: alertPresentationForFacts(
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
