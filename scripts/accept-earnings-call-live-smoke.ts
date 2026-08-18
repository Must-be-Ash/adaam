import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { MessageStreamEvent } from "eve/client";
import { withBundledCompiledArtifacts } from "../node_modules/eve/dist/src/runtime/loaders/bundled-artifacts.js";

import { createEarningsCallComparison } from "../agent/lib/earnings-call-comparison";
import {
  runEarningsCallSemanticComparison,
  type EarningsCallSemanticEvidenceInput,
  type WorkspaceSemanticAuthorizationProjection,
} from "../agent/lib/earnings-call-semantic";
import { createHybridEvidenceArtifactStore } from "../agent/lib/hybrid-evidence-artifact-store";
import { readHybridEvidenceJob } from "../agent/lib/hybrid-evidence-job-store";
import { resolveHybridTaskModelRoute } from "../agent/lib/hybrid-evidence-model-routing";
import { startHybridEvidenceWorkerTask } from "../agent/lib/hybrid-evidence-worker";
import {
  canonicalPublicFactRevisionSchema,
  digestPublicSourceValue,
  publicSourceProjectionSchema,
  publicSourceSubscriptionSchema,
} from "../agent/lib/public-source-adapter-schema";
import { resolveReviewedPublicSource } from "../agent/lib/public-source-registry";
import {
  runSharedEarningsCallPublicSourceAcquisition,
  type EarningsCallTransientArtifact,
} from "../agent/lib/earnings-call-public-source-adapter";
import { createEarningsCallPublicSourceFetch } from "../agent/lib/earnings-call-source-transport";
import { normalizeEarningsCallTranscript } from "../agent/lib/earnings-call-transcript";
import { earningsEventSchema } from "../agent/lib/earnings-call-schema";
import { strategyPackCatalog } from "../agent/lib/strategy-pack-catalog";
import { resolveParameterizedStrategyPackSources } from "../agent/lib/strategy-pack-source-resolution";
import {
  prepareInitialWorkspaceDocument,
  prepareInitialWorkspaceStrategyBinding,
} from "../agent/lib/workspace-state-store";
import { authorizeDeploymentWorkspaceStore } from "../agent/lib/workspace-store-authorization";

class MemoryCas {
  readonly values = new Map<string, string>();
  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }
  async get(key: string) { return this.values.get(key) ?? null; }
}

class MemoryBlob {
  readonly values = new Map<string, Uint8Array>();
  async delete(key: string) { this.values.delete(key); }
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, bytes: Uint8Array) { this.values.set(key, Uint8Array.from(bytes)); }
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ownerId = "owner_live_routing_smoke";
const workspaceId = "00000000-0000-4000-8000-0000000004b1";
const sourceId = "earnings-call-transcripts.0000019617";
const MAXIMUM_SMOKE_CHARACTERS_PER_SECTION = 5_000;
const pack = strategyPackCatalog.resolve({ id: "earnings-call-changes", version: "1.0.1" });
assert.ok(pack, "earnings-call-changes@1.0.1 is required");
const reviewedSource = resolveReviewedPublicSource(sourceId);
const userAgent = process.env.SEC_USER_AGENT;
if (!userAgent) throw new Error("sec_user_agent_missing");
const route = resolveHybridTaskModelRoute("semantic_interpretation");
const now = new Date();
const environment = {
  ...process.env,
  EVE_DEPLOYMENT_OWNER_ID: ownerId,
  EVE_HYBRID_EVIDENCE_AUTH_SECRET: randomBytes(32).toString("base64url"),
  EVE_HYBRID_EVIDENCE_ENABLED: "1",
  EVE_HYBRID_EVIDENCE_WORKER_LOCAL_TRANSPORT: "1",
  EVE_HYBRID_SEMANTIC_REASONING_ENABLED: "1",
  EVE_WORKSPACE_DISPATCH_ENABLED: "1",
  EVE_WORKSPACE_RUNTIME_ENABLED: "1",
  EVE_WORKSPACE_STATE_ENABLED: "1",
} satisfies NodeJS.ProcessEnv;
const originalEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);

