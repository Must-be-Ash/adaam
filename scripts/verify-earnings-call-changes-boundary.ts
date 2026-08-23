import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { researchReportSchema } from "../agent/lib/artifact-schema";

import { admitsReviewedEarningsCallTranscriptSources } from "../agent/lib/earnings-call-issuer-catalog";
import { buildEarningsCallSignalReport } from "../agent/lib/earnings-call-signal-report";
import { materializeEarningsCallExecutiveOutput } from "../agent/lib/earnings-call-workspace-worker";
import { workspaceExecutiveBriefSchema } from "../agent/lib/workspace-executive-brief";
import {
  EARNINGS_CALL_RESEARCH_DEFINITION_ID,
  EARNINGS_CALL_RESEARCH_DEFINITION_VERSIONS,
  earningsCallResearchEvidenceContent,
  earningsCallResearchValidationContract,
  isEarningsCallAgenticResearchPack,
} from "../agent/lib/earnings-call-research";
import { EARNINGS_CALL_POLICY } from "../agent/lib/earnings-call-policy";
import {
  createEarningsCallComparisonDefinitions,
  earningsCallComparisonPlannerLimits,
  earningsCallComparisonSessionOptions,
  EARNINGS_CALL_EXTENDED_SESSION_INPUT_TOKENS,
} from "../agent/lib/hybrid-evidence-definition-registry";
import { resolveStrategyPackResearchWorkerContract } from "../agent/lib/hybrid-evidence-worker-contract-registry";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import {
  resolveStrategyPackConfiguration,
  resolveStrategyPackSourceInstances,
} from "../agent/lib/strategy-pack-service";
import {
  EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
  PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
  resolveManagedMonitorLifecycleContract,
} from "../agent/lib/workspace-monitor-lifecycle-contract";
import { requiresManagedMonitorActivationWatermark } from "../agent/lib/workspace-monitor-store";

const EARNINGS_MONITOR_RESOURCE_ID = "compare-earnings-calls";
const PUBLISHED_VERSIONS = ["1.0.0", "1.0.1"] as const;   // predate the lifecycle contract
const CONTRACT_DECLARING_VERSIONS = ["1.1.0", "1.2.0"] as const;
const CURRENT_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Strategy ownership: issuer discovery and source-family selection stay in the
// pack and its reviewed catalog. Shared plumbing never re-derives them.
// ---------------------------------------------------------------------------

const currentPack = strategyPackCatalog.resolve({
  id: "earnings-call-changes",
  version: CURRENT_VERSION,
});
assert.ok(currentPack, `earnings-call-changes@${CURRENT_VERSION} must be published`);
assert.equal(currentPack.capabilities.required.includes("evaluate_earnings_call_changes"), true);
assert.equal(currentPack.capabilities.hardDenied.includes("web.search"), true);

const configured = resolveStrategyPackConfiguration(currentPack, {});
assert.deepEqual(configured.configuration.selectedIssuerCiks, ["0000789019"]);
assert.equal(configured.configuration.materialityThreshold, "threshold_65");

// Only an issuer whose reviewed source family declares a supported discovery
// policy resolves into a runnable monitor source. The default MSFT selection
// deliberately resolves to none, which is why an earnings monitor must be
// installable with no sources at all.
assert.deepEqual(
  resolveStrategyPackSourceInstances(currentPack, configured.configuration).map(
    ({ sourceId }) => sourceId,
  ),
  [],
);
assert.deepEqual(
  resolveStrategyPackSourceInstances(currentPack, {
    ...configured.configuration,
    selectedIssuerCiks: ["0000019617"],
  }).map(({ sourceId }) => sourceId),
  ["earnings-call-transcripts.0000019617"],
);

// The transcript comparison envelope is strategy-owned and unchanged by this
// migration: shared plumbing selects when the comparison runs, never how.
assert.equal(EARNINGS_CALL_POLICY.policyId, "earnings-call-changes");
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumSingleJobInputTokens, 12_000);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.overflowOutcome, "abstained");

// ---------------------------------------------------------------------------
// Monitor lifecycle: every generic decision resolves from the declared
// contract, not from the pack id.
// ---------------------------------------------------------------------------

for (const version of CONTRACT_DECLARING_VERSIONS) {
  const entry = strategyPackCatalog.resolve({ id: "earnings-call-changes", version })!;
  assert.equal(
    entry.monitors.find(({ resourceId }) => resourceId === EARNINGS_MONITOR_RESOURCE_ID)
      ?.lifecycleContractId,
    EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
  );
}

