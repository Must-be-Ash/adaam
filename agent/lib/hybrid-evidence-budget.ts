import {
  authorizeDeploymentWorkspaceStore,
  type AuthorizedWorkspaceStoreScope,
} from "./workspace-store-authorization";
import { randomUUID } from "node:crypto";
import { claimHybridEvidenceJobAdmission, resetHybridEvidenceJobAdmission,
  readHybridEvidenceJob, pruneCompletedHybridEvidenceAdmissions, HybridEvidenceJobStoreError,
  type HybridEvidenceJobRecord, type HybridEvidenceJobStoreClient,
  type HybridEvidenceAttemptReceipt } from "./hybrid-evidence-job-store";
import {
  reconcileWorkspaceRunBudget,
  readWorkspaceBudgetLedger,
  reserveWorkspaceRunBudget,
  WorkspaceBudgetError,
  type WorkspaceBudgetLedgerClient,
  type WorkspaceBudgetReservation,
} from "./workspace-budget-ledger";
import {
  reconcileHybridEvidenceDeploymentBudget,
  readGlobalDispatchBudgetLedger,
  resolveHybridEvidenceDeploymentBudgetLimits,
  reserveHybridEvidenceDeploymentBudget,
  WorkspaceDispatchBudgetError,
  type GlobalDispatchReservation,
  type WorkspaceGlobalBudgetClient,
} from "./workspace-dispatch-budget";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type {
  HybridEvidenceJob,
  HybridEvidenceJobDefinition,
} from "./hybrid-evidence-schema";

export type HybridEvidenceBudgetReservation =
  | Readonly<{
      lane: "source_global_extraction";
      reservation: GlobalDispatchReservation;
      reservationKey: string;
      workspace: Readonly<{
        reservation: WorkspaceBudgetReservation;
        scope: AuthorizedWorkspaceStoreScope;
      }> | null;
    }>
  | Readonly<{
      lane: "workspace_semantic";
      parentRunId: string | null;
      reservation: WorkspaceBudgetReservation;
      reservationKey: string;
      scope: AuthorizedWorkspaceStoreScope;
    }>;

export class HybridEvidenceBudgetError extends Error {
  constructor(readonly code:
    | "budget_policy_unresolved"
    | "job_not_dispatchable"
    | "model_denied"
    | "workspace_scope_mismatch") {
    super(code);
    this.name = "HybridEvidenceBudgetError";
  }
}

export function createHybridEvidenceAttemptReceipt(
  reservation: HybridEvidenceBudgetReservation,
): HybridEvidenceAttemptReceipt {
  const scope = reservation.lane === "source_global_extraction"
    ? reservation.workspace?.scope
    : reservation.scope;
  return Object.freeze({
    lane: reservation.lane,
    reservationKey: reservation.reservationKey,
    workspace: scope ? Object.freeze({ ownerId: scope.ownerId, workspaceId: scope.workspaceId }) : null,
  });
}

/** Restore only a durable trusted scope, and re-authorize it against this deployment. */
export async function reconcileRecordedHybridEvidenceAttempt(input: {
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualPaidCost?: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
  outcome: "reconciled" | "uncertain";
  receipt: HybridEvidenceAttemptReceipt;
}, clients: {
  global?: WorkspaceGlobalBudgetClient;
  workspace?: WorkspaceBudgetLedgerClient;
} = {}): Promise<void> {
  const scope = input.receipt.workspace
    ? authorizeDeploymentWorkspaceStore(input.receipt.workspace, input.environment)
    : null;
  if (input.receipt.lane === "workspace_semantic" && !scope) {
    throw new HybridEvidenceBudgetError("workspace_scope_mismatch");
  }
  await Promise.all([
    scope ? reconcileWorkspaceRunBudget({
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      actualPaidCost: input.actualPaidCost,
      now: input.now,
      outcome: input.outcome,
      runId: input.receipt.reservationKey,
      scope,
    }, clients.workspace) : Promise.resolve(),
    input.receipt.lane === "source_global_extraction"
      ? reconcileHybridEvidenceDeploymentBudget({
        actualInputTokens: input.actualInputTokens,
        actualOutputTokens: input.actualOutputTokens,
        actualPaidCost: input.actualPaidCost,
        now: input.now,
        outcome: input.outcome,
        reservationKey: input.receipt.reservationKey,
      }, clients.global) : Promise.resolve(),
  ]);
}

function paidMicrosToDecimal(value: string): string {
  const micros = BigInt(value);
  return `${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, "0")}`;
}

