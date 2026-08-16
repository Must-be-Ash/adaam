import { defineTool } from "eve/tools";
import { z } from "zod";

import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../lib/strategy-pack-reference-catalog";
import { removeStrategyPackWorkspaceFromSelection } from "../lib/strategy-pack-service";
import { requireStrategyPackToolContext } from "../lib/strategy-pack-tool-context";

export default defineTool({
  description:
    "Non-destructively remove the exact strategy pack from the current authenticated session. Call only after inspecting the current binding and after the owner explicitly confirms that pack-managed work will retire, future messages will start a fresh conversation generation, and durable research will remain.",
  inputSchema: z.object({
    confirmedConsequences: z.literal(true),
    expectedBindingRevision: z.number().int().positive(),
  }).strict(),
  async execute(input, ctx) {
    const trusted = requireStrategyPackToolContext(ctx);
    const result = await removeStrategyPackWorkspaceFromSelection({
      confirmedConsequences: input.confirmedConsequences,
      expectedBindingRevision: input.expectedBindingRevision,
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
      durableResearchPreserved: true,
      futureMessagesStartFreshGeneration: true,
      managedWorkRetired: true,
    };
  },
});
