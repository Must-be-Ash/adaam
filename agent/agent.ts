import { defineAgent } from "eve";

export default defineAgent({
  build: {
    externalDependencies: [
      "@adaam/eve-workspace-runtime-bridge",
      "@napi-rs/canvas",
      "pdfjs-dist",
      // Nitro full-trace selector: retain PDF.js's runtime-loaded decoder assets.
      "pdfjs-dist*",
    ],
  },
  model: "zai/glm-5.3-flash",
  reasoning: "high",
  compaction: {
    thresholdPercent: 0.75,
  },
  limits: {
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    sessionTimeoutMs: 7 * 24 * 60 * 60_000,
  },
});
