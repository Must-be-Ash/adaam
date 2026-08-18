import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createHybridEvidenceArtifactStore,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import {
  EARNINGS_CALL_COMPARISON_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SECTION_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID,
  createEarningsCallComparisonDefinitions,
} from "../agent/lib/hybrid-evidence-definition-registry";
import type { HybridEvidenceJobStoreClient } from "../agent/lib/hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "../agent/lib/hybrid-evidence-lineage-store";
import { hybridEvidenceJobSchema } from "../agent/lib/hybrid-evidence-schema";
import {
  prepareWorkspaceSemanticEvidenceBundleJob,
  type WorkspaceSemanticAuthorizationProjection,
} from "../agent/lib/hybrid-evidence-semantic";
import {
  readWorkspaceSemanticEvidence,
  type WorkspaceSemanticEvidenceStoreClient,
} from "../agent/lib/hybrid-evidence-semantic-store";
import {
  completeHybridEvidenceJobForWorker,
  readHybridEvidenceSliceForWorker,
} from "../agent/lib/hybrid-evidence-worker";
import {
  planEarningsCallSemanticComparison,
  runEarningsCallSemanticComparison,
  type EarningsCallSemanticEvidenceInput,
} from "../agent/lib/earnings-call-semantic";
import { createEarningsCallComparison } from "../agent/lib/earnings-call-comparison";
import { normalizeEarningsCallTranscript } from "../agent/lib/earnings-call-transcript";
import { EARNINGS_CALL_SCHEMA_VERSION, earningsEventSchema } from "../agent/lib/earnings-call-schema";
import {
  canonicalPublicFactRevisionSchema,
  deriveCanonicalPublicFactLogicalKey,
  deriveCanonicalPublicFactRevisionId,
  digestPublicSourceValue,
  publicSourceProjectionSchema,
  publicSourceSubscriptionSchema,
} from "../agent/lib/public-source-adapter-schema";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import type { WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceStateStoreClient,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryCas implements HybridEvidenceArtifactIndexClient,
  HybridEvidenceJobStoreClient, HybridEvidenceLineageStoreClient,
  WorkspaceBudgetLedgerClient, WorkspaceSemanticEvidenceStoreClient,
  WorkspaceStateStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) { this.values.set(key, Uint8Array.from(bytes)); }
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const now = new Date();
const ownerId = "owner_fixture";
const modelId = "google/gemini-3.6-flash";
const workspaces = [
  "123e4567-e89b-42d3-a456-426614174400",
  "123e4567-e89b-42d3-a456-426614174401",
  "123e4567-e89b-42d3-a456-426614174402",
  "123e4567-e89b-42d3-a456-426614174403",
] as const;
const [workspaceA, workspaceB, workspaceC, workspaceD] = workspaces;
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 13).toString("base64url"),
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
} as const;

const definitions = createEarningsCallComparisonDefinitions([modelId]);
assert.deepEqual(definitions.map(({ definitionId }) => definitionId), [
  EARNINGS_CALL_COMPARISON_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SECTION_DEFINITION_ID,
  EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID,
]);
assert.deepEqual(definitions.map(({ limits }) => [limits.maximumInputTokens, limits.maximumOutputTokens]), [
  [12_000, 2_000],
  [5_000, 750],
  [4_000, 1_000],
]);

const fixturePack = strategyPackCatalog.entries.find(({ id, version }) =>
  id === "earnings-call-changes" && version === "1.0.0")!;
const selectedIssuerCik = "0000019617";
const sourceId = `earnings-call-transcripts.${selectedIssuerCik}`;
const sourceContract = resolveParameterizedStrategyPackSources(
  fixturePack,
  { selectedIssuerCiks: [selectedIssuerCik] },
)[0]!;
const reviewedSource = resolveReviewedPublicSource(sourceId);
assert.equal(sourceContract.sourceId, sourceId);
assert.equal(sourceContract.sourceInstanceId, reviewedSource.sourceInstance.sourceInstanceId);
assert.equal(sourceContract.contractDigest, reviewedSource.sourceContract.contractDigest);
assert.deepEqual(sourceContract.allowedOrigins, reviewedSource.sourceContract.allowedOrigins);
const packDigest = fixturePack.contentDigest;

