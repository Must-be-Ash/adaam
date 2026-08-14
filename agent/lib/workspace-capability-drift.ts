import { z } from "zod";

import {
  SHARED_RUNTIME_HARD_DENIED_CAPABILITIES,
  type WorkspaceRuntimeTool,
} from "./workspace-runtime-capabilities";
import type { WorkspaceCapabilityManifestValue } from "./workspace-state-store";

const MAX_DRIFT_ENTRIES = 128;
const providerToolSchema = z.object({
  kind: z.enum(["read", "mutation"]),
  providerId: z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u),
  schemaDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  toolId: z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u),
}).strict();

export const UNAVAILABLE_CAPABILITY_REASONS = [
  "authorization",
  "safety_policy",
  "runtime_restriction",
  "missing_integration",
  "provider_drift",
] as const;

export type UnavailableCapabilityReasonCode =
  (typeof UNAVAILABLE_CAPABILITY_REASONS)[number];
export type ProviderDriftKind =
  | "new_mutation"
  | "new_read"
  | "removed"
  | "schema_changed";

export interface ProviderDriftEntry {
  readonly kind: ProviderDriftKind;
  readonly providerId: string;
  readonly reviewedSchemaDigest: string | null;
  readonly runtimeSchemaDigest: string | null;
  readonly toolId: string;
}

export interface ProviderDriftReport {
  readonly entries: readonly ProviderDriftEntry[];
  readonly status: "clean" | "drifted";
}

export interface CapabilityAvailability {
  readonly available: boolean;
  readonly reason: null | {
    readonly code: UnavailableCapabilityReasonCode;
    readonly providerId?: string;
    readonly toolId: string;
  };
}

export class ProviderInventoryError extends Error {
  readonly code = "capability_catalog_invalid";

  constructor() {
    super("The provider tool inventory is invalid or exceeds its bound.");
    this.name = "ProviderInventoryError";
  }
}

function inventory(
  values: readonly z.input<typeof providerToolSchema>[],
): Map<string, z.infer<typeof providerToolSchema>> {
  const parsed = z.array(providerToolSchema).max(256).safeParse(values);
  if (!parsed.success) throw new ProviderInventoryError();
  const result = new Map<string, z.infer<typeof providerToolSchema>>();
  for (const tool of parsed.data) {
    const key = `${tool.providerId}\0${tool.toolId}`;
    if (result.has(key)) throw new ProviderInventoryError();
    result.set(key, tool);
  }
  return result;
}

export function reportProviderToolDrift(input: {
  current: readonly z.input<typeof providerToolSchema>[];
  reviewed: readonly z.input<typeof providerToolSchema>[];
}): ProviderDriftReport {
  const current = inventory(input.current);
  const reviewed = inventory(input.reviewed);
  const entries: ProviderDriftEntry[] = [];
  for (const [key, tool] of reviewed) {
    const observed = current.get(key);
    if (!observed) {
      entries.push({
        kind: "removed",
        providerId: tool.providerId,
        reviewedSchemaDigest: tool.schemaDigest,
        runtimeSchemaDigest: null,
        toolId: tool.toolId,
      });
    } else if (
      observed.schemaDigest !== tool.schemaDigest ||
      observed.kind !== tool.kind
    ) {
      entries.push({
        kind: "schema_changed",
        providerId: tool.providerId,
        reviewedSchemaDigest: tool.schemaDigest,
        runtimeSchemaDigest: observed.schemaDigest,
        toolId: tool.toolId,
      });
    }
  }
  for (const [key, tool] of current) {
    if (reviewed.has(key)) continue;
    entries.push({
      kind: tool.kind === "mutation" ? "new_mutation" : "new_read",
      providerId: tool.providerId,
      reviewedSchemaDigest: null,
      runtimeSchemaDigest: tool.schemaDigest,
      toolId: tool.toolId,
    });
  }
  entries.sort((left, right) =>
    `${left.providerId}\0${left.toolId}\0${left.kind}`.localeCompare(
      `${right.providerId}\0${right.toolId}\0${right.kind}`,
    ),
  );
  if (entries.length > MAX_DRIFT_ENTRIES) throw new ProviderInventoryError();
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    status: entries.length === 0 ? "clean" : "drifted",
  });
}

function unavailable(
  code: UnavailableCapabilityReasonCode,
  toolId: string,
  providerId?: string,
): CapabilityAvailability {
  return Object.freeze({
    available: false,
    reason: Object.freeze({ code, ...(providerId ? { providerId } : {}), toolId }),
  });
}

export function workspaceCapabilityAvailability(input: {
  authorizedConnectionIds?: readonly string[];
  catalog: readonly WorkspaceRuntimeTool[];
  deploymentHardDeniedIds?: readonly string[];
  manifest: WorkspaceCapabilityManifestValue;
  providerId?: string;
  toolId: string;
}): CapabilityAvailability {
  const hardDenied = new Set([
    ...SHARED_RUNTIME_HARD_DENIED_CAPABILITIES,
    ...input.manifest.hardDeniedCapabilityIds,
    ...(input.deploymentHardDeniedIds ?? []),
  ]);
  if (hardDenied.has(input.toolId)) {
    return unavailable("safety_policy", input.toolId, input.providerId);
  }
  const catalogTool = input.catalog.find((tool) => tool.id === input.toolId);
  if (catalogTool?.category === "financial") {
    return unavailable("runtime_restriction", input.toolId, input.providerId);
  }

  const granted =
    input.manifest.controlPlaneToolIds.includes(input.toolId) ||
    input.manifest.researchToolIds.includes(input.toolId);
  if (!input.providerId) {
    if (!catalogTool) return unavailable("missing_integration", input.toolId);
    return granted
      ? Object.freeze({ available: true, reason: null })
      : unavailable("runtime_restriction", input.toolId);
  }

  const reviewed = input.manifest.providerTools.find(
    (tool) =>
      tool.providerId === input.providerId && tool.toolId === input.toolId,
  );
  const current = catalogTool?.providerId === input.providerId
    ? catalogTool
    : undefined;
  if (!reviewed || !current || reviewed.schemaDigest !== current.schemaDigest) {
    return unavailable("provider_drift", input.toolId, input.providerId);
  }
  if (reviewed.kind === "mutation" || current.category === "financial") {
    return unavailable("runtime_restriction", input.toolId, input.providerId);
  }
  if (!granted) {
    return unavailable("runtime_restriction", input.toolId, input.providerId);
  }
  if (!(input.authorizedConnectionIds ?? []).includes(input.providerId)) {
    return unavailable("authorization", input.toolId, input.providerId);
  }
  return Object.freeze({ available: true, reason: null });
}
