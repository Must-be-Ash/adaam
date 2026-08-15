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
  type WorkspaceFindingCandidate,
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
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";
import {
  fetchOfficialPublicSourceText,
  type OfficialPublicSourceResponse,
} from "../tools/fetch_public_source";

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

function alertPresentation(evaluation: SecIpoEvaluation):
  | { title: string; whyMatched: string }
  | undefined {
  if (evaluation.alerts.length === 0) return undefined;
  if (evaluation.alerts.length === 1) {
    return {
      title: evaluation.alerts[0]!.title,
      whyMatched: evaluation.alerts[0]!.whyMatched,
    };
  }
  return {
    title: `${evaluation.alerts.length} new SEC S-1 filings`,
    whyMatched:
      "The configured SEC feed contained multiple newly observed S-1 registrations or amendments.",
  };
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
    return Object.freeze({
      baselineEstablished: false,
      checkpoint: {
        contentDigest: existing.checkpoint.contentDigest,
        watermark: existing.checkpoint.watermark,
      },
      factCount: existing.finding?.facts?.length ?? 0,
      outcome: existing,
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
  const fetched = await (input.clients?.fetchSource ?? fetchOfficialPublicSourceText)(
    SEC_IPO_SOURCE_URL,
  );
  const page = normalizeSecIpoFetch({
    ...fetched,
    observedAt: now.toISOString(),
  });
  const evaluation = evaluateSecIpoPage(
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
