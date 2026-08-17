import {
  HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS,
  type HybridEvidenceWorkerEnvelope,
} from "./hybrid-evidence-auth";

export function createHybridEvidenceWorkerAgentConfig(
  envelope: HybridEvidenceWorkerEnvelope,
) {
  return Object.freeze({
    description: "Execute one bounded public hybrid-evidence task with no conversational history.",
    limits: Object.freeze({
      maxInputTokensPerSession: envelope.budget.inputTokens,
      maxOutputTokensPerSession: envelope.budget.outputTokens,
      sessionTimeoutMs: HYBRID_EVIDENCE_WORKER_MAX_RUNTIME_MS,
    }),
    model: envelope.modelId,
    reasoning: envelope.reasoning,
  });
}

export function createHybridEvidenceWorkerRuntimeConfig(
  envelope: HybridEvidenceWorkerEnvelope,
) {
  const config = createHybridEvidenceWorkerAgentConfig(envelope);
  if (config.reasoning !== "provider-default") return config;
  const { reasoning: _reasoning, ...providerDefaultConfig } = config;
  return Object.freeze(providerDefaultConfig);
}
