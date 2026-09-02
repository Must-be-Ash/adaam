import type { AgentReasoningDefinition } from "eve";

const MODEL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9._-]+$/u;

export type HybridTaskPurpose =
  | "deterministic_processing"
  | "extraction_recovery"
  | "semantic_interpretation";

export const HYBRID_MODEL_REASONING_VALUES = [
  "provider-default",
  "low",
  "high",
] as const satisfies readonly AgentReasoningDefinition[];

export type HybridModelReasoning = (typeof HYBRID_MODEL_REASONING_VALUES)[number];

export type HybridTaskModelRoute =
  | Readonly<{
      executionClass: "no_model";
      modelId: null;
      purpose: "deterministic_processing";
      reasoning: null;
    }>
  | Readonly<{
      executionClass: "fast";
      modelId: string;
      purpose: "extraction_recovery";
      reasoning: "provider-default" | "low";
    }>
  | Readonly<{
      executionClass: "frontier";
      modelId: string;
      purpose: "semantic_interpretation";
      reasoning: "high";
    }>;

export class HybridModelRoutingError extends Error {
  constructor(readonly code:
    | "hybrid_model_route_denied"
    | "hybrid_model_routing_invalid") {
    super(code);
    this.name = "HybridModelRoutingError";
  }
}

function invalid(): never {
  throw new HybridModelRoutingError("hybrid_model_routing_invalid");
}

function configuredModelId(value: string | undefined): string {
  if (!value || value !== value.trim() || !MODEL_ID_PATTERN.test(value) || value.length > 200) {
    return invalid();
  }
  return value;
}

function configuredRoutes(environment: NodeJS.ProcessEnv) {
  const fastModelId = configuredModelId(environment.EVE_HYBRID_FAST_MODEL_ID);
  const frontierModelId = configuredModelId(environment.EVE_HYBRID_FRONTIER_MODEL_ID);
  const fastReasoning = environment.EVE_HYBRID_FAST_MODEL_REASONING;
  const frontierReasoning = environment.EVE_HYBRID_FRONTIER_MODEL_REASONING;
  if (
    (fastReasoning !== "low" && fastReasoning !== "provider-default") ||
    frontierReasoning !== "high"
  ) return invalid();
  return Object.freeze({
    fast: Object.freeze({ modelId: fastModelId, reasoning: fastReasoning }),
    frontier: Object.freeze({ modelId: frontierModelId, reasoning: frontierReasoning }),
  });
}

export function resolveHybridTaskModelRoute(
  purpose: "deterministic_processing",
  environment?: NodeJS.ProcessEnv,
): Extract<HybridTaskModelRoute, { executionClass: "no_model" }>;
export function resolveHybridTaskModelRoute(
  purpose: "extraction_recovery",
  environment?: NodeJS.ProcessEnv,
): Extract<HybridTaskModelRoute, { executionClass: "fast" }>;
export function resolveHybridTaskModelRoute(
  purpose: "semantic_interpretation",
  environment?: NodeJS.ProcessEnv,
): Extract<HybridTaskModelRoute, { executionClass: "frontier" }>;
export function resolveHybridTaskModelRoute(
  purpose: HybridTaskPurpose,
  environment: NodeJS.ProcessEnv = process.env,
): HybridTaskModelRoute {
  if (purpose === "deterministic_processing") {
    return Object.freeze({
      executionClass: "no_model" as const,
      modelId: null,
      purpose,
      reasoning: null,
    });
  }
  const configured = configuredRoutes(environment);
  if (purpose === "extraction_recovery") {
    return Object.freeze({
      executionClass: "fast" as const,
      modelId: configured.fast.modelId,
      purpose,
      reasoning: configured.fast.reasoning,
    });
  }
  if (purpose === "semantic_interpretation") {
    return Object.freeze({
      executionClass: "frontier" as const,
      modelId: configured.frontier.modelId,
      purpose,
      reasoning: configured.frontier.reasoning,
    });
  }
  return invalid();
}

export function assertHybridModelRouteAllowed(
  route: HybridTaskModelRoute,
  allowedModelIds: readonly string[],
): void {
  if (route.executionClass === "no_model") return;
  if (!allowedModelIds.includes(route.modelId)) {
    throw new HybridModelRoutingError("hybrid_model_route_denied");
  }
}
