import assert from "node:assert/strict";

import {
  artifactIdForCall,
} from "../agent/lib/artifact-store.ts";
import {
  artifactManifestSchema,
  publishArtifactInputSchema,
} from "../agent/lib/artifact-schema.ts";
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
  publishArtifactInputSchema.parse({
    kind: "report",
    publicDataOnly: true,
    report,
  }),
);
assert.throws(() =>
  publishArtifactInputSchema.parse({
    kind: "report",
    publicDataOnly: false,
    report,
  }),
);
assert.throws(() =>
  publishArtifactInputSchema.parse({
    kind: "image",
    publicDataOnly: true,
    sourceUrl: "https://cdn.example/image.png?token=secret",
    title: "Unsafe image",
  }),
);
assert.throws(() =>
  publishArtifactInputSchema.parse({
    kind: "report",
    publicDataOnly: true,
    report: {
      ...report,
      sources: [{ label: "Unsafe", url: "javascript:alert(1)" }],
    },
  }),
);
assert.throws(() =>
  publishArtifactInputSchema.parse({
    kind: "report",
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

console.log("Artifact schema and URL verification passed.");
