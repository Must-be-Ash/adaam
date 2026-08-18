import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolvePublicCommentaryRuntimeFlags } from "./public-commentary-flags";
import { INVERSE_CRAMER_EVALUATION_TOOL_ID } from "./strategy-pack-reference-catalog";
import { getWorkspaceMonitor } from "./workspace-monitor-store";
import { readWorkspaceDocument } from "./workspace-state-store";
import { readWorkspaceRunOutcome, type WorkspaceFindingCandidate } from "./workspace-finding-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import {
  commitDeterministicWorkspaceEvaluationForWorker,
  finalizeExistingWorkspaceRunOutcomeForWorker,
  type WorkspaceWorkerControlPlaneClients,
} from "./workspace-worker-control-plane";

type WorkerContext = Parameters<typeof requireWorkspaceWorkerAuth>[0];

export interface PublicCommentaryPipelineResult {
  readonly alertPresentation: { readonly title: string; readonly whyMatched: string } | null;
  readonly analyzedStatements: number;
  readonly checkpoint: Readonly<{ readonly contentDigest: string; readonly watermark: string }>;
  readonly finding: WorkspaceFindingCandidate | null;
}

export interface PublicCommentaryWorkspaceWorkerClients extends WorkspaceWorkerControlPlaneClients {
  readonly pipeline?: Readonly<{
    run(input: Readonly<{
      configuration: Readonly<Record<string, unknown>>;
      configurationGeneration: number;
      environment: NodeJS.ProcessEnv;
      monitorId: string;
      ownerId: string;
      pack: Readonly<{ contentDigest: string; id: "inverse-cramer"; version: string }>;
      scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
      window: Readonly<{ endAt: string; startAt: string }>;
    }>): Promise<PublicCommentaryPipelineResult>;
  }>;
}

export class PublicCommentaryWorkspaceWorkerError extends Error {
  constructor(readonly code:
    | "public_commentary_capability_denied"
    | "public_commentary_execution_disabled"
    | "public_commentary_monitor_invalid"
    | "public_commentary_pipeline_unavailable"
    | "public_commentary_strategy_invalid"
  ) {
    super(code);
    this.name = "PublicCommentaryWorkspaceWorkerError";
  }
}

export async function evaluatePublicCommentarySignalsForWorker(input: {
  readonly clients?: PublicCommentaryWorkspaceWorkerClients;
  readonly ctx: WorkerContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
}) {
  const environment = input.environment ?? process.env;
  const now = input.now ?? new Date();
  const envelope = requireWorkspaceWorkerAuth(input.ctx, {}, environment);
  const scope = authorizeWorkspaceWorkerStore(input.ctx, environment);
  const existing = await readWorkspaceRunOutcome(scope, envelope.occurrenceKey, input.clients?.finding);
  if (existing) {
    const outcome = await finalizeExistingWorkspaceRunOutcomeForWorker({
      clients: input.clients,
      ctx: input.ctx,
      environment,
      now,
      outcome: existing,
      toolId: INVERSE_CRAMER_EVALUATION_TOOL_ID,
    });
    return Object.freeze({ analyzedStatements: 0, outcome, replayed: true });
  }
  if (!resolvePublicCommentaryRuntimeFlags(environment).strategyExecutionEnabled) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_execution_disabled");
  }
  const [capabilities, monitor, strategy] = await Promise.all([
    resolveWorkspaceWorkerCapabilitySnapshot({
      envelope,
      registry: [{ definition: true, metadata: { category: "control_plane", id: INVERSE_CRAMER_EVALUATION_TOOL_ID } }],
      scope,
      stateClient: input.clients?.state,
    }),
    getWorkspaceMonitor(scope, envelope.monitorId, input.clients?.monitor),
    readWorkspaceDocument("strategy", scope, input.clients?.state),
  ]);
  if (!(INVERSE_CRAMER_EVALUATION_TOOL_ID in capabilities.tools)) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_capability_denied");
  }
  if (
    !monitor || monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    monitor.managedBy?.packId !== "inverse-cramer" ||
    envelope.strategyPack?.packId !== "inverse-cramer" ||
    envelope.strategyPack.packContentDigest !== monitor.managedBy.packContentDigest
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_monitor_invalid");
  if (
    strategy?.schemaVersion !== 2 || strategy.value.pack?.id !== "inverse-cramer" ||
    strategy.value.pack.contentDigest !== monitor.managedBy.packContentDigest ||
    strategy.value.pack.version !== monitor.managedBy.packVersion
  ) throw new PublicCommentaryWorkspaceWorkerError("public_commentary_strategy_invalid");
  if (!input.clients?.pipeline) {
    throw new PublicCommentaryWorkspaceWorkerError("public_commentary_pipeline_unavailable");
  }
  const result = await input.clients.pipeline.run({
    configuration: strategy.value.configuration,
    configurationGeneration: envelope.strategyPack.workspaceGeneration,
    environment,
    monitorId: monitor.monitorId,
    ownerId: scope.ownerId,
    pack: {
      contentDigest: monitor.managedBy.packContentDigest,
      id: "inverse-cramer",
      version: monitor.managedBy.packVersion,
    },
    scope,
    window: envelope.window,
  });
  const outcome = await commitDeterministicWorkspaceEvaluationForWorker({
    alertPresentation: result.alertPresentation ?? undefined,
    checkpoint: result.checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment,
    finding: result.finding,
    initialBaseline: monitor.sourceCheckpoint.watermark === null,
    now,
    toolId: INVERSE_CRAMER_EVALUATION_TOOL_ID,
  });
  return Object.freeze({ analyzedStatements: result.analyzedStatements, outcome, replayed: false });
}

export const evaluatePublicCommentarySignalsTool = defineTool({
  description: "Run the bounded Inverse Cramer acquisition-projection, extraction, optional related-source search, semantic interpretation, registered policy, persistence, checkpoint, and at-most-once alert pipeline.",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({
    analyzedStatements: z.number().int().nonnegative().max(200),
    outcome: z.enum(["finding_staged", "no_match"]),
    replayed: z.boolean(),
    runId: z.string().min(1).max(160),
  }).strict(),
  async execute(_input, ctx) {
    const result = await evaluatePublicCommentarySignalsForWorker({ ctx });
    return {
      analyzedStatements: result.analyzedStatements,
      outcome: result.outcome.outcome,
      replayed: result.replayed,
      runId: result.outcome.runId,
    };
  },
});
