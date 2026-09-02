import { CONGRESSIONAL_RESEARCH_DEFINITION_ID, CONGRESSIONAL_RESEARCH_BUDGET, congressionalResearchWorkerCandidateSchema } from "./congressional-research";
import {
  commentaryActionabilityToolInputSchema,
  COMMENTARY_ACTIONABILITY_TOOL_DESCRIPTION,
  COMMENTARY_SEMANTIC_DEFINITION_ID,
  commentarySemanticWorkerCandidateSchema,
  createInverseCramerActionabilityDefinition,
  createPublicCommentaryImpactDefinition,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  inverseCramerActionabilityWorkerCandidateSchema,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
  inverseCramerSemanticWorkerCandidateSchema,
  materializeCommentaryActionabilityCandidate,
  PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
  publicCommentaryImpactWorkerCandidateSchema,
  QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS,
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
    completion: Object.freeze({ description: "Commit one evidence-linked Congressional Signals materiality decision and executive brief.", inputSchema: congressionalResearchWorkerCandidateSchema }),
    definitionId: CONGRESSIONAL_RESEARCH_DEFINITION_ID,
    research: Object.freeze({ approvedUrlPolicy: "evidence_sources" as const, budget: CONGRESSIONAL_RESEARCH_BUDGET, requiresParentRunId: true as const }),
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description: "Commit one compact Inverse Cramer market-view candidate using the historical exact schema.",
      inputSchema: inverseCramerActionabilityWorkerCandidateSchema,
    }),
    definitionId: INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
    definitionDigests: Object.freeze([
      "2ae4ee044cf6aaf9bb43eca4232d5b07c100a8a7fb9ccaa46538c830ff5347fd",
      "a68ec7ee643af922a835d28b24f353f7177d158d83d32d8f612180647fdd17e8",
    ]),
    research: null,
  }),
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
      description: `Commit one compact Inverse Cramer market-view decision. ${COMMENTARY_ACTIONABILITY_TOOL_DESCRIPTION}`,
      inputSchema: commentaryActionabilityToolInputSchema,
    }),
    definitionId: INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
    definitionDigests: Object.freeze([
      createInverseCramerActionabilityDefinition(
        ["google/gemini-3.7-flash"],
        {},
        "1.0.1",
      ).definitionDigest,
    ]),
    materializeCandidate: materializeCommentaryActionabilityCandidate,
    research: null,
  }),
  Object.freeze({
    capabilityRevisions: Object.freeze([2]),
    completion: Object.freeze({
      description: "Commit one configured public-commentary impact candidate using the historical exact schema.",
      inputSchema: publicCommentaryImpactWorkerCandidateSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
    definitionDigests: Object.freeze([
      "9fcb43d34864bbc04528d9a7ab1c248ee8a1f2644e800880d09f10e7decfdaf2",
      "587d757612af699fb232fc8e40033a9a3cb1d420ec9eca7acb6453f8bdd57923",
      "a43336b8dcbc4fce2ccf431cc2ed47347c6aa7d467d3bf1aeffd47c15068be29",
    ]),
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
      description: `Commit one configured public-commentary impact decision. ${COMMENTARY_ACTIONABILITY_TOOL_DESCRIPTION}`,
      inputSchema: commentaryActionabilityToolInputSchema,
    }),
    definitionId: PUBLIC_COMMENTARY_IMPACT_DEFINITION_ID,
    definitionDigests: Object.freeze([
      createPublicCommentaryImpactDefinition(
        ["google/gemini-3.7-flash"],
        { allowedAdapterIds: QUALIFIED_PUBLIC_COMMENTARY_ADAPTER_IDS },
        "1.0.3",
      ).definitionDigest,
    ]),
    materializeCandidate: materializeCommentaryActionabilityCandidate,
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
  definitionDigest?: string,
): HybridEvidenceWorkerContract | null {
  return hybridEvidenceWorkerContractRegistry.resolve(definitionId, definitionDigest);
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
