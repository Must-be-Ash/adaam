import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  compareEarningsCallLanguage,
  earningsCallLanguageSampleSchema,
} from "../lib/earnings-call-language-metrics";

export default defineTool({
  description:
    "Calculate reproducible language metrics for one earnings-call section and, optionally, a comparable prior-quarter section. Use this before interpreting hedging, specificity, confidence, or external-attribution changes. The output is descriptive evidence, not a prediction.",
  inputSchema: z.object({
    current: earningsCallLanguageSampleSchema,
    prior: earningsCallLanguageSampleSchema.optional(),
  }),
  execute({ current, prior }) {
    return compareEarningsCallLanguage({ current, ...(prior ? { prior } : {}) });
  },
});
