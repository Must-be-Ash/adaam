import type { PublicSourceCorrection } from "./public-source-adapter-schema";
import {
  digestEarningsCallValue,
  earningsFindingSchema,
  type EarningsFinding,
} from "./earnings-call-schema";

function conclusionProjection(finding: EarningsFinding) {
  const assertions = [
    ...finding.facts,
    ...finding.inferences,
    ...finding.counterevidence,
    ...(finding.forecast?.catalysts ?? []),
    ...(finding.forecast?.risks ?? []),
  ].map(({ statement }) => statement).sort();
  return Object.freeze({
    assertions: Object.freeze(assertions),
    direction: finding.forecast?.direction ?? null,
    materiality: Object.freeze({
      alertEligible: finding.materiality.alertEligible,
      configuredThreshold: finding.materiality.configuredThreshold,
      deterministicScore: finding.materiality.deterministicScore,
    }),
    stance: finding.recommendation?.stance ?? null,
  });
}

export interface EarningsCallSourceCorrectionAssessment {
  readonly conclusionChanged: boolean;
  readonly correctiveAlertEligible: boolean;
  readonly finding: EarningsFinding;
  readonly lineage: Readonly<{
    conclusionChanged: boolean;
    correctionId: string;
    correctiveAlertEligible: boolean;
    fromRevisionId: string;
    priorAlerted: boolean;
    priorFindingId: string | null;
    reason: "source_correction";
    toRevisionId: string;
  }>;
}

export function assessEarningsCallSourceCorrection(input: {
  readonly correction: PublicSourceCorrection;
  readonly current: EarningsFinding;
  readonly prior: EarningsFinding | null;
  readonly priorAlerted: boolean;
}): EarningsCallSourceCorrectionAssessment {
  const priorAccepted = input.prior?.outcome === "accepted" ? input.prior : null;
  const conclusionChanged = priorAccepted !== null &&
    JSON.stringify(conclusionProjection(priorAccepted)) !==
      JSON.stringify(conclusionProjection(input.current));
  const correctiveAlertEligible = input.priorAlerted && conclusionChanged;
  const decisionReasons = conclusionChanged &&
      !input.current.materiality.decisionReasons.includes("source_correction")
    ? [...input.current.materiality.decisionReasons, "source_correction" as const]
    : input.current.materiality.decisionReasons;
  const { findingDigest: _findingDigest, ...core } = input.current;
  const finding = earningsFindingSchema.parse({
    ...core,
    materiality: { ...core.materiality, decisionReasons },
    findingDigest: digestEarningsCallValue({
      ...core,
      materiality: { ...core.materiality, decisionReasons },
    }),
  });
  const lineage = Object.freeze({
    conclusionChanged,
    correctionId: input.correction.correctionId,
    correctiveAlertEligible,
    fromRevisionId: input.correction.fromRevisionId,
    priorAlerted: input.priorAlerted,
    priorFindingId: input.prior?.findingId ?? null,
    reason: "source_correction" as const,
    toRevisionId: input.correction.toRevisionId,
  });
  return Object.freeze({ conclusionChanged, correctiveAlertEligible, finding, lineage });
}
