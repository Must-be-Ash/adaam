import { createHash } from "node:crypto";

import type { RunHandle } from "../../node_modules/eve/dist/src/channel/types.js";

import {
  reconcileHybridEvidenceAttempt,
  reserveHybridEvidenceAttempt,
  type HybridEvidenceBudgetReservation,
} from "./hybrid-evidence-budget";
import {
  createExtractionRecoveryDefinitions,
  EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID,
} from "./hybrid-evidence-definition-registry";
import { createAcceptedExtractionResult } from "./hybrid-evidence-extraction-recovery";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import {
  acceptHybridEvidenceJob,
  failHybridEvidenceJob,
  markHybridEvidenceJobUncertain,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  type HybridEvidenceJobStoreClient,
} from "./hybrid-evidence-job-store";
import {
  advanceHybridSourceResultLineage,
  type HybridEvidenceLineageStoreClient,
} from "./hybrid-evidence-lineage-store";
import {
  digestHybridEvidenceValue,
  type EvidenceLocator,
} from "./hybrid-evidence-schema";
import {
  prepareHybridEvidenceWorkerRun,
  startHybridEvidenceWorkerTask,
  workerCandidateSchema,
  type PreparedHybridEvidenceWorkerRun,
} from "./hybrid-evidence-worker";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceGlobalBudgetClient } from "./workspace-dispatch-budget";
import {
  earningsTranscriptSchema,
  type EarningsTranscript,
} from "./earnings-call-schema";
import { validateEarningsCallTranscriptRecoveryCandidate } from "./earnings-call-transcript";

type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  paidCostUsd?: string;
}>;

export interface EarningsCallTranscriptRecoveryClients {
  readonly artifacts: HybridEvidenceArtifactStore;
  readonly globalBudget?: WorkspaceGlobalBudgetClient;
  readonly jobs?: HybridEvidenceJobStoreClient;
  readonly lineage?: HybridEvidenceLineageStoreClient;
  readonly workspaceBudget?: WorkspaceBudgetLedgerClient;
}

export type EarningsCallTranscriptRecoveryResult =
  | Readonly<{
      normalizedText: string;
      resultId: string;
      state: "accepted";
      transcript: EarningsTranscript;
    }>
  | Readonly<{
      reason: "budget_unavailable" | "candidate_invalid" | "execution_unavailable";
      state: "unavailable";
    }>;

async function drain(handle: RunHandle): Promise<ModelUsage | undefined> {
  const reader = handle.events.getReader();
  let inputTokens = 0;
  let outputTokens = 0;
  let paidCostUsd = 0;
  let sawUsage = false;
  let missingCost = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type !== "step.completed") continue;
      const usage = next.value.data.usage;
      if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) continue;
      sawUsage = true;
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      if (usage.costUsd === undefined) missingCost = true;
      else paidCostUsd += usage.costUsd;
    }
  } finally {
    reader.releaseLock();
  }
  return sawUsage
    ? Object.freeze({
        inputTokens,
        outputTokens,
        ...(missingCost ? {} : { paidCostUsd: String(paidCostUsd) }),
      })
    : undefined;
}

