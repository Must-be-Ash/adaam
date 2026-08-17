import { createWorkflowRuntime } from "../../eve/dist/src/execution/workflow-runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "../../eve/dist/src/runtime/compiled-artifacts-source.js";

export async function createNodeTargetedWorkflowRuntime(config) {
  return createWorkflowRuntime({
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    dynamicSubagentAgentConfig: config.dynamicSubagentAgentConfig,
    nodeId: config.nodeId,
  });
}
