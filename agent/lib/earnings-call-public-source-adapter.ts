import { createHash } from "node:crypto";

import { z } from "zod";

import {
  commitPublicSourceAcquisition,
  derivePublicSourceAcquisitionEligibilityId,
  ensurePublicSourceInstance,
  readCommittedPublicSourceAcquisitionForWindow,
  readLatestPublicSourceFactRevision,
  readPublicSourceAcquisitionJournal,
  readReusablePublicSourceAcquisition,
  recordPublicSourceAcquisitionOutcome,
  reservePublicSourceFairAccess,
  PublicSourceAcquisitionStoreError,
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
  publicSourceCorrectionSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceAcquisitionJournal,
  type PublicSourceCorrection,
  type PublicSourceInstance,
} from "./public-source-adapter-schema";
import {
  type ReviewedParameterizedSourceFamily,
} from "./earnings-call-public-source-contract";
import { resolveReviewedPublicSource } from "./public-source-registry";

const SEC_MAXIMUM_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const SEC_MINIMUM_REQUEST_INTERVAL_MILLISECONDS = 125;
const SEC_USER_AGENT_SCHEMA = z.string().trim().min(8).max(300).refine(
  (value) => /@|https?:\/\//u.test(value),
  "sec_user_agent_invalid",
);

export interface EarningsCallPublicSourceRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly kind: "issuer_discovery" | "sec_submissions" | "transcript_artifact";
  readonly maximumBytes: number;
  readonly url: string;
}

export interface EarningsCallPublicSourceResponse {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly redirectCount: number;
  readonly requestedUrl: string;
  readonly status: number;
  readonly truncated?: boolean;
}

export interface EarningsCallPublicSourceAcquisition extends PublicSourcePreparedAcquisition {
  readonly transientArtifacts: readonly EarningsCallTransientArtifact[];
  readonly baselineEstablished: boolean;
}

export interface EarningsCallTransientArtifact {
  readonly artifactBytes: Uint8Array;
  readonly artifactDigest: string;
  readonly artifactMediaType: "application/pdf" | "text/html";
  readonly artifactUrl: string;
  readonly factRevisionId: string;
  readonly fact: CanonicalPublicFactRevision;
}

export interface SharedEarningsCallPublicSourceAcquisitionResult {
  readonly acquisition: EarningsCallPublicSourceAcquisition["result"];
  readonly baselineEstablished: boolean;
  readonly commit: PublicSourceAcquisitionCommit | null;
  readonly journal: PublicSourceAcquisitionJournal | null;
  readonly reused: boolean;
  readonly transientArtifacts: readonly EarningsCallTransientArtifact[];
}

class EarningsCallAcquisitionError extends Error {
  readonly code:
    | "parser_incomplete"
    | "transcript_artifact_invalid"
    | "transcript_coverage_unavailable"
    | "transport_origin_forbidden"
    | "transport_redirect_forbidden"
    | "transport_response_oversized";

  constructor(code: EarningsCallAcquisitionError["code"]) {
    super(code);
    this.code = code;
    this.name = "EarningsCallAcquisitionError";
  }
}

const sharedAcquisitions = new Map<
  string,
  Promise<Omit<SharedEarningsCallPublicSourceAcquisitionResult, "reused">>
>();

function exactReviewedUrl(
  value: string,
  endpoint: ReviewedParameterizedSourceFamily["artifact"] |
    ReviewedParameterizedSourceFamily["discovery"],
): boolean {
  try {
    const url = new URL(value);
    return url.origin === endpoint.origin &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.toString() === value &&
      new RegExp(endpoint.pathPattern, "u").test(url.pathname);
  } catch {
    return false;
  }
}

