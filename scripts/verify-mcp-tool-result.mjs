import assert from "node:assert/strict";

import { createMCPClient } from "@ai-sdk/mcp";

import {
  McpToolResultError,
  normalizeMcpToolResult,
} from "../agent/lib/mcp-tool-result.ts";
import {
  normalizeCoinbaseMcpToolResult,
  validateCoinbaseMcpInput,
} from "../agent/lib/coinbase-mcp-policy.ts";
import {
  masterkeyMcpNormalizationPolicy,
  masterkeyToolApproval,
} from "../agent/lib/masterkey-mcp-policy.ts";
import { createBoundedFetch } from "../agent/lib/mcp-response-limit.ts";

assert.equal(masterkeyToolApproval("user"), "not-applicable");
assert.equal(masterkeyToolApproval(undefined), "not-applicable");
assert.deepEqual(masterkeyToolApproval("runtime"), {
  reason: "Scheduled public-feed checks cannot use paid services.",
  type: "denied",
});

const imageBytes = "A".repeat(750_000);
const imageResult = {
  content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }],
  structuredContent: {
    serviceId: "image-service",
    outputs: [
      {
        type: "image",
        url: "https://example.com/generated.jpg",
        mime: "image/jpeg",
      },
    ],
    providerCostUsd: 0.02,
  },
  isError: false,
};
const normalizedImage = normalizeMcpToolResult(imageResult, {
  ...masterkeyMcpNormalizationPolicy("run_service"),
});
const normalizedImageText = JSON.stringify(normalizedImage);
assert.equal(normalizedImageText.includes(imageBytes), false);
assert.equal(
  normalizedImageText.includes("https://example.com/generated.jpg"),
  true,
);
assert.ok(normalizedImageText.length < 2_000);

assert.throws(
  () =>
    normalizeMcpToolResult({
      content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }],
      isError: false,
    }),
  /without a durable URL/u,
);

const searchResult = normalizeMcpToolResult(
  {
    content: [{ type: "text", text: "duplicate text envelope" }],
    structuredContent: {
      total: 25,
      results: Array.from({ length: 25 }, (_, index) => ({
        id: `service-${index}`,
      })),
    },
    isError: false,
  },
  masterkeyMcpNormalizationPolicy("search_services"),
);
assert.equal(JSON.stringify(searchResult).includes("duplicate text envelope"), false);
assert.equal(searchResult.results.length, 11);
assert.match(String(searchResult.results.at(-1)), /additional items omitted/u);

const paidResultCollection = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: {
      results: Array.from({ length: 40 }, (_, index) => ({
        id: `paid-result-${index}`,
      })),
    },
    isError: false,
  },
  masterkeyMcpNormalizationPolicy("run_service"),
);
assert.equal(paidResultCollection.results.length, 40);

const coinbaseOrders = Array.from({ length: 75 }, (_, index) => ({
  order_id: `order-${String(index).padStart(3, "0")}`,
  product_id: "BTC-USD",
  base_size: "0.000000010000000000",
  limit_price: "123456.789012345678",
  status: "OPEN",
}));
const normalizedCoinbase = normalizeCoinbaseMcpToolResult(
  {
    content: [{ type: "text", text: "duplicate Coinbase envelope" }],
    structuredContent: {
      orders: coinbaseOrders,
      cursor: "cursor-next-page",
      access_token: "must-not-survive",
    },
    isError: false,
  },
  "coinbase_orders_list",
);
assert.equal(normalizedCoinbase.orders.length, coinbaseOrders.length);
assert.equal(normalizedCoinbase.orders[0].order_id, "order-000");
assert.equal(
  normalizedCoinbase.orders[0].base_size,
  "0.000000010000000000",
);
assert.equal(normalizedCoinbase.cursor, "cursor-next-page");
assert.equal(JSON.stringify(normalizedCoinbase).includes("must-not-survive"), false);
assert.equal(
  JSON.stringify(normalizedCoinbase).includes("duplicate Coinbase envelope"),
  false,
);
assert.equal(validateCoinbaseMcpInput({ limit: 200 }).limit, 200);
for (const limit of [-1, 0, 201, 1.5, "200"]) {
  assert.throws(
    () => validateCoinbaseMcpInput({ limit }),
    /between 1 and 200/u,
  );
}

