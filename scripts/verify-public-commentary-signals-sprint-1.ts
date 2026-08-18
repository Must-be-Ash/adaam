import assert from "node:assert/strict";

import { PUBLIC_SOURCE_ADAPTER_IDS, PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS } from "../agent/lib/public-source-adapter-schema";
import { readPublicSourceInstance, type PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { resolveXPublicStatementRuntimePath } from "../agent/lib/public-source-flags";
import { createPublicSourceSubscription, resolvePublicSourceWorkspaceReference } from "../agent/lib/public-source-workspace-reference";
import { ensurePublicSourceSubscription, projectPublicSourceAcquisition, type PublicSourceSubscriptionStoreClient } from "../agent/lib/public-source-subscription-store";
import { resolvePublicCommentaryRuntimeFlags } from "../agent/lib/public-commentary-flags";
import { projectPublicCommentarySourceEvent } from "../agent/lib/public-commentary-workspace-isolation";
import { purgeRevocableEvidence, readRevocableEvidenceEnvelope, readRevocableEvidencePayload, transitionRevocableEvidence, type RevocableEvidenceStoreClient } from "../agent/lib/revocable-evidence-store";
import { X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER, X_PUBLIC_STATEMENTS_SOURCE_ID } from "../agent/lib/strategy-pack-reference-catalog";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import { acquireXPublicStatements, createXExactPostRequest, createXPublicStatementFetch, createXTimelineRequest, rehydrateXPublicStatement, runSharedXPublicStatementAcquisition, type XPublicStatementRequest, type XPublicStatementResponse } from "../agent/lib/x-public-statement-adapter";

class MemoryStore implements PublicSourceAcquisitionStoreClient, PublicSourceSubscriptionStoreClient, RevocableEvidenceStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async get(key: string): Promise<unknown> { return this.values.get(key) ?? null; }
}

const source = resolveReviewedPublicSource(X_PUBLIC_STATEMENTS_SOURCE_ID);
assert.deepEqual(PUBLIC_SOURCE_ADAPTER_IDS, ["earnings-call-transcripts", "house-financial-disclosures", "sec-latest-filings", "x-public-statements"]);
assert.ok(PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS.includes("public-statement/v1"));
assert.equal(source.adapterDefinition.definitionDigest, X_PUBLIC_STATEMENTS_PUBLIC_SOURCE_ADAPTER.definitionDigest);
assert.equal(source.sourceInstance.configuration.kind, "x_public_statements_user");
assert.equal(source.sourceInstance.configuration.numericUserId, "14216123");

