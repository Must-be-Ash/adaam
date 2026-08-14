/*
 * Eve 0.33's public schedule/channel surface starts root sessions only. Keep
 * the one required node-targeted runtime call isolated here until Eve exposes
 * an equivalent public application API. The installed runtime documents and
 * implements nodeId as the compiled-graph subagent selector.
 */
import type { ChannelAdapter } from "../../node_modules/eve/dist/src/channel/adapter.js";
import type { RunHandle } from "../../node_modules/eve/dist/src/channel/types.js";
import type { WorkspaceWorkerTaskRequest } from "./workspace-worker-runner";

const adapter: ChannelAdapter = Object.freeze({
  kind: "channel:workspace-monitor-runner",
});

export async function startWorkspaceWorkerTask(
  request: WorkspaceWorkerTaskRequest,
): Promise<RunHandle> {
  // Resolve from Eve's own package URL so its private `#...` imports retain
  // Eve's package scope when authored modules are copied into the build cache.
  const eveEntry = import.meta.resolve("eve");
  const [{ createWorkflowRuntime }, { createBundledRuntimeCompiledArtifactsSource }] =
    await Promise.all([
      import(new URL("./execution/workflow-runtime.js", eveEntry).href) as Promise<
        typeof import("../../node_modules/eve/dist/src/execution/workflow-runtime.js")
      >,
      import(new URL("./runtime/compiled-artifacts-source.js", eveEntry).href) as Promise<
        typeof import("../../node_modules/eve/dist/src/runtime/compiled-artifacts-source.js")
      >,
    ]);
  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    nodeId: request.nodeId,
  });
  return runtime.createSession({
    adapter,
    auth: request.auth,
    continuationToken: request.continuationToken,
    input: request.input,
    limits: request.limits,
    mode: request.mode,
  });
}
