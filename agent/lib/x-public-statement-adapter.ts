import { z } from "zod";

import {
  commitPublicSourceAcquisition,
  derivePublicSourceAcquisitionEligibilityId,
  ensurePublicSourceInstance,
  readCommittedPublicSourceAcquisitionForWindow,
  readLatestPublicSourceFactRevision,
  readPublicSourceFactRevision,
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
  publicSourceCorrectionSchema,
  publicSourceInstanceSchema,
  type CanonicalPublicFactRevision,
  type PublicSourceCorrection,
  type PublicSourceInstance,
} from "./public-source-adapter-schema";
import {
  PUBLIC_COMMENTARY_LIMITS,
  digestPublicCommentaryValue,
  type RevocableEvidenceEnvelope,
} from "./public-commentary-schema";
import {
  createRevocableEvidence,
  purgeRevocableEvidence,
  readRevocableEvidenceEnvelope,
  replaceRevocableEvidence,
  transitionRevocableEvidence,
  type RevocableEvidenceStoreClient,
} from "./revocable-evidence-store";
import { resolveReviewedPublicSource } from "./public-source-registry";

const X_API_ORIGIN = "https://api.x.com";
const X_POST_READ_USD = 0.005;

const numericIdSchema = z.string().regex(/^\d{1,20}$/u);
const timestampSchema = z.string().datetime({ offset: true });

const xPostSchema = z.object({
  author_id: numericIdSchema,
  conversation_id: numericIdSchema,
  created_at: timestampSchema,
  edit_controls: z.object({ editable_until: timestampSchema }).passthrough(),
  edit_history_post_ids: z.array(numericIdSchema).min(1).max(6).optional(),
  edit_history_tweet_ids: z.array(numericIdSchema).min(1).max(6).optional(),
  entities: z.object({
    cashtags: z.array(z.object({ tag: z.string() }).passthrough()).max(32).optional(),
    mentions: z.array(z.object({ username: z.string() }).passthrough()).max(32).optional(),
    urls: z.array(z.object({ expanded_url: z.string().url().optional() }).passthrough()).max(32).optional(),
  }).passthrough().optional(),
  id: numericIdSchema,
  referenced_posts: z.array(z.object({ id: numericIdSchema, type: z.string() }).passthrough()).max(16).optional(),
  referenced_tweets: z.array(z.object({ id: numericIdSchema, type: z.string() }).passthrough()).max(16).optional(),
  text: z.string().max(PUBLIC_COMMENTARY_LIMITS.maximumStatementCharacters),
  withheld: z.unknown().optional(),
}).passthrough();

const xTimelineBodySchema = z.object({
  data: z.array(xPostSchema).max(100).optional(),
  meta: z.object({
    newest_id: numericIdSchema.optional(),
    next_token: z.string().min(1).max(500).optional(),
    oldest_id: numericIdSchema.optional(),
    result_count: z.number().int().nonnegative().max(100).optional(),
  }).passthrough().optional(),
}).passthrough();

const xExactBodySchema = z.object({ data: xPostSchema.optional() }).passthrough();

export interface XPublicStatementRequest {
  readonly kind: "exact_post" | "timeline";
  readonly url: string;
}

export interface XPublicStatementResponse {
  readonly body: string;
  readonly finalUrl: string;
  readonly observedAt: string;
  readonly rateLimit: number | null;
  readonly rateRemaining: number | null;
  readonly rateReset: number | null;
  readonly requestedUrl: string;
  readonly status: number;
  readonly truncated?: boolean;
}

export interface XAcquisitionReceipt {
  readonly amountUsd: string;
  readonly billablePostReads: number;
  readonly completeness: "complete" | "partial";
  readonly pagesRead: number;
  readonly rateLimit: number | null;
  readonly rateRemaining: number | null;
  readonly rateReset: number | null;
  readonly recordType: "x_public_statement_acquisition_receipt";
  readonly schemaVersion: 1;
}

export interface XRevocableEvidenceOptions {
  readonly client: RevocableEvidenceStoreClient;
  readonly encryptionKey: Uint8Array;
  readonly keyReference: string;
}

export interface XPublicStatementAcquisition extends PublicSourcePreparedAcquisition {
  readonly baselineEstablished: boolean;
  readonly receipt: XAcquisitionReceipt;
  readonly statements: readonly CanonicalPublicFactRevision[];
}

