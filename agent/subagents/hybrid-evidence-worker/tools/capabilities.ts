import { defineDynamic } from "eve/tools";

import { requireHybridEvidenceWorkerAuth } from "../../../lib/hybrid-evidence-auth";
import {
  completeHybridEvidenceJobTool,
  readHybridEvidenceSliceTool,
} from "../../../lib/hybrid-evidence-worker";

function resolve(ctx: Parameters<typeof requireHybridEvidenceWorkerAuth>[0]) {
  try {
    requireHybridEvidenceWorkerAuth(ctx);
    return {
      complete_hybrid_evidence_job: completeHybridEvidenceJobTool,
      read_hybrid_evidence_slice: readHybridEvidenceSliceTool,
    };
  } catch {
    return null;
  }
}

export default defineDynamic({
  events: {
    "step.started": (_event, ctx) => resolve(ctx),
    "turn.started": (_event, ctx) => resolve(ctx),
  },
});
