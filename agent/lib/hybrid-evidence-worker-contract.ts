import type { ZodType } from "zod";

export interface HybridEvidenceWorkerContract {
  readonly capabilityRevisions: readonly number[];
  readonly completion: Readonly<{
    description: string;
    inputSchema: ZodType;
  }>;
  readonly definitionId: string;
  readonly research: Readonly<{
    approvedUrlPolicy: "evidence_sources";
    budget: Readonly<{
      maximumPaidPerCall: string;
      maximumPaidPerDay: string;
      maximumPaidPerMonth: string;
      paidPerRun: string;
      unknownPriceFallbackCeiling: string;
    }>;
    requiresParentRunId: true;
  }> | null;
}

export interface HybridEvidenceWorkerContractRegistry {
  resolve(definitionId: string): HybridEvidenceWorkerContract | null;
}

export function createHybridEvidenceWorkerContractRegistry(
  contracts: readonly HybridEvidenceWorkerContract[],
): HybridEvidenceWorkerContractRegistry {
  const registered = new Map<string, HybridEvidenceWorkerContract>();
  for (const contract of contracts) {
    if (
      registered.has(contract.definitionId) ||
      contract.definitionId.length < 3 ||
      contract.definitionId.length > 200 ||
      contract.capabilityRevisions.length === 0 ||
      new Set(contract.capabilityRevisions).size !== contract.capabilityRevisions.length ||
      contract.capabilityRevisions.some((revision) =>
        !Number.isSafeInteger(revision) || revision <= 0
      ) ||
      contract.completion.description.trim().length === 0
    ) {
      throw new Error("hybrid_evidence_worker_contract_conflict");
    }
    registered.set(contract.definitionId, Object.freeze(contract));
  }
  return Object.freeze({
    resolve(definitionId: string) {
      return registered.get(definitionId) ?? null;
    },
  });
}
