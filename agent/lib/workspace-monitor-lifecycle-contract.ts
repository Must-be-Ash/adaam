import { z } from "zod";

export const PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.public-commentary-legacy/v1";
export const PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID =
  "monitor.public-commentary-cadence/v1";

const contractSchema = z.object({
  activationWatermark: z.enum(["none", "on_enable"]),
  id: z.string().min(3).max(160),
  initialEvaluationWindow: z.enum(["created_at", "preceding_interval"]),
  initialOccurrence: z.enum(["scheduled", "immediate"]),
}).strict();

export type WorkspaceMonitorLifecycleContract = z.infer<typeof contractSchema>;

const contracts = new Map<string, WorkspaceMonitorLifecycleContract>([
  contractSchema.parse({
    activationWatermark: "on_enable",
    id: PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "created_at",
    initialOccurrence: "immediate",
  }),
  contractSchema.parse({
    activationWatermark: "on_enable",
    id: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    initialEvaluationWindow: "preceding_interval",
    initialOccurrence: "immediate",
  }),
].map((contract) => [contract.id, Object.freeze(contract)]));

const legacyBindings = new Map<string, string>([
  ["inverse-cramer@1.0.0/evaluate-public-commentary", PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.1.0/evaluate-public-commentary", PUBLIC_COMMENTARY_LEGACY_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.2.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["inverse-cramer@1.3.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["public-commentary-tracker@1.0.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
  ["public-commentary-tracker@1.1.0/evaluate-public-commentary", PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID],
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
