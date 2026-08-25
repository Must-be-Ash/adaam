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
import { DEFAULT_PAID_BUDGET } from "../agent/lib/strategy-pack-service";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  buildPublicCommentaryMultiSignalReport,
  buildPublicCommentarySignalReport,
} from "../agent/lib/public-commentary-signal-report";
import {
  createInverseCramerActionabilityDefinition,
  createInverseCramerSemanticDefinition,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
  INVERSE_CRAMER_ACTIONABILITY_DEFINITION_VERSIONS,
  INVERSE_CRAMER_SEMANTIC_DEFINITION_ID,
} from "../agent/lib/public-commentary-semantics";
import { declaredCommentaryContractVersion } from "../agent/lib/public-commentary-workspace-worker";
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
// The per-run envelope is floored so the fan-out has room even when a pack
// declares a smaller budget (see WORKSPACE_MINIMUM_*_TOKENS_PER_RUN).
assert.equal(budget.maximumInputTokensPerRun, 1_000_000);
assert.equal(budget.maximumPaidPerCall, "1.000000");
// The research lane declares $5.00/day; the workspace default is higher, and a
// monitor takes whichever leaves it more room to work.
assert.equal(budget.maximumPaidPerDay, DEFAULT_PAID_BUDGET.perDay);
assert.ok(Number(budget.maximumPaidPerDay) >= 5);

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
assert.equal(budget.maximumInputTokensPerRun, 1_000_000, "the per-run floor funds the fan-out even for a pack that declared a smaller envelope");

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
  "funded",
  "the per-run floor now funds the fan-out even for a pack that declared the superseded 40,000-token envelope",
);

