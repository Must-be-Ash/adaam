import { createHash } from "node:crypto";

import type { RunHandle } from "../../node_modules/eve/dist/src/channel/types.js";

import {
  reconcileHybridEvidenceAttempt,
  reconcileRecordedHybridEvidenceAttempt,
  reserveAdmittedHybridEvidenceAttempt,
  type HybridEvidenceBudgetReservation,
} from "./hybrid-evidence-budget";
import {
  createExtractionRecoveryDefinitions,
  EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID,
} from "./hybrid-evidence-definition-registry";
import {
  assertHybridModelRouteAllowed,
  resolveHybridTaskModelRoute,
} from "./hybrid-evidence-model-routing";
import { createAcceptedExtractionResult } from "./hybrid-evidence-extraction-recovery";
import type { HybridEvidenceArtifactStore } from "./hybrid-evidence-artifact-store";
import {
  acceptHybridEvidenceJob,
  expireHybridEvidenceJobClaim,
  retryUncertainHybridEvidenceJob,
  resetHybridEvidenceJobAdmission,
  persistHybridEvidenceExtractionUsage,
  markHybridEvidenceJobUncertain,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  waitForHybridEvidenceJobSettlement,
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
  drainHybridEvidenceWorker,
  startHybridEvidenceWorkerTask,
  workerCandidateSchema,
  type PreparedHybridEvidenceWorkerRun,
} from "./hybrid-evidence-worker";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceStateStoreClient } from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import {
  resolveHybridEvidenceDeploymentBudgetLimits,
  type WorkspaceGlobalBudgetClient,
} from "./workspace-dispatch-budget";
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
  readonly state?: WorkspaceStateStoreClient;
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