const coinbaseCliContentOnly = normalizeCoinbaseMcpToolResult(
  {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          product_id: "BTC-USD",
          price: "63964.670000000000",
          base_increment: "0.00000001",
          quote_increment: "0.01",
          product_type: "SPOT",
        }),
      },
    ],
    structuredContent: null,
    isError: false,
  },
  "coinbase_products_get",
);
assert.equal(coinbaseCliContentOnly.product_id, "BTC-USD");
assert.equal(coinbaseCliContentOnly.price, "63964.670000000000");
assert.equal(coinbaseCliContentOnly.base_increment, "0.00000001");
assert.equal(coinbaseCliContentOnly.quote_increment, "0.01");
assert.equal(coinbaseCliContentOnly.product_type, "SPOT");

assert.throws(
  () =>
    normalizeCoinbaseMcpToolResult(
      {
        content: [],
        structuredContent: {
          orders: Array.from({ length: 201 }, (_, index) => ({
            order_id: `order-page-${index}`,
          })),
          cursor: "cursor-must-not-skip-records",
        },
        isError: false,
      },
      "coinbase_orders_list",
    ),
  /smaller page limit|narrower query/u,
);

const wideCoinbasePayload = Object.fromEntries([
  ...Array.from({ length: 110 }, (_, index) => [
    `unimportant_${index}`,
    `value-${index}`,
  ]),
  ["cursor", "cursor-after-wide-object"],
  ["order_id", "order-after-wide-object"],
  ["base_size", "0.123456789012345678"],
  ["created_time", "2026-08-10T12:00:00.000Z"],
]);
const normalizedWideCoinbase = normalizeCoinbaseMcpToolResult(
  {
    content: [],
    structuredContent: wideCoinbasePayload,
    isError: false,
  },
  "coinbase_orders_get",
);
assert.equal(normalizedWideCoinbase.cursor, "cursor-after-wide-object");
assert.equal(normalizedWideCoinbase.order_id, "order-after-wide-object");
assert.equal(normalizedWideCoinbase.base_size, "0.123456789012345678");
assert.equal(
  normalizedWideCoinbase.created_time,
  "2026-08-10T12:00:00.000Z",
);

const oversizedCoinbase = normalizeCoinbaseMcpToolResult(
  {
    content: [],
    structuredContent: {
      orders: [
        {
          order_id: "order-critical",
          client_order_id: "client-critical",
          product_id: "BTC-USD",
          base_size: "0.000000010000000000",
          limit_price: "123456.789012345678",
          created_time: "2026-08-10T12:00:00.000Z",
          diagnostic: "x".repeat(200_000),
        },
      ],
      cursor: "cursor-after-critical",
    },
    isError: false,
  },
  "coinbase_orders_list",
);
assert.ok(JSON.stringify(oversizedCoinbase).length <= 120_000);
assert.equal(oversizedCoinbase.orders[0].order_id, "order-critical");
assert.equal(oversizedCoinbase.orders[0].client_order_id, "client-critical");
assert.equal(oversizedCoinbase.orders[0].product_id, "BTC-USD");
assert.equal(
  oversizedCoinbase.orders[0].base_size,
  "0.000000010000000000",
);
assert.equal(
  oversizedCoinbase.orders[0].limit_price,
  "123456.789012345678",
);
assert.equal(
  oversizedCoinbase.orders[0].created_time,
  "2026-08-10T12:00:00.000Z",
);
assert.equal(oversizedCoinbase.cursor, "cursor-after-critical");

const transcript = "Q".repeat(110_000);
const normalizedTranscript = normalizeMcpToolResult({
  content: [{ type: "text", text: JSON.stringify({ transcript }) }],
  structuredContent: null,
  isError: false,
});
assert.equal(normalizedTranscript.transcript, transcript);

const transcriptSegments = Array.from({ length: 80 }, (_, index) => ({
  speaker: index % 2 === 0 ? "Analyst" : "Executive",
  text: `${index}: ${"segment ".repeat(30)}`,
}));
const normalizedSegments = normalizeMcpToolResult({
  content: [],
  structuredContent: { transcript: transcriptSegments },
  isError: false,
});
assert.equal(normalizedSegments.transcript.length, transcriptSegments.length);

const metadataFallback = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: null,
    _meta: { masterkey: { status: "complete", result: "metadata-result" } },
    isError: false,
  },
  masterkeyMcpNormalizationPolicy("get_result"),
);
assert.equal(metadataFallback.result, "metadata-result");

const nullToolResult = normalizeMcpToolResult({
  content: [{ type: "text", text: "must not replace explicit null" }],
  toolResult: null,
  isError: false,
});
assert.equal(nullToolResult, null);