function validateResponse(input: {
  readonly endpoint?: ReviewedParameterizedSourceFamily["artifact"] |
    ReviewedParameterizedSourceFamily["discovery"];
  readonly expectedUrl: string;
  readonly maximumBytes: number;
  readonly maximumRedirects: number;
  readonly response: EarningsCallPublicSourceResponse;
}): void {
  const response = input.response;
  if (response.requestedUrl !== input.expectedUrl || response.status !== 200) {
    throw new EarningsCallAcquisitionError("transcript_coverage_unavailable");
  }
  if (response.redirectCount < 0 || response.redirectCount > input.maximumRedirects) {
    throw new EarningsCallAcquisitionError("transport_redirect_forbidden");
  }
  if (
    response.truncated === true ||
    response.body.byteLength === 0 ||
    response.body.byteLength > input.maximumBytes
  ) throw new EarningsCallAcquisitionError("transport_response_oversized");
  if (input.endpoint) {
    if (!exactReviewedUrl(response.finalUrl, input.endpoint)) {
      throw new EarningsCallAcquisitionError("transport_origin_forbidden");
    }
  } else if (response.finalUrl !== input.expectedUrl || response.redirectCount !== 0) {
    throw new EarningsCallAcquisitionError("transport_redirect_forbidden");
  }
}

function mediaType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLowerCase();
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(body: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new EarningsCallAcquisitionError("transcript_artifact_invalid");
  }
}

function validateArtifact(
  family: ReviewedParameterizedSourceFamily,
  response: EarningsCallPublicSourceResponse,
): void {
  if (mediaType(response.contentType) !== family.artifact.mediaType) {
    throw new EarningsCallAcquisitionError("transcript_artifact_invalid");
  }
  if (family.artifact.mediaType === "application/pdf") {
    if (new TextDecoder().decode(response.body.slice(0, 5)) !== "%PDF-") {
      throw new EarningsCallAcquisitionError("transcript_artifact_invalid");
    }
    return;
  }
  const text = decodeUtf8(response.body).trimStart().toLowerCase();
  if (!text.startsWith("<!doctype html") && !text.startsWith("<html")) {
    throw new EarningsCallAcquisitionError("transcript_artifact_invalid");
  }
}

