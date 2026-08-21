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
  createInverseCramerSemanticDefinition,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
} from "../agent/lib/public-commentary-semantics";
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

const pack = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.1" });
assert.ok(pack);
assert.equal(
  pack.monitors[0]?.lifecycleContractId,
  PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
);
const researchDefinition = createInverseCramerResearchDefinition(["openai/gpt-5.4"]);
const semanticDefinition = createInverseCramerSemanticDefinition(["openai/gpt-5.4"]);
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
assert.equal(budget.maximumInputTokensPerRun, 25_000);
assert.equal(budget.maximumPaidPerCall, "1.000000");
assert.equal(budget.maximumPaidPerDay, "5.000000");

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
