import assert from "node:assert/strict";

import rootAgent from "../agent/agent";
import {
  signHybridEvidenceWorkerEnvelope,
  verifyHybridEvidenceWorkerToken,
  type HybridEvidenceWorkerEnvelope,
} from "../agent/lib/hybrid-evidence-auth";
import {
  assertHybridModelRouteAllowed,
  HybridModelRoutingError,
  resolveHybridTaskModelRoute,
} from "../agent/lib/hybrid-evidence-model-routing";
import { createHybridEvidenceWorkerAgentConfig } from "../agent/lib/hybrid-evidence-worker-config";

const configuredEnvironment: NodeJS.ProcessEnv = {
  EVE_HYBRID_FAST_MODEL_ID: "google/gemini-3-flash",
  EVE_HYBRID_FAST_MODEL_REASONING: "low",
  EVE_HYBRID_FRONTIER_MODEL_ID: "openai/gpt-5.4",
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
};

assert.deepEqual(
  resolveHybridTaskModelRoute("deterministic_processing", {}),
  {
    executionClass: "no_model",
    modelId: null,
    purpose: "deterministic_processing",
    reasoning: null,
  },
);

const fast = resolveHybridTaskModelRoute(
  "extraction_recovery",
  configuredEnvironment,
);
assert.deepEqual(fast, {
  executionClass: "fast",
  modelId: "google/gemini-3-flash",
  purpose: "extraction_recovery",
  reasoning: "low",
});

const frontier = resolveHybridTaskModelRoute(
  "semantic_interpretation",
  configuredEnvironment,
);
assert.deepEqual(frontier, {
  executionClass: "frontier",
  modelId: "openai/gpt-5.4",
  purpose: "semantic_interpretation",
  reasoning: "high",
});

for (const environment of [
  {},
  { EVE_HYBRID_FAST_MODEL_ID: "google/gemini-3-flash" },
  {
    ...configuredEnvironment,
    EVE_HYBRID_FRONTIER_MODEL_REASONING: "medium",
  },
  {
    ...configuredEnvironment,
    EVE_HYBRID_FRONTIER_MODEL_ID: "google/gemini-3-flash",
  },
]) {
  assert.throws(
    () => resolveHybridTaskModelRoute("extraction_recovery", environment),
    (error) =>
      error instanceof HybridModelRoutingError &&
      error.code === "hybrid_model_routing_invalid",
  );
}

assert.doesNotThrow(() =>
  assertHybridModelRouteAllowed(fast, ["google/gemini-3-flash"]));
assert.throws(
  () => assertHybridModelRouteAllowed(frontier, ["google/gemini-3-flash"]),
  (error) =>
    error instanceof HybridModelRoutingError &&
    error.code === "hybrid_model_route_denied",
);

const authEnvironment: NodeJS.ProcessEnv = {
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 41).toString("base64url"),
};
const issuedAt = new Date("2026-08-17T12:00:00.000Z");
const envelope: HybridEvidenceWorkerEnvelope = {
  allowedLocators: [{
    artifactDigest: "a".repeat(64),
    end: 12,
    kind: "text_span",
    spanDigest: "b".repeat(64),
    start: 0,
  }],
  artifactDigests: ["a".repeat(64)],
  authVersion: 1,
  budget: {
    inputTokens: 2_000,
    outputTokens: 400,
    paidMicros: "50000",
    reservationKey: "hybrid.fixture.routing",
    scope: "deployment_source_recovery",
  },
  capabilityRevision: 1,
  definitionDigest: "c".repeat(64),
  definitionId: "hybrid-definition.routing-fixture",
  definitionVersion: "1.0.0",
  evidenceLimits: { maximumBytes: 4096, maximumPages: 0, maximumRows: 0 },
  expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
  inputDigest: "d".repeat(64),
  issuedAt: issuedAt.toISOString(),
  jobId: "hybrid-job.routing-fixture",
  modelId: fast.modelId,
  reasoning: fast.reasoning,
  schemaVersion: 1,
  scope: {
    initiatingWorkspaceId: "workspace_fixture",
    kind: "source_global",
    sourceInstanceId: "source_fixture",
  },
};
const token = signHybridEvidenceWorkerEnvelope(envelope, authEnvironment);
const verifiedEnvelope = verifyHybridEvidenceWorkerToken(
  token,
  { now: issuedAt },
  authEnvironment,
);
assert.equal(verifiedEnvelope.reasoning, "low");
assert.deepEqual(createHybridEvidenceWorkerAgentConfig(verifiedEnvelope), {
  description: "Execute one bounded public hybrid-evidence task with no conversational history.",
  limits: {
    maxInputTokensPerSession: 2_000,
    maxOutputTokensPerSession: 400,
    sessionTimeoutMs: 15 * 60_000,
  },
  model: "google/gemini-3-flash",
  reasoning: "low",
});
const frontierEnvelope = {
  ...envelope,
  jobId: "hybrid-job.frontier-routing-fixture",
  modelId: frontier.modelId,
  reasoning: frontier.reasoning,
};
const frontierToken = signHybridEvidenceWorkerEnvelope(
  frontierEnvelope,
  authEnvironment,
);
const verifiedFrontierEnvelope = verifyHybridEvidenceWorkerToken(
  frontierToken,
  { now: issuedAt },
  authEnvironment,
);
assert.equal(verifiedFrontierEnvelope.reasoning, "high");
assert.equal(
  createHybridEvidenceWorkerAgentConfig(verifiedFrontierEnvelope).model,
  "openai/gpt-5.4",
);
assert.throws(
  () => verifyHybridEvidenceWorkerToken(
    `${Buffer.from(JSON.stringify({ ...envelope, reasoning: "high" }), "utf8").toString("base64url")}.${token.split(".")[1]}`,
    { now: issuedAt },
    authEnvironment,
  ),
  /hybrid_evidence_auth_invalid/u,
);

assert.equal(rootAgent.model, "google/gemini-3.6-flash");
assert.equal(rootAgent.reasoning, "high");

console.log("adaptive model routing Sprint 1 verification passed");
