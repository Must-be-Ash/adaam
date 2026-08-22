import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveStrategyPackInitialBudgetPolicy,
  resolveStrategyPackInitialMonitorDueAt,
} from "../agent/lib/strategy-pack-service";
import {
  materializeInverseCramerExecutiveOutput,
  resolvePublicCommentaryFirstRunStart,
} from "../agent/lib/public-commentary-workspace-worker";
import {
  resolveWorkspaceWorkerEvaluationWindow,
} from "../agent/lib/workspace-worker-runner";
import {
  PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
} from "../agent/lib/workspace-monitor-lifecycle-contract";
import {
  createInverseCramerResearchDefinition,
  INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
  isInverseCramerAgenticResearchPack,
} from "../agent/lib/inverse-cramer-research";
import { resolveHybridEvidenceWorkerContract } from "../agent/lib/hybrid-evidence-worker-contract-registry";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { buildPublicCommentarySignalReport } from "../agent/lib/public-commentary-signal-report";
import {
  createInverseCramerActionabilityDefinition,
  createInverseCramerSemanticDefinition,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
} from "../agent/lib/public-commentary-semantics";
import { PUBLIC_COMMENTARY_OCCURRENCE_LIMITS } from "../agent/lib/public-commentary-vertical";
import {
  reserveWorkspaceRunBudget,
  type WorkspaceBudgetLedgerClient,
} from "../agent/lib/workspace-budget-ledger";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryCas implements WorkspaceBudgetLedgerClient {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}
import { workspaceExecutiveBriefSchema } from "../agent/lib/workspace-executive-brief";

const activatedAt = "2026-08-20T12:00:00.000Z";
const scheduledAt = "2026-08-21T00:00:00.000Z";

assert.equal(resolveStrategyPackInitialMonitorDueAt({
  activate: true,
  lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
  now: new Date(activatedAt),
  scheduledAt,
}), activatedAt);

assert.deepEqual(resolveWorkspaceWorkerEvaluationWindow({
  monitor: {
    createdAt: activatedAt,
    lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    managedBy: { packId: "fixture-commentary", packVersion: "1.0.0" },
    schedule: { anchor: activatedAt, everyMinutes: 720, kind: "interval" },
    sourceCheckpoint: { contentDigest: null, watermark: null },
  },
  occurrence: { scheduledFor: activatedAt },
} as never), {
  endAt: activatedAt,
  startAt: "2026-08-20T00:00:00.000Z",
});

assert.equal(resolvePublicCommentaryFirstRunStart({
  activationWatermark: activatedAt,
  cadence: "hours_12",
  initialBaseline: true,
  pack: {
    id: "fixture-commentary",
    lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
    version: "1.0.0",
  },
  windowEndAt: activatedAt,
}), "2026-08-20T00:00:00.000Z");

