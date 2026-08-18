import { createHash } from "node:crypto";

import { z } from "zod";

import {
  createCommentaryPolicyDefinition,
  decideCommentaryPolicy,
} from "./commentary-policy";
import {
  commentaryCorrectionSchema,
  commentaryExtractionSchema,
  commentaryFindingSchema,
  commentaryInterpretationSchema,
  commentaryMaterialitySchema,
  digestPublicCommentaryValue,
  publicStatementRole,
  publicStatementSchema,
  publicStatementStableId,
  webCorroborationSearchSchema,
  type PublicStatement,
  type WebCorroborationSearch,
} from "./public-commentary-schema";
import {
  createCommentarySemanticDefinition,
  extractCommentaryMetadata,
  commentarySemanticPayloadSchema,
  type CommentarySemanticPayload,
} from "./public-commentary-semantics";
import { resolvePublicCommentaryRuntimeFlags } from "./public-commentary-flags";
import {
  persistPublicCommentaryCorroborationAttempt,
  persistPublicCommentaryOccurrenceQuarantine,
  readPublicCommentaryCorroborationAttempt,
  type PublicCommentaryAttemptStoreClient,
} from "./public-commentary-attempt-store";
import {
  persistPublicCommentaryFinding,
  type PublicCommentaryFindingRecord,
  type PublicCommentaryFindingStoreClient,
} from "./public-commentary-finding-store";
import {
  digestHybridEvidenceValue,
  hybridAcceptedResultSchema,
  type HybridAcceptedResult,
} from "./hybrid-evidence-schema";
import type { WorkspaceSemanticEvidenceBundleRunResult } from "./hybrid-evidence-semantic";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import { workspaceFindingCandidateSchema, type WorkspaceFindingCandidate } from "./workspace-finding-store";
import {
  readWorkspaceBudgetLedger,
  reconcileWorkspaceRunBudget,
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
} from "./workspace-budget-ledger";
import {
  readWorkspaceDocument,
  type WorkspaceStateStoreClient,
} from "./workspace-state-store";
import type { WebCorroborationProvider } from "./web-corroboration-search";
import { compileWebCorroborationQuery } from "./web-corroboration-search";
import { marketSymbolSchema } from "./strategy-pack-schema";

export const INVERSE_CRAMER_POLICY = createCommentaryPolicyDefinition({
  displayName: "Inverse Cramer",
  policyId: "commentary-direction-inversion",
  policyVersion: "1.0.0",
  transformId: "invert-bullish-bearish",
  transformVersion: "1.0.0",
});

export interface PublicCommentarySourceBinding {
  readonly accessClassification: "public";
  readonly adapterId: string;
  readonly canonicalUrl: string;
  readonly origin: string;
  readonly sourceId: string;
  readonly sourceInstanceId: string;
}

const PUBLIC_COMMENTARY_OCCURRENCE_LIMITS = Object.freeze({
  batchSize: 8,
  maximumFactIdentities: 8,
  maximumFacts: 8,
  // The X continuation store retains at most 500 timeline items and a single
  // occurrence can add the eight bounded rehydration results. Keep the
  // projection envelope aligned with that durable source envelope so a
  // completed continuation is processed in batches instead of quarantined.
  maximumStatements: 508,
  maximumSummaryCharacters: 2_000,
});
const EXA_SEARCH_RESERVATION_USD = "0.007000";

const publicCommentaryConfigurationSchema = z.object({
  alerts: z.enum(["disabled", "enabled"]),
  cadenceMinutes: z.enum([
    "minutes_10", "minutes_15", "minutes_30", "minutes_60",
    "hours_1", "hours_6", "hours_12", "hours_24",
  ]),
  firstRunLookback: z.enum(["off", "hours_1", "hours_6", "hours_12", "hours_24"]).default("off"),
  includeQuotePosts: z.enum(["exclude", "include"]),
  includeReplies: z.enum(["exclude", "include"]),
  minimumConfidence: z.enum(["low", "medium", "high"]),
  minimumMateriality: z.enum(["threshold_50", "threshold_65", "threshold_80"]),
  relatedSourceSearch: z.enum(["disabled", "enabled"]),
  selectedSymbols: z.array(marketSymbolSchema).max(32),
  timezone: z.string().min(1).max(100),
}).strict();

type PublicCommentaryConfiguration = z.infer<typeof publicCommentaryConfigurationSchema>;

