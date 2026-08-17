import type { RunHandle } from "../../node_modules/eve/dist/src/channel/types.js";

import {
  createHybridEvidenceArtifactStore,
  type HybridEvidenceArtifactStore,
} from "./hybrid-evidence-artifact-store";
import {
  reconcileHybridEvidenceAttempt,
  reserveHybridEvidenceAttempt,
  type HybridEvidenceBudgetReservation,
} from "./hybrid-evidence-budget";
import {
  createExtractionRecoveryDefinitions,
  HOUSE_DOCUMENT_ROW_DEFINITION_ID,
} from "./hybrid-evidence-definition-registry";
import {
  assessExtractionRecoveryEligibility,
  createAcceptedExtractionResult,
  validateHouseDocumentRowCandidate,
} from "./hybrid-evidence-extraction-recovery";
import {
  acceptHybridEvidenceJob,
  markHybridEvidenceJobUncertain,
  prepareHybridEvidenceJob,
  quarantineHybridEvidenceJob,
  readHybridEvidenceJob,
  type HybridEvidenceJobRecord,
  type HybridEvidenceJobStoreClient,
} from "./hybrid-evidence-job-store";
import {
  projectHybridEvidencePdf,
  readIndependentPdfText,
  type IndependentPdfOcr,
} from "./hybrid-evidence-pdf";
import type { EvidenceLocator } from "./hybrid-evidence-schema";
import {
  advanceHybridSourceResultLineage,
  type HybridEvidenceLineageStoreClient,
} from "./hybrid-evidence-lineage-store";
import {
  prepareHybridEvidenceWorkerRun,
  startHybridEvidenceWorkerTask,
  type PreparedHybridEvidenceWorkerRun,
} from "./hybrid-evidence-worker";
import type {
  HouseHybridRecovery,
  HouseHybridRecoveryResult,
} from "./house-public-source-adapter";
import type { WorkspaceBudgetLedgerClient } from "./workspace-budget-ledger";
import type { WorkspaceGlobalBudgetClient } from "./workspace-dispatch-budget";

export interface HouseHybridEvidenceRecoveryClients {
  readonly artifacts?: HybridEvidenceArtifactStore;
  readonly globalBudget?: WorkspaceGlobalBudgetClient;
  readonly jobs?: HybridEvidenceJobStoreClient;
  readonly lineage?: HybridEvidenceLineageStoreClient;
  readonly workspaceBudget?: WorkspaceBudgetLedgerClient;
}

export interface HouseHybridEvidenceRecoveryDependencies {
  readonly dispatch?: (input: {
    readonly prepared: PreparedHybridEvidenceWorkerRun;
    readonly reservation: HybridEvidenceBudgetReservation;
  }) => Promise<void>;
  readonly ocr?: IndependentPdfOcr;
  readonly startWorker?: (request: PreparedHybridEvidenceWorkerRun["request"]) => Promise<RunHandle>;
}

async function drain(handle: RunHandle): Promise<void> {
  const reader = handle.events.getReader();
  try {
    while (!(await reader.read()).done) {
      // The controlled completion tool owns the durable result. Event content
      // is intentionally ignored so provider payloads never enter app logs.
    }
  } finally {
    reader.releaseLock();
  }
}

function validationCode(error: unknown) {
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "validator_failed";
  const allowed = new Set([
    "citation_invalid",
    "evidence_bounds_exceeded",
    "hostile_document",
    "independent_value_mismatch",
    "prompt_injection_detected",
    "required_field_unknown",
    "row_identity_ambiguous",
    "schema_mismatch",
    "source_relationship_invalid",
    "validator_failed",
  ] as const);
  return allowed.has(code as never) ? code as Parameters<typeof quarantineHybridEvidenceJob>[0]["codes"][number] : "validator_failed";
}