const memory = new MemoryCas();
const artifacts = createHybridEvidenceArtifactStore({
  blob: new MemoryBlob(),
  index: memory,
  quota: {
    deploymentBytesPerDay: 8 * 1024 * 1024,
    deploymentCountPerDay: 16,
    sourceBytesPerDay: 8 * 1024 * 1024,
    sourceCountPerDay: 16,
  },
});
const resolvedSource = resolveParameterizedStrategyPackSources(pack, { selectedIssuerCiks: ["0000019617"] })[0];
assert.ok(resolvedSource);
const scope = authorizeDeploymentWorkspaceStore({ ownerId, workspaceId }, environment);
const snapshot = {
  bindingRevision: 1,
  capabilityManifestRevision: 1,
  packContentDigest: pack.contentDigest,
  packId: pack.id,
  packVersion: pack.version,
  workspaceGeneration: 1,
};
for (const prepared of [
  prepareInitialWorkspaceDocument("budget", {
    now,
    scope,
    value: {
      effectiveAt: now.toISOString(), maximumConcurrentWorkers: 1,
      maximumInputTokensPerDay: 24_000, maximumInputTokensPerRun: 24_000,
      maximumOutputTokensPerDay: 4_000, maximumOutputTokensPerRun: 4_000,
      maximumPaidPerCall: "1.00", maximumPaidPerDay: "1.00", maximumPaidPerMonth: "1.00",
      maximumScheduledRunsPerDay: 1, ownerTimezone: "UTC", unknownPriceFallbackCeiling: "1.00",
    },
  }),
  prepareInitialWorkspaceDocument("capabilities", {
    now,
    scope,
    value: {
      connectionIds: [], controlPlaneToolIds: [], financialToolIds: [],
      hardDeniedCapabilityIds: [...pack.capabilities.hardDenied], maximumDataAccessClassification: "public",
      paidResearchAllowed: false, providerTools: [], researchToolIds: [], skills: [],
      sources: [{
        allowedOrigins: resolvedSource.allowedOrigins, contractDigest: resolvedSource.contractDigest,
        contractVersion: resolvedSource.contractVersion, origin: resolvedSource.allowedOrigins[0]!, sourceId,
      }],
      workerModelPolicy: { allowedModelIds: [route.modelId], maximumOutputTokens: 4_000 },
    },
  }),
  prepareInitialWorkspaceStrategyBinding({
    now,
    scope,
    value: {
      bindingRevision: 1,
      configuration: { dailyTimes: ["09:00"], materialityThreshold: "threshold_50", selectedIssuerCiks: ["0000019617"], timezone: "UTC" },
      effectiveCapabilityManifestRevision: 1,
      health: { checkedAt: now.toISOString(), code: null, status: "healthy" },
      lastActiveSnapshot: snapshot, lifecycleState: "active", managedResources: {}, ownerOverrides: {},
      pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version }, pendingSnapshot: null,
      timestamps: { activatedAt: now.toISOString(), configuredAt: now.toISOString(), generationRolloverAt: now.toISOString(), installedAt: now.toISOString() },
    },
  }),
]) memory.values.set(prepared.key, prepared.raw);