function xConfiguration(sourceInstance: PublicSourceInstance) {
  if (sourceInstance.configuration.kind !== "x_public_statements_user") {
    throw new Error("x_public_statement_source_instance_invalid");
  }
  return sourceInstance.configuration;
}

function exactOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.origin === X_API_ORIGIN &&
      parsed.username === "" && parsed.password === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function numericHeader(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createXPublicStatementFetch(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMilliseconds?: number;
} = {}): (request: XPublicStatementRequest) => Promise<XPublicStatementResponse> {
  const environment = options.environment ?? process.env;
  const bearerToken = environment.X_BEARER_TOKEN?.trim();
  if (!bearerToken) throw new Error("x_bearer_token_missing");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
  return async (request) => {
    if (!exactOrigin(request.url)) throw new Error("x_transport_origin_forbidden");
    const response = await fetchImpl(request.url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    const body = await response.text();
    const maximumBytes = 1 * 1_024 * 1_024;
    const truncated = Buffer.byteLength(body, "utf8") > maximumBytes;
    if (truncated) throw new Error("x_transport_response_oversized");
    if (!exactOrigin(response.url || request.url)) {
      throw new Error("x_transport_redirect_forbidden");
    }
    return Object.freeze({
      body,
      finalUrl: response.url || request.url,
      observedAt: new Date().toISOString(),
      rateLimit: numericHeader(response.headers.get("x-rate-limit-limit")),
      rateRemaining: numericHeader(response.headers.get("x-rate-limit-remaining")),
      rateReset: numericHeader(response.headers.get("x-rate-limit-reset")),
      requestedUrl: request.url,
      status: response.status,
      truncated,
    });
  };
}

export function createXTimelineRequest(input: {
  readonly paginationToken?: string;
  readonly sourceInstance: PublicSourceInstance;
}): XPublicStatementRequest {
  const source = publicSourceInstanceSchema.parse(input.sourceInstance);
  const configuration = xConfiguration(source);
  const url = new URL(configuration.canonicalUrl);
  url.searchParams.set("exclude", "retweets");
  url.searchParams.set("expansions", "author_id,edit_history_tweet_ids,in_reply_to_user_id,referenced_tweets.id");
  url.searchParams.set("max_results", "100");
  url.searchParams.set("tweet.fields", "author_id,conversation_id,created_at,edit_controls,edit_history_tweet_ids,entities,in_reply_to_user_id,referenced_tweets,text,withheld");
  if (source.cursor.revision > 0) {
    if (source.cursor.watermark === null) throw new Error("x_since_id_missing");
    url.searchParams.set("since_id", source.cursor.watermark);
  }
  if (input.paginationToken) url.searchParams.set("pagination_token", input.paginationToken);
  return Object.freeze({ kind: "timeline", url: url.toString() });
}

export function createXExactPostRequest(postId: string): XPublicStatementRequest {
  const id = numericIdSchema.parse(postId);
  const url = new URL(`${X_API_ORIGIN}/2/tweets/${id}`);
  url.searchParams.set("expansions", "author_id,edit_history_tweet_ids,in_reply_to_user_id,referenced_tweets.id");
  url.searchParams.set("tweet.fields", "author_id,conversation_id,created_at,edit_controls,edit_history_tweet_ids,entities,in_reply_to_user_id,referenced_tweets,text,withheld");
  return Object.freeze({ kind: "exact_post", url: url.toString() });
}

function parseBody(response: XPublicStatementResponse) {
  if (
    response.truncated ||
    !exactOrigin(response.requestedUrl) ||
    !exactOrigin(response.finalUrl) ||
    response.finalUrl !== response.requestedUrl
  ) {
    throw new Error("x_transport_invalid");
  }
  try {
    return xTimelineBodySchema.parse(JSON.parse(response.body));
  } catch {
    throw new Error("x_json_invalid");
  }
}

function editChain(post: z.infer<typeof xPostSchema>): readonly string[] {
  return Object.freeze(post.edit_history_post_ids ?? post.edit_history_tweet_ids ?? [post.id]);
}

function referencedPosts(post: z.infer<typeof xPostSchema>) {
  return post.referenced_posts ?? post.referenced_tweets ?? [];
}

function postRole(post: z.infer<typeof xPostSchema>): "original" | "quote" | "reply" | "repost" {
  const types = new Set(referencedPosts(post).map(({ type }) => type));
  if (types.has("retweeted")) return "repost";
  if (types.has("quoted")) return "quote";
  if (types.has("replied_to")) return "reply";
  return "original";
}

function canonicalXUrl(username: string, postId: string): string {
  return `https://x.com/${username}/status/${postId}`;
}

function lifecycle(post: z.infer<typeof xPostSchema>, observedAt: string) {
  return observedAt < post.edit_controls.editable_until ? "provisional" as const : "final" as const;
}

async function evidenceEnvelope(input: {
  readonly evidence: XRevocableEvidenceOptions;
  readonly observedAt: string;
  readonly post: z.infer<typeof xPostSchema>;
  readonly stablePostId: string;
}): Promise<RevocableEvidenceEnvelope> {
  const envelopeId = `revocable-evidence.x.${input.stablePostId}`;
  const current = await readRevocableEvidenceEnvelope(envelopeId, input.evidence.client);
  if (!current) {
    return createRevocableEvidence({
      client: input.evidence.client,
      encryptionKey: input.evidence.encryptionKey,
      keyReference: input.evidence.keyReference,
      lifecycle: lifecycle(input.post, input.observedAt),
      observedAt: input.observedAt,
      plaintext: input.post.text,
      providerObjectId: input.stablePostId,
    });
  }
  if (current.sourceDigest === digestPublicCommentaryValue(input.post.text)) return current;
  return replaceRevocableEvidence({
    client: input.evidence.client,
    encryptionKey: input.evidence.encryptionKey,
    envelopeId,
    observedAt: input.observedAt,
    plaintext: input.post.text,
    reasonCode: "provider_edit",
  });
}

async function canonicalFact(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly evidence: XRevocableEvidenceOptions;
  readonly observedAt: string;
  readonly post: z.infer<typeof xPostSchema>;
  readonly sourceInstance: PublicSourceInstance;
}): Promise<{ fact: CanonicalPublicFactRevision; correction: PublicSourceCorrection | null }> {
  const configuration = xConfiguration(input.sourceInstance);
  if (input.post.author_id !== configuration.numericUserId) {
    throw new Error("x_source_identity_mismatch");
  }
  const chain = editChain(input.post);
  const stablePostId = chain[0]!;
  const envelope = await evidenceEnvelope({
    evidence: input.evidence,
    observedAt: input.observedAt,
    post: input.post,
    stablePostId,
  });
  const role = postRole(input.post);
  if (role === "repost") throw new Error("x_repost_excluded");
  const canonicalUrl = canonicalXUrl(configuration.username, input.post.id);
  const payload = {
    schemaVersion: "public-statement/v1" as const,
    statement: {
      attribution: "direct" as const,
      canonicalUrl,
      contentDigest: envelope.sourceDigest,
      contentReference: { envelopeId: envelope.envelopeId, revision: envelope.revision },
      editChainIds: [...chain],
      editableUntil: input.post.edit_controls.editable_until,
      entities: {
        cashtags: [...new Set((input.post.entities?.cashtags ?? []).map(({ tag }) => tag.toUpperCase()))],
        mentions: [...new Set((input.post.entities?.mentions ?? []).map(({ username }) => username))],
        urls: [...new Set((input.post.entities?.urls ?? []).flatMap(({ expanded_url }) =>
          expanded_url ? [expanded_url] : []))],
      },
      lifecycle: envelope.currentLifecycle === "edited"
        ? "edited" as const
        : lifecycle(input.post, input.observedAt),
      observedAt: input.observedAt,
      provider: "x" as const,
      publishedAt: input.post.created_at,
      references: {
        conversationId: input.post.conversation_id,
        referencedPostIds: referencedPosts(input.post).map(({ id }) => id),
      },
      revision: envelope.revision,
      role,
      speaker: {
        displayLabel: configuration.displayLabel,
        stableId: configuration.numericUserId,
        username: configuration.username,
      },
      stablePostId,
    },
  };
  const payloadDigest = digestPublicSourceValue(payload);
  const base = {
    adapterId: "x-public-statements" as const,
    createdObservedAt: input.observedAt,
    extraction: { errorCode: null, state: "complete" as const },
    factSchemaVersion: "public-statement/v1" as const,
    payload,
    payloadDigest,
    provenance: {
      authority: "X" as const,
      documentDigest: null,
      publicUrl: canonicalUrl,
      rowEvidenceDigest: envelope.sourceDigest,
    },
    recordType: "canonical_public_fact_revision" as const,
    schemaVersion: 1 as const,
    sourceInstanceId: input.sourceInstance.sourceInstanceId,
    sourceNativeId: stablePostId,
    sourceTimes: { publishedAt: input.post.created_at, updatedAt: input.observedAt },
    stableRowIdentity: "statement",
  };
  const logicalKey = deriveCanonicalPublicFactLogicalKey(base);
  const fact = canonicalPublicFactRevisionSchema.parse({
    ...base,
    logicalKey,
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest }),
  });
  const previous = await readLatestPublicSourceFactRevision(logicalKey, input.client);
  const correction = previous && previous.revisionId !== fact.revisionId
    ? publicSourceCorrectionSchema.parse({
        correctionId: `correction.${digestPublicSourceValue([
          logicalKey,
          previous.revisionId,
          fact.revisionId,
          "source_correction",
        ])}`,
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

function receipt(responses: readonly XPublicStatementResponse[], postsRead: number, complete: boolean): XAcquisitionReceipt {
  const latest = responses.at(-1);
  return Object.freeze({
    amountUsd: (postsRead * X_POST_READ_USD).toFixed(6),
    billablePostReads: postsRead,
    completeness: complete ? "complete" : "partial",
    pagesRead: responses.length,
    rateLimit: latest?.rateLimit ?? null,
    rateRemaining: latest?.rateRemaining ?? null,
    rateReset: latest?.rateReset ?? null,
    recordType: "x_public_statement_acquisition_receipt",
    schemaVersion: 1,
  });
}

function errorAcquisition(input: {
  readonly code: "acquisition_uncertain" | "pagination_bounds_exceeded" | "parser_incomplete" | "rate_limit_exhausted" | "transport_timeout";
  readonly observedAt: string;
  readonly receipt: XAcquisitionReceipt;
  readonly sourceInstance: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): XPublicStatementAcquisition {
  const digest = digestPublicSourceValue([input.sourceInstance.sourceInstanceId, input.window, input.code]);
  return Object.freeze({
    baselineEstablished: false,
    corrections: Object.freeze([]),
    facts: Object.freeze([]),
    receipt: input.receipt,
    retractions: Object.freeze([]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: `acquisition.${digest}`,
      adapterDefinitionDigest: input.sourceInstance.adapterDefinitionDigest,
      adapterId: input.sourceInstance.adapterId,
      adapterVersion: input.sourceInstance.adapterVersion,
      baselineEstablished: false,
      candidateFactRevisionIds: [],
      correctionIds: [],
      retractionIds: [],
      coverage: "partial",
      errorCode: input.code,
      observedAt: input.observedAt,
      proposedNextCursor: null,
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: input.code === "transport_timeout" || input.code === "rate_limit_exhausted" ? 60 : null,
      schemaVersion: 1,
      sourceInstanceId: input.sourceInstance.sourceInstanceId,
      stageReceipts: [{
        errorCode: input.code,
        inputDigest: digest,
        outputDigest: null,
        stage: "transport",
        status: "failed",
      }],
      status: input.code === "transport_timeout" || input.code === "rate_limit_exhausted"
        ? "retryable_failure"
        : input.code === "acquisition_uncertain"
          ? "uncertain"
          : "partial",
    }),
    statements: Object.freeze([]),
    window: input.window,
  });
}

export async function acquireXPublicStatements(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly evidence: XRevocableEvidenceOptions;
  readonly responses: readonly XPublicStatementResponse[];
  readonly sourceInstance: PublicSourceInstance;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<XPublicStatementAcquisition> {
  const sourceInstance = publicSourceInstanceSchema.parse(input.sourceInstance);
  const configuration = xConfiguration(sourceInstance);
  const parsedPages = input.responses.map(parseBody);
  const postsRead = parsedPages.reduce((total, page) => total + (page.data?.length ?? 0), 0);
  const hasUnconsumedPage = parsedPages.at(-1)?.meta?.next_token !== undefined;
  const bounded = input.responses.length <= configuration.maximumPagesPerPoll &&
    postsRead <= configuration.maximumPostsPerPoll;
  const acquisitionReceipt = receipt(input.responses, postsRead, bounded && !hasUnconsumedPage);
  if (!bounded || hasUnconsumedPage) {
    return errorAcquisition({
      code: "pagination_bounds_exceeded",
      observedAt: input.responses.at(-1)?.observedAt ?? input.window.endAt,
      receipt: acquisitionReceipt,
      sourceInstance,
      window: input.window,
    });
  }
  const observedAt = input.responses.at(-1)?.observedAt ?? input.window.endAt;
  const posts = parsedPages.flatMap((page) => page.data ?? [])
    .sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : 1);
  const normalized: { fact: CanonicalPublicFactRevision; correction: PublicSourceCorrection | null }[] = [];
  for (const post of posts) {
    if (postRole(post) === "repost") continue;
    normalized.push(await canonicalFact({
      client: input.client,
      evidence: input.evidence,
      observedAt,
      post,
      sourceInstance,
    }));
  }
  const facts = Object.freeze(normalized.map(({ fact }) => fact));
  const corrections = Object.freeze(normalized.flatMap(({ correction }) => correction ? [correction] : []));
  const watermark = posts.reduce(
    (maximum, post) => BigInt(post.id) > BigInt(maximum) ? post.id : maximum,
    sourceInstance.cursor.watermark ?? "0",
  );
  const contentDigest = digestPublicSourceValue(facts.map((fact) => fact.payloadDigest));
  const id = `acquisition.${digestPublicSourceValue([
    sourceInstance.sourceInstanceId,
    sourceInstance.adapterDefinitionDigest,
    sourceInstance.cursor.revision,
    input.window,
    contentDigest,
  ])}`;
  const baselineEstablished = sourceInstance.cursor.revision === 0;
  return Object.freeze({
    baselineEstablished,
    corrections,
    facts,
    receipt: acquisitionReceipt,
    retractions: Object.freeze([]),
    result: publicSourceAcquisitionResultSchema.parse({
      acquisitionId: id,
      adapterDefinitionDigest: sourceInstance.adapterDefinitionDigest,
      adapterId: sourceInstance.adapterId,
      adapterVersion: sourceInstance.adapterVersion,
      baselineEstablished,
      candidateFactRevisionIds: facts.map((fact) => fact.revisionId),
      correctionIds: corrections.map((correction) => correction.correctionId),
      retractionIds: [],
      coverage: "complete",
      errorCode: null,
      observedAt,
      proposedNextCursor: {
        contentDigest,
        expectedRevision: sourceInstance.cursor.revision,
        watermark,
      },
      recordType: "public_source_acquisition_result",
      retryAfterSeconds: null,
      schemaVersion: 1,
      sourceInstanceId: sourceInstance.sourceInstanceId,
      stageReceipts: [
        {
          errorCode: null,
          inputDigest: digestPublicSourceValue(input.responses.map(({ body }) => body)),
          outputDigest: digestPublicSourceValue(parsedPages),
          stage: "transport",
          status: "complete",
        },
        {
          errorCode: null,
          inputDigest: digestPublicSourceValue(parsedPages),
          outputDigest: digestPublicSourceValue(facts.map((fact) => fact.revisionId)),
          stage: "normalize",
          status: "complete",
        },
      ],
      status: facts.length === 0 ? "no_change" : "complete",
    }),
    statements: facts,
    window: input.window,
  });
}

export interface SharedXPublicStatementAcquisitionResult {
  readonly acquisition: XPublicStatementAcquisition["result"];
  readonly baselineEstablished: boolean;
  readonly commit: PublicSourceAcquisitionCommit | null;
  readonly receipt: XAcquisitionReceipt;
  readonly reused: boolean;
  readonly statements: readonly CanonicalPublicFactRevision[];
}

const sharedAcquisitions = new Map<string, Promise<Omit<SharedXPublicStatementAcquisitionResult, "reused">>>();

async function statementsForRevisionIds(
  revisionIds: readonly string[],
  client?: PublicSourceAcquisitionStoreClient,
): Promise<readonly CanonicalPublicFactRevision[]> {
  const facts = await Promise.all(revisionIds.map((id) => readPublicSourceFactRevision(id, client)));
  if (facts.some((fact) => fact?.factSchemaVersion !== "public-statement/v1")) {
    throw new Error("x_replayed_fact_invalid");
  }
  return Object.freeze(facts.filter((fact): fact is CanonicalPublicFactRevision => fact !== null));
}

const replayReceipt = Object.freeze({
  amountUsd: "0.000000",
  billablePostReads: 0,
  completeness: "complete" as const,
  pagesRead: 0,
  rateLimit: null,
  rateRemaining: null,
  rateReset: null,
  recordType: "x_public_statement_acquisition_receipt" as const,
  schemaVersion: 1 as const,
});

export async function runSharedXPublicStatementAcquisition(input: {
  readonly client?: PublicSourceAcquisitionStoreClient;
  readonly evidence: XRevocableEvidenceOptions;
  readonly fetchResponse: (request: XPublicStatementRequest) => Promise<XPublicStatementResponse>;
  readonly sourceId: string;
  readonly window: { readonly endAt: string; readonly startAt: string };
}): Promise<SharedXPublicStatementAcquisitionResult> {
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
      baselineEstablished: committedForWindow.result.baselineEstablished,
      commit: null,
      receipt: replayReceipt,
      reused: true,
      statements: await statementsForRevisionIds(committedForWindow.result.candidateFactRevisionIds, input.client),
    });
  }
  const sourceInstance = await ensurePublicSourceInstance(reviewed.sourceInstance, input.client);
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
      baselineEstablished: reusable.result.baselineEstablished,
      commit: null,
      receipt: replayReceipt,
      reused: true,
      statements: await statementsForRevisionIds(reusable.result.candidateFactRevisionIds, input.client),
    });
  }
  const eligibilityId = derivePublicSourceAcquisitionEligibilityId(eligibility);
  const active = sharedAcquisitions.get(eligibilityId);
  if (active) return Object.freeze({ ...(await active), reused: true });
  const started = (async (): Promise<Omit<SharedXPublicStatementAcquisitionResult, "reused">> => {
    const responses: XPublicStatementResponse[] = [];
    let paginationToken: string | undefined;
    for (let page = 0; page < xConfiguration(sourceInstance).maximumPagesPerPoll; page += 1) {
      const response = await input.fetchResponse(createXTimelineRequest({
        paginationToken,
        sourceInstance,
      }));
      responses.push(response);
      if (response.status !== 200) {
        const failure = errorAcquisition({
          code: response.status === 429 ? "rate_limit_exhausted" : "acquisition_uncertain",
          observedAt: response.observedAt,
          receipt: receipt(responses, 0, false),
          sourceInstance,
          window: input.window,
        });
        await recordPublicSourceAcquisitionOutcome(failure.result, input.client);
        return Object.freeze({
          acquisition: failure.result,
          baselineEstablished: false,
          commit: null,
          receipt: failure.receipt,
          statements: Object.freeze([]),
        });
      }
      const parsed = parseBody(response);
      paginationToken = parsed.meta?.next_token;
      if (!paginationToken) break;
    }
    const prepared = await acquireXPublicStatements({
      client: input.client,
      evidence: input.evidence,
      responses,
      sourceInstance,
      window: input.window,
    });
    if (prepared.result.status !== "complete" && prepared.result.status !== "no_change") {
      await recordPublicSourceAcquisitionOutcome(prepared.result, input.client);
      return Object.freeze({
        acquisition: prepared.result,
        baselineEstablished: false,
        commit: null,
        receipt: prepared.receipt,
        statements: prepared.statements,
      });
    }
    const commit = await commitPublicSourceAcquisition({ acquisition: prepared, client: input.client });
    return Object.freeze({
      acquisition: prepared.result,
      baselineEstablished: prepared.baselineEstablished,
      commit,
      receipt: prepared.receipt,
      statements: prepared.statements,
    });
  })();
  sharedAcquisitions.set(eligibilityId, started);
  try {
    return Object.freeze({ ...(await started), reused: false });
  } finally {
    if (sharedAcquisitions.get(eligibilityId) === started) sharedAcquisitions.delete(eligibilityId);
  }
}

