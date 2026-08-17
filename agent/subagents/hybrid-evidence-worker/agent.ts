import { defineAgent, defineDynamic } from "eve";

import { verifyHybridEvidenceWorkerToken } from "../../lib/hybrid-evidence-auth";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const token = ctx.session.auth.current?.attributes.hybrid_evidence_runtime_token;
      if (typeof token !== "string") return null;
      try {
        const envelope = verifyHybridEvidenceWorkerToken(token);
        return defineAgent({
          description: "Execute one bounded public hybrid-evidence task with no conversational history.",
          limits: {
            maxInputTokensPerSession: envelope.budget.inputTokens,
            maxOutputTokensPerSession: envelope.budget.outputTokens,
            sessionTimeoutMs: 15 * 60_000,
          },
          model: envelope.modelId,
          reasoning: "high",
        });
      } catch {
        return null;
      }
    },
  },
});
