import {
  commitPublicSourceAcquisition,
  derivePublicSourceAcquisitionEligibilityId,
  ensurePublicSourceInstance,
  readCommittedPublicSourceAcquisitionForWindow,
  readPublicSourceAcquisitionJournal,
  readReusablePublicSourceAcquisition,
  recordPublicSourceAcquisitionOutcome,
  type PublicSourceAcquisitionCommit,
  type PublicSourceAcquisitionStoreClient,
  type PublicSourcePreparedAcquisition,
} from "./public-source-acquisition-store";
import {
  canonicalPublicFactRevisionSchema,
  deriveCanonicalPublicFactLogicalKey,
  deriveCanonicalPublicFactRevisionId,
  digestPublicSourceValue,
  publicSourceAcquisitionResultSchema,
  publicSourceInstanceSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceAcquisitionJournal,
  type PublicSourceInstance,
} from "./public-source-adapter-schema";
import { resolveReviewedPublicSource } from "./public-source-registry";
import {
  evaluateSecIpoPage,
  normalizeSecIpoFetch,
  SecIpoEvaluationError,
  type SecIpoCheckpoint,
} from "./sec-ipo-evaluation";
import {
  SecIpoNormalizerError,
  type SecIpoAtomPage,
  type SecIpoFiling,
} from "./sec-ipo-reference";

export interface SecPublicSourceResponse {
  readonly body: string;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly requestedUrl: string;
  readonly status: number;
  readonly truncated?: boolean;
}

export interface SecPublicSourceAcquisition extends PublicSourcePreparedAcquisition {
  readonly baselineEstablished: boolean;
}

export interface SharedSecPublicSourceAcquisitionResult {
  readonly acquisition: SecPublicSourceAcquisition["result"];
  readonly baselineEstablished: boolean;
  readonly journal: PublicSourceAcquisitionJournal | null;
  readonly reused: boolean;
}

const sharedAcquisitions = new Map<
  string,
  Promise<Omit<SharedSecPublicSourceAcquisitionResult, "reused">>
>();

function acquisitionId(input: {
  bodyDigest: string;
  sourceInstance: PublicSourceInstance;
  window: { endAt: string; startAt: string };
}): string {
  return `acquisition.${digestPublicSourceValue([
    input.sourceInstance.sourceInstanceId,
    input.sourceInstance.adapterDefinitionDigest,
    input.sourceInstance.cursor.revision,
    input.window.startAt,
    input.window.endAt,
    input.bodyDigest,
  ])}`;
}

function checkpoint(sourceInstance: PublicSourceInstance): SecIpoCheckpoint | null {
  if (sourceInstance.cursor.revision === 0) return null;
  if (
    sourceInstance.cursor.contentDigest === null ||
    sourceInstance.cursor.watermark === null
  ) {
    throw new SecIpoEvaluationError("sec_atom_fetch_incomplete");
  }
  return {
    contentDigest: sourceInstance.cursor.contentDigest,
    watermark: sourceInstance.cursor.watermark,
  };
}

function amendmentAccessions(page: SecIpoAtomPage): ReadonlyMap<string, string> {
  return new Map(page.filings
    .filter((filing) => filing.formType === "S-1")
    .map((filing) => [filing.registrationKey, filing.accessionNumber]));
}

function canonicalFact(input: {
  amendmentOfAccessionNumber: string | null;
  filing: SecIpoFiling;
  sourceInstance: PublicSourceInstance;
}): CanonicalPublicFactRevision {
  const payload = {
    accessionNumber: input.filing.accessionNumber,
    amendmentOfAccessionNumber: input.amendmentOfAccessionNumber,
    cik: input.filing.cik,
    companyName: input.filing.companyName,
    fileNumber: input.filing.fileNumber,
    filingUrl: input.filing.canonicalFilingUrl,
    formType: input.filing.formType,
    publishedAt: input.filing.publishedAt,
    schemaVersion: "sec-filing/v1" as const,
    updatedAt: input.filing.updatedAt,
  };
  const payloadDigest = digestPublicSourceValue(payload);
  const base = {
    adapterId: "sec-latest-filings" as const,
    createdObservedAt: input.filing.observedAt,
    extraction: { errorCode: null, state: "complete" as const },
    factSchemaVersion: "sec-filing/v1" as const,
    payload,
    payloadDigest,
    provenance: {
      authority: "SEC" as const,
      documentDigest: null,
      publicUrl: input.filing.canonicalFilingUrl,
      rowEvidenceDigest: input.filing.contentHash,
    },
    recordType: "canonical_public_fact_revision" as const,
    schemaVersion: 1 as const,
    sourceInstanceId: input.sourceInstance.sourceInstanceId,
    sourceNativeId: `${input.filing.accessionNumber}:${input.filing.formType}`,
    sourceTimes: {
      publishedAt: input.filing.publishedAt,
      updatedAt: input.filing.updatedAt,
    },
    stableRowIdentity: "filing",
  };
  const logicalKey = deriveCanonicalPublicFactLogicalKey(base);
  return canonicalPublicFactRevisionSchema.parse({
    ...base,
    logicalKey,
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest }),
  });
}