const secSubmissionsSchema = z.object({
  cik: z.union([z.string(), z.number()]),
  filings: z.object({
    recent: z.object({
      accessionNumber: z.array(z.string()),
      acceptanceDateTime: z.array(z.string()),
      filingDate: z.array(z.string()),
      form: z.array(z.string()),
      primaryDocument: z.array(z.string()),
      reportDate: z.array(z.string()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

type SecContext = {
  readonly acceptanceDateTime: string;
  readonly accessionNumber: string;
  readonly filingUrl: string;
};

function secTimestamp(value: string): string | null {
  if (!/^\d{14}$/u.test(value)) return null;
  const timestamp = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
}

function secContexts(
  body: Uint8Array,
  cik: string,
  events: ReviewedParameterizedSourceFamily["events"],
): ReadonlyMap<string, SecContext> {
  let parsed: z.infer<typeof secSubmissionsSchema>;
  try {
    parsed = secSubmissionsSchema.parse(JSON.parse(decodeUtf8(body)));
  } catch {
    throw new EarningsCallAcquisitionError("parser_incomplete");
  }
  if (String(parsed.cik).padStart(10, "0") !== cik) {
    throw new EarningsCallAcquisitionError("parser_incomplete");
  }
  const recent = parsed.filings.recent;
  const length = recent.accessionNumber.length;
  if ([recent.acceptanceDateTime, recent.filingDate, recent.form, recent.primaryDocument, recent.reportDate]
    .some((values) => values.length !== length)) {
    throw new EarningsCallAcquisitionError("parser_incomplete");
  }
  const contexts = new Map<string, SecContext>();
  for (const event of events) {
    let best: { context: SecContext; distance: number } | null = null;
    for (let index = 0; index < length; index += 1) {
      if (recent.form[index] !== "8-K" && recent.form[index] !== "6-K") continue;
      const filingDate = recent.filingDate[index]!;
      const reportDate = recent.reportDate[index]!;
      const eventTime = Date.parse(`${event.callDate}T00:00:00Z`);
      const evidenceTime = Date.parse(`${reportDate || filingDate}T00:00:00Z`);
      const distance = Math.abs(evidenceTime - eventTime) / 86_400_000;
      if (!Number.isFinite(distance) || distance > 14 || (best && best.distance <= distance)) continue;
      const accessionNumber = recent.accessionNumber[index]!;
      const acceptanceDateTime = secTimestamp(recent.acceptanceDateTime[index]!);
      const primaryDocument = recent.primaryDocument[index]!;
      if (
        !/^\d{10}-\d{2}-\d{6}$/u.test(accessionNumber) ||
        !acceptanceDateTime ||
        !/^[A-Za-z0-9_.-]{1,200}$/u.test(primaryDocument)
      ) continue;
      best = {
        context: {
          acceptanceDateTime,
          accessionNumber,
          filingUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionNumber.replaceAll("-", "")}/${primaryDocument}`,
        },
        distance,
      };
    }
    if (best) contexts.set(event.fiscalPeriod, best.context);
  }
  return contexts;
}

function canonicalFact(input: {
  readonly artifact: EarningsCallPublicSourceResponse;
  readonly event: ReviewedParameterizedSourceFamily["events"][number];
  readonly family: ReviewedParameterizedSourceFamily;
  readonly secContext: SecContext | null;
  readonly source: PublicSourceInstance;
}): CanonicalPublicFactRevision {
  const payload = {
    artifactByteCount: input.artifact.body.byteLength,
    artifactDigest: digestBytes(input.artifact.body),
    artifactMediaType: input.family.artifact.mediaType,
    artifactUrl: input.artifact.finalUrl,
    callDate: input.event.callDate,
    cik: input.family.cik,
    discoveryUrl: input.event.discoveryUrl,
    fiscalPeriod: input.event.fiscalPeriod,
    schemaVersion: "earnings-call-event/v1" as const,
    secContext: input.secContext,
  };
  const payloadDigest = digestPublicSourceValue(payload);
  const base = {
    adapterId: "earnings-call-transcripts" as const,
    createdObservedAt: input.artifact.observedAt,
    extraction: { errorCode: null, state: "complete" as const },
    factSchemaVersion: "earnings-call-event/v1" as const,
    payload,
    payloadDigest,
    provenance: {
      authority: "Issuer IR" as const,
      documentDigest: payload.artifactDigest,
      publicUrl: payload.artifactUrl,
      rowEvidenceDigest: input.family.familyDigest,
    },
    recordType: "canonical_public_fact_revision" as const,
    schemaVersion: 1 as const,
    sourceInstanceId: input.source.sourceInstanceId,
    sourceNativeId: `${input.family.cik}:${input.event.fiscalPeriod}:${input.event.callDate}`,
    sourceTimes: { publishedAt: `${input.event.callDate}T00:00:00.000Z`, updatedAt: null },
    stableRowIdentity: "earnings-call-event",
  };
  const logicalKey = deriveCanonicalPublicFactLogicalKey(base);
  return canonicalPublicFactRevisionSchema.parse({
    ...base,
    logicalKey,
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest }),
  });
}

function correction(
  from: CanonicalPublicFactRevision,
  to: CanonicalPublicFactRevision,
): PublicSourceCorrection {
  const reason = "source_correction" as const;
  return publicSourceCorrectionSchema.parse({
    correctionId: `correction.${digestPublicSourceValue([
      to.logicalKey,
      from.revisionId,
      to.revisionId,
      reason,
    ])}`,
    createdObservedAt: to.createdObservedAt,
    fromRevisionId: from.revisionId,
    logicalKey: to.logicalKey,
    reason,
    recordType: "public_source_fact_correction",
    schemaVersion: 1,
    toRevisionId: to.revisionId,
  });
}

function acquisitionId(input: {
  readonly contentDigest: string;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): string {
  return `acquisition.${digestPublicSourceValue([
    input.source.sourceInstanceId,
    input.source.adapterDefinitionDigest,
    input.source.cursor.revision,
    input.window.startAt,
    input.window.endAt,
    input.contentDigest,
  ])}`;
}

function failure(input: {
  readonly code: EarningsCallAcquisitionError["code"] | "acquisition_uncertain" | "transport_timeout";
  readonly observedAt: string;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): EarningsCallPublicSourceAcquisition {
  const digest = digestPublicSourceValue([input.source.sourceInstanceId, input.window, input.code]);
  const retryable = input.code === "transport_timeout";
  return Object.freeze({
    baselineEstablished: false,
    corrections: Object.freeze([]),
    facts: Object.freeze([]),
    retractions: Object.freeze([]),
    transientArtifacts: Object.freeze([]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: acquisitionId({ contentDigest: digest, source: input.source, window: input.window }),
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      adapterId: input.source.adapterId,
      adapterVersion: input.source.adapterVersion,
      baselineEstablished: false,
      candidateFactRevisionIds: [],
      correctionIds: [],
      retractionIds: [],
      coverage: "partial",
      errorCode: input.code,
      observedAt: input.observedAt,
      proposedNextCursor: null,
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: retryable ? 60 : null,
      schemaVersion: 1,
      sourceInstanceId: input.source.sourceInstanceId,
      stageReceipts: [{
        errorCode: input.code,
        inputDigest: digest,
        outputDigest: null,
        stage: "transport",
        status: "failed",
      }],
      status: retryable ? "retryable_failure" : input.code === "acquisition_uncertain" ? "uncertain" : "terminal_failure",
    }),
    window: input.window,
  });
}

async function acquire(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchResponse: (request: EarningsCallPublicSourceRequest) => Promise<EarningsCallPublicSourceResponse>;
  readonly family: ReviewedParameterizedSourceFamily;
  readonly source: PublicSourceInstance;
  readonly userAgent: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<EarningsCallPublicSourceAcquisition> {
  const secUrl = `https://data.sec.gov/submissions/CIK${input.family.cik}.json`;
  await reservePublicSourceFairAccess({
    authorityOrigin: "https://data.sec.gov",
    minimumIntervalMilliseconds: SEC_MINIMUM_REQUEST_INTERVAL_MILLISECONDS,
  }, input.client);
  const sec = await input.fetchResponse({
    headers: Object.freeze({
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "User-Agent": input.userAgent,
    }),
    kind: "sec_submissions",
    maximumBytes: SEC_MAXIMUM_RESPONSE_BYTES,
    url: secUrl,
  });
  validateResponse({
    expectedUrl: secUrl,
    maximumBytes: SEC_MAXIMUM_RESPONSE_BYTES,
    maximumRedirects: 0,
    response: sec,
  });
  if (mediaType(sec.contentType) !== "application/json") {
    throw new EarningsCallAcquisitionError("parser_incomplete");
  }
  const contexts = secContexts(sec.body, input.family.cik, input.family.events);
  const facts: CanonicalPublicFactRevision[] = [];
  const transientArtifacts: EarningsCallTransientArtifact[] = [];
  const artifactDigests: string[] = [];
  const observedTimes = [sec.observedAt];
  for (const event of input.family.events) {
    let discovery: EarningsCallPublicSourceResponse | null = null;
    if (event.discoveryUrl !== event.artifactUrl) {
      discovery = await input.fetchResponse({
        headers: Object.freeze({ Accept: "text/html", "User-Agent": input.userAgent }),
        kind: "issuer_discovery",
        maximumBytes: input.family.maximumDiscoveryBytes,
        url: event.discoveryUrl,
      });
      validateResponse({
        endpoint: input.family.discovery,
        expectedUrl: event.discoveryUrl,
        maximumBytes: input.family.maximumDiscoveryBytes,
        maximumRedirects: input.family.maximumRedirects,
        response: discovery,
      });
      observedTimes.push(discovery.observedAt);
      if (
        event.discoveryEvidence === "direct_link" &&
        !decodeUtf8(discovery.body).includes(event.artifactUrl)
      ) throw new EarningsCallAcquisitionError("transcript_coverage_unavailable");
    }
    const artifact = await input.fetchResponse({
      headers: Object.freeze({ Accept: input.family.artifact.mediaType, "User-Agent": input.userAgent }),
      kind: "transcript_artifact",
      maximumBytes: input.family.maximumArtifactBytes,
      url: event.artifactUrl,
    });
    validateResponse({
      endpoint: input.family.artifact,
      expectedUrl: event.artifactUrl,
      maximumBytes: input.family.maximumArtifactBytes,
      maximumRedirects: input.family.maximumRedirects,
      response: artifact,
    });
    validateArtifact(input.family, artifact);
    observedTimes.push(artifact.observedAt);
    const fact = canonicalFact({
      artifact,
      event,
      family: input.family,
      secContext: contexts.get(event.fiscalPeriod) ?? null,
      source: input.source,
    });
    facts.push(fact);
    transientArtifacts.push(Object.freeze({
      artifactBytes: artifact.body,
      artifactDigest: fact.payload.schemaVersion === "earnings-call-event/v1"
        ? fact.payload.artifactDigest
        : "",
      artifactMediaType: input.family.artifact.mediaType,
      artifactUrl: artifact.finalUrl,
      factRevisionId: fact.revisionId,
      fact,
    }));
    artifactDigests.push(fact.payload.schemaVersion === "earnings-call-event/v1"
      ? fact.payload.artifactDigest
      : "");
  }
  const corrections: PublicSourceCorrection[] = [];
  const candidateFacts: CanonicalPublicFactRevision[] = [];
  for (const fact of facts) {
    const prior = await readLatestPublicSourceFactRevision(fact.logicalKey, input.client);
    if (!prior) {
      candidateFacts.push(fact);
    } else if (prior.revisionId !== fact.revisionId) {
      candidateFacts.push(fact);
      corrections.push(correction(prior, fact));
    }
  }
  const contentDigest = digestPublicSourceValue([
    digestBytes(sec.body),
    ...artifactDigests,
  ]);
  const baselineEstablished = input.source.cursor.revision === 0;
  return Object.freeze({
    baselineEstablished,
    corrections: Object.freeze(corrections),
    facts: Object.freeze(candidateFacts),
    retractions: Object.freeze([]),
    transientArtifacts: Object.freeze(transientArtifacts),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: acquisitionId({ contentDigest, source: input.source, window: input.window }),
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      adapterId: input.source.adapterId,
      adapterVersion: input.source.adapterVersion,
      baselineEstablished,
      candidateFactRevisionIds: candidateFacts.map(({ revisionId }) => revisionId),
      correctionIds: corrections.map(({ correctionId }) => correctionId),
      retractionIds: [],
      coverage: "complete",
      errorCode: null,
      observedAt: observedTimes.sort().at(-1)!,
      proposedNextCursor: {
        contentDigest,
        expectedRevision: input.source.cursor.revision,
        watermark: [...input.family.events].sort((left, right) => right.callDate.localeCompare(left.callDate))[0]!.callDate,
      },
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: null,
      schemaVersion: 1,
      sourceInstanceId: input.source.sourceInstanceId,
      stageReceipts: [
        {
          errorCode: null,
          inputDigest: digestPublicSourceValue(secUrl),
          outputDigest: digestBytes(sec.body),
          stage: "transport",
          status: "complete",
        },
        {
          errorCode: null,
          inputDigest: input.family.familyDigest,
          outputDigest: digestPublicSourceValue(candidateFacts.map(({ revisionId }) => revisionId)),
          stage: "normalize",
          status: "complete",
        },
      ],
      status: candidateFacts.length === 0 ? "no_change" : "complete",
    }),
    window: input.window,
  });
}

async function readCursorConflictWinner(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly source: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const winner = await readCommittedPublicSourceAcquisitionForWindow({
      accessClassification: "public",
      adapterDefinitionDigest: input.source.adapterDefinitionDigest,
      sourceInstanceId: input.source.sourceInstanceId,
      window: input.window,
    }, input.client);
    if (winner) return winner;
  }
  return null;
}

export async function runSharedEarningsCallPublicSourceAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly fetchResponse: (request: EarningsCallPublicSourceRequest) => Promise<EarningsCallPublicSourceResponse>;
  readonly sourceId: string;
  readonly userAgent: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<SharedEarningsCallPublicSourceAcquisitionResult> {
  const userAgent = SEC_USER_AGENT_SCHEMA.parse(input.userAgent);
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  if (!reviewed.sourceFamily || reviewed.sourceInstance.configuration.kind !== "earnings_call_issuer") {
    throw new EarningsCallAcquisitionError("transcript_coverage_unavailable");
  }
  const family = reviewed.sourceFamily;
  const windowIdentity = {
    accessClassification: "public" as const,
    adapterDefinitionDigest: reviewed.sourceInstance.adapterDefinitionDigest,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    window: input.window,
  };
  const committedForWindow = await readCommittedPublicSourceAcquisitionForWindow(windowIdentity, input.client);
  if (committedForWindow) return Object.freeze({
    acquisition: committedForWindow.result,
    baselineEstablished: committedForWindow.result.baselineEstablished,
    commit: null,
    journal: committedForWindow.journal,
    reused: true,
    transientArtifacts: Object.freeze([]),
  });
  const source = await ensurePublicSourceInstance(reviewed.sourceInstance, input.client);
  const eligibility = {
    ...windowIdentity,
    expectedCursorRevision: source.cursor.revision,
  };
  const reusable = await readReusablePublicSourceAcquisition(eligibility, input.client);
  if (reusable) return Object.freeze({
    acquisition: reusable.result,
    baselineEstablished: reusable.result.baselineEstablished,
    commit: null,
    journal: reusable.journal,
    reused: true,
    transientArtifacts: Object.freeze([]),
  });
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  const active = sharedAcquisitions.get(eligibilityId);
  if (active) return Object.freeze({ ...(await active), reused: true });
  const started = (async (): Promise<Omit<SharedEarningsCallPublicSourceAcquisitionResult, "reused">> => {
    const raced = await readReusablePublicSourceAcquisition(eligibility, input.client);
    if (raced) return Object.freeze({
      acquisition: raced.result,
      baselineEstablished: raced.result.baselineEstablished,
      commit: null,
      journal: raced.journal,
      transientArtifacts: Object.freeze([]),
    });
    let prepared: EarningsCallPublicSourceAcquisition;
    try {
      prepared = await acquire({
        client: input.client,
        family,
        fetchResponse: input.fetchResponse,
        source,
        userAgent,
        window: input.window,
      });
    } catch (error) {
      const timeout = error instanceof Error &&
        (error.name === "AbortError" || /timed?\s*out|timeout/iu.test(error.message));
      const code = timeout
        ? "transport_timeout" as const
        : error instanceof EarningsCallAcquisitionError
          ? error.code
          : "acquisition_uncertain" as const;
      prepared = failure({ code, observedAt: input.window.endAt, source, window: input.window });
      await recordPublicSourceAcquisitionOutcome(prepared.result, input.client);
      return Object.freeze({
        acquisition: prepared.result,
        baselineEstablished: false,
        commit: null,
        journal: null,
        transientArtifacts: Object.freeze([]),
      });
    }
    try {
      const commit = await commitPublicSourceAcquisition({ acquisition: prepared, client: input.client });
      return Object.freeze({
        acquisition: prepared.result,
        baselineEstablished: prepared.baselineEstablished,
        commit,
        journal: commit.journal,
        transientArtifacts: prepared.transientArtifacts,
      });
    } catch (error) {
      if (
        !(error instanceof PublicSourceAcquisitionStoreError) ||
        (error.code !== "source_cursor_conflict" && error.code !== "journal_conflict")
      ) throw error;
      const winner = await readCursorConflictWinner({ client: input.client, source, window: input.window });
      if (!winner) throw error;
      return Object.freeze({
        acquisition: winner.result,
        baselineEstablished: winner.result.baselineEstablished,
        commit: null,
        journal: winner.journal,
        transientArtifacts: Object.freeze([]),
      });
    }
  })();
  sharedAcquisitions.set(eligibilityId, started);
  try {
    return Object.freeze({ ...(await started), reused: false });
  } finally {
    if (sharedAcquisitions.get(eligibilityId) === started) sharedAcquisitions.delete(eligibilityId);
  }
}
