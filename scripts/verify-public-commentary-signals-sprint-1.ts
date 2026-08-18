import assert from "node:assert/strict";

import { PUBLIC_SOURCE_ADAPTER_IDS, PUBLIC_SOURCE_FACT_SCHEMA_VERSIONS } from "../agent/lib/public-source-adapter-schema";
import { readPublicSourceAcquisitionResult, readPublicSourceInstance, type PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import { coordinatePublicSourceOccurrence } from "../agent/lib/public-source-coordinator";
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
import { claimDueXPublicStatementsForRehydration, completeXPublicStatementRehydration, registerWorkspaceXPublicStatementForRehydration, trackXPublicStatementForRehydration } from "../agent/lib/x-public-statement-rehydration-store";

class MemoryStore implements PublicSourceAcquisitionStoreClient, PublicSourceSubscriptionStoreClient, RevocableEvidenceStoreClient {
  readonly values = new Map<string, string>();
  failNextDeletionConfirmation = false;
  failNextDelete = false;
  async compareAndSet(key: string, expected: string | null, next: string): Promise<boolean> {
    const current = this.values.get(key) ?? null;
    if (current !== expected) return false;
    if (this.failNextDeletionConfirmation && next.includes('"state":"confirmed"')) {
      this.failNextDeletionConfirmation = false;
      return false;
    }
    this.values.set(key, next);
    return true;
  }
  async delete(key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected_delete_failure");
    }
    this.values.delete(key);
  }
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
const workspaceA = "123e4567-e89b-42d3-a456-426614174201";
const workspaceB = "123e4567-e89b-42d3-a456-426614174202";
const ownerEnvironment = { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" };
const scopeA = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: workspaceA }, ownerEnvironment);
const scopeB = authorizeDeploymentWorkspaceStore({ ownerId: "owner_fixture", workspaceId: workspaceB }, ownerEnvironment);
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
for (const fact of acquired.statements) {
  if (fact.payload.schemaVersion !== "public-statement/v1") continue;
  await registerWorkspaceXPublicStatementForRehydration({ scope: scopeA, stablePostId: fact.payload.statement.stablePostId }, store);
  await registerWorkspaceXPublicStatementForRehydration({ scope: scopeB, stablePostId: fact.payload.statement.stablePostId }, store);
}
const claimedRehydrations = await claimDueXPublicStatementsForRehydration({
  now: new Date("2026-08-18T06:35:00.000Z"),
  scope: scopeA,
}, store);
assert.deepEqual(claimedRehydrations.map(({ stablePostId }) => stablePostId).sort(), ["100", "102", "103", "104"]);
assert.deepEqual(await claimDueXPublicStatementsForRehydration({
  now: new Date("2026-08-18T06:35:00.000Z"),
  scope: scopeB,
}, store), [], "a concurrent workspace must not duplicate paid exact-post checks");

const leaseStore = new MemoryStore();
const leaseEvidence = { ...evidence, client: leaseStore };
const leaseAcquisition = await acquireXPublicStatements({
  client: leaseStore,
  evidence: leaseEvidence,
  responses: [response(createXTimelineRequest({ sourceInstance: source.sourceInstance }), { data: [fixturePosts.original], meta: { newest_id: "100" } })],
  sourceInstance: source.sourceInstance,
  window,
});
const leaseFact = leaseAcquisition.statements[0]!;
await registerWorkspaceXPublicStatementForRehydration({ scope: scopeA, stablePostId: "100" }, leaseStore);
const staleClaim = (await claimDueXPublicStatementsForRehydration({ now: new Date("2026-08-18T06:35:00.000Z"), scope: scopeA }, leaseStore))[0]!;
const leaseEditedPost = { ...fixturePosts.original, edit_history_tweet_ids: ["100", "105"], id: "105", text: "Fixture lease-generation edit." };
await acquireXPublicStatements({
  client: leaseStore,
  evidence: leaseEvidence,
  responses: [response(createXTimelineRequest({ sourceInstance: source.sourceInstance }), { data: [leaseEditedPost], meta: { newest_id: "105" } }, 200, "2026-08-18T06:36:00.000Z")],
  sourceInstance: source.sourceInstance,
  window: { endAt: "2026-08-18T06:37:00.000Z", startAt: "2026-08-18T06:36:00.000Z" },
});
await assert.rejects(completeXPublicStatementRehydration({
  amountUsd: "0.005000",
  billablePostReads: 1,
  candidate: staleClaim,
  correctionRequired: true,
  lifecycle: "edited",
  now: new Date("2026-08-18T06:36:00.000Z"),
}, leaseStore), /x_rehydration_claim_stale/u);