export async function rehydrateXPublicStatement(input: {
  readonly evidence: XRevocableEvidenceOptions;
  readonly response: XPublicStatementResponse;
  readonly sourceInstance: PublicSourceInstance;
  readonly stablePostId: string;
}) {
  const source = publicSourceInstanceSchema.parse(input.sourceInstance);
  const configuration = xConfiguration(source);
  const envelopeId = `revocable-evidence.x.${numericIdSchema.parse(input.stablePostId)}`;
  const requested = new URL(input.response.requestedUrl);
  if (
    !exactOrigin(input.response.requestedUrl) ||
    !exactOrigin(input.response.finalUrl) ||
    input.response.finalUrl !== input.response.requestedUrl ||
    requested.pathname !== `/2/tweets/${input.stablePostId}`
  ) throw new Error("x_transport_origin_forbidden");
  const current = await readRevocableEvidenceEnvelope(envelopeId, input.evidence.client);
  if (!current) throw new Error("x_revocable_evidence_missing");
  const base = {
    envelopeId,
    rawContentIncluded: false as const,
    recordType: "x_public_statement_lifecycle_result" as const,
    schemaVersion: 1 as const,
    sharedSourceInstanceId: source.sourceInstanceId,
  };
  if (input.response.status !== 200) {
    if (input.response.status === 404 || input.response.status === 403) {
      const reason = input.response.status === 404 ? "provider_deleted" as const : "account_protected" as const;
      const lifecycleState = input.response.status === 404 ? "deleted" as const : "protected" as const;
      const purged = await purgeRevocableEvidence({
        client: input.evidence.client,
        envelopeId,
        lifecycle: lifecycleState,
        observedAt: input.response.observedAt,
        reason,
      });
      return Object.freeze({
        ...base,
        correctionEvent: Object.freeze({
          eventId: `correction.${digestPublicSourceValue([envelopeId, lifecycleState, input.response.observedAt])}`,
          reason: input.response.status === 404 ? "source_deleted" as const : "source_protected" as const,
        }),
        correctionRequired: true,
        eventId: `lifecycle.${digestPublicSourceValue([envelopeId, lifecycleState, input.response.observedAt])}`,
        lifecycle: lifecycleState,
        purgeReceipt: purged.receipt,
      });
    }
    const unavailable = await transitionRevocableEvidence({
      client: input.evidence.client,
      envelopeId,
      lifecycle: "unavailable",
      observedAt: input.response.observedAt,
      reasonCode: "exact_lookup_unavailable",
    });
    return Object.freeze({
      ...base,
      correctionEvent: null,
      correctionRequired: false,
      eventId: unavailable.lifecycleEvents.at(-1)!.eventId,
      lifecycle: "unavailable" as const,
      purgeReceipt: null,
    });
  }
  let body: z.infer<typeof xExactBodySchema>;
  try {
    body = xExactBodySchema.parse(JSON.parse(input.response.body));
  } catch {
    throw new Error("x_json_invalid");
  }
  const post = body.data;
  if (!post || post.author_id !== configuration.numericUserId) {
    throw new Error("x_source_identity_mismatch");
  }
  if (post.withheld !== undefined) {
    const purged = await purgeRevocableEvidence({
      client: input.evidence.client,
      envelopeId,
      lifecycle: "withheld",
      observedAt: input.response.observedAt,
      reason: "provider_withheld",
    });
    return Object.freeze({
      ...base,
      correctionEvent: Object.freeze({
        eventId: `correction.${digestPublicSourceValue([envelopeId, "withheld", input.response.observedAt])}`,
        reason: "source_withheld" as const,
      }),
      correctionRequired: true,
      eventId: `lifecycle.${digestPublicSourceValue([envelopeId, "withheld", input.response.observedAt])}`,
      lifecycle: "withheld" as const,
      purgeReceipt: purged.receipt,
    });
  }
  if (editChain(post)[0] !== input.stablePostId) throw new Error("x_edit_chain_mismatch");
  if (digestPublicCommentaryValue(post.text) !== current.sourceDigest) {
    const edited = await replaceRevocableEvidence({
      client: input.evidence.client,
      encryptionKey: input.evidence.encryptionKey,
      envelopeId,
      observedAt: input.response.observedAt,
      plaintext: post.text,
      reasonCode: "provider_rehydrated",
    });
    return Object.freeze({
      ...base,
      correctionEvent: Object.freeze({
        eventId: `correction.${digestPublicSourceValue([envelopeId, "edited", input.response.observedAt])}`,
        reason: "source_edited" as const,
      }),
      correctionRequired: true,
      eventId: edited.lifecycleEvents.at(-1)!.eventId,
      lifecycle: "edited" as const,
      purgeReceipt: null,
    });
  }
  const final = input.response.observedAt >= post.edit_controls.editable_until
    ? await transitionRevocableEvidence({
        client: input.evidence.client,
        envelopeId,
        lifecycle: "final",
        observedAt: input.response.observedAt,
        reasonCode: "edit_window_closed",
      })
    : current;
  return Object.freeze({
    ...base,
    correctionEvent: null,
    correctionRequired: false,
    eventId: final.lifecycleEvents.at(-1)!.eventId,
    lifecycle: final.currentLifecycle,
    purgeReceipt: null,
  });
}