const pack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.4" });
assert.ok(pack);
assert.equal(
  pack.monitors[0]?.lifecycleContractId,
  PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
);
const researchDefinition = createInverseCramerResearchDefinition(["openai/gpt-5.4"]);
const semanticDefinition = createInverseCramerSemanticDefinition(["openai/gpt-5.4"], {
  definitionVersion: "1.0.3",
});
assert.equal(
  pack.evidenceContracts?.find(({ id }) => id === INVERSE_CRAMER_SEMANTIC_DEFINITION_ID)?.digest,
  semanticDefinition.definitionDigest,
);
assert.equal(
  pack.evidenceContracts?.find(({ id }) => id === INVERSE_CRAMER_RESEARCH_DEFINITION_ID)?.digest,
  researchDefinition.definitionDigest,
);
// The research child reads the signed finding, may take one bounded supplementary
// pass, and must still emit a complete executive brief through its completion
// tool. Version 1.0.0 sized that whole session at 2,000 cumulative output tokens,
// which Production exhausted with SESSION_TOKEN_LIMIT_REACHED before the brief
// could commit. Historical packs keep the original contract.
assert.equal(researchDefinition.definitionVersion, "1.0.0");
assert.equal(researchDefinition.limits.maximumOutputTokens, 2_000);
const activeResearchDefinition = createInverseCramerResearchDefinition(["openai/gpt-5.4"], "1.0.1");
assert.equal(activeResearchDefinition.limits.maximumInputTokens, 40_000);
assert.equal(activeResearchDefinition.limits.maximumOutputTokens, 12_000);
assert.equal(
  activeResearchDefinition.limits.maximumPaidCostUsd,
  researchDefinition.limits.maximumPaidCostUsd,
  "resizing the research session must not raise its paid ceiling",
);
{
  const researchPack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.7" });
  assert.ok(researchPack);
  assert.deepEqual(
    researchPack.evidenceContracts?.find(({ id }) => id === INVERSE_CRAMER_RESEARCH_DEFINITION_ID),
    {
      digest: activeResearchDefinition.definitionDigest,
      id: INVERSE_CRAMER_RESEARCH_DEFINITION_ID,
      version: "1.0.1",
    },
  );
  // Resizing the research session to 1.0.1 must not silently disable the
  // executive-brief runtime. Every pack that declares a supported research
  // contract version still selects it.
  assert.equal(isInverseCramerAgenticResearchPack(researchPack), true);
  for (const version of ["1.4.4", "1.4.5", "1.4.6"]) {
    const historical = strategyPackCatalog.resolve({ id: "inverse-cramer", version });
    assert.ok(historical);
    assert.equal(isInverseCramerAgenticResearchPack(historical), true);
  }
  const preResearchPack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.3.0" });
  assert.ok(preResearchPack);
  assert.equal(isInverseCramerAgenticResearchPack(preResearchPack), false);
}
assert.equal(resolveHybridEvidenceWorkerContract(INVERSE_CRAMER_RESEARCH_DEFINITION_ID)?.research
  ?.requiresParentRunId, true);
assert.equal(resolveHybridEvidenceWorkerContract(INVERSE_CRAMER_RESEARCH_DEFINITION_ID)?.research
  ?.budget.paidPerRun, "3.500000");
const budget = resolveStrategyPackInitialBudgetPolicy(pack, { timezone: "UTC" }, activatedAt);
assert.equal(budget.maximumInputTokensPerRun, 40_000);
assert.equal(budget.maximumPaidPerCall, "1.000000");
assert.equal(budget.maximumPaidPerDay, "5.000000");

// An occurrence reserves its whole per-run allowance as the parent envelope and
// every nested compact semantic child draws from it, so the active envelope must
// fund the declared semantic fan-out over the statements in one cadence window.
const compactDefinition = createInverseCramerActionabilityDefinition(["openai/gpt-5.4"]);
const activePack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.6" });
assert.ok(activePack);
const activeBudget = resolveStrategyPackInitialBudgetPolicy(activePack, { timezone: "UTC" }, activatedAt);
const fanOut = PUBLIC_COMMENTARY_OCCURRENCE_LIMITS.semanticConcurrency;
assert.ok(
  compactDefinition.limits.maximumInputTokens * fanOut <= activeBudget.maximumInputTokensPerRun,
  "the occurrence envelope must fund the declared concurrent semantic children",
);
assert.ok(
  compactDefinition.limits.maximumOutputTokens * fanOut <= activeBudget.maximumOutputTokensPerRun,
);
// A run whose reservation exceeds the daily allowance could never dispatch.
assert.ok(activeBudget.maximumInputTokensPerRun <= activeBudget.maximumInputTokensPerDay);
assert.ok(activeBudget.maximumOutputTokensPerRun <= activeBudget.maximumOutputTokensPerDay);
assert.equal(budget.maximumInputTokensPerRun, 40_000, "historical packs keep their declared envelope");