const backlogStore = new MemoryStore();
for (let index = 0; index < 513; index += 1) {
  const stablePostId = String(10_000 + index);
  await trackXPublicStatementForRehydration({
    editableUntil: "2026-08-18T06:30:00.000Z",
    factRevisionId: `fact.backlog.${stablePostId}`,
    lifecycle: "final",
    observedAt,
    providerPostId: stablePostId,
    stablePostId,
  }, backlogStore);
}
assert.equal(
  [...backlogStore.values.keys()].filter((key) => key.startsWith("revocable-rehydration:x:v2:")).length,
  32,
  "more than 200 active statements must remain bounded and claimable without a global queue wedge",
);

const capacityStore = new MemoryStore();
for (let index = 0; index < 512; index += 1) {
  const stablePostId = String(32_000 + index * 32);
  await trackXPublicStatementForRehydration({
    editableUntil: "2026-08-18T06:30:00.000Z",
    factRevisionId: `fact.capacity.${stablePostId}`,
    lifecycle: "final",
    observedAt,
    providerPostId: stablePostId,
    stablePostId,
  }, capacityStore);
}
const capacityPostId = String(32_000 + 512 * 32);
const capacityRequest = createXTimelineRequest({ sourceInstance: source.sourceInstance });
await assert.rejects(acquireXPublicStatements({
  client: capacityStore,
  evidence: { ...evidence, client: capacityStore },
  responses: [response(capacityRequest, {
    data: [{
      ...fixturePosts.original,
      conversation_id: capacityPostId,
      edit_history_tweet_ids: [capacityPostId],
      id: capacityPostId,
    }],
    meta: { newest_id: capacityPostId },
  })],
  sourceInstance: source.sourceInstance,
  window,
}), /x_rehydration_capacity_exceeded/u);
const capacityEnvelope = await readRevocableEvidenceEnvelope(
  `revocable-evidence.x.${capacityPostId}`,
  capacityStore,
);
assert.equal(capacityEnvelope?.payloadDeletion?.state, "confirmed");
assert.equal(capacityEnvelope?.payloadDeletion?.receipt.reason, "capacity_exceeded");

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
assert.equal(gap.result.status, "no_change");
assert.equal(gap.result.errorCode, null);
assert.equal(gap.baselineEstablished, true);
assert.equal(gap.result.proposedNextCursor?.watermark, "102");
assert.equal(gap.statements.length, 0);
assert.equal([...gapStore.values.keys()].some((key) => key.startsWith("revocable-payload:")), false);

const overflowStore = new MemoryStore();
const overflowEvidence = { ...evidence, client: overflowStore };
const overflowRequests: XPublicStatementRequest[] = [];
const overflowFetch = async (request: XPublicStatementRequest) => {
  overflowRequests.push(request);
  if (new URL(request.url).searchParams.has("since_id")) {
    return response(request, { data: [], meta: { result_count: 0 } }, 200, "2026-08-18T06:22:00.000Z");
  }
  return new URL(request.url).searchParams.get("pagination_token") === null
    ? response(request, { data: [fixturePosts.original], meta: { newest_id: "100", next_token: "overflow-2" } })
    : response(request, { data: [fixturePosts.quote], meta: { newest_id: "102", next_token: "overflow-3" } });
};
const overflowBaseline = await runSharedXPublicStatementAcquisition({
  client: overflowStore,
  evidence: overflowEvidence,
  fetchResponse: overflowFetch,
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:21:00.000Z", startAt: "2026-08-18T06:20:00.000Z" },
});
assert.equal(overflowBaseline.acquisition.status, "no_change");
assert.equal(overflowBaseline.acquisition.proposedNextCursor?.watermark, "102");
const overflowForward = await runSharedXPublicStatementAcquisition({
  client: overflowStore,
  evidence: overflowEvidence,
  fetchResponse: overflowFetch,
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:23:00.000Z", startAt: "2026-08-18T06:22:00.000Z" },
});
assert.equal(overflowForward.acquisition.status, "no_change");
assert.equal(new URL(overflowRequests[2]!.url).searchParams.get("since_id"), "102");
assert.equal(overflowRequests.length, 3);