export function createHouseHybridEvidenceRecovery(input: {
  readonly clients?: HouseHybridEvidenceRecoveryClients;
  readonly dependencies?: HouseHybridEvidenceRecoveryDependencies;
  readonly environment?: NodeJS.ProcessEnv;
  readonly initiatingWorkspaceId: string;
  readonly modelId: string;
}): HouseHybridRecovery {
  const environment = input.environment ?? process.env;
  const artifacts = input.clients?.artifacts ?? createHybridEvidenceArtifactStore();
  const definition = createExtractionRecoveryDefinitions([input.modelId]).find(
    (candidate) => candidate.definitionId === HOUSE_DOCUMENT_ROW_DEFINITION_ID,
  )!;
  const startWorker = input.dependencies?.startWorker ?? startHybridEvidenceWorkerTask;

  return Object.freeze({
    async recover(
      recoveryInput: Parameters<HouseHybridRecovery["recover"]>[0],
    ): Promise<HouseHybridRecoveryResult | null> {
      const processingNow = new Date();
      const decision = assessExtractionRecoveryEligibility({
        definition,
        outcome: {
          errorCode: recoveryInput.deterministic.errorCode,
          plausibilityPassed: recoveryInput.deterministic.state !== "suspicious",
          relationshipPassed: recoveryInput.deterministic.state !== "suspicious",
          state: recoveryInput.deterministic.state,
        },
      });
      if (decision.kind !== "recover") return null;

      let projection;
      try {
        projection = await projectHybridEvidencePdf(recoveryInput.artifact);
      } catch {
        return null;
      }
      const manifest = await artifacts.persist({
        acquisitionId: recoveryInput.acquisitionId,
        authority: "House Clerk",
        bytes: recoveryInput.artifact,
        canonicalPublicUrl: recoveryInput.publicUrl,
        mediaType: "application/pdf",
        observedAt: recoveryInput.observedAt,
        parserEligibility: {
          adapterId: recoveryInput.source.adapterId,
          factSchemaVersion: "house-ptr-transaction/v1",
          outcomeDigest: recoveryInput.deterministic.errorCode === "deterministic_false_success"
            ? recoveryInput.row.rowDigest
            : projection.documentDigest,
          reasonCode: decision.code,
          state: decision.state,
        },
        sourceInstanceId: recoveryInput.source.sourceInstanceId,
        structure: {
          characterCount: null,
          columnCount: null,
          pageCount: projection.pageCount,
          rowCount: null,
          sheetCount: null,
        },
      });
      const locators: EvidenceLocator[] = projection.pages.map((page) => ({
        artifactDigest: projection.documentDigest,
        evidenceDigest: page.evidenceDigest,
        kind: "pdf_page",
        page: page.page,
        region: null,
      }));
      let record = await prepareHybridEvidenceJob({
        artifacts: [manifest],
        definition,
        inputContextDigest: recoveryInput.row.rowDigest,
        locators,
        modelId: input.modelId,
        now: processingNow,
        scope: {
          initiatingWorkspaceId: input.initiatingWorkspaceId,
          kind: "source_global",
          sourceInstanceId: recoveryInput.source.sourceInstanceId,
        },
      }, input.clients?.jobs);
      if (record.job.state === "accepted" && record.acceptedResult) {
        const payload = record.acceptedResult.payload as unknown as HouseHybridRecoveryResult;
        const filerName = [
          recoveryInput.row.filer.prefix,
          recoveryInput.row.filer.firstName,
          recoveryInput.row.filer.lastName,
          recoveryInput.row.filer.suffix,
        ].filter((value): value is string => value !== null).join(" ");
        if (
          !payload.document || !Array.isArray(payload.rows) ||
          payload.document.docId !== recoveryInput.row.docId ||
          payload.document.filerName !== filerName ||
          payload.document.filingDate !== recoveryInput.row.filingDate ||
          payload.document.stateDistrict !== recoveryInput.row.filer.stateDistrict
        ) return null;
        await advanceHybridSourceResultLineage({
          lineageKey: `${recoveryInput.source.sourceInstanceId}:${recoveryInput.row.year}:${recoveryInput.row.docId}:${definition.definitionId}`,
          now: new Date(recoveryInput.observedAt),
          resultId: record.acceptedResult.resultId,
          sourceDigest: recoveryInput.row.rowDigest,
          sourceRevision: `cursor:${recoveryInput.source.cursor.revision}:row:${recoveryInput.row.rowDigest}`,
        }, input.clients?.lineage);
        return Object.freeze({
          document: payload.document,
          resultId: record.acceptedResult.resultId,
          rows: payload.rows,
        });
      }
      if (record.job.state !== "prepared") return null;

      const reservation = await reserveHybridEvidenceAttempt({
        definition,
        environment,
        job: record.job,
        now: processingNow,
      }, {
        global: input.clients?.globalBudget,
        workspace: input.clients?.workspaceBudget,
      });
      const prepared = await prepareHybridEvidenceWorkerRun({
        budget: reservation,
        definition,
        environment,
        jobClient: input.clients?.jobs,
        locators,
        now: processingNow,
        prepared: record,
      });
      try {
        if (input.dependencies?.dispatch) {
          await input.dependencies.dispatch({ prepared, reservation });
        } else {
          await drain(await startWorker(prepared.request));
        }
        record = (await readHybridEvidenceJob(record.job.jobId, input.clients?.jobs))!;
        if (record.job.state !== "completed" || !record.candidate) throw new Error("validator_failed");
        const independentTextByPage = await readIndependentPdfText({
          ocr: input.dependencies?.ocr,
          projection,
        });
        const filerName = [
          recoveryInput.row.filer.prefix,
          recoveryInput.row.filer.firstName,
          recoveryInput.row.filer.lastName,
          recoveryInput.row.filer.suffix,
        ].filter((value): value is string => value !== null).join(" ");
        const validated = validateHouseDocumentRowCandidate({
          artifactDigest: projection.documentDigest,
          candidate: record.candidate,
          expected: {
            docId: recoveryInput.row.docId,
            filerName,
            filingDate: recoveryInput.row.filingDate,
            stateDistrict: recoveryInput.row.filer.stateDistrict,
          },
          independentTextByPage,
          projection,
        });
        const result = createAcceptedExtractionResult({
          citations: locators,
          definition,
          job: record,
          now: new Date(),
          payload: validated as unknown as Record<string, unknown>,
        });
        const accepted = await acceptHybridEvidenceJob({
          jobId: record.job.jobId,
          now: new Date(),
          result,
        }, input.clients?.jobs);
        await artifacts.setReference({
          active: true,
          artifactDigest: manifest.contentDigest,
          kind: "accepted_result",
          referenceId: result.resultId,
        });
        await artifacts.setReference({
          active: true,
          artifactDigest: manifest.contentDigest,
          kind: "current_lineage",
          referenceId: result.resultId,
        });
        await advanceHybridSourceResultLineage({
          lineageKey: `${recoveryInput.source.sourceInstanceId}:${recoveryInput.row.year}:${recoveryInput.row.docId}:${definition.definitionId}`,
          now: new Date(),
          resultId: result.resultId,
          sourceDigest: recoveryInput.row.rowDigest,
          sourceRevision: `cursor:${recoveryInput.source.cursor.revision}:row:${recoveryInput.row.rowDigest}`,
        }, input.clients?.lineage);
        await reconcileHybridEvidenceAttempt({
          actualInputTokens: accepted.acceptedResult?.usage.inputTokens,
          actualOutputTokens: accepted.acceptedResult?.usage.outputTokens,
          actualPaidCost: accepted.acceptedResult?.usage.paidCostUsd,
          outcome: "reconciled",
          reservation,
        }, { global: input.clients?.globalBudget, workspace: input.clients?.workspaceBudget });
        return Object.freeze({
          document: validated.document,
          resultId: result.resultId,
          rows: validated.rows,
        });
      } catch (error) {
        const latest = await readHybridEvidenceJob(record.job.jobId, input.clients?.jobs);
        if (latest?.job.state === "completed") {
          await quarantineHybridEvidenceJob({
            codes: [validationCode(error)],
            jobId: latest.job.jobId,
            now: new Date(),
          }, input.clients?.jobs);
          await artifacts.setRetention({
            artifactDigest: manifest.contentDigest,
            now: new Date(),
            state: "quarantined",
          });
          await reconcileHybridEvidenceAttempt({ outcome: "reconciled", reservation }, {
            global: input.clients?.globalBudget,
            workspace: input.clients?.workspaceBudget,
          });
        } else {
          if (latest && (latest.job.state === "prepared" || latest.job.state === "running")) {
            await markHybridEvidenceJobUncertain({ jobId: latest.job.jobId, now: new Date() }, input.clients?.jobs);
          }
          await reconcileHybridEvidenceAttempt({ outcome: "uncertain", reservation }, {
            global: input.clients?.globalBudget,
            workspace: input.clients?.workspaceBudget,
          });
        }
        return null;
      }
    },
  });
}
