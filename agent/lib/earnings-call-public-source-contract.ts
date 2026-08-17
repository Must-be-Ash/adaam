import { z } from "zod";

import reviewedFamilies from "./earnings-call-reviewed-source-families";
import { EARNINGS_CALL_ISSUER_CATALOG } from "./earnings-call-issuer-catalog";
import {
  derivePublicSourceAdapterDefinitionDigest,
  digestPublicSourceValue,
  publicSourceAdapterDefinitionSchema,
  publicSourceInstanceSchema,
} from "./public-source-adapter-schema";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const exactOriginSchema = z.string().url().refine((value) => new URL(value).origin === value);
const endpointSchema = z.object({
  mediaType: z.enum(["application/pdf", "text/html"]).optional(),
  origin: exactOriginSchema,
  pathPattern: z.string().min(1).max(500),
}).strict();
const eventSchema = z.object({
  artifactUrl: z.string().url(),
  callDate: z.string().date(),
  discoveryEvidence: z.enum(["direct_link", "reviewed_path_template"]),
  discoveryUrl: z.string().url(),
  fiscalPeriod: z.string().regex(/^FY\d{4}-Q[1-4]$/u),
  reviewedArtifact: z.object({
    byteCount: z.number().int().positive().max(8 * 1_024 * 1_024),
    digest: digestSchema,
  }).strict(),
  role: z.enum(["current", "prior"]),
}).strict();

const reviewedArtifacts = new Map<string, Readonly<{ byteCount: number; digest: string }>>([
  ["0000789019:FY2026-Q3", { byteCount: 345_521, digest: "b0bbe530c46206eec6d58c38af875c9e7231e98e0b5cd507372956917be7b7c5" }],
  ["0000789019:FY2026-Q2", { byteCount: 342_331, digest: "523bf2ae5177f3e7f58095a5a3c16aafd80400677ebd377a2a54356d6b66ca7b" }],
  ["0000019617:FY2026-Q2", { byteCount: 286_751, digest: "df9042c4c156aa33eed0cec2f5727598504e88e038be31140d98452dc9054540" }],
  ["0000019617:FY2026-Q1", { byteCount: 543_920, digest: "0b97af7b67e8c14fd812a7e6ece55ea74005d3968b942560db2e558ea96f63f9" }],
  ["0001744489:FY2026-Q2", { byteCount: 455_158, digest: "b3084f1976ec1928ce59faf371224e4bff32677cbaed8db3b66753ffaffae250" }],
  ["0001744489:FY2026-Q1", { byteCount: 763_153, digest: "fb005bfd8b8e034f7774b9e3c4069697ceb01a9474889a184c72e4e3b236f0d9" }],
  ["0001048911:FY2026-Q4", { byteCount: 254_423, digest: "edd8a892d440c5080492c7d12a4e13a1c59741a4f0eb647d2688fdda030b6be8" }],
  ["0001048911:FY2026-Q3", { byteCount: 259_167, digest: "f9b3de0ac897e4d58f7cbb737f0b04eecee82f6a9f94780b59c0b2339b4d47b3" }],
  ["0001326801:FY2026-Q1", { byteCount: 131_758, digest: "75a66cc6c660e37c009851d6820fd75bc5576d6d298b974b49bba26fc4bd6bac" }],
  ["0001326801:FY2025-Q4", { byteCount: 152_406, digest: "2def106046fcde215f214ac0689aff6fa6c432d7016bf9315b4a831b2041a14b" }],
]);

export const reviewedParameterizedSourceFamilySchema = z.object({
  artifact: endpointSchema.extend({ mediaType: z.enum(["application/pdf", "text/html"]) }).strict(),
  catalogDigest: digestSchema,
  catalogId: z.literal("sec-issuers"),
  catalogRevision: z.number().int().positive(),
  cik: z.string().regex(/^\d{10}$/u),
  discovery: endpointSchema.omit({ mediaType: true }).strict(),
  events: z.array(eventSchema).length(2),
  familyDigest: digestSchema,
  familyId: z.string().regex(/^earnings-call-transcripts\.\d{10}$/u),
  maximumArtifactBytes: z.literal(8 * 1_024 * 1_024),
  maximumDiscoveryBytes: z.literal(2 * 1_024 * 1_024),
  maximumRedirects: z.literal(3),
  recordType: z.literal("reviewed_parameterized_source_family"),
  schemaVersion: z.literal(1),
}).strict().superRefine((family, context) => {
  const { familyDigest, ...core } = family;
  if (
    digestPublicSourceValue(core) !== familyDigest ||
    family.familyId !== `earnings-call-transcripts.${family.cik}` ||
    family.events.some((event) => {
      const discovery = new URL(event.discoveryUrl);
      const artifact = new URL(event.artifactUrl);
      return discovery.origin !== family.discovery.origin ||
        artifact.origin !== family.artifact.origin ||
        !new RegExp(family.discovery.pathPattern, "u").test(discovery.pathname) ||
        !new RegExp(family.artifact.pathPattern, "u").test(artifact.pathname) ||
        discovery.search !== "" || artifact.search !== "" ||
        discovery.hash !== "" || artifact.hash !== "";
    }) ||
    new Set(family.events.map(({ role }) => role)).size !== 2
  ) context.addIssue({ code: "custom", message: "parameterized_source_family_invalid" });
});

