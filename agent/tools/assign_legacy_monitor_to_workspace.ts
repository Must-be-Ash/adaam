import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireEventTriggerOwner } from "../lib/event-trigger-owner";
import { assignLegacyMonitorToWorkspace } from "../lib/workspace-legacy-monitor-assignment";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export default defineTool({
  description:
    "Assign one unassigned legacy monitor to the current authenticated workspace. This immutable migration disables the legacy record and never copies chat history.",
  inputSchema: z.object({
    expectedLegacyRevision: z.number().int().positive(),
    legacyTriggerId: z.string().uuid(),
  }).strict(),
  async execute(input, ctx) {
    requireWorkspaceMonitorWrites();
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const owner = requireEventTriggerOwner(ctx);
    return assignLegacyMonitorToWorkspace({
      ...input,
      deliverySubscriptionId: runtimeScope.conversationId,
      legacyOwnerKey: owner.ownerKey,
      scope: authorizePhotonWorkspaceToolStore(ctx, runtimeScope),
    });
  },
});
