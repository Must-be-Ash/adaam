import { createHash } from "node:crypto";
import type { ResearchReport } from "#artifact-schema";
import { publishReportArtifact } from "./artifact-store";
import { artifactReferenceForId } from "./artifact-reference";
import { createHybridEvidenceEphemeralArtifactStore, type HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import { resolveHybridTaskModelRoute } from "./hybrid-evidence-model-routing";
import { runWorkspaceSemanticEvidenceBundleJob } from "./hybrid-evidence-semantic";
import { drainHybridEvidenceWorker, startHybridEvidenceWorkerTask } from "./hybrid-evidence-worker";
import { congressionalResearchEvidenceContent, congressionalResearchResultSchema, createCongressionalResearchDefinition, CONGRESSIONAL_RESEARCH_DEFINITION_ID } from "./congressional-research";
import type { HouseStrategyTransaction } from "./congressional-signal-schema";
import type { CongressionalFilingEvaluation } from "./congressional-strategy";
import type { CongressionalCoverage } from "./congressional-history";
import type { StrategyPackCatalogEntry } from "./strategy-pack-catalog";
import type { WorkspaceExecutiveBrief } from "./workspace-executive-brief";
import { HOUSE_FINANCIAL_DISCLOSURES_SOURCE_ID } from "./strategy-pack-reference-catalog";

type SemanticClients = Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1];
export type CongressionalReportTransaction = Readonly<{
  amountRange: HouseStrategyTransaction["amountRange"];
  asset: HouseStrategyTransaction["asset"];
  disclosedMember: HouseStrategyTransaction["disclosedMember"];
  filingDate: HouseStrategyTransaction["filingDate"];
  lineage: Pick<HouseStrategyTransaction["lineage"], "state">;
  owner: HouseStrategyTransaction["owner"];
  source: Pick<HouseStrategyTransaction["source"], "page" | "publicDocumentUrl" | "rowIdentity">;
  transactionDate: HouseStrategyTransaction["transactionDate"];
  transactionType: HouseStrategyTransaction["transactionType"];
}>;
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
  historyCoverage?: CongressionalCoverage["state"];
  evaluation: CongressionalFilingEvaluation; previousTransactions?: Parameters<typeof congressionalResearchEvidenceContent>[0]["previousTransactions"]; minimumAlertBand: "priority" | "review"; previousAlert: boolean;
  runtime: ReturnType<typeof resolveCongressionalResearchRuntime>;
  environment: NodeJS.ProcessEnv; now: Date; parentBudgetRunId: string;
  scope: Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[0]["scope"];
  clients: CongressionalResearchClients;
}) {
  const projection = input.evaluation.filing;
  const artifacts = input.clients.artifacts ?? createHybridEvidenceEphemeralArtifactStore();
  const content = congressionalResearchEvidenceContent(input);
  let artifact: Awaited<ReturnType<typeof artifacts.persist>> | undefined;
  try {
    artifact = await artifacts.persist({
    acquisitionId: projection.projection.acquisitionId, authority: "U.S. House of Representatives",
    bytes: Buffer.from(content), canonicalPublicUrl: input.evaluation.transactions[0]!.source.publicDocumentUrl,
    mediaType: "text/plain", now: input.now, observedAt: input.evaluation.signal.createdAt,
    parserEligibility: null, sourceInstanceId: projection.fact.sourceInstanceId,
    structure: { characterCount: content.length, columnCount: null, pageCount: null, rowCount: null, sheetCount: null },
  });
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
  } catch {
    // Any optional enrichment failure falls back to the already verified facts.
    return null;
  } finally {
    if (artifact) {
      try {
        await artifacts.deleteUnreferenced(artifact.contentDigest);
      } catch {
        // Persisted artifacts begin unreferenced. A failed immediate deletion
        // remains eligible for the store's normal orphan collection and must
        // not override a verified factual notification.
      }
    }
  }
}

export function congressionalBriefPresentation(brief: WorkspaceExecutiveBrief) {
  return { title: brief.title, whyMatched: [brief.interpretation, brief.implications[0], brief.uncertainty[0],
    ...(brief.research.status === "unavailable" ? [brief.research.limitation] : [])].join(" ").slice(0, 1_000) };
}

