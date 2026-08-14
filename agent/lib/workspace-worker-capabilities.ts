import type { SessionContext } from "eve/context";

import {
  resolveWorkspaceRuntimeCapabilities,
  WorkspaceRuntimeCapabilityError,
  type WorkspaceRuntimeCapabilities,
  type WorkspaceRuntimeTool,
} from "./workspace-runtime-capabilities";
import { readWorkspaceDocument, type WorkspaceStateStoreClient } from "./workspace-state-store";
import { authorizeWorkspaceWorkerStore, type AuthorizedWorkspaceStoreScope } from "./workspace-store-authorization";
import { requireWorkspaceWorkerAuth, type WorkspaceWorkerEnvelope } from "./workspace-worker-auth";

export interface WorkspaceWorkerToolRegistration<T> {
  readonly definition: T;
  readonly metadata: WorkspaceRuntimeTool;
}

export interface WorkspaceWorkerCapabilitySet<T> {
  readonly resolved: WorkspaceRuntimeCapabilities;
  readonly skillIds: readonly string[];
  readonly tools: Readonly<Record<string, T>>;
}

export async function resolveWorkspaceWorkerCapabilitySnapshot<T>(input: {
  deploymentHardDeniedIds?: readonly string[];
  envelope: Pick<WorkspaceWorkerEnvelope, "capabilityRevision" | "ownerId" | "sources" | "workspaceId">;
  registry: readonly WorkspaceWorkerToolRegistration<T>[];
  scope: AuthorizedWorkspaceStoreScope;
  stateClient?: WorkspaceStateStoreClient;
}): Promise<WorkspaceWorkerCapabilitySet<T>> {
  const manifest = await readWorkspaceDocument(
    "capabilities",
    input.scope,
    input.stateClient,
  );
  if (!manifest) {
    throw new WorkspaceRuntimeCapabilityError("capability_manifest_stale");
  }
  const resolved = resolveWorkspaceRuntimeCapabilities({
    catalog: input.registry.map((registration) => registration.metadata),
    deploymentHardDeniedIds: input.deploymentHardDeniedIds,
    expectedCapabilityRevision: input.envelope.capabilityRevision,
    manifest,
    ownerId: input.envelope.ownerId,
    workspaceId: input.envelope.workspaceId,
  });
  const allowedSources = new Map(
    manifest.value.sources.map((source) => [source.sourceId, source.origin]),
  );
  if (input.envelope.sources.some(
    (source) => allowedSources.get(source.sourceId) !== source.origin,
  )) {
    throw new WorkspaceRuntimeCapabilityError("capability_scope_mismatch");
  }
  const allowedTools = new Set(resolved.toolIds);
  const tools = Object.freeze(Object.fromEntries(
    input.registry
      .filter((registration) => allowedTools.has(registration.metadata.id))
      .map((registration) => [registration.metadata.id, registration.definition]),
  ));
  return Object.freeze({
    resolved,
    skillIds: resolved.skillIds,
    tools,
  });
}

export async function resolveWorkspaceWorkerStepCapabilities<T>(input: {
  ctx: { readonly session: { readonly auth: SessionContext["session"]["auth"] } };
  deploymentHardDeniedIds?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  registry: readonly WorkspaceWorkerToolRegistration<T>[];
  stateClient?: WorkspaceStateStoreClient;
}): Promise<WorkspaceWorkerCapabilitySet<T>> {
  const envelope = requireWorkspaceWorkerAuth(
    input.ctx,
    {},
    input.environment,
  );
  const scope = authorizeWorkspaceWorkerStore(input.ctx, input.environment);
  return resolveWorkspaceWorkerCapabilitySnapshot({
    deploymentHardDeniedIds: input.deploymentHardDeniedIds,
    envelope,
    registry: input.registry,
    scope,
    stateClient: input.stateClient,
  });
}