const adapterCore = {
  acquisitionMethod: "poll" as const,
  adapterId: "earnings-call-transcripts" as const,
  adapterVersion: "1.0.0",
  authorityOrigin: "https://data.sec.gov",
  configurationSchemaVersion: 1 as const,
  factSchemaVersions: ["earnings-call-event/v1" as const],
  implementationRevision: 1,
  limits: {
    maximumArchiveBytes: 5 * 1_024 * 1_024,
    maximumFactsPerAcquisition: 4,
    maximumPdfBytes: 8 * 1_024 * 1_024,
    maximumPdfPages: 128,
    maximumResponseBytes: 8 * 1_024 * 1_024,
  },
  maximumCadenceMinutes: 1_440,
  minimumCadenceMinutes: 60,
  recordType: "public_source_adapter_definition" as const,
  schemaVersion: 1 as const,
};

export const EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER = Object.freeze(
  publicSourceAdapterDefinitionSchema.parse({
    ...adapterCore,
    definitionDigest: derivePublicSourceAdapterDefinitionDigest(adapterCore),
  }),
);

export type ReviewedParameterizedSourceFamily = z.infer<
  typeof reviewedParameterizedSourceFamilySchema
>;

export const EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES = Object.freeze(
  reviewedFamilies.families.map((source) => {
    const core = {
      artifact: source.artifact,
      catalogDigest: EARNINGS_CALL_ISSUER_CATALOG.catalogDigest,
      catalogId: EARNINGS_CALL_ISSUER_CATALOG.catalogId,
      catalogRevision: EARNINGS_CALL_ISSUER_CATALOG.revision,
      cik: source.cik,
      discovery: source.discovery,
      events: source.events.map((event) => {
        const reviewedArtifact = reviewedArtifacts.get(`${source.cik}:${event.fiscalPeriod}`);
        if (!reviewedArtifact) throw new Error("parameterized_source_artifact_lock_missing");
        return { ...event, reviewedArtifact };
      }),
      familyId: `earnings-call-transcripts.${source.cik}`,
      maximumArtifactBytes: 8 * 1_024 * 1_024,
      maximumDiscoveryBytes: 2 * 1_024 * 1_024,
      maximumRedirects: 3,
      recordType: "reviewed_parameterized_source_family" as const,
      schemaVersion: 1 as const,
    };
    return Object.freeze(reviewedParameterizedSourceFamilySchema.parse({
      ...core,
      familyDigest: digestPublicSourceValue(core),
    }));
  }),
);

export function deriveEarningsCallPublicSource(family: ReviewedParameterizedSourceFamily) {
  const reviewed = reviewedParameterizedSourceFamilySchema.parse(family);
  const issuer = EARNINGS_CALL_ISSUER_CATALOG.entries.find(({ cik }) => cik === reviewed.cik);
  if (!issuer || issuer.coverage.state !== "baseline_ready") {
    throw new Error("parameterized_source_catalog_mismatch");
  }
  const configuration = {
    canonicalUrl: `https://data.sec.gov/submissions/CIK${reviewed.cik}.json`,
    catalogDigest: reviewed.catalogDigest,
    catalogId: reviewed.catalogId,
    catalogRevision: reviewed.catalogRevision,
    cik: reviewed.cik,
    familyDigest: reviewed.familyDigest,
    familyId: reviewed.familyId,
    kind: "earnings_call_issuer" as const,
  };
  const sourceInstance = publicSourceInstanceSchema.parse({
    adapterDefinitionDigest: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.definitionDigest,
    adapterId: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.adapterId,
    adapterVersion: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.adapterVersion,
    authorityOrigin: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER.authorityOrigin,
    cadenceMinutes: 360,
    configuration,
    configurationDigest: digestPublicSourceValue(configuration),
    cursor: { contentDigest: null, revision: 0, watermark: null },
    lifecycleState: "active",
    recordType: "public_source_instance",
    schemaVersion: 1,
    sourceInstanceId: `source.earnings-call-transcripts.${reviewed.cik}`,
  });
  return Object.freeze({
    adapterDefinition: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER,
    family: reviewed,
    sourceContract: Object.freeze({
      allowedOrigins: Object.freeze([...new Set([
        "https://data.sec.gov",
        reviewed.discovery.origin,
        reviewed.artifact.origin,
      ])].sort()),
      canonicalUrl: configuration.canonicalUrl,
      contractDigest: reviewed.familyDigest,
      contractVersion: "1.0.0",
      publicSource: Object.freeze({
        adapterDefinition: EARNINGS_CALL_PUBLIC_SOURCE_ADAPTER,
        sourceInstance,
      }),
    }),
    sourceId: reviewed.familyId,
    sourceInstance,
  });
}

const derivedSources = new Map(EARNINGS_CALL_REVIEWED_SOURCE_FAMILIES.map((family) => {
  const derived = deriveEarningsCallPublicSource(family);
  return [derived.sourceId, derived] as const;
}));

export function resolveEarningsCallPublicSource(sourceId: string) {
  return derivedSources.get(sourceId) ?? null;
}