// One report per bounded source delivery keeps every filing separate and avoids
// exceeding the shared finding's eight artifact/provenance slots.
export async function publishCongressionalResearchReport(input: {
  entries: readonly Readonly<{ identity: string; transactions: readonly CongressionalReportTransaction[]; brief?: WorkspaceExecutiveBrief }>[];
  scope: { ownerId: string; workspaceId: string }; asOf: string; publishReport?: typeof publishReportArtifact;
}) {
  if (!input.entries.length) return [];
  const batches: typeof input.entries[number][][] = [];
  for (const entry of input.entries) {
    const rowCount = entry.transactions.filter(({ transactionType }) =>
      transactionType === "P" || transactionType === "S").length;
    const entryBlockCount = Math.max(1, Math.ceil(rowCount / 100)) + 1;
    const entrySourceUrls = new Set([
      ...entry.transactions.map(({ source }) => source.publicDocumentUrl),
      ...(entry.brief?.sources.map(({ url }) => url) ?? []),
    ]);
    const current = batches.at(-1);
    const currentBlockCount = current?.reduce((count, candidate) => count +
      Math.max(1, Math.ceil(candidate.transactions.filter(({ transactionType }) =>
        transactionType === "P" || transactionType === "S").length / 100)) + 1, 0) ?? 0;
    const currentSourceUrls = new Set(current?.flatMap((candidate) => [
      ...candidate.transactions.map(({ source }) => source.publicDocumentUrl),
      ...(candidate.brief?.sources.map(({ url }) => url) ?? []),
    ]) ?? []);
    if (!current || currentBlockCount + entryBlockCount > 40 ||
      new Set([...currentSourceUrls, ...entrySourceUrls]).size > 100) batches.push([entry]);
    else current.push(entry);
  }
  if (batches.length > 8) throw new Error("congressional_report_capacity_exceeded");
  const references: string[] = [];
  for (const [batchIndex, entries] of batches.entries()) {
    const identities = entries.map(({ identity }) => identity);
    const artifactId = createHash("sha256").update(JSON.stringify({ ...input.scope,
      batchIndex, identities, reportType: "congressional-disclosure-report/v2" })).digest("hex").slice(0, 32);
    const sources = new Map(entries.flatMap(({ brief }) => brief?.sources ?? []).map((source) => [source.url, source]));
    for (const { transactions } of entries) {
      for (const row of transactions) sources.set(row.source.publicDocumentUrl, {
        label: "Official House PTR", role: "official", url: row.source.publicDocumentUrl,
      });
    }
    const sourceIndexes = new Map([...sources.keys()].map((url, index) => [url, index + 1]));
    const blocks: ResearchReport["blocks"] = [];
    for (const { brief, transactions } of entries) {
      const rows = transactions.filter(({ transactionType }) => transactionType === "P" || transactionType === "S");
      for (let offset = 0; offset < Math.max(rows.length, 1); offset += 100) {
        const page = rows.slice(offset, offset + 100);
        blocks.push(page.length ? {
          type: "table", heading: offset === 0 ? congressionalDisclosureSummary(transactions).slice(0, 180) : "Verified disclosure facts (continued)",
          columns: ["Asset", "Asset continued", "Ticker · type", "Dates", "Amount · owner", "Official source · row identity"],
          rows: page.map((row) => congressionalTransactionCells(row, sourceIndexes.get(row.source.publicDocumentUrl)!)),
        } : { type: "text", heading: "Verified disclosure facts",
          body: congressionalDisclosureSummary(transactions) + " No verified purchase or sale rows were retained." });
      }
      if (brief) blocks.push({ type: "text", heading: brief.title.slice(0, 180),
        body: ["Optional model interpretation (not a replacement for disclosed facts):",
          brief.interpretation, ...brief.implications, ...brief.uncertainty,
          `Confidence: ${brief.confidence}. Research: ${brief.research.status}.`,
          `Sources: ${brief.sources.map(({ url }) => `[${sourceIndexes.get(url)}]`).join(", ")}`,
          ...(brief.research.status === "unavailable" ? [brief.research.limitation] : [])].join("\n\n") });
      else blocks.push({ type: "text", heading: "Interpretation unavailable",
        body: "Optional interpretation unavailable; notification is based on verified facts only." });
    }
    const report: ResearchReport = {
    title: "Congressional Signals · disclosed transactions",
    description: "Official House disclosures with separately attributed interpretation and bounded supplementary research.",
    eyebrow: "Eve · Congressional Signals", asOf: input.asOf,
    summary: "Every verified disclosed purchase and sale is listed below. Optional model interpretation is separate from the official facts.",
    disclosure: "Delayed disclosures are not current holdings, evidence of wrongdoing, or trade instructions. Reported value ranges and owner relationships are preserved; only the owner decides whether to trade.",
      sources: [...sources.values()].map(({ role, sourceId: _sourceId, ...source }, index) => ({ ...source,
      label: `[${index + 1}] ${role === "official" ? "Official filing" : "Supplementary context"} · ${source.label}`.slice(0, 180) })),
      blocks,
    };
    const published = await (input.publishReport ?? publishReportArtifact)({ artifactId, report });
    if (published.artifactId !== artifactId || published.kind !== "report") throw new Error("congressional_report_invalid");
    references.push(artifactReferenceForId(artifactId));
  }
  return references;
}

const OWNER_LABELS = {
  self: "member", spouse: "spouse", dependent_child: "dependent child", joint: "joint",
  other_disclosed: "other disclosed owner", unknown: "unknown (not inferred)",
} as const satisfies Record<HouseStrategyTransaction["owner"]["relationship"], string>;
const TRANSACTION_TYPE_LABELS = { P: "Purchase", S: "Sale", E: "Exchange" } as const;

export function congressionalDisclosureSummary(rows: readonly CongressionalReportTransaction[]): string {
  const first = rows[0]!;
  const count = rows.filter((row) => row.transactionType === "P" || row.transactionType === "S").length;
  return `${first.disclosedMember.firstName} ${first.disclosedMember.lastName} disclosed ${count} purchase/sale transaction(s), filed ${first.filingDate}. These are delayed disclosures, not trades made today. Full verified details are in the linked report.`;
}

function congressionalTransactionCells(row: CongressionalReportTransaction, sourceIndex: number): string[] {
  const owner = OWNER_LABELS[row.owner.relationship];
  const asset = row.asset.description ?? "Asset unreadable or missing";
  return [
    `${row.lineage.state === "retracted" ? "RETRACTED: " : ""}${asset.slice(0, 500)}`,
    asset.slice(500),
    `${row.asset.reportedTicker ?? "not reported"} · ${TRANSACTION_TYPE_LABELS[row.transactionType ?? "E"]}`,
    `Transaction ${row.transactionDate ?? "unreadable or missing"} · filed ${row.filingDate}`,
    `${row.amountRange.label} · ${owner}`,
    `[${sourceIndex}] · ${row.source.page ? `page ${row.source.page}` : "page citation unavailable"} · ${row.source.rowIdentity}`,
  ];
}