const memory = new MemoryCas();
const artifacts = createHybridEvidenceArtifactStore({
  blob: new MemoryBlob(),
  index: memory,
  quota: {
    deploymentBytesPerDay: 2_000_000,
    deploymentCountPerDay: 100,
    sourceBytesPerDay: 2_000_000,
    sourceCountPerDay: 100,
  },
});

function scope(workspaceId: string) {
  return authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, environment);
}

function seedWorkspace(workspaceId: string) {
  const authorized = scope(workspaceId);
  const binding = prepareInitialWorkspaceStrategyBinding({
    now,
    scope: authorized,
    value: {
      bindingRevision: 1,
      configuration: { selectedIssuerCiks: [selectedIssuerCik] },
      effectiveCapabilityManifestRevision: 1,
      health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
      lastActiveSnapshot: {
        bindingRevision: 1,
        capabilityManifestRevision: 1,
        packContentDigest: packDigest,
        packId: fixturePack.id,
        packVersion: fixturePack.version,
        workspaceGeneration: 1,
      },
      lifecycleState: "active",
      managedResources: {},
      ownerOverrides: {},
      pack: { contentDigest: packDigest, id: fixturePack.id, version: fixturePack.version },
      pendingSnapshot: null,
      timestamps: {
        activatedAt: now.toISOString(),
        configuredAt: now.toISOString(),
        generationRolloverAt: now.toISOString(),
        installedAt: now.toISOString(),
      },
    },
  });
  const capabilities = prepareInitialWorkspaceDocument("capabilities", {
    now,
    scope: authorized,
    value: {
      connectionIds: [], controlPlaneToolIds: [], financialToolIds: [],
      hardDeniedCapabilityIds: ["broker.mutation", "financial.mutation", "filesystem", "shell"],
      maximumDataAccessClassification: "public",
      paidResearchAllowed: false, providerTools: [], researchToolIds: [], skills: [],
      sources: [{
        allowedOrigins: sourceContract.allowedOrigins,
        contractDigest: sourceContract.contractDigest,
        contractVersion: sourceContract.contractVersion,
        origin: sourceContract.allowedOrigins[0]!,
        sourceId: sourceContract.sourceId,
      }],
      workerModelPolicy: { allowedModelIds: [modelId], maximumOutputTokens: 2_000 },
    },
  });
  const budget = prepareInitialWorkspaceDocument("budget", {
    now,
    scope: authorized,
    value: {
      effectiveAt: now.toISOString(), maximumConcurrentWorkers: 2,
      maximumInputTokensPerDay: 100_000, maximumInputTokensPerRun: 24_000,
      maximumOutputTokensPerDay: 20_000, maximumOutputTokensPerRun: 4_000,
      maximumPaidPerCall: "1.00", maximumPaidPerDay: "10.00", maximumPaidPerMonth: "100.00",
      maximumScheduledRunsPerDay: 32, ownerTimezone: "UTC", unknownPriceFallbackCeiling: "1.00",
    },
  });
  memory.values.set(binding.key, binding.raw);
  memory.values.set(capabilities.key, capabilities.raw);
  memory.values.set(budget.key, budget.raw);
}
for (const workspaceId of workspaces) seedWorkspace(workspaceId);