const earnings = resolveManagedMonitorLifecycleContract({
  lifecycleContractId: EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
});
assert.ok(earnings);
assert.deepEqual(
  {
    activationWatermark: earnings.activationWatermark,
    deferredSourceRetry: earnings.deferredSourceRetry,
    initialEvaluationWindow: earnings.initialEvaluationWindow,
    initialOccurrence: earnings.initialOccurrence,
    sourceAdmission: earnings.sourceAdmission,
    sourcelessInstall: earnings.sourcelessInstall,
  },
  {
    activationWatermark: "on_enable",
    deferredSourceRetry: "occurrence_scoped",
    initialEvaluationWindow: "created_at",
    initialOccurrence: "scheduled",
    sourceAdmission: "reviewed_transcript_coverage",
    sourcelessInstall: "allowed",
  },
);

// Published versions cannot declare the contract - their content digest is
// immutable - so their exact bindings reproduce the behavior they shipped with.
for (const version of PUBLISHED_VERSIONS) {
  const historical = strategyPackCatalog.resolve({ id: "earnings-call-changes", version });
  assert.ok(historical);
  assert.equal(
    historical.monitors.find(({ resourceId }) => resourceId === EARNINGS_MONITOR_RESOURCE_ID)
      ?.lifecycleContractId,
    undefined,
  );
  assert.equal(
    resolveManagedMonitorLifecycleContract({
      managedBy: {
        packId: "earnings-call-changes",
        packVersion: version,
        resourceId: EARNINGS_MONITOR_RESOURCE_ID,
      },
    })?.id,
    EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
  );
}

// Every published earnings version must resolve a lifecycle contract: an
// unresolved binding would silently drop the activation watermark and the
// reviewed-source admission rule on a live monitor rather than degrade it.
for (const entry of strategyPackCatalog.entries) {
  if (entry.id !== "earnings-call-changes") continue;
  for (const monitor of entry.monitors) {
    assert.equal(
      resolveManagedMonitorLifecycleContract({
        lifecycleContractId: monitor.lifecycleContractId,
        managedBy: {
          packId: entry.id,
          packVersion: entry.version,
          resourceId: monitor.resourceId,
        },
      })?.id,
      EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
      `${entry.id}@${entry.version}/${monitor.resourceId} must resolve a lifecycle contract`,
    );
  }
}

// Resolution reads the declaration, not the identity: an unrelated pack id that
// declares the earnings lifecycle contract gets earnings lifecycle behavior,
// and an earnings-shaped pack id that declares nothing gets none.
assert.equal(
  resolveManagedMonitorLifecycleContract({
    lifecycleContractId: EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
    managedBy: {
      packId: "some-other-transcript-strategy",
      packVersion: "9.9.9",
      resourceId: "compare-transcripts",
    },
  })?.sourcelessInstall,
  "allowed",
);
assert.equal(
  resolveManagedMonitorLifecycleContract({
    managedBy: {
      packId: "earnings-call-changes",
      packVersion: "9.9.9",
      resourceId: EARNINGS_MONITOR_RESOURCE_ID,
    },
  }),
  null,
);

// The activation watermark is now one declaration, shared with commentary.
assert.equal(
  requiresManagedMonitorActivationWatermark({
    lifecycleContractId: EARNINGS_CALL_TRANSCRIPT_MONITOR_LIFECYCLE_CONTRACT_ID,
  }),
  true,
);
assert.equal(
  requiresManagedMonitorActivationWatermark({
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: "0".repeat(64),
      packId: "earnings-call-changes",
      packVersion: "1.0.1",
      resourceId: EARNINGS_MONITOR_RESOURCE_ID,
    },
  }),
  true,
);
assert.equal(
  requiresManagedMonitorActivationWatermark({
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: "0".repeat(64),
      packId: "earnings-call-changes",
      packVersion: "9.9.9",
      resourceId: EARNINGS_MONITOR_RESOURCE_ID,
    },
  }),
  false,
);

// ---------------------------------------------------------------------------
// Reviewed-source admission: the predicate is strategy-owned, the decision to
// apply it is a contract declaration.
// ---------------------------------------------------------------------------

