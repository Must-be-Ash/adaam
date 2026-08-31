import { createHash } from "node:crypto";
import type { ResearchReport } from "#artifact-schema";
import { publishReportArtifact } from "./artifact-store";
import { artifactReferenceForId } from "./artifact-reference";
import { createHybridEvidenceEphemeralArtifactStore, type HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import { resolveHybridTaskModelRoute } from "./hybrid-evidence-model-routing";
import { runWorkspaceSemanticEvidenceBundleJob } from "./hybrid-evidence-semantic";
import { drainHybridEvidenceWorker, startHybridEvidenceWorkerTask } from "./hybrid-evidence-worker";
import { congressionalResearchEvidenceContent, congressionalResearchResultSchema, createCongressionalResearchDefinition, CONGRESSIONAL_RESEARCH_DEFINITION_ID } from "./congressional-research";
import type { CongressionalFilingEvaluation } from "./congressional-strategy";
import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import type { WorkspaceExecutiveBrief } from "./workspace-executive-brief";
import { HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID } from "./strategy-pack-reference-catalog";

type SemanticClients = Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1];
export interface CongressionalResearchClients {
  artifacts?: HybridEvidenceArtifactStore;
  semantic?: Omit<SemanticClients, "artifacts" | "execute"> & Partial<Pick<SemanticClients, "execute">>;
  publishReport?: typeof publishReportArtifact;
}

export function resolveCongressionalResearchRuntime(input: {
  pack: StrategyPackCatalogEntry; modelIds: readonly string[];
  environment: NodeJS.ProcessEnv; workspaceGeneration: number;
}) {
  const route = resolveHybridTaskModelRoute("semantic_interpretation", input.environment);
  const definitions = input.modelIds.map((id) => createCongressionalResearchDefinition([id]))
    .filter((definition) => input.pack.evidenceContracts?.some((contract) =>
      contract.id === CONGRESSIONAL_RESEARCH_DEFINITION_ID && contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest));
  if (definitions.length !== 1 || definitions[0]!.allowedModelIds[0] !== route.modelId) {
    throw new Error("congressional_research_contract_invalid");
  }
  return { definition: definitions[0]!, modelId: route.modelId, reasoning: route.reasoning,
    pack: input.pack, workspaceGeneration: input.workspaceGeneration };
}

export async function researchCongressionalFiling(input: {
  evaluation: CongressionalFilingEvaluation; previousTransactions?: Parameters<typeof congressionalResearchEvidenceContent>[0]["previousTransactions"]; minimumAlertBand: "priority" | "review"; previousAlert: boolean;
  runtime: ReturnType<typeof resolveCongressionalResearchRuntime>;
  environment: NodeJS.ProcessEnv; now: Date; parentBudgetRunId: string;
  scope: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[0]["scope"];
  clients: CongressionalResearchClients;
}) {
  const projection = input.evaluation.filing;
  const artifacts = input.clients.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
  const content = congressionalResearchEvidenceContent(input);
  const artifact = await artifacts.persist({
    acquisitionId: projection.projection.acquisitionId, authority: "U.S. House of Representatives",
    bytes: Buffer.from(content), canonicalPublicUrl: input.evaluation.transactions[0]!.source.publicDocumentUrl,
    mediaType: "text/plain", now: input.now, observedAt: input.evaluation.signal.createdAt,
    parserEligibility: null, sourceInstanceId: projection.fact.sourceInstanceId,
    structure: { characterCount: content.length, columnCount: null, pageCount: null, rowCount: null, sheetCount: null },
  });
  try {
    const result = await runWorkspaceSemanticEvidenceBundleJob({
      definition: input.runtime.definition, environment: input.environment,
      members: [{ artifact, locators: [
        { kind: "source_fact", factRevisionId: projection.fact.revisionId, payloadDigest: projection.fact.payloadDigest },
        { kind: "text_span", artifactDigest: artifact.contentDigest, start: 0, end: content.length,
          spanDigest: createHash("sha256").update(content).digest("hex") },
      ], memberId: projection.fact.revisionId,
      projectionReference: { factRevisionId: projection.fact.revisionId, sourceId: HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID,
        subscriptionId: projection.projection.subscriptionId }, role: "section",
      semanticContext: { normalizedHouseFiling: true } }],
      modelId: input.runtime.modelId, now: input.now,
      pack: { id: input.runtime.pack.id, version: input.runtime.pack.version, contentDigest: input.runtime.pack.contentDigest },
      parentBudgetRunId: input.parentBudgetRunId, reasoning: input.runtime.reasoning,
      scope: input.scope, workspaceGeneration: input.runtime.workspaceGeneration,
    }, { ...input.clients.semantic, artifacts,
      execute: input.clients.semantic?.execute ?? (async (prepared) =>
        drainHybridEvidenceWorker(await startHybridEvidenceWorkerTask(prepared.request))),
    });
    if (!result.record.acceptedResult) throw new Error("congressional_research_incomplete");
    const decision = congressionalResearchResultSchema.parse(result.record.acceptedResult.payload);
    if (decision.brief.sources.some(({ role, url }) => role === "supplementary" && !result.record.researchUrlGrants.includes(url))) {
      throw new Error("congressional_research_source_not_granted");
    }
    return decision;
  } finally { await artifacts.deleteUnreferenced(artifact.contentDigest); }
}

