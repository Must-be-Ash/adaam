import {
  readLatestPublicCommentaryFinding,
  readPublicCommentaryFinding,
  type PublicCommentaryFindingRecord,
  type PublicCommentaryFindingStoreClient,
} from "./public-commentary-finding-store";
import { PUBLIC_COMMENTARY_COPY } from "./public-commentary-product-contract";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

export class PublicCommentaryPresentationError extends Error {
  constructor(readonly code: "public_commentary_finding_not_found" | "public_commentary_reference_invalid") {
    super(code);
    this.name = "PublicCommentaryPresentationError";
  }
}

export function explainPublicCommentaryFinding(record: PublicCommentaryFindingRecord) {
  return Object.freeze({
    citation: Object.freeze({ ...record.finding.citations[0] }),
    confidence: record.finding.confidence,
    correction: record.correction ? Object.freeze({ ...record.correction }) : null,
    createdAt: record.createdAt,
    direction: record.finding.policyDecision.researchDirection,
    directionDisclosure: record.directionDisclosure,
    findingId: record.finding.findingId,
    horizon: record.interpretation.horizon,
    interpretationId: record.finding.interpretationId,
    lifecycle: record.statement.lifecycle,
    outcome: record.finding.outcome,
    rationale: record.finding.summary,
    relatedCoverage: record.corroboration.status,
    relatedCoverageLabel: PUBLIC_COMMENTARY_COPY.relatedCoverage[record.corroboration.status],
    statementRevisionId: record.finding.statementRevisionId,
    targetSymbols: Object.freeze(record.extraction.targets.flatMap(({ symbol }) => symbol ? [symbol] : [])),
  });
}

export async function readPublicCommentaryFindingExplanation(input: {
  readonly findingId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, client?: PublicCommentaryFindingStoreClient) {
  if (!/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u.test(input.findingId)) {
    throw new PublicCommentaryPresentationError("public_commentary_reference_invalid");
  }
  const record = await readPublicCommentaryFinding(input.scope, input.findingId, client);
  if (!record) throw new PublicCommentaryPresentationError("public_commentary_finding_not_found");
  return explainPublicCommentaryFinding(record);
}

export async function readLatestPublicCommentaryFindingExplanation(
  scope: AuthorizedWorkspaceStoreScope,
  client?: PublicCommentaryFindingStoreClient,
) {
  const record = await readLatestPublicCommentaryFinding(scope, client);
  if (!record) throw new PublicCommentaryPresentationError("public_commentary_finding_not_found");
  return explainPublicCommentaryFinding(record);
}

export async function readPublicCommentaryWorkspacePresentation(input: {
  readonly credentialStatus: "configured" | "missing" | "unavailable";
  readonly estimatedCostUsd: string;
  readonly monitor: Readonly<{
    readonly lifecycleState: "enabled" | "paused" | "paused_failure" | "retired" | "suspended_archived";
    readonly sourceCheckpoint: Readonly<{ readonly watermark: string | null }>;
  }> | null;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly sourceStatus: "healthy" | "degraded" | "disabled" | "unavailable";
}, client?: PublicCommentaryFindingStoreClient) {
  const latest = await readLatestPublicCommentaryFinding(input.scope, client);
  return Object.freeze({
    cost: Object.freeze({ estimatedUsd: input.estimatedCostUsd, mode: "pay_per_use" as const }),
    coverage: latest ? latest.corroboration.status : "not_run" as const,
    credentialStatus: input.credentialStatus,
    latestAnalysis: latest ? explainPublicCommentaryFinding(latest) : null,
    lifecycle: latest?.statement.lifecycle ?? "unavailable",
    monitorState: input.monitor?.lifecycleState ?? "paused",
    outcomes: Object.freeze({
      accepted: latest?.finding.outcome === "accepted" ? 1 : 0,
      abstained: latest?.finding.outcome === "abstained" ? 1 : 0,
      corrected: latest?.finding.outcome === "corrected" || latest?.correction ? 1 : 0,
      noView: latest?.finding.outcome === "no_view" ? 1 : 0,
      quarantined: latest?.finding.outcome === "quarantined" ? 1 : 0,
      retracted: latest?.finding.outcome === "retracted" ? 1 : 0,
    }),
    sourceCheckpoint: input.monitor?.sourceCheckpoint.watermark ?? null,
    sourceStatus: input.sourceStatus,
    state: "available" as const,
  });
}
