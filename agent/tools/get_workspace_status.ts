import { defineTool } from "eve/tools";
import { z } from "zod";

import { listWorkspaceMonitors } from "../lib/workspace-monitor-store";
import { readEarningsCallWorkspacePresentation } from "../lib/earnings-call-presentation";
import {
  readPublicSourceWorkspaceHealth,
  unavailablePublicSourceWorkspaceHealth,
} from "../lib/public-source-health";
import { inspectStrategyPackWorkspace } from "../lib/strategy-pack-service";
import { readWorkspaceDocument } from "../lib/workspace-state-store";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";
import { inspectWorkspaceHybridEvidence } from "../lib/hybrid-evidence-semantic";

export default defineTool({
  description: "Inspect current-workspace monitor health, schedules, checkpoints, and budget policy without changing state.",
  inputSchema: z.object({}).strict(),
  async execute(_input, ctx) {
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const monitors = await listWorkspaceMonitors(scope);
    const [budget, hybridEvidence, strategyPack] = await Promise.all([
      readWorkspaceDocument("budget", scope),
      inspectWorkspaceHybridEvidence({
        scope,
        sourceReferences: monitors.flatMap((monitor) => monitor.publicSourceSubscriptions ?? []),
      }),
      inspectStrategyPackWorkspace({ scope, workspaceGeneration: runtimeScope.generation }),
    ]);
    const earningsMonitor = monitors.find((monitor) =>
      monitor.managedBy?.packId === "earnings-call-changes");
    const earningsCallChangesActive = strategyPack.state === "active" &&
      strategyPack.pack?.id === "earnings-call-changes";
    const earningsSourceHealth = earningsCallChangesActive && earningsMonitor
      ? await Promise.all((earningsMonitor.publicSourceSubscriptions ?? []).map((reference) =>
          readPublicSourceWorkspaceHealth({ reference, scope }).catch(() =>
            unavailablePublicSourceWorkspaceHealth(reference))))
      : [];
    const earningsCallChanges = earningsCallChangesActive
      ? await readEarningsCallWorkspacePresentation({
          ...(earningsMonitor ? {
            monitor: earningsMonitor,
            sourceHealth: earningsSourceHealth,
          } : {}),
          scope,
          selectedIssuerCiks: Array.isArray(strategyPack.configuration?.selectedIssuerCiks)
            ? strategyPack.configuration.selectedIssuerCiks.filter(
                (value): value is string => typeof value === "string",
              )
            : [],
        })
      : null;
    return {
      budget,
      earningsCallChanges,
      hybridEvidence,
      monitorCounts: {
        enabled: monitors.filter((monitor) => monitor.lifecycleState === "enabled").length,
        paused: monitors.filter((monitor) => monitor.lifecycleState !== "enabled" && monitor.lifecycleState !== "retired").length,
        retired: monitors.filter((monitor) => monitor.lifecycleState === "retired").length,
        total: monitors.length,
      },
      monitors,
    };
  },
});