const oversized = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    serviceId: "large-data-service",
    outputs: Array.from({ length: 50 }, (_, index) => ({
      id: index,
      text: "x".repeat(50_000),
    })),
    summary: "Large result",
  },
  isError: false,
});
assert.ok(JSON.stringify(oversized).length <= 120_000);

const immutableHardCap = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: { text: "x".repeat(250_000) },
    isError: false,
  },
  { maxOutputCharacters: 1_000_000 },
);
assert.ok(JSON.stringify(immutableHardCap).length <= 120_000);

const immutableArrayCap = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: {
      items: Array.from({ length: 510 }, (_, index) => index),
    },
    isError: false,
  },
  { maxArrayItems: 1_000_000 },
);
assert.equal(immutableArrayCap.items.length, 501);
assert.match(String(immutableArrayCap.items.at(-1)), /10 additional items/u);

const immutableResultCap = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: {
      results: Array.from({ length: 510 }, (_, index) => index),
    },
    isError: false,
  },
  { maxResultItems: 1_000_000 },
);
assert.equal(immutableResultCap.results.length, 501);
assert.match(String(immutableResultCap.results.at(-1)), /10 additional items/u);

// Gap D: objects beyond the 100-key cap must report which fields were dropped,
// not only the count, so the model can retrieve a known-but-omitted field.
const wideObject = normalizeMcpToolResult({
  content: [],
  structuredContent: Object.fromEntries(
    Array.from({ length: 180 }, (_, index) => [
      `field_${String(index).padStart(3, "0")}`,
      index,
    ]),
  ),
  isError: false,
});
assert.equal(wideObject.fieldsOmitted, 80);
assert.ok(Array.isArray(wideObject.fieldsOmittedNames));
// The name list itself is bounded (50 names + one overflow marker).
assert.equal(wideObject.fieldsOmittedNames.length, 51);
assert.match(String(wideObject.fieldsOmittedNames.at(-1)), /more field names omitted/u);
// Specific dropped fields are nameable (not just counted); names beyond the cap
// fall under the overflow marker rather than being listed individually.
assert.ok(wideObject.fieldsOmittedNames.includes("field_100"));
assert.ok(wideObject.fieldsOmittedNames.includes("field_149"));
assert.ok(!wideObject.fieldsOmittedNames.includes("field_179"));

const modestlyWideObject = normalizeMcpToolResult({
  content: [],
  structuredContent: Object.fromEntries(
    Array.from({ length: 120 }, (_, index) => [`k_${index}`, index]),
  ),
  isError: false,
});
assert.equal(modestlyWideObject.fieldsOmitted, 20);
assert.equal(modestlyWideObject.fieldsOmittedNames.length, 20);
assert.ok(!String(modestlyWideObject.fieldsOmittedNames).includes("more field names"));

// Gap E: the depth cutoff marker must name why data was dropped (a depth limit),
// so the model does not read it as "the field was empty/absent".
let deeplyNested = { leaf: "value" };
for (let index = 0; index < 15; index += 1) {
  deeplyNested = { nested: deeplyNested };
}
const depthLimited = normalizeMcpToolResult({
  content: [],
  structuredContent: deeplyNested,
  isError: false,
});
assert.match(JSON.stringify(depthLimited), /nested data omitted: exceeds Eve's 10-level depth limit/u);

const mixedContent = normalizeMcpToolResult({
  content: [
    { type: "text", text: "Result summary" },
    {
      type: "resource_link",
      uri: "https://example.com/result.json",
      name: "result",
    },
  ],
  structuredContent: null,
  isError: false,
});
assert.match(JSON.stringify(mixedContent), /result\.json/u);

const credentialResult = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    postFields: {
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-signature": "secret-signature",
      policy: "secret-policy",
    },
    aws_secret_access_key: "provider-prefixed-secret",
    openai_api_key: "provider-api-key",
    credentials: { username: "user", password: "password" },
    note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    token: "bare-token-secret",
    publicUrl: "https://files.example.com/object",
  },
  isError: false,
});
const credentialText = JSON.stringify(credentialResult);
assert.equal(credentialText.includes("secret-signature"), false);
assert.equal(credentialText.includes("secret-policy"), false);
assert.equal(credentialText.includes("provider-prefixed-secret"), false);
assert.equal(credentialText.includes("provider-api-key"), false);
assert.equal(credentialText.includes("abcdefghijklmnopqrstuvwxyz"), false);
assert.equal(credentialText.includes("bare-token-secret"), false);
assert.match(credentialText, /files\.example\.com/u);