const projections = new Map<string, WorkspaceSemanticAuthorizationProjection>();
function createProjection(input: {
  artifactByteCount: number; artifactDigest: string; eventRevisionId: string; revision: number; role: string; workspaceId: string;
}): WorkspaceSemanticAuthorizationProjection {
  const reviewedEvent = reviewedSource.sourceFamily!.baselineEvents.find(({ role }) =>
    role === (input.role.includes("Q2") ? "current" : "prior"))!;
  const artifactUrl = reviewedEvent.artifactUrl;
  const payload = {
    artifactByteCount: input.artifactByteCount,
    artifactDigest: input.artifactDigest,
    artifactMediaType: "text/html" as const,
    artifactUrl,
    callDate: reviewedEvent.callDate,
    cik: selectedIssuerCik,
    discoveryUrl: reviewedEvent.discoveryUrl,
    fiscalPeriod: input.role,
    schemaVersion: "earnings-call-event/v1" as const,
    secContext: null,
  };
  const factBase = {
    adapterId: reviewedSource.adapterDefinition.adapterId,
    createdObservedAt: now.toISOString(), extraction: { errorCode: null, state: "complete" as const },
    factSchemaVersion: "earnings-call-event/v1", payload, payloadDigest: digestPublicSourceValue(payload),
    provenance: {
      authority: "Issuer IR" as const, documentDigest: input.artifactDigest,
      publicUrl: artifactUrl, rowEvidenceDigest: null,
    },
    recordType: "canonical_public_fact_revision" as const, schemaVersion: 1 as const,
    sourceInstanceId: reviewedSource.sourceInstance.sourceInstanceId,
    sourceNativeId: `${selectedIssuerCik}:${input.role}:${reviewedEvent.callDate}`,
    sourceTimes: { publishedAt: now.toISOString(), updatedAt: now.toISOString() }, stableRowIdentity: "earnings_call",
  };
  const logicalKey = deriveCanonicalPublicFactLogicalKey(factBase);
  const fact = canonicalPublicFactRevisionSchema.parse({
    ...factBase, logicalKey,
    revisionId: deriveCanonicalPublicFactRevisionId({ logicalKey, payloadDigest: factBase.payloadDigest }),
  });
  const subscriptionId = `subscription.${sha256(`${input.workspaceId}:earnings`)}`;
  const subscription = publicSourceSubscriptionSchema.parse({
    adapterDefinitionDigest: reviewedSource.adapterDefinition.definitionDigest,
    adapterVersion: reviewedSource.adapterDefinition.adapterVersion,
    deliveryCursor: { lastAcquisitionId: `acquisition.${input.role}.${input.revision}`, revision: input.revision },
    factSchemaVersions: ["earnings-call-event/v1"], filter: { kind: "all" }, lifecycleState: "active",
    monitorId: "monitor.fixture.earnings",
    packBinding: { bindingRevision: 1, packContentDigest: packDigest, packId: fixturePack.id, packVersion: fixturePack.version },
    recordType: "public_source_subscription", schemaVersion: 1, sourceInstanceId: fact.sourceInstanceId,
    subscriptionId, workspaceId: input.workspaceId,
  });
  const projection = publicSourceProjectionSchema.parse({
    acquisitionId: subscription.deliveryCursor.lastAcquisitionId, factRevisionId: fact.revisionId,
    factSchemaVersion: fact.factSchemaVersion, monitorId: subscription.monitorId, projectedAt: now.toISOString(),
    projectionId: `projection.${digestPublicSourceValue([subscriptionId, fact.revisionId])}`,
    recordType: "public_source_fact_projection", schemaVersion: 1, sourceInstanceId: fact.sourceInstanceId,
    subscriptionId, workspaceId: input.workspaceId,
  });
  const result = Object.freeze({ fact, projection, sourceId, subscription });
  projections.set(`${input.workspaceId}:${fact.revisionId}`, result);
  return result;
}

function transcriptHtml(period: string, current: boolean, repeat = 1) {
  const prepared = (current
    ? "We raised the full-year range with explicit shipment and margin assumptions. "
    : "We maintained the prior range with broad assumptions and limited visibility. ").repeat(repeat);
  const qa = (current
    ? "Jordan Lee (Chief Executive Officer): We expect execution next quarter if demand remains stable. "
    : "Jordan Lee (Chief Executive Officer): We cannot yet quantify the operating drivers. ").repeat(repeat);
  return [
    `<p>${period} earnings conference transcript</p>`, "<h2>Prepared Remarks</h2>",
    `<p>Jordan Lee (Chief Executive Officer): ${prepared}</p>`, "<h2>Questions and Answers</h2>",
    "<p>Alex Kim (Analyst): What changed in the outlook?</p>", `<p>${qa}</p>`,
  ].join("\n");
}

