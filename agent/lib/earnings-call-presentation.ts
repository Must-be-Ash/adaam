import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import {
  readEarningsCallFinding,
  readLatestEarningsCallFinding,
  type EarningsCallFindingRecord,
  type EarningsCallFindingStoreClient,
} from "./earnings-call-finding-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

export class EarningsCallPresentationError extends Error {
  constructor(readonly code: "earnings_finding_not_found" | "earnings_finding_reference_invalid") {
    super(code);
    this.name = "EarningsCallPresentationError";
  }
}

function citedAssertion(assertion: EarningsCallFindingRecord["finding"]["facts"][number]) {
  return Object.freeze({
    citations: Object.freeze(assertion.citations.map((citation) => Object.freeze({ ...citation }))),
    statement: assertion.statement,
  });
}

export function explainEarningsCallFinding(record: EarningsCallFindingRecord) {
  const finding = record.finding;
  return Object.freeze({
    analysisLineage: Object.freeze({ ...finding.analysisLineage }),
    cik: record.cik,
    companyName: record.companyName,
    comparisonDigest: finding.comparisonDigest,
    comparisonId: finding.comparisonId,
    confidence: finding.confidence,
    counterevidence: Object.freeze(finding.counterevidence.map(citedAssertion)),
    createdAt: record.createdAt,
    facts: Object.freeze(finding.facts.map(citedAssertion)),
    findingDigest: finding.findingDigest,
    findingId: finding.findingId,
    forecast: finding.forecast ? Object.freeze(structuredClone(finding.forecast)) : null,
    inferences: Object.freeze(finding.inferences.map(citedAssertion)),
    materiality: Object.freeze(structuredClone(finding.materiality)),
    outcome: finding.outcome,
    recommendation: finding.recommendation
      ? Object.freeze(structuredClone(finding.recommendation))
      : null,
    sources: Object.freeze(record.sources.map((source) => Object.freeze({ ...source }))),
    ticker: record.ticker,
    unknowns: Object.freeze([...finding.unknowns]),
  });
}

export async function readEarningsCallFindingExplanation(input: {
  readonly findingId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, client?: EarningsCallFindingStoreClient) {
  if (!/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u.test(input.findingId)) {
    throw new EarningsCallPresentationError("earnings_finding_reference_invalid");
  }
  const record = await readEarningsCallFinding(input.scope, input.findingId, client);
  if (!record) throw new EarningsCallPresentationError("earnings_finding_not_found");
  return explainEarningsCallFinding(record);
}

export async function readLatestEarningsCallFindingExplanation(
  scope: AuthorizedWorkspaceStoreScope,
  client?: EarningsCallFindingStoreClient,
) {
  const record = await readLatestEarningsCallFinding(scope, client);
  if (!record) throw new EarningsCallPresentationError("earnings_finding_not_found");
  return explainEarningsCallFinding(record);
}

export async function readEarningsCallWorkspacePresentation(input: {
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly selectedIssuerCiks: readonly string[];
}, client?: EarningsCallFindingStoreClient) {
  const selected = new Set(input.selectedIssuerCiks);
  const coverage = EARNINGS_CALL_ISSUER_CATALOG.entries
    .filter(({ cik }) => selected.has(cik))
    .map((entry) => Object.freeze({
      cik: entry.cik,
      companyName: entry.companyName,
      lastSuccessfulEventAt: entry.coverage.lastSuccessfulEventAt,
      reasonCode: entry.coverage.reasonCode,
      state: entry.coverage.state,
      ticker: entry.ticker,
    }));
  const latest = await readLatestEarningsCallFinding(input.scope, client);
  return Object.freeze({
    coverage: Object.freeze(coverage),
    latestAnalysis: latest ? explainEarningsCallFinding(latest) : null,
    state: "available" as const,
  });
}