// Exact Production reproduction: two projected statements evaluated at the
// declared concurrency each reserve the compact ceiling from the same parent.
async function fanOutReservationOutcome(policy: typeof activeBudget) {
  const ledger = new MemoryCas();
  const scope = authorizeDeploymentWorkspaceStore(
    { ownerId: "owner_fixture", workspaceId: "44444444-4444-4444-8444-444444444444" },
    { EVE_DEPLOYMENT_OWNER_ID: "owner_fixture" },
  );
  const now = new Date(activatedAt);
  const occurrence = {
    inputTokens: policy.maximumInputTokensPerRun,
    now,
    outputTokens: policy.maximumOutputTokensPerRun,
    paidCostCeiling: { amount: "3.500000", kind: "known" as const },
    policy,
    policyRevision: 1,
    runId: "occurrence.fan-out",
    scope,
  };
  await reserveWorkspaceRunBudget(occurrence, ledger);
  const child = (index: number) => ({
    inputTokens: compactDefinition.limits.maximumInputTokens,
    kind: "hybrid_model_attempt" as const,
    now,
    outputTokens: compactDefinition.limits.maximumOutputTokens,
    paidCostCeiling: { amount: compactDefinition.limits.maximumPaidCostUsd, kind: "known" as const },
    parentRunId: occurrence.runId,
    policy,
    policyRevision: 1,
    runId: `occurrence.fan-out.statement-${index}`,
    scope,
  });
  try {
    for (let index = 0; index < fanOut; index += 1) {
      await reserveWorkspaceRunBudget(child(index), ledger);
    }
    return "funded" as const;
  } catch (error) {
    return error instanceof Error ? error.message : "unknown";
  }
}
assert.equal(
  await fanOutReservationOutcome(activeBudget),
  "funded",
  "1.4.6 must fund every concurrent semantic child from one occurrence envelope",
);
assert.equal(
  await fanOutReservationOutcome(budget),
  "budget_exhausted",
  "the superseded 40,000-token envelope funded only one child, which is the reported defect",
);

// The outer workspace worker adds one turn per evaluated statement and must
// still have room to call its commit tool. A session too small to finish
// terminalized occurrences as `worker_outcome_missing` with no error at all, so
// its declared limits must fit inside the occurrence envelope alongside the
// nested children a realistic cadence window produces.
{
  const workerAgentSource = readFileSync(
    new URL("../agent/subagents/workspace-worker/agent.ts", import.meta.url),
    "utf8",
  );
  const sessionInput = Number(
    /maxInputTokensPerSession:\s*([\d_]+)/u.exec(workerAgentSource)?.[1]?.replaceAll("_", ""),
  );
  const sessionOutput = Number(
    /maxOutputTokensPerSession:\s*([\d_]+)/u.exec(workerAgentSource)?.[1]?.replaceAll("_", ""),
  );
  assert.ok(Number.isSafeInteger(sessionInput) && Number.isSafeInteger(sessionOutput));
  const statementsPerOccurrence = 8;
  // Reviewed values. Production terminalized a five-statement occurrence as
  // `worker_outcome_missing` with no error at 32,000/8,000, because the session
  // adds a turn per statement under high reasoning and could exhaust itself
  // before its commit tool ran.
  assert.equal(sessionInput, 64_000);
  assert.equal(sessionOutput, 16_000);
  assert.ok(
    sessionInput + compactDefinition.limits.maximumInputTokens * statementsPerOccurrence
      <= activeBudget.maximumInputTokensPerRun,
    "the worker session plus a realistic fan-out must fit the occurrence input envelope",
  );
  assert.ok(
    sessionOutput + compactDefinition.limits.maximumOutputTokens * statementsPerOccurrence
      <= activeBudget.maximumOutputTokensPerRun,
    "the worker session plus a realistic fan-out must fit the occurrence output envelope",
  );
}

