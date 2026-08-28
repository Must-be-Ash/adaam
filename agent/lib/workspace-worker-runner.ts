import { createHash } from "node:crypto";

import type { SessionAuthContext } from "eve/context";

import type { WorkspaceDispatchReservation } from "./workspace-dispatch-budget";
import { resolveManagedMonitorLifecycleContract } from "./workspace-monitor-lifecycle-contract";
import {
  readWorkspaceRunOutcome,
  type WorkspaceFindingStoreClient,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import {
  getWorkspaceMonitor,
  workspaceMonitorOccurrenceKey,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import {
  buildWorkspaceSourcePrompt,
  createWorkspaceSourceCoverage,
  type WorkspaceSourceCoverageClient,
} from "./workspace-source-coverage";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import {
  prepareWorkspaceWorkerStrategyPackRuntime,
  type StrategyPackRuntimeCatalog,
  type StrategyPackWorkerSnapshot,
} from "./strategy-pack-runtime";
import {
  createWorkspaceWorkerEnvelope,
  signWorkspaceWorkerEnvelope,
  workspaceWorkerExecutionAuth,
  type WorkspaceWorkerEnvelope,
} from "./workspace-worker-auth";

/*
 * Retained as the reviewed default identifier for capability fixtures and
 * compatibility callers. Scheduled occurrences no longer launch a primary
 * model turn, so dispatch preparation must not require this identifier to be
 * present in a workspace's persisted model policy.
 */
export const WORKSPACE_WORKER_MODEL_ID = "zai/glm-5.3-flash";

/*
 * A scheduled occurrence no longer runs an LLM worker session; the scheduler
 * invokes the strategy evaluator deterministically (see
 * `workspace-evaluator-dispatch.ts`). The only thing the evaluator needs from
 * this preparation is the signed runtime auth - `ctx.session.auth.current` - so
 * the prepared request carries just that. Envelope and source coverage are still
 * prepared here because the deterministic commit path reads them.
 */
export interface WorkspaceWorkerTaskRequest {
  readonly auth: SessionAuthContext;
}

export interface PreparedWorkspaceWorkerRun {
  readonly envelope: WorkspaceWorkerEnvelope;
  readonly request: WorkspaceWorkerTaskRequest;
  readonly scope: AuthorizedWorkspaceStoreScope;
}

export interface PreparedWorkspaceWorkerRecovery {
  readonly capabilityRevision: number;
  readonly claimed: ClaimedWorkspaceMonitor;
  readonly expectedRunId: string | null;
  readonly monitor: WorkspaceMonitor;
  readonly strategyPack: StrategyPackWorkerSnapshot | null;
  readonly scope: AuthorizedWorkspaceStoreScope;
}

export interface WorkspaceWorkerRunnerClients {
  readonly sourceCoverage?: WorkspaceSourceCoverageClient;
  readonly state?: WorkspaceStateStoreClient;
  readonly strategyPackCatalog?: StrategyPackRuntimeCatalog;
}

export interface WorkspaceWorkerRecoveryClients {
  readonly monitor?: WorkspaceMonitorStoreClient;
  readonly state?: WorkspaceStateStoreClient;
  readonly strategyPackCatalog?: StrategyPackRuntimeCatalog;
}

export class WorkspaceWorkerRunnerError extends Error {
  readonly code:
    | "workspace_worker_model_denied"
    | "workspace_worker_prompt_too_large"
    | "workspace_worker_required_outcome_missing"
    | "workspace_worker_state_missing"
    | "workspace_worker_state_stale";

  constructor(code: WorkspaceWorkerRunnerError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceWorkerRunnerError";
  }
}

function sameSources(
  left: WorkspaceMonitor["sources"],
  right: WorkspaceMonitor["sources"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function prepareWorkspaceWorkerRecovery(input: {
  claimed: ClaimedWorkspaceMonitor;
  clients?: WorkspaceWorkerRecoveryClients;
  expectedRunId?: string;
}): Promise<PreparedWorkspaceWorkerRecovery> {
  const expectedOccurrenceKey = workspaceMonitorOccurrenceKey({
    configurationRevision: input.claimed.monitor.configurationRevision,
    monitorId: input.claimed.monitor.monitorId,
    occurrenceIdentity: input.claimed.occurrence.occurrenceIdentity,
    scope: input.claimed.scope,
  });
  if (
    input.claimed.monitor.ownerId !== input.claimed.scope.ownerId ||
    input.claimed.monitor.workspaceId !== input.claimed.scope.workspaceId ||
    input.claimed.occurrence.monitorId !== input.claimed.monitor.monitorId ||
    input.claimed.occurrence.configurationRevision !==
      input.claimed.monitor.configurationRevision ||
    input.claimed.occurrence.occurrenceKey !== expectedOccurrenceKey ||
    createHash("sha256").update(input.claimed.leaseToken).digest("hex") !==
      input.claimed.occurrence.leaseTokenDigest ||
    (input.expectedRunId !== undefined &&
      (input.claimed.occurrence.attempt !== 1 ||
        input.expectedRunId !== `${expectedOccurrenceKey}:attempt:1`))
  ) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_stale");
  }
  const [brief, strategy, capabilities, budget, currentMonitor] =
    await Promise.all([
      readWorkspaceDocument("brief", input.claimed.scope, input.clients?.state),
      readWorkspaceDocument("strategy", input.claimed.scope, input.clients?.state),
      readWorkspaceDocument(
        "capabilities",
        input.claimed.scope,
        input.clients?.state,
      ),
      readWorkspaceDocument("budget", input.claimed.scope, input.clients?.state),
      getWorkspaceMonitor(
        input.claimed.scope,
        input.claimed.monitor.monitorId,
        input.clients?.monitor,
      ),
    ]);
  if (!brief || !strategy || !capabilities || !budget || !currentMonitor) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_missing");
  }
  if (
    currentMonitor.lifecycleState !== "enabled" ||
    currentMonitor.ownerId !== input.claimed.scope.ownerId ||
    currentMonitor.workspaceId !== input.claimed.scope.workspaceId ||
    currentMonitor.configurationRevision !==
      input.claimed.monitor.configurationRevision ||
    !sameSources(currentMonitor.sources, input.claimed.monitor.sources)
  ) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_stale");
  }
  const allowedSources = new Map(
    capabilities.value.sources.map((source) => [source.sourceId, source.origin]),
  );
  if (
    currentMonitor.sources.some(
      (source) => allowedSources.get(source.sourceId) !== source.origin,
    )
  ) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_stale");
  }
  const strategyPack = await prepareWorkspaceWorkerStrategyPackRuntime({
    catalog: input.clients?.strategyPackCatalog,
    monitor: currentMonitor,
    scope: input.claimed.scope,
    stateClient: input.clients?.state,
  });
  return Object.freeze({
    capabilityRevision: capabilities.revision,
    claimed: input.claimed,
    expectedRunId: input.expectedRunId ?? null,
    monitor: currentMonitor,
    scope: input.claimed.scope,
    strategyPack: strategyPack?.snapshot ?? null,
  });
}

