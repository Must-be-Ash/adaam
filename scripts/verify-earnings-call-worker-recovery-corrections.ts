import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { assessEarningsCallSourceCorrection } from "../agent/lib/earnings-call-correction-policy";
import { runEarningsCallTranscriptLayoutRecovery } from "../agent/lib/earnings-call-hybrid-evidence-recovery";
import {
  persistEarningsCallFinding,
  readEarningsCallFindingByEventRevision,
  type EarningsCallFindingStoreClient,
} from "../agent/lib/earnings-call-finding-store";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "../agent/lib/hybrid-evidence-job-store";
import { verifyHybridEvidenceWorkerToken } from "../agent/lib/hybrid-evidence-auth";
import type { HybridEvidenceLineageStoreClient } from "../agent/lib/hybrid-evidence-lineage-store";
import { resolveHybridEvidenceFlags } from "../agent/lib/hybrid-evidence-flags";
import {
  digestEarningsCallValue,
  EARNINGS_CALL_SCHEMA_VERSION,
  earningsFindingSchema,
} from "../agent/lib/earnings-call-schema";
import { normalizeEarningsCallTranscript } from "../agent/lib/earnings-call-transcript";
import {
  completeHybridEvidenceJobForWorker,
  type PreparedHybridEvidenceWorkerRun,
} from "../agent/lib/hybrid-evidence-worker";
import {
  digestPublicSourceValue,
  publicSourceCorrectionSchema,
} from "../agent/lib/public-source-adapter-schema";
import {
  earningsCallWorkspaceWorkerOutputSchema,
  resolveEarningsCallAcceptedArtifactReferences,
} from "../agent/lib/earnings-call-workspace-worker";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import type { WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import type { WorkspaceGlobalBudgetClient } from "../agent/lib/workspace-dispatch-budget";

class MemoryCas implements HybridEvidenceArtifactIndexClient,
  HybridEvidenceJobStoreClient, HybridEvidenceLineageStoreClient,
  WorkspaceBudgetLedgerClient, WorkspaceGlobalBudgetClient,
  EarningsCallFindingStoreClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current !== undefined) return { created: false, value: current };
    this.values.set(key, value);
    return { created: true, value };
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) { this.values.set(key, Uint8Array.from(bytes)); }
}

const modelId = "openai/gpt-5.5";
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: "owner_fixture_recovery",
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 7).toString("base64url"),
  EVE_HYBRID_SOURCE_RECOVERY_CONCURRENT_WORKERS: "2",
  EVE_HYBRID_FAST_MODEL_ID: modelId,
  EVE_HYBRID_FAST_MODEL_REASONING: "low",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "100000",
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: modelId,
  EVE_HYBRID_SOURCE_RECOVERY_OUTPUT_TOKENS_PER_DAY: "20000",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_CALL: "1.00",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_DAY: "10.00",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_MONTH: "100.00",
} as const;
Object.assign(process.env, environment);
assert.equal(resolveHybridEvidenceFlags({}).extractionRecovery, false,
  "all-off flags must prevent earnings transcript recovery dispatch");

const acceptedArtifactReferences = resolveEarningsCallAcceptedArtifactReferences([
  {
    artifacts: [{ contentDigest: "a".repeat(64) }, { contentDigest: "b".repeat(64) }],
    evidence: { result: { resultId: "semantic-result.bundle" } },
  },
  {
    artifacts: [{ contentDigest: "a".repeat(64) }],
    evidence: { result: { resultId: "semantic-result.section" } },
  },
] as never);
assert.deepEqual(
  [...acceptedArtifactReferences.get("a".repeat(64)) ?? []],
  ["semantic-result.bundle", "semantic-result.section"],
  "cleanup must retain only the accepted results actually attached to an artifact",
);
assert.deepEqual(
  [...acceptedArtifactReferences.get("b".repeat(64)) ?? []],
  ["semantic-result.bundle"],
  "cleanup must not create cross-product accepted-result references",
);

