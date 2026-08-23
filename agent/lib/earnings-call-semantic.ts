import { createHash } from "node:crypto";

import {
  earningsCallComparisonPlannerLimits,
  earningsCallComparisonSessionOptions,
  EARNINGS_CALL_COMPARISON_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SECTION_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID,
  EARNINGS_CALL_SEMANTIC_SIGNED_RUNTIME_MS,
  EARNINGS_CALL_SEMANTIC_SESSION_OUTPUT_TOKENS,
  createEarningsCallComparisonDefinitions,
} from "./hybrid-evidence-definition-registry";
import {
  runWorkspaceSemanticEvidenceBundleJob,
  type WorkspaceSemanticEvidenceBundleInputMember,
  type WorkspaceSemanticEvidenceBundleRunResult,
  type WorkspaceSemanticModelUsage,
} from "./hybrid-evidence-semantic";
import type { HybridModelReasoning } from "./hybrid-evidence-model-routing";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "./hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "./hybrid-evidence-lineage-store";
import type { WorkspaceSemanticEvidenceStoreClient } from "./hybrid-evidence-semantic-store";
import type {
  EvidenceArtifactManifest,
  EvidenceLocator,
  HybridEvidenceJobDefinition,
} from "./hybrid-evidence-schema";
import type { PreparedHybridEvidenceWorkerRun } from "./hybrid-evidence-worker";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import type { PublicSourceAcquisitionStoreClient } from "./public-source-acquisition-store";
import type { PublicSourceSubscriptionStoreClient } from "./public-source-subscription-store";
import type { WorkspaceMonitorStoreClient } from "./workspace-monitor-store";
import {
  createEarningsCallCitations,
} from "./earnings-call-transcript";
import {
  digestEarningsCallValue,
  earningsComparisonSchema,
  earningsTranscriptSchema,
  type EarningsComparison,
  type EarningsTranscript,
} from "./earnings-call-schema";
import { EARNINGS_CALL_POLICY } from "./earnings-call-policy";

type ComparisonRole = "current" | "prior" | "year_ago";

export interface EarningsCallSemanticEvidenceInput {
  readonly artifact: EvidenceArtifactManifest;
  readonly normalizedText: string;
  readonly projectionReference: {
    readonly factRevisionId: string;
    readonly sourceId: string;
    readonly subscriptionId: string;
  };
  readonly role: ComparisonRole;
  readonly sourceFactLocator: Extract<EvidenceLocator, { kind: "source_fact" }>;
  readonly transcript: EarningsTranscript;
}

interface PlannedSpan {
  readonly end: number;
  readonly role: ComparisonRole;
  readonly sectionId: string;
  readonly start: number;
}

type PreparedCitationSpan = Readonly<{
  citation: ReturnType<typeof createEarningsCallCitations>[number];
  evidenceSpanDigest: string;
}>;

export type EarningsCallSemanticPlannerLimits = Readonly<{
  maximumAggregateInputTokens: number;
  maximumSectionInputTokens: number;
  maximumSectionJobs: number;
  maximumSingleJobInputTokens: number;
  maximumSectionOutputTokens: number;
  maximumSynthesisInputTokens: number;
}>;

export type EarningsCallSemanticPlan = Readonly<{
  aggregateInputTokens: number;
  jobs: readonly Readonly<{ inputTokens: number; spans: readonly PlannedSpan[] }>[];
  state: "overflow" | "sectioned" | "single_job";
  synthesisInputTokens: number;
}>;

export type EarningsCallSemanticRunResult = Readonly<{
  final: WorkspaceSemanticEvidenceBundleRunResult | null;
  plan: EarningsCallSemanticPlan;
  reasonCode: "token_or_budget_overflow" | null;
  sections: readonly WorkspaceSemanticEvidenceBundleRunResult[];
  state: "abstained" | "accepted" | "quarantined";
}>;

function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

function normalizedEvidenceDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requiredSpans(evidence: readonly EarningsCallSemanticEvidenceInput[]): PlannedSpan[] {
  return evidence.flatMap(({ role, transcript }) => transcript.sections
    .filter(({ sectionKind }) =>
      sectionKind === "prepared_remarks" || sectionKind === "questions_and_answers")
    .map(({ end, sectionId, start }) => ({ end, role, sectionId, start })));
}

