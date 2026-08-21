import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { resolveHybridEvidenceResearchToolNames } from "../agent/lib/hybrid-evidence-research";
import {
  createHybridEvidenceWorkerContractRegistry,
  type HybridEvidenceWorkerContract,
} from "../agent/lib/hybrid-evidence-worker-contract";
import { resolveHybridEvidenceWorkerContract } from "../agent/lib/hybrid-evidence-worker-contract-registry";
import { COMMENTARY_SEMANTIC_DEFINITION_ID } from "../agent/lib/public-commentary-semantics";
import { SEC_IPO_RESEARCH_DEFINITION_ID } from "../agent/lib/sec-ipo-semantics";

const candidateSchema = z.object({
  citations: z.array(z.unknown()),
  disposition: z.enum(["accepted", "abstained", "quarantined"]),
  fields: z.record(z.string(), z.unknown()),
  unknowns: z.array(z.string()),
}).strict();

const referenceContract: HybridEvidenceWorkerContract = Object.freeze({
  capabilityRevisions: Object.freeze([2]),
  completion: Object.freeze({
    description: "Complete the reference semantic job.",
    inputSchema: candidateSchema,
  }),
  definitionId: "reference-semantic-research",
  research: Object.freeze({
    approvedUrlPolicy: "evidence_sources",
    requiresParentRunId: true,
  }),
});

const registry = createHybridEvidenceWorkerContractRegistry([referenceContract]);
assert.equal(registry.resolve(referenceContract.definitionId), referenceContract);
assert.equal(registry.resolve("unregistered-semantic-definition"), null);
assert.deepEqual(resolveHybridEvidenceResearchToolNames({
  decision: null,
  researchEnabled: registry.resolve(referenceContract.definitionId)?.research != null,
}), ["decide_hybrid_evidence_research", "read_hybrid_evidence_bundle"]);
assert.throws(
  () => createHybridEvidenceWorkerContractRegistry([
    referenceContract,
    { ...referenceContract },
  ]),
  /hybrid_evidence_worker_contract_conflict/u,
);

assert.equal(
  resolveHybridEvidenceWorkerContract(SEC_IPO_RESEARCH_DEFINITION_ID)
    ?.research?.approvedUrlPolicy,
  "evidence_sources",
);
assert.equal(
  resolveHybridEvidenceWorkerContract(COMMENTARY_SEMANTIC_DEFINITION_ID)?.research,
  null,
);
assert.equal(resolveHybridEvidenceWorkerContract("unregistered-semantic-definition"), null);

for (const path of [
  "agent/lib/hybrid-evidence-auth.ts",
  "agent/lib/hybrid-evidence-research.ts",
  "agent/lib/hybrid-evidence-semantic.ts",
  "agent/lib/hybrid-evidence-worker.ts",
  "agent/subagents/hybrid-evidence-worker/tools/capabilities.ts",
]) {
  assert.doesNotMatch(
    await readFile(path, "utf8"),
    /SEC_IPO_RESEARCH_DEFINITION_ID/u,
    `${path} must dispatch through the registered worker contract`,
  );
}

console.info("Shared research contract dispatch verification passed.");
