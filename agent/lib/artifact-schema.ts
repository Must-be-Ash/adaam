import { z } from "zod";

export const ARTIFACT_SCHEMA_VERSION = 1 as const;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_ARTIFACT_MANIFEST_BYTES = 1 * 1024 * 1024;

export const artifactIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/u, "Invalid artifact identifier.");

export const artifactKindSchema = z.enum([
  "report",
  "image",
  "audio",
  "video",
  "pdf",
  "file",
]);

const boundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const reportProse = (maximum: number) =>
  boundedText(maximum).describe(
    "Plain prose only. Do not include Markdown, HTML, a document title, or internal session/workspace metadata.",
  );

const CREDENTIAL_QUERY_KEY =
  /(?:^|[-_])(api[-_]?key|auth|authorization|credential|password|secret|signature|signed|token)(?:$|[-_])/iu;

const publicWebUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        ![...url.searchParams.keys()].some((key) =>
          CREDENTIAL_QUERY_KEY.test(key),
        ) &&
        !CREDENTIAL_QUERY_KEY.test(url.hash)
      );
    } catch {
      return false;
    }
  }, "Use a public HTTP or HTTPS URL without embedded credentials.");

const publicBlobUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.hostname.endsWith(".blob.vercel-storage.com")
      );
    } catch {
      return false;
    }
  }, "Use a public Vercel Blob URL.");

const toneSchema = z.enum([
  "positive",
  "negative",
  "neutral",
  "warning",
  "info",
]);

export const reportSourceSchema = z.object({
  label: boundedText(180),
  publisher: boundedText(120).optional(),
  publishedAt: boundedText(80).optional(),
  url: publicWebUrlSchema,
});

export const reportMetricSchema = z.object({
  detail: boundedText(240).optional(),
  label: boundedText(100),
  tone: toneSchema.optional(),
  value: boundedText(120),
});

const textBlockSchema = z.object({
  body: reportProse(12_000),
  bullets: z.array(reportProse(1_000)).max(20).optional(),
  heading: boundedText(180).optional(),
  type: z.literal("text"),
});

const calloutBlockSchema = z.object({
  body: reportProse(4_000),
  heading: boundedText(180).optional(),
  tone: toneSchema.default("info"),
  type: z.literal("callout"),
});

const metricsBlockSchema = z.object({
  heading: boundedText(180).optional(),
  items: z.array(reportMetricSchema).min(1).max(12),
  type: z.literal("metrics"),
});

const tableBlockSchema = z.object({
  columns: z.array(boundedText(100)).min(1).max(8),
  heading: boundedText(180).optional(),
  note: boundedText(1_000).optional(),
  rows: z
    .array(z.array(z.string().trim().max(500)).min(1).max(8))
    .min(1)
    .max(100),
  type: z.literal("table"),
});

const lineChartBlockSchema = z.object({
  heading: boundedText(180),
  note: boundedText(1_000).optional(),
  series: z
    .array(
      z.object({
        name: boundedText(80),
        points: z
          .array(
            z.object({
              label: boundedText(80),
              value: z.number().finite(),
            }),
          )
          .min(2)
          .max(366),
      }),
    )
    .min(1)
    .max(6),
  type: z.literal("line-chart"),
  valuePrefix: z.string().max(12).optional(),
  valueSuffix: z.string().max(12).optional(),
});

const barChartBlockSchema = z.object({
  heading: boundedText(180),
  items: z
    .array(
      z.object({
        label: boundedText(80),
        tone: toneSchema.optional(),
        value: z.number().finite(),
      }),
    )
    .min(1)
    .max(30),
  note: boundedText(1_000).optional(),
  type: z.literal("bar-chart"),
  valuePrefix: z.string().max(12).optional(),
  valueSuffix: z.string().max(12).optional(),
});

const pieChartBlockSchema = z.object({
  heading: boundedText(180),
  items: z
    .array(
      z.object({
        label: boundedText(80),
        value: z.number().finite().nonnegative(),
      }),
    )
    .min(2)
    .max(12),
  note: boundedText(1_000).optional(),
  type: z.literal("pie-chart"),
});

const candlestickChartBlockSchema = z.object({
  candles: z
    .array(
      z.object({
        close: z.number().finite(),
        high: z.number().finite(),
        label: boundedText(80),
        low: z.number().finite(),
        open: z.number().finite(),
        volume: z.number().finite().nonnegative().optional(),
      }),
    )
    .min(2)
    .max(366),
  heading: boundedText(180),
  note: boundedText(1_000).optional(),
  type: z.literal("candlestick-chart"),
  valuePrefix: z.string().max(12).optional(),
});

