import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type {
  EarningsCallPublicSourceRequest,
  EarningsCallPublicSourceResponse,
} from "../agent/lib/earnings-call-public-source-adapter";
import {
  earningsCallFindingRecordSchema,
  readLatestEarningsCallFinding,
  type EarningsCallFindingStoreClient,
} from "../agent/lib/earnings-call-finding-store";
import type { EarningsCallIssuerStatusStoreClient } from "../agent/lib/earnings-call-status-store";
import { normalizeEarningsCallTranscript } from "../agent/lib/earnings-call-transcript";
import { EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID } from "../agent/lib/hybrid-evidence-definition-registry";
import {
  createHybridEvidenceEphemeralArtifactStore,
  type HybridEvidenceArtifactIndexClient,
  type HybridEvidenceBlobClient,
} from "../agent/lib/hybrid-evidence-artifact-store";
import type { HybridEvidenceJobStoreClient } from "../agent/lib/hybrid-evidence-job-store";
import type { HybridEvidenceLineageStoreClient } from "../agent/lib/hybrid-evidence-lineage-store";
import { verifyHybridEvidenceWorkerToken } from "../agent/lib/hybrid-evidence-auth";
import { hybridEvidenceJobSchema } from "../agent/lib/hybrid-evidence-schema";
import {
  listWorkspaceSemanticJobSummaries,
  type WorkspaceSemanticEvidenceStoreClient,
} from "../agent/lib/hybrid-evidence-semantic-store";
import {
  completeHybridEvidenceJobForWorker,
  readHybridEvidenceSliceForWorker,
  type PreparedHybridEvidenceWorkerRun,
} from "../agent/lib/hybrid-evidence-worker";
import { projectHybridEvidencePdf } from "../agent/lib/hybrid-evidence-pdf";
import type { PublicSourceAcquisitionStoreClient } from "../agent/lib/public-source-acquisition-store";
import {
  readAuthorizedPublicSourceProjection,
  readPublicSourceSubscription,
  type PublicSourceSubscriptionStoreClient,
} from "../agent/lib/public-source-subscription-store";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import { EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID } from "../agent/lib/strategy-pack-reference-catalog";
import { requireWorkspaceWorkerStrategyPackRuntime } from "../agent/lib/strategy-pack-runtime";
import { readWorkspaceAlert, type WorkspaceAlertStoreClient } from "../agent/lib/workspace-alert-store";
import {
  finishWorkspaceMonitorDispatchBudget,
  reserveWorkspaceMonitorDispatchBudget,
  type WorkspaceGlobalBudgetClient,
} from "../agent/lib/workspace-dispatch-budget";
import { readWorkspaceBudgetLedger, type WorkspaceBudgetLedgerClient } from "../agent/lib/workspace-budget-ledger";
import {
  readWorkspaceRunOutcome,
  type WorkspaceFindingStoreClient,
} from "../agent/lib/workspace-finding-store";
import {
  claimDueWorkspaceMonitors,
  createWorkspaceMonitor,
  getWorkspaceMonitor,
  inspectWorkspaceMonitorOccurrenceLease,
  workspaceMonitorOccurrenceKey,
  type ClaimedWorkspaceMonitor,
  type WorkspaceMonitor,
  type WorkspaceMonitorStoreClient,
} from "../agent/lib/workspace-monitor-store";
import type { WorkspaceSourceCoverageClient } from "../agent/lib/workspace-source-coverage";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceStateStoreClient,
  type WorkspaceStrategyBindingValue,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";
import {
  evaluateEarningsCallChangesForWorker,
  earningsCallWorkspaceWorkerOutputSchema,
  recoverEarningsCallWorkspaceRunForControlPlane,
  type EarningsCallWorkspaceWorkerClients,
} from "../agent/lib/earnings-call-workspace-worker";
import type { EarningsCallSourceLifecycleClient } from "../agent/lib/earnings-call-source-lifecycle-store";
import { createEarningsCallSourceLifecycleStore } from "../agent/lib/earnings-call-source-lifecycle-store";
import {
  prepareWorkspaceWorkerRecovery,
  prepareWorkspaceWorkerRun,
  WORKSPACE_WORKER_MODEL_ID,
} from "../agent/lib/workspace-worker-runner";

class MemoryCas implements
  EarningsCallFindingStoreClient,
  EarningsCallIssuerStatusStoreClient,
  EarningsCallSourceLifecycleClient,
  HybridEvidenceArtifactIndexClient,
  HybridEvidenceJobStoreClient,
  HybridEvidenceLineageStoreClient,
  PublicSourceAcquisitionStoreClient,
  PublicSourceSubscriptionStoreClient,
  WorkspaceBudgetLedgerClient,
  WorkspaceGlobalBudgetClient,
  WorkspaceSemanticEvidenceStoreClient,
  WorkspaceSourceCoverageClient,
  WorkspaceStateStoreClient {
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

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

class MemoryBlob implements HybridEvidenceBlobClient {
  putCount = 0;
  maximumResidentArtifacts = 0;
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) {
    this.putCount += 1;
    this.values.set(key, Uint8Array.from(bytes));
    this.maximumResidentArtifacts = Math.max(this.maximumResidentArtifacts, this.values.size);
  }
}

class MemoryFindingStore implements WorkspaceFindingStoreClient {
  readonly values = new Map<string, string>();

  async createOutcomeWithIdentityClaims(
    input: Parameters<WorkspaceFindingStoreClient["createOutcomeWithIdentityClaims"]>[0],
  ) {
    const current = this.values.get(input.outcomeKey);
    if (current) return { status: "existing" as const, value: current };
    for (const claim of input.identityClaims) {
      const existing = this.values.get(claim.key);
      if (existing && existing !== claim.value) {
        return { status: "identity_conflict" as const, value: existing };
      }
    }
    for (const claim of input.identityClaims) this.values.set(claim.key, claim.value);
    this.values.set(input.outcomeKey, input.outcomeValue);
    return { status: "created" as const, value: input.outcomeValue };
  }