async function createEvidence(input: {
  current: boolean; fiscalPeriod: string; repeat?: number; revision?: number; workspaceId: string;
}): Promise<{ evidence: EarningsCallSemanticEvidenceInput; record: Parameters<typeof createEarningsCallComparison>[0]["current"] }> {
  const revision = input.revision ?? 1;
  const role = input.current ? "current" : "prior";
  const rawBytes = Buffer.from(transcriptHtml(input.fiscalPeriod, input.current, input.repeat ?? 1), "utf8");
  const rawDigest = sha256(rawBytes);
  const eventRevisionId = `event-revision.${input.fiscalPeriod}.${revision}`;
  const normalized = await normalizeEarningsCallTranscript({
    artifactBytes: rawBytes, artifactDigest: rawDigest, artifactMediaType: "text/html",
    eventRevisionId, fiscalPeriod: input.fiscalPeriod,
  });
  assert.equal(normalized.state, "accepted");
  if (normalized.state !== "accepted") throw new Error("fixture_transcript_not_accepted");
  const projection = createProjection({
    artifactByteCount: rawBytes.byteLength,
    artifactDigest: rawDigest,
    eventRevisionId,
    revision,
    role: input.fiscalPeriod,
    workspaceId: input.workspaceId,
  });
  const artifact = await artifacts.persist({
    acquisitionId: projection.projection.acquisitionId, authority: projection.fact.provenance.authority,
    bytes: Buffer.from(normalized.normalizedText, "utf8"),
    canonicalPublicUrl: projection.fact.provenance.publicUrl,
    mediaType: "text/plain", now, observedAt: now.toISOString(), parserEligibility: null,
    sourceInstanceId: projection.fact.sourceInstanceId,
    structure: { characterCount: normalized.normalizedText.length, columnCount: null, pageCount: null, rowCount: null, sheetCount: null },
  });
  const event = earningsEventSchema.parse({
    artifactByteCount: rawBytes.byteLength, artifactDigest: rawDigest,
    callDate: reviewedSource.sourceFamily!.baselineEvents.find(({ fiscalPeriod }) =>
      fiscalPeriod === input.fiscalPeriod)!.callDate,
    cik: selectedIssuerCik, eventId: `event.${input.fiscalPeriod}`, fiscalPeriod: input.fiscalPeriod,
    observedAt: now.toISOString(), publishedAt: now.toISOString(), recordType: "earnings_call_event",
    revision, revisionId: eventRevisionId, schemaVersion: EARNINGS_CALL_SCHEMA_VERSION,
    secAccession: null, sourceInstanceId: projection.fact.sourceInstanceId,
  });
  return {
    evidence: Object.freeze({
      artifact, normalizedText: normalized.normalizedText,
      projectionReference: { factRevisionId: projection.fact.revisionId, sourceId, subscriptionId: projection.subscription.subscriptionId },
      role, sourceFactLocator: { factRevisionId: projection.fact.revisionId, kind: "source_fact", payloadDigest: projection.fact.payloadDigest },
      transcript: normalized.transcript,
    }),
    record: Object.freeze({ event, normalizedText: normalized.normalizedText, transcript: normalized.transcript }),
  };
}

async function pair(workspaceId: string, repeat = 1, priorRevision = 1) {
  const current = await createEvidence({ current: true, fiscalPeriod: "FY2026-Q2", repeat, workspaceId });
  const prior = await createEvidence({ current: false, fiscalPeriod: "FY2026-Q1", repeat, revision: priorRevision, workspaceId });
  return {
    comparison: createEarningsCallComparison({ current: current.record, prior: prior.record }),
    evidence: [{ ...current.evidence, role: "current" as const }, { ...prior.evidence, role: "prior" as const }],
  };
}

function resolveProjection(reference: { factRevisionId: string }, workspaceId: string) {
  return projections.get(`${workspaceId}:${reference.factRevisionId}`) ?? null;
}

let dispatches = 0;
type CandidateMode = "accepted" | "abstained" | "absence_claim_abstained" |
  "absence_claim_incomplete" |
  "absence_claim_undeclared" | "advice_in_fact" | "bad_citation" |
  "fake_precision" | "missing_evidence" | "numeric_in_rationale" |
  "ordinary_negation";
