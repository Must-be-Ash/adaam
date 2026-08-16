import { defineTool } from "eve/tools";
import { z } from "zod";

import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../lib/strategy-pack-reference-catalog";
import {
  createStrategyPackWorkspaceFromSelection,
  strategyPackMutationConfigurationSchema,
} from "../lib/strategy-pack-service";
import { requireStrategyPackToolContext } from "../lib/strategy-pack-tool-context";

export const createStrategyPackSessionInputSchema = z.object({
  activateMonitorResourceIds: z.array(z.string().min(2).max(80)).max(16).default([]),
  configuration: strategyPackMutationConfigurationSchema.optional(),
  name: z.string().trim().min(1).max(80),
  packId: z.string().min(2).max(64),
  packVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
}).strict();

export default defineTool({
  description:
    "Create one new session from an exact reviewed strategy pack. Include monitor resource IDs only when the owner explicitly requested that schedule; otherwise install with managed monitors paused. The current turn stays in its source session and the owner's next message routes to the newly selected session.",
  inputSchema: createStrategyPackSessionInputSchema,
  async execute(input, ctx) {
    const trusted = requireStrategyPackToolContext(ctx);
    const result = await createStrategyPackWorkspaceFromSelection({
      ...input,
      expectedRegistryRevision: trusted.expectedRegistryRevision,
      principalId: trusted.principalId,
      requestIdentity: trusted.mutationIdentity,
      sourceAssignment: {
        generation: trusted.runtimeScope.generation,
        workspaceId: trusted.runtimeScope.workspaceId,
      },
      threadId: trusted.threadId,
    }, {
      capabilityInventory: STRATEGY_PACK_CAPABILITY_INVENTORY,
    });
    return {
      ...result,
      currentTurnSessionChanged: false,
      nextMessageSessionId: result.receipt.targetWorkspaceId,
    };
  },
});
