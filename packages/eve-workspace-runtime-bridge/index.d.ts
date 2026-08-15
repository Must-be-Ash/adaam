interface NodeTargetedWorkflowRuntime {
  createSession(input: unknown): Promise<unknown>;
}

export declare function createNodeTargetedWorkflowRuntime(config: {
  readonly nodeId: string;
}): Promise<NodeTargetedWorkflowRuntime>;