export function congressionalBriefPresentation(brief: WorkspaceExecutiveBrief) {
  return { title: brief.title, whyMatched: [brief.interpretation, brief.implications[0], brief.uncertainty[0],
    ...(brief.research.status === "unavailable" ? [brief.research.limitation] : [])].join(" ").slice(0, 1_000) };
}

// One report per bounded source delivery keeps every filing separate and avoids
// exceeding the shared finding's eight artifact/provenance slots.
export async function publishCongressionalResearchReport(input: {
  briefs: readonly WorkspaceExecutiveBrief[]; identities: readonly string[];
  scope: { ownerId: string; workspaceId: string }; asOf: string; publishReport?: typeof publishReportArtifact;
}) {
  if (!input.briefs.length) return null;
  const artifactId = createHash("sha256").update(JSON.stringify({ ...input.scope,
    identities: input.identities, reportType: "congressional-executive-report/v1" })).digest("hex").slice(0, 32);
  const sources = new Map(input.briefs.flatMap(({ sources }) => sources).map((source) => [source.url, source]));
  const sourceIndexes = new Map([...sources.keys()].map((url, index) => [url, index + 1]));
  const report: ResearchReport = {
    title: input.briefs.length === 1 ? input.briefs[0]!.title : `${input.briefs.length} Congressional Signals briefs`,
    description: "Official House disclosures with separately attributed interpretation and bounded supplementary research.",
    eyebrow: "Eve · Congressional Signals", asOf: input.asOf,
    summary: input.briefs.length === 1 ? input.briefs[0]!.interpretation : "Each filing below is a separate signal; these disclosures do not establish a shared investment thesis.",
    disclosure: "Delayed disclosures are not current holdings, evidence of wrongdoing, or trade instructions. Reported value ranges and owner relationships are preserved; only the owner decides whether to trade.",
    sources: [...sources.values()].map(({ role, sourceId: _sourceId, ...source }, index) => ({ ...source,
      label: `[${index + 1}] ${role === "official" ? "Official filing" : "Supplementary context"} · ${source.label}`.slice(0, 180) })),
    blocks: input.briefs.map((brief) => ({ type: "text", heading: brief.title.slice(0, 180),
      body: [...brief.materialFacts.map(({ statement }) => statement),
        brief.interpretation, ...brief.implications, ...brief.uncertainty,
        `Confidence: ${brief.confidence}. Research: ${brief.research.status}.`,
        `Sources: ${brief.sources.map(({ url }) => `[${sourceIndexes.get(url)}]`).join(", ")}`,
        ...(brief.research.status === "unavailable" ? [brief.research.limitation] : [])].join("\n\n") })),
  };
  const published = await (input.publishReport ?? publishReportArtifact)({ artifactId, report });
  if (published.artifactId !== artifactId || published.kind !== "report") throw new Error("congressional_report_invalid");
  return artifactReferenceForId(artifactId);
}