const sourceFacts = new Map<string, unknown>();
const projections = new Map<string, WorkspaceSemanticAuthorizationProjection>();
async function startTransport() {
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { args: unknown[]; method: string; namespace: string };
      const result = payload.namespace === "source_fact"
        ? sourceFacts.get(String(payload.args[0])) ?? null
        : await Reflect.apply(Reflect.get(payload.namespace === "artifacts" ? artifacts : memory, payload.method), payload.namespace === "artifacts" ? artifacts : memory, payload.args);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "worker_transport_failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    token,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function withLocalWorkflowWorld<T>(run: () => Promise<T>): Promise<T> {
  const appRoot = process.cwd();
  const eveEntry = import.meta.resolve("eve");
  const [
    { compileAgent },
    { createWorld },
    { setWorld },
    { WorkflowBundleBuilder },
    { bundleWorkflowStepRegistrations },
    { writeCompiledArtifactsFiles },
    { resolvePackageRoot, resolveWorkflowModulePath },
    { deriveEveWorkflowQueuePrefix },
  ] = await Promise.all([
    import(new URL("./compiler/compile-agent.js", eveEntry).href),
    import(new URL("./compiled/@workflow/world-local/index.js", eveEntry).href),
    import(new URL("./internal/workflow/runtime.js", eveEntry).href),
    import(new URL("./internal/workflow-bundle/builder.js", eveEntry).href),
    import(new URL("./internal/workflow-bundle/builder-support.js", eveEntry).href),
    import(new URL("./internal/application/compiled-artifacts.js", eveEntry).href),
    import(new URL("./internal/application/package.js", eveEntry).href),
    import(new URL("./internal/workflow/queue-namespace.js", eveEntry).href),
  ]);
  const compilation = await compileAgent({ startPath: appRoot });
  const workflowDataDirectory = await mkdtemp(join(tmpdir(), "adaam-earnings-live-smoke-world-"));
  const workflowBuildDirectory = await mkdtemp(join(tmpdir(), "adaam-earnings-live-smoke-bundle-"));
  try {
    const generatedArtifacts = await writeCompiledArtifactsFiles({
      compileResult: compilation,
      defaultWorkflowWorld: "local",
      outDir: join(workflowBuildDirectory, "artifacts"),
    });
    const workflowBundlePath = join(workflowBuildDirectory, "workflows.mjs");
    const workflowStepsPath = join(workflowBuildDirectory, "steps.mjs");
    class LocalWorkflowBundleBuilder extends WorkflowBundleBuilder {
      async buildStepRegistrations(outfile: string, compiledArtifactsBootstrapPath: string): Promise<void> {
        const inputFiles = await this.getInputFiles();
        const tsconfigPath = await this.findTsConfigPath();
        const discoveredEntries = await this.discoverEntries(inputFiles, workflowBuildDirectory, tsconfigPath);
        await bundleWorkflowStepRegistrations({
          builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
          discoveredEntries: {
            ...discoveredEntries,
            discoveredSerdeFiles: [...discoveredEntries.discoveredSerdeFiles, compiledArtifactsBootstrapPath],
          },
          outfile,
          projectRoot: this.transformProjectRoot,
          ...(tsconfigPath ? { tsconfigPath } : {}),
          workingDir: this.config.workingDir,
        });
      }
    }
    const builder = new LocalWorkflowBundleBuilder({
      agentName: compilation.manifest.config.name,
      appRoot,
      compiledArtifactsBootstrapPath: generatedArtifacts.bootstrapPath,
      outDir: join(workflowBuildDirectory, "cache"),
      rootDir: resolvePackageRoot(),
      watch: false,
    });
    await builder.build({ nitroStepOutfile: workflowStepsPath, nitroWorkflowOutfile: workflowBundlePath });
    await builder.buildStepRegistrations(workflowStepsPath, generatedArtifacts.bootstrapPath);
    const workflowHandler = await import(pathToFileURL(workflowBundlePath).href) as {
      POST: (request: Request) => Promise<Response>;
    };
    const workflowWorld = createWorld({
      dataDir: workflowDataDirectory,
      recoverActiveRuns: false,
      streamFlushIntervalMs: 1,
      tag: "adaam-earnings-live-smoke",
    });
    workflowWorld.registerHandler(
      deriveEveWorkflowQueuePrefix(compilation.manifest.config.name),
      workflowHandler.POST,
    );
    setWorld(workflowWorld);
    await workflowWorld.start();
    try {
      const compileDirectory = resolve(".eve/compile");
      const moduleMapModule = await import(`${pathToFileURL(resolve(compileDirectory, "module-map.mjs")).href}?${Date.now()}`);
      return await withBundledCompiledArtifacts({
        manifest: compilation.manifest,
        metadata: compilation.metadata,
        moduleMap: moduleMapModule.moduleMap as Parameters<typeof withBundledCompiledArtifacts>[0]["moduleMap"],
        sessionId: "earnings-call-routing-live-smoke",
      }, run);
    } finally {
      setWorld(undefined);
      await workflowWorld.clear();
      await workflowWorld.close();
    }
  } finally {
    await rm(workflowDataDirectory, { force: true, recursive: true });
    await rm(workflowBuildDirectory, { force: true, recursive: true });
  }
}

