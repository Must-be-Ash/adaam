import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import {
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
  type WorkspaceBudgetReservation,
} from "./workspace-budget-ledger";
import {
  reconcileHybridEvidenceDeploymentBudget,
  reserveHybridEvidenceDeploymentBudget,
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
    }>
  | Readonly<{
      lane: "workspace_semantic";
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

export async function reserveHybridEvidenceAttempt(input: {
  definition: HybridEvidenceJobDefinition;
  environment?: NodeJS.ProcessEnv;
  job: HybridEvidenceJob;
  now?: Date;
  scope?: AuthorizedWorkspaceStoreScope;
}, clients: {
  global?: WorkspaceGlobalBudgetClient;
  state?: WorkspaceStateStoreClient;
  workspace?: WorkspaceBudgetLedgerClient;
} = {}): Promise<HybridEvidenceBudgetReservation> {
  if (!(["prepared", "running"] as const).includes(input.job.state as "prepared" | "running")) {
    throw new HybridEvidenceBudgetError("job_not_dispatchable");
  }
  if (
    input.job.definitionDigest !== input.definition.definitionDigest ||
    input.job.modelId === "" ||
    !input.definition.allowedModelIds.includes(input.job.modelId)
  ) throw new HybridEvidenceBudgetError("model_denied");

  if (input.job.scope.kind === "source_global") {
    const reservation = await reserveHybridEvidenceDeploymentBudget({
      inputTokens: input.definition.limits.maximumInputTokens,
      modelId: input.job.modelId,
      now: input.now,
      outputTokens: input.definition.limits.maximumOutputTokens,
      paidCostCeiling: input.definition.limits.maximumPaidCostUsd,
      reservationKey: input.job.budgetReservation.key,
    }, { client: clients.global, environment: input.environment });
    return Object.freeze({
      lane: "source_global_extraction" as const,
      reservation,
      reservationKey: input.job.budgetReservation.key,
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
    policy: budget.value,
    policyRevision: budget.revision,
    runId: input.job.budgetReservation.key,
    scope: input.scope,
  }, clients.workspace);
  return Object.freeze({
    lane: "workspace_semantic" as const,
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
    await reconcileHybridEvidenceDeploymentBudget({
      actualInputTokens: input.actualInputTokens,
      actualOutputTokens: input.actualOutputTokens,
      actualPaidCost: input.actualPaidCost,
      now: input.now,
      outcome: input.outcome,
      reservationKey: input.reservation.reservationKey,
    }, clients.global);
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