/** A cancelled pre-dispatch lease can never run a model. Repair partial admission too. */
export async function releaseCancelledHybridEvidenceAdmissions(input: {
  record: HybridEvidenceJobRecord;
  environment?: NodeJS.ProcessEnv;
}, clients: { jobs?: HybridEvidenceJobStoreClient; global?: WorkspaceGlobalBudgetClient; workspace?: WorkspaceBudgetLedgerClient } = {}) {
  const repaired: string[] = [];
  for (const receipt of input.record.cancelledAdmissions) {
    const global = (await readGlobalDispatchBudgetLedger(clients.global)).reservations.find(({ runId }) => runId === receipt.reservationKey);
    if (global && (global.state === "reserved" || global.state === "uncertain")) {
      await reconcileHybridEvidenceDeploymentBudget({ reservationKey: receipt.reservationKey, outcome: "released" }, clients.global);
    }
    if (receipt.workspace) {
      const scope = authorizeDeploymentWorkspaceStore(receipt.workspace, input.environment);
      const workspace = (await readWorkspaceBudgetLedger(scope, clients.workspace)).reservations.find(({ runId }) => runId === receipt.reservationKey);
      if (workspace && (workspace.state === "reserved" || workspace.state === "uncertain")) {
        await reconcileWorkspaceRunBudget({ runId: receipt.reservationKey, scope, outcome: "released" }, clients.workspace);
      }
    }
    // Absence is conclusive only after the owner positively finished its
    // writes. An expired owner or lost storage acknowledgement may write late.
    if (receipt.cancellationCompleted) repaired.push(receipt.reservationKey);
  }
  if (repaired.length) await pruneCompletedHybridEvidenceAdmissions({ jobId: input.record.job.jobId, reservationKeys: repaired }, clients.jobs);
}

export async function reserveAdmittedHybridEvidenceAttempt(input: Parameters<typeof reserveHybridEvidenceAttempt>[0] & {
  record: HybridEvidenceJobRecord;
  initiatingWorkspaceId: string;
}, clients: NonNullable<Parameters<typeof reserveHybridEvidenceAttempt>[1]> & { jobs?: HybridEvidenceJobStoreClient } = {}) {
  const current = await readHybridEvidenceJob(input.record.job.jobId, clients.jobs);
  if (current) await releaseCancelledHybridEvidenceAdmissions({ record: current, environment: input.environment }, clients);
  const admissionToken = randomUUID();
  const record = await claimHybridEvidenceJobAdmission({
    jobId: input.record.job.jobId, token: admissionToken, initiatingWorkspaceId: input.initiatingWorkspaceId,
    workspace: input.scope && input.parentRunId ? { ownerId: input.scope.ownerId, workspaceId: input.scope.workspaceId } : null,
  }, clients.jobs);
  let reservationCompleted = false;
  try {
    await releaseCancelledHybridEvidenceAdmissions({ record, environment: input.environment }, clients);
    const reservation = await reserveHybridEvidenceAttempt({ ...input, job: record.job }, clients);
    reservationCompleted = true;
    const owned = await readHybridEvidenceJob(record.job.jobId, clients.jobs);
    if (owned?.admission?.tokenDigest !== record.admission!.tokenDigest ||
      Date.parse(owned.admission.expiresAt) <= Date.now()) throw new HybridEvidenceBudgetError("job_not_dispatchable");
    return { admissionToken, record, reservation };
  } catch (error) {
    // Typed policy denials occur before any unacknowledged write. Generic
    // transport/CAS failures are ambiguous even if a ledger currently looks empty.
    const ownerCompleted = reservationCompleted || error instanceof HybridEvidenceBudgetError ||
      (error instanceof WorkspaceBudgetError && ["budget_exhausted", "budget_policy_stale", "budget_policy_unresolved"].includes(error.code)) ||
      (error instanceof WorkspaceDispatchBudgetError && error.code === "global_budget_exhausted");
    let cancelled: HybridEvidenceJobRecord;
    try {
      cancelled = await resetHybridEvidenceJobAdmission({ admissionToken, ownerCompleted,
        jobId: record.job.jobId, reservationKey: record.job.budgetReservation.key }, clients.jobs);
    } catch (resetError) {
      if (!(resetError instanceof HybridEvidenceJobStoreError) || resetError.code !== "job_conflict") throw resetError;
      // A successor fenced this owner while a ledger write was in flight.
      // Repair the old receipt without resetting/releasing the successor.
      cancelled = (await readHybridEvidenceJob(record.job.jobId, clients.jobs))!;
      if (!cancelled) throw resetError;
    }
    await releaseCancelledHybridEvidenceAdmissions({ record: cancelled, environment: input.environment }, clients);
    throw error;
  }
}