const continuationStore = new MemoryStore();
const continuationEvidence = { ...evidence, client: continuationStore };
await runSharedXPublicStatementAcquisition({
  client: continuationStore,
  evidence: continuationEvidence,
  fetchResponse: async (request) => response(request, { data: [fixturePosts.original], meta: { newest_id: "100" } }),
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:24:00.000Z", startAt: "2026-08-18T06:23:00.000Z" },
});
const continuationRequests: XPublicStatementRequest[] = [];
const continuationFetch = async (request: XPublicStatementRequest) => {
  continuationRequests.push(request);
  const token = new URL(request.url).searchParams.get("pagination_token");
  if (token === null) return response(request, { data: [fixturePosts.quote], meta: { next_token: "continuation-2" } });
  if (token === "continuation-2") return response(request, { data: [fixturePosts.reply], meta: { next_token: "continuation-3" } });
  assert.equal(token, "continuation-3");
  return response(request, { data: [fixturePosts.later], meta: { newest_id: "104" } });
};
const continuationPartial = await runSharedXPublicStatementAcquisition({
  client: continuationStore,
  evidence: continuationEvidence,
  fetchResponse: continuationFetch,
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:26:00.000Z", startAt: "2026-08-18T06:25:00.000Z" },
});
assert.equal(continuationPartial.acquisition.errorCode, "pagination_bounds_exceeded");
assert.equal(continuationPartial.statements.length, 0);
assert.equal(continuationPartial.receipt.billablePostReads, 2);
const continuationComplete = await runSharedXPublicStatementAcquisition({
  client: continuationStore,
  evidence: continuationEvidence,
  fetchResponse: continuationFetch,
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:28:00.000Z", startAt: "2026-08-18T06:27:00.000Z" },
});
assert.equal(continuationComplete.acquisition.status, "complete");
assert.equal(continuationComplete.statements.length, 3);
assert.equal(continuationComplete.receipt.billablePostReads, 1);
assert.equal(
  continuationPartial.receipt.billablePostReads + continuationComplete.receipt.billablePostReads,
  3,
  "continuation receipts must charge each provider read exactly once",
);
assert.deepEqual(continuationRequests.map((request) => new URL(request.url).searchParams.get("pagination_token")), [null, "continuation-2", "continuation-3"]);
assert.equal((await readPublicSourceInstance(source.sourceInstance.sourceInstanceId, continuationStore))?.cursor.watermark, "104");

for (const [label, thrown, expectedCode] of [
  ["timeout", Object.assign(new Error("fixture timeout"), { name: "TimeoutError" }), "transport_timeout"],
  ["transport", new Error("fixture connection reset"), "acquisition_uncertain"],
] as const) {
  const failureStore = new MemoryStore();
  const failed = await runSharedXPublicStatementAcquisition({
    client: failureStore,
    evidence: { ...evidence, client: failureStore },
    fetchResponse: async () => { throw thrown; },
    sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
    window: {
      endAt: label === "timeout" ? "2026-08-18T06:25:00.000Z" : "2026-08-18T06:27:00.000Z",
      startAt: label === "timeout" ? "2026-08-18T06:24:00.000Z" : "2026-08-18T06:26:00.000Z",
    },
  });
  assert.equal(failed.acquisition.errorCode, expectedCode);
  assert.equal(failed.journal, null);
  assert.notEqual(await readPublicSourceAcquisitionResult(failed.acquisition.acquisitionId, failureStore), null);
}
const parseFailureStore = new MemoryStore();
const parseFailure = await runSharedXPublicStatementAcquisition({
  client: parseFailureStore,
  evidence: { ...evidence, client: parseFailureStore },
  fetchResponse: async (request) => response(request, "not-json"),
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:29:00.000Z", startAt: "2026-08-18T06:28:00.000Z" },
});
assert.equal(parseFailure.acquisition.errorCode, "parser_incomplete");
assert.notEqual(await readPublicSourceAcquisitionResult(parseFailure.acquisition.acquisitionId, parseFailureStore), null);