function clients(workspaceId: string, mode: CandidateMode = "accepted"): Parameters<typeof runEarningsCallSemanticComparison>[1] {
  return {
    artifacts, budget: memory, jobs: memory, lineage: memory,
    notifyHealth: async () => {},
    resolveProjection: async (reference) => resolveProjection(reference, workspaceId), semantic: memory, state: memory,
    async execute(prepared) {
      dispatches += 1;
      assert.equal(prepared.request.input.message.includes("Use only read_hybrid_evidence_slice and complete_hybrid_evidence_job"), true);
      assert.equal(prepared.request.input.message.includes("request all required text_span locators together in one parallel tool step"), true);
      assert.equal(prepared.request.input.message.includes("call complete_hybrid_evidence_job immediately using its authoritative schema"), true);
      const body = JSON.parse(prepared.request.input.message.match(/<hybrid-evidence-job-v1>\n([\s\S]+)\n<\/hybrid-evidence-job-v1>/u)![1]!);
      const projection = body.inputProjection;
      const bindings = projection.members.flatMap((member: any) =>
        member.semanticContext.citationSpans.map((span: any) => ({ member, span })));
      const selected = mode === "bad_citation"
        ? [{ ...bindings[0], span: { ...bindings[0].span, citation: { ...bindings[0].span.citation, start: bindings[0].span.citation.start + 1 } } }]
        : bindings.slice(0, Math.max(1, projection.members.length));
      const citations = selected.map(({ span }: any) => span.citation);
      const locatorCitations = selected.map(({ member, span }: any) => ({
        artifactDigest: member.artifactDigest, end: span.citation.end, kind: "text_span" as const,
        spanDigest: span.evidenceSpanDigest, start: span.citation.start,
      }));
      const ctx = { session: { auth: { current: prepared.request.auth, initiator: prepared.request.auth } } };
      const semanticLocator = body.locators.find((locator: any) => locator.kind === "semantic_result");
      if (semanticLocator) {
        const slice = await readHybridEvidenceSliceForWorker({
          clients: {
            artifacts, jobs: memory,
            readSemanticResult: async ({ resultId }) => readWorkspaceSemanticEvidence({ resultId, scope: scope(workspaceId) }, memory),
          },
          ctx, environment, locator: semanticLocator,
        });
        assert.equal(slice.content.includes(semanticLocator.resultId), true);
      }
      const analysisKind = prepared.record.job.definitionId === EARNINGS_CALL_COMPARISON_SECTION_DEFINITION_ID
        ? "section" : prepared.record.job.definitionId === EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID ? "synthesis" : "comparison";
      const assertion = {
        citations,
        statement: mode === "advice_in_fact"
          ? "We recommend buy exposure based on management language."
          : mode === "ordinary_negation"
            ? "Improved specificity does not guarantee outcomes."
          : mode.startsWith("absence_claim")
            ? "Management did not discuss customer churn."
            : "Management language changed relative to the prior call.",
      };
      const noView = mode === "abstained" || mode === "absence_claim_abstained";
      const fields = {
        analysisKind, confidence: noView ? "low" : "medium", counterevidence: [],
        absenceDependentAssertions: mode === "absence_claim_incomplete" ||
          mode === "absence_claim_abstained"
          ? [assertion.statement]
          : [],
        coverage: { complete: true, memberIds: projection.members.map(({ memberId }: any) => memberId) },
        facts: [assertion],
        forecast: analysisKind === "section" || noView ? null : {
          catalysts: [], citations, direction: "positive", horizon: "next_quarter",
          invalidationConditions: ["Demand weakens before the next call."],
          likelyMarketInterpretation: "The change may be interpreted constructively.", risks: [],
          scenarios: [{ condition: "Execution remains stable.", direction: "positive", label: "base", rationale: "Guidance is more specific." }],
        },
        inferences: [assertion], outcome: noView ? "abstained" : "accepted",
        rationale: mode === "numeric_in_rationale"
          ? "The cited change implies 37% upside."
          : "The cited current and prior passages support the bounded comparison.",
        reasonCodes: [noView ? "evidence_incomplete" : "material_change"],
        recommendation: analysisKind === "section" ? null : {
          assumptions: ["The cited public transcript remains authoritative."],
          citations: mode === "missing_evidence" ? [] : citations,
          conditionalImplication: mode === "fake_precision" ? "Buy with a $250 price target."
            : noView ? "No view until complete evidence is available." : "Investigate whether execution supports the changed outlook.",
          rationale: "The stance is limited to the cited call evidence.", stance: noView ? "no_view" : "constructive",
          valuationAssessment: "not_assessed",
        },
      };
      const completionNow = new Date(prepared.record.job.startedAt!);
      const completedShape = hybridEvidenceJobSchema.safeParse({
        ...prepared.record.job,
        completedAt: completionNow.toISOString(),
        state: "completed",
        updatedAt: completionNow.toISOString(),
      });
      if (!completedShape.success) {
        throw new Error(JSON.stringify({ issues: completedShape.error.issues, job: prepared.record.job }));
      }
      await completeHybridEvidenceJobForWorker({
        candidate: { citations: locatorCitations, disposition: noView ? "abstained" : "accepted", fields, unknowns: noView ? ["Current Q&A coverage is incomplete."] : [] },
        ctx, environment, jobClient: memory, now: completionNow,
      });
      return { inputTokens: 100, outputTokens: 50, paidCostUsd: "0.0010" };
    },
  };
}

