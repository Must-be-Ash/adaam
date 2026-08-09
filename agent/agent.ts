import { defineAgent } from "eve";

export default defineAgent({
  model: "google/gemini-3.6-flash",
  reasoning: "high",
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxInputTokensPerSession: 250_000,
    maxOutputTokensPerSession: 20_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60_000,
  },
});
