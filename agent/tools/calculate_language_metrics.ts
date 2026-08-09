import { defineTool } from "eve/tools";
import { z } from "zod";

const HEDGING_PHRASES = [
  "approximately",
  "around",
  "could",
  "generally",
  "hope",
  "hopefully",
  "may",
  "might",
  "potentially",
  "roughly",
  "somewhat",
  "we anticipate",
  "we believe",
  "we estimate",
  "we expect",
  "we hope",
  "we think",
] as const;

const CONFIDENCE_PHRASES = [
  "we are confident",
  "we remain confident",
  "we will",
  "we expect to deliver",
  "we are committed",
  "strong visibility",
  "high visibility",
  "on track",
  "ahead of plan",
  "ahead of schedule",
] as const;

const EXTERNAL_ATTRIBUTION_PHRASES = [
  "macro headwinds",
  "macroeconomic",
  "foreign exchange",
  "fx headwinds",
  "supply chain",
  "industry-wide",
  "industry pressure",
  "regulatory environment",
  "interest rates",
  "inflation",
  "weather",
  "geopolitical",
  "labor market",
  "consumer environment",
] as const;

const sampleSchema = z.object({
  label: z.string().trim().min(1).max(160).optional(),
  section: z.enum(["prepared-remarks", "qa", "full-call", "unknown"]).default("unknown"),
  text: z.string().min(1).max(3_000_000),
});

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

function measure(sample: z.infer<typeof sampleSchema>) {
  const wordCount =
    sample.text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*|\d+(?:[.,]\d+)*/g)?.length ?? 0;
  const sentenceCount = Math.max(
    1,
    sample.text.split(/[.!?]+(?:\s+|$)/).filter((sentence) => sentence.trim().length > 0)
      .length,
  );

  const hedgingPhrases = countPhrases(sample.text, HEDGING_PHRASES);
  const confidencePhrases = countPhrases(sample.text, CONFIDENCE_PHRASES);
  const externalAttributionPhrases = countPhrases(
    sample.text,
    EXTERNAL_ATTRIBUTION_PHRASES,
  );

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

  return {
    label: sample.label ?? null,
    section: sample.section,
    coverage: {
      wordCount,
      sentenceCount,
      shortSampleWarning:
        wordCount < 500
          ? "Fewer than 500 words; normalized changes may be unstable."
          : null,
    },
    hedging: {
      count: hedgingCount,
      perThousandWords: normalizedRate(hedgingCount, wordCount, 1_000),
      phraseCounts: nonZeroCounts(hedgingPhrases),
    },
    specificity: {
      concreteReferenceCount,
      perHundredSentences: normalizedRate(
        concreteReferenceCount,
        sentenceCount,
        100,
      ),
      numberCount,
      percentageCount,
      currencyCount,
      rangeCount,
      timelineCount,
    },
    confidenceLanguage: {
      count: confidenceCount,
      perThousandWords: normalizedRate(confidenceCount, wordCount, 1_000),
      phraseCounts: nonZeroCounts(confidencePhrases),
    },
    externalAttribution: {
      count: externalAttributionCount,
      perThousandWords: normalizedRate(
        externalAttributionCount,
        wordCount,
        1_000,
      ),
      phraseCounts: nonZeroCounts(externalAttributionPhrases),
    },
  };
}

export default defineTool({
  description:
    "Calculate reproducible language metrics for one earnings-call section and, optionally, a comparable prior-quarter section. Use this before interpreting hedging, specificity, confidence, or external-attribution changes. The output is descriptive evidence, not a prediction.",
  inputSchema: z.object({
    current: sampleSchema,
    prior: sampleSchema.optional(),
  }),
  execute({ current, prior }) {
    const currentMetrics = measure(current);
    const priorMetrics = prior ? measure(prior) : null;

    return {
      current: currentMetrics,
      prior: priorMetrics,
      change:
        priorMetrics === null
          ? null
          : {
              hedgingPerThousandWords: round(
                currentMetrics.hedging.perThousandWords -
                  priorMetrics.hedging.perThousandWords,
              ),
              specificityPerHundredSentences: round(
                currentMetrics.specificity.perHundredSentences -
                  priorMetrics.specificity.perHundredSentences,
              ),
              confidencePerThousandWords: round(
                currentMetrics.confidenceLanguage.perThousandWords -
                  priorMetrics.confidenceLanguage.perThousandWords,
              ),
              externalAttributionPerThousandWords: round(
                currentMetrics.externalAttribution.perThousandWords -
                  priorMetrics.externalAttribution.perThousandWords,
              ),
            },
      caveat:
        "Phrase counts do not determine intent, answer directness, guidance quality, or investment outcome. Review the underlying passages.",
    };
  },
});