const reviewed = [{ sourceId: "earnings-call-transcripts.0000019617" }];
const unreviewed = [{ sourceId: "earnings-call-transcripts.0001341439" }];
assert.equal(admitsReviewedEarningsCallTranscriptSources(reviewed), true);
assert.equal(admitsReviewedEarningsCallTranscriptSources(unreviewed), false);
assert.equal(admitsReviewedEarningsCallTranscriptSources([]), false);
assert.equal(earnings.admitsActivationSources(reviewed), true);
assert.equal(earnings.admitsActivationSources(unreviewed), false);

// A commentary monitor keeps open admission: the contract, not an exception for
// earnings, decides that the reviewed-coverage rule does not apply to it.
const commentary = resolveManagedMonitorLifecycleContract({
  lifecycleContractId: PUBLIC_COMMENTARY_CADENCE_MONITOR_LIFECYCLE_CONTRACT_ID,
});
assert.ok(commentary);
assert.equal(commentary.sourceAdmission, "any_declared_source");
assert.equal(commentary.sourcelessInstall, "forbidden");
assert.equal(commentary.deferredSourceRetry, "none");
assert.equal(commentary.admitsActivationSources(unreviewed), true);

// ---------------------------------------------------------------------------
// Research and worker contracts.
// ---------------------------------------------------------------------------

assert.deepEqual(
  currentPack.evidenceContracts?.filter(({ id }) => id === EARNINGS_CALL_RESEARCH_DEFINITION_ID)
    .map(({ id, version }) => `${id}@${version}`),
  [`${EARNINGS_CALL_RESEARCH_DEFINITION_ID}@${EARNINGS_CALL_RESEARCH_DEFINITION_VERSIONS[0]}`],
);
assert.equal(isEarningsCallAgenticResearchPack(currentPack), true);
for (const version of PUBLISHED_VERSIONS) {
  const historical = strategyPackCatalog.resolve({ id: "earnings-call-changes", version });
  assert.ok(historical);
  assert.equal(isEarningsCallAgenticResearchPack(historical), false);
  assert.equal(resolveStrategyPackResearchWorkerContract(historical), null);
}
const workerContract = resolveStrategyPackResearchWorkerContract(currentPack);
assert.ok(workerContract);
assert.equal(workerContract.definitionId, EARNINGS_CALL_RESEARCH_DEFINITION_ID);
assert.equal(workerContract.research?.requiresParentRunId, true);
assert.equal(workerContract.research?.approvedUrlPolicy, "evidence_sources");
assert.deepEqual(workerContract.capabilityRevisions, [2]);

// The comparison definitions stay on the generic completion boundary: this
// migration adds the research lane and does not restate the reviewed
// comparison output contract in the worker registry.
assert.equal(
  isEarningsCallAgenticResearchPack({
    evidenceContracts: [{
      id: EARNINGS_CALL_RESEARCH_DEFINITION_ID,
      version: EARNINGS_CALL_RESEARCH_DEFINITION_VERSIONS[0],
    }],
    id: "some-other-transcript-strategy",
    version: "9.9.9",
  }),
  false,
);

// ---------------------------------------------------------------------------
// Per-run envelope: one occurrence runs the shared worker session plus bounded
// comparison and research children, so the reservation must at least cover the
// session's own declared limits.
// ---------------------------------------------------------------------------

const monitor = currentPack.monitors.find(
  ({ resourceId }) => resourceId === EARNINGS_MONITOR_RESOURCE_ID,
)!;
const workerAgent = readFileSync(
  new URL("../agent/subagents/workspace-worker/agent.ts", import.meta.url),
  "utf8",
);
const declaredSessionInput = Number(
  /maxInputTokensPerSession:\s*([\d_]+)/u.exec(workerAgent)?.[1]?.replaceAll("_", "") ?? "0",
);
const declaredSessionOutput = Number(
  /maxOutputTokensPerSession:\s*([\d_]+)/u.exec(workerAgent)?.[1]?.replaceAll("_", "") ?? "0",
);
assert.ok(declaredSessionInput > 0 && declaredSessionOutput > 0);
assert.ok(monitor.suggestedBudget.maximumInputTokensPerRun >= declaredSessionInput);
assert.ok(monitor.suggestedBudget.maximumOutputTokensPerRun >= declaredSessionOutput);
for (const version of PUBLISHED_VERSIONS) {
  const historical = strategyPackCatalog.resolve({ id: "earnings-call-changes", version })!;
  const published = historical.monitors.find(
    ({ resourceId }) => resourceId === EARNINGS_MONITOR_RESOURCE_ID,
  )!;
  assert.ok(
    published.suggestedBudget.maximumInputTokensPerRun < declaredSessionInput,
    `${version} is the sizing defect the migrated versions repair`,
  );
}

