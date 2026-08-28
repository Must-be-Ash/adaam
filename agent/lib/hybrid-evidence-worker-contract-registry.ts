import {
  COMMENTARY_SEMANTIC_DEFINITION_ID,
  commentarySemanticWorkerCandidateSchema,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  inverseCramerActionabilityWorkerCandidateSchema,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
  inverseCramerSemanticWorkerCandidateSchema,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
  publicCommentaryImpactWorkerCandidateSchema,
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
import {
  PUBLIC_COMMENTARY_AGENTIC_RESEARCH_BUDGET,
  PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
  publicCommentaryResearchWorkerCandidateSchema,
} from "./public-commentary-research";
import {
  EARNINGS_CALL_AGENTIC_RESEARCH_BUDGET,
  EARNINGS_CALL_RESEARCH_DEFINITION_ID,
  earningsCallResearchWorkerCandidateSchema,
} from "./earnings-call-research";
import { houseDocumentRowWorkerCandidateSchema } from "./hybrid-evidence-extraction-recovery";
import { HOUSE_DOCUMENT_ROW_DEFINITION_ID } from "./hybrid-evidence-definition-registry";

const contracts = Object.freeze([
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one exact House PTR extraction using the registered document, checkbox, amount-band, and row schema.",
      inputSchema: houseDocumentRowWorkerCandidateSchema,
    }),
    definitionId: HOUSE_DOCUMENT_ROW_DEFINITION_ID,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one Earnings Call Changes executive brief using the exact registered research contract.",
      inputSchema: earningsCallResearchWorkerCandidateSchema,
    }),
    definitionId: EARNINGS_CALL_RESEARCH_DEFINITION_ID,
    research: Object.freeze({
      approvedUrlPolicy: "evidence_sources" as const,
      budget: EARNINGS_CALL_AGENTIC_RESEARCH_BUDGET,
      requiresParentRunId: true as const,
    }),
  }),
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
        "Commit one configured public-commentary impact classification using the exact registered contract.",
      inputSchema: publicCommentaryImpactWorkerCandidateSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description:
        "Commit one public-commentary executive brief using the exact registered research contract.",
      inputSchema: publicCommentaryResearchWorkerCandidateSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_RESEARCH_DEFINITION_ID,
    research: Object.freeze({
      approvedUrlPolicy: "evidence_sources" as const,
      budget: PUBLIC_COMMENTARY_AGENTIC_RESEARCH_BUDGET,
      requiresParentRunId: true as const,
    }),
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