export function planEarningsCallSemanticComparison(
  evidence: readonly EarningsCallSemanticEvidenceInput[],
  // Defaults to the frozen policy envelope so every published version plans
  // exactly as it shipped; a version whose signed session is larger passes its
  // own limits so the planner and the definition agree on one job size.
  limits: EarningsCallSemanticPlannerLimits = EARNINGS_CALL_POLICY.semanticEnvelope,
): EarningsCallSemanticPlan {
  const spans = requiredSpans(evidence);
  const totalTokens = spans.reduce((total, span) => total + estimateTokens(span.end - span.start), 0);
  if (totalTokens <= limits.maximumSingleJobInputTokens) {
    return Object.freeze({
      aggregateInputTokens: totalTokens,
      jobs: Object.freeze([Object.freeze({ inputTokens: totalTokens, spans: Object.freeze(spans) })]),
      state: "single_job",
      synthesisInputTokens: 0,
    });
  }
  const maximumCharacters = limits.maximumSectionInputTokens * 4;
  const chunks = spans.flatMap((span) => {
    const output: PlannedSpan[] = [];
    for (let start = span.start; start < span.end; start += maximumCharacters) {
      output.push({ ...span, end: Math.min(span.end, start + maximumCharacters), start });
    }
    return output;
  });
  const jobs: { inputTokens: number; spans: PlannedSpan[] }[] = [];
  for (const span of chunks) {
    const inputTokens = estimateTokens(span.end - span.start);
    const previous = jobs.at(-1);
    if (previous && previous.inputTokens + inputTokens <= limits.maximumSectionInputTokens) {
      previous.inputTokens += inputTokens;
      previous.spans.push(span);
    } else {
      jobs.push({ inputTokens, spans: [span] });
    }
  }
  const synthesisInputTokens = jobs.length * limits.maximumSectionOutputTokens;
  const aggregateInputTokens = totalTokens + synthesisInputTokens;
  if (
    jobs.length > limits.maximumSectionJobs ||
    synthesisInputTokens > limits.maximumSynthesisInputTokens ||
    aggregateInputTokens > limits.maximumAggregateInputTokens
  ) {
    return Object.freeze({
      aggregateInputTokens,
      jobs: Object.freeze([]),
      state: "overflow",
      synthesisInputTokens,
    });
  }
  return Object.freeze({
    aggregateInputTokens,
    jobs: Object.freeze(jobs.map((job) => Object.freeze({
      inputTokens: job.inputTokens,
      spans: Object.freeze(job.spans),
    }))),
    state: "sectioned",
    synthesisInputTokens,
  });
}

function validateComparisonEvidence(
  comparisonInput: EarningsComparison,
  evidenceInput: readonly EarningsCallSemanticEvidenceInput[],
) {
  const comparison = earningsComparisonSchema.parse(comparisonInput);
  const evidence = evidenceInput.map((item) => ({
    ...item,
    transcript: earningsTranscriptSchema.parse(item.transcript),
  }));
  const byRole = new Map(evidence.map((item) => [item.role, item]));
  if (
    byRole.size !== evidence.length || !byRole.has("current") || !byRole.has("prior") ||
    (comparison.secondaryYearAgo !== null) !== byRole.has("year_ago")
  ) throw new Error("earnings_semantic_comparison_members_invalid");
  for (const role of ["current", "prior", "year_ago"] as const) {
    const item = byRole.get(role);
    const expected = role === "current" ? comparison.current
      : role === "prior" ? comparison.prior : comparison.secondaryYearAgo;
    if (!item && !expected) continue;
    if (
      !item || !expected || item.transcript.eventRevisionId !== expected.eventRevisionId ||
      item.transcript.transcriptId !== expected.transcriptId ||
      item.transcript.artifactDigest !== expected.artifactDigest ||
      item.normalizedText.length !== item.transcript.characterCount ||
      digestEarningsCallValue(item.normalizedText) !== item.transcript.normalizedTextDigest ||
      normalizedEvidenceDigest(item.normalizedText) !== item.artifact.contentDigest ||
      item.artifact.structure.characterCount !== item.normalizedText.length
    ) throw new Error("earnings_semantic_comparison_members_invalid");
  }
  return Object.freeze({ comparison, evidence: Object.freeze(evidence) });
}