// ---------------------------------------------------------------------------
// The comparison session is version-scoped. A real reviewed transcript pair
// measures ~50,000 estimated input tokens, far above the frozen policy
// envelope, so every version that signs the envelope's 24,000 overflows the
// planner and abstains without analyzing anything. Only the current version
// signs a session large enough to hold a real pair in one job - and raising it
// must not disturb what published versions declared.
// ---------------------------------------------------------------------------

assert.equal(
  earningsCallComparisonSessionOptions(CURRENT_VERSION).maximumSessionInputTokens,
  EARNINGS_CALL_EXTENDED_SESSION_INPUT_TOKENS,
);
assert.equal(
  earningsCallComparisonPlannerLimits(CURRENT_VERSION).maximumSingleJobInputTokens,
  EARNINGS_CALL_EXTENDED_SESSION_INPUT_TOKENS,
);
for (const version of ["1.0.1", "1.1.0"]) {
  assert.equal(
    earningsCallComparisonSessionOptions(version).maximumSessionInputTokens,
    EARNINGS_CALL_POLICY.semanticEnvelope.maximumAggregateInputTokens,
    `${version} must keep the comparison session it shipped with`,
  );
  assert.equal(
    earningsCallComparisonPlannerLimits(version).maximumSingleJobInputTokens,
    EARNINGS_CALL_POLICY.semanticEnvelope.maximumSingleJobInputTokens,
    `${version} must keep the planner limits it shipped with`,
  );
}
assert.equal(earningsCallComparisonSessionOptions("1.0.0").maximumSessionInputTokens, undefined);

// The policy envelope itself stays frozen: its literals feed the comparison
// digests published packs declare, so a change there invalidates them rather
// than leaving them unchanged.
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumAggregateInputTokens, 24_000);
assert.equal(EARNINGS_CALL_POLICY.semanticEnvelope.maximumSingleJobInputTokens, 12_000);
for (const version of ["1.0.1", "1.1.0", CURRENT_VERSION]) {
  const entry = strategyPackCatalog.resolve({ id: "earnings-call-changes", version })!;
  const built = createEarningsCallComparisonDefinitions(
    ["openai/gpt-5.4"],
    earningsCallComparisonSessionOptions(version),
  );
  assert.ok(
    built.every((definition) => entry.evidenceContracts?.some((contract) =>
      contract.id === definition.definitionId &&
      contract.version === definition.definitionVersion &&
      contract.digest === definition.definitionDigest)),
    `${version} must still resolve the comparison definitions it declares`,
  );
}

// ---------------------------------------------------------------------------
// Executive research output: the brief may never widen the official evidence,
// and only a brief that does not fit an alert is published as an artifact.
// ---------------------------------------------------------------------------

const TRANSCRIPT_URL =
  "https://www.jpmorganchase.com/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/2nd-quarter/2Q26-earnings-transcript.pdf";
const scope = Object.freeze({
  ownerId: "owner_fixture",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
});
const reportNow = workspaceExecutiveBriefSchema.parse({
  confidence: "medium",
  implications: ["Management framed the outlook more cautiously than last quarter."],
  interpretation: "The prepared remarks dropped a prior growth commitment.",
  materialFacts: [{
    sourceUrls: [TRANSCRIPT_URL],
    statement: "The current call omits the prior quarter's explicit growth commitment.",
  }],
  research: { status: "not_needed" },
  sources: [{ label: "JPM FY2026-Q2 transcript", role: "official", url: TRANSCRIPT_URL }],
  title: "JPM FY2026-Q2 earnings-call change",
  uncertainty: ["One call is not a trend."],
});
const researched = workspaceExecutiveBriefSchema.parse({
  ...reportNow,
  research: { status: "completed" },
  sources: [
    ...reportNow.sources,
    { label: "Investor overview", role: "supplementary", url: "https://example.com/investors/overview" },
  ],
});