assert.equal(resolveXPublicStatementRuntimePath({}), "disabled");
assert.equal(resolveXPublicStatementRuntimePath({ EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1" }), "public_source_misconfigured");
assert.equal(resolveXPublicStatementRuntimePath({ EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1", EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1", EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1" }), "public_source_adapter");
assert.deepEqual(resolvePublicCommentaryRuntimeFlags({}), { corroborationEnabled: false, sourceEnabled: false, strategyExecutionEnabled: false });
assert.deepEqual(resolvePublicCommentaryRuntimeFlags({ EVE_EXA_CORROBORATION_ENABLED: "1", EVE_INVERSE_CRAMER_EXECUTION_ENABLED: "1", EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1" }), { corroborationEnabled: false, sourceEnabled: false, strategyExecutionEnabled: false });

assert.throws(() => createXPublicStatementFetch({ environment: {} }), /x_bearer_token_missing/u);
let observedAuthorization: string | null = null;
const authenticatedFetch = createXPublicStatementFetch({
  environment: { X_BEARER_TOKEN: "fixture-secret" },
  fetchImpl: (async (_request, init) => {
    observedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json", "x-rate-limit-limit": "10000", "x-rate-limit-remaining": "9999", "x-rate-limit-reset": "1787031000" }, status: 200 });
  }) as typeof fetch,
});
const authenticatedResponse = await authenticatedFetch(createXTimelineRequest({ sourceInstance: source.sourceInstance }));
assert.equal(observedAuthorization, "Bearer fixture-secret");
assert.ok(!JSON.stringify(authenticatedResponse).includes("fixture-secret"));

const observedAt = "2026-08-18T06:10:00.000Z";
const window = { endAt: "2026-08-18T06:20:00.000Z", startAt: "2026-08-18T06:10:00.000Z" };
const fixturePosts = {
  original: { author_id: "14216123", conversation_id: "100", created_at: "2026-08-18T06:00:00.000Z", edit_controls: { editable_until: "2026-08-18T06:30:00.000Z" }, edit_history_tweet_ids: ["100"], entities: { cashtags: [{ tag: "AAPL" }], mentions: [{ username: "fixturedesk" }], urls: [{ expanded_url: "https://example.com/research" }] }, id: "100", text: "Fixture bullish view on $AAPL." },
  quote: { author_id: "14216123", conversation_id: "102", created_at: "2026-08-18T06:02:00.000Z", edit_controls: { editable_until: "2026-08-18T06:32:00.000Z" }, edit_history_tweet_ids: ["102"], id: "102", referenced_tweets: [{ id: "90", type: "quoted" }], text: "Fixture commentary attached to a quote." },
  reply: { author_id: "14216123", conversation_id: "80", created_at: "2026-08-18T06:03:00.000Z", edit_controls: { editable_until: "2026-08-18T06:33:00.000Z" }, edit_history_tweet_ids: ["103"], id: "103", referenced_tweets: [{ id: "80", type: "replied_to" }], text: "Fixture reply with a direct view." },
  later: { author_id: "14216123", conversation_id: "104", created_at: "2026-08-18T06:04:00.000Z", edit_controls: { editable_until: "2026-08-18T06:34:00.000Z" }, edit_history_tweet_ids: ["104"], id: "104", text: "Fixture statement for unavailable rehydration." },
  repost: { author_id: "14216123", conversation_id: "101", created_at: "2026-08-18T06:01:00.000Z", edit_controls: { editable_until: "2026-08-18T06:31:00.000Z" }, edit_history_tweet_ids: ["101"], id: "101", referenced_tweets: [{ id: "70", type: "retweeted" }], text: "Fixture repost excluded before evidence persistence." },
} as const;

function response(request: XPublicStatementRequest, body: unknown, status = 200, at = observedAt): XPublicStatementResponse {
  return Object.freeze({ body: JSON.stringify(body), finalUrl: request.url, observedAt: at, rateLimit: status === 200 ? 10_000 : 450, rateRemaining: status === 429 ? 0 : 449, rateReset: 1_787_031_000, requestedUrl: request.url, status });
}

const store = new MemoryStore();
const encryptionKey = new Uint8Array(32).fill(7);
let externalReads = 0;
const fetchedRequests: XPublicStatementRequest[] = [];
const fetchResponse = async (request: XPublicStatementRequest) => {
  externalReads += 1;
  fetchedRequests.push(request);
  return new URL(request.url).searchParams.get("pagination_token") === null
    ? response(request, { data: [fixturePosts.original, fixturePosts.repost], meta: { newest_id: "101", next_token: "fixture-next", result_count: 2 } })
    : response(request, { data: [fixturePosts.quote, fixturePosts.reply, fixturePosts.later], meta: { newest_id: "104", result_count: 3 } });
};
const evidence = { client: store, encryptionKey, keyReference: "kms://revocable-evidence/x-fixture" };

const acquired = await runSharedXPublicStatementAcquisition({ client: store, evidence, fetchResponse, sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, window });
assert.equal(acquired.reused, false);
assert.equal(acquired.baselineEstablished, true);
assert.equal(acquired.acquisition.status, "complete");
assert.equal(acquired.statements.length, 4);
assert.deepEqual(acquired.statements.map((fact) => fact.payload.schemaVersion), Array(4).fill("public-statement/v1"));
assert.deepEqual(acquired.statements.map((fact) => fact.payload.schemaVersion === "public-statement/v1" ? fact.payload.statement.role : null), ["original", "quote", "reply", "original"]);
assert.equal(acquired.receipt.pagesRead, 2);
assert.equal(acquired.receipt.billablePostReads, 5);
assert.equal(acquired.receipt.amountUsd, "0.025000");
assert.equal(acquired.receipt.completeness, "complete");
assert.equal(externalReads, 2);
assert.equal(new URL(fetchedRequests[0]!.url).searchParams.get("since_id"), null);
assert.equal(new URL(fetchedRequests[0]!.url).searchParams.get("exclude"), "retweets");
assert.equal(new URL(fetchedRequests[1]!.url).searchParams.get("pagination_token"), "fixture-next");
assert.ok(!JSON.stringify(acquired).includes(fixturePosts.original.text));
assert.ok(![...store.values.entries()].filter(([key]) => !key.startsWith("revocable-payload:")).some(([, value]) => value.includes(fixturePosts.original.text)));

const gapStore = new MemoryStore();
const baselineRequest = createXTimelineRequest({ sourceInstance: source.sourceInstance });
const gap = await acquireXPublicStatements({
  client: gapStore,
  evidence: { ...evidence, client: gapStore },
  responses: [
    response(baselineRequest, { data: [fixturePosts.original], meta: { next_token: "page-2" } }),
    response({ kind: "timeline", url: `${baselineRequest.url}&pagination_token=page-2` }, { data: [fixturePosts.quote], meta: { next_token: "page-3" } }),
  ],
  sourceInstance: source.sourceInstance,
  window,
});
assert.equal(gap.result.status, "partial");
assert.equal(gap.result.errorCode, "pagination_bounds_exceeded");
assert.equal(gap.statements.length, 0);
assert.equal([...gapStore.values.keys()].some((key) => key.startsWith("revocable-payload:")), false);

const replay = await runSharedXPublicStatementAcquisition({ client: store, evidence, fetchResponse, sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, window });
assert.equal(replay.reused, true);
assert.equal(replay.receipt.amountUsd, "0.000000");
assert.equal(externalReads, 2);
assert.deepEqual(replay.statements.map(({ revisionId }) => revisionId), acquired.statements.map(({ revisionId }) => revisionId));
const storedSource = (await readPublicSourceInstance(source.sourceInstance.sourceInstanceId, store))!;
assert.equal(new URL(createXTimelineRequest({ sourceInstance: storedSource }).url).searchParams.get("since_id"), "104");
assert.equal(createXExactPostRequest("100").url.startsWith("https://api.x.com/2/tweets/100?"), true);

const workspaceA = "123e4567-e89b-42d3-a456-426614174201";
const workspaceB = "123e4567-e89b-42d3-a456-426614174202";
const ownerEnvironment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scopeA = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: workspaceA }, ownerEnvironment);
const scopeB = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: workspaceB }, ownerEnvironment);
const referenceA = resolvePublicSourceWorkspaceReference({ monitorId: "monitor.commentary.a", sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, workspaceId: workspaceA });
const referenceB = resolvePublicSourceWorkspaceReference({ monitorId: "monitor.commentary.b", sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, workspaceId: workspaceB });
const subscriptionA = await ensurePublicSourceSubscription(scopeA, createPublicSourceSubscription({ binding: { bindingRevision: 1, packContentDigest: "a".repeat(64), packId: "inverse-cramer", packVersion: "1.0.0" }, lifecycleState: "active", monitorId: "monitor.commentary.a", reference: referenceA, workspaceId: workspaceA }), store);
const subscriptionB = await ensurePublicSourceSubscription(scopeB, createPublicSourceSubscription({ binding: { bindingRevision: 2, packContentDigest: "b".repeat(64), packId: "inverse-cramer", packVersion: "1.0.0" }, lifecycleState: "active", monitorId: "monitor.commentary.b", reference: referenceB, workspaceId: workspaceB }), store);
const projectedA = await projectPublicSourceAcquisition({ acquisition: acquired.acquisition, scope: scopeA, subscriptionId: subscriptionA.subscriptionId }, { acquisition: store, subscription: store });
const projectedB = await projectPublicSourceAcquisition({ acquisition: acquired.acquisition, scope: scopeB, subscriptionId: subscriptionB.subscriptionId }, { acquisition: store, subscription: store });
assert.equal(projectedA.projections.length, 4);
assert.equal(projectedB.projections.length, 4);
assert.deepEqual(projectedA.projections.map(({ fact }) => fact.revisionId), projectedB.projections.map(({ fact }) => fact.revisionId));
assert.notEqual(subscriptionA.subscriptionId, subscriptionB.subscriptionId);
assert.notDeepEqual(subscriptionA.packBinding, subscriptionB.packBinding);
assert.ok(!JSON.stringify([projectedA, projectedB]).includes(fixturePosts.original.text));

const firstStatement = acquired.statements[0]!;
assert.equal(firstStatement.payload.schemaVersion, "public-statement/v1");
const firstEnvelopeId = firstStatement.payload.statement.contentReference.envelopeId;
assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: firstEnvelopeId }), fixturePosts.original.text);
const finalized = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("100"), { data: fixturePosts.original }, 200, "2026-08-18T06:40:00.000Z"), sourceInstance: storedSource, stablePostId: "100" });
assert.equal(finalized.lifecycle, "final");
assert.equal(finalized.correctionRequired, false);