function errorResult(input: {
  acquisitionId: string;
  bodyDigest: string;
  errorCode:
    | "acquisition_uncertain"
    | "parser_incomplete"
    | "transport_redirect_forbidden"
    | "transport_response_oversized"
    | "xml_invalid";
  observedAt: string;
  sourceInstance: PublicSourceInstance;
  status: "partial" | "terminal_failure" | "uncertain";
  window: { endAt: string; startAt: string };
}): SecPublicSourceAcquisition {
  return Object.freeze({
    baselineEstablished: false,
    corrections: Object.freeze([]),
    facts: Object.freeze([]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: input.acquisitionId,
      adapterDefinitionDigest: input.sourceInstance.adapterDefinitionDigest,
      adapterId: input.sourceInstance.adapterId,
      adapterVersion: input.sourceInstance.adapterVersion,
      candidateFactRevisionIds: [],
      correctionIds: [],
      coverage: "partial",
      errorCode: input.errorCode,
      observedAt: input.observedAt,
      proposedNextCursor: null,
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: null,
      schemaVersion: 1,
      sourceInstanceId: input.sourceInstance.sourceInstanceId,
      stageReceipts: [
        {
          errorCode: null,
          inputDigest: input.bodyDigest,
          outputDigest: input.bodyDigest,
          stage: "transport",
          status: "complete",
        },
        {
          errorCode: input.errorCode,
          inputDigest: input.bodyDigest,
          outputDigest: null,
          stage: "normalize",
          status: "failed",
        },
      ],
      status: input.status,
    }),
    window: input.window,
  });
}

function mappedFailure(error: unknown): {
  errorCode: Parameters<typeof errorResult>[0]["errorCode"];
  status: Parameters<typeof errorResult>[0]["status"];
} | null {
  if (error instanceof SecIpoNormalizerError) {
    if (error.code === "sec_atom_incomplete") {
      return { errorCode: "parser_incomplete", status: "partial" };
    }
    if (error.code === "sec_atom_oversized") {
      return { errorCode: "transport_response_oversized", status: "terminal_failure" };
    }
    return { errorCode: "xml_invalid", status: "terminal_failure" };
  }
  if (error instanceof SecIpoEvaluationError) {
    if (error.code === "sec_atom_redirected") {
      return { errorCode: "transport_redirect_forbidden", status: "terminal_failure" };
    }
    if (error.code === "sec_atom_fetch_incomplete") {
      return { errorCode: "parser_incomplete", status: "partial" };
    }
    return { errorCode: "acquisition_uncertain", status: "uncertain" };
  }
  return null;
}