const small = await pair(workspaceA);
assert.equal(planEarningsCallSemanticComparison(small.evidence).state, "single_job");
const accepted = await runEarningsCallSemanticComparison({
  comparison: small.comparison, environment, evidence: small.evidence, modelId, now,
  pack: fixturePack, scope: scope(workspaceA), workspaceGeneration: 1,
}, clients(workspaceA));
assert.equal(accepted.state, "accepted");
assert.equal(accepted.final?.evidence?.schemaVersion, 2);
assert.deepEqual(accepted.final?.evidence?.schemaVersion === 2
  ? accepted.final.evidence.members.map(({ role }) => role) : [], ["current", "prior"]);
assert.equal(
  (accepted.final?.inputProjection as any)?.members.every((member: any) =>
    member.semanticContext.coverage.liveCallCompleteness === "not_attested"),
  true,
);
assert.equal(accepted.final?.evidence?.result.payload.forecast !== null, true);
assert.equal(accepted.final?.evidence?.result.payload.recommendation !== null, true);
assert.equal(accepted.final?.evidence?.result.citations.length >= 2, true);

const replayDispatches = dispatches;
const replay = await runEarningsCallSemanticComparison({
  comparison: small.comparison, environment, evidence: small.evidence, modelId, now,
  pack: fixturePack, scope: scope(workspaceA), workspaceGeneration: 1,
}, clients(workspaceA));
assert.equal(replay.final?.record.job.jobId, accepted.final?.record.job.jobId);
assert.equal(dispatches, replayDispatches);

const originalMembers = accepted.final!.members.map((member) => ({
  artifact: member.artifact, locators: member.locators, memberId: member.memberId,
  projectionReference: member.projectionReference,
  role: member.role === "current" ? "prior" as const : "current" as const,
  semanticContext: member.semanticContext,
}));
const reversed = await prepareWorkspaceSemanticEvidenceBundleJob({
  definition: definitions[0]!, members: originalMembers, modelId, now, pack: fixturePack,
  scope: scope(workspaceA), workspaceGeneration: 1,
}, {
  jobs: memory,
  resolveProjection: async (reference) => resolveProjection(reference, workspaceA), state: memory,
});
assert.notEqual(reversed.record.job.jobId, accepted.final?.record.job.jobId);

await assert.rejects(() => prepareWorkspaceSemanticEvidenceBundleJob({
  definition: definitions[0]!,
  members: originalMembers.map((member, index) => index === 0 ? {
    ...member,
    projectionReference: {
      ...member.projectionReference,
      sourceId: "earnings-call-transcripts",
    },
  } : member),
  modelId,
  now,
  pack: fixturePack,
  scope: scope(workspaceA),
  workspaceGeneration: 1,
}, {
  jobs: memory,
  resolveProjection: async (reference) => resolveProjection(reference, workspaceA),
  state: memory,
}), /workspace_scope_mismatch/u);

const corrected = await pair(workspaceA, 2, 2);
const correctedRun = await runEarningsCallSemanticComparison({
  comparison: corrected.comparison, environment, evidence: corrected.evidence, modelId,
  now: new Date(now.getTime() + 1_000), pack: fixturePack, scope: scope(workspaceA), workspaceGeneration: 1,
}, clients(workspaceA));
assert.equal(correctedRun.final?.invalidation?.cause.kind, "source_revision");
assert.notEqual(correctedRun.final?.record.job.jobId, accepted.final?.record.job.jobId);

