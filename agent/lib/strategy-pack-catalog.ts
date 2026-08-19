import { createHash } from "node:crypto";

import { STRATEGY_PACK_CATALOG_GENERATED } from "./strategy-pack-catalog.generated";
import {
  compareStrategyPackVersions,
  compareStrategyPackText,
  type StrategyPackDefinition,
} from "./strategy-pack-schema";

export type StrategyPackCatalogAvailability =
  | "available"
  | "blocked"
  | "deprecated";

export interface StrategyPackCatalogEntry extends StrategyPackDefinition {
  readonly availability: StrategyPackCatalogAvailability;
}

export interface ModelSafeStrategyPackSummary {
  readonly availability: StrategyPackCatalogAvailability;
  readonly configuration: readonly {
    readonly key: string;
    readonly kind:
      | "bounded_enum"
      | "bounded_text"
      | "bounded_text_list"
      | "bounded_token_list"
      | "canonical_id_list"
      | "catalog_id_list"
      | "daily_local_times"
      | "iana_timezone"
      | "impact_hypothesis_list"
      | "x_public_identity";
    readonly label: string;
    readonly required: boolean;
  }[];
  readonly description: string;
  readonly displayName: string;
  readonly id: string;
  readonly maturity: StrategyPackDefinition["maturity"];
  readonly version: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function catalogKey(id: string, version: string): string {
  return `${id}@${version}`;
}

function modelSafeSummaries(entries: readonly StrategyPackCatalogEntry[]) {
  return deepFreeze(entries.map((entry) => ({
    availability: entry.availability,
    configuration: entry.configuration.map((field) => ({
      key: field.key,
      kind: field.kind,
      label: field.label,
      required: field.required,
    })),
    description: entry.description,
    displayName: entry.displayName,
    id: entry.id,
    maturity: entry.maturity,
    version: entry.version,
  })));
}

export function createStrategyPackCatalog(
  definitions: readonly StrategyPackDefinition[],
  options: {
    blockedVersions?: readonly { readonly id: string; readonly version: string }[];
  } = {},
): {
  readonly catalogDigest: string;
  readonly entries: readonly StrategyPackCatalogEntry[];
  listModelSafe(): readonly ModelSafeStrategyPackSummary[];
  listLatestModelSafe(): readonly ModelSafeStrategyPackSummary[];
  resolve(input: {
    readonly contentDigest?: string;
    readonly id: string;
    readonly version: string;
  }): StrategyPackCatalogEntry | null;
} {
  const blocked = new Set(
    (options.blockedVersions ?? []).map(({ id, version }) => catalogKey(id, version)),
  );
  const seen = new Set<string>();
  const entries = definitions
    .map((definition) => {
      const key = catalogKey(definition.id, definition.version);
      if (seen.has(key)) throw new Error("strategy_pack_catalog_duplicate");
      seen.add(key);
      const availability: StrategyPackCatalogAvailability = blocked.has(key)
        ? "blocked"
        : definition.maturity === "deprecated"
          ? "deprecated"
          : "available";
      return deepFreeze(structuredClone({ ...definition, availability }));
    })
    .sort(
      (left, right) =>
        compareStrategyPackText(left.id, right.id) ||
        compareStrategyPackVersions(left.version, right.version),
    );
  const frozenEntries = deepFreeze(entries) as readonly StrategyPackCatalogEntry[];
  const byKey = new Map(
    frozenEntries.map((entry) => [catalogKey(entry.id, entry.version), entry]),
  );
  const catalogDigest = createHash("sha256")
    .update(JSON.stringify(frozenEntries))
    .digest("hex");

  return Object.freeze({
    catalogDigest,
    entries: frozenEntries,
    listModelSafe(): readonly ModelSafeStrategyPackSummary[] {
      return modelSafeSummaries(frozenEntries);
    },
    listLatestModelSafe(): readonly ModelSafeStrategyPackSummary[] {
      return modelSafeSummaries(frozenEntries.filter((entry, index) =>
        frozenEntries[index + 1]?.id !== entry.id));
    },
    resolve(input): StrategyPackCatalogEntry | null {
      const entry = byKey.get(catalogKey(input.id, input.version)) ?? null;
      if (
        entry &&
        input.contentDigest !== undefined &&
        entry.contentDigest !== input.contentDigest
      ) {
        return null;
      }
      return entry;
    },
  });
}

export const strategyPackCatalog = createStrategyPackCatalog(
  STRATEGY_PACK_CATALOG_GENERATED,
);
