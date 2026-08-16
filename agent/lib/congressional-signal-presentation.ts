import { z } from "zod";

import type { CongressionalHistoryRevision } from "./congressional-history";
import {
  CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
  congressionalFilingSignalSchema,
} from "./congressional-signal-schema";
import {
  readCongressionalFilingSignal,
  readCongressionalHistory,
  type CongressionalSignalStoreClient,
} from "./congressional-signal-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";

const signalRevisionIdSchema = z.string()
  .regex(/^congressional-signal-revision\.[a-f0-9]{64}$/u);
const MAX_REASON_TRACE_ITEMS = 32;
const MAX_TRANSACTION_EXPLANATIONS = 8;
const MAX_SOURCE_RECORD_IDS = 8;

export class CongressionalSignalPresentationError extends Error {
  constructor(readonly code: "congressional_signal_not_found" | "congressional_signal_reference_invalid") {
    super(code);
    this.name = "CongressionalSignalPresentationError";
  }
}

export function explainCongressionalSignal(value: unknown) {
  const signal = congressionalFilingSignalSchema.parse(value);
  const transactionEvaluations = signal.transactionEvaluations
    .slice(0, MAX_TRANSACTION_EXPLANATIONS)
    .map((evaluation) => Object.freeze({
      band: evaluation.band,
      clusterRevisionIds: Object.freeze([...(evaluation.clusterRevisionIds ?? [])]),
      committeeState: evaluation.committeeResolution.state,
      evidence: Object.freeze(evaluation.evidence.map((item) => Object.freeze({
        reasonCode: item.reasonCode,
        sourceRecordCount: item.sourceRecordIds.length,
        sourceRecordIds: Object.freeze(item.sourceRecordIds.slice(0, MAX_SOURCE_RECORD_IDS)),
        sourceRecordsTruncated: item.sourceRecordIds.length > MAX_SOURCE_RECORD_IDS,
        state: item.state,
      }))),
      pattern: evaluation.patternResolution
        ? Object.freeze({
            ruleCodes: Object.freeze([...evaluation.patternResolution.ruleCodes]),
            state: evaluation.patternResolution.state,
          })
        : null,
      reasonCodes: Object.freeze([...evaluation.reasonCodes]),
      transactionRevisionId: evaluation.transactionRevisionId,
    }));
  return Object.freeze({
    alertEligible: signal.alertEligible,
    band: signal.band,
    catalogReferences: Object.freeze(structuredClone(signal.catalogReferences)),
    caveat: CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
    createdAt: signal.createdAt,
    lineage: Object.freeze({ ...signal.lineage }),
    packBinding: Object.freeze({ ...signal.packBinding }),
    policyReference: Object.freeze({ ...signal.policyReference }),
    reasonTrace: Object.freeze(signal.reasonTrace.slice(0, MAX_REASON_TRACE_ITEMS)
      .map((item) => Object.freeze({ ...item }))),
    reasonTraceTruncated: signal.reasonTrace.length > MAX_REASON_TRACE_ITEMS,
    signalRevisionId: signal.signalRevisionId,
    transactionEvaluations: Object.freeze(transactionEvaluations),
    transactionEvaluationsTruncated:
      signal.transactionEvaluations.length > MAX_TRANSACTION_EXPLANATIONS,
    transactionOutcomeCounts: Object.freeze(signal.transactionEvaluations.reduce(
      (counts, evaluation) => ({ ...counts, [evaluation.band]: counts[evaluation.band] + 1 }),
      { priority: 0, record_only: 0, review: 0 },
    )),
  });
}

export async function readCongressionalSignalExplanation(input: {
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly signalRevisionId: string;
}, client?: CongressionalSignalStoreClient) {
  const signalRevisionId = signalRevisionIdSchema.safeParse(input.signalRevisionId);
  if (!signalRevisionId.success) {
    throw new CongressionalSignalPresentationError("congressional_signal_reference_invalid");
  }
  const signal = await readCongressionalFilingSignal(input.scope, signalRevisionId.data, client);
  if (!signal) throw new CongressionalSignalPresentationError("congressional_signal_not_found");
  return explainCongressionalSignal(signal);
}

export async function readLatestCongressionalSignalExplanation(
  scope: AuthorizedWorkspaceStoreScope,
  client?: CongressionalSignalStoreClient,
) {
  const history = await readCongressionalHistory(scope, client);
  if (!history) throw new CongressionalSignalPresentationError("congressional_signal_not_found");
  const signalRevisionId = latestSignalRevisionId(history);
  if (!signalRevisionId) {
    throw new CongressionalSignalPresentationError("congressional_signal_not_found");
  }
  return readCongressionalSignalExplanation({ scope, signalRevisionId }, client);
}

function signalOutcomeCounts(history: CongressionalHistoryRevision) {
  const rank = { priority: 2, record_only: 0, review: 1 } as const;
  const signals = new Map<string, { alertEligible: boolean; band: keyof typeof rank }>();
  for (const entry of history.activeEntries) {
    const current = signals.get(entry.signalRevisionId);
    signals.set(entry.signalRevisionId, {
      alertEligible: entry.alertEligible || (current?.alertEligible ?? false),
      band: !current || rank[entry.band] > rank[current.band] ? entry.band : current.band,
    });
  }
  const values = [...signals.values()];
  return Object.freeze({
    alertEligible: values.filter(({ alertEligible }) => alertEligible).length,
    priority: values.filter(({ band }) => band === "priority").length,
    recordOnly: values.filter(({ band }) => band === "record_only").length,
    review: values.filter(({ band }) => band === "review").length,
    total: values.length,
  });
}

function latestSignalRevisionId(history: CongressionalHistoryRevision): string | null {
  return [...history.activeEntries].sort((left, right) =>
    right.transaction.observedAt.localeCompare(left.transaction.observedAt) ||
    right.signalRevisionId.localeCompare(left.signalRevisionId))[0]?.signalRevisionId ?? null;
}

export async function readCongressionalWorkspacePresentation(
  scope: AuthorizedWorkspaceStoreScope,
  client?: CongressionalSignalStoreClient,
) {
  const history = await readCongressionalHistory(scope, client);
  if (!history) {
    return Object.freeze({
      coverage: null,
      latestSignal: null,
      outcomeCounts: Object.freeze({ alertEligible: 0, priority: 0, recordOnly: 0, review: 0, total: 0 }),
      state: "not_initialized" as const,
    });
  }
  const signalRevisionId = latestSignalRevisionId(history);
  const latestSignal = signalRevisionId
    ? await readCongressionalFilingSignal(scope, signalRevisionId, client)
    : null;
  if (signalRevisionId && !latestSignal) {
    throw new CongressionalSignalPresentationError("congressional_signal_not_found");
  }
  return Object.freeze({
    coverage: Object.freeze({ ...history.coverage }),
    latestSignal: latestSignal
      ? Object.freeze({
          alertEligible: latestSignal.alertEligible,
          band: latestSignal.band,
          caveat: CONGRESSIONAL_SIGNAL_NEUTRAL_CAVEAT,
          createdAt: latestSignal.createdAt,
          signalRevisionId: latestSignal.signalRevisionId,
        })
      : null,
    outcomeCounts: signalOutcomeCounts(history),
    state: "available" as const,
  });
}