let publicationCalls = 0;
const publishReport = async (input: { artifactId: string }) => {
  publicationCalls += 1;
  return {
    artifactId: input.artifactId,
    kind: "report" as const,
    publicUrl: `https://eve.example/artifacts/${input.artifactId}`,
  };
};
const materializeInput = {
  asOf: "2026-07-14T20:00:00.000Z",
  clients: { publishReport: publishReport as never },
  factIdentities: ["earnings-finding.fixture"],
  officialUrls: [TRANSCRIPT_URL],
  scope,
};

// A compact report_now brief fits the alert and publishes nothing.
const compact = await materializeEarningsCallExecutiveOutput({
  ...materializeInput,
  approvedSupplementaryUrls: [],
  brief: reportNow,
});
assert.deepEqual(compact.artifactRefs, []);
assert.equal(publicationCalls, 0);
assert.equal(compact.presentation.title, "JPM FY2026-Q2 earnings-call change");

// A supplementary source the research lane never granted is refused outright.
await assert.rejects(
  materializeEarningsCallExecutiveOutput({
    ...materializeInput,
    approvedSupplementaryUrls: [],
    brief: researched,
  }),
  /earnings_call_strategy_invalid/u,
);
assert.equal(publicationCalls, 0);

// A completed research pass carries supplementary context, so it is published.
const published = await materializeEarningsCallExecutiveOutput({
  ...materializeInput,
  approvedSupplementaryUrls: ["https://example.com/investors/overview"],
  brief: researched,
});
assert.equal(published.artifactRefs.length, 1);
assert.equal(publicationCalls, 1);
researchReportSchema.parse(buildEarningsCallSignalReport({
  asOf: materializeInput.asOf,
  brief: researched,
}));

// A brief whose official source is not the acquired transcript can never be
// published: the research child must not substitute its own evidence.
await assert.rejects(
  materializeEarningsCallExecutiveOutput({
    ...materializeInput,
    approvedSupplementaryUrls: [],
    brief: workspaceExecutiveBriefSchema.parse({
      ...reportNow,
      materialFacts: [{
        sourceUrls: ["https://example.com/mismatched-transcript.pdf"],
        statement: "A mismatched transcript must not be published.",
      }],
      sources: [{
        label: "Mismatched transcript",
        role: "official",
        url: "https://example.com/mismatched-transcript.pdf",
      }],
    }),
  }),
  /earnings_call_strategy_invalid/u,
);
assert.equal(publicationCalls, 1);

// The registered validator enforces the same boundary on the model output
// before any of that runs.
const validationInput = {
  disposition: "accepted" as const,
  evidenceTexts: [{
    content: earningsCallResearchEvidenceContent({
      canonicalUrl: TRANSCRIPT_URL,
      cik: "0000019617",
      companyName: "JPMorgan Chase & Co.",
      confidence: "medium",
      counterevidence: [],
      currentFiscalPeriod: "FY2026-Q2",
      findingId: "earnings-finding.fixture",
      inferences: ["Management framed the outlook more cautiously."],
      materialFacts: ["The current call omits the prior growth commitment."],
      priorFiscalPeriod: "FY2026-Q1",
      ticker: "JPM",
      uncertainty: [],
    }),
    locator: {
      artifactDigest: "a".repeat(64),
      end: 12,
      kind: "text_span" as const,
      spanDigest: "b".repeat(64),
      start: 0,
    },
  }],
  fields: reportNow,
  inputProjection: {
    members: [{ role: "section" }],
    recordType: "workspace_semantic_role_bound_projection",
    schemaVersion: 2,
  },
  unknowns: [] as readonly string[],
};
assert.equal(
  earningsCallResearchValidationContract.validate(validationInput as never).requireExactCitations,
  true,
);
assert.throws(
  () => earningsCallResearchValidationContract.validate({
    ...validationInput,
    disposition: "abstained",
  } as never),
  /earnings_call_frontier_output_invalid/u,
);
assert.throws(
  () => earningsCallResearchValidationContract.validate({
    ...validationInput,
    fields: workspaceExecutiveBriefSchema.parse({
      ...reportNow,
      materialFacts: [{
        sourceUrls: ["https://example.com/other.pdf"],
        statement: "An unrelated source cannot support a material fact.",
      }],
      sources: [{ label: "Other", role: "official", url: "https://example.com/other.pdf" }],
    }),
  } as never),
  /earnings_call_frontier_output_invalid/u,
);

console.info("Earnings Call Changes strategy boundary verification passed.");
