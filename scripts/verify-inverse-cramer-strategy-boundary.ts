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
