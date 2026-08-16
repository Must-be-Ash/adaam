import { defineTool } from "eve/tools";
import { z } from "zod";

import { STRATEGY_PACK_CAPABILITY_INVENTORY } from "../lib/strategy-pack-reference-catalog";
import { configureStrategyPackWorkspaceFromSelection } from "../lib/strategy-pack-service";
import { requireStrategyPackToolContext } from "../lib/strategy-pack-tool-context";

export default defineTool({
  description:
    "Configure declared owner-editable fields on the exact strategy pack in the current authenticated session. Call only after inspecting the current binding and after the owner explicitly confirms that managed work will pause, future messages will start a fresh conversation generation, and durable research will remain.",
  inputSchema: z.object({
    configuration: z.record(z.string().min(1).max(80), z.unknown())
      .refine((value) => Object.keys(value).length > 0),
    confirmedConsequences: z.literal(true),
    expectedBindingRevision: z.number().int().positive(),
  }).strict(),
  async execute(input, ctx) {
    const trusted = requireStrategyPackToolContext(ctx);
    const result = await configureStrategyPackWorkspaceFromSelection({
      confirmedConsequences: input.confirmedConsequences,
      configuration: input.configuration,
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
      managedWorkPaused: true,
    };
  },
});
