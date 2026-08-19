import { z } from "zod";

import type {
  PublicSourceAdapterDefinition,
  PublicSourceInstance,
} from "./public-source-adapter-schema";

export const STRATEGY_PACK_SCHEMA_VERSION = 1;
export const STRATEGY_PACK_CORE_SCHEMA_VERSION = 1;
export const STRATEGY_PACK_WORKSPACE_SCHEMA_VERSION = 1;
export const STRATEGY_PACK_CATALOG_ENTRY_LIMIT = 128;

export const STRATEGY_PACK_FILE_LIMITS = Object.freeze({
  aggregate: 128 * 1_024,
  evaluations: 32 * 1_024,
  manifest: 64 * 1_024,
  monitorInstruction: 8 * 1_024,
  playbookInstruction: 32 * 1_024,
  workspaceInstruction: 8 * 1_024,
});

export function compareStrategyPackVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function compareStrategyPackText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const semverSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const packIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const stableIdSchema = z
  .string()
  .min(2)
  .max(160)
  .regex(/^[A-Za-z][A-Za-z0-9_./:@-]+$/u);
const catalogEntryIdSchema = z.string().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/u);
const relativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);
const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const marketSymbolSchema = z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/u);

const STRATEGY_PACK_INTERVAL_MINUTES = Object.freeze({
  hours_1: 60,
  hours_6: 360,
  hours_12: 720,
  hours_24: 1_440,
  minutes_10: 10,
  minutes_15: 15,
  minutes_30: 30,
  minutes_60: 60,
} as const);

export function strategyPackIntervalMinutes(value: string): number | null {
  return Object.prototype.hasOwnProperty.call(STRATEGY_PACK_INTERVAL_MINUTES, value)
    ? STRATEGY_PACK_INTERVAL_MINUTES[value as keyof typeof STRATEGY_PACK_INTERVAL_MINUTES]
    : null;
}

function sortedUnique(values: readonly string[]): boolean {
  return (
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value)
  );
}

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function safeCanonicalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.toString() !== value
    ) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (/(?:api[-_]?key|credential|password|secret|signature|token)/iu.test(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const configurationFieldBase = {
  description: z.string().trim().min(1).max(400),
  key: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z][A-Za-z0-9]*$/u),
  label: z.string().trim().min(1).max(120),
  mutableAfterInstall: z.boolean(),
  pauseManagedMonitorsOnChange: z.boolean(),
  required: z.boolean(),
  rolloverGenerationOnChange: z.boolean(),
};

const timezoneConfigurationSchema = z
  .object({
    ...configurationFieldBase,
    default: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
    kind: z.literal("iana_timezone"),
  })
  .strict();

const dailyTimesConfigurationSchema = z
  .object({
    ...configurationFieldBase,
    default: z.array(localTimeSchema).min(1).max(16),
    kind: z.literal("daily_local_times"),
    maximumItems: z.number().int().positive().max(16),
    minimumItems: z.number().int().positive().max(16),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      field.minimumItems > field.maximumItems ||
      field.default.length < field.minimumItems ||
      field.default.length > field.maximumItems ||
      !sortedUnique(field.default)
    ) {
      context.addIssue({
        code: "custom",
        message: "strategy_pack_daily_times_invalid",
      });
    }
  });

const boundedEnumConfigurationSchema = z
  .object({
    ...configurationFieldBase,
    allowedValues: z.array(stableIdSchema).min(2).max(32),
    default: stableIdSchema,
    kind: z.literal("bounded_enum"),
  })
  .strict()
  .superRefine((field, context) => {
    if (!sortedUnique(field.allowedValues) || !field.allowedValues.includes(field.default)) {
      context.addIssue({ code: "custom", message: "strategy_pack_bounded_enum_invalid" });
    }
  });

