import { z } from "zod";

import {
  PUBLIC_SOURCE_ADAPTER_IDS,
  PUBLIC_SOURCE_ERROR_CODES,
  type PublicSourceAcquisitionResult,
} from "./public-source-adapter-schema";

export const PUBLIC_SOURCE_RUNTIME_COUNTERS = [
  "public_source_acquisition_total",
  "public_source_fact_revision_total",
  "public_source_correction_total",
  "public_source_acquisition_reused_total",
  "public_source_projection_total",
  "public_source_failure_total",
] as const;

export const PUBLIC_SOURCE_COUNTER_OPERATIONS = ["created", "reused"] as const;
export const PUBLIC_SOURCE_FAILURE_STAGES = [
  "transport",
  "archive",
  "xml",
  "pdf",
  "normalize",
] as const;
export const PUBLIC_SOURCE_ACQUISITION_OUTCOMES = [
  "complete",
  "no_change",
  "partial",
  "retryable_failure",
  "terminal_failure",
  "uncertain",
] as const;

const counterSchema = z.enum(PUBLIC_SOURCE_RUNTIME_COUNTERS);
const operationSchema = z.enum(PUBLIC_SOURCE_COUNTER_OPERATIONS);
const outcomeSchema = z.enum(PUBLIC_SOURCE_ACQUISITION_OUTCOMES);
const stageSchema = z.enum(PUBLIC_SOURCE_FAILURE_STAGES);
const errorCodeSchema = z.enum(PUBLIC_SOURCE_ERROR_CODES);

export const publicSourceRuntimeObservationSchema = z.object({
  counter: counterSchema,
  errorCode: errorCodeSchema.optional(),
  operation: operationSchema.optional(),
  outcome: outcomeSchema.optional(),
  stage: stageSchema.optional(),
  value: z.number().int().positive().max(1_000).default(1),
}).strict().superRefine((observation, context) => {
  const needsOutcome = observation.counter === "public_source_acquisition_total";
  const needsOperation = observation.counter === "public_source_fact_revision_total" ||
    observation.counter === "public_source_correction_total" ||
    observation.counter === "public_source_projection_total";
  const needsFailure = observation.counter === "public_source_failure_total";
  if (needsOutcome !== (observation.outcome !== undefined)) {
    context.addIssue({ code: "custom", message: "Acquisition counters require a fixed outcome." });
  }
  if (needsOperation !== (observation.operation !== undefined)) {
    context.addIssue({ code: "custom", message: "Write counters require a fixed operation." });
  }
  if (needsFailure !== (observation.stage !== undefined && observation.errorCode !== undefined)) {
    context.addIssue({ code: "custom", message: "Failure counters require a fixed stage and code." });
  }
});

export type PublicSourceRuntimeObservation = z.infer<
  typeof publicSourceRuntimeObservationSchema
>;
export type PublicSourceRuntimeObservationSink = (
  observation: PublicSourceRuntimeObservation,
) => void;

export function parsePublicSourceRuntimeObservation(
  value: unknown,
): PublicSourceRuntimeObservation {
  return publicSourceRuntimeObservationSchema.parse(value);
}

const consoleSink: PublicSourceRuntimeObservationSink = (observation) => {
  const write = observation.counter === "public_source_failure_total"
    ? console.warn
    : console.info;
  write("[public-source.runtime]", observation);
};

export function emitPublicSourceRuntimeObservation(
  value: unknown,
  sink: PublicSourceRuntimeObservationSink = consoleSink,
): void {
  sink(Object.freeze(parsePublicSourceRuntimeObservation(value)));
}

export function emitPublicSourceAcquisitionObservations(
  acquisition: PublicSourceAcquisitionResult,
  sink?: PublicSourceRuntimeObservationSink,
): void {
  emitPublicSourceRuntimeObservation({
    counter: "public_source_acquisition_total",
    outcome: acquisition.status,
  }, sink);
  for (const receipt of acquisition.stageReceipts) {
    if (receipt.status !== "complete" && receipt.errorCode !== null) {
      emitPublicSourceRuntimeObservation({
        counter: "public_source_failure_total",
        errorCode: receipt.errorCode,
        stage: receipt.stage,
      }, sink);
    }
  }
}

const healthCursorSchema = z.object({
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  revision: z.number().int().nonnegative(),
  watermark: z.string().min(1).max(200).nullable(),
}).strict();
const healthOutcomeSchema = z.object({
  acquisitionId: z.string().min(3).max(200),
  coverage: z.enum(["complete", "partial", "unsupported"]),
  errorCode: z.enum(PUBLIC_SOURCE_ERROR_CODES).nullable(),
  failureStage: z.enum(PUBLIC_SOURCE_FAILURE_STAGES).nullable(),
  observedAt: z.string().datetime({ offset: true }),
  status: z.enum(PUBLIC_SOURCE_ACQUISITION_OUTCOMES),
}).strict().superRefine((outcome, context) => {
  if ((outcome.errorCode === null) !== (outcome.failureStage === null)) {
    context.addIssue({ code: "custom", message: "Health failure stage and code must be paired." });
  }
});

export const publicSourceHealthRecordSchema = z.object({
  adapterId: z.enum(PUBLIC_SOURCE_ADAPTER_IDS),
  adapterVersion: z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
  cursor: healthCursorSchema,
  extraction: z.object({
    complete: z.number().int().nonnegative().max(500),
    partial: z.number().int().nonnegative().max(500),
    state: z.enum(["complete", "partial", "unsupported"]),
    unsupported: z.number().int().nonnegative().max(500),
  }).strict(),
  lastCompleteAcquisition: z.object({
    acquisitionId: z.string().min(3).max(200),
    observedAt: z.string().datetime({ offset: true }),
    status: z.enum(["complete", "no_change"]),
  }).strict().nullable(),
  lastOutcome: healthOutcomeSchema,
  lifecycleState: z.enum(["active", "paused", "retired"]),
  recordType: z.literal("public_source_health"),
  schemaVersion: z.literal(1),
  sourceInstanceId: z.string().min(3).max(200),
}).strict();

export type PublicSourceHealthRecord = z.infer<typeof publicSourceHealthRecordSchema>;