const depthChartBlockSchema = z.object({
  asks: z
    .array(
      z.object({
        price: z.number().finite(),
        size: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(200),
  bids: z
    .array(
      z.object({
        price: z.number().finite(),
        size: z.number().finite().nonnegative(),
      }),
    )
    .min(1)
    .max(200),
  heading: boundedText(180),
  note: boundedText(1_000).optional(),
  type: z.literal("depth-chart"),
  valuePrefix: z.string().max(12).optional(),
});

export const reportBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  calloutBlockSchema,
  metricsBlockSchema,
  tableBlockSchema,
  lineChartBlockSchema,
  barChartBlockSchema,
  pieChartBlockSchema,
  candlestickChartBlockSchema,
  depthChartBlockSchema,
]);

export const researchReportSchema = z.object({
  asOf: boundedText(100).optional(),
  blocks: z.array(reportBlockSchema).min(1).max(40),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  description: boundedText(320),
  disclosure: reportProse(1_000).optional(),
  eyebrow: boundedText(100).optional(),
  metrics: z.array(reportMetricSchema).max(12).optional(),
  sources: z.array(reportSourceSchema).max(100).default([]),
  subject: z
    .object({
      assetClass: boundedText(80).optional(),
      name: boundedText(160),
      symbol: boundedText(40).optional(),
    })
    .optional(),
  summary: reportProse(5_000),
  title: boundedText(200),
  verdict: z
    .object({
      label: boundedText(120),
      rationale: reportProse(1_000),
      tone: toneSchema,
    })
    .optional(),
});

const publicDataOnlySchema = z
  .literal(true)
  .describe(
    "Required confirmation that the artifact contains only public, non-account data.",
  );

const sourceUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use a credential-free, query-free HTTPS source URL.");

const mediaInputBase = {
  contentType: boundedText(120).optional(),
  description: boundedText(320).optional(),
  fileName: boundedText(180).optional(),
  publicDataOnly: publicDataOnlySchema,
  sourceUrl: sourceUrlSchema,
  title: boundedText(200),
};

export const publishArtifactInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("report"),
    publicDataOnly: publicDataOnlySchema,
    report: researchReportSchema,
  }),
  z.object({ ...mediaInputBase, kind: z.literal("image") }),
  z.object({ ...mediaInputBase, kind: z.literal("audio") }),
  z.object({ ...mediaInputBase, kind: z.literal("video") }),
  z.object({ ...mediaInputBase, kind: z.literal("pdf") }),
  z.object({
    contentType: boundedText(120).optional(),
    description: boundedText(320).optional(),
    fileName: boundedText(180),
    kind: z.literal("file"),
    publicDataOnly: publicDataOnlySchema,
    sourceUrl: sourceUrlSchema.optional(),
    text: z.string().min(1).max(500_000).optional(),
    title: boundedText(200),
  }),
]);

const mediaManifestSchema = z.object({
  byteLength: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
  contentType: boundedText(120),
  downloadUrl: publicBlobUrlSchema,
  fileName: boundedText(180),
  url: publicBlobUrlSchema,
});

const manifestBase = {
  createdAt: z.string().datetime(),
  description: boundedText(320),
  id: artifactIdSchema,
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  title: boundedText(200),
  visibility: z.literal("public"),
};

export const artifactManifestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...manifestBase,
    kind: z.literal("report"),
    report: researchReportSchema,
  }),
  z.object({
    ...manifestBase,
    kind: z.literal("image"),
    media: mediaManifestSchema,
  }),
  z.object({
    ...manifestBase,
    kind: z.literal("audio"),
    media: mediaManifestSchema,
  }),
  z.object({
    ...manifestBase,
    kind: z.literal("video"),
    media: mediaManifestSchema,
  }),
  z.object({
    ...manifestBase,
    kind: z.literal("pdf"),
    media: mediaManifestSchema,
  }),
  z.object({
    ...manifestBase,
    kind: z.literal("file"),
    media: mediaManifestSchema,
  }),
]);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
export type PublishArtifactInput = z.infer<typeof publishArtifactInputSchema>;
export type ResearchReport = z.infer<typeof researchReportSchema>;
export type ReportBlock = z.infer<typeof reportBlockSchema>;