const canonicalIdListConfigurationSchema = z
  .object({
    ...configurationFieldBase,
    allowedValues: z.array(stableIdSchema).min(1).max(600),
    default: z.array(stableIdSchema).max(32),
    kind: z.literal("canonical_id_list"),
    maximumItems: z.number().int().positive().max(32),
    minimumItems: z.number().int().nonnegative().max(32),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      field.minimumItems > field.maximumItems ||
      field.default.length < field.minimumItems ||
      field.default.length > field.maximumItems ||
      !sortedUnique(field.allowedValues) ||
      !sortedUnique(field.default) ||
      field.default.some((value) => !field.allowedValues.includes(value))
    ) {
      context.addIssue({ code: "custom", message: "strategy_pack_canonical_id_list_invalid" });
    }
  });

const boundedTokenListConfigurationSchema = z.object({
  ...configurationFieldBase,
  default: z.array(marketSymbolSchema).max(32),
  kind: z.literal("bounded_token_list"),
  maximumItems: z.number().int().positive().max(32),
  minimumItems: z.number().int().nonnegative().max(32),
  tokenFormat: z.literal("market_symbol"),
}).strict().superRefine((field, context) => {
  if (
    field.minimumItems > field.maximumItems ||
    field.default.length < field.minimumItems ||
    field.default.length > field.maximumItems ||
    !sortedUnique(field.default)
  ) context.addIssue({ code: "custom", message: "strategy_pack_bounded_token_list_invalid" });
});

const boundedTextConfigurationSchema = z.object({
  ...configurationFieldBase,
  default: z.string().trim(),
  kind: z.literal("bounded_text"),
  maximumCharacters: z.number().int().positive().max(2_000),
  minimumCharacters: z.number().int().nonnegative().max(2_000),
}).strict().superRefine((field, context) => {
  const length = field.default.length;
  if (
    field.minimumCharacters > field.maximumCharacters ||
    length < field.minimumCharacters ||
    length > field.maximumCharacters
  ) context.addIssue({ code: "custom", message: "strategy_pack_bounded_text_invalid" });
});

const boundedTextListConfigurationSchema = z.object({
  ...configurationFieldBase,
  default: z.array(z.string().trim().min(1).max(400)).max(16),
  kind: z.literal("bounded_text_list"),
  maximumItems: z.number().int().positive().max(16),
  minimumItems: z.number().int().nonnegative().max(16),
}).strict().superRefine((field, context) => {
  if (
    field.minimumItems > field.maximumItems ||
    field.default.length < field.minimumItems ||
    field.default.length > field.maximumItems ||
    !sortedUnique(field.default)
  ) context.addIssue({ code: "custom", message: "strategy_pack_bounded_text_list_invalid" });
});

const xPublicIdentityConfigurationSchema = z.object({
  ...configurationFieldBase,
  default: z.tuple([
    z.string().url(),
    z.string().regex(/^[A-Za-z0-9_]{1,15}$/u),
    z.string().trim().min(1).max(160),
    z.string().regex(/^\d{1,20}$/u),
    z.literal("confirmed"),
  ]),
  kind: z.literal("x_public_identity"),
}).strict();

const impactHypothesisListConfigurationSchema = z.object({
  ...configurationFieldBase,
  default: z.array(z.string().trim().regex(/^.{1,200}\|[A-Z][A-Z0-9.-]{0,15}\|(?:up|down)$/u)).min(1).max(8),
  kind: z.literal("impact_hypothesis_list"),
  maximumItems: z.number().int().positive().max(8),
  minimumItems: z.number().int().positive().max(8),
}).strict().superRefine((field, context) => {
  if (
    field.minimumItems > field.maximumItems ||
    field.default.length < field.minimumItems ||
    field.default.length > field.maximumItems ||
    !sortedUnique(field.default)
  ) context.addIssue({ code: "custom", message: "strategy_pack_impact_hypotheses_invalid" });
});

const catalogIdListConfigurationSchema = z.object({
  ...configurationFieldBase,
  catalogDigest: digestSchema,
  catalogId: stableIdSchema,
  catalogRevision: z.number().int().positive(),
  default: z.array(catalogEntryIdSchema).max(32),
  kind: z.literal("catalog_id_list"),
  maximumItems: z.number().int().positive().max(32),
  minimumItems: z.number().int().nonnegative().max(32),
}).strict().superRefine((field, context) => {
  if (
    field.minimumItems > field.maximumItems ||
    field.default.length < field.minimumItems ||
    field.default.length > field.maximumItems ||
    !sortedUnique(field.default)
  ) context.addIssue({ code: "custom", message: "strategy_pack_catalog_id_list_invalid" });
});

