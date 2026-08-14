import assert from "node:assert/strict";

import {
  artifactIdForCall,
  publishReportArtifact,
  readArtifactManifest,
} from "../agent/lib/artifact-store.ts";

if (!process.argv.includes("--confirm-public-write")) {
  throw new Error(
    "Pass --confirm-public-write to create or replace the public smoke artifact.",
  );
}

const baseUrl = process.env.ARTIFACT_SMOKE_BASE_URL;
if (!baseUrl) {
  throw new Error("Set ARTIFACT_SMOKE_BASE_URL to the deployed application origin.");
}
const origin = new URL(baseUrl);
if (origin.protocol !== "https:") {
  throw new Error("ARTIFACT_SMOKE_BASE_URL must use HTTPS.");
}
process.env.PHOTON_MINI_APP_BASE_URL = origin.origin;

const artifactId = artifactIdForCall("eve-public-artifact-smoke-v1");
const published = await publishReportArtifact({
  artifactId,
  report: {
    asOf: "August 13, 2026",
    blocks: [
      {
        body: "This public report verifies structured storage, deterministic rendering, chart components, and the stable Eve artifact URL.",
        bullets: [
          "The report body is JSON in Vercel Blob, not model-authored HTML.",
          "The same artifact contract supports public media and downloadable files.",
        ],
        heading: "What this verifies",
        type: "text",
      },
      {
        heading: "Comparative volume",
        items: [
          { label: "Prior 30 days", value: 120 },
          { label: "Latest 30 days", tone: "positive", value: 180 },
        ],
        note: "Illustrative values used only for renderer verification.",
        type: "bar-chart",
        valuePrefix: "$",
        valueSuffix: "m",
      },
      {
        candles: [
          { close: 11, high: 12, label: "Day 1", low: 9, open: 10 },
          { close: 10.5, high: 11.5, label: "Day 2", low: 10, open: 11 },
          { close: 12, high: 12.5, label: "Day 3", low: 10.2, open: 10.5 },
          { close: 12.8, high: 13, label: "Day 4", low: 11.5, open: 12 },
        ],
        heading: "Candlestick component",
        note: "Illustrative OHLC values.",
        type: "candlestick-chart",
        valuePrefix: "$",
      },
      {
        asks: [
          { price: 12.9, size: 80 },
          { price: 13, size: 120 },
          { price: 13.1, size: 160 },
        ],
        bids: [
          { price: 12.7, size: 90 },
          { price: 12.6, size: 130 },
          { price: 12.5, size: 170 },
        ],
        heading: "Depth component",
        note: "Illustrative displayed-book values.",
        type: "depth-chart",
        valuePrefix: "$",
      },
    ],
    confidence: "high",
    description:
      "A mobile report generated from typed data by Eve's artifact renderer.",
    disclosure:
      "Renderer smoke test only. The displayed market values are illustrative.",
    eyebrow: "Artifact foundation · Smoke test",
    metrics: [
      {
        detail: "Structured report manifest",
        label: "Storage",
        tone: "positive",
        value: "Blob",
      },
      {
        detail: "No model-written layout",
        label: "Renderer",
        tone: "positive",
        value: "Deterministic",
      },
      {
        detail: "Report + media contract",
        label: "Foundation",
        tone: "info",
        value: "Generic",
      },
    ],
    sources: [
      {
        label: "Vercel Blob documentation",
        publisher: "Vercel",
        url: "https://vercel.com/docs/storage/vercel-blob",
      },
    ],
    summary:
      "The first artifact slice uses one Blob store for report manifests and future media bytes, while Eve serves a stable mobile page and Photon can open it as a mini app.",
    title: "Eve artifact foundation",
    verdict: {
      label: "Ready for channel smoke testing",
      rationale:
        "Storage and retrieval succeeded with the same schema used by the production renderer.",
      tone: "positive",
    },
  },
});

const loaded = await readArtifactManifest(artifactId);
assert.equal(loaded?.id, artifactId);
assert.equal(loaded?.kind, "report");
assert.equal(published.publicUrl, `${origin.origin}/artifacts/${artifactId}`);

console.log(published.publicUrl);
