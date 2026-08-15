import { z } from "zod";

export const WORKSPACE_RUNTIME_ERROR_CODES = [
  "owner_unmapped",
  "owner_scope_mismatch",
  "workspace_scope_mismatch",
  "workspace_unavailable",
  "ingress_duplicate",
  "assignment_immutable",
  "dispatch_duplicate",
  "dispatch_uncertain",
  "response_delivery_uncertain",
  "workspace_archived",
  "explicit_resume_required",
  "stale_generation",
  "stale_configuration",
  "capability_denied",
  "capability_drift",
  "runtime_restricted",
  "run_budget_exhausted",
  "token_budget_exhausted",
  "paid_budget_exhausted",
  "paid_charge_uncertain",
  "source_out_of_scope",
  "incomplete_source_coverage",
  "source_payload_invalid",
  "alert_delivery_duplicate",
  "alert_delivery_uncertain",
  "routing_confirmation_required",
  "routing_action_stale",
  "storage_unavailable",
  "lease_conflict",
  "evaluation_failed",
  "schedule_job_failed",
] as const;

export type WorkspaceRuntimeErrorCode =
  (typeof WORKSPACE_RUNTIME_ERROR_CODES)[number];

export const WORKSPACE_RUNTIME_COUNTERS = [
  "workspace_monitor_claimed_total",
  "workspace_monitor_started_total",
  "workspace_monitor_completed_total",
  "workspace_monitor_no_match_total",
  "workspace_monitor_retryable_failure_total",
  "workspace_monitor_terminal_failure_total",
  "workspace_monitor_budget_deferred_total",
  "workspace_alert_delivered_total",
  "workspace_alert_uncertain_total",
  "workspace_ingress_deduplicated_total",
  "workspace_dispatch_quarantined_total",
  "workspace_response_delivery_quarantined_total",
  "workspace_routing_confirmation_total",
] as const;

export type WorkspaceRuntimeCounter =
  (typeof WORKSPACE_RUNTIME_COUNTERS)[number];

export const WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES = [
  "candidate_selected",
  "selected_retained",
  "action_stale",
  "expired",
] as const;

export type WorkspaceRoutingConfirmationOutcome =
  (typeof WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES)[number];

const errorCodeSchema = z.enum(WORKSPACE_RUNTIME_ERROR_CODES);
const counterSchema = z.enum(WORKSPACE_RUNTIME_COUNTERS);
const routingOutcomeSchema = z.enum(WORKSPACE_ROUTING_CONFIRMATION_OUTCOMES);

export const workspaceRuntimeObservationSchema = z
  .object({
    counter: counterSchema,
    errorCode: errorCodeSchema.optional(),
    outcome: routingOutcomeSchema.optional(),
    value: z.number().int().positive().max(1_000).default(1),
  })
  .strict()
  .superRefine((observation, context) => {
    const isRoutingConfirmation =
      observation.counter === "workspace_routing_confirmation_total";
    if (isRoutingConfirmation !== (observation.outcome !== undefined)) {
      context.addIssue({
        code: "custom",
        message:
          "Only routing-confirmation observations require a fixed outcome.",
        path: ["outcome"],
      });
    }
  });

export type WorkspaceRuntimeObservation = z.infer<
  typeof workspaceRuntimeObservationSchema
>;

export type WorkspaceRuntimeObservationSink = (
  observation: WorkspaceRuntimeObservation,
) => void;

const errorCodeAliases: Readonly<Record<string, WorkspaceRuntimeErrorCode>> =
  Object.freeze({
    budget_exhausted: "run_budget_exhausted",
    budget_ledger_corrupt: "storage_unavailable",
    budget_policy_stale: "stale_configuration",
    budget_policy_unresolved: "storage_unavailable",
    budget_reservation_conflict: "lease_conflict",
    global_budget_conflict: "lease_conflict",
    global_budget_exhausted: "run_budget_exhausted",
    global_budget_invalid: "storage_unavailable",
    workspace_budget_missing: "storage_unavailable",
    workspace_worker_capability_denied: "capability_denied",
    workspace_worker_model_denied: "runtime_restricted",
    workspace_worker_run_stale: "stale_configuration",
    workspace_worker_state_missing: "workspace_unavailable",
    workspace_worker_state_stale: "stale_configuration",
  });

function errorCandidate(error: unknown): string | null {
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = Reflect.get(error, "code");
      if (typeof code === "string") return code;
    }
    return error instanceof Error ? error.message : null;
  } catch {
    return null;
  }
}

export function parseWorkspaceRuntimeObservation(
  value: unknown,
): WorkspaceRuntimeObservation {
  return workspaceRuntimeObservationSchema.parse(value);
}

export function safeWorkspaceRuntimeErrorCode(
  error: unknown,
  fallback: WorkspaceRuntimeErrorCode,
): WorkspaceRuntimeErrorCode {
  const candidate = errorCandidate(error);
  if (candidate) {
    const parsed = errorCodeSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return candidate ? (errorCodeAliases[candidate] ?? fallback) : fallback;
}

const consoleWorkspaceRuntimeObservationSink:
  WorkspaceRuntimeObservationSink = (observation) => {
    const write = observation.errorCode ? console.warn : console.info;
    write("[workspace.runtime]", observation);
  };

export function emitWorkspaceRuntimeObservation(
  value: unknown,
  sink: WorkspaceRuntimeObservationSink =
    consoleWorkspaceRuntimeObservationSink,
): void {
  sink(Object.freeze(parseWorkspaceRuntimeObservation(value)));
}
