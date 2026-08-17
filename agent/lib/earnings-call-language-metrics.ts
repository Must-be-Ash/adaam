import { z } from "zod";

const HEDGING_PHRASES = [
  "approximately", "around", "could", "generally", "hope", "hopefully", "may",
  "might", "potentially", "roughly", "somewhat", "we anticipate", "we believe",
  "we estimate", "we expect", "we hope", "we think",
] as const;

const CONFIDENCE_PHRASES = [
  "we are confident", "we remain confident", "we will", "we expect to deliver",
  "we are committed", "strong visibility", "high visibility", "on track",
  "ahead of plan", "ahead of schedule",
] as const;

const EXTERNAL_ATTRIBUTION_PHRASES = [
  "macro headwinds", "macroeconomic", "foreign exchange", "fx headwinds",
  "supply chain", "industry-wide", "industry pressure", "regulatory environment",
  "interest rates", "inflation", "weather", "geopolitical", "labor market",
  "consumer environment",
] as const;

export const earningsCallLanguageSampleSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  section: z.enum(["prepared-remarks", "qa", "full-call", "unknown"]).default("unknown"),
  text: z.string().min(1).max(3_000_000),
});

export type EarningsCallLanguageSample = z.input<typeof earningsCallLanguageSampleSchema>;
type Phrase = (typeof HEDGING_PHRASES)[number] |
  (typeof CONFIDENCE_PHRASES)[number] |
  (typeof EXTERNAL_ATTRIBUTION_PHRASES)[number];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countPhrase(text: string, phrase: Phrase): number {
  const pattern = escapeRegExp(phrase).replace(/\s+/g, "\\s+");
  return text.match(new RegExp(`\\b${pattern}\\b`, "gi"))?.length ?? 0;
}

function countPhrases<T extends readonly Phrase[]>(
  text: string,
  phrases: T,
): Record<T[number], number> {
  return Object.fromEntries(
    phrases.map((phrase) => [phrase, countPhrase(text, phrase)]),
  ) as Record<T[number], number>;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function nonZeroCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizedRate(count: number, denominator: number, scale: number): number {
  return denominator === 0 ? 0 : round((count / denominator) * scale);
}

function matchCount(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function measureEarningsCallLanguage(sampleInput: EarningsCallLanguageSample) {
  const sample = earningsCallLanguageSampleSchema.parse(sampleInput);
  const wordCount =
    sample.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)?.length ?? 0;
  const sentenceCount = Math.max(
    1,
    sample.text.split(/[.!?]+(?:\s+|$)/).filter((sentence) => sentence.trim().length > 0)
      .length,
  );
  const hedgingPhrases = countPhrases(sample.text, HEDGING_PHRASES);
  const confidencePhrases = countPhrases(sample.text, CONFIDENCE_PHRASES);
  const externalAttributionPhrases = countPhrases(sample.text, EXTERNAL_ATTRIBUTION_PHRASES);
  const numberCount = matchCount(
    sample.text,
    /(?:[$€£]\s*)?(?:\b\d{1,3}(?:,\d{3})+|\b\d+(?:\.\d+)?)(?:\s?(?:%|bps\b|basis points?\b|million\b|billion\b|thousand\b))?/gi,
  );
  const percentageCount = matchCount(
    sample.text,
    /\b\d+(?:\.\d+)?\s*(?:%|percent(?:age points?)?|bps|basis points?)\b/gi,
  );
  const currencyCount = matchCount(
    sample.text,
    /(?:[$€£]\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:dollars?|euros?|pounds?))\b/gi,
  );
  const rangeCount = matchCount(
    sample.text,
    /(?:[$€£]\s*)?\d[\d,.]*\s*(?:-|–|—|to)\s*(?:[$€£]\s*)?\d[\d,.]*(?:\s*%)?/gi,
  );
  const timelineCount = matchCount(
    sample.text,
    /\b(?:Q[1-4]|FY\d{2,4}|next quarter|next year|by (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/gi,
  );
  const hedgingCount = sumCounts(hedgingPhrases);
  const confidenceCount = sumCounts(confidencePhrases);
  const externalAttributionCount = sumCounts(externalAttributionPhrases);
  const concreteReferenceCount = numberCount + timelineCount;

  return Object.freeze({
    label: sample.label ?? null,
    section: sample.section,
    coverage: Object.freeze({
      wordCount,
      sentenceCount,
      shortSampleWarning: wordCount < 500
        ? "Fewer than 500 words; normalized changes may be unstable."
        : null,
    }),
    hedging: Object.freeze({
      count: hedgingCount,
      perThousandWords: normalizedRate(hedgingCount, wordCount, 1_000),
      phraseCounts: Object.freeze(nonZeroCounts(hedgingPhrases)),
    }),
    specificity: Object.freeze({
      concreteReferenceCount,
      perHundredSentences: normalizedRate(concreteReferenceCount, sentenceCount, 100),
      numberCount,
      percentageCount,
      currencyCount,
      rangeCount,
      timelineCount,
    }),
    confidenceLanguage: Object.freeze({
      count: confidenceCount,
      perThousandWords: normalizedRate(confidenceCount, wordCount, 1_000),
      phraseCounts: Object.freeze(nonZeroCounts(confidencePhrases)),
    }),
    externalAttribution: Object.freeze({
      count: externalAttributionCount,
      perThousandWords: normalizedRate(externalAttributionCount, wordCount, 1_000),
      phraseCounts: Object.freeze(nonZeroCounts(externalAttributionPhrases)),
    }),
  });
}

export function compareEarningsCallLanguage(input: {
  readonly current: EarningsCallLanguageSample;
  readonly prior?: EarningsCallLanguageSample;
}) {
  const current = measureEarningsCallLanguage(input.current);
  const prior = input.prior ? measureEarningsCallLanguage(input.prior) : null;
  return Object.freeze({
    current,
    prior,
    change: prior === null ? null : Object.freeze({
      hedgingPerThousandWords: round(
        current.hedging.perThousandWords - prior.hedging.perThousandWords,
      ),
      specificityPerHundredSentences: round(
        current.specificity.perHundredSentences - prior.specificity.perHundredSentences,
      ),
      confidencePerThousandWords: round(
        current.confidenceLanguage.perThousandWords - prior.confidenceLanguage.perThousandWords,
      ),
      externalAttributionPerThousandWords: round(
        current.externalAttribution.perThousandWords - prior.externalAttribution.perThousandWords,
      ),
    }),
    caveat:
      "Phrase counts do not determine intent, answer directness, guidance quality, or investment outcome. Review the underlying passages.",
  });
}