const statementUrl = "https://x.com/jimcramer/status/123";
const brief = workspaceExecutiveBriefSchema.parse({
  confidence: "medium",
  implications: ["The registered inverse policy points to bearish pressure; this remains research, not a trade."],
  interpretation: "Cramer expressed a bullish view, and the immutable Inverse Cramer transform maps it to bearish research direction.",
  materialFacts: [{ sourceUrls: [statementUrl], statement: "Jim Cramer expressed a bullish view on the cited asset." }],
  research: { status: "not_needed" },
  sources: [{ label: "Jim Cramer statement", role: "official", url: statementUrl }],
  title: "Inverse Cramer research signal",
  uncertainty: ["The statement may not predict subsequent price action."],
});
const report = buildPublicCommentarySignalReport({ asOf: activatedAt, brief });
assert.equal(report.blocks[0]?.type, "callout");
assert.deepEqual(report.sources.map(({ url }) => url), [statementUrl]);
let publishCalls = 0;
const textOnly = await materializeInverseCramerExecutiveOutput({
  approvedSupplementaryUrls: [],
  asOf: activatedAt,
  brief,
  clients: {
    publishReport: async () => {
      publishCalls += 1;
      throw new Error("single_source_report_now_must_not_publish");
    },
  },
  factIdentities: ["finding.fixture"],
  officialUrls: [statementUrl],
  scope: { ownerId: "owner_fixture", workspaceId: "11111111-1111-4111-8111-111111111111" } as never,
});
assert.equal(publishCalls, 0);
assert.deepEqual(textOnly.artifactRefs, []);
assert.match(textOnly.presentation.whyMatched, /immutable Inverse Cramer transform/iu);

// A completed supplementary research pass must publish a readable artifact and
// still deliver a concise Photon alert that cites the statement. Only the
// no-research single-source path stays text-only.
const supplementaryUrl = "https://example.com/micron-hbm-coverage";
const researchedBrief = workspaceExecutiveBriefSchema.parse({
  ...brief,
  research: { status: "completed" },
  sources: [
    { label: "Jim Cramer statement", role: "official", url: statementUrl },
    { label: "Supplementary coverage", role: "supplementary", url: supplementaryUrl },
  ],
});
const publishedArtifacts: string[] = [];
const researched = await materializeInverseCramerExecutiveOutput({
  approvedSupplementaryUrls: [supplementaryUrl],
  asOf: activatedAt,
  brief: researchedBrief,
  clients: {
    publishReport: async ({ artifactId }) => {
      publishedArtifacts.push(artifactId);
      return { artifactId, kind: "report" as const };
    },
  },
  factIdentities: ["finding.fixture"],
  officialUrls: [statementUrl],
  scope: { ownerId: "owner_fixture", workspaceId: "11111111-1111-4111-8111-111111111111" } as never,
});
assert.equal(publishedArtifacts.length, 1, "a completed research pass must publish one readable artifact");
assert.equal(researched.artifactRefs.length, 1, "the alert must reference the published artifact");
assert.ok(
  researched.presentation.whyMatched.length <= 1_000,
  "the Photon alert stays an executive summary rather than the full brief",
);
assert.match(researched.presentation.title, /Inverse Cramer/iu);
// A supplementary source the research grant never approved must be refused.
await assert.rejects(materializeInverseCramerExecutiveOutput({
  approvedSupplementaryUrls: [],
  asOf: activatedAt,
  brief: researchedBrief,
  clients: { publishReport: async () => { throw new Error("ungranted_source_must_not_publish"); } },
  factIdentities: ["finding.fixture"],
  officialUrls: [statementUrl],
  scope: { ownerId: "owner_fixture", workspaceId: "11111111-1111-4111-8111-111111111111" } as never,
}), /public_commentary_strategy_invalid/u);

for (const path of [
  "agent/lib/strategy-pack-service.ts",
  "agent/lib/workspace-monitor-store.ts",
  "agent/lib/workspace-worker-runner.ts",
]) {
  assert.doesNotMatch(
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
    /inverse-cramer/u,
    `${path} must select lifecycle behavior from a declared contract, not the strategy name`,
  );
}

console.log("Inverse Cramer strategy-boundary characterization passed.");