const changedLayout = [
  "Microsoft FY2026 Q3 Earnings Conference Call Transcript",
  "CALL PARTICIPANTS",
  "Jordan Lee (Chief Executive Officer)",
  "Alex Kim (Analyst)",
  "PREPARED DISCUSSION",
  "Jordan Lee (Chief Executive Officer): We are confident in execution.",
  "ANALYST DIALOGUE",
  "Alex Kim (Analyst): What changed in the outlook?",
  "Jordan Lee (Chief Executive Officer): We expect 10% growth next quarter.",
].join("\n");
const changedBytes = Buffer.from(`<html><body>${changedLayout.replaceAll("\n", "<p>")}</body></html>`);
const changedDigest = createHash("sha256").update(changedBytes).digest("hex");
const deterministic = await normalizeEarningsCallTranscript({
  artifactBytes: changedBytes,
  artifactDigest: changedDigest,
  artifactMediaType: "text/html",
  eventRevisionId: "fact.earnings.changed.1",
  fiscalPeriod: "FY2026-Q3",
});
assert.equal(deterministic.state, "recovery_required");
if (deterministic.state !== "recovery_required") throw new Error("expected recovery_required");

const preparedStart = deterministic.sourceText.indexOf("PREPARED DISCUSSION");
const qaStart = deterministic.sourceText.indexOf("ANALYST DIALOGUE");
const executiveStart = deterministic.sourceText.indexOf("Jordan Lee", preparedStart);
const analystStart = deterministic.sourceText.indexOf("Alex Kim", qaStart);
const answerStart = deterministic.sourceText.indexOf("Jordan Lee", analystStart);
const candidate = {
  citations: [],
  disposition: "accepted" as const,
  fields: {
    qaPairs: [{ answerTurnIndexes: [2], questionTurnIndexes: [1] }],
    sections: [
      { end: qaStart, sectionKind: "prepared_remarks", start: preparedStart },
      { end: deterministic.sourceText.length, sectionKind: "questions_and_answers", start: qaStart },
    ],
    speakerTurns: [
      { end: qaStart, role: "executive", speakerName: "Jordan Lee", start: executiveStart },
      { end: answerStart, role: "analyst", speakerName: "Alex Kim", start: analystStart },
      { end: deterministic.sourceText.length, role: "executive", speakerName: "Jordan Lee", start: answerStart },
    ],
  },
  unknowns: [],
};

const memory = new MemoryCas();
const artifacts = createHybridEvidenceEphemeralArtifactStore({
  blob: new MemoryBlob(),
  index: memory,
  quota: {
    deploymentBytesPerDay: 8 * 1_024 * 1_024,
    deploymentCountPerDay: 20,
    sourceBytesPerDay: 8 * 1_024 * 1_024,
    sourceCountPerDay: 20,
  },
});
let dispatches = 0;
const complete = async (prepared: PreparedHybridEvidenceWorkerRun, value: typeof candidate) => {
  dispatches += 1;
  const envelope = verifyHybridEvidenceWorkerToken(prepared.token, {}, environment);
  assert.equal(envelope.modelId, modelId);
  assert.equal(envelope.reasoning, "low");
  await completeHybridEvidenceJobForWorker({
    candidate: value,
    ctx: { session: { auth: { current: prepared.request.auth } } },
    environment,
    jobClient: memory,
  });
  return { inputTokens: 100, outputTokens: 80, paidCostUsd: "0.01" };
};
const recoveryInput = {
  acquisitionId: "acquisition.earnings.recovery.1",
  artifactDigest: deterministic.artifactDigest,
  artifactMediaType: "text/html" as const,
  artifactUrl: "https://www.jpmorganchase.com/content/dam/example.html",
  clients: { artifacts, globalBudget: memory, jobs: memory, lineage: memory, workspaceBudget: memory },
  dispatch: ({ prepared }: { prepared: PreparedHybridEvidenceWorkerRun }) => complete(prepared, candidate),
  environment,
  eventRevisionId: "fact.earnings.changed.1",
  initiatingWorkspaceId: "123e4567-e89b-42d3-a456-426614174400",
  modelId,
  observedAt: "2026-08-17T20:00:00.000Z",
  sourceInstanceId: "source.earnings-call-transcripts.0000019617.fixture",
  sourceLogicalKey: "earnings-call:0000019617:FY2026-Q3:2026-07-14",
  sourceText: deterministic.sourceText,
};
const recovered = await runEarningsCallTranscriptLayoutRecovery(recoveryInput);
assert.equal(recovered.state, "accepted");
assert.equal(recovered.state === "accepted" ? recovered.transcript.qaPairs.length : 0, 1);
assert.equal(dispatches, 1, "recovery_required must dispatch the registered compiled worker path");
assert.equal((await runEarningsCallTranscriptLayoutRecovery(recoveryInput)).state, "accepted");
assert.equal(dispatches, 1, "accepted source-global recovery must replay without another model call");