assert.throws(
  () =>
    normalizeMcpToolResult({
      content: [],
      structuredContent: {
        outputs: [
          {
            url: "https://bucket.example.com/object?X-Amz-Signature=secret-output-signature",
          },
        ],
      },
      isError: false,
    }),
  /credential-bearing output URL/u,
);

for (const url of [
  "https://bucket.example.com/object?sv=2024-11-04&sig=azure-sas-secret",
  "https://example.com/object#access_token=fragment-secret",
]) {
  assert.throws(
    () =>
      normalizeMcpToolResult({
        content: [],
        structuredContent: { outputs: [{ url }] },
        isError: false,
      }),
    /credential-bearing output URL/u,
  );
}

for (const structuredContent of [
  {
    uploadUrl: "https://uploads.example.com/private-capability/path-only-token",
  },
  {
    callbackUrl: "https://username:password@example.com/callback",
  },
  {
    signedUrl: "https://files.example.com/private-capability/path-only-token",
  },
  {
    signedUrl:
      "s3://private-bucket/object?X-Amz-Signature=structured-uri-secret",
  },
  {
    signedUri: "s3://private-bucket/path-only-signed-uri",
  },
  {
    presignedUri: "gs://private-bucket/path-only-presigned-uri",
  },
  {
    uploadUri: "r2://private-bucket/path-only-upload-uri",
  },
  {
    nested: {
      outputs: [
        {
          outputUrl:
            "https://files.example.com/object?X-Amz-Signature=nested-secret",
        },
      ],
    },
  },
]) {
  assert.throws(
    () =>
      normalizeMcpToolResult({
        content: [],
        structuredContent,
        isError: false,
      }),
    /credential-bearing output URL/u,
  );
}

assert.throws(
  () =>
    normalizeMcpToolResult({
      content: [
        { type: "text", text: "artifact" },
        {
          type: "resource_link",
          uri: "https://files.example.com/object#access_token=resource-secret",
        },
      ],
      isError: false,
    }),
  /credential-bearing output URL/u,
);

for (const text of [
  "signedUrl: https://files.example.com/private/path-capability",
  'signedUrl: "https://files.example.com/private/quoted-capability"',
  "signedUrl: [download](https://files.example.com/private/markdown-capability)",
  `signedUrl: [${"long-wrapper-".repeat(20)}](https://files.example.com/private/long-wrapper-capability)`,
]) {
  assert.throws(
    () =>
      normalizeMcpToolResult({
        content: [{ type: "text", text }],
        isError: false,
      }),
    /credential-bearing output URL/u,
  );
}

const manySafeUris = Array.from(
  { length: 3_000 },
  (_, index) => `https://example.com/public/${index}`,
).join(" ");
const normalizedManySafeUris = normalizeMcpToolResult({
  content: [{ type: "text", text: manySafeUris }],
  isError: false,
});
assert.ok(JSON.stringify(normalizedManySafeUris).length <= 120_000);

// Gap A: an auxiliary inline preview riding alongside usable structured data
// must NOT discard that data. Keep the payload and flag the omitted artifact.
const auxiliaryImageWithData = normalizeMcpToolResult({
  content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }],
  structuredContent: {
    revenue: "123456789.00",
    analysis: "Q3 beat expectations with 12% YoY growth.",
    status: "complete",
  },
  isError: false,
});
assert.equal(JSON.stringify(auxiliaryImageWithData).includes(imageBytes), false);
assert.equal(auxiliaryImageWithData.revenue, "123456789.00");
assert.equal(
  auxiliaryImageWithData.analysis,
  "Q3 beat expectations with 12% YoY growth.",
);
assert.equal(auxiliaryImageWithData.inlineArtifactsOmitted, true);

// A thin status wrapper is still usable data: keep it, flag the omitted artifact,
// and never embed the binary.
const statusWithAuxiliaryImage = normalizeMcpToolResult({
  content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }],
  structuredContent: { status: "complete" },
  isError: false,
});
assert.equal(statusWithAuxiliaryImage.status, "complete");
assert.equal(statusWithAuxiliaryImage.inlineArtifactsOmitted, true);
assert.equal(JSON.stringify(statusWithAuxiliaryImage).includes(imageBytes), false);

const embeddedImageWithStatus = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    status: "complete",
    nested: { images: [imageBytes] },
  },
  isError: false,
});
assert.equal(embeddedImageWithStatus.status, "complete");
assert.equal(embeddedImageWithStatus.inlineArtifactsOmitted, true);
assert.equal(JSON.stringify(embeddedImageWithStatus).includes(imageBytes), false);