export function partitionPublicCommentaryStatements<T>(values: readonly T[]): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.batchSize) {
    batches.push(values.slice(offset, offset + PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.batchSize));
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

const confidenceRank = { high: 3, low: 1, medium: 2 } as const;

function semanticCitations(payload: CommentarySemanticPayload) {
  return [
    ...payload.facts.flatMap(({ citations }) => citations),
    ...payload.inferences.flatMap(({ citations }) => citations),
    ...payload.counterevidence.flatMap(({ citations }) => citations),
    ...payload.recommendation.citations,
    ...(payload.forecast ? [
      ...payload.forecast.likelyImplication.citations,
      ...payload.forecast.scenarios.flatMap(({ citations }) => citations),
      ...payload.forecast.catalysts.flatMap(({ citations }) => citations),
      ...payload.forecast.risks.flatMap(({ citations }) => citations),
      ...payload.forecast.invalidationConditions.flatMap(({ citations }) => citations),
    ] : []),
  ];
}

export function readAttestedCommentarySemanticResult(input: {
  readonly allowedAdapterIds?: readonly string[];
  readonly pack?: Readonly<{ contentDigest: string; id: string; version: string }>;
  readonly result: HybridAcceptedResult;
  readonly scope: AuthorizedWorkspaceStoreScope;
}): CommentarySemanticPayload {
  const result = hybridAcceptedResultSchema.parse(input.result);
  const definition = createCommentarySemanticDefinition([result.model.modelId], {
    allowedAdapterIds: input.allowedAdapterIds,
  });
  const passedValidator = result.validationTrace.some((trace) =>
    trace.outcome === "passed" && trace.errorCode === null &&
    trace.validatorId === definition.requiredValidator.validatorId &&
    trace.validatorVersion === definition.requiredValidator.version);
  if (
    result.purpose !== "semantic_interpretation" ||
    result.definition.definitionId !== definition.definitionId ||
    result.definition.definitionVersion !== definition.definitionVersion ||
    result.definition.definitionDigest !== definition.definitionDigest ||
    result.scope.kind !== "workspace" ||
    result.scope.ownerId !== input.scope.ownerId ||
    result.scope.workspaceId !== input.scope.workspaceId ||
    (input.pack !== undefined && (
      result.scope.packContentDigest !== input.pack.contentDigest ||
      result.scope.packId !== input.pack.id ||
      result.scope.packVersion !== input.pack.version
    )) ||
    result.outputDigest !== digestHybridEvidenceValue(result.payload) ||
    !passedValidator
  ) throw new Error("public_commentary_semantic_attestation_invalid");
  return commentarySemanticPayloadSchema.parse(result.payload);
}

function interpretation(payload: CommentarySemanticPayload, statementRevisionId: string) {
  return commentaryInterpretationSchema.parse({
    assumptions: payload.assumptions,
    confidence: payload.confidence,
    counterevidence: payload.counterevidence.map(({ statement }) => statement),
    horizon: payload.horizon,
    implications: payload.forecast ? [payload.forecast.likelyImplication.statement] : [],
    interpretationId: `commentary-interpretation.${digestPublicCommentaryValue([statementRevisionId, payload])}`,
    invalidationConditions: payload.forecast?.invalidationConditions.map(({ statement }) => statement) ?? [],
    recordType: "commentary_interpretation",
    risks: payload.forecast?.risks.map(({ statement }) => statement) ?? [],
    scenarios: payload.forecast?.scenarios.map(({ citations: _citations, ...scenario }) => scenario) ?? [],
    schemaVersion: 1,
  });
}

function threshold(value: "threshold_50" | "threshold_65" | "threshold_80"): number {
  return Number(value.slice("threshold_".length));
}

export async function materializePublicCommentarySignal(input: {
  readonly configuration: Readonly<{
    readonly alerts: "disabled" | "enabled";
    readonly minimumConfidence: "low" | "medium" | "high";
    readonly minimumMateriality: "threshold_50" | "threshold_65" | "threshold_80";
    readonly selectedSymbols: readonly string[];
  }>;
  readonly contextSearchRevisionId: string | null;
  readonly corroboration: WebCorroborationSearch;
  readonly extractionDefinitionDigest: string;
  readonly fastModelId: string;
  readonly frontierModelId: string;
  readonly interpretationDefinitionDigest: string;
  readonly monitorId: string;
  readonly now?: Date;
  readonly ownerId: string;
  readonly pack: Readonly<{ contentDigest: string; id: string; version: string }>;
  readonly policy?: ReturnType<typeof createCommentaryPolicyDefinition>;
  readonly extraction?: z.infer<typeof commentaryExtractionSchema>;
  readonly plaintext: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly semanticResult: HybridAcceptedResult;
  readonly source: PublicCommentarySourceBinding;
  readonly statement: PublicStatement;
  readonly statementRevisionId: string;
  readonly configurationGeneration: number;
}, client?: PublicCommentaryFindingStoreClient): Promise<Readonly<{
  alertPresentation: { title: string; whyMatched: string } | null;
  genericFinding: WorkspaceFindingCandidate | null;
  record: PublicCommentaryFindingRecord;
}>> {
  const statement = publicStatementSchema.parse(input.statement);
  const semantic = readAttestedCommentarySemanticResult({
    allowedAdapterIds: [input.source.adapterId],
    pack: input.pack,
    result: input.semanticResult,
    scope: input.scope,
  });
  const corroboration = webCorroborationSearchSchema.parse(input.corroboration);
  if (
    statement.contentDigest !== digestPublicCommentaryValue(input.plaintext) ||
    statement.contentReference === null ||
    statement.lifecycle !== "final" && statement.lifecycle !== "edited"
  ) throw new Error("public_commentary_statement_not_final");
  const permitted = new Set(statement.textLocators.map(({ end, spanDigest, start }) =>
    digestPublicCommentaryValue({ end, spanDigest, start })));
  if (semanticCitations(semantic).some(({ end, spanDigest, start }) =>
    !permitted.has(digestPublicCommentaryValue({ end, spanDigest, start })))) {
    throw new Error("public_commentary_citation_invalid");
  }
  const extraction = input.extraction
    ? commentaryExtractionSchema.parse(input.extraction)
    : (await extractCommentaryMetadata({ statement, text: input.plaintext })).extraction;
  if (
    extraction.attribution !== statement.attribution ||
    extraction.evidence.some(({ end, spanDigest, start }) =>
      start < 0 || end > input.plaintext.length ||
      createHash("sha256").update(input.plaintext.slice(start, end)).digest("hex") !== spanDigest)
  ) throw new Error("public_commentary_extraction_attestation_invalid");
  const interpreted = interpretation(semantic, input.statementRevisionId);
  const registeredPolicy = input.policy ?? INVERSE_CRAMER_POLICY;
  const policy = decideCommentaryPolicy({ extraction, policy: registeredPolicy });
  const selected = input.configuration.selectedSymbols.length === 0 || extraction.targets.some(
    ({ symbol }) => symbol !== null && input.configuration.selectedSymbols.includes(symbol),
  );
  const score = Math.min(100,
    (extraction.targets.length > 0 ? 20 : 0) +
    (extraction.voiceOwnership === "speaker" ? 20 : 0) +
    (["bullish", "bearish"].includes(extraction.stance) ? 20 : 0) +
    (semantic.outcome === "accepted" ? 20 : 0) +
    (semantic.confidence === "high" ? 20 : semantic.confidence === "medium" ? 10 : 0));
  const eligible = semantic.outcome === "accepted" &&
    policy.decision.decision === "research_candidate" && selected &&
    score >= threshold(input.configuration.minimumMateriality) &&
    confidenceRank[semantic.confidence] >= confidenceRank[input.configuration.minimumConfidence] &&
    input.configuration.alerts === "enabled";
  const materiality = commentaryMaterialitySchema.parse({
    alertEligible: eligible,
    decisionReasons: eligible
      ? ["final_direct_view", "registered_policy", "configured_threshold_met"]
      : [semantic.outcome !== "accepted" ? "semantic_not_accepted" : !selected ? "target_not_selected" : "configured_threshold_not_met"],
    deterministicScore: score,
    materialityId: `commentary-materiality.${digestPublicCommentaryValue([input.statementRevisionId, score, input.configuration])}`,
    recordType: "commentary_materiality",
    schemaVersion: 1,
  });
  const outcome = semantic.outcome === "abstained" ? "abstained" as const
    : semantic.outcome === "no_view" || policy.decision.decision !== "research_candidate" ? "no_view" as const
    : "accepted" as const;
  const summary = `${policy.directionDisclosure} ${semantic.rationale}`;
  const finding = commentaryFindingSchema.parse({
    analysisIdentity: {
      budgetAttempt: 1,
      configurationGeneration: input.configurationGeneration,
      contextSearchRevisionId: input.contextSearchRevisionId,
      evidenceRoleBindingDigests: [digestPublicCommentaryValue(statement.textLocators)],
      extractionDefinitionDigest: input.extractionDefinitionDigest,
      fastModelId: input.fastModelId,
      frontierModelId: input.frontierModelId,
      interpretationDefinitionDigest: input.interpretationDefinitionDigest,
      monitorId: input.monitorId,
      ownerId: input.ownerId,
      pack: input.pack,
      policyDigest: registeredPolicy.policy.definitionDigest,
      statementRevisionId: input.statementRevisionId,
      workspaceId: input.scope.workspaceId,
    },
    citations: [{
      canonicalUrl: statement.canonicalUrl,
      contentRevision: statement.revision,
      stableStatementId: publicStatementStableId(statement),
    }],
    confidence: semantic.confidence,
    findingId: `commentary-finding.${digestPublicCommentaryValue([input.scope.workspaceId, input.statementRevisionId, registeredPolicy.policy.definitionDigest, semantic])}`,
    interpretationId: interpreted.interpretationId,
    materiality,
    outcome,
    policyDecision: policy.decision,
    recordType: "public_commentary_finding",
    schemaVersion: 1,
    statementRevisionId: input.statementRevisionId,
    summary,
  });
  const record = await persistPublicCommentaryFinding(input.scope, {
    correction: null,
    corroboration,
    createdAt: (input.now ?? new Date()).toISOString(),
    directionDisclosure: policy.directionDisclosure,
    extraction,
    finding,
    interpretation: interpreted,
    ownerId: input.scope.ownerId,
    policyDisplayName: registeredPolicy.displayName,
    rawContentIncluded: false,
    recordType: "public_commentary_finding_record",
    schemaVersion: 1,
    source: input.source,
    statement,
    workspaceId: input.scope.workspaceId,
  }, client);
  if (!eligible) return Object.freeze({ alertPresentation: null, genericFinding: null, record });
  const direction = policy.decision.researchDirection!;
  const whyMatched = [
    `Direction: ${direction}.`,
    `Rationale: ${semantic.rationale}`,
    `Confidence: ${semantic.confidence}. Horizon: ${semantic.horizon}.`,
    `Related coverage: ${corroboration.status}.`,
    `Primary citation: ${statement.canonicalUrl} revision ${statement.revision}.`,
    policy.directionDisclosure,
  ].join(" ");
  const source = {
    accessClassification: input.source.accessClassification,
    canonicalUrl: input.source.canonicalUrl,
    origin: input.source.origin,
    sourceId: input.source.sourceId,
  };
  return Object.freeze({
    alertPresentation: { title: `${registeredPolicy.displayName} · ${extraction.targets[0]?.symbol ?? "public commentary"}`, whyMatched },
    genericFinding: {
      accessClassification: "public",
      artifactRefs: [finding.findingId, finding.statementRevisionId, finding.interpretationId],
      asOf: statement.publishedAt,
      factIdentities: [finding.findingId],
      facts: [{
        filingIdentity: finding.findingId,
        finding,
        kind: "public_commentary_signal",
        observedAt: statement.observedAt,
        schemaVersion: 1,
        source,
      }],
      provenance: [source],
      summary: whyMatched,
    },
    record,
  });
}

export async function materializePublicCommentaryCorrection(input: {
  readonly current: PublicCommentaryFindingRecord;
  readonly lifecycle: "deleted" | "edited" | "protected" | "withheld";
  readonly now?: Date;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly sourceRevision: number;
}, client?: PublicCommentaryFindingStoreClient): Promise<Readonly<{
  alertPresentation: { title: string; whyMatched: string };
  genericFinding: WorkspaceFindingCandidate;
  record: PublicCommentaryFindingRecord;
}>> {
  const reason = `source_${input.lifecycle}` as const;
  const rootFindingId = input.current.correction?.rootFindingId ?? input.current.finding.findingId;
  const rootStatementRevisionId = input.current.correction?.rootStatementRevisionId ??
    input.current.finding.statementRevisionId;
  const stableStatementId = publicStatementStableId(input.current.statement);
  const statementRevisionId = `statement.${input.current.statement.provider}.${stableStatementId}.${input.sourceRevision}`;
  const revokedContentDigest = digestPublicCommentaryValue([
    "public-commentary-content-revoked",
    stableStatementId,
    input.sourceRevision,
    input.lifecycle,
  ]);
  const correction = commentaryCorrectionSchema.parse({
    correctionId: `commentary-correction.${digestPublicCommentaryValue([input.current.finding.findingId, reason, input.sourceRevision])}`,
    deduplicationKey: digestPublicCommentaryValue([input.current.finding.findingId, reason, input.sourceRevision]),
    findingId: input.current.finding.findingId,
    invalidatesRecommendation: true,
    reason,
    recordType: "public_commentary_correction",
    rootFindingId,
    rootStatementRevisionId,
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
    supersedesStatementRevisionId: input.current.finding.statementRevisionId,
  });
  const finding = commentaryFindingSchema.parse({
    ...input.current.finding,
    analysisIdentity: {
      ...input.current.finding.analysisIdentity,
      contextSearchRevisionId: null,
      evidenceRoleBindingDigests: [digestPublicCommentaryValue([])],
      statementRevisionId,
    },
    citations: input.current.finding.citations.map((citation) => ({
      ...citation,
      contentRevision: input.sourceRevision,
    })),
    confidence: "low",
    findingId: `commentary-finding.${digestPublicCommentaryValue([input.current.finding.findingId, correction.correctionId])}`,
    interpretationId: `commentary-interpretation.revoked.${digestPublicCommentaryValue([
      statementRevisionId,
      correction.correctionId,
    ])}`,
    materiality: {
      ...input.current.finding.materiality,
      alertEligible: false,
      decisionReasons: ["source_correction"],
      deterministicScore: 0,
      materialityId: `commentary-materiality.${correction.deduplicationKey}`,
    },
    outcome: input.lifecycle === "deleted" || input.lifecycle === "protected" || input.lifecycle === "withheld"
      ? "retracted"
      : "corrected",
    policyDecision: {
      ...input.current.finding.policyDecision,
      decision: "no_view",
      decisionId: `commentary-policy-decision.revoked.${correction.deduplicationKey}`,
      inputDigest: revokedContentDigest,
      rationaleCodes: ["source_correction"],
      researchDirection: null,
    },
    statementRevisionId,
    summary: `Prior research candidate invalidated because the source was ${input.lifecycle}.`,
  });
  const statement = publicStatementSchema.parse({
    ...input.current.statement,
    contentDigest: revokedContentDigest,
    contentReference: null,
    entities: { cashtags: [], mentions: [], urls: [] },
    lifecycle: input.lifecycle,
    observedAt: (input.now ?? new Date()).toISOString(),
    ...(input.current.statement.provider === "x" ? {
      editableUntil: null,
      references: { ...input.current.statement.references, referencedPostIds: [] },
    } : {
      document: {
        ...input.current.statement.document,
        revisionIds: [...input.current.statement.document.revisionIds, revokedContentDigest],
      },
    }),
    revision: input.sourceRevision,
    textLocators: [],
  });
  const record = await persistPublicCommentaryFinding(input.scope, {
    ...input.current,
    correction,
    createdAt: (input.now ?? new Date()).toISOString(),
    directionDisclosure: null,
    extraction: null,
    finding,
    interpretation: null,
    statement,
  }, client);
  const whyMatched = `${finding.summary} No active research direction remains. Primary citation: ${statement.canonicalUrl} revision ${statement.revision}.`;
  const source = {
    accessClassification: input.current.source.accessClassification,
    canonicalUrl: input.current.source.canonicalUrl,
    origin: input.current.source.origin,
    sourceId: input.current.source.sourceId,
  };
  return Object.freeze({
    alertPresentation: {
      title: `${input.current.policyDisplayName} · source correction`,
      whyMatched,
    },
    genericFinding: {
      accessClassification: "public",
      artifactRefs: [finding.findingId, finding.statementRevisionId, correction.correctionId],
      asOf: (input.now ?? new Date()).toISOString(),
      factIdentities: [finding.findingId],
      facts: [{
        filingIdentity: finding.findingId,
        finding,
        kind: "public_commentary_signal",
        observedAt: (input.now ?? new Date()).toISOString(),
        schemaVersion: 1,
        source,
      }],
      provenance: [source],
      summary: whyMatched,
    },
    record,
  });
}

export interface PublicCommentaryProjectedStatement {
  readonly plaintext: string;
  readonly source: PublicCommentarySourceBinding;
  readonly statement: PublicStatement;
  readonly statementRevisionId: string;
}

type PublicCommentarySemanticRun = Pick<
  WorkspaceSemanticEvidenceBundleRunResult,
  "evidence" | "record" | "strategyEvidence"
>;

export function publicCommentaryStatementAttemptId(input: {
  readonly configurationGeneration: number;
  readonly queryDigest: string;
  readonly statementRevisionId: string;
}): string {
  return `commentary-attempt.${digestPublicCommentaryValue([
    input.configurationGeneration,
    input.queryDigest,
    input.statementRevisionId,
  ])}`;
}

function localCorroboration(input: {
  readonly now: Date;
  readonly queryDigest: string;
  readonly status: "not_run" | "unavailable";
}) {
  return webCorroborationSearchSchema.parse({
    completeness: input.status === "not_run" ? "complete" : "unknown",
    cost: { amountUsd: "0.000000", billableUnits: 0, currency: "USD" },
    provider: "exa",
    queriedAt: input.now.toISOString(),
    queryDigest: input.queryDigest,
    recordType: "web_corroboration_search",
    requestId: `exa-local.${digestPublicCommentaryValue([input.queryDigest, input.now.toISOString(), input.status])}`,
    results: [],
    schemaVersion: 1,
    status: input.status,
  });
}

async function settleCorroborationBudget(input: Readonly<{
  corroboration: WebCorroborationSearch;
  now: Date;
  runId: string;
  scope: AuthorizedWorkspaceStoreScope;
}>, client?: WorkspaceBudgetLedgerClient): Promise<void> {
  if (input.corroboration.status === "not_run" || input.corroboration.status === "not_applicable") return;
  const ledger = await readWorkspaceBudgetLedger(input.scope, client);
  const reservation = ledger.reservations.find(({ runId }) => runId === input.runId);
  if (!reservation || reservation.state === "reconciled" || reservation.state === "released") return;
  const outcome = input.corroboration.status === "unavailable" ? "uncertain" as const
    : "reconciled" as const;
  await reconcileWorkspaceRunBudget({
    ...(outcome === "reconciled" ? {
      actualInputTokens: 0,
      actualOutputTokens: 0,
      actualPaidCost: input.corroboration.cost.amountUsd,
    } : {}),
    now: input.now,
    outcome,
    runId: input.runId,
    scope: input.scope,
  }, client);
}

async function runBudgetedCorroboration(input: {
  readonly attemptId: string;
  readonly configuration: PublicCommentaryConfiguration;
  readonly configurationGeneration: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly now: Date;
  readonly provider: WebCorroborationProvider;
  readonly query: ReturnType<typeof compileWebCorroborationQuery>;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly statementRevisionId: string;
}, clients: {
  readonly attempts?: PublicCommentaryAttemptStoreClient;
  readonly budget?: WorkspaceBudgetLedgerClient;
  readonly state?: WorkspaceStateStoreClient;
}): Promise<WebCorroborationSearch> {
  const cached = await readPublicCommentaryCorroborationAttempt(
    input.scope,
    input.attemptId,
    clients.attempts,
  );
  if (cached) {
    if (
      cached.configurationGeneration !== input.configurationGeneration ||
      cached.queryDigest !== input.query.queryDigest ||
      cached.statementRevisionId !== input.statementRevisionId
    ) throw new Error("public_commentary_attempt_conflict");
    await settleCorroborationBudget({
      corroboration: cached.corroboration,
      now: input.now,
      runId: input.attemptId,
      scope: input.scope,
    }, clients.budget);
    return cached.corroboration;
  }
  const flags = resolvePublicCommentaryRuntimeFlags(input.environment);
  const ownerEnabled = input.configuration.relatedSourceSearch === "enabled";
  if (!ownerEnabled || !flags.corroborationEnabled) {
    const corroboration = localCorroboration({
      now: input.now,
      queryDigest: input.query.queryDigest,
      status: "not_run",
    });
    await persistPublicCommentaryCorroborationAttempt(input.scope, {
      attemptId: input.attemptId,
      configurationGeneration: input.configurationGeneration,
      corroboration,
      ownerId: input.scope.ownerId,
      queryDigest: input.query.queryDigest,
      recordType: "public_commentary_corroboration_attempt",
      schemaVersion: 1,
      statementRevisionId: input.statementRevisionId,
      workspaceId: input.scope.workspaceId,
    }, clients.attempts);
    return corroboration;
  }

  const budget = await readWorkspaceDocument("budget", input.scope, clients.state);
  if (!budget) throw new Error("public_commentary_budget_policy_unresolved");
  const ledger = await readWorkspaceBudgetLedger(input.scope, clients.budget);
  const existing = ledger.reservations.find(({ runId }) => runId === input.attemptId);
  if (existing) {
    if (existing.state === "reserved") {
      await reconcileWorkspaceRunBudget({
        now: input.now,
        outcome: "uncertain",
        runId: input.attemptId,
        scope: input.scope,
      }, clients.budget);
    }
    const corroboration = localCorroboration({
      now: input.now,
      queryDigest: input.query.queryDigest,
      status: "unavailable",
    });
    await persistPublicCommentaryCorroborationAttempt(input.scope, {
      attemptId: input.attemptId,
      configurationGeneration: input.configurationGeneration,
      corroboration,
      ownerId: input.scope.ownerId,
      queryDigest: input.query.queryDigest,
      recordType: "public_commentary_corroboration_attempt",
      schemaVersion: 1,
      statementRevisionId: input.statementRevisionId,
      workspaceId: input.scope.workspaceId,
    }, clients.attempts);
    return corroboration;
  }

  await reserveWorkspaceRunBudget({
    inputTokens: 0,
    kind: "hybrid_model_attempt",
    now: input.now,
    outputTokens: 0,
    paidCostCeiling: { amount: EXA_SEARCH_RESERVATION_USD, kind: "known" },
    policy: budget.value,
    policyRevision: budget.revision,
    runId: input.attemptId,
    scope: input.scope,
  }, clients.budget);
  let corroboration: WebCorroborationSearch;
  try {
    corroboration = await input.provider.search({
      budgetAuthorized: true,
      enabled: true,
      now: input.now,
      query: input.query,
    });
    await persistPublicCommentaryCorroborationAttempt(input.scope, {
      attemptId: input.attemptId,
      configurationGeneration: input.configurationGeneration,
      corroboration,
      ownerId: input.scope.ownerId,
      queryDigest: input.query.queryDigest,
      recordType: "public_commentary_corroboration_attempt",
      schemaVersion: 1,
      statementRevisionId: input.statementRevisionId,
      workspaceId: input.scope.workspaceId,
    }, clients.attempts);
  } catch (error) {
    await reconcileWorkspaceRunBudget({
      now: input.now,
      outcome: "uncertain",
      runId: input.attemptId,
      scope: input.scope,
    }, clients.budget);
    throw error;
  }
  await settleCorroborationBudget({
    corroboration,
    now: input.now,
    runId: input.attemptId,
    scope: input.scope,
  }, clients.budget);
  return corroboration;
}

export function createPublicCommentaryPipeline(input: {
  readonly acquireAndProject: (request: Readonly<{
    firstRunLookback: PublicCommentaryConfiguration["firstRunLookback"];
    scope: AuthorizedWorkspaceStoreScope;
    window: Readonly<{ endAt: string; startAt: string }>;
  }>) => Promise<Readonly<{
    checkpoint: Readonly<{ contentDigest: string; watermark: string }>;
    statements: readonly PublicCommentaryProjectedStatement[];
  }>>;
  readonly attempts?: PublicCommentaryAttemptStoreClient;
  readonly budget?: WorkspaceBudgetLedgerClient;
  readonly corroboration: WebCorroborationProvider;
  readonly findings?: PublicCommentaryFindingStoreClient;
  readonly policy?: ReturnType<typeof createCommentaryPolicyDefinition>;
  readonly recoverExtraction?: Parameters<typeof extractCommentaryMetadata>[0]["recover"];
  readonly state?: WorkspaceStateStoreClient;
  readonly interpret: (request: Readonly<{
    attemptId: string;
    corroboration: WebCorroborationSearch;
    plaintext: string;
    statement: PublicStatement;
    statementRevisionId: string;
  }>) => Promise<PublicCommentarySemanticRun>;
}) {
  return Object.freeze({
    async run(request: Readonly<{
      configuration: Readonly<Record<string, unknown>>;
      configurationGeneration: number;
      environment: NodeJS.ProcessEnv;
      monitorId: string;
      ownerId: string;
      pack: Readonly<{ contentDigest: string; id: string; version: string }>;
      scope: AuthorizedWorkspaceStoreScope;
      window: Readonly<{ endAt: string; startAt: string }>;
    }>) {
      const configuration = publicCommentaryConfigurationSchema.parse(request.configuration);
      const acquired = await input.acquireAndProject({
        firstRunLookback: configuration.firstRunLookback,
        scope: request.scope,
        window: request.window,
      });
      const occurrenceId = `commentary-occurrence.${digestPublicCommentaryValue([
        request.monitorId,
        request.configurationGeneration,
        request.window,
        acquired.checkpoint,
      ])}`;
      const quarantineOverflow = async (
        reason: "facts_overflow" | "statements_overflow" | "summary_overflow",
      ) => persistPublicCommentaryOccurrenceQuarantine(request.scope, {
        configurationGeneration: request.configurationGeneration,
        createdAt: request.window.endAt,
        observedStatements: acquired.statements.length,
        occurrenceId,
        ownerId: request.scope.ownerId,
        reason,
        recordType: "public_commentary_occurrence_quarantine",
        schemaVersion: 1,
        workspaceId: request.scope.workspaceId,
      }, input.attempts);
      if (acquired.statements.length > PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.maximumStatements) {
        await quarantineOverflow("statements_overflow");
        throw new Error("public_commentary_occurrence_statements_overflow");
      }
      const accepted: Awaited<ReturnType<typeof materializePublicCommentarySignal>>[] = [];
      for (const batch of partitionPublicCommentaryStatements(acquired.statements)) {
        const prepared = await Promise.allSettled(batch.map(async (projected) => {
          const statement = publicStatementSchema.parse(projected.statement);
          if (
            publicStatementRole(statement) === "repost" ||
            (publicStatementRole(statement) === "reply" && configuration.includeReplies === "exclude") ||
            (publicStatementRole(statement) === "quote" && configuration.includeQuotePosts === "exclude")
          ) return null;
          const extraction = (await extractCommentaryMetadata({
            environment: request.environment,
            recover: input.recoverExtraction,
            statement,
            text: projected.plaintext,
          })).extraction;
          const targetTerms = extraction.targets.flatMap(({ displayName, symbol }) =>
            symbol ? [symbol] : [displayName]).slice(0, 8);
          const query = compileWebCorroborationQuery({
            endPublishedAt: request.window.endAt,
            publicTargetTerms: targetTerms.length ? targetTerms : [projected.statement.speaker.displayLabel],
            publicTopicTerms: [],
            startPublishedAt: request.window.startAt,
          });
          const attemptId = publicCommentaryStatementAttemptId({
            configurationGeneration: request.configurationGeneration,
            queryDigest: query.queryDigest,
            statementRevisionId: projected.statementRevisionId,
          });
          const corroboration = await runBudgetedCorroboration({
            attemptId,
            configuration,
            configurationGeneration: request.configurationGeneration,
            environment: request.environment,
            now: new Date(request.window.endAt),
            provider: input.corroboration,
            query,
            scope: request.scope,
            statementRevisionId: projected.statementRevisionId,
          }, { attempts: input.attempts, budget: input.budget, state: input.state });
          const semanticRun = await input.interpret({
            attemptId,
            corroboration,
            plaintext: projected.plaintext,
            statement,
            statementRevisionId: projected.statementRevisionId,
          });
          if (semanticRun.record.job.state === "quarantined" || semanticRun.evidence === null) {
            return null;
          }
          return Object.freeze({
            corroboration,
            extraction,
            projected,
            semanticResult: semanticRun.evidence.result,
            statement,
          });
        }));
        const rejected = prepared.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
        for (const result of prepared) {
          if (result.status !== "fulfilled" || result.value === null) continue;
          const { corroboration, extraction, projected, semanticResult, statement } = result.value;
          accepted.push(await materializePublicCommentarySignal({
            configuration: {
              alerts: configuration.alerts,
              minimumConfidence: configuration.minimumConfidence,
              minimumMateriality: configuration.minimumMateriality,
              selectedSymbols: configuration.selectedSymbols,
            },
            configurationGeneration: request.configurationGeneration,
            contextSearchRevisionId: corroboration.requestId,
            corroboration,
            extractionDefinitionDigest: digestPublicCommentaryValue(["commentary-extraction", "1.0.0"]),
            fastModelId: request.environment.EVE_HYBRID_FAST_MODEL_ID ?? "anthropic/claude-haiku-4.5",
            frontierModelId: semanticResult.model.modelId,
            interpretationDefinitionDigest: semanticResult.definition.definitionDigest,
            monitorId: request.monitorId,
            now: new Date(request.window.endAt),
            ownerId: request.ownerId,
            pack: request.pack,
            policy: input.policy,
            extraction,
            plaintext: projected.plaintext,
            scope: request.scope,
            semanticResult,
            source: projected.source,
            statement,
            statementRevisionId: projected.statementRevisionId,
          }, input.findings));
        }
      }
      const allMaterial = accepted.filter(({ genericFinding }) => genericFinding !== null);
      const material = allMaterial.slice(0, PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.maximumFacts);
      const facts = material.flatMap(({ genericFinding }) => genericFinding!.facts ?? [])
        .slice(0, PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.maximumFacts);
      const factIdentities = material.flatMap(({ genericFinding }) => genericFinding!.factIdentities)
        .slice(0, PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.maximumFactIdentities);
      const aggregateSummary = allMaterial.length === 0 ? null : [
        `${allMaterial.length} validated public-commentary research candidate${allMaterial.length === 1 ? "" : "s"}.`,
        `Statement findings: ${factIdentities.join(", ")}.`,
      ].join(" ");
      if (aggregateSummary && aggregateSummary.length > PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.maximumSummaryCharacters) {
        await quarantineOverflow("summary_overflow");
        throw new Error("public_commentary_occurrence_summary_overflow");
      }
      const finding = material.length === 0 ? null : workspaceFindingCandidateSchema.parse({
        accessClassification: "public",
        artifactRefs: material.flatMap(({ genericFinding }) => genericFinding!.artifactRefs).slice(0, 8),
        asOf: material.map(({ genericFinding }) => genericFinding!.asOf).sort().at(-1)!,
        factIdentities,
        facts,
        provenance: material.flatMap(({ genericFinding }) => genericFinding!.provenance).filter((source, index, values) =>
          values.findIndex((candidate) => candidate.sourceId === source.sourceId && candidate.canonicalUrl === source.canonicalUrl) === index),
        summary: aggregateSummary,
      });
      return Object.freeze({
        alertPresentation: allMaterial.find(({ alertPresentation }) => alertPresentation !== null)?.alertPresentation ?? null,
        analyzedStatements: acquired.statements.length,
        checkpoint: acquired.checkpoint,
        finding,
      });
    },
  });
}
