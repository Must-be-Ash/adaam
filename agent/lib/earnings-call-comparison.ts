import {
  digestEarningsCallValue,
  EARNINGS_CALL_SCHEMA_VERSION,
  earningsComparisonSchema,
  earningsEventSchema,
  earningsMetricSchema,
  earningsTranscriptSchema,
  type EarningsComparison,
  type EarningsEvent,
  type EarningsTranscript,
} from "./earnings-call-schema";
import { compareEarningsCallLanguage } from "./earnings-call-language-metrics";
import { EARNINGS_CALL_POLICY } from "./earnings-call-policy";

export const EARNINGS_CALL_METRIC_VERSION = "1.0.0";

export interface EarningsCallEvidenceRecord {
  readonly event: EarningsEvent;
  readonly normalizedText: string;
  readonly transcript: EarningsTranscript;
}

function sectionText(
  record: EarningsCallEvidenceRecord,
  sectionKind: "prepared_remarks" | "questions_and_answers",
): string {
  const section = record.transcript.sections.find((candidate) =>
    candidate.sectionKind === sectionKind);
  if (!section) throw new Error("comparison_section_missing");
  return record.normalizedText.slice(section.start, section.end);
}

function metricValues(input: {
  readonly current: EarningsCallEvidenceRecord;
  readonly prior: EarningsCallEvidenceRecord;
  readonly sectionKind: "prepared_remarks" | "questions_and_answers";
}) {
  const section = input.sectionKind === "prepared_remarks" ? "prepared-remarks" : "qa";
  const result = compareEarningsCallLanguage({
    current: { section, text: sectionText(input.current, input.sectionKind) },
    prior: { section, text: sectionText(input.prior, input.sectionKind) },
  });
  const definitions = [
    {
      currentValue: result.current.confidenceLanguage.perThousandWords,
      delta: result.change!.confidencePerThousandWords,
      metricId: "commitment_language_rate" as const,
      priorValue: result.prior!.confidenceLanguage.perThousandWords,
    },
    {
      currentValue: result.current.externalAttribution.perThousandWords,
      delta: result.change!.externalAttributionPerThousandWords,
      metricId: "external_attribution_rate" as const,
      priorValue: result.prior!.externalAttribution.perThousandWords,
    },
    {
      currentValue: result.current.hedging.perThousandWords,
      delta: result.change!.hedgingPerThousandWords,
      metricId: "hedging_language_rate" as const,
      priorValue: result.prior!.hedging.perThousandWords,
    },
    {
      currentValue: result.current.specificity.perHundredSentences,
      delta: result.change!.specificityPerHundredSentences,
      metricId: "specificity_rate" as const,
      priorValue: result.prior!.specificity.perHundredSentences,
    },
  ];
  return definitions.map((definition) => earningsMetricSchema.parse({
    ...definition,
    sectionKind: input.sectionKind,
    unit: "ratio",
  }));
}

function assertRecord(record: EarningsCallEvidenceRecord): void {
  const event = earningsEventSchema.parse(record.event);
  const transcript = earningsTranscriptSchema.parse(record.transcript);
  if (
    transcript.eventRevisionId !== event.revisionId ||
    transcript.artifactDigest !== event.artifactDigest ||
    record.normalizedText.length !== transcript.characterCount ||
    digestEarningsCallValue(record.normalizedText) !== transcript.normalizedTextDigest
  ) throw new Error("comparison_evidence_mismatch");
}

function buildEarningsCallComparison(input: {
  readonly current: EarningsCallEvidenceRecord;
  readonly prior: EarningsCallEvidenceRecord;
  readonly secondaryYearAgo?: EarningsCallEvidenceRecord | null;
}): EarningsComparison {
  const cik = input.current.event.cik;
  if (
    input.prior.event.cik !== cik ||
    (input.secondaryYearAgo && input.secondaryYearAgo.event.cik !== cik)
  ) throw new Error("comparison_issuer_mismatch");
  const metrics = (["prepared_remarks", "questions_and_answers"] as const)
    .flatMap((sectionKind) => metricValues({
      current: input.current,
      prior: input.prior,
      sectionKind,
    }));
  const core = {
    cik,
    comparisonId: `comparison.${digestEarningsCallValue([
      input.current.event.revisionId,
      input.prior.event.revisionId,
      input.secondaryYearAgo?.event.revisionId ?? null,
      EARNINGS_CALL_METRIC_VERSION,
    ]).slice(0, 40)}`,
    current: {
      artifactDigest: input.current.event.artifactDigest,
      eventRevisionId: input.current.event.revisionId,
      fiscalPeriod: input.current.event.fiscalPeriod,
      transcriptId: input.current.transcript.transcriptId,
    },
    metricVersion: EARNINGS_CALL_METRIC_VERSION,
    metrics,
    prior: {
      artifactDigest: input.prior.event.artifactDigest,
      eventRevisionId: input.prior.event.revisionId,
      fiscalPeriod: input.prior.event.fiscalPeriod,
      transcriptId: input.prior.transcript.transcriptId,
    },
    recordType: "earnings_call_comparison" as const,
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    secondaryYearAgo: input.secondaryYearAgo ? {
      artifactDigest: input.secondaryYearAgo.event.artifactDigest,
      eventRevisionId: input.secondaryYearAgo.event.revisionId,
      fiscalPeriod: input.secondaryYearAgo.event.fiscalPeriod,
      transcriptId: input.secondaryYearAgo.transcript.transcriptId,
    } : null,
  };
  return earningsComparisonSchema.parse({
    ...core,
    comparisonDigest: digestEarningsCallValue(core),
  });
}

