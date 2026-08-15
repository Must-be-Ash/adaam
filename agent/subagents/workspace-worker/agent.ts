import { defineAgent } from "eve";

export default defineAgent({
  description: "Execute one bounded workspace monitor occurrence with no interactive history.",
  model: "google/gemini-3.6-flash",
  reasoning: "high",
  limits: {
    maxInputTokensPerSession: 32_000,
    maxOutputTokensPerSession: 8_000,
    sessionTimeoutMs: 2 * 60 * 60_000,
  },
});
