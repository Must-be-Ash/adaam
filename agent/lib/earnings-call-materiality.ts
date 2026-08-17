import {
  digestEarningsCallValue,
  EARNINGS_CALL_SCHEMA_VERSION,
  earningsFindingSchema,
  earningsMaterialityDecisionSchema,
  type EarningsComparison,
  type EarningsFinding,
} from "./earnings-call-schema";
import { EARNINGS_CALL_POLICY } from "./earnings-call-policy";
import {
  earningsSemanticPayloadSchema,
  type EarningsSemanticPayload,
} from "./hybrid-evidence-definition-registry";
import type { WorkspaceSemanticEvidenceBundleRunResult } from "./hybrid-evidence-semantic";

export function earningsCallMaterialityScore(comparison: EarningsComparison): number {
  const magnitudes = comparison.metrics.map(({ delta, metricId }) => {
    const scale = metricId === "qa_answer_length_median" ? 0.05 : 10;
    return Math.min(20, Math.round(Math.abs(delta) * scale));
  });
  const nonZero = magnitudes.filter((value) => value > 0);
  return Math.min(100, nonZero.reduce((total, value) => total + value, 0));
}

export function decideEarningsCallMateriality(input: {
  readonly activationWatermark: string;
  readonly comparison: EarningsComparison;
  readonly currentPublishedAt: string;
  readonly outcome: EarningsSemanticPayload["outcome"] | "quarantined";
  readonly threshold: number;
}) {
  const score = earningsCallMaterialityScore(input.comparison);
  const afterWatermark = Date.parse(input.currentPublishedAt) > Date.parse(input.activationWatermark);
  const accepted = input.outcome === "accepted";
  const changed = score > 0;
  const reasons = !accepted
    ? [input.outcome === "no_change" ? "no_change" as const : "abstained" as const]
    : !afterWatermark
      ? ["not_after_activation_watermark" as const]
      : !changed
        ? ["no_change" as const]
        : score < input.threshold
          ? ["below_threshold" as const]
          : ["material_change" as const];
  return earningsMaterialityDecisionSchema.parse({
    alertEligible: reasons[0] === "material_change",
    configuredThreshold: input.threshold,
    decisionReasons: reasons,
    deterministicScore: score,
    policyVersion: EARNINGS_CALL_POLICY.policyVersion,
  });
}

export function createEarningsCallFinding(input: {
  readonly activationWatermark: string;
  readonly comparison: EarningsComparison;
  readonly configurationRevision: number;
  readonly currentPublishedAt: string;
  readonly monitorId: string;
  readonly ownerId: string;
  readonly pack: { readonly contentDigest: string; readonly id: "earnings-call-changes"; readonly version: string };
  readonly semantic: WorkspaceSemanticEvidenceBundleRunResult;
  readonly threshold: number;
  readonly workspaceId: string;
}): EarningsFinding {
  const result = input.semantic.evidence?.result;
  const definition = input.semantic.definition;
  const payload = result ? earningsSemanticPayloadSchema.parse(result.payload) : null;
  const outcome = !result || input.semantic.record.job.state === "quarantined"
    ? "quarantined" as const
    : payload?.outcome ?? "abstained";
  const materiality = decideEarningsCallMateriality({
    activationWatermark: input.activationWatermark,
    comparison: input.comparison,
    currentPublishedAt: input.currentPublishedAt,
    outcome,
    threshold: input.threshold,
  });
  const acceptedPayload = outcome === "accepted" ? payload : null;
  const fallbackCitation = payload?.inferences[0]?.citations[0] ??
    payload?.recommendation?.citations[0] ?? payload?.forecast?.citations[0] ?? null;
  const core = {
    activationWatermark: input.activationWatermark,
    analysisLineage: {
      budgetAttempt: input.semantic.record.job.attempt,
      configurationRevision: input.configurationRevision,
      definitionDigest: definition.definitionDigest,
      definitionId: definition.definitionId,
      definitionVersion: definition.definitionVersion,
      modelId: input.semantic.record.job.modelId,
      promptDigest: result?.model.promptTemplateDigest ?? definition.instructionTemplate.digest,
      validatorVersion: definition.requiredValidator.version,
    },
    comparisonDigest: input.comparison.comparisonDigest,
    comparisonId: input.comparison.comparisonId,
    confidence: payload?.confidence ?? "low" as const,
    counterevidence: payload?.counterevidence ?? [],
    facts: payload?.facts.length ? payload.facts : [{
      citations: fallbackCitation ? [fallbackCitation] : [],
      statement: "No accepted semantic conclusion was available.",
    }],
    findingId: `earnings-finding.${digestEarningsCallValue([
      input.workspaceId,
      input.monitorId,
      input.comparison.comparisonDigest,
      result?.outputDigest ?? input.semantic.record.job.jobId,
      input.threshold,
    ]).slice(0, 48)}`,
    forecast: acceptedPayload?.forecast ?? null,
    inferences: acceptedPayload?.inferences ?? [],
    materiality,
    monitorId: input.monitorId,
    outcome,
    ownerId: input.ownerId,
    pack: input.pack,
    recordType: "earnings_call_finding" as const,
    recommendation: acceptedPayload?.recommendation ?? (outcome === "no_change" && payload?.recommendation
      ? payload.recommendation
      : null),
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    unknowns: result?.uncertainty.unknowns.length
      ? result.uncertainty.unknowns
      : outcome === "quarantined" || outcome === "abstained"
        ? ["The semantic comparison did not produce an accepted conclusion."]
        : [],
    workspaceId: input.workspaceId,
  };
  return earningsFindingSchema.parse({
    ...core,
    findingDigest: digestEarningsCallValue(core),
  });
}