export function createEarningsCallComparison(input: {
  readonly current: EarningsCallEvidenceRecord;
  readonly prior: EarningsCallEvidenceRecord;
  readonly secondaryYearAgo?: EarningsCallEvidenceRecord | null;
}): EarningsComparison {
  assertRecord(input.current);
  assertRecord(input.prior);
  if (input.secondaryYearAgo) assertRecord(input.secondaryYearAgo);
  return buildEarningsCallComparison(input);
}

function fiscalOrdinal(value: string): number {
  const match = /^FY(\d{4})-Q([1-4])$/u.exec(value);
  if (!match) throw new Error("ambiguous_period");
  return Number(match[1]) * 4 + Number(match[2]) - 1;
}

export interface EarningsCallCorrectionLineage {
  readonly correctiveAlertEligible: false;
  readonly fromRevisionId: string;
  readonly reason: "artifact_digest_changed";
  readonly requiresMaterialConclusionChange: true;
  readonly toRevisionId: string;
}

export function buildEarningsCallEvidenceTimeline(input: {
  readonly activationWatermark: string;
  readonly baselineBackfill: boolean;
  readonly records: readonly EarningsCallEvidenceRecord[];
}): Readonly<{
  alertEligibleRevisionIds: readonly string[];
  comparisons: readonly EarningsComparison[];
  corrections: readonly EarningsCallCorrectionLineage[];
  records: readonly EarningsCallEvidenceRecord[];
}> {
  if (Number.isNaN(Date.parse(input.activationWatermark))) {
    throw new Error("activation_watermark_invalid");
  }
  const byEvent = new Map<string, EarningsCallEvidenceRecord[]>();
  let cik: string | null = null;
  for (const record of input.records) {
    assertRecord(record);
    if (cik !== null && record.event.cik !== cik) throw new Error("comparison_issuer_mismatch");
    cik = record.event.cik;
    const revisions = byEvent.get(record.event.eventId) ?? [];
    revisions.push(record);
    byEvent.set(record.event.eventId, revisions);
  }
  const corrections: EarningsCallCorrectionLineage[] = [];
  const latest = [...byEvent.values()].map((revisions) => {
    revisions.sort((left, right) => left.event.revision - right.event.revision ||
      left.event.observedAt.localeCompare(right.event.observedAt));
    for (let index = 1; index < revisions.length; index += 1) {
      const from = revisions[index - 1]!;
      const to = revisions[index]!;
      if (from.event.artifactDigest !== to.event.artifactDigest) {
        corrections.push(Object.freeze({
          correctiveAlertEligible: false,
          fromRevisionId: from.event.revisionId,
          reason: "artifact_digest_changed",
          requiresMaterialConclusionChange: true,
          toRevisionId: to.event.revisionId,
        }));
      }
    }
    const record = revisions.at(-1)!;
    return Object.freeze({ ordinal: fiscalOrdinal(record.event.fiscalPeriod), record });
  }).sort((left, right) => left.ordinal - right.ordinal ||
    left.record.event.callDate.localeCompare(right.record.event.callDate));
  const boundedDecorated = input.baselineBackfill
    ? latest.slice(-EARNINGS_CALL_POLICY.activation.maximumBackfillEventsPerIssuer)
    : latest;
  const bounded = boundedDecorated.map(({ record }) => record);
  const byOrdinal = new Map(boundedDecorated.map((entry) => [entry.ordinal, entry.record]));
  const comparisons: EarningsComparison[] = [];
  const comparableRevisionIds = new Set<string>();
  for (let index = 1; index < bounded.length; index += 1) {
    const current = bounded[index]!;
    const prior = bounded[index - 1]!;
    const currentOrdinal = boundedDecorated[index]!.ordinal;
    const priorOrdinal = boundedDecorated[index - 1]!.ordinal;
    if (currentOrdinal - priorOrdinal !== 1) {
      continue;
    }
    const yearAgo = byOrdinal.get(currentOrdinal - 4) ?? null;
    comparisons.push(buildEarningsCallComparison({
      current,
      prior,
      secondaryYearAgo: yearAgo,
    }));
    comparableRevisionIds.add(current.event.revisionId);
  }
  const alertEligibleRevisionIds = input.baselineBackfill
    ? []
    : bounded.filter((record) =>
      comparableRevisionIds.has(record.event.revisionId) &&
      Date.parse(record.event.publishedAt) > Date.parse(input.activationWatermark))
      .map(({ event }) => event.revisionId);
  return Object.freeze({
    alertEligibleRevisionIds: Object.freeze(alertEligibleRevisionIds),
    comparisons: Object.freeze(comparisons),
    corrections: Object.freeze(corrections),
    records: Object.freeze(bounded),
  });
}