export async function runEarningsCallTranscriptLayoutRecovery(input: {
  readonly acquisitionId: string;
  readonly artifactDigest: string;
  readonly artifactMediaType: "application/pdf" | "text/html";
  readonly artifactUrl: string;
  readonly clients: EarningsCallTranscriptRecoveryClients;
  readonly dispatch?: (input: {
    readonly prepared: PreparedHybridEvidenceWorkerRun;
    readonly reservation: HybridEvidenceBudgetReservation;
  }) => Promise<ModelUsage | void>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly eventRevisionId: string;
  readonly initiatingWorkspaceId: string;
  readonly modelId: string;
  readonly observedAt: string;
  readonly sourceInstanceId: string;
  readonly sourceLogicalKey: string;
  readonly sourceText: string;
  readonly startWorker?: (request: PreparedHybridEvidenceWorkerRun["request"]) => Promise<RunHandle>;
}): Promise<EarningsCallTranscriptRecoveryResult> {
  const now = new Date();
  const definition = createExtractionRecoveryDefinitions([input.modelId]).find(
    ({ definitionId }) => definitionId === EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID,
  )!;
  const projectionText = `${input.sourceText}\n<!-- eve normalized transcript projection -->`;
  const bytes = Buffer.from(projectionText, "utf8");
  const manifest = await input.clients.artifacts.persist({
    acquisitionId: input.acquisitionId,
    authority: new URL(input.artifactUrl).hostname,
    bytes,
    canonicalPublicUrl: input.artifactUrl,
    mediaType: "text/html",
    observedAt: input.observedAt,
    parserEligibility: {
      adapterId: "earnings-call-transcripts",
      factSchemaVersion: "earnings-call-event/v1",
      outcomeDigest: input.artifactDigest,
      reasonCode: "transcript_layout_changed",
      state: "unsupported",
    },
    sourceInstanceId: input.sourceInstanceId,
    structure: {
      characterCount: projectionText.length,
      columnCount: null,
      pageCount: null,
      rowCount: null,
      sheetCount: null,
    },
  });
  const locator: EvidenceLocator = {
    artifactDigest: manifest.contentDigest,
    end: input.sourceText.length,
    kind: "text_span",
    spanDigest: createHash("sha256").update(input.sourceText).digest("hex"),
    start: 0,
  };
  let record = await prepareHybridEvidenceJob({
    artifacts: [manifest],
    definition,
    inputContextDigest: digestHybridEvidenceValue([
      input.artifactDigest,
      input.eventRevisionId,
      input.artifactMediaType,
    ]),
    locators: [locator],
    modelId: input.modelId,
    now,
    scope: {
      initiatingWorkspaceId: input.initiatingWorkspaceId,
      kind: "source_global",
      sourceInstanceId: input.sourceInstanceId,
    },
  }, input.clients.jobs);
  const convergeAccepted = async (acceptedRecord: typeof record) => {
    if (!acceptedRecord.acceptedResult) throw new Error("validator_failed");
    const transcript = earningsTranscriptSchema.parse(acceptedRecord.acceptedResult.payload);
    if (
      transcript.artifactDigest !== input.artifactDigest ||
      transcript.eventRevisionId !== input.eventRevisionId
    ) throw new Error("validator_failed");
    await input.clients.artifacts.setReference({
      active: true,
      artifactDigest: manifest.contentDigest,
      kind: "accepted_result",
      referenceId: acceptedRecord.acceptedResult.resultId,
    });
    await advanceHybridSourceResultLineage({
      lineageKey: `${input.sourceInstanceId}:${input.sourceLogicalKey}:${definition.definitionId}`,
      now: new Date(acceptedRecord.acceptedResult.validatedAt),
      resultId: acceptedRecord.acceptedResult.resultId,
      sourceDigest: input.artifactDigest,
      sourceRevision: input.eventRevisionId,
    }, input.clients.lineage);
    await input.clients.artifacts.deleteUnreferenced(manifest.contentDigest);
    return Object.freeze({
      normalizedText: input.sourceText,
      resultId: acceptedRecord.acceptedResult.resultId,
      state: "accepted" as const,
      transcript,
    });
  };
  if (record.job.state === "accepted" && record.acceptedResult) {
    try {
      return await convergeAccepted(record);
    } catch {
      return Object.freeze({ reason: "candidate_invalid", state: "unavailable" as const });
    }
  }
  if (record.job.state !== "prepared") {
    return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
  }

  let reservation: HybridEvidenceBudgetReservation;
  try {
    reservation = await reserveHybridEvidenceAttempt({
      definition,
      environment: input.environment,
      job: record.job,
      now,
    }, {
      global: input.clients.globalBudget,
      workspace: input.clients.workspaceBudget,
    });
  } catch {
    await failHybridEvidenceJob({ code: "budget_exhausted", jobId: record.job.jobId, now }, input.clients.jobs);
    await input.clients.artifacts.setRetention({
      artifactDigest: manifest.contentDigest,
      now,
      state: "quarantined",
    }).catch(() => undefined);
    return Object.freeze({ reason: "budget_unavailable", state: "unavailable" as const });
  }

  const prepared = await prepareHybridEvidenceWorkerRun({
    budget: reservation,
    definition,
    environment: input.environment,
    jobClient: input.clients.jobs,
    locators: [locator],
    now,
    prepared: record,
  });
  try {
    const usage = input.dispatch
      ? await input.dispatch({ prepared, reservation })
      : await drain(await (input.startWorker ?? startHybridEvidenceWorkerTask)(prepared.request));
    record = (await readHybridEvidenceJob(record.job.jobId, input.clients.jobs))!;
    if (record.job.state !== "completed" || !record.candidate) throw new Error("validator_failed");
    const candidate = workerCandidateSchema.parse(record.candidate);
    if (candidate.disposition !== "accepted" || candidate.unknowns.length > 0) {
      throw new Error("validator_failed");
    }
    const transcript = validateEarningsCallTranscriptRecoveryCandidate({
      artifactDigest: input.artifactDigest,
      candidate: candidate.fields,
      eventRevisionId: input.eventRevisionId,
      sourceText: input.sourceText,
    });
    const acceptedResult = createAcceptedExtractionResult({
      citations: [locator],
      definition,
      job: record,
      now: new Date(),
      payload: transcript as unknown as Readonly<Record<string, unknown>>,
      usage: {
        inputTokens: usage?.inputTokens ?? definition.limits.maximumInputTokens,
        outputTokens: usage?.outputTokens ?? definition.limits.maximumOutputTokens,
        paidCostUsd: usage?.paidCostUsd ?? definition.limits.maximumPaidCostUsd,
      },
    });
    const accepted = await acceptHybridEvidenceJob({
      jobId: record.job.jobId,
      now: new Date(),
      result: acceptedResult,
    }, input.clients.jobs);
    const converged = await convergeAccepted(accepted);
    await reconcileHybridEvidenceAttempt({
      actualInputTokens: accepted.acceptedResult?.usage.inputTokens,
      actualOutputTokens: accepted.acceptedResult?.usage.outputTokens,
      actualPaidCost: accepted.acceptedResult?.usage.paidCostUsd,
      outcome: "reconciled",
      reservation,
    }, { global: input.clients.globalBudget, workspace: input.clients.workspaceBudget });
    return converged;
  } catch {
    const latest = await readHybridEvidenceJob(record.job.jobId, input.clients.jobs);
    if (latest?.job.state === "accepted" && latest.acceptedResult) {
      try {
        const converged = await convergeAccepted(latest);
        await reconcileHybridEvidenceAttempt({
          actualInputTokens: latest.acceptedResult.usage.inputTokens,
          actualOutputTokens: latest.acceptedResult.usage.outputTokens,
          actualPaidCost: latest.acceptedResult.usage.paidCostUsd,
          outcome: "reconciled",
          reservation,
        }, { global: input.clients.globalBudget, workspace: input.clients.workspaceBudget });
        return converged;
      } catch {
        await reconcileHybridEvidenceAttempt({ outcome: "uncertain", reservation }, {
          global: input.clients.globalBudget,
          workspace: input.clients.workspaceBudget,
        });
        return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
      }
    }
    if (latest?.job.state === "completed") {
      await quarantineHybridEvidenceJob({
        codes: ["validator_failed"],
        jobId: latest.job.jobId,
        now: new Date(),
      }, input.clients.jobs);
      await input.clients.artifacts.setRetention({
        artifactDigest: manifest.contentDigest,
        now: new Date(),
        state: "quarantined",
      }).catch(() => undefined);
      await reconcileHybridEvidenceAttempt({ outcome: "reconciled", reservation }, {
        global: input.clients.globalBudget,
        workspace: input.clients.workspaceBudget,
      });
      return Object.freeze({ reason: "candidate_invalid", state: "unavailable" as const });
    }
    if (latest && (latest.job.state === "prepared" || latest.job.state === "running")) {
      await markHybridEvidenceJobUncertain({ jobId: latest.job.jobId, now: new Date() }, input.clients.jobs);
    }
    await reconcileHybridEvidenceAttempt({ outcome: "uncertain", reservation }, {
      global: input.clients.globalBudget,
      workspace: input.clients.workspaceBudget,
    });
    return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
  }
}