  async createOrRead(key: string, value: string) {
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }

  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryAlertStore implements WorkspaceAlertStoreClient {
  failNextAlert = false;
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string, next: string) {
    if (this.values.get(key) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async createOrRead(key: string, value: string) {
    if (this.failNextAlert && JSON.parse(value).recordType === "workspace_alert") {
      this.failNextAlert = false;
      throw new Error("fixture_alert_interrupted");
    }
    const current = this.values.get(key);
    if (current) return current;
    this.values.set(key, value);
    return value;
  }

  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryMonitorStore implements WorkspaceMonitorStoreClient {
  readonly completedOccurrences = new Set<string>();
  readonly dueAt = new Map<string, number>();
  readonly leases = new Map<string, { expiresAt: number; token: string }>();
  readonly occurrences = new Map<string, Record<string, unknown>>();
  readonly values = new Map<string, string>();
  dueMonitorId: string | null = null;

  async complete(input: Parameters<WorkspaceMonitorStoreClient["complete"]>[0]) {
    if (this.completedOccurrences.has(input.occurrenceRecordKey)) return "already_completed" as const;
    const current = this.values.get(input.recordKey);
    if (!current) return "missing" as const;
    if (current !== input.expectedRaw) return "stale" as const;
    const occurrence = this.occurrences.get(input.occurrenceRecordKey);
    if (
      !occurrence || occurrence.status !== "leased" ||
      occurrence.configurationRevision !== input.configurationRevision ||
      occurrence.leaseTokenDigest !== input.leaseTokenDigest ||
      !this.leases.has(input.leaseKey)
    ) return "lease_mismatch" as const;
    this.occurrences.set(input.occurrenceRecordKey, { ...occurrence, status: "completed" });
    this.completedOccurrences.add(input.occurrenceRecordKey);
    this.leases.delete(input.leaseKey);
    this.values.set(input.recordKey, input.nextRaw);
    if (input.nextDueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.nextDueAtMs);
    return "completed" as const;
  }

  async create(input: Parameters<WorkspaceMonitorStoreClient["create"]>[0]) {
    if (this.values.has(input.recordKey)) return false;
    this.values.set(input.recordKey, input.raw);
    if (input.dueAtMs !== null) this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async get(key: string) {
    const lease = this.leases.get(key);
    if (lease) return lease.token;
    const occurrence = this.occurrences.get(key);
    if (occurrence) return JSON.stringify(occurrence);
    return this.values.get(key) ?? null;
  }

  async claim(input: Parameters<WorkspaceMonitorStoreClient["claim"]>[0]) {
    const current = this.values.get(input.recordKey);
    if (!current) return { status: "missing" as const };
    const monitor = JSON.parse(current) as WorkspaceMonitor;
    if (monitor.configurationRevision !== input.configurationRevision) return { status: "stale" as const };
    if ((this.dueAt.get(input.recordKey) ?? Number.POSITIVE_INFINITY) > input.nowMs) {
      return { status: "not_due" as const };
    }
    const existing = this.occurrences.get(input.occurrenceRecordKey);
    if (existing?.status === "completed") return { status: "duplicate" as const };
    const active = this.leases.get(input.leaseKey);
    if (active && active.expiresAt > input.nowMs) return { status: "leased" as const };
    const attempt = typeof existing?.attempt === "number" ? existing.attempt + 1 : 1;
    this.leases.set(input.leaseKey, { expiresAt: input.leaseExpiresAtMs, token: input.leaseToken });
    this.occurrences.set(input.occurrenceRecordKey, {
      attempt,
      configurationRevision: input.configurationRevision,
      leaseTokenDigest: input.leaseTokenDigest,
      monitorId: input.monitorId,
      occurrenceIdentity: input.occurrenceIdentity,
      occurrenceKey: input.occurrenceKey,
      scheduledFor: input.scheduledFor,
      schemaVersion: 1,
      status: "leased",
      updatedAt: input.updatedAt,
    });
    return { attempt, status: "claimed" as const };
  }

  async list() { return [...this.values.values()]; }

  async listDue(input: Parameters<WorkspaceMonitorStoreClient["listDue"]>[0]) {
    return [...this.dueAt.entries()]
      .filter(([, dueAt]) => dueAt <= input.nowMs)
      .filter(([recordKey]) => this.dueMonitorId === null ||
        (JSON.parse(this.values.get(recordKey)!) as WorkspaceMonitor).monitorId === this.dueMonitorId)
      .slice(0, input.limit)
      .map(([recordKey]) => ({ raw: this.values.get(recordKey)!, recordKey }));
  }

  async releaseLease(input: Parameters<WorkspaceMonitorStoreClient["releaseLease"]>[0]) {
    const lease = this.leases.get(input.leaseKey);
    if (!lease || lease.token !== input.leaseToken) return false;
    this.leases.delete(input.leaseKey);
    if (input.dueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }

  async update(input: Parameters<WorkspaceMonitorStoreClient["update"]>[0]) {
    if (this.values.get(input.recordKey) !== input.expected) return false;
    this.values.set(input.recordKey, input.next);
    if (input.dueAtMs === null) this.dueAt.delete(input.recordKey);
    else this.dueAt.set(input.recordKey, input.dueAtMs);
    return true;
  }
}

function transcriptFixture(lines: readonly string[]): Uint8Array {
  const escaped = lines.map((line) => line
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)"));
  const fontObjectId = 3 + lines.length * 2;
  const pageObjectIds = lines.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${lines.length} >>`,
    ...escaped.flatMap((line, index) => {
      const contentObjectId = 4 + index * 2;
      const commands = `BT\n/F1 10 Tf\n54 738 Td\n(${line}) Tj\nET`;
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
        `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
      ];
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n% fixture\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

const fixtureNowMs = Date.parse("2026-10-13T18:00:00.000Z");
globalThis.Date = new Proxy(Date, {
  construct(target, argumentsList) {
    return Reflect.construct(target, argumentsList.length > 0 ? argumentsList : [fixtureNowMs]);
  },
  get(target, property, receiver) {
    return property === "now" ? () => fixtureNowMs : Reflect.get(target, property, receiver);
  },
}) as DateConstructor;

const ownerId = "owner_fixture_earnings_production";
const sourceId = "earnings-call-transcripts.0000019617";
const semanticModelId = "google/gemini-3.6-flash";
const frontierSemanticModelId = "openai/gpt-5.4";
const recoveryModelId = "openai/gpt-5.5";
const liveNow = new Date("2026-10-13T18:00:00.000Z");
const baselineNow = new Date(liveNow.getTime() - 16 * 60_000);
const environment = {
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED: "1",
  EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED: "1",
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: Buffer.alloc(32, 61).toString("base64url"),
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_HYBRID_SOURCE_RECOVERY_CONCURRENT_WORKERS: "2",
  EVE_HYBRID_FAST_MODEL_ID: recoveryModelId,
  EVE_HYBRID_FAST_MODEL_REASONING: "low",
  EVE_HYBRID_FRONTIER_MODEL_ID: semanticModelId,
  EVE_HYBRID_FRONTIER_MODEL_REASONING: "high",
  EVE_HYBRID_SOURCE_RECOVERY_INPUT_TOKENS_PER_DAY: "100000",
  EVE_HYBRID_SOURCE_RECOVERY_MODEL_IDS: recoveryModelId,
  EVE_HYBRID_SOURCE_RECOVERY_OUTPUT_TOKENS_PER_DAY: "20000",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_CALL: "1.00",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_DAY: "10.00",
  EVE_HYBRID_SOURCE_RECOVERY_PAID_PER_MONTH: "100.00",
  EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED: "1",
  EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED: "1",
  EVE_STRATEGY_PACK_CATALOG_ENABLED: "1",
  EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED: "1",
  EVE_STRATEGY_PACK_RUNTIME_ENABLED: "1",
  EVE_STRATEGY_PACK_WORKER_MODEL_ID: semanticModelId,
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_GLOBAL_CONCURRENT_WORKERS: "8",
  EVE_WORKSPACE_RUNTIME_AUTH_SECRET: Buffer.alloc(32, 62).toString("base64url"),
  EVE_WORKSPACE_STATE_ENABLED: "1",
} satisfies NodeJS.ProcessEnv;
Object.assign(process.env, environment);

const pack = strategyPackCatalog.resolve({ id: "earnings-call-changes", version: "1.0.0" });
assert.ok(pack);
const frontierPack = strategyPackCatalog.resolve({ id: "earnings-call-changes", version: "1.0.1" });
assert.ok(frontierPack);
const frontierEnvironment = {
  ...environment,
  EVE_HYBRID_FRONTIER_MODEL_ID: frontierSemanticModelId,
  EVE_STRATEGY_PACK_WORKER_MODEL_ID: frontierSemanticModelId,
} satisfies NodeJS.ProcessEnv;
const resource = pack.monitors[0]!;
const sources = resolveParameterizedStrategyPackSources(
  pack,
  { selectedIssuerCiks: ["0000019617"] },
  resource.sourceIds,
);
assert.equal(sources.length, 1);
assert.equal(sources[0]?.sourceId, sourceId);
const reviewed = resolveReviewedPublicSource(sourceId);
assert.equal(reviewed.sourceFamily?.schemaVersion, 2);
assert.equal(sources[0]?.sourceInstanceId, reviewed.sourceInstance.sourceInstanceId);

const state = new MemoryCas();
const acquisition = new MemoryCas();
const coverage = new MemoryCas();
const budget = new MemoryCas();
const semantic = new MemoryCas();
const earnings = new MemoryCas();
const lifecycleMemory = new MemoryCas();
const findings = new MemoryFindingStore();
const alerts = new MemoryAlertStore();
const monitors = new MemoryMonitorStore();
const artifactBlob = new MemoryBlob();
const artifacts = createHybridEvidenceEphemeralArtifactStore({
  blob: artifactBlob,
  index: semantic,
  quota: {
    deploymentBytesPerDay: 8 * 1_024 * 1_024,
    deploymentCountPerDay: 100,
    sourceBytesPerDay: 8 * 1_024 * 1_024,
    sourceCountPerDay: 100,
  },
});
const sourceLifecycle = createEarningsCallSourceLifecycleStore(lifecycleMemory);
const semanticRoutes = new Map<string, { modelId: string; reasoning: "high" }>();

function capabilityManifest(input: {
  readonly pack: NonNullable<typeof pack>;
  readonly semanticModelId: string;
}): WorkspaceCapabilityManifestValue {
  return {
    connectionIds: [],
    controlPlaneToolIds: [EARNINGS_CALL_CHANGES_EVALUATION_TOOL_ID],
    financialToolIds: [],
    hardDeniedCapabilityIds: [...input.pack.capabilities.hardDenied].sort(),
    maximumDataAccessClassification: "public",
    paidResearchAllowed: false,
    providerTools: [],
    researchToolIds: [],
    skills: input.pack.skills.map(({ id, version }) => ({ id, version })),
    sources: sources.map((source) => ({
      allowedOrigins: [...source.allowedOrigins],
      contractDigest: source.contractDigest,
      contractVersion: source.contractVersion,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
    workerModelPolicy: {
      allowedModelIds: [...new Set([input.semanticModelId, WORKSPACE_WORKER_MODEL_ID])],
      maximumOutputTokens: 4_000,
    },
  };
}

async function installWorkspace(
  workspaceId: string,
  options: {
    readonly pack: NonNullable<typeof pack>;
    readonly semanticModelId: string;
  } = { pack, semanticModelId },
) {
  const boundPack = options.pack;
  const boundResource = boundPack.monitors[0]!;
  const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, environment);
  const monitor = await createWorkspaceMonitor({
    activateManagedMonitor: true,
    deliverySubscriptionId: `delivery.${workspaceId}`,
    idempotencyKey: `earnings-production-${workspaceId}`,
    instruction: boundResource.instruction,
    managedBy: {
      bindingRevision: 1,
      kind: "strategy_pack",
      packContentDigest: boundPack.contentDigest,
      packId: boundPack.id,
      packVersion: boundPack.version,
      resourceId: boundResource.resourceId,
    },
    name: boundResource.displayName,
    nextOccurrenceAt: baselineNow.toISOString(),
    now: new Date(baselineNow.getTime() - 60_000),
    publicSourceIds: [sourceId],
    requiredCapabilityIds: [...boundResource.requiredCapabilityIds],
    schedule: { anchor: baselineNow.toISOString(), everyMinutes: 15, kind: "interval" },
    scope,
    sources: sources.map((source) => ({
      accessClassification: source.accessClassification,
      canonicalUrl: source.canonicalUrl,
      origin: new URL(source.canonicalUrl).origin,
      sourceId: source.sourceId,
    })),
  }, monitors);
  const snapshot = {
    bindingRevision: 1,
    capabilityManifestRevision: 1,
    packContentDigest: boundPack.contentDigest,
    packId: boundPack.id,
    packVersion: boundPack.version,
    workspaceGeneration: 1,
  };
  const strategy: WorkspaceStrategyBindingValue = {
    bindingRevision: 1,
    configuration: {
      dailyTimes: ["09:00", "16:00"],
      materialityThreshold: "threshold_50",
      selectedIssuerCiks: ["0000019617"],
      timezone: "UTC",
    },
    effectiveCapabilityManifestRevision: 1,
    health: { checkedAt: baselineNow.toISOString(), code: null, status: "healthy" },
    lastActiveSnapshot: snapshot,
    lifecycleState: "active",
    managedResources: {
      [boundResource.resourceId]: { monitorId: monitor.monitorId, sourceIds: [sourceId] },
    },
    ownerOverrides: {},
    pack: { contentDigest: boundPack.contentDigest, id: boundPack.id, version: boundPack.version },
    pendingSnapshot: null,
    timestamps: {
      activatedAt: baselineNow.toISOString(),
      configuredAt: baselineNow.toISOString(),
      generationRolloverAt: baselineNow.toISOString(),
      installedAt: baselineNow.toISOString(),
    },
  };
  for (const prepared of [
    prepareInitialWorkspaceDocument("brief", {
      now: baselineNow,
      scope,
      value: {
        currentFindingsSummary: "",
        goal: "Track reviewed JPM earnings-call changes.",
        lastMaterialChange: "",
        openQuestions: [],
        promotedFacts: [],
        sourcePolicy: { allowedSourceIds: [sourceId], maximumAccessClassification: "public" },
        strategyConfigurationRevision: 1,
        thesis: "",
        watchlist: [],
      },
    }),
    prepareInitialWorkspaceDocument("budget", {
      now: baselineNow,
      scope,
      value: {
        effectiveAt: baselineNow.toISOString(),
        maximumConcurrentWorkers: 2,
        maximumInputTokensPerDay: 100_000,
        maximumInputTokensPerRun: 24_000,
        maximumOutputTokensPerDay: 20_000,
        maximumOutputTokensPerRun: 4_000,
        maximumPaidPerCall: "1.00",
        maximumPaidPerDay: "10.00",
        maximumPaidPerMonth: "100.00",
        maximumScheduledRunsPerDay: 8,
        ownerTimezone: "UTC",
        unknownPriceFallbackCeiling: "1.00",
      },
    }),
    prepareInitialWorkspaceDocument("capabilities", {
      now: baselineNow,
      scope,
      value: capabilityManifest({ pack: boundPack, semanticModelId: options.semanticModelId }),
    }),
    prepareInitialWorkspaceStrategyBinding({ now: baselineNow, scope, value: strategy }),
  ]) state.values.set(prepared.key, prepared.raw);
  semanticRoutes.set(workspaceId, { modelId: options.semanticModelId, reasoning: "high" });
  return { monitor, pack: boundPack, scope };
}

const baselineListing = Buffer.from(JSON.stringify({
  items: [
    { year: "2026", quarter: "2nd", docs: { transcript: { title: "2Q26 Earnings Transcript", link: "/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/2nd-quarter/2Q26-earnings-transcript.pdf" } } },
    { year: "2026", quarter: "1st", docs: { transcript: { title: "1Q26 Earnings Transcript", link: "/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/1st-quarter/1q26-earnings-transcript.pdf" } } },
  ],
  "total-items": 2,
}));
const liveListing = Buffer.from(await readFile(
  new URL("./fixtures/earnings-call-changes/jpm-reviewed-listing-future.json", import.meta.url),
  "utf8",
));
const secBody = Buffer.from(JSON.stringify({
  cik: "19617",
  filings: {
    recent: {
      accessionNumber: ["0000019617-26-000303", "0000019617-26-000202", "0000019617-26-000101"],
      acceptanceDateTime: ["2026-10-13T17:59:30.000Z", "2026-07-14T17:00:00.000Z", "2026-04-14T17:00:00.000Z"],
      filingDate: ["2026-10-13", "2026-07-14", "2026-04-14"],
      form: ["8-K", "8-K", "8-K"],
      items: ["2.02,9.01", "2.02,9.01", "2.02,9.01"],
      primaryDocument: ["jpm-20261013.htm", "jpm-20260714.htm", "jpm-20260414.htm"],
      reportDate: ["2026-10-13", "2026-07-14", "2026-04-14"],
    },
  },
}));
const transcriptBytes = new Map(reviewed.sourceFamily!.baselineEvents.map((event) => [
  event.artifactUrl,
  transcriptFixture([
    `JPM ${event.fiscalPeriod} Earnings Conference Call Transcript`,
    "Prepared Remarks",
    event.role === "current"
      ? "Jordan Lee - Chief Executive Officer: We maintained our outlook."
      : "Jordan Lee - Chief Executive Officer: We may adjust our outlook.",
    "Questions and Answers",
    "Alex Kim - Analyst: What changed in the outlook?",
    event.role === "current"
      ? "Jordan Lee - Chief Executive Officer: Drivers remain uncertain."
      : "Jordan Lee - Chief Executive Officer: Several outcomes remain possible.",
  ]),
]));
const futureUrl = new URL("/content/dam/jpmc/jpmorgan-chase-and-co/investor-relations/documents/quarterly-earnings/2026/3rd-quarter/3Q26-earnings-transcript.pdf", "https://www.jpmorganchase.com").toString();
transcriptBytes.set(futureUrl, transcriptFixture([
  "JPM FY2026 Q3 Earnings Conference Call Transcript",
  "Prepared Remarks",
  "Jordan Lee - Chief Executive Officer: We raised the full-year range.",
  "Jordan Lee - Chief Executive Officer: The launch is committed next quarter.",
  "Questions and Answers",
  "Alex Kim - Analyst: What changed in the outlook?",
  "Jordan Lee - Chief Executive Officer: We expect stronger execution next quarter.",
  "Jordan Lee - Chief Executive Officer: Supply constraints remain a risk.",
]));
for (const [url, bytes] of transcriptBytes) {
  const event = url === futureUrl
    ? { fiscalPeriod: "FY2026-Q3", state: "accepted" as const }
    : reviewed.sourceFamily!.baselineEvents.find(({ artifactUrl }) => artifactUrl === url)!.role === "current"
      ? { fiscalPeriod: "FY2026-Q2", state: "accepted" as const }
      : { fiscalPeriod: "FY2026-Q1", state: "accepted" as const };
  const normalized = await normalizeEarningsCallTranscript({
    artifactBytes: bytes,
    artifactDigest: createHash("sha256").update(bytes).digest("hex"),
    artifactMediaType: "application/pdf",
    eventRevisionId: `fixture.${event.fiscalPeriod}`,
    fiscalPeriod: event.fiscalPeriod,
  });
  const projection = await projectHybridEvidencePdf(bytes);
  assert.equal(
    normalized.state,
    event.state,
    `${event.fiscalPeriod} fixture must reach its intended parser path: ${projection.pages.map(({ text }) => text).join("\n")}`,
  );
}

let sourcePhase: "baseline" | "live" = "baseline";
let secFetches = 0;
let discoveryFetches = 0;
let artifactFetches = 0;
const fetchResponse = async (
  request: EarningsCallPublicSourceRequest,
): Promise<EarningsCallPublicSourceResponse> => {
  const body = request.kind === "sec_submissions"
    ? (secFetches += 1, secBody)
    : request.kind === "issuer_discovery"
      ? (discoveryFetches += 1, sourcePhase === "baseline" ? baselineListing : liveListing)
      : (artifactFetches += 1, transcriptBytes.get(request.url));
  assert.ok(body, `unexpected fixture URL ${request.url}`);
  assert.ok(body.byteLength <= request.maximumBytes, "fixture transport must obey the requested byte bound");
  return {
    body,
    contentType: request.kind === "sec_submissions"
      ? "application/json"
      : request.kind === "issuer_discovery" ? "application/json" : "application/pdf",
    finalUrl: request.url,
    observedAt: sourcePhase === "baseline" ? baselineNow.toISOString() : liveNow.toISOString(),
    redirectChain: [request.url],
    redirectCount: 0,
    requestedUrl: request.url,
    status: 200,
  };
};

let recoveryDispatches = 0;
const semanticDispatches = new Map<string, number>();

function recoveryCandidate(sourceText: string) {
  const preparedStart = sourceText.indexOf("Prepared Discussion");
  const qaStart = sourceText.indexOf("Analyst Dialogue");
  const executiveStart = sourceText.indexOf("Jordan Lee", preparedStart);
  const analystStart = sourceText.indexOf("Alex Kim", qaStart);
  const answerStart = sourceText.indexOf("Jordan Lee", analystStart);
  assert.ok(preparedStart >= 0 && qaStart > preparedStart && executiveStart > preparedStart);
  assert.ok(analystStart > qaStart && answerStart > analystStart);
  return {
    citations: [],
    disposition: "accepted" as const,
    fields: {
      qaPairs: [{ answerTurnIndexes: [2], questionTurnIndexes: [1] }],
      sections: [
        { end: qaStart, sectionKind: "prepared_remarks", start: preparedStart },
        { end: sourceText.length, sectionKind: "questions_and_answers", start: qaStart },
      ],
      speakerTurns: [
        { end: qaStart, role: "executive", speakerName: "Jordan Lee", start: executiveStart },
        { end: answerStart, role: "analyst", speakerName: "Alex Kim", start: analystStart },
        { end: sourceText.length, role: "executive", speakerName: "Jordan Lee", start: answerStart },
      ],
    },
    unknowns: [],
  };
}

async function completeFixtureModel(prepared: PreparedHybridEvidenceWorkerRun) {
  const envelope = verifyHybridEvidenceWorkerToken(prepared.token, {}, environment);
  const body = JSON.parse(prepared.request.input.message.match(
    /<hybrid-evidence-job-v1>\n([\s\S]+)\n<\/hybrid-evidence-job-v1>/u,
  )![1]!) as any;
  const ctx = { session: { auth: { current: prepared.request.auth, initiator: prepared.request.auth } } };
  if (prepared.record.job.definitionId === EARNINGS_CALL_TRANSCRIPT_LAYOUT_DEFINITION_ID) {
    assert.equal(envelope.modelId, recoveryModelId);
    assert.equal(envelope.reasoning, "low");
    recoveryDispatches += 1;
    const locator = body.locators.find((candidate: any) => candidate.kind === "text_span");
    const slice = await readHybridEvidenceSliceForWorker({
      clients: { artifacts, jobs: semantic },
      ctx,
      environment,
      locator,
    });
    await completeHybridEvidenceJobForWorker({
      candidate: recoveryCandidate(slice.content),
      ctx,
      environment,
      jobClient: semantic,
      now: new Date(prepared.record.job.startedAt!),
    });
    return { inputTokens: 90, outputTokens: 70, paidCostUsd: "0.01" };
  }
  const workspaceId = prepared.record.job.scope.kind === "workspace"
    ? prepared.record.job.scope.workspaceId
    : "unexpected";
  assert.deepEqual(
    { modelId: envelope.modelId, reasoning: envelope.reasoning },
    semanticRoutes.get(workspaceId),
  );
  semanticDispatches.set(workspaceId, (semanticDispatches.get(workspaceId) ?? 0) + 1);
  const projection = body.inputProjection;
  const bindings = projection.members.flatMap((member: any) =>
    member.semanticContext.citationSpans.map((span: any) => ({ member, span })));
  const citations = bindings.map(({ span }: any) => span.citation);
  const locatorCitations = bindings.map(({ member, span }: any) => ({
    artifactDigest: member.artifactDigest,
    end: span.citation.end,
    kind: "text_span" as const,
    spanDigest: span.evidenceSpanDigest,
    start: span.citation.start,
  }));
  for (const locator of locatorCitations) {
    const slice = await readHybridEvidenceSliceForWorker({
      clients: { artifacts, jobs: semantic },
      ctx,
      environment,
      locator,
    });
    assert.ok(slice.content.length > 0);
  }
  const assertion = { citations, statement: "Management made its outlook more specific and committed." };
  const candidate = {
    citations: locatorCitations,
    disposition: "accepted" as const,
    fields: {
      absenceDependentAssertions: [],
      analysisKind: "comparison",
      confidence: "high",
      counterevidence: [{ citations, statement: "Demand stability remains an explicit condition." }],
      coverage: { complete: true, memberIds: projection.members.map(({ memberId }: any) => memberId) },
      facts: [assertion],
      forecast: {
        catalysts: [],
        citations,
        direction: "positive",
        horizon: "next_quarter",
        invalidationConditions: ["Demand weakens materially."],
        likelyMarketInterpretation: "The additional operating specificity may be interpreted constructively.",
        risks: [{ citations, statement: "Supply constraints remain an explicit risk." }],
        scenarios: [{
          condition: "Demand remains stable.",
          direction: "positive",
          label: "base",
          rationale: "Execution follows the cited operating assumptions.",
        }],
      },
      inferences: [assertion],
      outcome: "accepted",
      rationale: "The cited current and prior passages support the bounded comparison.",
      reasonCodes: ["material_change"],
      recommendation: {
        assumptions: ["Demand remains stable."],
        citations,
        conditionalImplication: "Investigate whether execution supports the changed outlook.",
        rationale: "The stance is limited to the cited public call evidence.",
        stance: "constructive",
        valuationAssessment: "not_assessed",
      },
    },
    unknowns: [],
  };
  const completedShape = hybridEvidenceJobSchema.safeParse({
    ...prepared.record.job,
    completedAt: prepared.record.job.startedAt,
    state: "completed",
    updatedAt: prepared.record.job.startedAt,
  });
  assert.equal(completedShape.success, true);
  await completeHybridEvidenceJobForWorker({
    candidate,
    ctx,
    environment,
    jobClient: semantic,
    now: new Date(prepared.record.job.startedAt!),
  });
  return { inputTokens: 180, outputTokens: 100, paidCostUsd: "0.002" };
}

const workerClients: EarningsCallWorkspaceWorkerClients = {
  acquisition,
  alert: alerts,
  artifacts,
  earningsFindings: earnings,
  earningsStatus: earnings,
  fetchResponse,
  finding: findings,
  hybridGlobalBudget: budget,
  monitor: monitors,
  semantic: {
    artifacts,
    budget,
    catalog: strategyPackCatalog,
    execute: completeFixtureModel,
    jobs: semantic,
    lineage: semantic,
    semantic,
  },
  sourceCoverage: coverage,
  sourceLifecycle,
  state,
  strategyPackCatalog,
  subscription: acquisition,
};

async function claim(workspace: Awaited<ReturnType<typeof installWorkspace>>, now: Date) {
  monitors.dueMonitorId = workspace.monitor.monitorId;
  try {
    const jobs = await claimDueWorkspaceMonitors({
      environment,
      leaseForMs: 30 * 60_000,
      limit: 10,
      now,
      recoveryWindowMs: 6 * 60 * 60_000,
    }, monitors);
    const selected = jobs.find(({ monitor }) => monitor.monitorId === workspace.monitor.monitorId);
    assert.ok(selected, `missing due claim for ${workspace.scope.workspaceId}`);
    return selected;
  } finally {
    monitors.dueMonitorId = null;
  }
}

async function prepare(
  job: ClaimedWorkspaceMonitor,
  now: Date,
  options: { readonly environment: NodeJS.ProcessEnv; readonly pack: NonNullable<typeof pack> } = {
    environment,
    pack,
  },
) {
  const dispatchBudget = await reserveWorkspaceMonitorDispatchBudget(job, {
    clients: { global: budget, state, workspace: budget },
    environment: options.environment,
    now,
  });
  const prepared = await prepareWorkspaceWorkerRun({
    claimed: job,
    clients: { sourceCoverage: coverage, state, strategyPackCatalog },
    dispatchBudget,
    environment: options.environment,
    now,
  });
  assert.equal(prepared.envelope.strategyPack?.packContentDigest, options.pack.contentDigest);
  assert.equal(prepared.envelope.sources[0]?.sourceId, sourceId);
  return { dispatchBudget, prepared };
}

async function evaluate(
  job: ClaimedWorkspaceMonitor,
  now: Date,
  options?: { readonly environment: NodeJS.ProcessEnv; readonly pack: NonNullable<typeof pack> },
) {
  const { dispatchBudget, prepared } = await prepare(job, now, options);
  const result = await evaluateEarningsCallChangesForWorker({
    clients: workerClients,
    ctx: { session: { auth: { current: prepared.request.auth } } },
    environment: options?.environment ?? environment,
    now,
  });
  earningsCallWorkspaceWorkerOutputSchema.parse({
    evaluatedIssuers: result.evaluatedIssuers,
    materialFindings: result.materialFindings,
    outcome: result.outcome.outcome,
    replayed: result.replayed,
    runId: result.outcome.runId,
  });
  await finishWorkspaceMonitorDispatchBudget(job, dispatchBudget, {
    actualInputTokens: 180,
    actualOutputTokens: 100,
    now,
    outcome: "reconciled",
  }, { global: budget, workspace: budget });
  return { prepared, result };
}

const workspaceA = await installWorkspace("123e4567-e89b-42d3-a456-426614176101");
const workspaceB = await installWorkspace("123e4567-e89b-42d3-a456-426614176102");
const workspaceC = await installWorkspace("123e4567-e89b-42d3-a456-426614176103");
const workspaceD = await installWorkspace("123e4567-e89b-42d3-a456-426614176104", {
  pack: frontierPack,
  semanticModelId: frontierSemanticModelId,
});

sourcePhase = "baseline";
for (const [workspace, options] of [
  [workspaceA, undefined],
  [workspaceB, undefined],
  [workspaceC, undefined],
  [workspaceD, { environment: frontierEnvironment, pack: frontierPack }],
] as const) {
  const result = await evaluate(await claim(workspace, baselineNow), baselineNow, options);
  assert.equal(result.result.outcome.outcome, "no_match");
  assert.equal(result.result.materialFindings, 0, "activation baseline must remain silent");
}
assert.equal(secFetches, 1, "overlapping baseline workspaces must share source acquisition");
assert.equal(discoveryFetches, 1, "overlapping baseline workspaces must share listing acquisition");
assert.equal([...alerts.values.values()].length, 0);

sourcePhase = "live";
const liveClaimA = await claim(workspaceA, liveNow);
const liveA = await evaluate(liveClaimA, liveNow);
assert.equal(liveA.result.outcome.outcome, "finding_staged");
assert.equal(liveA.result.materialFindings, 1);
assert.equal(recoveryDispatches, 0, "familiar live layouts must remain deterministic-first");
const subscriptionIdA = workspaceA.monitor.publicSourceSubscriptions?.[0]?.subscriptionId;
assert.ok(subscriptionIdA);
const subscriptionA = await readPublicSourceSubscription(workspaceA.scope, subscriptionIdA, acquisition);
assert.ok(subscriptionA?.deliveryCursor.lastAcquisitionId);
const historicalProjectionA = [...acquisition.values.values()].map((raw) => JSON.parse(raw)).find((value) =>
  value.recordType === "public_source_fact_projection" &&
  value.workspaceId === workspaceA.scope.workspaceId &&
  value.acquisitionId !== subscriptionA.deliveryCursor.lastAcquisitionId);
assert.ok(historicalProjectionA, "the comparison must include a projection from a committed prior acquisition");
const authorizedHistoricalA = await readAuthorizedPublicSourceProjection({
  factRevisionId: historicalProjectionA.factRevisionId,
  scope: workspaceA.scope,
  subscriptionId: subscriptionIdA,
}, { acquisition, subscription: acquisition });
assert.equal(authorizedHistoricalA?.projection.acquisitionId, historicalProjectionA.acquisitionId,
  "committed historical projection membership must remain authorized after the delivery cursor advances");
const historicalJournalEntry = [...acquisition.values.entries()].find(([, raw]) => {
  const value = JSON.parse(raw);
  return value.recordType === "public_source_acquisition_journal" &&
    value.acquisitionId === historicalProjectionA.acquisitionId;
});
assert.ok(historicalJournalEntry);
const [historicalJournalKey, historicalJournalRaw] = historicalJournalEntry;
const historicalJournal = JSON.parse(historicalJournalRaw);
try {
  acquisition.values.set(historicalJournalKey, JSON.stringify({
    ...historicalJournal,
    committedAt: null,
    status: "prepared",
  }));
  await assert.rejects(() => readAuthorizedPublicSourceProjection({
    factRevisionId: historicalProjectionA.factRevisionId,
    scope: workspaceA.scope,
    subscriptionId: subscriptionIdA,
  }, { acquisition, subscription: acquisition }), /public_source_subscription_corrupt/u,
  "an uncommitted historical acquisition must never authorize semantic evidence");
} finally {
  acquisition.values.set(historicalJournalKey, historicalJournalRaw);
}
const earningsA = await readLatestEarningsCallFinding(workspaceA.scope, earnings);
assert.ok(earningsA);
earningsCallFindingRecordSchema.parse(earningsA);
const genericA = liveA.result.outcome.finding;
assert.ok(genericA);
const alertA = await readWorkspaceAlert(workspaceA.scope, genericA.findingId, alerts);
assert.ok(alertA);
assert.equal(alertA.findingId, genericA.findingId);
assert.deepEqual(alertA.sourceRefs, [sourceId]);
assert.deepEqual(alertA.sourceLinks, [{ canonicalUrl: sources[0]!.canonicalUrl, sourceId }]);
assert.ok(alertA.artifactRefs?.includes(earningsA.finding.findingId));
assert.ok(alertA.artifactRefs?.includes(earningsA.finding.comparisonId));
assert.ok(alertA.artifactRefs?.includes(earningsA.sources.find(({ role }) => role === "current")!.eventRevisionId));

const replay = await evaluateEarningsCallChangesForWorker({
  clients: workerClients,
  ctx: { session: { auth: { current: liveA.prepared.request.auth } } },
  environment,
  now: liveNow,
});
assert.equal(replay.replayed, true);
assert.equal(replay.outcome.runId, liveA.result.outcome.runId);
earningsCallWorkspaceWorkerOutputSchema.parse({
  evaluatedIssuers: replay.evaluatedIssuers,
  materialFindings: replay.materialFindings,
  outcome: replay.outcome.outcome,
  replayed: replay.replayed,
  runId: replay.outcome.runId,
});
assert.equal([...alerts.values.values()].filter((raw) => JSON.parse(raw).recordType === "workspace_alert").length, 1);

const acquisitionFactsBeforeWorkspaceB = [...acquisition.values.values()].filter((raw) =>
  JSON.parse(raw).recordType === "canonical_public_fact_revision").length;
const secBeforeWorkspaceB = secFetches;
const discoveryBeforeWorkspaceB = discoveryFetches;
const liveB = await evaluate(await claim(workspaceB, liveNow), liveNow);
assert.equal(liveB.result.outcome.outcome, "finding_staged");
assert.equal(secFetches, secBeforeWorkspaceB);
assert.equal(discoveryFetches, discoveryBeforeWorkspaceB);
assert.equal(recoveryDispatches, 0, "deterministic layouts must not dispatch recovery in sibling workspaces");
assert.equal([...acquisition.values.values()].filter((raw) =>
  JSON.parse(raw).recordType === "canonical_public_fact_revision").length, acquisitionFactsBeforeWorkspaceB);
const earningsB = await readLatestEarningsCallFinding(workspaceB.scope, earnings);
assert.ok(earningsB);
assert.notEqual(earningsA.finding.findingId, earningsB.finding.findingId);
const liveD = await evaluate(await claim(workspaceD, liveNow), liveNow, {
  environment: frontierEnvironment,
  pack: frontierPack,
});
assert.equal(liveD.result.outcome.outcome, "finding_staged");
assert.ok(
  (semanticDispatches.get(workspaceD.scope.workspaceId) ?? 0) > 0,
  "the 1.0.1 binding must execute GPT-5.4/high through the signed worker",
);
assert.equal(await readLatestEarningsCallFinding(workspaceC.scope, earnings), null);
assert.equal(await readWorkspaceRunOutcome(workspaceB.scope, liveA.prepared.envelope.occurrenceKey, findings), null);
const alertB = await readWorkspaceAlert(workspaceB.scope, liveB.result.outcome.finding!.findingId, alerts);
assert.ok(alertB);
assert.notEqual(alertA.alertId, alertB.alertId);
const [semanticA, semanticB, budgetA, budgetB] = await Promise.all([
  listWorkspaceSemanticJobSummaries(workspaceA.scope, semantic),
  listWorkspaceSemanticJobSummaries(workspaceB.scope, semantic),
  readWorkspaceBudgetLedger(workspaceA.scope, budget),
  readWorkspaceBudgetLedger(workspaceB.scope, budget),
]);
assert.ok(semanticA.length > 0 && semanticB.length > 0);
assert.notDeepEqual(semanticA.map(({ jobId }) => jobId), semanticB.map(({ jobId }) => jobId));
assert.ok(budgetA.reservations.length > 0 && budgetB.reservations.length > 0);
assert.equal(budgetA.workspaceId, workspaceA.scope.workspaceId);
assert.equal(budgetB.workspaceId, workspaceB.scope.workspaceId);

const liveClaimC = await claim(workspaceC, liveNow);
const interrupted = await prepare(liveClaimC, liveNow);
alerts.failNextAlert = true;
await assert.rejects(
  evaluateEarningsCallChangesForWorker({
    clients: workerClients,
    ctx: { session: { auth: { current: interrupted.prepared.request.auth } } },
    environment,
    now: liveNow,
  }),
  /fixture_alert_interrupted/u,
);
const interruptedOutcome = await readWorkspaceRunOutcome(
  workspaceC.scope,
  interrupted.prepared.envelope.occurrenceKey,
  findings,
);
assert.ok(interruptedOutcome?.finding, "the durable outcome must precede alert finalization");
assert.equal(await readWorkspaceAlert(workspaceC.scope, interruptedOutcome.finding.findingId, alerts), null);
const recoveryPrepared = await prepareWorkspaceWorkerRecovery({
  claimed: liveClaimC,
  clients: { monitor: monitors, state, strategyPackCatalog },
  expectedRunId: interrupted.prepared.envelope.runId,
});
assert.deepEqual(
  recoveryPrepared.strategyPack,
  interruptedOutcome.strategyPack,
  "recovery must re-authorize the exact strategy-pack snapshot stored with the outcome",
);
assert.equal(interruptedOutcome.ownerId, recoveryPrepared.scope.ownerId);
assert.equal(interruptedOutcome.workspaceId, recoveryPrepared.scope.workspaceId);
assert.equal(interruptedOutcome.monitorId, recoveryPrepared.claimed.monitor.monitorId);
assert.equal(interruptedOutcome.occurrenceKey, recoveryPrepared.claimed.occurrence.occurrenceKey);
assert.equal(interruptedOutcome.configurationRevision,
  recoveryPrepared.claimed.monitor.configurationRevision);
assert.equal(interruptedOutcome.finding?.runId, interruptedOutcome.runId);
assert.equal(interruptedOutcome.finding?.ownerId, interruptedOutcome.ownerId);
assert.equal(interruptedOutcome.finding?.workspaceId, interruptedOutcome.workspaceId);
assert.equal(interruptedOutcome.finding?.monitorId, interruptedOutcome.monitorId);
assert.deepEqual(interruptedOutcome.finding?.strategyPack, interruptedOutcome.strategyPack);
assert.equal(
  JSON.stringify(interruptedOutcome.finding?.strategyPack),
  JSON.stringify(interruptedOutcome.strategyPack),
  "finding and outcome strategy-pack snapshots must have the same canonical field order",
);
assert.equal(interruptedOutcome.runId, recoveryPrepared.expectedRunId);
assert.equal(recoveryPrepared.claimed.occurrence.attempt, 1);
assert.equal(recoveryPrepared.expectedRunId,
  `${recoveryPrepared.claimed.occurrence.occurrenceKey}:attempt:1`);
assert.equal(await inspectWorkspaceMonitorOccurrenceLease({
  configurationRevision: recoveryPrepared.claimed.monitor.configurationRevision,
  leaseToken: recoveryPrepared.claimed.leaseToken,
  leaseTokenDigest: recoveryPrepared.claimed.occurrence.leaseTokenDigest,
  monitorId: recoveryPrepared.claimed.monitor.monitorId,
  occurrenceKey: recoveryPrepared.claimed.occurrence.occurrenceKey,
  scope: recoveryPrepared.scope,
}, monitors), "current");
const currentRecoveryMonitor = await getWorkspaceMonitor(
  recoveryPrepared.scope,
  recoveryPrepared.claimed.monitor.monitorId,
  monitors,
);
assert.ok(currentRecoveryMonitor);
assert.deepEqual(currentRecoveryMonitor.sources, recoveryPrepared.claimed.monitor.sources);
await requireWorkspaceWorkerStrategyPackRuntime({
  catalog: strategyPackCatalog,
  envelope: {
    capabilityRevision: recoveryPrepared.capabilityRevision,
    sources: recoveryPrepared.claimed.monitor.sources,
    strategyPack: recoveryPrepared.strategyPack,
  },
  environment,
  monitor: currentRecoveryMonitor,
  scope: recoveryPrepared.scope,
  stateClient: state,
});
const recovered = await recoverEarningsCallWorkspaceRunForControlPlane({
  clients: workerClients,
  now: liveNow,
  prepared: recoveryPrepared,
});
assert.equal(recovered.status, "recovered");
assert.ok(await readWorkspaceAlert(workspaceC.scope, interruptedOutcome.finding.findingId, alerts));
assert.equal((await getWorkspaceMonitor(workspaceC.scope, workspaceC.monitor.monitorId, monitors))?.lastCompletedAt,
  liveNow.toISOString());
await finishWorkspaceMonitorDispatchBudget(liveClaimC, interrupted.dispatchBudget, {
  actualInputTokens: 180,
  actualOutputTokens: 100,
  now: liveNow,
  outcome: "reconciled",
}, { global: budget, workspace: budget });

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(
  packageJson.scripts["verify:earnings-call-changes:worker-recovery-corrections"],
  "jiti scripts/verify-earnings-call-worker-recovery-corrections.ts",
  "source-correction alert semantics remain delegated to their focused production-contract gate",
);
assert.equal(
  [...state.values.values(), ...acquisition.values.values(), ...earnings.values.values(), ...findings.values.values()]
    .some((raw) => raw.includes("Prepared Discussion") || raw.includes("Analyst Dialogue")),
  false,
  "raw transcript bytes must not escape the private ephemeral artifact store",
);
assert.ok(artifactBlob.putCount > 0 && artifactBlob.maximumResidentArtifacts > 0,
  "worker evidence must be materialized only through the private ephemeral store");
assert.ok(artifactFetches >= 2 + 2 + 2 + 3 + 3 + 3);
assert.equal(workspaceMonitorOccurrenceKey({
  configurationRevision: liveClaimC.monitor.configurationRevision,
  monitorId: liveClaimC.monitor.monitorId,
  occurrenceIdentity: liveClaimC.occurrence.occurrenceIdentity,
  scope: liveClaimC.scope,
}), liveClaimC.occurrence.occurrenceKey);

console.info("Earnings Call Changes production worker wiring verification passed.");
