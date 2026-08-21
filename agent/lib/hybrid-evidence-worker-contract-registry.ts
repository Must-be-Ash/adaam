import {
  COMMENTARY_SEMANTIC_DEFINITION_ID,
  commentarySemanticWorkerCandidateSchema,
} from "./public-commentary-semantics";
import {
  SEC_IPO_RESEARCH_DEFINITION_ID,
  secIpoResearchWorkerCandidateSchema,
} from "./sec-ipo-semantics";
import {
  createHybridEvidenceWorkerContractRegistry,
  type HybridEvidenceWorkerContract,
} from "./hybrid-evidence-worker-contract";

const contracts = Object.freeze([
  Object.freeze({
    capabilityRevisions: Object.freeze([1, 2]),
    completion: Object.freeze({
      description:
        "Commit one public-commentary candidate using the exact registered semantic contract.",
      inputSchema: commentarySemanticWorkerCandidateSchema,
    }),
    definitionId: COMMENTARY_SEMANTIC_DEFINITION_ID,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one IPO executive brief using the exact registered semantic contract.",
      inputSchema: secIpoResearchWorkerCandidateSchema,
    }),
    definitionId: SEC_IPO_RESEARCH_DEFINITION_ID,
    research: Object.freeze({
      approvedUrlPolicy: "evidence_sources" as const,
      requiresParentRunId: true as const,
    }),
  }),
] satisfies readonly HybridEvidenceWorkerContract[]);

export const hybridEvidenceWorkerContractRegistry =
  createHybridEvidenceWorkerContractRegistry(contracts);

export function resolveHybridEvidenceWorkerContract(
  definitionId: string,
): HybridEvidenceWorkerContract | null {
  return hybridEvidenceWorkerContractRegistry.resolve(definitionId);
}