export async function assertRecordedHybridEvidenceBudgetActive(input: {
  receipt: HybridEvidenceAttemptReceipt | null;
  environment?: NodeJS.ProcessEnv;
}, clients: { global?: WorkspaceGlobalBudgetClient; workspace?: WorkspaceBudgetLedgerClient } = {}) {
  if (!input.receipt) throw new HybridEvidenceBudgetError("job_not_dispatchable");
  const { receipt } = input;
  const global = (await readGlobalDispatchBudgetLedger(clients.global)).reservations.find(({ runId }) => runId === receipt.reservationKey);
  // Unknown work still holds its full allowance; settled or released work does not.
  if (!global || !["reserved", "uncertain"].includes(global.state)) throw new HybridEvidenceBudgetError("job_not_dispatchable");
  if (receipt.workspace) {
    const scope = authorizeDeploymentWorkspaceStore(receipt.workspace, input.environment);
    const workspace = (await readWorkspaceBudgetLedger(scope, clients.workspace)).reservations.find(({ runId }) => runId === receipt.reservationKey);
    if (!workspace || !["reserved", "uncertain"].includes(workspace.state)) throw new HybridEvidenceBudgetError("job_not_dispatchable");
  }
}

export async function reserveHybridEvidenceAttempt(input: {
  aggregateLimits?: { inputTokens: number; outputTokens: number };
  definition: HybridEvidenceJobDefinition;
  environment?: NodeJS.ProcessEnv;
  job: HybridEvidenceJob;
  now?: Date;
  parentRunId?: string;
  scope?: AuthorizedWorkspaceStoreScope;
}, clients: {
  global?: WorkspaceGlobalBudgetClient;
  state?: WorkspaceStateStoreClient;
  workspace?: WorkspaceBudgetLedgerClient;
} = {}): Promise<HybridEvidenceBudgetReservation> {
  if (input.aggregateLimits && (!Number.isSafeInteger(input.aggregateLimits.inputTokens) ||
    !Number.isSafeInteger(input.aggregateLimits.outputTokens) ||
    input.aggregateLimits.inputTokens < input.definition.limits.maximumInputTokens ||
    input.aggregateLimits.outputTokens < input.definition.limits.maximumOutputTokens ||
    input.aggregateLimits.inputTokens > 200_000 || input.aggregateLimits.outputTokens > 52_000)) {
    throw new HybridEvidenceBudgetError("budget_policy_unresolved");
  }
  if (!(["prepared", "running"] as const).includes(input.job.state as "prepared" | "running")) {
    throw new HybridEvidenceBudgetError("job_not_dispatchable");
  }
  if (
    input.job.definitionDigest !== input.definition.definitionDigest ||
    input.job.modelId === "" ||
    !input.definition.allowedModelIds.includes(input.job.modelId)
  ) throw new HybridEvidenceBudgetError("model_denied");

  if (input.job.scope.kind === "source_global") {
    if (input.scope && input.scope.workspaceId !== input.job.scope.initiatingWorkspaceId) {
      throw new HybridEvidenceBudgetError("workspace_scope_mismatch");
    }
    const reservation = await reserveHybridEvidenceDeploymentBudget({
      inputTokens: input.aggregateLimits?.inputTokens ?? input.definition.limits.maximumInputTokens,
      modelId: input.job.modelId,
      now: input.now,
      outputTokens: input.aggregateLimits?.outputTokens ?? input.definition.limits.maximumOutputTokens,
      paidCostCeiling: input.definition.limits.maximumPaidCostUsd,
      reservationKey: input.job.budgetReservation.key,
    }, { client: clients.global, environment: input.environment });
    let workspace: Extract<HybridEvidenceBudgetReservation, {
      lane: "source_global_extraction";
    }>["workspace"] = null;
    if (input.scope && input.parentRunId) {
      try {
        const budget = await readWorkspaceDocument("budget", input.scope, clients.state);
        if (!budget) throw new HybridEvidenceBudgetError("budget_policy_unresolved");
        const deployment = resolveHybridEvidenceDeploymentBudgetLimits(input.environment);
        const workspaceReservation = await reserveWorkspaceRunBudget({
          deploymentPaidCaps: {
            maximumPaidPerCall: paidMicrosToDecimal(deployment.maximumPaidMicrosPerCall),
            maximumPaidPerDay: paidMicrosToDecimal(deployment.maximumPaidMicrosPerDay),
            maximumPaidPerMonth: paidMicrosToDecimal(deployment.maximumPaidMicrosPerMonth),
          },
          inputTokens: input.aggregateLimits?.inputTokens ?? input.definition.limits.maximumInputTokens,
          kind: "hybrid_model_attempt",
          now: input.now,
          outputTokens: input.aggregateLimits?.outputTokens ?? input.definition.limits.maximumOutputTokens,
          paidCostCeiling: { amount: input.definition.limits.maximumPaidCostUsd, kind: "known" },
          parentRunId: input.parentRunId,
          policy: budget.value,
          policyRevision: budget.revision,
          runId: input.job.budgetReservation.key,
          scope: input.scope,
        }, clients.workspace);
        workspace = Object.freeze({ reservation: workspaceReservation, scope: input.scope });
      } catch (error) {
        await reconcileHybridEvidenceDeploymentBudget({
          now: input.now,
          outcome: "released",
          reservationKey: input.job.budgetReservation.key,
        }, clients.global);
        throw error;
      }
    }
    return Object.freeze({
      lane: "source_global_extraction" as const,
      reservation,
      reservationKey: input.job.budgetReservation.key,
      workspace,
    });
  }

  if (
    !input.scope ||
    input.scope.ownerId !== input.job.scope.ownerId ||
    input.scope.workspaceId !== input.job.scope.workspaceId
  ) throw new HybridEvidenceBudgetError("workspace_scope_mismatch");
  const [budget, capabilities] = await Promise.all([
    readWorkspaceDocument("budget", input.scope, clients.state),
    readWorkspaceDocument("capabilities", input.scope, clients.state),
  ]);
  if (!budget || !capabilities) {
    throw new HybridEvidenceBudgetError("budget_policy_unresolved");
  }
  if (!capabilities.value.workerModelPolicy.allowedModelIds.includes(input.job.modelId)) {
    throw new HybridEvidenceBudgetError("model_denied");
  }
  const reservation = await reserveWorkspaceRunBudget({
    inputTokens: input.definition.limits.maximumInputTokens,
    kind: "hybrid_model_attempt",
    now: input.now,
    outputTokens: Math.min(
      input.definition.limits.maximumOutputTokens,
      capabilities.value.workerModelPolicy.maximumOutputTokens,
    ),
    paidCostCeiling: { amount: input.definition.limits.maximumPaidCostUsd, kind: "known" },
    parentRunId: input.parentRunId,
    policy: budget.value,
    policyRevision: budget.revision,
    runId: input.job.budgetReservation.key,
    scope: input.scope,
  }, clients.workspace);
  return Object.freeze({
    lane: "workspace_semantic" as const,
    parentRunId: input.parentRunId ?? null,
    reservation,
    reservationKey: input.job.budgetReservation.key,
    scope: input.scope,
  });
}

