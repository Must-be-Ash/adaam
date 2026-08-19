import {
  readLatestPublicCommentaryFinding,
  readPublicCommentaryFinding,
  type PublicCommentaryFindingRecord,
  type PublicCommentaryFindingStoreClient,
} from "./public-commentary-finding-store";
import { PUBLIC_COMMENTARY_COPY } from "./public-commentary-product-contract";
import {
  createDefaultRevocableEvidenceStoreClient,
  readRevocableEvidencePayload,
  type RevocableEvidenceStoreClient,
} from "./revocable-evidence-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

export class PublicCommentaryPresentationError extends Error {
  constructor(readonly code: "public_commentary_finding_not_found" | "public_commentary_reference_invalid") {
    super(code);
    this.name = "PublicCommentaryPresentationError";
  }
}

export function explainPublicCommentaryFinding(record: PublicCommentaryFindingRecord, exactStatement: string | null = null) {
  const corrected = record.correction !== null;
  return Object.freeze({
    citation: Object.freeze({ ...record.finding.citations[0] }),
    confidence: record.finding.confidence,
    correction: record.correction ? Object.freeze({ ...record.correction }) : null,
    createdAt: record.createdAt,
    direction: record.finding.policyDecision.researchDirection,
    directionDisclosure: record.directionDisclosure ?? "No active research direction remains after the source correction.",
    exactStatement,
    findingId: record.finding.findingId,
    horizon: record.interpretation?.horizon ?? "unavailable",
    impactClassification: record.impactClassification,
    interpretationId: corrected ? null : record.finding.interpretationId,
    lifecycle: record.statement.lifecycle,
    liveRevalidation: "not_performed" as const,
    outcome: record.finding.outcome,
    rationale: record.finding.summary,
    relatedCoverage: record.corroboration.status,
    relatedCoverageLabel: PUBLIC_COMMENTARY_COPY.relatedCoverage[record.corroboration.status],
    sourceFreshness: corrected ? "correction_observed" as const : "stored_snapshot" as const,
    statementRevisionId: record.finding.statementRevisionId,
    targetSymbols: Object.freeze(record.extraction?.targets.flatMap(({ symbol }) => symbol ? [symbol] : []) ?? []),
  });
}

async function exactStatementText(record: PublicCommentaryFindingRecord, options?: Readonly<{
  client?: RevocableEvidenceStoreClient;
  encryptionKey?: Uint8Array;
  environment?: NodeJS.ProcessEnv;
}>): Promise<string | null> {
  if (!record.statement.contentReference) return null;
  const environment = options?.environment ?? process.env;
  const encoded = environment.EVE_PUBLIC_COMMENTARY_EVIDENCE_KEY_BASE64?.trim();
  const encryptionKey = options?.encryptionKey ?? (encoded ? Buffer.from(encoded, "base64") : null);
  if (!encryptionKey || encryptionKey.byteLength !== 32) return null;
  return readRevocableEvidencePayload({
    client: options?.client ?? createDefaultRevocableEvidenceStoreClient(environment),
    encryptionKey,
    envelopeId: record.statement.contentReference.envelopeId,
  });
}

export async function readPublicCommentaryFindingExplanation(input: {
  readonly findingId: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
}, client?: PublicCommentaryFindingStoreClient, evidence?: Parameters<typeof exactStatementText>[1]) {
  if (!/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u.test(input.findingId)) {
    throw new PublicCommentaryPresentationError("public_commentary_reference_invalid");
  }
  const record = await readPublicCommentaryFinding(input.scope, input.findingId, client);
  if (!record) throw new PublicCommentaryPresentationError("public_commentary_finding_not_found");
  return explainPublicCommentaryFinding(record, await exactStatementText(record, evidence));
}

export async function readLatestPublicCommentaryFindingExplanation(
  scope: AuthorizedWorkspaceStoreScope,
  client?: PublicCommentaryFindingStoreClient,
  evidence?: Parameters<typeof exactStatementText>[1],
) {
  const record = await readLatestPublicCommentaryFinding(scope, client);
  if (!record) throw new PublicCommentaryPresentationError("public_commentary_finding_not_found");
  return explainPublicCommentaryFinding(record, await exactStatementText(record, evidence));
}

export async function readPublicCommentaryWorkspacePresentation(input: {
  readonly costMode?: "first_party" | "pay_per_use";
  readonly credentialStatus: "configured" | "missing" | "not_required" | "unavailable";
  readonly estimatedCostUsd: string;
  readonly monitor: Readonly<{
    readonly lifecycleState: "enabled" | "paused" | "paused_failure" | "retired" | "suspended_archived";
    readonly sourceCheckpoint: Readonly<{ readonly watermark: string | null }>;
  }> | null;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly sourceStatus: "healthy" | "degraded" | "disabled" | "unavailable";
}, client?: PublicCommentaryFindingStoreClient, evidence?: Parameters<typeof exactStatementText>[1]) {
  const latest = await readLatestPublicCommentaryFinding(input.scope, client);
  const exactStatement = latest ? await exactStatementText(latest, evidence) : null;
  return Object.freeze({
    cost: Object.freeze({ estimatedUsd: input.estimatedCostUsd, mode: input.costMode ?? "pay_per_use" }),
    coverage: latest ? latest.corroboration.status : "not_run" as const,
    credentialStatus: input.credentialStatus,
    latestAnalysis: latest ? explainPublicCommentaryFinding(latest, exactStatement) : null,
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
