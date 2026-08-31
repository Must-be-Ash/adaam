import { z } from "zod";

import { admitsReviewedEarningsCallTranscriptSources } from "./earnings-call-issuer-catalog";

export const PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.public-commentary-legacy/v1";
export const PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.public-commentary-cadence/v1";
export const EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.earnings-call-transcripts/v1";
export const CONGRESSIONAL_HOUSE_DISCLOSURES_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.congressional-house-disclosures/v1";

/*
 * Generic monitor storage and dispatch decide four things a strategy must be
 * able to differ on, and each is a declared property rather than a pack name:
 *
 * - `sourcelessInstall` - whether the pack may install a paused monitor with no
 *   runnable source yet, because its sources are resolved from owner
 *   configuration and may legitimately resolve to none.
 * - `sourceAdmission` - which of the monitor's declared sources make it
 *   eligible to be enabled. The predicate itself stays strategy-owned; only the
 *   decision to apply it is declared here.
 * - `activationWatermark` - whether enabling establishes a "from now on"
 *   boundary instead of replaying source history.
 * - `deferredSourceRetry` - whether a failed occurrence may carry an
 *   occurrence-scoped source retry instead of terminalizing immediately.
 */
const contractSchema = z.object({
  activationWatermark: z.enum(["none", "on_enable"]),
  deferredSourceRetry: z.enum(["none", "occurrence_scoped"]),
  id: z.string().min(3).max(160),
  initialEvaluationWindow: z.enum(["created_at", "preceding_interval"]),
  initialOccurrence: z.enum(["scheduled", "immediate"]),
  sourceAdmission: z.enum(["any_declared_source", "reviewed_transcript_coverage"]),
  sourcelessInstall: z.enum(["allowed", "forbidden"]),
}).strict();

type DeclaredContract = z.infer<typeof contractSchema>;

export type WorkspaceMonitorLifecycleContract = DeclaredContract & {
  readonly admitsActivationSources: (
    sources: readonly { readonly sourceId: string }[],
  ) => boolean;
};

const sourceAdmissionRules: Readonly<
  Record<DeclaredContract["sourceAdmission"], WorkspaceMonitorLifecycleContract["admitsActivationSources"]>
> = Object.freeze({
  any_declared_source: () => true,
  reviewed_transcript_coverage: admitsReviewedEarningsCallTranscriptSources,
});

function defineContract(declaration: unknown): WorkspaceMonitorLifecycleContract {
  const declared = contractSchema.parse(declaration);
  return Object.freeze({
    ...declared,
    admitsActivationSources: sourceAdmissionRules[declared.sourceAdmission],
  });
}

const contracts = new Map<string, WorkspaceMonitorLifecycleContract>([
  defineContract({
    activationWatermark: "on_enable",
    deferredSourceRetry: "none",
    id: PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "created_at",
    initialOccurrence: "immediate",
    sourceAdmission: "any_declared_source",
    sourcelessInstall: "forbidden",
  }),
  defineContract({
    activationWatermark: "on_enable",
    deferredSourceRetry: "none",
    id: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "preceding_interval",
    initialOccurrence: "immediate",
    sourceAdmission: "any_declared_source",
    sourcelessInstall: "forbidden",
  }),
  defineContract({
    activationWatermark: "on_enable",
    deferredSourceRetry: "occurrence_scoped",
    id: EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "created_at",
    initialOccurrence: "scheduled",
    sourceAdmission: "reviewed_transcript_coverage",
    sourcelessInstall: "allowed",
  }),
  /*
   * House's bounded acquisitions may need several source attempts before a
   * complete baseline exists. Reuse occurrence-scoped source retry without
   * changing its activation, source admission, or historical-alert boundary.
   * Legacy pack bindings receive this same runtime retry safety below.
   */
  defineContract({
    activationWatermark: "none",
    deferredSourceRetry: "occurrence_scoped",
    id: CONGRESSIONAL_HOUSE_DISCLOSURES_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "created_at",
    initialOccurrence: "scheduled",
    sourceAdmission: "any_declared_source",
    sourcelessInstall: "forbidden",
  }),
].map((contract) => [contract.id, contract]));

const legacyBindings = new Map<string, string>([
  ...["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((version): [string, string] =>
    [`congressional-signals@${version}/evaluate-house-ptrs`, CONGRESSIONAL_HOUSE_DISCLOSURES_MONITOR_LIFECYCLE_CONTRACT_ID]),
  ["inverse-cramer@1.0.0/evaluate-public-commentary", PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.1.0/evaluate-public-commentary", PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.2.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.3.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["public-commentary-tracker@1.0.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["public-commentary-tracker@1.1.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["earnings-call-changes@1.0.0/compare-earnings-calls", EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["earnings-call-changes@1.0.1/compare-earnings-calls", EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID],
]);

export function resolveWorkspaceMonitorLifecycleContract(
  contractId: string | null | undefined,
): WorkspaceMonitorLifecycleContract | null {
  return contractId ? contracts.get(contractId) ?? null : null;
}

export function resolveManagedMonitorLifecycleContract(input: Readonly<{
  lifecycleContractId?: string | null;
  managedBy?: Readonly<{
    packId: string;
    packVersion: string;
    resourceId: string;
  }> | null;
}>): WorkspaceMonitorLifecycleContract | null {
  const declared = resolveWorkspaceMonitorLifecycleContract(input.lifecycleContractId);
  if (declared) return declared;
  const managed = input.managedBy;
  if (!managed) return null;
  return resolveWorkspaceMonitorLifecycleContract(
    legacyBindings.get(`${managed.packId}@${managed.packVersion}/${managed.resourceId}`),
  );
}