export async function reconcileHybridEvidenceAttempt(input: {
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualPaidCost?: string;
  now?: Date;
  outcome: "reconciled" | "released" | "uncertain";
  reservation: HybridEvidenceBudgetReservation;
}, clients: {
  global?: WorkspaceGlobalBudgetClient;
  workspace?: WorkspaceBudgetLedgerClient;
} = {}): Promise<void> {
  if (input.reservation.lane === "source_global_extraction") {
    const workspaceReconciliation = input.reservation.workspace
      ? reconcileWorkspaceRunBudget({
        actualInputTokens: input.actualInputTokens,
        actualOutputTokens: input.actualOutputTokens,
        actualPaidCost: input.actualPaidCost,
        now: input.now,
        outcome: input.outcome,
        runId: input.reservation.reservationKey,
        scope: input.reservation.workspace.scope,
      }, clients.workspace)
      : Promise.resolve();
    await Promise.all([workspaceReconciliation, reconcileHybridEvidenceDeploymentBudget({
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      actualPaidCost: input.actualPaidCost,
      now: input.now,
      outcome: input.outcome,
      reservationKey: input.reservation.reservationKey,
    }, clients.global)]);
    return;
  }
  await reconcileWorkspaceRunBudget({
    actualInputTokens: input.actualInputTokens,
    actualOutputTokens: input.actualOutputTokens,
    actualPaidCost: input.actualPaidCost,
    now: input.now,
    outcome: input.outcome,
    runId: input.reservation.reservationKey,
    scope: input.reservation.scope,
  }, clients.workspace);
}
