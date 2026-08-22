import { defineAgent } from "eve";

export default defineAgent({
  description: "Execute one bounded workspace monitor occurrence with no interactive history.",
  model: "google/gemini-3.6-flash",
  reasoning: "high",
  // One occurrence may evaluate several statements, and each one adds a turn to
  // this session. At 8,000 cumulative output tokens with high reasoning the
  // session could exhaust itself before calling its commit tool, which
  // terminalized the occurrence as `worker_outcome_missing` with no error. These
  // limits leave room for the declared fan-out plus the commit turn while still
  // fitting inside the occurrence budget envelope alongside nested children.
  limits: {
    maxInputTokensPerSession: 64_000,
    maxOutputTokensPerSession: 16_000,
    sessionTimeoutMs: 2 * 60 * 60_000,
  },
});
