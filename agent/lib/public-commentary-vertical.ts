import {
  createCommentaryPolicyDefinition,
  decideCommentaryPolicy,
} from "./commentary-policy";
import {
  commentaryCorrectionSchema,
  commentaryFindingSchema,
  commentaryInterpretationSchema,
  commentaryMaterialitySchema,
  digestPublicCommentaryValue,
  publicStatementSchema,
  webCorroborationSearchSchema,
  type PublicStatement,
  type WebCorroborationSearch,
} from "./public-commentary-schema";
import {
  extractCommentaryMetadata,
  commentarySemanticPayloadSchema,
  type CommentarySemanticPayload,
} from "./public-commentary-semantics";
import {
  persistPublicCommentaryFinding,
  type PublicCommentaryFindingRecord,
  type PublicCommentaryFindingStoreClient,
} from "./public-commentary-finding-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import { workspaceFindingCandidateSchema, type WorkspaceFindingCandidate } from "./workspace-finding-store";
import { X_PUBLIC_STATEMENTS_SOURCE_URL } from "./strategy-pack-reference-catalog";
import type { WebCorroborationProvider } from "./web-corroboration-search";
import { compileWebCorroborationQuery } from "./web-corroboration-search";

export const INVERSE_CRAMER_POLICY = createCommentaryPolicyDefinition({
  displayName: "Inverse Cramer",
  policyId: "commentary-direction-inversion",
  policyVersion: "1.0.0",
  transformId: "invert-bullish-bearish",
  transformVersion: "1.0.0",
});

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
  readonly pack: Readonly<{ contentDigest: string; id: "inverse-cramer"; version: "1.0.0" }>;
  readonly plaintext: string;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly semantic: CommentarySemanticPayload;
  readonly statement: PublicStatement;
  readonly statementRevisionId: string;
  readonly configurationGeneration: number;
}, client?: PublicCommentaryFindingStoreClient): Promise<Readonly<{
  alertPresentation: { title: string; whyMatched: string } | null;
  genericFinding: WorkspaceFindingCandidate | null;
  record: PublicCommentaryFindingRecord;
}>> {
  const statement = publicStatementSchema.parse(input.statement);
  const semantic = commentarySemanticPayloadSchema.parse(input.semantic);
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
  const extraction = (await extractCommentaryMetadata({ statement, text: input.plaintext })).extraction;
  const interpreted = interpretation(semantic, input.statementRevisionId);
  const policy = decideCommentaryPolicy({ extraction, policy: INVERSE_CRAMER_POLICY });
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
      policyDigest: INVERSE_CRAMER_POLICY.policy.definitionDigest,
      statementRevisionId: input.statementRevisionId,
      workspaceId: input.scope.workspaceId,
    },
    citations: [{
      canonicalUrl: statement.canonicalUrl,
      contentRevision: statement.revision,
      stablePostId: statement.stablePostId,
    }],
    confidence: semantic.confidence,
    findingId: `commentary-finding.${digestPublicCommentaryValue([input.scope.workspaceId, input.statementRevisionId, INVERSE_CRAMER_POLICY.policy.definitionDigest, semantic])}`,
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
    rawContentIncluded: false,
    recordType: "public_commentary_finding_record",
    schemaVersion: 1,
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
    accessClassification: "public" as const,
    canonicalUrl: X_PUBLIC_STATEMENTS_SOURCE_URL,
    origin: "https://api.x.com" as const,
    sourceId: "x-jim-cramer-public-statements" as const,
  };
  return Object.freeze({
    alertPresentation: { title: `Inverse Cramer · ${extraction.targets[0]?.symbol ?? "public commentary"}`, whyMatched },
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
  const correction = commentaryCorrectionSchema.parse({
    correctionId: `commentary-correction.${digestPublicCommentaryValue([input.current.finding.findingId, reason, input.sourceRevision])}`,
    deduplicationKey: digestPublicCommentaryValue([input.current.finding.findingId, reason, input.sourceRevision]),
    findingId: input.current.finding.findingId,
    invalidatesRecommendation: true,
    reason,
    recordType: "public_commentary_correction",
    schemaVersion: 1,
    sourceRevision: input.sourceRevision,
  });
  const finding = commentaryFindingSchema.parse({
    ...input.current.finding,
    findingId: `commentary-finding.${digestPublicCommentaryValue([input.current.finding.findingId, correction.correctionId])}`,
    materiality: {
      ...input.current.finding.materiality,
      alertEligible: false,
      decisionReasons: ["source_correction"],
      materialityId: `commentary-materiality.${correction.deduplicationKey}`,
    },
    outcome: input.lifecycle === "deleted" || input.lifecycle === "protected" || input.lifecycle === "withheld"
      ? "retracted"
      : "corrected",
    summary: `Prior research candidate invalidated because the source was ${input.lifecycle}.`,
  });
  const record = await persistPublicCommentaryFinding(input.scope, {
    ...input.current,
    correction,
    createdAt: (input.now ?? new Date()).toISOString(),
    finding,
  }, client);
  const whyMatched = `${finding.summary} Primary citation: ${input.current.statement.canonicalUrl} revision ${input.current.statement.revision}.`;
  const source = {
    accessClassification: "public" as const,
    canonicalUrl: X_PUBLIC_STATEMENTS_SOURCE_URL,
    origin: "https://api.x.com" as const,
    sourceId: "x-jim-cramer-public-statements" as const,
  };
  return Object.freeze({
    alertPresentation: {
      title: "Inverse Cramer · source correction",
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
  readonly statement: PublicStatement;
  readonly statementRevisionId: string;
}

export function createPublicCommentaryPipeline(input: {
  readonly acquireAndProject: (request: Readonly<{
    scope: AuthorizedWorkspaceStoreScope;
    window: Readonly<{ endAt: string; startAt: string }>;
  }>) => Promise<Readonly<{
    checkpoint: Readonly<{ contentDigest: string; watermark: string }>;
    statements: readonly PublicCommentaryProjectedStatement[];
  }>>;
  readonly corroboration: WebCorroborationProvider;
  readonly findings?: PublicCommentaryFindingStoreClient;
  readonly interpret: (request: Readonly<{
    corroboration: WebCorroborationSearch;
    plaintext: string;
    statement: PublicStatement;
    statementRevisionId: string;
  }>) => Promise<CommentarySemanticPayload>;
}) {
  return Object.freeze({
    async run(request: Readonly<{
      configuration: Readonly<Record<string, unknown>>;
      configurationGeneration: number;
      environment: NodeJS.ProcessEnv;
      monitorId: string;
      ownerId: string;
      pack: Readonly<{ contentDigest: string; id: "inverse-cramer"; version: string }>;
      scope: AuthorizedWorkspaceStoreScope;
      window: Readonly<{ endAt: string; startAt: string }>;
    }>) {
      const acquired = await input.acquireAndProject({ scope: request.scope, window: request.window });
      const accepted: Awaited<ReturnType<typeof materializePublicCommentarySignal>>[] = [];
      for (const projected of acquired.statements) {
        const extraction = (await extractCommentaryMetadata({
          statement: projected.statement,
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
        const corroboration = await input.corroboration.search({
          budgetAuthorized: request.configuration.relatedSourceSearch === "enabled",
          enabled: request.configuration.relatedSourceSearch === "enabled",
          query,
        });
        const semantic = await input.interpret({
          corroboration,
          plaintext: projected.plaintext,
          statement: projected.statement,
          statementRevisionId: projected.statementRevisionId,
        });
        const minimumConfidence = request.configuration.minimumConfidence;
        const minimumMateriality = request.configuration.minimumMateriality;
        const alerts = request.configuration.alerts;
        const selectedSymbols = request.configuration.selectedSymbols;
        if (
          !["low", "medium", "high"].includes(String(minimumConfidence)) ||
          !["threshold_50", "threshold_65", "threshold_80"].includes(String(minimumMateriality)) ||
          !["disabled", "enabled"].includes(String(alerts)) ||
          !Array.isArray(selectedSymbols) || selectedSymbols.some((value) => typeof value !== "string")
        ) throw new Error("public_commentary_configuration_invalid");
        accepted.push(await materializePublicCommentarySignal({
          configuration: {
            alerts: alerts as "disabled" | "enabled",
            minimumConfidence: minimumConfidence as "low" | "medium" | "high",
            minimumMateriality: minimumMateriality as "threshold_50" | "threshold_65" | "threshold_80",
            selectedSymbols,
          },
          configurationGeneration: request.configurationGeneration,
          contextSearchRevisionId: corroboration.requestId,
          corroboration,
          extractionDefinitionDigest: digestPublicCommentaryValue(["commentary-extraction", "1.0.0"]),
          fastModelId: request.environment.EVE_HYBRID_FAST_MODEL_ID ?? "anthropic/claude-haiku-4.5",
          frontierModelId: request.environment.EVE_HYBRID_FRONTIER_MODEL_ID ?? "openai/gpt-5.4",
          interpretationDefinitionDigest: digestPublicCommentaryValue(["public-commentary-semantic-interpretation", "1.0.0"]),
          monitorId: request.monitorId,
          ownerId: request.ownerId,
          pack: { ...request.pack, version: "1.0.0" },
          plaintext: projected.plaintext,
          scope: request.scope,
          semantic,
          statement: projected.statement,
          statementRevisionId: projected.statementRevisionId,
        }, input.findings));
      }
      const material = accepted.filter(({ genericFinding }) => genericFinding !== null);
      const finding = material.length === 0 ? null : workspaceFindingCandidateSchema.parse({
        accessClassification: "public",
        artifactRefs: material.flatMap(({ genericFinding }) => genericFinding!.artifactRefs).slice(0, 8),
        asOf: material.map(({ genericFinding }) => genericFinding!.asOf).sort().at(-1)!,
        factIdentities: material.flatMap(({ genericFinding }) => genericFinding!.factIdentities),
        facts: material.flatMap(({ genericFinding }) => genericFinding!.facts ?? []),
        provenance: material.flatMap(({ genericFinding }) => genericFinding!.provenance).filter((source, index, values) =>
          values.findIndex((candidate) => candidate.sourceId === source.sourceId && candidate.canonicalUrl === source.canonicalUrl) === index),
        summary: material.map(({ genericFinding }) => genericFinding!.summary).join("\n"),
      });
      return Object.freeze({
        alertPresentation: material[0]?.alertPresentation ?? null,
        analyzedStatements: acquired.statements.length,
        checkpoint: acquired.checkpoint,
        finding,
      });
    },
  });
}