function memberForSpans(input: {
  citationSpansByKey: ReadonlyMap<string, PreparedCitationSpan>;
  evidence: EarningsCallSemanticEvidenceInput;
  memberId: string;
  role: ComparisonRole | "section";
  spans: readonly PlannedSpan[];
}): WorkspaceSemanticEvidenceBundleInputMember {
  const { evidence } = input;
  const citationSpans = input.spans.map((span) => {
    const prepared = input.citationSpansByKey.get(citationSpanKey(span));
    if (!prepared) throw new Error("earnings_semantic_citation_missing");
    return prepared;
  });
  const textLocators = citationSpans.map(({ citation, evidenceSpanDigest }) => ({
    artifactDigest: evidence.artifact.contentDigest,
    end: citation.end,
    kind: "text_span" as const,
    spanDigest: evidenceSpanDigest,
    start: citation.start,
  }));
  return Object.freeze({
    artifact: evidence.artifact,
    locators: Object.freeze([evidence.sourceFactLocator, ...textLocators]),
    memberId: input.memberId,
    projectionReference: evidence.projectionReference,
    role: input.role,
    semanticContext: Object.freeze({
      citationSpans: Object.freeze(citationSpans),
      coverage: Object.freeze({ ...evidence.transcript.coverage }),
      eventRevisionId: evidence.transcript.eventRevisionId,
      parentRole: evidence.role,
      sections: Object.freeze(evidence.transcript.sections.map(({ end, sectionId, start }) =>
        Object.freeze({ end, sectionId, start }))),
      sourceArtifactDigest: evidence.transcript.artifactDigest,
      transcriptId: evidence.transcript.transcriptId,
    }),
  });
}

function bundleMembers(input: {
  citationSpansByKey: ReadonlyMap<string, PreparedCitationSpan>;
  evidence: readonly EarningsCallSemanticEvidenceInput[];
  sectionJobIndex?: number;
  spans: readonly PlannedSpan[];
}) {
  return input.evidence.flatMap((evidence) => {
    const spans = input.spans.filter(({ role }) => role === evidence.role);
    if (spans.length === 0) return [];
    return [memberForSpans({
      citationSpansByKey: input.citationSpansByKey,
      evidence,
      memberId: input.sectionJobIndex === undefined
        ? `earnings-member.${evidence.role}`
        : `earnings-section.${input.sectionJobIndex}.${evidence.role}`,
      role: input.sectionJobIndex === undefined ? evidence.role : "section",
      spans,
    })];
  });
}

function citationSpanKey(span: PlannedSpan): string {
  return `${span.role}\0${span.sectionId}\0${span.start}\0${span.end}`;
}

function prepareCitationSpans(
  evidence: readonly EarningsCallSemanticEvidenceInput[],
  spans: readonly PlannedSpan[],
): ReadonlyMap<string, PreparedCitationSpan> {
  const prepared = new Map<string, PreparedCitationSpan>();
  for (const item of evidence) {
    const memberSpans = spans.filter(({ role }) => role === item.role);
    const citations = createEarningsCallCitations({
      artifactDigest: item.transcript.artifactDigest,
      eventRevisionId: item.transcript.eventRevisionId,
      normalizedText: item.normalizedText,
      spans: memberSpans,
      transcript: item.transcript,
    });
    memberSpans.forEach((span, index) => prepared.set(citationSpanKey(span), Object.freeze({
      citation: citations[index]!,
      evidenceSpanDigest: normalizedEvidenceDigest(item.normalizedText.slice(span.start, span.end)),
    })));
  }
  return prepared;
}