export function acquireSecPublicSource(input: {
  readonly response: SecPublicSourceResponse;
  readonly sourceInstance: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): SecPublicSourceAcquisition {
  const sourceInstance = publicSourceInstanceSchema.parse(input.sourceInstance);
  const bodyDigest = digestPublicSourceValue(input.response.body);
  const id = acquisitionId({ bodyDigest, sourceInstance, window: input.window });
  try {
    const page = normalizeSecIpoFetch(input.response);
    const evaluation = evaluateSecIpoPage(
      page,
      checkpoint(sourceInstance),
      { ownerId: "public_source", workspaceId: "00000000-0000-4000-8000-000000000000" },
    );
    const selectedFilings = evaluation.baselineEstablished
      ? page.filings
      : evaluation.findings.map((finding) => finding.filing);
    const registrations = amendmentAccessions(page);
    if (selectedFilings.some((filing) =>
      filing.formType === "S-1/A" && !registrations.has(filing.registrationKey))) {
      return errorResult({
        acquisitionId: id,
        bodyDigest,
        errorCode: "parser_incomplete",
        observedAt: input.response.observedAt,
        sourceInstance,
        status: "partial",
        window: input.window,
      });
    }
    const facts = Object.freeze(selectedFilings.map((filing) => canonicalFact({
      amendmentOfAccessionNumber: filing.formType === "S-1/A"
        ? registrations.get(filing.registrationKey)!
        : null,
      filing,
      sourceInstance,
    })));
    const status = !evaluation.baselineEstablished && facts.length === 0
      ? "no_change" as const
      : "complete" as const;
    return Object.freeze({
      baselineEstablished: evaluation.baselineEstablished,
      corrections: Object.freeze([]),
      facts,
      result: publicSourceAcquisitionResultSchema.parse({
        acquisitionId: id,
        adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest,
        adapterId: sourceInstance.adapterId,
        adapterVersion: sourceInstance.adapterVersion,
        candidateFactRevisionIds: facts.map((fact) => fact.revisionId),
        correctionIds: [],
        coverage: "complete",
        errorCode: null,
        observedAt: input.response.observedAt,
        proposedNextCursor: {
          contentDigest: evaluation.checkpoint.contentDigest,
          expectedRevision: sourceInstance.cursor.revision,
          watermark: evaluation.checkpoint.watermark,
        },
        recordType: "public_source_acquisition_result",
        retryAfterSeconds: null,
        schemaVersion: 1,
        sourceInstanceId: sourceInstance.sourceInstanceId,
        stageReceipts: [
          {
            errorCode: null,
            inputDigest: bodyDigest,
            outputDigest: page.contentHash,
            stage: "transport",
            status: "complete",
          },
          {
            errorCode: null,
            inputDigest: page.contentHash,
            outputDigest: digestPublicSourceValue(facts.map((fact) => fact.revisionId)),
            stage: "normalize",
            status: "complete",
          },
        ],
        status,
      }),
      window: input.window,
    });
  } catch (error) {
    const failure = mappedFailure(error);
    if (failure === null) throw error;
    return errorResult({
      acquisitionId: id,
      bodyDigest,
      ...failure,
      observedAt: input.response.observedAt,
      sourceInstance,
      window: input.window,
    });
  }
}

export async function runSecPublicSourceAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly response: SecPublicSourceResponse;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<{
  readonly acquisition: SecPublicSourceAcquisition;
  readonly commit: PublicSourceAcquisitionCommit | null;
}> {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  const sourceInstance = await ensurePublicSourceInstance(
    reviewed.sourceInstance,
    input.client,
  );
  const acquisition = acquireSecPublicSource({
    response: input.response,
    sourceInstance,
    window: input.window,
  });
  if (
    acquisition.result.status !== "complete" &&
    acquisition.result.status !== "no_change"
  ) {
    await recordPublicSourceAcquisitionOutcome(acquisition.result, input.client);
    return Object.freeze({ acquisition, commit: null });
  }
  const commit = await commitPublicSourceAcquisition({
    acquisition,
    client: input.client,
  });
  return Object.freeze({ acquisition, commit });
}

export async function runSharedSecPublicSourceAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchResponse: () => Promise<SecPublicSourceResponse>;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<SharedSecPublicSourceAcquisitionResult> {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  const committedForWindow = await readCommittedPublicSourceAcquisitionForWindow({
    accessClassification: "public",
    adapterDefinitionDigest: reviewed.sourceInstance.adapterDefinitionDigest,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    window: input.window,
  }, input.client);
  if (committedForWindow) {
    return Object.freeze({
      acquisition: committedForWindow.result,
      baselineEstablished: committedForWindow.journal.expectedCursorRevision === 0,
      journal: committedForWindow.journal,
      reused: true,
    });
  }
  const sourceInstance = await ensurePublicSourceInstance(
    reviewed.sourceInstance,
    input.client,
  );
  const eligibility = {
    accessClassification: "public" as const,
    adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest,
    expectedCursorRevision: sourceInstance.cursor.revision,
    sourceInstanceId: sourceInstance.sourceInstanceId,
    window: input.window,
  };
  const reusable = await readReusablePublicSourceAcquisition(eligibility, input.client);
  if (reusable) {
    return Object.freeze({
      acquisition: reusable.result,
      baselineEstablished: reusable.journal.expectedCursorRevision === 0,
      journal: reusable.journal,
      reused: true,
    });
  }
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  const active = sharedAcquisitions.get(eligibilityId);
  if (active) {
    const joined = await active;
    return Object.freeze({ ...joined, reused: true });
  }
  const started = (async (): Promise<Omit<SharedSecPublicSourceAcquisitionResult, "reused">> => {
    const raced = await readReusablePublicSourceAcquisition(eligibility, input.client);
    if (raced) {
      return Object.freeze({
        acquisition: raced.result,
        baselineEstablished: raced.journal.expectedCursorRevision === 0,
        journal: raced.journal,
      });
    }
    const response = await input.fetchResponse();
    const completed = await runSecPublicSourceAcquisition({
      client: input.client,
      response,
      sourceId: input.sourceId,
      window: input.window,
    });
    const journal = completed.commit?.journal ?? await readPublicSourceAcquisitionJournal(
      completed.acquisition.result.acquisitionId,
      input.client,
    );
    return Object.freeze({
      acquisition: completed.acquisition.result,
      baselineEstablished: completed.acquisition.baselineEstablished,
      journal,
    });
  })();
  sharedAcquisitions.set(eligibilityId, started);
  try {
    const completed = await started;
    return Object.freeze({ ...completed, reused: false });
  } finally {
    if (sharedAcquisitions.get(eligibilityId) === started) {
      sharedAcquisitions.delete(eligibilityId);
    }
  }
}
