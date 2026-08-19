import { createHash } from "node:crypto";

import {
  commitPublicSourceAcquisition,
  ensurePublicSourceInstance,
  readCommittedPublicSourceAcquisitionForWindow,
  readLatestPublicSourceFactRevision,
  readReusablePublicSourceAcquisition,
  recordPublicSourceAcquisitionOutcome,
  type PublicSourceAcquisitionStoreClient,
} from "./public-source-acquisition-store";
import {
  canonicalPublicFactRevisionSchema,
  deriveCanonicalPublicFactLogicalKey,
  deriveCanonicalPublicFactRevisionId,
  digestPublicSourceValue,
  publicSourceAcquisitionResultSchema,
  publicSourceCorrectionSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceCorrection,
} from "./public-source-adapter-schema";
import {
  PUBLIC_COMMENTARY_LIMITS,
  digestPublicCommentaryValue,
  publicStatementSchema,
} from "./public-commentary-schema";
import { resolveReviewedPublicSource } from "./public-source-registry";
import {
  createRevocableEvidence,
  readRevocableEvidenceEnvelope,
  replaceRevocableEvidence,
  type RevocableEvidenceStoreClient,
} from "./revocable-evidence-store";
import { PUBLIC_COMMENTARY_TRACKER_SOURCE_URL } from "./strategy-pack-reference-catalog";

const FEED_URL = PUBLIC_COMMENTARY_TRACKER_SOURCE_URL;
const MAXIMUM_FEED_BYTES = 2 * 1_024 * 1_024;

export interface OfficialWebStatementResponse {
  readonly body: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly requestedUrl: string;
  readonly status: number;
}

export function createOfficialWebStatementFetch(options: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMilliseconds?: number;
} = {}) {
  return async (): Promise<OfficialWebStatementResponse> => {
    const response = await (options.fetchImpl ?? fetch)(FEED_URL, {
      headers: { Accept: "application/rss+xml, application/xml;q=0.9" },
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 10_000),
    });
    if ((response.url || FEED_URL) !== FEED_URL) throw new Error("official_web_redirect_forbidden");
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_FEED_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("official_web_response_oversized");
    }
    if (!response.body) throw new Error("official_web_response_missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > MAXIMUM_FEED_BYTES) {
        await reader.cancel();
        throw new Error("official_web_response_oversized");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return Object.freeze({
      body,
      finalUrl: response.url || FEED_URL,
      observedAt: new Date().toISOString(),
      requestedUrl: FEED_URL,
      status: response.status,
    });
  };
}

function decodeXml(value: string): string {
  return value
    .replaceAll(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&#8217;", "’")
    .replaceAll("&#8211;", "–")
    .replaceAll("&#8230;", "…")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#039;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function tag(item: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "iu").exec(item);
  return match ? decodeXml(match[1]!) : null;
}

export function parseOfficialWebStatementFeed(body: string) {
  if (!/<rss\b/iu.test(body) || !/<channel>/iu.test(body) || !/<\/rss>\s*$/iu.test(body)) {
    throw new Error("official_web_feed_invalid");
  }
  const parsed: Array<Readonly<{ canonicalUrl: string; publishedAt: string; text: string; title: string }>> = [];
  for (const match of body.matchAll(/<item>([\s\S]*?)<\/item>/giu)) {
    if (parsed.length === 32) throw new Error("official_web_pagination_bounds_exceeded");
    const item = match[1]!;
    const canonicalUrl = tag(item, "link");
    const description = tag(item, "description");
    const published = tag(item, "pubDate");
    const title = tag(item, "title");
    if (!canonicalUrl || !description || !published || !title) continue;
    const publishedAt = new Date(published);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(canonicalUrl);
    } catch {
      continue;
    }
    if (
      !Number.isFinite(publishedAt.getTime()) || parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "www.whitehouse.gov" || parsedUrl.username !== "" ||
      parsedUrl.password !== ""
    ) continue;
    const text = description.slice(0, PUBLIC_COMMENTARY_LIMITS.maximumStatementCharacters);
    parsed.push(Object.freeze({ canonicalUrl, publishedAt: publishedAt.toISOString(), text, title }));
  }
  return Object.freeze(parsed);
}

