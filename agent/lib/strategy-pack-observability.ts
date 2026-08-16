import { z } from "zod";

export const STRATEGY_PACK_COUNTERS = [
  "strategy_pack_catalog_validation_total",
  "strategy_pack_install_total",
  "strategy_pack_configuration_total",
  "strategy_pack_removal_total",
  "strategy_pack_mutation_conflict_total",
  "strategy_pack_mutation_failure_total",
  "strategy_pack_binding_unavailable_total",
  "strategy_pack_run_stale_total",
  "strategy_pack_capability_unavailable_total",
] as const;

export const STRATEGY_PACK_REASON_CODES = [
  "authority_expansion",
  "catalog_disabled",
  "capability_unavailable",
  "conflict",
  "corrupt",
  "financial_guard",
  "invalid_request",
  "payload_conflict",
  "source_assignment_stale",
  "storage_failure",
  "unavailable",
] as const;

const observationSchema = z.object({
  counter: z.enum(STRATEGY_PACK_COUNTERS),
  outcome: z.enum(["committed", "replayed", "rejected"]).optional(),
  packId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,79}$/u).optional(),
  reasonCode: z.enum(STRATEGY_PACK_REASON_CODES).optional(),
  value: z.number().int().positive().max(1_000).default(1),
}).strict();

export type StrategyPackObservation = z.infer<typeof observationSchema>;
export type StrategyPackObservationSink = (observation: StrategyPackObservation) => void;

const consoleSink: StrategyPackObservationSink = (observation) => {
  const write = observation.reasonCode ? console.warn : console.info;
  write("[strategy.pack]", observation);
};

export function emitStrategyPackObservation(
  value: unknown,
  sink: StrategyPackObservationSink = consoleSink,
): void {
  sink(Object.freeze(observationSchema.parse(value)));
}

export function safeStrategyPackReasonCode(error: unknown): StrategyPackObservation["reasonCode"] {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Reflect.get(error, "code")
    : null;
  const aliases: Readonly<Record<string, NonNullable<StrategyPackObservation["reasonCode"]>>> = {
    strategy_pack_authority_expansion: "authority_expansion",
    strategy_pack_catalog_disabled: "catalog_disabled",
    strategy_pack_financial_approval_pending: "financial_guard",
    strategy_pack_invalid_request: "invalid_request",
    strategy_pack_mutation_conflict: "conflict",
    strategy_pack_mutation_corrupt: "corrupt",
    strategy_pack_mutation_payload_conflict: "payload_conflict",
    strategy_pack_mutations_disabled: "catalog_disabled",
    strategy_pack_source_assignment_stale: "source_assignment_stale",
    strategy_pack_unavailable: "unavailable",
  };
  return typeof code === "string" ? (aliases[code] ?? "storage_failure") : "storage_failure";
}