const editedPost = { ...fixturePosts.original, edit_controls: { editable_until: "2026-08-18T07:10:00.000Z" }, edit_history_tweet_ids: ["100", "105"], id: "105", text: "Fixture edited bearish view on $AAPL." };
const edited = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("100"), { data: editedPost }, 200, "2026-08-18T06:45:00.000Z"), sourceInstance: storedSource, stablePostId: "100" });
assert.equal(edited.lifecycle, "edited");
assert.equal(edited.correctionRequired, true);
assert.equal(edited.correctionEvent?.reason, "source_edited");
assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: firstEnvelopeId }), editedPost.text);

const deleted = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("100"), { errors: [{ detail: "not found" }] }, 404, "2026-08-18T07:00:00.000Z"), sourceInstance: storedSource, stablePostId: "100" });
assert.equal(deleted.lifecycle, "deleted");
assert.equal(deleted.correctionRequired, true);
assert.equal(deleted.correctionEvent?.reason, "source_deleted");
assert.equal(deleted.purgeReceipt?.reason, "provider_deleted");
assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: firstEnvelopeId }), null);
const tombstoned = await transitionRevocableEvidence({ client: store, envelopeId: firstEnvelopeId, lifecycle: "tombstoned", observedAt: "2026-08-18T07:01:00.000Z", reasonCode: "invalidation_propagated" });
assert.equal(tombstoned.currentLifecycle, "tombstoned");