export async function requireWorkspaceWorkerOutcome(
  prepared: Pick<PreparedWorkspaceWorkerRun, "envelope" | "scope">,
  client?: WorkspaceFindingStoreClient,
): Promise<WorkspaceRunOutcome> {
  const outcome = await readWorkspaceRunOutcome(
    prepared.scope,
    prepared.envelope.occurrenceKey,
    client,
  );
  if (
    !outcome ||
    outcome.runId !== prepared.envelope.runId ||
    outcome.monitorId !== prepared.envelope.monitorId ||
    outcome.configurationRevision !== prepared.envelope.configurationRevision ||
    JSON.stringify(outcome.strategyPack) !==
      JSON.stringify(prepared.envelope.strategyPack)
  ) {
    throw new WorkspaceWorkerRunnerError(
      "workspace_worker_required_outcome_missing",
    );
  }
  return outcome;
}

export function resolveWorkspaceWorkerEvaluationWindow(job: ClaimedWorkspaceMonitor): {
  endAt: string;
  startAt: string;
} {
  const endAt = job.occurrence.scheduledFor;
  const intervalMinutes = job.monitor.schedule.kind === "interval"
    ? job.monitor.schedule.everyMinutes
    : null;
  const lifecycle = resolveManagedMonitorLifecycleContract(job.monitor);
  const cadenceBackfill = job.monitor.sourceCheckpoint.watermark === null &&
    intervalMinutes !== null &&
    lifecycle?.initialEvaluationWindow === "preceding_interval";
  const startAt = job.monitor.sourceCheckpoint.watermark ?? (cadenceBackfill
    ? new Date(Date.parse(endAt) - intervalMinutes! * 60_000).toISOString()
    : job.monitor.createdAt);
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_stale");
  }
  return { endAt, startAt };
}

