import { defineAgent, defineDynamic } from "eve";

import {
  decodeHybridEvidenceWorkerToken,
  hybridEvidenceWorkerTokenFromSessionAuth,
} from "../../lib/hybrid-evidence-auth";
import { createHybridEvidenceWorkerAgentConfig } from "../../lib/hybrid-evidence-worker-config";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const token = hybridEvidenceWorkerTokenFromSessionAuth(ctx.session.auth);
      if (!token) return null;
      try {
        const envelope = decodeHybridEvidenceWorkerToken(token);
        return defineAgent(createHybridEvidenceWorkerAgentConfig(envelope));
      } catch {
        return null;
      }
    },
  },
});
