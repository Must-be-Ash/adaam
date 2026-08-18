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
  const { model, reasoning, ...config } = createHybridEvidenceWorkerAgentConfig(envelope);
  const runtimeConfig = Object.freeze({
    ...config,
    model: Object.freeze({ id: model }),
    ...(reasoning === "provider-default" ? {} : { reasoning }),
  });
  if (reasoning !== "provider-default") return runtimeConfig;
  const { reasoning: _reasoning, ...providerDefaultConfig } = runtimeConfig;
  return Object.freeze(providerDefaultConfig);
}