const replay = await runSharedXPublicStatementAcquisition({ client: store, evidence, fetchResponse, sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, window });
assert.equal(replay.reused, true);
assert.equal(replay.receipt.amountUsd, "0.000000");
assert.equal(externalReads, 2);
assert.deepEqual(replay.statements.map(({ revisionId }) => revisionId), acquired.statements.map(({ revisionId }) => revisionId));
const storedSource = (await readPublicSourceInstance(source.sourceInstance.sourceInstanceId, store))!;
assert.equal(new URL(createXTimelineRequest({ sourceInstance: storedSource }).url).searchParams.get("since_id"), "104");
assert.equal(createXExactPostRequest("100").url.startsWith("https://api.x.com/2/tweets/100?"), true);

const referenceA = resolvePublicSourceWorkspaceReference({ monitorId: "monitor.commentary.a", sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, workspaceId: workspaceA });
const referenceB = resolvePublicSourceWorkspaceReference({ monitorId: "monitor.commentary.b", sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, workspaceId: workspaceB });
const coordinatorStore = new MemoryStore();
const coordinatorReference = resolvePublicSourceWorkspaceReference({ monitorId: "monitor.commentary.coordinator", sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID, workspaceId: workspaceA });
const coordinated = await coordinatePublicSourceOccurrence({
  clients: { acquisition: coordinatorStore, subscription: coordinatorStore },
  environment: {
    ...ownerEnvironment,
    EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
    EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
    EVE_X_PUBLIC_STATEMENT_SOURCE_ENABLED: "1",
  },
  fetch: {
    adapterId: "x-public-statements",
    evidence: { ...evidence, client: coordinatorStore },
    fetchResponse: async (request) => response(request, { data: [fixturePosts.original], meta: { newest_id: "100", result_count: 1 } }),
  },
  monitor: {
    lifecycleState: "enabled",
    managedBy: null,
    monitorId: "monitor.commentary.coordinator",
    publicSourceSubscriptions: [coordinatorReference],
    workspaceId: workspaceA,
  },
  scope: scopeA,
  sourceId: X_PUBLIC_STATEMENTS_SOURCE_ID,
  window: { endAt: "2026-08-18T06:31:00.000Z", startAt: "2026-08-18T06:30:00.000Z" },
});
assert.notEqual(coordinated.projection, null);
assert.equal(coordinated.acquisition.proposedNextCursor?.watermark, "100");
assert.equal(coordinated.workspaceCheckpoint?.watermark, observedAt);
assert.match(coordinated.workspaceCheckpoint?.watermark ?? "", /^\d{4}-\d{2}-\d{2}T/u);
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
assert.equal(finalized.correctionRequired, true);
assert.equal(finalized.correctionEvent?.reason, "source_edited");
assert.equal(finalized.canonical?.journal.status, "committed");
assert.equal(finalized.canonical?.fact.payload.schemaVersion === "public-statement/v1" ? finalized.canonical.fact.payload.statement.lifecycle : null, "final");

await transitionRevocableEvidence({
  client: store,
  envelopeId: "revocable-evidence.x.102",
  lifecycle: "final",
  observedAt: "2026-08-18T06:41:00.000Z",
  reasonCode: "fixture_interrupted_after_evidence_transition",
});
const recoveredFinalization = await rehydrateXPublicStatement({
  evidence,
  response: response(createXExactPostRequest("102"), { data: fixturePosts.quote }, 200, "2026-08-18T06:42:00.000Z"),
  sourceInstance: storedSource,
  stablePostId: "102",
});
assert.equal(recoveredFinalization.lifecycle, "final");
assert.equal(recoveredFinalization.canonical?.journal.status, "committed");
assert.notEqual(recoveredFinalization.canonical?.correction, null);

const editedPost = { ...fixturePosts.original, edit_controls: { editable_until: "2026-08-18T07:10:00.000Z" }, edit_history_tweet_ids: ["100", "105"], id: "105", text: "Fixture edited bearish view on $AAPL." };
const edited = await rehydrateXPublicStatement({ evidence, providerPostId: "105", response: response(createXExactPostRequest("105"), { data: editedPost }, 200, "2026-08-18T06:45:00.000Z"), sourceInstance: storedSource, stablePostId: "100" });
assert.equal(edited.lifecycle, "edited");
assert.equal(edited.correctionRequired, true);
assert.equal(edited.correctionEvent?.reason, "source_edited");
assert.equal(edited.canonical?.journal.status, "committed");
assert.notEqual(edited.canonical?.correction, null);
assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: firstEnvelopeId }), editedPost.text);

