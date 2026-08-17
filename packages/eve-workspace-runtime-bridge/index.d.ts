interface NodeTargetedWorkflowRuntime {
  createSession(input: unknown): Promise<unknown>;
}

export declare function createNodeTargetedWorkflowRuntime(config: {
  readonly dynamicSubagentAgentConfig?: {
    readonly description?: string;
    readonly limits?: {
      readonly maxInputTokensPerSession?: number | false;
      readonly maxOutputTokensPerSession?: number | false;
      readonly sessionTimeoutMs?: number | false;
    };
    readonly model: string;
    readonly reasoning?: "minimal" | "low" | "medium" | "high";
  };
  readonly nodeId: string;
}): Promise<NodeTargetedWorkflowRuntime>;
