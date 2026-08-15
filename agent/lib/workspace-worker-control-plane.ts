import type { SessionContext } from "eve/context";

import {
  completeWorkspaceRunNoMatch,
  stageWorkspaceFinding,
  type WorkspaceFindingCandidate,
  type WorkspaceFindingStoreClient,
  type WorkspaceRunOutcome,
} from "./workspace-finding-store";
import {
  completeWorkspaceMonitorCheckpoint,
  getWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "./workspace-monitor-store";
import {
  completeWorkspaceSourceCoverage,
  readWorkspaceSourceCoverage,
  type WorkspaceSourceCoverageClient,
} from "./workspace-source-coverage";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";
import type { PreparedWorkspaceWorkerRun } from "./workspace-worker-runner";
import {
  stageWorkspaceAlert,
  type WorkspaceAlertStoreClient,
} from "./workspace-alert-store";
import { authorizeWorkspaceWorkerStore } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth, type WorkspaceWorkerEnvelope } from "./workspace-worker-auth";
import { resolveWorkspaceWorkerCapabilitySnapshot } from "./workspace-worker-capabilities";

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

function sameSources(
  monitor: WorkspaceMonitor,
  envelope: WorkspaceWorkerEnvelope,
): boolean {
  return JSON.stringify(monitor.sources) === JSON.stringify(envelope.sources);
}

async function assertCurrentMonitor(
  envelope: WorkspaceWorkerEnvelope,
  scope: ReturnType<typeof authorizeWorkspaceWorkerStore>,
  client?: WorkspaceMonitorStoreClient,
): Promise<WorkspaceMonitor> {
  const monitor = await getWorkspaceMonitor(scope, envelope.monitorId, client);
  if (
    !monitor ||
    monitor.lifecycleState !== "enabled" ||
    monitor.configurationRevision !== envelope.configurationRevision ||
    !sameSources(monitor, envelope)
  ) {
    throw new WorkspaceWorkerCommitError("workspace_worker_run_stale");
  }
  return monitor;
}

async function prepareCommit(input: {
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
  const monitor = await assertCurrentMonitor(envelope, scope, input.clients?.monitor);
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
      checkpoint: input.checkpoint,
      now: input.now,
      runId: envelope.runId,
      scope,
    },
    input.clients?.sourceCoverage,
  );
  await assertCurrentMonitor(envelope, scope, input.clients?.monitor);
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
  now?: Date;
  toolId: string;
}): Promise<WorkspaceRunOutcome> {
  const prepared = await prepareCommit({
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
  prepared: PreparedWorkspaceWorkerRun;
  toolId: string;
}): Promise<WorkspaceRunOutcome> {
  const { envelope, scope } = input.prepared;
  if (
    input.outcome.ownerId !== scope.ownerId ||
    input.outcome.workspaceId !== scope.workspaceId ||
    input.outcome.monitorId !== envelope.monitorId ||
    input.outcome.occurrenceKey !== envelope.occurrenceKey ||
    input.outcome.configurationRevision !== envelope.configurationRevision
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
    input.clients?.monitor,
  );
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
  return input.outcome;
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
