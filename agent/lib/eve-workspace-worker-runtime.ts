/*
 * Eve 0.33's public schedule/channel surface starts root sessions only. Keep
 * the one required node-targeted runtime call isolated here until Eve exposes
 * an equivalent public application API. The installed runtime documents and
 * implements nodeId as the compiled-graph subagent selector.
 */
import type { ChannelAdapter } from "../../node_modules/eve/dist/src/channel/adapter.js";
import type { RunHandle } from "../../node_modules/eve/dist/src/channel/types.js";
import { createNodeTargetedWorkflowRuntime } from "@adaam/eve-workspace-runtime-bridge";
import type { WorkspaceWorkerTaskRequest } from "./workspace-worker-runner";

const adapter: ChannelAdapter = Object.freeze({
  // This session originates in an authored schedule and needs no channel
  // behavior. Use Eve's framework-owned durable adapter kind so workflow
  // steps can rehydrate it without an otherwise nonexistent channel route.
  kind: "schedule",
});

export async function startWorkspaceWorkerTask(
  request: WorkspaceWorkerTaskRequest,
): Promise<RunHandle> {
  const runtime = await createNodeTargetedWorkflowRuntime({
    nodeId: request.nodeId,
  });
  return runtime.createSession({
    adapter,
    auth: request.auth,
    continuationToken: request.continuationToken,
    input: request.input,
    limits: request.limits,
    mode: request.mode,
  }) as Promise<RunHandle>;
}
