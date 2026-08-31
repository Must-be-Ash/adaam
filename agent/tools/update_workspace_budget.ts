import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  readWorkspaceDocument,
  validateWorkspaceBudgetPolicyValue,
  writeWorkspaceDocument,
  workspaceScheduledRunsPerDaySchema,
} from "../lib/workspace-state-store";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u);
export const updateWorkspaceBudgetInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  maximumConcurrentWorkers: z.number().int().positive().max(32).optional(),
  maximumInputTokensPerDay: z.number().int().positive().max(100_000_000).optional(),
  maximumInputTokensPerRun: z.number().int().positive().max(10_000_000).optional(),
  maximumOutputTokensPerDay: z.number().int().positive().max(100_000_000).optional(),
  maximumOutputTokensPerRun: z.number().int().positive().max(10_000_000).optional(),
  maximumPaidPerCall: decimal.nullable().optional(),
  maximumPaidPerDay: decimal.nullable().optional(),
  maximumPaidPerMonth: decimal.nullable().optional(),
  maximumScheduledRunsPerDay: workspaceScheduledRunsPerDaySchema.optional(),
  ownerTimezone: z.string().min(1).max(80).optional(),
  unknownPriceFallbackCeiling: decimal.optional(),
}).strict().refine(
  ({ expectedRevision: _expectedRevision, ...patch }) => Object.values(patch).some((value) => value !== undefined),
  { message: "workspace_budget_update_empty" },
);

export default defineTool({
  description: "Update the current authenticated workspace budget using its exact revision. Deployment safety maxima remain authoritative.",
  inputSchema: updateWorkspaceBudgetInputSchema,
  async execute({ expectedRevision, ...patch }, ctx) {
    requireWorkspaceMonitorWrites();
    const scope = authorizePhotonWorkspaceToolStore(ctx);
    const current = await readWorkspaceDocument("budget", scope);
    if (!current) throw new Error("workspace_budget_not_configured");
    const value = validateWorkspaceBudgetPolicyValue({
      ...current.value,
      ...patch,
      effectiveAt: new Date().toISOString(),
    });
    return {
      budget: await writeWorkspaceDocument("budget", {
        expectedRevision,
        scope,
        value,
      }),
    };
  },
});