function eventForArtifact(artifact: EarningsCallTransientArtifact) {
  const payload = artifact.fact.payload;
  assert.equal(payload.schemaVersion, "earnings-call-event/v1");
  if (payload.schemaVersion !== "earnings-call-event/v1") throw new Error("live_payload_invalid");
  return earningsEventSchema.parse({
    artifactByteCount: payload.artifactByteCount, artifactDigest: payload.artifactDigest, callDate: payload.callDate,
    cik: payload.cik, eventId: artifact.fact.logicalKey, fiscalPeriod: payload.fiscalPeriod,
    observedAt: artifact.fact.createdObservedAt, publishedAt: payload.secContext?.acceptanceDateTime ?? `${payload.callDate}T00:00:00.000Z`,
    recordType: "earnings_call_event", revision: 1, revisionId: artifact.fact.revisionId, schemaVersion: 1,
    secAccession: payload.secContext?.accessionNumber ?? null, sourceInstanceId: artifact.fact.sourceInstanceId,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function boundedTranscript(input: {
  event: ReturnType<typeof eventForArtifact>;
  normalized: Extract<Awaited<ReturnType<typeof normalizeEarningsCallTranscript>>, { state: "accepted" }>;
}) {
  const prepared = input.normalized.transcript.sections.find(({ sectionKind }) =>
    sectionKind === "prepared_remarks");
  const questionsAndAnswers = input.normalized.transcript.sections.find(({ sectionKind }) =>
    sectionKind === "questions_and_answers");
  assert.ok(prepared && questionsAndAnswers);
  const html = [
    `<p>${input.event.fiscalPeriod} earnings conference transcript</p>`,
    "<h2>Prepared Remarks</h2>",
    `<p>${escapeHtml(input.normalized.normalizedText.slice(
      prepared.start,
      Math.min(prepared.end, prepared.start + MAXIMUM_SMOKE_CHARACTERS_PER_SECTION),
    ))}</p>`,
    "<h2>Questions and Answers</h2>",
    `<p>${escapeHtml(input.normalized.normalizedText.slice(
      questionsAndAnswers.start,
      Math.min(
        questionsAndAnswers.end,
        questionsAndAnswers.start + MAXIMUM_SMOKE_CHARACTERS_PER_SECTION,
      ),
    ))}</p>`,
  ].join("\n");
  const bytes = Buffer.from(html);
  const artifactDigest = sha256(bytes);
  const normalized = await normalizeEarningsCallTranscript({
    artifactBytes: bytes,
    artifactDigest,
    artifactMediaType: "text/html",
    eventRevisionId: input.event.revisionId,
    fiscalPeriod: input.event.fiscalPeriod,
  });
  assert.equal(normalized.state, "accepted", `${input.event.fiscalPeriod} bounded transcript must normalize`);
  if (normalized.state !== "accepted") throw new Error("bounded_live_transcript_not_accepted");
  return {
    event: earningsEventSchema.parse({
      ...input.event,
      artifactByteCount: bytes.byteLength,
      artifactDigest,
    }),
    normalized,
  };
}

const transport = await startTransport();
process.env.EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_TOKEN = transport.token;
process.env.EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_URL = transport.url;
try {
  const acquisition = await runSharedEarningsCallPublicSourceAcquisition({
    client: new MemoryCas(), fetchResponse: createEarningsCallPublicSourceFetch(), sourceId, userAgent,
    window: { endAt: now.toISOString(), startAt: new Date(now.getTime() - 24 * 60 * 60_000).toISOString() },
  });
  assert.equal(acquisition.acquisition.status, "complete");
  const selected = acquisition.transientArtifacts.filter(({ fact }) => fact.payload.schemaVersion === "earnings-call-event/v1" && ["FY2026-Q2", "FY2026-Q1"].includes(fact.payload.fiscalPeriod));
  assert.equal(selected.length, 2);
  const evidence: EarningsCallSemanticEvidenceInput[] = [];
  const records = [];
  for (const transient of selected) {
    let event = eventForArtifact(transient);
    const full = await normalizeEarningsCallTranscript({ artifactBytes: transient.artifactBytes, artifactDigest: transient.artifactDigest, artifactMediaType: transient.artifactMediaType, eventRevisionId: event.revisionId, fiscalPeriod: event.fiscalPeriod });
    assert.equal(full.state, "accepted", `${event.fiscalPeriod} must normalize deterministically`);
    if (full.state !== "accepted") throw new Error("live_transcript_not_accepted");
    const bounded = await boundedTranscript({ event, normalized: full });
    event = bounded.event;
    const normalized = bounded.normalized;
    const artifact = await artifacts.persist({
      acquisitionId: acquisition.acquisition.acquisitionId, authority: new URL(transient.artifactUrl).hostname,
      bytes: Buffer.from(normalized.normalizedText), canonicalPublicUrl: transient.artifactUrl, mediaType: "text/plain",
      observedAt: now.toISOString(), parserEligibility: null, sourceInstanceId: transient.fact.sourceInstanceId,
      structure: { characterCount: normalized.normalizedText.length, columnCount: null, pageCount: null, rowCount: null, sheetCount: null },
    });
    const subscription = publicSourceSubscriptionSchema.parse({
      adapterDefinitionDigest: reviewedSource.adapterDefinition.definitionDigest,
      adapterVersion: reviewedSource.adapterDefinition.adapterVersion,
      deliveryCursor: { lastAcquisitionId: acquisition.acquisition.acquisitionId, revision: 1 }, factSchemaVersions: ["earnings-call-event/v1"],
      filter: { kind: "all" }, lifecycleState: "active", monitorId: "monitor.live.routing.smoke",
      packBinding: { bindingRevision: 1, packContentDigest: pack.contentDigest, packId: pack.id, packVersion: pack.version },
      recordType: "public_source_subscription", schemaVersion: 1, sourceInstanceId: transient.fact.sourceInstanceId,
      subscriptionId: `subscription.${sha256(`${workspaceId}:${event.revisionId}`)}`, workspaceId,
    });
    const projection = publicSourceProjectionSchema.parse({
      acquisitionId: acquisition.acquisition.acquisitionId, factRevisionId: event.revisionId, factSchemaVersion: transient.fact.factSchemaVersion,
      monitorId: subscription.monitorId, projectedAt: now.toISOString(), projectionId: `projection.${digestPublicSourceValue([subscription.subscriptionId, event.revisionId])}`,
      recordType: "public_source_fact_projection", schemaVersion: 1, sourceInstanceId: transient.fact.sourceInstanceId, subscriptionId: subscription.subscriptionId, workspaceId,
    });
    const authorizationProjection: WorkspaceSemanticAuthorizationProjection = { fact: canonicalPublicFactRevisionSchema.parse(transient.fact), projection, sourceId, subscription };
    sourceFacts.set(event.revisionId, authorizationProjection.fact);
    projections.set(event.revisionId, authorizationProjection);
    evidence.push({
      artifact, normalizedText: normalized.normalizedText,
      projectionReference: { factRevisionId: event.revisionId, sourceId, subscriptionId: subscription.subscriptionId },
      role: event.fiscalPeriod === "FY2026-Q2" ? "current" : "prior",
      sourceFactLocator: { factRevisionId: event.revisionId, kind: "source_fact", payloadDigest: transient.fact.payloadDigest },
      transcript: normalized.transcript,
    });
    records.push({ event, normalizedText: normalized.normalizedText, transcript: normalized.transcript });
  }
  const current = records.find(({ event }) => event.fiscalPeriod === "FY2026-Q2");
  const prior = records.find(({ event }) => event.fiscalPeriod === "FY2026-Q1");
  assert.ok(current && prior);
  const workerProof = { generationIds: [] as string[], modelIds: [] as string[], toolNames: [] as string[], inputTokens: 0, outputTokens: 0, paidCostUsd: 0 };
  const semantic = await withLocalWorkflowWorld(() => runEarningsCallSemanticComparison({
    comparison: createEarningsCallComparison({ current, prior }), environment, evidence, modelId: route.modelId, now,
    pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version }, reasoning: route.reasoning, scope, workspaceGeneration: 1,
  }, {
    artifacts, budget: memory as any, jobs: memory as any, lineage: memory as any, semantic: memory as any, state: memory as any,
    notifyHealth: async () => {}, resolveProjection: async ({ factRevisionId }) => projections.get(factRevisionId) ?? null,
    async execute(prepared) {
      assert.equal(typeof prepared.request.auth.attributes.hybrid_evidence_runtime_token, "string", "signed worker token missing");
      const handle = await startHybridEvidenceWorkerTask(prepared.request);
      const events: MessageStreamEvent[] = [];
      for await (const event of handle.events) events.push(event);
      workerProof.modelIds.push(...events.flatMap((event) => event.type === "step.started" ? [event.data.modelId] : []));
      workerProof.toolNames.push(...events.flatMap((event) => event.type === "actions.requested" ? event.data.actions.flatMap((action) => action.kind === "tool-call" ? [action.toolName] : []) : []));
      for (const event of events) if (event.type === "step.completed") {
        const generationId = event.data.providerMetadata?.gateway?.generationId;
        if (generationId) workerProof.generationIds.push(generationId);
        workerProof.inputTokens += event.data.usage?.inputTokens ?? 0;
        workerProof.outputTokens += event.data.usage?.outputTokens ?? 0;
        workerProof.paidCostUsd += event.data.usage?.costUsd ?? 0;
      }
      const completedJob = await readHybridEvidenceJob(prepared.record.job.jobId, memory);
      assert.equal(completedJob?.job.state, "completed", JSON.stringify(events));
      assert.ok(workerProof.modelIds.every((modelId) => modelId === route.modelId));
      assert.ok(workerProof.generationIds.length > 0);
      assert.ok(workerProof.toolNames.includes("read_hybrid_evidence_slice"));
      assert.ok(workerProof.toolNames.includes("complete_hybrid_evidence_job"));
      return { inputTokens: workerProof.inputTokens, outputTokens: workerProof.outputTokens, paidCostUsd: workerProof.paidCostUsd.toFixed(4) };
    },
  }));
  assert.equal(semantic.state, "accepted", JSON.stringify({
    finalDisposition: semantic.final?.evidence?.result.disposition ?? null,
    finalJobState: semantic.final?.record.job.state ?? null,
    quarantineCodes: semantic.final?.record.quarantineCodes ?? [],
    reasonCode: semantic.reasonCode,
    workerProof,
  }));
  assert.ok(semantic.final?.evidence?.result.disposition === "accepted");
  console.info(JSON.stringify({
    acquisitionId: acquisition.acquisition.acquisitionId,
    acceptedCitations: semantic.final.evidence.result.citations,
    executionClass: route.executionClass, modelId: route.modelId,
    pack: { contentDigest: pack.contentDigest, id: pack.id, version: pack.version }, reasoning: route.reasoning,
    signedWorkerPath: { generationIds: workerProof.generationIds, nodeId: "subagents/hybrid-evidence-worker", toolNames: [...new Set(workerProof.toolNames)].sort(), used: true },
    usage: { inputTokens: workerProof.inputTokens, outputTokens: workerProof.outputTokens, paidCostUsd: workerProof.paidCostUsd },
    validation: { disposition: semantic.final.evidence.result.disposition, jobState: semantic.final.record.job.state, status: semantic.final.evidence.validationStatus },
  }, null, 2));
} finally {
  await transport.close();
  delete process.env.EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_TOKEN;
  delete process.env.EVE_HYBRID_EVIDENCE_WORKER_FIXTURE_RPC_URL;
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
