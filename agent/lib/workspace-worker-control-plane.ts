import type { SessionContext } from "eve/context";
import { isDeepStrictEqual } from "node:util";

import {
  completeWorkspaceRunNoMatch,
  stageWorkspaceFinding,
  workspaceRunAttemptForOccurrence,
  type WorkspaceFindingCandidate,
  type WorkspaceFindingStoreClient,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import {
  completeWorkspaceMonitorCheckpoint,
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import {
  completeWorkspaceSourceCoverage,
  readWorkspaceSourceCoverage,
  type WorkspaceSourceCoverageClient,
} from "./workspace-source-coverage";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";
import type { PreparedWorkspaceWorkerRecovery } from "./workspace-worker-runner";
import {
  stageWorkspaceAlert,
  type WorkspaceAlertStoreClient,
} from "./workspace-alert-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth, type WorkspaceWorkerEnvelope } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";
import { requireWorkspaceWorkerStrategyPackRuntime } from "./strategy-pack-runtime";
import type { StrategyPackRuntimeCatalog } from "./strategy-pack-runtime";

export const COMPLETE_WORKSPACE_RUN_TOOL_ID = "complete_workspace_run";
export const WRITE_WORKSPACE_FINDING_TOOL_ID = "write_workspace_finding";

type WorkerContext = {
  readonly session: { readonly auth: SessionContext["session"]["auth"] };
};

export interface WorkspaceWorkerControlPlaneClients {
  readonly alert?: WorkspaceAlertStoreClient;
  readonly finding?: WorkspaceFindingStoreClient;
  readonly monitor?: WorkspaceMonitorStoreClient;
  readonly sourceCoverage?: WorkspaceSourceCoverageClient;
  readonly state?: WorkspaceStateStoreClient;
  readonly strategyPackCatalog?: StrategyPackRuntimeCatalog;
}

export class WorkspaceWorkerCommitError extends Error {
  readonly code:
    | "workspace_worker_capability_denied"
    | "workspace_worker_classification_denied"
    | "workspace_worker_run_stale";

  constructor(code: WorkspaceWorkerCommitError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceWorkerCommitError";
  }
}

export function isPriorWorkspaceRunForRecovery(input: {
  claimedAttempt: number;
  claimedOccurrenceKey: string;
  outcomeOccurrenceKey: string;
  outcomeRunId: string;
}): boolean {
  const priorAttempt = workspaceRunAttemptForOccurrence(
    input.outcomeOccurrenceKey,
    input.outcomeRunId,
  );
  return (
    input.outcomeOccurrenceKey === input.claimedOccurrenceKey &&
    priorAttempt !== null &&
    priorAttempt < input.claimedAttempt
  );
}

function findingMatchesOutcome(outcome: WorkspaceRunOutcome): boolean {
  return (
    outcome.finding === null ||
    (outcome.finding.ownerId === outcome.ownerId &&
      outcome.finding.workspaceId === outcome.workspaceId &&
      outcome.finding.monitorId === outcome.monitorId &&
      outcome.finding.runId === outcome.runId &&
      isDeepStrictEqual(outcome.finding.strategyPack, outcome.strategyPack))
  );
}

function sameSources(
  monitor: WorkspaceMonitor,
  envelope: Pick<WorkspaceWorkerEnvelope, "sources">,
): boolean {
  return JSON.stringify(monitor.sources) === JSON.stringify(envelope.sources);
}

async function assertCurrentMonitor(
  envelope: Pick<WorkspaceWorkerEnvelope,
    "capabilityRevision" | "configurationRevision" | "monitorId" | "sources" | "strategyPack"
  >,
  scope: ReturnType<typeof authorizeWorkspaceWorkerStore>,
  clients: Pick<
    WorkspaceWorkerControlPlaneClients,
    "monitor" | "state" | "strategyPackCatalog"
  > = {},
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceMonitor> {
  const monitor = await getWorkspaceMonitor(scope, envelope.monitorId, clients.monitor);
  if (
    !monitor ||
    monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    !sameSources(monitor, envelope)
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  try {
    await requireWorkspaceWorkerStrategyPackRuntime({
      catalog: clients.strategyPackCatalog,
      envelope,
      environment,
      monitor,
      scope,
      stateClient: clients.state,
    });
  } catch {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  return monitor;
}

async function prepareCommit(input: {
  allowInitialBaselineCheckpoint?: boolean;
  checkpoint?: { contentDigest: string; watermark: string };
  clients?: WorkspaceWorkerControlPlaneClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  toolId: string;
}): Promise<{
  coverage: Awaited<ReturnType<typeof completeWorkspaceSourceCoverage>>;
  envelope: WorkspaceWorkerEnvelope;
  maximumDataAccessClassification: "owner_private" | "public";
  monitor: WorkspaceMonitor;
  scope: ReturnType<typeof authorizeWorkspaceWorkerStore>;
}> {
  const envelope = requireWorkspaceWorkerAuth(input.ctx, {}, input.environment);
  const scope = authorizeWorkspaceWorkerStore(input.ctx, input.environment);
  const capabilities = await resolveWorkspaceWorkerCapabilitySnapshot({
    envelope,
    registry: [{
      definition: true,
      metadata: { category: "control_plane", id: input.toolId },
    }],
    scope,
    stateClient: input.clients?.state,
  });
  if (!(input.toolId in capabilities.tools)) {
    throw new WorkspaceWorkerCommitError("workspace_worker_capability_denied");
  }
  const monitor = await assertCurrentMonitor(
    envelope,
    scope,
    input.clients,
    input.environment,
  );
  const currentCoverage = await readWorkspaceSourceCoverage(
    scope,
    envelope.runId,
    input.clients?.sourceCoverage,
  );
  if (
    !currentCoverage ||
    currentCoverage.monitorId !== envelope.monitorId ||
    currentCoverage.configurationRevision !== envelope.configurationRevision
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  const coverage = await completeWorkspaceSourceCoverage(
    {
      allowCheckpointBeforeWindow:
        input.allowInitialBaselineCheckpoint === true &&
        monitor.sourceCheckpoint.watermark === null,
      checkpoint: input.checkpoint,
      now: input.now,
      runId: envelope.runId,
      scope,
    },
    input.clients?.sourceCoverage,
  );
  await assertCurrentMonitor(envelope, scope, input.clients, input.environment);
  return {
    coverage,
    envelope,
    maximumDataAccessClassification: capabilities.maximumDataAccessClassification,
    monitor,
    scope,
  };
}

async function completeMonitorCheckpoint(
  prepared: Awaited<ReturnType<typeof prepareCommit>>,
  input: {
    client?: WorkspaceMonitorStoreClient;
    now?: Date;
  },
): Promise<void> {
  if (prepared.coverage.checkpoint === null) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  await completeWorkspaceMonitorCheckpoint({
    completedAt: input.now,
    configurationRevision: prepared.envelope.configurationRevision,
    contentDigest: prepared.coverage.checkpoint.contentDigest,
    leaseTokenDigest: prepared.envelope.leaseTokenDigest,
    monitorId: prepared.envelope.monitorId,
    occurrenceKey: prepared.envelope.occurrenceKey,
    scheduledFor: prepared.envelope.scheduledFor,
    scope: prepared.scope,
    watermark: prepared.coverage.checkpoint.watermark,
  }, input.client);
}

export async function commitDeterministicWorkspaceEvaluationForWorker(input: {
  alertPresentation?: { title: string; whyMatched: string };
  checkpoint: { contentDigest: string; watermark: string };
  clients?: WorkspaceWorkerControlPlaneClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  finding: WorkspaceFindingCandidate | null;
  initialBaseline?: boolean;
  now?: Date;
  toolId: string;
}): Promise<WorkspaceRunOutcome> {
  if (input.initialBaseline === true && input.finding !== null) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  const prepared = await prepareCommit({
    allowInitialBaselineCheckpoint: input.initialBaseline,
    checkpoint: input.checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment: input.environment,
    now: input.now,
    toolId: input.toolId,
  });
  let outcome: WorkspaceRunOutcome;
  if (input.finding === null) {
    outcome = await completeWorkspaceRunNoMatch({
      coverage: prepared.coverage,
      envelope: prepared.envelope,
      now: input.now,
      scope: prepared.scope,
    }, input.clients?.finding);
  } else {
    if (
      input.finding.accessClassification === "owner_private" &&
      prepared.maximumDataAccessClassification === "public"
    ) {
      throw new WorkspaceWorkerCommitError(
        "workspace_worker_classification_denied",
      );
    }
    outcome = await stageWorkspaceFinding({
      coverage: prepared.coverage,
      envelope: prepared.envelope,
      finding: input.finding,
      now: input.now,
      scope: prepared.scope,
    }, input.clients?.finding);
    if (!outcome.finding) {
      throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
    }
    await stageWorkspaceAlert({
      finding: outcome.finding,
      monitor: prepared.monitor,
      now: input.now,
      presentation: input.alertPresentation,
      scope: prepared.scope,
    }, input.clients?.alert);
  }
  await completeMonitorCheckpoint(prepared, {
    client: input.clients?.monitor,
    now: input.now,
  });
  return outcome;
}

export async function finalizeExistingWorkspaceRunOutcomeForWorker(input: {
  alertPresentation?: { title: string; whyMatched: string };
  clients?: WorkspaceWorkerControlPlaneClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  outcome: WorkspaceRunOutcome;
  toolId: string;
}): Promise<WorkspaceRunOutcome> {
  const prepared = await prepareCommit({
    checkpoint: input.outcome.checkpoint,
    clients: input.clients,
    ctx: input.ctx,
    environment: input.environment,
    now: input.now,
    toolId: input.toolId,
  });
  if (
    input.outcome.ownerId !== prepared.scope.ownerId ||
    input.outcome.workspaceId !== prepared.scope.workspaceId ||
    input.outcome.monitorId !== prepared.envelope.monitorId ||
    input.outcome.runId !== prepared.envelope.runId ||
    input.outcome.occurrenceKey !== prepared.envelope.occurrenceKey ||
    !findingMatchesOutcome(input.outcome) ||
    input.outcome.configurationRevision !==
      prepared.envelope.configurationRevision
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  if (input.outcome.finding) {
    await stageWorkspaceAlert({
      finding: input.outcome.finding,
      monitor: prepared.monitor,
      now: input.now,
      presentation: input.alertPresentation,
      scope: prepared.scope,
    }, input.clients?.alert);
  }
  await completeMonitorCheckpoint(prepared, {
    client: input.clients?.monitor,
    now: input.now,
  });
  return input.outcome;
}

export async function finalizePriorWorkspaceRunOutcomeForControlPlane(input: {
  alertPresentation?: { title: string; whyMatched: string };
  clients?: WorkspaceWorkerControlPlaneClients;
  now?: Date;
  outcome: WorkspaceRunOutcome;
  prepared: PreparedWorkspaceWorkerRecovery;
  toolId: string;
}): Promise<{
  outcome: WorkspaceRunOutcome;
  status: "already_completed" | "recovered";
}> {
  const { claimed, scope } = input.prepared;
  const envelope = {
    capabilityRevision: input.prepared.capabilityRevision,
    configurationRevision: claimed.monitor.configurationRevision,
    leaseTokenDigest: claimed.occurrence.leaseTokenDigest,
    monitorId: claimed.monitor.monitorId,
    occurrenceKey: claimed.occurrence.occurrenceKey,
    ownerId: scope.ownerId,
    scheduledFor: claimed.occurrence.scheduledFor,
    sources: claimed.monitor.sources,
    strategyPack: input.prepared.strategyPack,
    workspaceId: scope.workspaceId,
  };
  if (
    input.outcome.ownerId !== scope.ownerId ||
    input.outcome.workspaceId !== scope.workspaceId ||
    input.outcome.monitorId !== envelope.monitorId ||
    input.outcome.occurrenceKey !== envelope.occurrenceKey ||
    !findingMatchesOutcome(input.outcome) ||
    !isDeepStrictEqual(input.outcome.strategyPack, envelope.strategyPack) ||
    input.outcome.configurationRevision !== envelope.configurationRevision
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  if (
    input.prepared.expectedRunId === null
      ? !isPriorWorkspaceRunForRecovery({
          claimedAttempt: claimed.occurrence.attempt,
          claimedOccurrenceKey: claimed.occurrence.occurrenceKey,
          outcomeOccurrenceKey: input.outcome.occurrenceKey,
          outcomeRunId: input.outcome.runId,
        })
      : input.outcome.runId !== input.prepared.expectedRunId ||
        claimed.occurrence.attempt !== 1 ||
        input.prepared.expectedRunId !==
          `${claimed.occurrence.occurrenceKey}:attempt:1`
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  const capabilities = await resolveWorkspaceWorkerCapabilitySnapshot({
    envelope,
    registry: [{
      definition: true,
      metadata: { category: "control_plane", id: input.toolId },
    }],
    scope,
    stateClient: input.clients?.state,
  });
  if (!(input.toolId in capabilities.tools)) {
    throw new WorkspaceWorkerCommitError("workspace_worker_capability_denied");
  }
  const monitor = await assertCurrentMonitor(
    envelope,
    scope,
    input.clients,
  );
  const lease = await inspectWorkspaceMonitorOccurrenceLease({
    configurationRevision: envelope.configurationRevision,
    leaseToken: claimed.leaseToken,
    leaseTokenDigest: envelope.leaseTokenDigest,
    monitorId: envelope.monitorId,
    occurrenceKey: envelope.occurrenceKey,
    scope,
  }, input.clients?.monitor);
  if (lease === "completed") {
    return Object.freeze({ outcome: input.outcome, status: "already_completed" });
  }
  if (lease !== "current") {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  if (input.outcome.finding) {
    await stageWorkspaceAlert({
      finding: input.outcome.finding,
      monitor,
      now: input.now,
      presentation: input.alertPresentation,
      scope,
    }, input.clients?.alert);
  }
  await completeWorkspaceMonitorCheckpoint({
    completedAt: input.now,
    configurationRevision: envelope.configurationRevision,
    contentDigest: input.outcome.checkpoint.contentDigest,
    leaseTokenDigest: envelope.leaseTokenDigest,
    monitorId: envelope.monitorId,
    occurrenceKey: envelope.occurrenceKey,
    scheduledFor: envelope.scheduledFor,
    scope,
    watermark: input.outcome.checkpoint.watermark,
  }, input.clients?.monitor);
  return Object.freeze({ outcome: input.outcome, status: "recovered" });
}

export async function writeWorkspaceFindingForWorker(input: {
  clients?: WorkspaceWorkerControlPlaneClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  finding: WorkspaceFindingCandidate;
  now?: Date;
}): Promise<WorkspaceRunOutcome> {
  const prepared = await prepareCommit({
    clients: input.clients,
    ctx: input.ctx,
    environment: input.environment,
    now: input.now,
    toolId: WRITE_WORKSPACE_FINDING_TOOL_ID,
  });
  if (
    input.finding.accessClassification === "owner_private" &&
    prepared.maximumDataAccessClassification === "public"
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_classification_denied");
  }
  const outcome = await stageWorkspaceFinding({
    coverage: prepared.coverage,
    envelope: prepared.envelope,
    finding: input.finding,
    now: input.now,
    scope: prepared.scope,
  }, input.clients?.finding);
  if (!outcome.finding) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  await stageWorkspaceAlert({
    finding: outcome.finding,
    monitor: prepared.monitor,
    now: input.now,
    scope: prepared.scope,
  }, input.clients?.alert);
  await completeMonitorCheckpoint(prepared, {
    client: input.clients?.monitor,
    now: input.now,
  });
  return outcome;
}

export async function completeWorkspaceRunForWorker(input: {
  clients?: WorkspaceWorkerControlPlaneClients;
  ctx: WorkerContext;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<WorkspaceRunOutcome> {
  const prepared = await prepareCommit({
    clients: input.clients,
    ctx: input.ctx,
    environment: input.environment,
    now: input.now,
    toolId: COMPLETE_WORKSPACE_RUN_TOOL_ID,
  });
  const outcome = await completeWorkspaceRunNoMatch({
    coverage: prepared.coverage,
    envelope: prepared.envelope,
    now: input.now,
    scope: prepared.scope,
  }, input.clients?.finding);
  await completeMonitorCheckpoint(prepared, {
    client: input.clients?.monitor,
    now: input.now,
  });
  return outcome;
}