const WORKER_DISPATCH_ERROR_SETTLEMENT_GRACE_MS = 15_000;


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
  readonly observedAt: string;
  readonly parentBudgetRunId?: string;
  readonly scope?: AuthorizedWorkspaceStoreScope;
  readonly sourceInstanceId: string;
  readonly sourceLogicalKey: string;
  readonly sourceText: string;
  readonly startWorker?: (request: PreparedHybridEvidenceWorkerRun["request"]) => Promise<RunHandle>;
}): Promise<EarningsCallTranscriptRecoveryResult> {
  const now = new Date();
  const route = resolveHybridTaskModelRoute(
    "extraction_recovery",
    input.environment,
  );
  assertHybridModelRouteAllowed(
    route,
    resolveHybridEvidenceDeploymentBudgetLimits(input.environment).allowedModelIds,
  );
  const definition = createExtractionRecoveryDefinitions([route.modelId]).find(
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
    modelId: route.modelId,
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
    for (const kind of ["accepted_result", "current_lineage"] as const) await input.clients.artifacts.setReference({
      active: true,
      artifactDigest: manifest.contentDigest,
      kind,
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
    await reconcileRecordedHybridEvidenceAttempt({
      receipt: acceptedRecord.attemptReceipt ?? { lane: "source_global_extraction", reservationKey: acceptedRecord.job.budgetReservation.key, workspace: null },
      environment: input.environment, outcome: "reconciled",
      actualInputTokens: acceptedRecord.acceptedResult.usage.inputTokens,
      actualOutputTokens: acceptedRecord.acceptedResult.usage.outputTokens,
      actualPaidCost: acceptedRecord.acceptedResult.usage.paidCostUsd,
    }, { global: input.clients.globalBudget, workspace: input.clients.workspaceBudget });
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
  if (record.job.state === "running") {
    record = await expireHybridEvidenceJobClaim({ definition, jobId: record.job.jobId }, input.clients.jobs);
  }
  if (record.job.state === "uncertain" && record.attemptReceipt) {
    await reconcileRecordedHybridEvidenceAttempt({ receipt: record.attemptReceipt, environment: input.environment,
      outcome: "uncertain" }, { global: input.clients.globalBudget, workspace: input.clients.workspaceBudget });
    if (record.job.attempt < definition.limits.maximumAttempts) {
      record = await retryUncertainHybridEvidenceJob({ definition, jobId: record.job.jobId }, input.clients.jobs);
    }
  }
  if (record.job.state !== "prepared" && record.job.state !== "completed") {
    return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
  }

  let reservation: HybridEvidenceBudgetReservation | undefined;
  let admissionToken: string | undefined;
  if (record.job.state === "prepared") try {
    const admitted = await reserveAdmittedHybridEvidenceAttempt({
      record, initiatingWorkspaceId: input.initiatingWorkspaceId,
      definition,
      environment: input.environment,
      job: record.job,
      now,
      parentRunId: input.parentBudgetRunId,
      scope: input.scope,
    }, {
      jobs: input.clients.jobs,
      global: input.clients.globalBudget,
      state: input.clients.state,
      workspace: input.clients.workspaceBudget,
    });
    ({ record, reservation, admissionToken } = admitted);
  } catch {
    return Object.freeze({ reason: "budget_unavailable", state: "unavailable" as const });
  }

  let validationStarted = false;
  let validationCompleted = false;
  let ownedClaimToken: string | undefined;
  let usage: ModelUsage | void = record.extractionUsage ?? undefined;
  try {
  if (record.job.state === "prepared") {
  const prepared = await prepareHybridEvidenceWorkerRun({
    admissionToken,
    budget: reservation!,
    definition,
    environment: input.environment,
    jobClient: input.clients.jobs,
    locators: [locator],
    now,
    prepared: record,
    reasoning: route.reasoning,
  });
    ownedClaimToken = prepared.token;
    const workerSettlementDeadline = Date.now() + definition.limits.maximumRuntimeMs;
    let dispatchError: unknown;
    try {
      usage = input.dispatch
        ? await input.dispatch({ prepared, reservation: reservation! })
        : await drainHybridEvidenceWorker(await (input.startWorker ?? startHybridEvidenceWorkerTask)(prepared.request));
    } catch (error) {
      dispatchError = error;
    }
    record = (await waitForHybridEvidenceJobSettlement({
      jobId: record.job.jobId,
      maximumWaitMs: Math.min(
        Math.max(0, workerSettlementDeadline - Date.now()),
        dispatchError === undefined
          ? definition.limits.maximumRuntimeMs
          : WORKER_DISPATCH_ERROR_SETTLEMENT_GRACE_MS,
      ),
    }, input.clients.jobs))!;
    if (dispatchError !== undefined && record.job.state !== "completed") throw dispatchError;
    if (record.job.state === "completed" && usage) record = await persistHybridEvidenceExtractionUsage({
      claimToken: prepared.token, jobId: record.job.jobId, usage,
    }, input.clients.jobs);
  }
    if (record.job.state !== "completed" || !record.candidate) throw new Error("validator_failed");
    validationStarted = true;
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
    validationCompleted = true;
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
    return converged;
  } catch {
    const latest = await readHybridEvidenceJob(record.job.jobId, input.clients.jobs);
    if (latest?.job.state === "accepted" && latest.acceptedResult) {
      try {
        return await convergeAccepted(latest);
      } catch {
        return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
      }
    }
    if (latest?.job.state === "completed" && validationStarted && !validationCompleted) {
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
      await reconcileRecordedHybridEvidenceAttempt({ outcome: "reconciled", environment: input.environment,
        receipt: latest.attemptReceipt!, actualInputTokens: usage?.inputTokens,
        actualOutputTokens: usage?.outputTokens, actualPaidCost: usage?.paidCostUsd }, {
        global: input.clients.globalBudget,
        workspace: input.clients.workspaceBudget,
      });
      return Object.freeze({ reason: "candidate_invalid", state: "unavailable" as const });
    }
    if (latest?.job.state === "prepared" && reservation) {
      await reconcileHybridEvidenceAttempt({ outcome: "released", reservation }, {
        global: input.clients.globalBudget, workspace: input.clients.workspaceBudget,
      });
      await resetHybridEvidenceJobAdmission({ admissionToken, jobId: latest.job.jobId, reservationKey: reservation.reservationKey }, input.clients.jobs);
    } else if (latest?.job.state === "running" && ownedClaimToken &&
      latest.claimTokenDigest === createHash("sha256").update(ownedClaimToken).digest("hex")) {
      await markHybridEvidenceJobUncertain({ jobId: latest.job.jobId, now: new Date() }, input.clients.jobs);
      await reconcileRecordedHybridEvidenceAttempt({ outcome: "uncertain", receipt: latest.attemptReceipt!, environment: input.environment }, {
        global: input.clients.globalBudget, workspace: input.clients.workspaceBudget,
      });
    }
    return Object.freeze({ reason: "execution_unavailable", state: "unavailable" as const });
  }
}