// A scheduled occurrence no longer runs an outer LLM worker session; the
// scheduler invokes the evaluator deterministically and the only model spend is
// the nested semantic/research children fanned out one per evaluated statement.
// The occurrence envelope must still fund a realistic fan-out of those children.
{
  const statementsPerOccurrence = 8;
  assert.ok(
    compactDefinition.limits.maximumInputTokens * statementsPerOccurrence
      <= activeBudget.maximumInputTokensPerRun,
    "a realistic child fan-out must fit the occurrence input envelope",
  );
  assert.ok(
    compactDefinition.limits.maximumOutputTokens * statementsPerOccurrence
      <= activeBudget.maximumOutputTokensPerRun,
    "a realistic child fan-out must fit the occurrence output envelope",
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

// The inverse-cramer variant (default) discloses its registered inverse policy.
assert.equal(report.verdict?.label, "Inverse-policy research signal");
assert.match(report.eyebrow ?? "", /Inverse Cramer/u);
assert.match(report.disclosure ?? "", /inverse direction is a registered research policy/u);

// A plain public-commentary tracker has NO inverse policy: it must not inherit
// Inverse-Cramer branding (the bug that labeled a Kobeissi tracker artifact
// "Inverse-policy research signal" / "Eve · Inverse Cramer monitor").
const trackerReport = buildPublicCommentarySignalReport({
  asOf: activatedAt,
  brief,
  variant: "public-commentary-tracker",
});
assert.equal(trackerReport.verdict?.label, "Research signal");
assert.doesNotMatch(trackerReport.eyebrow ?? "", /Inverse Cramer/u);
assert.doesNotMatch(trackerReport.disclosure ?? "", /inverse direction/u);
assert.doesNotMatch(trackerReport.description ?? "", /Inverse Cramer/u);

/*
 * Two unrelated posts must NOT be fused into one thesis: each is its own labeled
 * section in a single report, with its own facts and interpretation preserved
 * verbatim. This is the newspaper the owner asked for - one artifact, one item
 * per signal, no fabricated cross-post correlation.
 */
const secondUrl = "https://x.com/jimcramer/status/456";
const secondBrief = workspaceExecutiveBriefSchema.parse({
  confidence: "medium",
  implications: ["Unrelated to the first signal; evaluated on its own footing."],
  interpretation: "A separate post about semiconductor demand, standing on its own.",
  materialFacts: [{ sourceUrls: [secondUrl], statement: "A distinct statement about chip demand." }],
  research: { status: "not_needed" },
  sources: [{ label: "Second statement", role: "official", url: secondUrl }],
  title: "Chip-demand signal",
  uncertainty: ["The second statement may not predict price action."],
});
const multi = buildPublicCommentaryMultiSignalReport({
  asOf: activatedAt,
  briefs: [brief, secondBrief],
  variant: "public-commentary-tracker",
});
assert.match(multi.title, /\+1 more/u, "a multi-signal report names the additional signals in its title");
const headings = multi.blocks.map((block) => block.heading ?? "");
assert.ok(headings.some((h) => /^Signal 1:/u.test(h)), "each post is its own labeled section");
assert.ok(headings.some((h) => /^Signal 2:/u.test(h)), "the second post has its own section too");
// Both interpretations survive verbatim - the signals are NOT merged into one.
const bodies = multi.blocks.map((block) => ("body" in block ? block.body : "")).join("\n");
assert.match(bodies, /immutable Inverse Cramer transform/u);
assert.match(bodies, /semiconductor demand, standing on its own/u);
assert.deepEqual(
  multi.sources.map(({ url }) => url).sort(),
  [statementUrl, secondUrl].sort(),
  "every signal's source is carried, deduped across sections",
);
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

/*
 * The market-view classification has no paid tool surface: no pages, no rows,
 * and no research lane in the worker contract registry. Version 1.0.0 still
 * reserved $0.25 per attempt from the occurrence's paid envelope, competing
 * with the timeline read for the same budget and starving the fan-out. 1.0.1
 * declares the truth, and is stricter rather than looser: reconciliation
 * refuses any actual paid cost above a reservation.
 */
assert.equal(
  createInverseCramerActionabilityDefinition(["openai/gpt-5.4"], {}, "1.0.0").limits.maximumPaidCostUsd,
  "0.2500",
);
assert.equal(
  createInverseCramerActionabilityDefinition(["openai/gpt-5.4"], {}, "1.0.1").limits.maximumPaidCostUsd,
  "0",
);
assert.equal(
  resolveHybridEvidenceWorkerContract(INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID)?.research,
  null,
  "a classification with a research lane would still need a real paid ceiling",
);
{
  const current = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.8" });
  assert.ok(current);
  assert.deepEqual(
    current.evidenceContracts?.find(({ id }) => id === INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID),
    {
      digest: createInverseCramerActionabilityDefinition(["openai/gpt-5.4"], {}, "1.0.1").definitionDigest,
      id: INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
      version: "1.0.1",
    },
  );
  assert.equal(
    declaredCommentaryContractVersion(current, INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
      INVERSE_CRAMER_ACTIONABILITY_DEFINITION_VERSIONS),
    "1.0.1",
  );
  const previous = strategyPackCatalog.resolve({ id: "inverse-cramer", version: "1.4.7" })!;
  assert.equal(
    declaredCommentaryContractVersion(previous, INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID,
      INVERSE_CRAMER_ACTIONABILITY_DEFINITION_VERSIONS),
    "1.0.0",
    "a published pack keeps the contract it shipped with",
  );
  assert.equal(
    previous.evidenceContracts?.find(({ id }) => id === INVERSE_CRAMER_ACTIONABILITY_DEFINITION_ID)?.digest,
    createInverseCramerActionabilityDefinition(["openai/gpt-5.4"], {}, "1.0.0").definitionDigest,
  );
}

console.log("Inverse Cramer strategy-boundary characterization passed.");

/*
 * Research is a declared capability, not an identity. It used to be gated by a
 * literal `managed.packId !== "inverse-cramer"`, so a pack could declare a
 * research contract and still be refused the lane - the declaration was not the
 * switch. Pack ids stay valid as provenance, registry keys and binding
 * identity; they must never decide what a strategy is allowed to do.
 */
{
  const { resolvePublicCommentaryResearchContract } = await import(
    "../agent/lib/public-commentary-research-contract"
  );
  const { INVERSE_CRAMER_RESEARCH_DEFINITION_ID, INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS } =
    await import("../agent/lib/inverse-cramer-research");
  const version = INVERSE_CRAMER_RESEARCH_DEFINITION_VERSIONS.at(-1)!;
  const declared = [{ id: INVERSE_CRAMER_RESEARCH_DEFINITION_ID, version }];

  assert.ok(
    resolvePublicCommentaryResearchContract({ evidenceContracts: declared }),
    "a pack that declares a registered research contract must resolve the lane",
  );
  assert.equal(
    resolvePublicCommentaryResearchContract({ evidenceContracts: [] }),
    null,
    "a pack that declares no research contract gets no lane - a deliberate choice",
  );
  assert.equal(
    resolvePublicCommentaryResearchContract({
      evidenceContracts: [{ id: INVERSE_CRAMER_RESEARCH_DEFINITION_ID, version: "0.0.0" }],
    }),
    null,
    "an unregistered contract version must not resolve",
  );

  const worker = readFileSync(
    new URL("../agent/lib/public-commentary-workspace-worker.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /packId\s*!==\s*"inverse-cramer"/u.test(worker),
    false,
    "the research lane must never be gated on a pack id again",
  );
}
console.info("Commentary research lane is declaration-driven.");