export async function prepareWorkspaceWorkerRun(input: {
  claimed: ClaimedWorkspaceMonitor;
  clients?: WorkspaceWorkerRunnerClients;
  dispatchBudget: WorkspaceDispatchReservation;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<PreparedWorkspaceWorkerRun> {
  const now = input.now ?? new Date();
  const [brief, strategy, capabilities, budget] = await Promise.all([
    readWorkspaceDocument("brief", input.claimed.scope, input.clients?.state),
    readWorkspaceDocument("strategy", input.claimed.scope, input.clients?.state),
    readWorkspaceDocument("capabilities", input.claimed.scope, input.clients?.state),
    readWorkspaceDocument("budget", input.claimed.scope, input.clients?.state),
  ]);
  if (!brief || !strategy || !capabilities || !budget) {
    throw new WorkspaceWorkerRunnerError("workspace_worker_state_missing");
  }
  const strategyPack = await prepareWorkspaceWorkerStrategyPackRuntime({
    catalog: input.clients?.strategyPackCatalog,
    environment: input.environment,
    monitor: input.claimed.monitor,
    scope: input.claimed.scope,
    stateClient: input.clients?.state,
  });
  const window = resolveWorkspaceWorkerEvaluationWindow(input.claimed);
  // Preparing coverage writes the run's source-coverage record, which the
  // deterministic commit path reads back; the return value is no longer needed
  // for a worker prompt.
  await createWorkspaceSourceCoverage(
    {
      configurationRevision: input.claimed.monitor.configurationRevision,
      monitorId: input.claimed.monitor.monitorId,
      now,
      runId: input.dispatchBudget.runId,
      scope: input.claimed.scope,
      sources: input.claimed.monitor.sources.map((source) => ({
        canonicalUrl: source.canonicalUrl,
        origin: source.origin,
        sourceId: source.sourceId,
      })),
      window,
    },
    input.clients?.sourceCoverage,
  );
  const leaseExpiresAt = new Date(input.claimed.leaseExpiresAt);
  const expiresAt = new Date(
    Math.min(leaseExpiresAt.getTime(), now.getTime() + 2 * 60 * 60_000),
  );
  const envelope = createWorkspaceWorkerEnvelope({
    budgetRevision: budget.revision,
    capabilityRevision: capabilities.revision,
    claimed: input.claimed,
    dispatchBudget: input.dispatchBudget,
    expiresAt,
    issuedAt: now,
    stateRevision: { brief: brief.revision, strategy: strategy.revision },
    strategyPack: strategyPack?.snapshot ?? null,
    window,
  });
  const token = signWorkspaceWorkerEnvelope(envelope, input.environment);
  return {
    envelope,
    request: Object.freeze({
      auth: workspaceWorkerExecutionAuth(envelope, token),
    }),
    scope: input.claimed.scope,
  };
}
