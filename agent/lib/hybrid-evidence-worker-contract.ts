import type { ZodType } from "zod";

import type { EvidenceLocator } from "./hybrid-evidence-schema";

export interface HybridEvidenceWorkerContract {
  readonly capabilityRevisions: readonly number[];
  readonly completion: Readonly<{
    description: string;
    inputSchema: ZodType;
  }>;
  readonly definitionId: string;
  readonly definitionDigests?: readonly string[];
  readonly materializeCandidate?: (input: {
    readonly allowedLocators: readonly EvidenceLocator[];
    readonly candidate: unknown;
  }) => unknown;
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
  resolve(definitionId: string, definitionDigest?: string): HybridEvidenceWorkerContract | null;
}

export function createHybridEvidenceWorkerContractRegistry(
  contracts: readonly HybridEvidenceWorkerContract[],
): HybridEvidenceWorkerContractRegistry {
  const defaults = new Map<string, HybridEvidenceWorkerContract>();
  const digestScopedIds = new Set<string>();
  const registered = new Map<string, HybridEvidenceWorkerContract>();
  for (const contract of contracts) {
    const definitionDigests = contract.definitionDigests ?? [];
    if (
      (definitionDigests.length === 0 && defaults.has(contract.definitionId)) ||
      contract.definitionId.length < 3 ||
      contract.definitionId.length > 200 ||
      contract.capabilityRevisions.length === 0 ||
      new Set(contract.capabilityRevisions).size !== contract.capabilityRevisions.length ||
      contract.capabilityRevisions.some((revision) =>
        !Number.isSafeInteger(revision) || revision <= 0
      ) ||
      contract.completion.description.trim().length === 0 ||
      definitionDigests.some((digest) => registered.has(`${contract.definitionId}\0${digest}`))
    ) {
      throw new Error("hybrid_evidence_worker_contract_conflict");
    }
    if (definitionDigests.length === 0) defaults.set(contract.definitionId, Object.freeze(contract));
    for (const digest of definitionDigests) {
      digestScopedIds.add(contract.definitionId);
      registered.set(`${contract.definitionId}\0${digest}`, Object.freeze(contract));
    }
  }
  return Object.freeze({
    resolve(definitionId: string, definitionDigest?: string) {
      if (definitionDigest && digestScopedIds.has(definitionId)) {
        return registered.get(`${definitionId}\0${definitionDigest}`) ?? null;
      }
      return defaults.get(definitionId) ?? null;
    },
  });
}
