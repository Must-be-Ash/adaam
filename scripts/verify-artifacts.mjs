import assert from "node:assert/strict";

import {
  artifactIdForCall,
} from "../agent/lib/artifact-store.ts";
import {
  artifactManifestSchema,
  publishChartInputSchema,
  publishFileInputSchema,
  publishImageInputSchema,
  publishReportInputSchema,
} from "../agent/lib/artifact-schema.ts";
import {
  artifactFinalValidationDecision,
  validateReportForPublication,
} from "../agent/lib/artifact-validation.ts";
import {
  artifactPageUrl,
  publicArtifactPageUrl,
} from "../agent/lib/public-app-url.ts";

const report = {
  asOf: "August 13, 2026",
  blocks: [
    {
      body: "Demand improved, but the evidence remains mixed.",
      bullets: ["Volume expanded.", "Liquidity remained concentrated."],
      heading: "What changed",
      type: "text",
    },
    {
      heading: "Thirty-day volume",
      series: [
        {
          name: "Daily volume",
          points: [
            { label: "Jul 15", value: 120 },
            { label: "Aug 13", value: 180 },
          ],
        },
      ],
      type: "line-chart",
      valuePrefix: "$",
      valueSuffix: "m",
    },
    {
      candles: [
        { close: 11, high: 12, label: "Aug 12", low: 9, open: 10 },
        { close: 12, high: 13, label: "Aug 13", low: 10, open: 11 },
      ],
      heading: "Price",
      type: "candlestick-chart",
      valuePrefix: "$",
    },
    {
      asks: [{ price: 12.1, size: 100 }],
      bids: [{ price: 11.9, size: 90 }],
      heading: "Displayed depth",
      type: "depth-chart",
      valuePrefix: "$",
    },
  ],
  confidence: "medium",
  description: "A public-data test of Eve's deterministic report renderer.",
  metrics: [
    {
      detail: "Compared with the prior 30 days",
      label: "Volume",
      tone: "positive",
      value: "+50%",
    },
  ],
  sources: [
    {
      label: "Coinbase market data",
      publisher: "Coinbase",
      url: "https://www.coinbase.com/price/hyperliquid",
    },
  ],
  subject: {
    assetClass: "Crypto",
    name: "Hyperliquid",
    symbol: "HYPE",
  },
  summary: "A concise summary based only on public market data.",
  title: "HYPE market dossier",
  verdict: {
    label: "Constructive, with liquidity risk",
    rationale: "Participation improved while visible depth remained uneven.",
    tone: "warning",
  },
};

assert.doesNotThrow(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report,
    requirements: [
      "metrics",
      "line-chart",
      "candlestick-chart",
      "depth-chart",
      "sources",
    ],
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report,
    requirements: [],
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: false,
    report,
  }),
);
assert.throws(() =>
  publishImageInputSchema.parse({
    publicDataOnly: true,
    sourceUrl: "https://cdn.example/image.png?token=secret",
    title: "Unsafe image",
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report: {
      ...report,
      sources: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    },
  }),
);
assert.throws(() =>
  publishReportInputSchema.parse({
    publicDataOnly: true,
    report: {
      ...report,
      sources: [
        {
          label: "Credential-bearing source",
          url: "https://files.example/report?access_token=secret",
        },
      ],
    },
  }),
);

const { blocks: _reportBlocks, ...chartMetadata } = report;
const chartInput = {
  ...chartMetadata,
  charts: [report.blocks[1]],
  publicDataOnly: true,
};
assert.doesNotThrow(() => publishChartInputSchema.parse(chartInput));
assert.throws(() =>
  publishChartInputSchema.parse({
    ...chartInput,
    charts: [],
  }),
);
assert.throws(() =>
  publishChartInputSchema.parse({
    ...chartInput,
    charts: [
      {
        heading: "Missing numeric series",
        series: [{ name: "Price", points: [] }],
        type: "line-chart",
      },
    ],
  }),
);

