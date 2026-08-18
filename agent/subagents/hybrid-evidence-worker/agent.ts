import { defineAgent, defineDynamic } from "eve";

import { verifyHybridEvidenceWorkerToken } from "../../lib/hybrid-evidence-auth";
import { createHybridEvidenceWorkerAgentConfig } from "../../lib/hybrid-evidence-worker-config";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const token = ctx.session.auth.current?.attributes.hybrid_evidence_runtime_token;
      if (typeof token !== "string") return null;
      try {
        const envelope = verifyHybridEvidenceWorkerToken(token);
        return defineAgent(createHybridEvidenceWorkerAgentConfig(envelope));
      } catch {
        return null;
      }
    },
  },
});