// When the media IS the whole deliverable (no structured/text payload), Eve still
// cannot retain it and must fail explicitly rather than pretend success.
for (const mediaOnlyResult of [
  {
    content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }],
  },
  {
    content: [],
    structuredContent: { imageData: imageBytes },
  },
  {
    content: [],
    structuredContent: {
      artifact: {
        data: imageBytes,
        mimeType: "image/jpeg",
        type: "image",
      },
    },
  },
]) {
  assert.throws(
    () =>
      normalizeMcpToolResult({
        ...mediaOnlyResult,
        isError: false,
      }),
    /without a durable URL/u,
  );
}

// Gap B: retention failures must read as "provider delivered, Eve could not
// retain" and must steer away from repaying/retrying, distinct from a provider
// failure. The guidance travels with both the inline-media and signed-URL paths.
for (const failing of [
  { content: [{ type: "image", data: imageBytes, mimeType: "image/jpeg" }] },
  {
    content: [],
    structuredContent: {
      outputs: [
        {
          url: "https://bucket.example.com/object?X-Amz-Signature=secret-output-signature",
        },
      ],
    },
  },
]) {
  let retentionError;
  try {
    normalizeMcpToolResult({ isError: false, ...failing });
  } catch (error) {
    retentionError = error;
  }
  assert.ok(retentionError instanceof McpToolResultError);
  assert.match(retentionError.message, /do not repay or retry/u);
  assert.match(retentionError.message, /job or usage history/u);
}

const nestedDurableMedia = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    nested: {
      images: [imageBytes],
      outputUrl: "https://files.example.com/generated.jpg",
    },
  },
  isError: false,
});
assert.equal(JSON.stringify(nestedDurableMedia).includes(imageBytes), false);
assert.match(JSON.stringify(nestedDurableMedia), /generated\.jpg/u);

const wrappedMediaBytes = imageBytes.match(/.{1,76}/gu).join("\n");
assert.throws(
  () =>
    normalizeMcpToolResult({
      content: [
        { type: "audio", data: wrappedMediaBytes, mimeType: "audio/mpeg" },
      ],
      isError: false,
    }),
  /without a durable URL/u,
);

const durableAudio = normalizeMcpToolResult({
  content: [
    { type: "audio", data: wrappedMediaBytes, mimeType: "audio/mpeg" },
    {
      type: "resource_link",
      uri: "https://files.example.com/generated.mp3",
    },
  ],
  isError: false,
});
assert.equal(JSON.stringify(durableAudio).includes(wrappedMediaBytes), false);
assert.match(JSON.stringify(durableAudio), /generated\.mp3/u);

const durableVideo = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    artifact: {
      type: "video",
      data: wrappedMediaBytes,
      outputUrl: "https://files.example.com/generated.mp4",
    },
  },
  isError: false,
});
assert.equal(JSON.stringify(durableVideo).includes(wrappedMediaBytes), false);
assert.match(JSON.stringify(durableVideo), /generated\.mp4/u);

// Gap F: even when a custom policy prioritizes an unrelated (and large) field
// and omits URL keys entirely, an inline-media result's durable URL must survive
// the context budget rather than being trimmed away and then rejected.
const durableUrlUnderHostilePolicy = normalizeMcpToolResult(
  {
    content: [],
    structuredContent: {
      artifact: {
        imageData: imageBytes,
        diagnostic: "x".repeat(5_000),
        outputUrl: "https://files.example.com/must-survive.jpg",
      },
    },
    isError: false,
  },
  {
    maxOutputCharacters: 2_000,
    priorityKeys: ["diagnostic"],
  },
);
const durableUrlText = JSON.stringify(durableUrlUnderHostilePolicy);
assert.match(durableUrlText, /must-survive\.jpg/u);
assert.equal(durableUrlText.includes(imageBytes), false);
assert.ok(durableUrlText.length <= 2_000);

const mediaArray = normalizeMcpToolResult({
  content: [],
  structuredContent: {
    images: [imageBytes],
    outputUrl: "https://example.com/generated-again.jpg",
  },
  isError: false,
});
assert.equal(JSON.stringify(mediaArray).includes(imageBytes), false);

const longMediaUrl = `https://example.com/image.jpg?description=${"a".repeat(1_100)}`;
const mediaUrlArray = normalizeMcpToolResult({
  content: [],
  structuredContent: { images: [longMediaUrl] },
  isError: false,
});
assert.equal(mediaUrlArray.images[0], longMediaUrl);