const invalid = await runEarningsCallTranscriptLayoutRecovery({
  ...recoveryInput,
  acquisitionId: "acquisition.earnings.recovery.invalid",
  artifactDigest: "b".repeat(64),
  dispatch: ({ prepared }) => complete(prepared, {
    ...candidate,
    fields: { ...candidate.fields, sections: candidate.fields.sections.map((section, index) =>
      index === 0 ? { ...section, end: section.end + 1 } : section) },
  }),
  eventRevisionId: "fact.earnings.changed.invalid",
});
assert.deepEqual(invalid, { reason: "candidate_invalid", state: "unavailable" });

const budgetFailure = await runEarningsCallTranscriptLayoutRecovery({
  ...recoveryInput,
  acquisitionId: "acquisition.earnings.recovery.budget",
  artifactDigest: "c".repeat(64),
  environment: { ...environment, EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "0" },
  eventRevisionId: "fact.earnings.changed.budget",
});
assert.deepEqual(budgetFailure, { reason: "budget_unavailable", state: "unavailable" });

const citation = {
  artifactDigest: "a".repeat(64), end: 24, eventRevisionId: "event.current",
  sectionId: "section.current", spanDigest: "d".repeat(64), start: 1,
  transcriptId: "transcript.current",
};
const ownerId = "owner_fixture_recovery";
const monitorId = "223e4567-e89b-42d3-a456-426614174440";
const finding = (workspaceId: string, suffix: string, direction: "negative" | "positive") => {
  const core = {
    activationWatermark: "2026-08-16T00:00:00.000Z",
    analysisLineage: {
      budgetAttempt: 1, configurationRevision: 1, definitionDigest: "e".repeat(64),
      definitionId: "earnings-call-semantic-comparison", definitionVersion: "1.0.0",
      modelId, promptDigest: "f".repeat(64), validatorVersion: "1.0.0",
    },
    comparisonDigest: digestEarningsCallValue([suffix, direction]),
    comparisonId: `comparison.${suffix}`,
    confidence: "high" as const,
    counterevidence: [],
    facts: [{ citations: [citation], statement: "Management changed its outlook." }],
    findingId: `earnings-finding.${suffix}`,
    forecast: {
      catalysts: [], citations: [citation], direction, horizon: "next_quarter" as const,
      invalidationConditions: ["Execution diverges."], likelyMarketInterpretation: "The outlook changed.", risks: [],
      scenarios: [{ condition: "Execution continues.", direction, label: "base" as const, rationale: "Cited evidence." }],
    },
    inferences: [{ citations: [citation], statement: direction === "positive" ? "The view improved." : "The view weakened." }],
    materiality: {
      alertEligible: true, configuredThreshold: 65, decisionReasons: ["material_change" as const],
      deterministicScore: 80, policyVersion: "1.0.0",
    },
    monitorId, outcome: "accepted" as const, ownerId,
    pack: { contentDigest: "1".repeat(64), id: "earnings-call-changes" as const, version: "1.0.0" },
    recordType: "earnings_call_finding" as const,
    recommendation: {
      assumptions: ["Execution continues."], citations: [citation], conditionalImplication: "Investigate the change.",
      rationale: "Cited evidence.", stance: direction === "positive" ? "constructive" as const : "cautious" as const,
      valuationAssessment: "not_assessed" as const,
    },
    schemaVersion: EARNINGS_CALL_SCHEMA_VERSION, unknowns: [], workspaceId,
  };
  return earningsFindingSchema.parse({ ...core, findingDigest: digestEarningsCallValue(core) });
};
const correctionCore = {
  createdObservedAt: "2026-08-17T20:00:00.000Z",
  fromRevisionId: "fact.earnings.from",
  logicalKey: "earnings-call:0000019617:FY2026-Q3:2026-07-14",
  reason: "source_correction" as const,
  recordType: "public_source_fact_correction" as const,
  schemaVersion: 1 as const,
  toRevisionId: "fact.earnings.to",
};
const correction = publicSourceCorrectionSchema.parse({
  ...correctionCore,
  correctionId: `correction.${digestPublicSourceValue([
    correctionCore.logicalKey, correctionCore.fromRevisionId, correctionCore.toRevisionId, correctionCore.reason,
  ])}`,
});
const workspaceA = "123e4567-e89b-42d3-a456-426614174401";
const prior = finding(workspaceA, "prior", "positive");
const unchanged = assessEarningsCallSourceCorrection({ correction, current: prior, prior, priorAlerted: true });
assert.equal(unchanged.conclusionChanged, false);
assert.equal(unchanged.correctiveAlertEligible, false);
assert.equal(unchanged.finding.materiality.decisionReasons.includes("source_correction"), false);
const changedAlerted = assessEarningsCallSourceCorrection({
  correction, current: finding(workspaceA, "changed", "negative"), prior, priorAlerted: true,
});
assert.equal(changedAlerted.conclusionChanged, true);
assert.equal(changedAlerted.correctiveAlertEligible, true);
assert.equal(changedAlerted.finding.materiality.decisionReasons.includes("source_correction"), true);
const changedUnalerted = assessEarningsCallSourceCorrection({
  correction, current: finding(workspaceA, "changed", "negative"), prior, priorAlerted: false,
});
assert.equal(changedUnalerted.conclusionChanged, true);
assert.equal(changedUnalerted.correctiveAlertEligible, false);
assert.deepEqual(assessEarningsCallSourceCorrection({
  correction, current: finding(workspaceA, "changed", "negative"), prior, priorAlerted: true,
}), changedAlerted, "correction policy must be replay-idempotent");