const protectedResult = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("102"), { errors: [{ detail: "forbidden" }] }, 403, "2026-08-18T07:02:00.000Z"), sourceInstance: storedSource, stablePostId: "102" });
assert.equal(protectedResult.lifecycle, "protected");
assert.equal(protectedResult.correctionEvent?.reason, "source_protected");
assert.equal((await readRevocableEvidenceEnvelope("revocable-evidence.x.102", store))?.payloadReference, null);

const withheldResult = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("103"), { data: { ...fixturePosts.reply, withheld: { country_codes: ["US"] } } }, 200, "2026-08-18T07:03:00.000Z"), sourceInstance: storedSource, stablePostId: "103" });
assert.equal(withheldResult.lifecycle, "withheld");
assert.equal(withheldResult.correctionEvent?.reason, "source_withheld");
assert.equal(withheldResult.purgeReceipt?.reason, "provider_withheld");

const unavailableResult = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("104"), { errors: [{ detail: "rate limited" }] }, 429, "2026-08-18T07:04:00.000Z"), sourceInstance: storedSource, stablePostId: "104" });
assert.equal(unavailableResult.lifecycle, "unavailable");
assert.equal(unavailableResult.correctionRequired, false);
assert.notEqual((await readRevocableEvidenceEnvelope("revocable-evidence.x.104", store))?.payloadReference, null);
await purgeRevocableEvidence({ client: store, envelopeId: "revocable-evidence.x.104", lifecycle: "purged", observedAt: "2026-08-18T07:05:00.000Z", reason: "retention_expired" });
assert.equal((await readRevocableEvidenceEnvelope("revocable-evidence.x.104", store))?.currentLifecycle, "purged");

const workspaceProjectionA = projectPublicCommentarySourceEvent({ configurationGeneration: 1, envelopeId: firstEnvelopeId, factRevisionId: firstStatement.revisionId, sourceEventId: deleted.eventId, sourceInstanceId: storedSource.sourceInstanceId, workspaceId: workspaceA });
const workspaceProjectionB = projectPublicCommentarySourceEvent({ configurationGeneration: 3, envelopeId: firstEnvelopeId, factRevisionId: firstStatement.revisionId, sourceEventId: deleted.eventId, sourceInstanceId: storedSource.sourceInstanceId, workspaceId: workspaceB });
assert.equal(workspaceProjectionA.sourceEventId, workspaceProjectionB.sourceEventId);
assert.equal(workspaceProjectionA.factRevisionId, workspaceProjectionB.factRevisionId);
assert.equal(workspaceProjectionA.rawContentIncluded, false);
assert.equal(workspaceProjectionB.rawContentIncluded, false);
assert.notEqual(workspaceProjectionA.configurationGeneration, workspaceProjectionB.configurationGeneration);
assert.notEqual(workspaceProjectionA.modelJobId, workspaceProjectionB.modelJobId);
assert.notEqual(workspaceProjectionA.budgetScopeId, workspaceProjectionB.budgetScopeId);
assert.notEqual(workspaceProjectionA.findingStoreScopeId, workspaceProjectionB.findingStoreScopeId);
assert.notEqual(workspaceProjectionA.chatContextId, workspaceProjectionB.chatContextId);
assert.ok(!JSON.stringify([workspaceProjectionA, workspaceProjectionB]).includes(editedPost.text));

console.log(JSON.stringify({
  acquisition: { baselineEstablished: acquired.baselineEstablished, billablePostReads: acquired.receipt.billablePostReads, facts: acquired.statements.length, pages: acquired.receipt.pagesRead, replayExternalReads: replay.receipt.billablePostReads },
  lifecycle: ["provisional", "final", "edited", "deleted", "protected", "withheld", "unavailable", "purged", "tombstoned"],
  productionFlagsDefaultOff: true,
  status: "sprint_1_green",
  workspaceIsolation: { sharedAcquisition: true, sharedLifecycleEvent: true, workspaceCount: 2 },
}, null, 2));