export const strategyPackConfigurationFieldSchema = z.discriminatedUnion(
  "kind",
  [
    timezoneConfigurationSchema,
    dailyTimesConfigurationSchema,
    boundedEnumConfigurationSchema,
    boundedTextConfigurationSchema,
    boundedTextListConfigurationSchema,
    boundedTokenListConfigurationSchema,
    canonicalIdListConfigurationSchema,
    catalogIdListConfigurationSchema,
    impactHypothesisListConfigurationSchema,
    xPublicIdentityConfigurationSchema,
  ],
);

const skillSchema = z
  .object({
    description: z.string().trim().min(1).max(300),
    id: stableIdSchema,
    instructionPath: relativePathSchema,
    version: semverSchema,
  })
  .strict();

const sourceSchema = z
  .object({
    accessClassification: z.literal("public"),
    allowedOrigins: z
      .array(z.string().max(500).refine(exactHttpsOrigin))
      .min(1)
      .max(4),
    canonicalUrl: z.string().max(2_048).refine(safeCanonicalUrl),
    contractDigest: digestSchema,
    contractVersion: semverSchema,
    parameterization: z.object({
      catalogDigest: digestSchema,
      catalogId: stableIdSchema,
      catalogRevision: z.number().int().positive(),
      selectionConfigurationKey: z.string().min(2).max(80),
    }).strict().optional(),
    sourceId: stableIdSchema,
  })
  .strict()
  .superRefine((source, context) => {
    let canonicalOrigin: string | null = null;
    try {
      canonicalOrigin = new URL(source.canonicalUrl).origin;
    } catch {
      // The field refinement owns the URL-shape issue.
    }
    if (
      !sortedUnique(source.allowedOrigins) ||
      !canonicalOrigin ||
      !source.allowedOrigins.includes(canonicalOrigin)
    ) {
      context.addIssue({
        code: "custom",
        message: "strategy_pack_source_origin_invalid",
      });
    }
  });

const monitorBase = {
    activationDefault: z.enum(["draft", "paused"]),
    alertPresentationId: stableIdSchema,
    displayName: z.string().trim().min(1).max(160),
    findingSchemaId: stableIdSchema,
    instructionPath: relativePathSchema,
    overridableFields: z.array(z.enum(["schedule"])).max(1),
    requiredCapabilityIds: z.array(stableIdSchema).min(1).max(32),
    resourceId: z
      .string()
      .min(2)
      .max(80)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    sourceIds: z.array(stableIdSchema).min(1).max(8),
    suggestedBudget: z
      .object({
        maximumInputTokensPerRun: z.number().int().positive().max(10_000_000),
        maximumOutputTokensPerRun: z.number().int().positive().max(100_000),
        maximumRunsPerDay: z.number().int().positive().max(144),
      })
      .strict(),
  } as const;

const monitorSchema = z
  .union([
    z.object({
      ...monitorBase,
      dailyTimesConfigurationKey: z.string().min(2).max(80),
      timezoneConfigurationKey: z.string().min(2).max(80),
    }).strict(),
    z.object({
      ...monitorBase,
      intervalMinutesConfigurationKey: z.string().min(2).max(80),
    }).strict(),
  ])
  .superRefine((monitor, context) => {
    if (
      !sortedUnique(monitor.requiredCapabilityIds) ||
      !sortedUnique(monitor.sourceIds) ||
      !sortedUnique(monitor.overridableFields)
    ) {
      context.addIssue({ code: "custom", message: "strategy_pack_monitor_duplicate" });
    }
  });

