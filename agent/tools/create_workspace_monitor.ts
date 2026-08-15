import { defineTool } from "eve/tools";
import { z } from "zod";

import { ensureIpoFilingsWorkspaceRuntime } from "../lib/ipo-filings-workspace-runtime";
import { savePhotonAlertDeliverySubscription } from "../lib/photon-alert-subscription-store";
import { SEC_IPO_SOURCE_ID, SEC_IPO_SOURCE_URL } from "../lib/sec-ipo-reference";
import { nextWorkspaceMonitorOccurrence } from "../lib/workspace-monitor-schedule";
import {
  createWorkspaceMonitor,
  workspaceMonitorScheduleSchema,
} from "../lib/workspace-monitor-store";
import { workspaceMonitorCreateSourcesSchema } from "../lib/workspace-monitor-input";
import { requirePhotonWorkspaceToolScope } from "../lib/workspace-runtime-scope";
import { requireWorkspaceMonitorWrites } from "../lib/workspace-runtime-flags";
import { readWorkspaceDocument } from "../lib/workspace-state-store";
import { authorizePhotonWorkspaceToolStore } from "../lib/workspace-store-authorization";

export const createWorkspaceMonitorInputSchema = z.object({
  endAt: z.string().datetime({ offset: true }).nullable().optional(),
  instruction: z.string().trim().min(1).max(8_000),
  name: z.string().trim().min(1).max(160),
  requiredCapabilityIds: z.array(z.string().trim().min(1).max(160)).max(32).default([]),
  schedule: workspaceMonitorScheduleSchema,
  sources: workspaceMonitorCreateSourcesSchema,
  tighteningLimits: z.object({
    inputTokensPerRun: z.number().int().positive().nullable().default(null),
    outputTokensPerRun: z.number().int().positive().nullable().default(null),
    paidPerRun: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u).nullable().default(null),
  }).strict().default({
    inputTokensPerRun: null,
    outputTokensPerRun: null,
    paidPerRun: null,
  }),
}).strict();

export default defineTool({
  description:
    "Create a durable monitor in the current authenticated workspace. Sources are exact and limited to eight combined entries. The exact public SEC IPO reference source can initialize its bounded runtime automatically; other monitors require an existing workspace runtime configuration.",
  inputSchema: createWorkspaceMonitorInputSchema,
  async execute(input, ctx) {
    requireWorkspaceMonitorWrites();
    const runtimeScope = requirePhotonWorkspaceToolScope(ctx);
    const scope = authorizePhotonWorkspaceToolStore(ctx, runtimeScope);
    const auth = ctx.session.auth.current;
    const threadId = auth && typeof auth.attributes.thread_id === "string"
      ? auth.attributes.thread_id
      : null;
    if (!auth || !threadId) throw new Error("workspace_scope_invalid");
    const now = new Date();
    const next = nextWorkspaceMonitorOccurrence(input.schedule, now);
    if (input.schedule.kind === "one_time" && !next) {
      throw new Error("monitor_schedule_invalid");
    }
    const isIpoReference = input.sources.length === 1 &&
      input.sources[0]?.accessClassification === "public" &&
      input.sources[0].canonicalUrl === SEC_IPO_SOURCE_URL &&
      input.sources[0].origin === "https://www.sec.gov" &&
      input.sources[0].sourceId === SEC_IPO_SOURCE_ID &&
      input.schedule.kind === "daily_local";
    if (isIpoReference) {
      if (input.schedule.kind !== "daily_local") {
        throw new Error("monitor_schedule_invalid");
      }
      await ensureIpoFilingsWorkspaceRuntime({
        now,
        ownerTimezone: input.schedule.timezone,
        scope,
      });
    } else {
      const documents = await Promise.all([
        readWorkspaceDocument("brief", scope),
        readWorkspaceDocument("strategy", scope),
        readWorkspaceDocument("capabilities", scope),
        readWorkspaceDocument("budget", scope),
      ]);
      if (documents.some((document) => document === null)) {
        throw new Error("workspace_runtime_not_configured");
      }
    }
    await savePhotonAlertDeliverySubscription({
      conversationId: runtimeScope.conversationId,
      now,
      ownerId: runtimeScope.ownerId,
      principalId: auth.principalId,
      subscriptionId: runtimeScope.conversationId,
      threadId,
    });
    return {
      monitor: await createWorkspaceMonitor({
        ...input,
        deliverySubscriptionId: runtimeScope.conversationId,
        idempotencyKey: ctx.callId,
        nextOccurrenceAt: next?.scheduledAt ?? null,
        now,
        scope,
      }),
    };
  },
});