const findingMemory = new MemoryCas();
const scopeA = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: workspaceA }, environment);
const scopeB = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId: "123e4567-e89b-42d3-a456-426614174402" }, environment);
const record = {
  cik: "0000019617", companyName: "JPMorgan Chase & Co.", createdAt: "2026-08-17T20:00:00.000Z", finding: prior,
  recordType: "earnings_call_finding_record" as const, schemaVersion: 1 as const,
  sources: [
    { canonicalUrl: "https://www.jpmorganchase.com/current", eventRevisionId: correction.fromRevisionId, fiscalPeriod: "FY2026-Q3", role: "current" as const },
    { canonicalUrl: "https://www.jpmorganchase.com/prior", eventRevisionId: "fact.earnings.prior", fiscalPeriod: "FY2026-Q2", role: "prior" as const },
  ],
  ticker: "JPM",
};
await persistEarningsCallFinding({ record, scope: scopeA }, findingMemory);
assert.equal((await readEarningsCallFindingByEventRevision(scopeA, correction.fromRevisionId, findingMemory))?.finding.findingId, prior.findingId);
await persistEarningsCallFinding({
  record: {
    ...record,
    createdAt: "2026-08-17T20:01:00.000Z",
    finding: changedAlerted.finding,
    sourceCorrection: changedAlerted.lineage,
    sources: record.sources.map((source) => source.role === "current"
      ? { ...source, eventRevisionId: correction.toRevisionId }
      : source),
  },
  scope: scopeA,
}, findingMemory);
assert.equal((await readEarningsCallFindingByEventRevision(
  scopeA, correction.toRevisionId, findingMemory,
))?.sourceCorrection?.correctionId, correction.correctionId,
"exact source-correction lineage must persist with the new workspace interpretation");
assert.equal(await readEarningsCallFindingByEventRevision(scopeB, correction.fromRevisionId, findingMemory), null,
  "source-correction lookup must remain workspace isolated");

assert.equal(earningsCallWorkspaceWorkerOutputSchema.parse({
  evaluatedIssuers: 1, materialFindings: 0, outcome: "no_match", replayed: true,
  runId: "fixture:attempt:1",
}).evaluatedIssuers, 1, "no-match replay must satisfy the compiled tool schema");

console.info("Earnings-call worker recovery and correction verification passed.");