assert.throws(
  () =>
    normalizeMcpToolResult({
      content: [{ type: "text", text: "provider rejected the request" }],
      isError: true,
    }),
  McpToolResultError,
);

let secretError;
try {
  normalizeMcpToolResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          aws_secret_access_key: "error-secret",
          detail: "Authorization: Bearer error-bearer-value",
          token: "error-token-value",
        }),
      },
    ],
    isError: true,
  });
} catch (error) {
  secretError = error;
}
assert.ok(secretError instanceof McpToolResultError);
assert.equal(secretError.message.includes("error-secret"), false);
assert.equal(secretError.message.includes("error-bearer-value"), false);
assert.equal(secretError.message.includes("error-token-value"), false);

let signedUrlError;
try {
  normalizeMcpToolResult({
    content: [
      {
        type: "text",
        text: 'signedUrl: [download]("https://files.example.com/private/error-path-capability")',
      },
    ],
    isError: true,
  });
} catch (error) {
  signedUrlError = error;
}
assert.ok(signedUrlError instanceof McpToolResultError);
assert.equal(signedUrlError.message.includes("error-path-capability"), false);

let signedUriError;
try {
  normalizeMcpToolResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          signedUrl:
            "s3://private-bucket/object?X-Amz-Signature=error-uri-secret",
        }),
      },
    ],
    isError: true,
  });
} catch (error) {
  signedUriError = error;
}
assert.ok(signedUriError instanceof McpToolResultError);
assert.equal(signedUriError.message.includes("error-uri-secret"), false);

const encoder = new TextEncoder();
let openStreamController;
const streamingFetch = createBoundedFetch(
  1_024,
  async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          openStreamController = controller;
          controller.enqueue(encoder.encode("event: message\ndata: ready\n\n"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
);
const streamingResponse = await Promise.race([
  streamingFetch("https://example.com/mcp"),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Bounded fetch buffered an open stream.")), 100),
  ),
]);
const streamingReader = streamingResponse.body.getReader();
const firstEvent = await streamingReader.read();
assert.match(new TextDecoder().decode(firstEvent.value), /data: ready/u);
await streamingReader.cancel();
try {
  openStreamController?.close();
} catch {
  // Reader cancellation already closed the fixture stream.
}

const oversizedFetch = createBoundedFetch(
  8,
  async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("123456789"));
          controller.close();
        },
      }),
    ),
);
await assert.rejects(
  oversizedFetch("https://example.com/mcp").then((response) => response.text()),
  /MCP response exceeded 8 bytes/u,
);

const transportErrors = new AbortController();
const signalTransportError = (error) => {
  if (!transportErrors.signal.aborted) transportErrors.abort(error);
};
let inboundController;
const fixtureFetch = createBoundedFetch(
  512,
  async (input, init) => {
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "GET") {
      return new Response(
        new ReadableStream({
          start(controller) {
            inboundController = controller;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    const requestBody =
      init?.body === undefined
        ? input instanceof Request
          ? await input.clone().text()
          : "{}"
        : String(init.body);
    const request = JSON.parse(requestBody || "{}");
    if (request.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "context-fixture", version: "1.0.0" },
        },
      });
    }
    if (request.method !== "tools/call") {
      return new Response(null, { status: 202 });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: message\ndata: ${"x".repeat(1_000)}\n\n`,
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
  signalTransportError,
);
const fixtureClient = await createMCPClient({
  clientName: "context-fixture",
  initializationOptions: {
    signal: transportErrors.signal,
    timeout: 1_000,
  },
  maxRetries: 0,
  onUncaughtError: signalTransportError,
  transport: {
    fetch: fixtureFetch,
    terminateSessionOnClose: false,
    type: "http",
    url: "https://example.com/mcp",
  },
  version: "1.0.0",
});
await assert.rejects(
  Promise.race([
    fixtureClient.callTool({
      arguments: {},
      name: "oversized",
      options: { signal: transportErrors.signal, timeout: 2_000 },
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Oversized MCP stream did not abort promptly.")),
        500,
      ),
    ),
  ]),
  /MCP response exceeded 512 bytes|aborted/iu,
);
await fixtureClient.close();
try {
  inboundController?.close();
} catch {
  // Client close already stopped the inbound fixture stream.
}

console.log("MCP_CONTEXT_SANITIZATION_VERIFIED");
