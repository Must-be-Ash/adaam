import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import { resolveEarningsCallPublicSource } from "./earnings-call-public-source-contract";
import {
  readEarningsCallFinding,
  readLatestEarningsCallFinding,
  type EarningsCallFindingRecord,
  type EarningsCallFindingStoreClient,
} from "./earnings-call-finding-store";
import {
  readEarningsCallIssuerStatus,
  type EarningsCallIssuerStatusStoreClient,
} from "./earnings-call-status-store";
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
  readonly monitor?: Readonly<{
    readonly lifecycleState: "enabled" | "paused" | "paused_failure" | "retired" | "suspended_archived";
    readonly sourceCheckpoint: Readonly<{ readonly contentDigest: string | null; readonly watermark: string | null }>;
    readonly sources: readonly Readonly<{ readonly sourceId: string }>[];
  }>;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly selectedIssuerCiks: readonly string[];
  readonly sourceHealth?: readonly Readonly<{
    readonly healthState: "degraded" | "healthy" | "idle" | "unavailable";
    readonly sourceId: string;
  }>[];
}, clients?: EarningsCallFindingStoreClient | Readonly<{
  readonly findings?: EarningsCallFindingStoreClient;
  readonly statuses?: EarningsCallIssuerStatusStoreClient;
}>) {
  const findings = clients && "createOrRead" in clients ? clients : clients?.findings;
  const statuses = clients && "createOrRead" in clients ? undefined : clients?.statuses;
  const selected = new Set(input.selectedIssuerCiks);
  const entries = EARNINGS_CALL_ISSUER_CATALOG.entries.filter(({ cik }) => selected.has(cik));
  const [latest, storedStatuses] = await Promise.all([
    readLatestEarningsCallFinding(input.scope, findings),
    Promise.all(entries.map(({ cik }) => readEarningsCallIssuerStatus(input.scope, cik, statuses))),
  ]);
  const sourceHealth = new Map((input.sourceHealth ?? []).map((health) => [health.sourceId, health]));
  const coverage = entries.map((entry, index) => {
    const sourceId = `earnings-call-transcripts.${entry.cik}`;
    const reviewed = resolveEarningsCallPublicSource(sourceId);
    const discoveryUnavailable = reviewed?.family.discoveryPolicy.state === "coverage_unavailable";
    let projected = discoveryUnavailable
      ? {
          lastSuccessfulEventAt: null,
          reasonCode: "coverage_not_reviewed" as const,
          state: "coverage_unavailable" as const,
        }
      : storedStatuses[index]?.coverage ?? {
          lastSuccessfulEventAt: null,
          reasonCode: "awaiting_comparable_call" as const,
          state: "awaiting_comparable_call" as const,
        };
    if (projected.state !== "coverage_unavailable") {
      if (
        !storedStatuses[index] &&
        input.monitor?.sourceCheckpoint.watermark &&
        input.monitor.sources.some((source) => source.sourceId === sourceId)
      ) {
        projected = {
          lastSuccessfulEventAt: input.monitor.sourceCheckpoint.watermark,
          reasonCode: null,
          state: "baseline_ready",
        };
      }
      if (latest?.cik === entry.cik) {
        projected = {
          lastSuccessfulEventAt: latest.createdAt,
          reasonCode: null,
          state: "current",
        };
      }
      const health = sourceHealth.get(sourceId);
      if (health && (health.healthState === "degraded" || health.healthState === "unavailable")) {
        projected = {
          lastSuccessfulEventAt: projected.lastSuccessfulEventAt,
          reasonCode: "source_failed",
          state: "degraded",
        };
      }
      if (
        input.monitor?.lifecycleState === "paused_failure" &&
        input.monitor.sources.some((source) => source.sourceId === sourceId)
      ) {
        projected = {
          lastSuccessfulEventAt: projected.lastSuccessfulEventAt ?? input.monitor.sourceCheckpoint.watermark,
          reasonCode: "source_failed",
          state: "paused_failure",
        };
      }
    }
    return Object.freeze({
      cik: entry.cik,
      companyName: entry.companyName,
      lastSuccessfulEventAt: projected.lastSuccessfulEventAt,
      reasonCode: projected.reasonCode,
      state: projected.state,
      ticker: entry.ticker,
    });
  });
  return Object.freeze({
    coverage: Object.freeze(coverage),
    latestAnalysis: latest ? explainEarningsCallFinding(latest) : null,
    state: "available" as const,
  });
}