function semanticRunState(final: WorkspaceSemanticEvidenceBundleRunResult) {
  if (final.record.job.state === "quarantined") return "quarantined" as const;
  return final.evidence?.result.disposition === "accepted" ? "accepted" as const : "abstained" as const;
}

function findDefinition(
  definitions: readonly HybridEvidenceJobDefinition[],
  definitionId: string,
) {
  const definition = definitions.find((candidate) => candidate.definitionId === definitionId);
  if (!definition) throw new Error("earnings_semantic_definition_missing");
  return definition;
}

type BundleClients = Parameters<typeof runWorkspaceSemanticEvidenceBundleJob>[1];

export async function runEarningsCallSemanticComparison(input: {
  comparison: EarningsComparison;
  environment?: NodeJS.ProcessEnv;
  evidence: readonly EarningsCallSemanticEvidenceInput[];
  modelId: string;
  reasoning?: HybridModelReasoning;
  now?: Date;
  pack: { contentDigest: string; id: string; version: string };
  scope: AuthorizedWorkspaceStoreScope;
  workspaceGeneration: number;
}, clients: BundleClients): Promise<EarningsCallSemanticRunResult> {
  const validated = validateComparisonEvidence(input.comparison, input.evidence);
  const plan = planEarningsCallSemanticComparison(
    validated.evidence,
    earningsCallComparisonPlannerLimits(input.pack.version),
  );
  if (plan.state === "overflow") {
    return Object.freeze({
      final: null,
      plan,
      reasonCode: "token_or_budget_overflow",
      sections: Object.freeze([]),
      state: "abstained",
    });
  }
  const allSpans = plan.jobs.flatMap(({ spans }) => spans);
  const citationSpansByKey = prepareCitationSpans(validated.evidence, allSpans);
  const definitions = createEarningsCallComparisonDefinitions(
    [input.modelId],
    earningsCallComparisonSessionOptions(input.pack.version),
  );
  const shared = {
    environment: input.environment,
    modelId: input.modelId,
    reasoning: input.reasoning,
    now: input.now,
    pack: input.pack,
    scope: input.scope,
    workspaceGeneration: input.workspaceGeneration,
  };
  if (plan.state === "single_job") {
    const final = await runWorkspaceSemanticEvidenceBundleJob({
      ...shared,
      definition: findDefinition(definitions, EARNINGS_CALL_COMPARISON_DEFINITION_ID),
      members: bundleMembers({
        citationSpansByKey,
        evidence: validated.evidence,
        spans: plan.jobs[0]!.spans,
      }),
    }, clients);
    return Object.freeze({
      final,
      plan,
      reasonCode: null,
      sections: Object.freeze([]),
      state: semanticRunState(final),
    });
  }
  const sections: WorkspaceSemanticEvidenceBundleRunResult[] = [];
  for (const [index, job] of plan.jobs.entries()) {
    const section = await runWorkspaceSemanticEvidenceBundleJob({
      ...shared,
      definition: findDefinition(definitions, EARNINGS_CALL_COMPARISON_SECTION_DEFINITION_ID),
      members: bundleMembers({
        citationSpansByKey,
        evidence: validated.evidence,
        sectionJobIndex: index,
        spans: job.spans,
      }),
    }, clients);
    sections.push(section);
    if (section.record.job.state === "quarantined") {
      return Object.freeze({
        final: null,
        plan,
        reasonCode: null,
        sections: Object.freeze(sections),
        state: "quarantined",
      });
    }
  }
  const semanticResultLocators: EvidenceLocator[] = sections.flatMap(({ evidence }) => evidence ? [{
    kind: "semantic_result" as const,
    outputDigest: evidence.result.outputDigest,
    resultId: evidence.result.resultId,
  }] : []);
  const final = await runWorkspaceSemanticEvidenceBundleJob({
    ...shared,
    additionalLocators: semanticResultLocators,
    definition: findDefinition(definitions, EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID),
    members: bundleMembers({ citationSpansByKey, evidence: validated.evidence, spans: allSpans }),
  }, clients);
  return Object.freeze({
    final,
    plan,
    reasonCode: null,
    sections: Object.freeze(sections),
    state: semanticRunState(final),
  });
}