async function canonicalFact(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly evidence: { client: RevocableEvidenceStoreClient; encryptionKey: Uint8Array; keyReference: string };
  readonly item: ReturnType<typeof parseOfficialWebStatementFeed>[number];
  readonly observedAt: string;
  readonly sourceInstanceId: string;
}): Promise<{ fact: CanonicalPublicFactRevision; correction: PublicSourceCorrection | null }> {
  const stableId = createHash("sha256").update(input.item.canonicalUrl).digest("hex");
  const contentDigest = digestPublicCommentaryValue(input.item.text);
  const logicalKey = deriveCanonicalPublicFactLogicalKey({
    adapterId: "official-web-statements",
    factSchemaVersion: "public-statement/v1",
    sourceInstanceId: input.sourceInstanceId,
    sourceNativeId: stableId,
    stableRowIdentity: "statement",
  });
  const envelopeId = `revocable-evidence.web.${stableId}`;
  const [previous, currentEnvelope] = await Promise.all([
    readLatestPublicSourceFactRevision(logicalKey, input.client),
    readRevocableEvidenceEnvelope(envelopeId, input.evidence.client),
  ]);
  const envelope = !currentEnvelope
    ? await createRevocableEvidence({
        client: input.evidence.client,
        encryptionKey: input.evidence.encryptionKey,
        keyReference: input.evidence.keyReference,
        lifecycle: "final",
        observedAt: input.observedAt,
        plaintext: input.item.text,
        provider: "web",
        providerObjectId: stableId,
      })
    : currentEnvelope.sourceDigest === contentDigest
      ? currentEnvelope
      : await replaceRevocableEvidence({
          client: input.evidence.client,
          encryptionKey: input.evidence.encryptionKey,
          envelopeId,
          observedAt: input.observedAt,
          plaintext: input.item.text,
          reasonCode: "provider_edit",
        });
  const publisherId = createHash("sha256").update("https://www.whitehouse.gov/").digest("hex");
  const previousRevisionIds = previous?.payload.schemaVersion === "public-statement/v1" &&
      previous.payload.statement.provider === "web"
    ? previous.payload.statement.document.revisionIds
    : [];
  const revisionIds = [...previousRevisionIds.filter((digest) => digest !== contentDigest), contentDigest].slice(-6);
  const statement = publicStatementSchema.parse({
    attribution: "direct",
    canonicalUrl: input.item.canonicalUrl,
    contentDigest,
    contentReference: { envelopeId: envelope.envelopeId, revision: envelope.revision },
    document: { publisher: { displayLabel: "The White House", stableId: publisherId }, revisionIds, stableId },
    entities: { cashtags: [], mentions: [], urls: [] },
    kind: "official_statement",
    lifecycle: envelope.currentLifecycle === "edited" ? "edited" : "final",
    observedAt: input.observedAt,
    provider: "web",
    publishedAt: input.item.publishedAt,
    recordType: "public_statement",
    references: { relatedStatementIds: [] },
    revision: envelope.revision,
    schemaVersion: 1,
    speaker: { displayLabel: "The White House", handle: null, stableId: publisherId },
    textLocators: [{ end: input.item.text.length, spanDigest: contentDigest, start: 0 }],
  });
  const payload = { schemaVersion: "public-statement/v1" as const, statement };
  const payloadDigest = digestPublicSourceValue(payload);
  const base = {
    adapterId: "official-web-statements" as const,
    createdObservedAt: input.observedAt,
    extraction: { errorCode: null, state: "complete" as const },
    factSchemaVersion: "public-statement/v1" as const,
    payload,
    payloadDigest,
    provenance: { authority: "The White House" as const, documentDigest: contentDigest, publicUrl: input.item.canonicalUrl, rowEvidenceDigest: contentDigest },
    recordType: "canonical_public_fact_revision" as const,
    schemaVersion: 1 as const,
    sourceInstanceId: input.sourceInstanceId,
    sourceNativeId: stableId,
    sourceTimes: { publishedAt: input.item.publishedAt, updatedAt: input.observedAt },
    stableRowIdentity: "statement",
  };
  const fact = canonicalPublicFactRevisionSchema.parse({ ...base, logicalKey, revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest }) });
  const correction = previous && previous.revisionId !== fact.revisionId
    ? publicSourceCorrectionSchema.parse({
        correctionId: `correction.${digestPublicSourceValue([logicalKey, previous.revisionId, fact.revisionId, "source_correction"])}`,
        createdObservedAt: input.observedAt,
        fromRevisionId: previous.revisionId,
        logicalKey,
        reason: "source_correction",
        recordType: "public_source_fact_correction",
        schemaVersion: 1,
        toRevisionId: fact.revisionId,
      })
    : null;
  return Object.freeze({ correction, fact });
}

export async function runSharedOfficialWebStatementAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly evidence: { client: RevocableEvidenceStoreClient; encryptionKey: Uint8Array; keyReference: string };
  readonly fetchResponse: () => Promise<OfficialWebStatementResponse>;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}) {
  const reviewed = resolveReviewedPublicSource(input.sourceId);
  const prior = await readCommittedPublicSourceAcquisitionForWindow({
    accessClassification: "public",
    adapterDefinitionDigest: reviewed.sourceInstance.adapterDefinitionDigest,
    sourceInstanceId: reviewed.sourceInstance.sourceInstanceId,
    window: input.window,
  }, input.client);
  if (prior) return Object.freeze({ acquisition: prior.result, baselineEstablished: prior.result.baselineEstablished, commit: null, journal: prior.journal, reused: true });
  const source = await ensurePublicSourceInstance(reviewed.sourceInstance, input.client);
  const reusable = await readReusablePublicSourceAcquisition({
    accessClassification: "public",
    adapterDefinitionDigest: source.adapterDefinitionDigest,
    expectedCursorRevision: source.cursor.revision,
    sourceInstanceId: source.sourceInstanceId,
    window: input.window,
  }, input.client);
  if (reusable) return Object.freeze({ acquisition: reusable.result, baselineEstablished: reusable.result.baselineEstablished, commit: null, journal: reusable.journal, reused: true });
  const response = await input.fetchResponse();
  const observedAt = response.observedAt;
  // The publisher feed is a bounded snapshot, not a cursor-addressable API.
  // Normalize the complete snapshot through endAt so a second workspace can
  // backfill independently and a same-timestamp correction is still observed.
  const items = response.status === 200 ? parseOfficialWebStatementFeed(response.body).filter(({ publishedAt }) =>
    publishedAt <= input.window.endAt) : [];
  if (response.status !== 200) {
    const result = publicSourceAcquisitionResultSchema.parse({
      acquisitionId: `acquisition.${digestPublicSourceValue([source.sourceInstanceId, input.window, response.status])}`,
      adapterDefinitionDigest: source.adapterDefinitionDigest, adapterId: source.adapterId, adapterVersion: source.adapterVersion,
      baselineEstablished: false, candidateFactRevisionIds: [], correctionIds: [], retractionIds: [], coverage: "partial",
      errorCode: "acquisition_uncertain", observedAt, proposedNextCursor: null, recordType: "public_source_acquisition_result",
      retryAfterSeconds: null, schemaVersion: 1, sourceInstanceId: source.sourceInstanceId,
      stageReceipts: [{ errorCode: "acquisition_uncertain", inputDigest: digestPublicSourceValue(response.status), outputDigest: null, stage: "transport", status: "failed" }], status: "uncertain",
    });
    await recordPublicSourceAcquisitionOutcome(result, input.client);
    return Object.freeze({ acquisition: result, baselineEstablished: false, commit: null, journal: null, reused: false });
  }
  const normalized = await Promise.all(items.map((item) => canonicalFact({ client: input.client, evidence: input.evidence, item, observedAt, sourceInstanceId: source.sourceInstanceId })));
  const facts = normalized.map(({ fact }) => fact);
  const corrections = normalized.flatMap(({ correction }) => correction ? [correction] : []);
  const watermark = [source.cursor.watermark, input.window.endAt, ...items.map(({ publishedAt }) => publishedAt)]
    .filter((value): value is string => value !== null).sort().at(-1)!;
  const contentDigest = digestPublicSourceValue(facts.map(({ payloadDigest }) => payloadDigest));
  const acquisition = {
    baselineEstablished: false,
    corrections,
    facts,
    retractions: [],
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: `acquisition.${digestPublicSourceValue([source.sourceInstanceId, source.cursor.revision, input.window, contentDigest])}`,
      adapterDefinitionDigest: source.adapterDefinitionDigest, adapterId: source.adapterId, adapterVersion: source.adapterVersion,
      baselineEstablished: false, candidateFactRevisionIds: facts.map(({ revisionId }) => revisionId), correctionIds: corrections.map(({ correctionId }) => correctionId), retractionIds: [], coverage: "complete", errorCode: null, observedAt,
      proposedNextCursor: { contentDigest, expectedRevision: source.cursor.revision, watermark }, recordType: "public_source_acquisition_result", retryAfterSeconds: null, schemaVersion: 1, sourceInstanceId: source.sourceInstanceId,
      stageReceipts: [
        { errorCode: null, inputDigest: digestPublicSourceValue(response.body), outputDigest: digestPublicSourceValue(items), stage: "transport", status: "complete" },
        { errorCode: null, inputDigest: digestPublicSourceValue(items), outputDigest: contentDigest, stage: "normalize", status: "complete" },
      ], status: facts.length ? "complete" : "no_change",
    }),
    window: input.window,
  };
  const commit = await commitPublicSourceAcquisition({ acquisition, client: input.client });
  return Object.freeze({ acquisition: acquisition.result, baselineEstablished: false, commit, journal: commit.journal, reused: false });
}
