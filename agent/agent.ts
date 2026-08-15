import { defineAgent } from "eve";

export default defineAgent({
  build: {
    externalDependencies: ["@adaam/eve-workspace-runtime-bridge"],
  },
  model: "google/gemini-3.6-flash",
  reasoning: "high",
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: 7 * 24 * 60 * 60_000,
  },
});