export const strategyPackManifestSchema = z
  .object({
    capabilities: z
      .object({
        hardDenied: z.array(stableIdSchema).min(1).max(64),
        required: z.array(stableIdSchema).min(1).max(64),
      })
      .strict(),
    compatibility: z
      .object({
        coreSchemaVersion: z.number().int().positive(),
        strategyPackSchemaVersion: z.number().int().positive(),
        workspaceSchemaVersion: z.number().int().positive(),
      })
      .strict(),
    configuration: z.array(strategyPackConfigurationFieldSchema).max(16),
    description: z.string().trim().min(1).max(500),
    displayName: z.string().trim().min(1).max(120),
    evidenceContracts: z.array(z.object({
      digest: digestSchema,
      id: stableIdSchema,
      version: semverSchema,
    }).strict()).max(16).superRefine((contracts, context) => {
      if (!sortedUnique(contracts.map(({ id }) => id))) {
        context.addIssue({ code: "custom", message: "strategy_pack_evidence_contract_duplicate" });
      }
    }).optional(),
    evaluationsPath: relativePathSchema,
    id: packIdSchema,
    maturity: z.enum(["deprecated", "experimental", "reference", "stable"]),
    monitors: z.array(monitorSchema).min(1).max(16),
    schemaVersion: z.literal(STRATEGY_PACK_SCHEMA_VERSION),
    skills: z.array(skillSchema).min(1).max(16),
    sources: z.array(sourceSchema).min(1).max(8),
    version: semverSchema,
    workspaceInstructionPath: relativePathSchema,
  })
  .strict();

export const strategyPackEvaluationsSchema = z
  .object({
    cases: z
      .array(
        z
          .object({
            fixtureId: stableIdSchema,
            id: stableIdSchema,
            kind: z.enum([
              "forbidden_capability",
              "malformed_input",
              "no_match",
              "positive",
              "replay",
            ]),
          })
          .strict(),
      )
      .min(5)
      .max(64),
    schemaVersion: z.literal(1),
    suiteId: stableIdSchema,
  })
  .strict()
  .superRefine((evaluations, context) => {
    const kinds = new Set(evaluations.cases.map((entry) => entry.kind));
    const ids = evaluations.cases.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "strategy_pack_eval_duplicate" });
    }
    for (const kind of [
      "forbidden_capability",
      "malformed_input",
      "no_match",
      "positive",
      "replay",
    ] as const) {
      if (!kinds.has(kind)) {
        context.addIssue({ code: "custom", message: `strategy_pack_eval_missing_${kind}` });
      }
    }
  });

export type StrategyPackManifest = z.infer<typeof strategyPackManifestSchema>;
export type StrategyPackEvaluations = z.infer<typeof strategyPackEvaluationsSchema>;

export interface StrategyPackDefinition
  extends Omit<StrategyPackManifest, "monitors" | "skills"> {
  readonly contentDigest: string;
  readonly evaluations: StrategyPackEvaluations;
  readonly monitors: readonly (StrategyPackManifest["monitors"][number] & {
    readonly instruction: string;
  })[];
  readonly skills: readonly (StrategyPackManifest["skills"][number] & {
    readonly instruction: string;
  })[];
  readonly workspaceInstruction: string;
}

export interface StrategyPackReferenceCatalog {
  readonly alertPresentationIds: readonly string[];
  readonly capabilityIds: readonly string[];
  readonly evalSuites: Readonly<Record<string, readonly string[]>>;
  readonly findingSchemaIds: readonly string[];
  readonly sourceContracts: Readonly<
    Record<
      string,
      {
        readonly allowedOrigins: readonly string[];
        readonly canonicalUrl: string;
        readonly contractDigest: string;
        readonly contractVersion: string;
        readonly publicSource?: {
          readonly adapterDefinition: PublicSourceAdapterDefinition;
          readonly sourceInstance: PublicSourceInstance;
        };
      }
    >
  >;
}

export const EMPTY_STRATEGY_PACK_REFERENCE_CATALOG = Object.freeze({
  alertPresentationIds: Object.freeze([]),
  capabilityIds: Object.freeze([]),
  evalSuites: Object.freeze({}),
  findingSchemaIds: Object.freeze([]),
  sourceContracts: Object.freeze({}),
}) satisfies StrategyPackReferenceCatalog;
