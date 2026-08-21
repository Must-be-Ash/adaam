import {
  COMMENTARY_SEMANTIC_DEFINITION_ID,
  commentarySemanticWorkerCandidateSchema,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  inverseCramerActionabilityWorkerCandidateSchema,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
  inverseCramerSemanticWorkerCandidateSchema,
} from "./public-commentary-semantics";
import {
  SEC_IPO_RESEARCH_DEFINITION_ID,
  secIpoResearchWorkerCandidateSchema,
} from "./sec-ipo-semantics";
import {
  createHybridEvidenceWorkerContractRegistry,
  type HybridEvidenceWorkerContract,
} from "./hybrid-evidence-worker-contract";
import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import { SEC_IPO_AGENTIC_RESEARCH_BUDGET } from "./sec-ipo-semantics";
import {
  INVERSE_CRAMER_AGENTIC_RESEARCH_BUDGET,
  INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
  inverseCramerResearchWorkerCandidateSchema,
} from "./inverse-cramer-research";

const contracts = Object.freeze([
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one compact Inverse Cramer market-view classification using the exact registered contract.",
      inputSchema: inverseCramerActionabilityWorkerCandidateSchema,
    }),
    definitionId: INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one Inverse Cramer executive brief using the exact registered semantic contract.",
      inputSchema: inverseCramerResearchWorkerCandidateSchema,
    }),
    definitionId: INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
    research: Object.freeze({
      approvedUrlPolicy: "evidence_sources" as const,
      budget: INVERSE_CRAMER_AGENTIC_RESEARCH_BUDGET,
      requiresParentRunId: true as const,
    }),
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one Inverse Cramer market-view candidate using the exact registered semantic contract.",
      inputSchema: inverseCramerSemanticWorkerCandidateSchema,
    }),
    definitionId: INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
    research: null,
  }),
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
      budget: SEC_IPO_AGENTIC_RESEARCH_BUDGET,
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

export function resolveStrategyPackResearchWorkerContract(
  pack: Pick<StrategyPackCatalogEntry, "evidenceContracts">,
): HybridEvidenceWorkerContract | null {
  const matches = (pack.evidenceContracts ?? []).flatMap(({ id }) => {
    const contract = resolveHybridEvidenceWorkerContract(id);
    return contract?.research ? [contract] : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}
