import { defineAgent } from "eve";

export default defineAgent({
  description: "Execute one bounded workspace monitor occurrence with no interactive history.",
  model: "google/gemini-3.6-flash",
  // This model is a reasoning model: at "high" it spends output tokens on
  // thinking before emitting any text or tool call, and returns an empty
  // response with finishReason "length" once a turn's output budget is consumed
  // by reasoning alone. Across a multi-statement fan-out (or a single heavy turn
  // on a large backlog) that exhausted the 16k session budget and surfaced as
  // `empty model response` -> `worker_recovery_outcome_missing` /
  // `worker_recovery_not_applicable`, intermittently pausing live monitors. The
  // top-level worker only orchestrates and calls its evaluation/commit tools;
  // the actual materiality and semantic judgement runs in nested hybrid-evidence
  // child jobs with their own frontier model and reasoning. So this session
  // needs reliable tool-calling, not deep reasoning - "low" keeps the fan-out
  // and commit turn well inside the budget. (Bumping the cap 8k -> 16k did not
  // hold; constraining the reasoning does.)
  reasoning: "low",
  // One occurrence may evaluate several statements, and each one adds a turn to
  // this session. These limits leave room for the declared fan-out plus the
  // commit turn while still fitting inside the occurrence budget envelope
  // alongside nested children.
  limits: {
    maxInputTokensPerSession: 64_000,
    maxOutputTokensPerSession: 16_000,
    sessionTimeoutMs: 2 * 60 * 60_000,
  },
});
