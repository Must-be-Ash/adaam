import type { SessionContext } from "eve/context";

import {
  strategyPackCatalog,
  type StrategyPackCatalogEntry,
} from "./strategy-pack-catalog";
import { resolveStrategyPackFlags } from "./strategy-pack-flags";
import type { StrategyPackDefinition } from "./strategy-pack-schema";
import type { WorkspaceMonitor } from "./workspace-monitor-store";
import {
  readWorkspaceDocument,
  type WorkspaceCapabilityManifestValue,
  type WorkspaceStateStoreClient,
  type WorkspaceStrategyBindingValue,
} from "./workspace-state-store";
import type { AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import { authorizePhotonWorkspaceToolStore } from "./workspace-store-authorization";
import { requirePhotonWorkspaceToolScope } from "./workspace-runtime-scope";
import { SHARED_RUNTIME_HARD_DENIED_CAPABILITIES } from "./workspace-runtime-capabilities";
import {
  strategyPackWorkerSnapshotSchema,
  type StrategyPackWorkerSnapshot,
} from "./strategy-pack-runtime-schema";
export {
  strategyPackWorkerSnapshotSchema,
  type StrategyPackWorkerSnapshot,
} from "./strategy-pack-runtime-schema";

export interface ActiveInteractiveStrategyPackRuntime {
  readonly pack: Readonly<{
    contentDigest: string;
    id: string;
    version: string;
  }>;
  readonly skills: readonly Readonly<{
    description: string;
    id: string;
    instruction: string;
    version: string;
  }>[];
  readonly snapshot: Readonly<{
    bindingRevision: number;
    capabilityManifestRevision: number;
    packContentDigest: string;
    packId: string;
    packVersion: string;
    workspaceGeneration: number;
  }>;
  readonly state: "active";
  readonly workspaceInstruction: string;
}

export type InteractiveStrategyPackRuntime =
  | ActiveInteractiveStrategyPackRuntime
  | Readonly<{ state: "unbound" }>;

export const STRATEGY_PACK_RUNTIME_UNAVAILABLE_INSTRUCTION = [
  "The installed workspace strategy pack is unavailable or stale.",
  "Do not perform general-purpose or pack-specific research in this session.",
  "Do not invoke workspace mutations, monitors, or delegated workers.",
  "Tell the owner that this workspace is paused until its exact strategy-pack binding is repaired.",
].join("\n");

export interface ActiveWorkspaceWorkerStrategyPackRuntime {
  readonly pack: ActiveInteractiveStrategyPackRuntime["pack"];
  readonly resource: Readonly<
    StrategyPackDefinition["monitors"][number] & { readonly instruction: string }
  >;
  readonly skills: ActiveInteractiveStrategyPackRuntime["skills"];
  readonly snapshot: StrategyPackWorkerSnapshot;
}

export class StrategyPackRuntimeError extends Error {
  readonly code:
    | "strategy_pack_runtime_stale"
    | "strategy_pack_runtime_unavailable";

  constructor(code: StrategyPackRuntimeError["code"]) {
    super(code);
    this.code = code;
    this.name = "StrategyPackRuntimeError";
  }
}

export type StrategyPackRuntimeCatalog = typeof strategyPackCatalog;
type Catalog = StrategyPackRuntimeCatalog;

function stale(): never {
  throw new StrategyPackRuntimeError("strategy_pack_runtime_stale");
}

function unavailable(): never {
  throw new StrategyPackRuntimeError("strategy_pack_runtime_unavailable");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function currentSnapshot(binding: WorkspaceStrategyBindingValue) {
  return binding.pendingSnapshot ?? binding.lastActiveSnapshot;
}

function exactCapabilities(
  capabilities: WorkspaceCapabilityManifestValue,
  pack: StrategyPackCatalogEntry,
): boolean {
  const availableTools = new Set([
    ...capabilities.controlPlaneToolIds,
    ...capabilities.financialToolIds,
    ...capabilities.researchToolIds,
    ...capabilities.providerTools.map(({ toolId }) => toolId),
  ]);
  const skills = new Map(
    capabilities.skills.map((skill) => [skill.id, skill.version]),
  );
  const sources = new Map(
    capabilities.sources.map((source) => [source.sourceId, source]),
  );
  const hardDenied = new Set([
    ...SHARED_RUNTIME_HARD_DENIED_CAPABILITIES,
    ...capabilities.hardDeniedCapabilityIds,
  ]);
  if (
    pack.capabilities.hardDenied.some(
      (capabilityId) =>
        !capabilities.hardDeniedCapabilityIds.includes(capabilityId),
    ) ||
    pack.capabilities.required.some((capabilityId) => {
      const skillId = capabilityId.startsWith("skill.")
        ? capabilityId.slice("skill.".length)
        : null;
      return hardDenied.has(capabilityId) ||
        (skillId !== null && hardDenied.has(skillId)) ||
        (skillId !== null
          ? !skills.has(skillId)
          : !availableTools.has(capabilityId));
    }) ||
    pack.skills.some((skill) => skills.get(skill.id) !== skill.version)
  ) {
    return false;
  }
  return pack.sources.every((source) => {
    const capability = sources.get(source.sourceId);
    return (
      capability !== undefined &&
      "contractDigest" in capability &&
      capability.contractDigest === source.contractDigest &&
      capability.contractVersion === source.contractVersion &&
      capability.origin === new URL(source.canonicalUrl).origin &&
      sameStrings(capability.allowedOrigins, source.allowedOrigins)
    );
  });
}

function exactSnapshot(input: {
  binding: WorkspaceStrategyBindingValue;
  capabilityRevision: number;
  pack: StrategyPackCatalogEntry;
  workspaceGeneration: number;
}) {
  const snapshot = currentSnapshot(input.binding);
  if (
    !snapshot ||
    snapshot.bindingRevision !== input.binding.bindingRevision ||
    snapshot.capabilityManifestRevision !== input.capabilityRevision ||
    snapshot.packContentDigest !== input.pack.contentDigest ||
    snapshot.packId !== input.pack.id ||
    snapshot.packVersion !== input.pack.version ||
    snapshot.workspaceGeneration !== input.workspaceGeneration
  ) {
    stale();
  }
  return Object.freeze({ ...snapshot });
}

async function resolveActiveRuntime(input: {
  catalog: Catalog;
  environment: NodeJS.ProcessEnv;
  scope: AuthorizedWorkspaceStoreScope;
  stateClient?: WorkspaceStateStoreClient;
  workspaceGeneration: number;
}): Promise<ActiveInteractiveStrategyPackRuntime | null> {
  const strategy = await readWorkspaceDocument(
    "strategy",
    input.scope,
    input.stateClient,
  );
  if (!strategy) return unavailable();
  if (strategy.schemaVersion !== 2) {
    return strategy.value.strategyPack === null &&
      Object.keys(strategy.value.configuration).length === 0
      ? null
      : unavailable();
  }
  const binding = strategy.value;
  if (binding.lifecycleState === "unbound") return null;
  if (!resolveStrategyPackFlags(input.environment).runtimeComposition) {
    return unavailable();
  }
  if (
    binding.lifecycleState !== "active" ||
    binding.health.status !== "healthy" ||
    binding.health.code !== null ||
    !binding.pack?.contentDigest ||
    binding.effectiveCapabilityManifestRevision === null
  ) {
    return unavailable();
  }
  const pack = input.catalog.resolve({
    contentDigest: binding.pack.contentDigest,
    id: binding.pack.id,
    version: binding.pack.version,
  });
  if (!pack || pack.availability !== "available") return unavailable();
  const capabilities = await readWorkspaceDocument(
    "capabilities",
    input.scope,
    input.stateClient,
  );
  if (
    !capabilities ||
    capabilities.revision !== binding.effectiveCapabilityManifestRevision ||
    !exactCapabilities(capabilities.value, pack)
  ) {
    return stale();
  }
  const snapshot = exactSnapshot({
    binding,
    capabilityRevision: capabilities.revision,
    pack,
    workspaceGeneration: input.workspaceGeneration,
  });
  return Object.freeze({
    pack: Object.freeze({
      contentDigest: pack.contentDigest,
      id: pack.id,
      version: pack.version,
    }),
    skills: Object.freeze(
      pack.skills.map((skill) =>
        Object.freeze({
          description: skill.description,
          id: skill.id,
          instruction: skill.instruction,
          version: skill.version,
        }),
      ),
    ),
    snapshot,
    state: "active",
    workspaceInstruction: pack.workspaceInstruction,
  });
}

export async function resolveInteractiveStrategyPackRuntime(input: {
  readonly catalog?: Catalog;
  readonly environment?: NodeJS.ProcessEnv;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly stateClient?: WorkspaceStateStoreClient;
  readonly workspaceGeneration: number;
}): Promise<InteractiveStrategyPackRuntime> {
  const runtime = await resolveActiveRuntime({
    catalog: input.catalog ?? strategyPackCatalog,
    environment: input.environment ?? process.env,
    scope: input.scope,
    stateClient: input.stateClient,
    workspaceGeneration: input.workspaceGeneration,
  });
  return runtime ?? Object.freeze({ state: "unbound" as const });
}

export async function resolveSessionStrategyPackRuntime(input: {
  readonly catalog?: Catalog;
  readonly ctx: {
    readonly session: { readonly auth: SessionContext["session"]["auth"] };
  };
  readonly environment?: NodeJS.ProcessEnv;
  readonly stateClient?: WorkspaceStateStoreClient;
}): Promise<InteractiveStrategyPackRuntime | null> {
  const auth = input.ctx.session.auth.current;
  if (
    !auth ||
    auth.authenticator !== "photon-imessage-webhook" ||
    auth.principalType !== "user" ||
    auth.attributes.channel !== "photon"
  ) {
    return null;
  }
  const workspaceAttributeNames = [
    "conversation_id",
    "owner_id",
    "scope_version",
    "workspace_generation",
    "workspace_id",
  ] as const;
  if (
    workspaceAttributeNames.every(
      (name) => auth.attributes[name] === undefined,
    )
  ) {
    return null;
  }
  const environment = input.environment ?? process.env;
  const runtimeScope = requirePhotonWorkspaceToolScope(input.ctx, {}, environment);
  const scope = authorizePhotonWorkspaceToolStore(input.ctx, runtimeScope, environment);
  return resolveInteractiveStrategyPackRuntime({
    catalog: input.catalog,
    environment,
    scope,
    stateClient: input.stateClient,
    workspaceGeneration: runtimeScope.generation,
  });
}

function exactMonitorSources(
  monitor: WorkspaceMonitor,
  pack: StrategyPackCatalogEntry,
  resource: StrategyPackCatalogEntry["monitors"][number],
): boolean {
  const sources = new Map(pack.sources.map((source) => [source.sourceId, source]));
  return (
    sameStrings(
      monitor.sources.map(({ sourceId }) => sourceId).sort(),
      [...resource.sourceIds].sort(),
    ) &&
    monitor.sources.every((source) => {
      const expected = sources.get(source.sourceId);
      return (
        expected !== undefined &&
        source.accessClassification === expected.accessClassification &&
        source.canonicalUrl === expected.canonicalUrl &&
        source.origin === new URL(expected.canonicalUrl).origin
      );
    })
  );
}

export async function requireWorkspaceWorkerStrategyPackRuntime(input: {
  readonly catalog?: Catalog;
  readonly envelope: Readonly<{
    capabilityRevision: number;
    sources: WorkspaceMonitor["sources"];
    strategyPack: StrategyPackWorkerSnapshot | null;
  }>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly monitor: WorkspaceMonitor;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly stateClient?: WorkspaceStateStoreClient;
}): Promise<ActiveWorkspaceWorkerStrategyPackRuntime | null> {
  const environment = input.environment ?? process.env;
  const snapshot = input.envelope.strategyPack;
  const provenance = input.monitor.managedBy ?? null;
  if ((snapshot === null) !== (provenance === null)) return stale();
  if (snapshot === null && provenance === null) return null;
  const strategy = await readWorkspaceDocument(
    "strategy",
    input.scope,
    input.stateClient,
  );
  if (snapshot === null || provenance === null) return stale();
  if (!resolveStrategyPackFlags(environment).managedDispatch) return unavailable();
  const parsedSnapshot = strategyPackWorkerSnapshotSchema.safeParse(snapshot);
  if (!parsedSnapshot.success) return stale();
  const runtime = await resolveActiveRuntime({
    catalog: input.catalog ?? strategyPackCatalog,
    environment,
    scope: input.scope,
    stateClient: input.stateClient,
    workspaceGeneration: snapshot.workspaceGeneration,
  });
  if (!runtime || strategy?.schemaVersion !== 2) return stale();
  const binding = strategy.value;
  const pack = (input.catalog ?? strategyPackCatalog).resolve({
    contentDigest: runtime.pack.contentDigest,
    id: runtime.pack.id,
    version: runtime.pack.version,
  });
  const managed = binding.managedResources[snapshot.resourceId];
  const resource = pack?.monitors.find(
    (candidate) => candidate.resourceId === snapshot.resourceId,
  );
  if (
    !pack ||
    !managed ||
    !resource ||
    input.envelope.capabilityRevision !== snapshot.capabilityManifestRevision ||
    JSON.stringify(runtime.snapshot) !==
      JSON.stringify({
        bindingRevision: snapshot.bindingRevision,
        capabilityManifestRevision: snapshot.capabilityManifestRevision,
        packContentDigest: snapshot.packContentDigest,
        packId: snapshot.packId,
        packVersion: snapshot.packVersion,
        workspaceGeneration: snapshot.workspaceGeneration,
      }) ||
    managed.monitorId !== input.monitor.monitorId ||
    !sameStrings(managed.sourceIds, [...resource.sourceIds]) ||
    provenance.bindingRevision !== snapshot.bindingRevision ||
    provenance.packContentDigest !== snapshot.packContentDigest ||
    provenance.packId !== snapshot.packId ||
    provenance.packVersion !== snapshot.packVersion ||
    provenance.resourceId !== snapshot.resourceId ||
    input.monitor.instruction !== resource.instruction.trim() ||
    !sameStrings(
      input.monitor.requiredCapabilityIds,
      resource.requiredCapabilityIds,
    ) ||
    JSON.stringify(input.monitor.sources) !== JSON.stringify(input.envelope.sources) ||
    !exactMonitorSources(input.monitor, pack, resource)
  ) {
    return stale();
  }
  return Object.freeze({
    pack: runtime.pack,
    resource: Object.freeze({ ...resource }),
    skills: runtime.skills,
    snapshot: Object.freeze({ ...snapshot }),
  });
}

export async function prepareWorkspaceWorkerStrategyPackRuntime(input: {
  readonly catalog?: Catalog;
  readonly environment?: NodeJS.ProcessEnv;
  readonly monitor: WorkspaceMonitor;
  readonly scope: AuthorizedWorkspaceStoreScope;
  readonly stateClient?: WorkspaceStateStoreClient;
}): Promise<ActiveWorkspaceWorkerStrategyPackRuntime | null> {
  const strategy = await readWorkspaceDocument(
    "strategy",
    input.scope,
    input.stateClient,
  );
  if (!strategy) return unavailable();
  const provenance = input.monitor.managedBy ?? null;
  if (provenance === null) return null;
  if (strategy.schemaVersion !== 2) {
    return unavailable();
  }
  const snapshot = currentSnapshot(strategy.value);
  if (!snapshot || !provenance) return stale();
  return requireWorkspaceWorkerStrategyPackRuntime({
    catalog: input.catalog,
    envelope: {
      capabilityRevision: snapshot.capabilityManifestRevision,
      sources: input.monitor.sources,
      strategyPack: {
        ...snapshot,
        resourceId: provenance.resourceId,
      },
    },
    environment: input.environment,
    monitor: input.monitor,
    scope: input.scope,
    stateClient: input.stateClient,
  });
}
