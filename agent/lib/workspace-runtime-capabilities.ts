import { z } from "zod";

import type { WorkspaceDocument } from "./workspace-state-store";

export const WORKSPACE_RUNTIME_CAPABILITY_EVENT = "step.started" as const;

export const SHARED_RUNTIME_HARD_DENIED_CAPABILITIES = Object.freeze([
  "broker.mutation",
  "coinbase_create_order",
  "coinbase_mcp",
  "filesystem.write",
  "masterkey_mcp",
  "session.manager",
] as const);

const toolSchema = z.object({
  category: z.enum(["control_plane", "financial", "research"]),
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u),
  providerId: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u)
    .optional(),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

export type WorkspaceRuntimeTool = z.infer<typeof toolSchema>;

export interface WorkspaceRuntimeCapabilities {
  readonly capabilityRevision: number;
  readonly connectionIds: readonly string[];
  readonly paidResearchAllowed: boolean;
  readonly skillIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly toolIds: readonly string[];
  readonly workerModelIds: readonly string[];
}

export class WorkspaceRuntimeCapabilityError extends Error {
  readonly code:
    | "capability_catalog_invalid"
    | "capability_manifest_stale"
    | "capability_scope_mismatch";

  constructor(code: WorkspaceRuntimeCapabilityError["code"]) {
    super(code);
    this.code = code;
    this.name = "WorkspaceRuntimeCapabilityError";
  }
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

export function emptyWorkspaceRuntimeCapabilities(
  capabilityRevision = 0,
): WorkspaceRuntimeCapabilities {
  return Object.freeze({
    capabilityRevision,
    connectionIds: Object.freeze([]),
    paidResearchAllowed: false,
    skillIds: Object.freeze([]),
    sourceIds: Object.freeze([]),
    toolIds: Object.freeze([]),
    workerModelIds: Object.freeze([]),
  });
}

export function resolveWorkspaceRuntimeCapabilities(input: {
  catalog: readonly WorkspaceRuntimeTool[];
  deploymentHardDeniedIds?: readonly string[];
  expectedCapabilityRevision: number;
  ownerId: string;
  manifest: WorkspaceDocument<"capabilities"> | null;
  workspaceId: string;
}): WorkspaceRuntimeCapabilities {
  if (!input.manifest) {
    return emptyWorkspaceRuntimeCapabilities(input.expectedCapabilityRevision);
  }
  if (
    input.manifest.ownerId !== input.ownerId ||
    input.manifest.workspaceId !== input.workspaceId
  ) {
    throw new WorkspaceRuntimeCapabilityError("capability_scope_mismatch");
  }
  if (input.manifest.revision !== input.expectedCapabilityRevision) {
    throw new WorkspaceRuntimeCapabilityError("capability_manifest_stale");
  }

  const catalog = z.array(toolSchema).max(256).safeParse(input.catalog);
  if (!catalog.success) {
    throw new WorkspaceRuntimeCapabilityError("capability_catalog_invalid");
  }
  const catalogIds = new Set<string>();
  for (const tool of catalog.data) {
    if (catalogIds.has(tool.id)) {
      throw new WorkspaceRuntimeCapabilityError("capability_catalog_invalid");
    }
    catalogIds.add(tool.id);
  }

  const manifest = input.manifest.value;
  const hardDenied = new Set([
    ...SHARED_RUNTIME_HARD_DENIED_CAPABILITIES,
    ...manifest.hardDeniedCapabilityIds,
    ...(input.deploymentHardDeniedIds ?? []),
  ]);
  const control = new Set(manifest.controlPlaneToolIds);
  const research = new Set(manifest.researchToolIds);
  const reviewedProviderTools = new Map(
    manifest.providerTools.map((tool) => [
      `${tool.providerId}\0${tool.toolId}`,
      tool,
    ]),
  );

  const toolIds = catalog.data
    .filter((tool) => {
      if (hardDenied.has(tool.id) || tool.category === "financial") return false;
      if (tool.category === "control_plane" && !control.has(tool.id)) return false;
      if (tool.category === "research" && !research.has(tool.id)) return false;
      if (!tool.providerId) return tool.schemaDigest === undefined;
      if (!tool.schemaDigest) return false;
      const reviewed = reviewedProviderTools.get(
        `${tool.providerId}\0${tool.id}`,
      );
      return (
        reviewed?.kind === "read" &&
        reviewed.schemaDigest === tool.schemaDigest
      );
    })
    .map((tool) => tool.id);
  const allowedProviderToolIds = new Set(
    catalog.data
      .filter((tool) => tool.providerId && toolIds.includes(tool.id))
      .map((tool) => tool.id),
  );

  return Object.freeze({
    capabilityRevision: input.manifest.revision,
    connectionIds: sortedUnique(
      manifest.connectionIds.filter((id) => !hardDenied.has(id)),
    ),
    paidResearchAllowed:
      manifest.paidResearchAllowed && allowedProviderToolIds.size > 0,
    skillIds: sortedUnique(
      manifest.skills
        .map((skill) => skill.id)
        .filter((id) => !hardDenied.has(id)),
    ),
    sourceIds: sortedUnique(
      manifest.sources
        .map((source) => source.sourceId)
        .filter((id) => !hardDenied.has(id)),
    ),
    toolIds: sortedUnique(toolIds),
    workerModelIds: sortedUnique(
      manifest.workerModelPolicy.allowedModelIds.filter(
        (id) => !hardDenied.has(id),
      ),
    ),
  });
}