const large = await pair(workspaceB, 190);
const largePlan = planEarningsCallSemanticComparison(large.evidence);
assert.equal(largePlan.state, "sectioned");
assert.equal(largePlan.jobs.length <= 4, true);
const sectioned = await runEarningsCallSemanticComparison({
  comparison: large.comparison, environment, evidence: large.evidence, modelId, now,
  pack: fixturePack, scope: scope(workspaceB), workspaceGeneration: 1,
}, clients(workspaceB));
assert.equal(sectioned.state, "accepted");
assert.equal(sectioned.sections.length, largePlan.jobs.length);
assert.equal(sectioned.final?.record.job.definitionId, EARNINGS_CALL_COMPARISON_SYNTHESIS_DEFINITION_ID);

const abstainPair = await pair(workspaceC);
const abstained = await runEarningsCallSemanticComparison({
  comparison: abstainPair.comparison, environment, evidence: abstainPair.evidence, modelId, now,
  pack: fixturePack, scope: scope(workspaceC), workspaceGeneration: 1,
}, clients(workspaceC, "abstained"));
assert.equal(abstained.state, "abstained");
assert.equal(abstained.final?.evidence?.result.disposition, "abstained");
assert.equal(abstained.final?.strategyEvidence, null);
assert.equal((abstained.final?.evidence?.result.payload.recommendation as any)?.stance, "no_view");

const absenceDowngradePair = await pair(workspaceC, 2);
const absenceDowngrade = await runEarningsCallSemanticComparison({
  comparison: absenceDowngradePair.comparison,
  environment,
  evidence: absenceDowngradePair.evidence,
  modelId,
  now,
  pack: fixturePack,
  scope: scope(workspaceC),
  workspaceGeneration: 1,
}, clients(workspaceC, "absence_claim_abstained"));
assert.equal(absenceDowngrade.state, "abstained");
assert.deepEqual(
  absenceDowngrade.final?.evidence?.result.payload.absenceDependentAssertions,
  ["Management did not discuss customer churn."],
);

const ordinaryNegationPair = await pair(workspaceD, 20);
const ordinaryNegation = await runEarningsCallSemanticComparison({
  comparison: ordinaryNegationPair.comparison,
  environment,
  evidence: ordinaryNegationPair.evidence,
  modelId,
  now,
  pack: fixturePack,
  scope: scope(workspaceD),
  workspaceGeneration: 1,
}, clients(workspaceD, "ordinary_negation"));
assert.equal(ordinaryNegation.state, "accepted");

for (const [index, mode] of ([
  "bad_citation",
  "fake_precision",
  "missing_evidence",
  "advice_in_fact",
  "numeric_in_rationale",
  "absence_claim_undeclared",
  "absence_claim_incomplete",
] as const).entries()) {
  const unsafe = await pair(workspaceD, index + 2);
  const result = await runEarningsCallSemanticComparison({
    comparison: unsafe.comparison, environment, evidence: unsafe.evidence, modelId, now,
    pack: fixturePack, scope: scope(workspaceD), workspaceGeneration: 1,
  }, clients(workspaceD, mode));
  assert.equal(result.state, "quarantined");
  assert.deepEqual(result.final?.record.quarantineCodes, ["model_output_invalid"]);
}

await assert.rejects(() => runEarningsCallSemanticComparison({
  comparison: small.comparison, environment, evidence: small.evidence, modelId, now,
  pack: fixturePack, scope: scope(workspaceB), workspaceGeneration: 1,
}, clients(workspaceB)), /workspace_scope_mismatch/u);

await assert.rejects(() => prepareWorkspaceSemanticEvidenceBundleJob({
  definition: definitions[0]!, members: originalMembers, modelId, now,
  pack: { ...fixturePack, contentDigest: sha256("wrong-pack") }, scope: scope(workspaceA), workspaceGeneration: 1,
}, {
  jobs: memory,
  resolveProjection: async (reference) => resolveProjection(reference, workspaceA), state: memory,
}), /workspace_scope_mismatch/u);

const overflowEvidence = await pair(workspaceB, 1_000);
assert.equal(planEarningsCallSemanticComparison(overflowEvidence.evidence).state, "overflow");

console.log("earnings call changes sprint 3 verification passed");