const deleted = await rehydrateXPublicStatement({ evidence, providerPostId: "105", response: response(createXExactPostRequest("105"), { errors: [{ detail: "not found" }] }, 404, "2026-08-18T07:00:00.000Z"), sourceInstance: storedSource, stablePostId: "100" });
assert.equal(deleted.lifecycle, "deleted");
assert.equal(deleted.correctionRequired, true);
assert.equal(deleted.correctionEvent?.reason, "source_deleted");
assert.equal(deleted.purgeReceipt?.reason, "provider_deleted");
assert.equal(await readRevocableEvidencePayload({ client: store, encryptionKey, envelopeId: firstEnvelopeId }), null);
const tombstoned = await transitionRevocableEvidence({ client: store, envelopeId: firstEnvelopeId, lifecycle: "tombstoned", observedAt: "2026-08-18T07:01:00.000Z", reasonCode: "invalidation_propagated" });
assert.equal(tombstoned.currentLifecycle, "tombstoned");

const genericForbidden = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("102"), { errors: [{ detail: "forbidden" }] }, 403, "2026-08-18T07:02:00.000Z"), sourceInstance: storedSource, stablePostId: "102" });
assert.equal(genericForbidden.lifecycle, "unavailable");
assert.notEqual((await readRevocableEvidenceEnvelope("revocable-evidence.x.102", store))?.payloadReference, null);
const protectedResult = await rehydrateXPublicStatement({ evidence, response: response(createXExactPostRequest("102"), { errors: [{ detail: "This post belongs to a protected account." }] }, 403, "2026-08-18T07:02:30.000Z"), sourceInstance: storedSource, stablePostId: "102" });
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
store.failNextDelete = true;
await assert.rejects(
  purgeRevocableEvidence({ client: store, envelopeId: "revocable-evidence.x.104", lifecycle: "purged", observedAt: "2026-08-18T07:05:00.000Z", reason: "retention_expired" }),
  /injected_delete_failure/u,
);
const pendingPurge = await readRevocableEvidenceEnvelope("revocable-evidence.x.104", store);
assert.equal(pendingPurge?.currentLifecycle, "purged");
assert.equal(pendingPurge?.payloadDeletion?.state, "pending");
const recoveredPurge = await purgeRevocableEvidence({ client: store, envelopeId: "revocable-evidence.x.104", lifecycle: "purged", observedAt: "2026-08-18T07:06:00.000Z", reason: "retention_expired" });
const replayedPurge = await purgeRevocableEvidence({ client: store, envelopeId: "revocable-evidence.x.104", lifecycle: "purged", observedAt: "2026-08-18T07:07:00.000Z", reason: "retention_expired" });
assert.equal(recoveredPurge.envelope.payloadDeletion?.state, "confirmed");
assert.equal(replayedPurge.receipt.receiptDigest, recoveredPurge.receipt.receiptDigest);
assert.equal(replayedPurge.receipt.purgedAt, "2026-08-18T07:05:00.000Z");

const confirmationFaultStore = new MemoryStore();
await acquireXPublicStatements({
  client: confirmationFaultStore,
  evidence: { ...evidence, client: confirmationFaultStore },
  responses: [response(baselineRequest, { data: [fixturePosts.original], meta: { newest_id: "100" } })],
  sourceInstance: source.sourceInstance,
  window,
});
confirmationFaultStore.failNextDeletionConfirmation = true;
await assert.rejects(
  purgeRevocableEvidence({ client: confirmationFaultStore, envelopeId: "revocable-evidence.x.100", lifecycle: "purged", observedAt: "2026-08-18T07:08:00.000Z", reason: "retention_expired" }),
  /revocable_evidence_conflict/u,
);
assert.equal((await readRevocableEvidenceEnvelope("revocable-evidence.x.100", confirmationFaultStore))?.payloadDeletion?.state, "pending");
const confirmedAfterCasFault = await purgeRevocableEvidence({ client: confirmationFaultStore, envelopeId: "revocable-evidence.x.100", lifecycle: "purged", observedAt: "2026-08-18T07:09:00.000Z", reason: "retention_expired" });
assert.equal(confirmedAfterCasFault.envelope.payloadDeletion?.state, "confirmed");
assert.equal(confirmedAfterCasFault.receipt.purgedAt, "2026-08-18T07:08:00.000Z");

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