assert.doesNotThrow(() =>
  publishFileInputSchema.parse({
    fileName: "market-data.csv",
    publicDataOnly: true,
    sourceUrl: "https://files.example/market-data.csv",
    title: "Market data",
  }),
);
assert.throws(() =>
  publishFileInputSchema.parse({
    fileName: "market-data.csv",
    publicDataOnly: true,
    sourceUrl: "https://files.example/market-data.csv",
    text: "date,value\n2026-08-13,1",
    title: "Market data",
  }),
);

const reportRequirements = [
  "metrics",
  "line-chart",
  "candlestick-chart",
  "depth-chart",
  "sources",
];
assert.deepEqual(
  validateReportForPublication(report, reportRequirements),
  [],
);
assert.deepEqual(
  validateReportForPublication(
    {
      ...report,
      blocks: report.blocks.filter(
        (block) => block.type !== "candlestick-chart",
      ),
      sources: [],
    },
    reportRequirements,
  ),
  ["candlestick-chart", "sources"],
);

const firstValidation = artifactFinalValidationDecision(
  { rejection: null, turnId: null },
  "turn-1",
  ["candlestick-chart"],
);
assert.equal(firstValidation.rejection?.status, "not_published");
assert.equal(firstValidation.rejection?.retryAllowed, false);
const blockedRepair = artifactFinalValidationDecision(
  firstValidation.state,
  "turn-1",
  [],
);
assert.deepEqual(blockedRepair.rejection, firstValidation.rejection);
assert.equal(
  artifactFinalValidationDecision(firstValidation.state, "turn-2", [])
    .rejection,
  null,
);

const firstId = artifactIdForCall("call_artifact_test");
assert.equal(firstId, artifactIdForCall("call_artifact_test"));
assert.notEqual(firstId, artifactIdForCall("call_artifact_other"));
assert.match(firstId, /^[a-f0-9]{32}$/u);

const previousBaseUrl = process.env.PHOTON_MINI_APP_BASE_URL;
try {
  process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example";
  const publicUrl = artifactPageUrl(firstId);
  assert.equal(publicUrl, `https://eve.example/artifacts/${firstId}`);
  assert.equal(publicArtifactPageUrl(publicUrl), publicUrl);
  assert.equal(
    publicArtifactPageUrl(`https://eve.example/artifacts/${firstId}?token=x`),
    null,
  );
  assert.equal(
    publicArtifactPageUrl(`https://attacker.example/artifacts/${firstId}`),
    null,
  );
} finally {
  if (previousBaseUrl === undefined) {
    delete process.env.PHOTON_MINI_APP_BASE_URL;
  } else {
    process.env.PHOTON_MINI_APP_BASE_URL = previousBaseUrl;
  }
}

assert.doesNotThrow(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: report.description,
    id: firstId,
    kind: "chart",
    report: {
      ...report,
      blocks: [report.blocks[1]],
    },
    schemaVersion: 1,
    title: "HYPE volume chart",
    visibility: "public",
  }),
);

assert.doesNotThrow(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: "Public image",
    id: firstId,
    kind: "image",
    media: {
      byteLength: 1024,
      contentType: "image/png",
      downloadUrl:
        "https://store.public.blob.vercel-storage.com/artifacts/test/image.png?download=1",
      fileName: "image.png",
      url: "https://store.public.blob.vercel-storage.com/artifacts/test/image.png",
    },
    schemaVersion: 1,
    title: "Public image",
    visibility: "public",
  }),
);
assert.throws(() =>
  artifactManifestSchema.parse({
    createdAt: "2026-08-13T20:00:00.000Z",
    description: "Unsafe image",
    id: firstId,
    kind: "image",
    media: {
      byteLength: 1024,
      contentType: "image/png",
      downloadUrl: "https://attacker.example/image.png?download=1",
      fileName: "image.png",
      url: "https://attacker.example/image.png",
    },
    schemaVersion: 1,
    title: "Unsafe image",
    visibility: "public",
  }),
);

console.log("Artifact publication schema, guard, and URL verification passed.");
