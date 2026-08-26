import assert from "node:assert/strict";

import { safeCoinbaseFailure } from "../agent/lib/coinbase-cli.ts";
import { McpToolResultError } from "../agent/lib/mcp-tool-result.ts";

const OPAQUE = "The Coinbase request failed without a safe diagnostic.";

// Coinbase reports API rejections as human-readable `HTTP <status>: <message>`
// text, not the enum codes the classifier was originally written against. Every
// one of these was collapsing into the opaque fallback, which left the agent and
// the user with no reason a trade failed and nothing to correct.
for (const [text, expected] of [
  ["HTTP 400: invalid quote size too small", /invalid quote size too small/u],
  ["HTTP 400: invalid base size too small", /invalid base size too small/u],
  ["HTTP 400: order size exceeds available balance", /exceeds available balance/u],
  ["HTTP 400: product is not available", /product is not available/u],
  ["PREVIEW_INVALID_QUOTE_SIZE_TOO_SMALL", /PREVIEW_INVALID_QUOTE_SIZE_TOO_SMALL/u],
]) {
  const failure = safeCoinbaseFailure(new McpToolResultError(text));
  assert.match(failure.message, expected, `Lost the Coinbase reason for: ${text}`);
  assert.notEqual(failure.message, OPAQUE);
  assert.match(failure.message, /not submitted/u, `Missing retry guidance for: ${text}`);
}

// The pre-existing specific classifications still take precedence.
for (const [text, expected] of [
  ["HTTP 400: insufficient fund", /insufficient available funds/u],
  ["HTTP 401: Unauthorized", /authentication failed/u],
  ["HTTP 403: missing required scopes", /portfolio scope/u],
  ["INVALID_VALUE", /Re-check the product/u],
  ["HTTP 504: request timed out", /completion state is unknown/u],
]) {
  assert.match(safeCoinbaseFailure(new McpToolResultError(text)).message, expected);
}

// A 5xx may drop the response to an already-accepted write, so it must never be
// reported as a clean rejection.
const serverError = safeCoinbaseFailure(
  new McpToolResultError("HTTP 500: internal server error"),
);
assert.match(serverError.message, /completion state is unknown/u);
assert.doesNotMatch(serverError.message, /not submitted/u);

const rateLimited = safeCoinbaseFailure(
  new McpToolResultError("HTTP 429: too many requests"),
);
assert.match(rateLimited.message, /rate-limited/u);
assert.match(rateLimited.message, /rejected rather than executed/u);

// Only a normalized MCP tool result is safe to echo. Transport, spawn and exec
// failures can carry child stderr or environment fragments that hold
// COINBASE_KEY_SECRET, so they must stay opaque.
const execFailure = Object.assign(new Error("Command failed: coinbase mcp"), {
  stderr: "COINBASE_KEY_SECRET=super-secret-private-key-value\n",
  stdout: "",
});
assert.equal(safeCoinbaseFailure(execFailure).message, OPAQUE);
assert.equal(
  safeCoinbaseFailure(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))
    .message,
  OPAQUE,
);
assert.equal(
  safeCoinbaseFailure(new Error("MCP error -32000: Connection closed")).message,
  OPAQUE,
);
assert.equal(safeCoinbaseFailure("boom").message, OPAQUE);

// Defense in depth: a live credential echoed back inside an MCP result is scrubbed.
const previousSecret = process.env.COINBASE_KEY_SECRET;
process.env.COINBASE_KEY_SECRET = "super-secret-private-key-value";
try {
  const poisoned = safeCoinbaseFailure(
    new McpToolResultError("HTTP 400: rejected key super-secret-private-key-value"),
  );
  assert.doesNotMatch(poisoned.message, /super-secret-private-key-value/u);
  assert.match(poisoned.message, /\[credential omitted\]/u);
} finally {
  if (previousSecret === undefined) delete process.env.COINBASE_KEY_SECRET;
  else process.env.COINBASE_KEY_SECRET = previousSecret;
}

// The echoed reason stays bounded so a hostile or oversized body cannot flood context.
const long = safeCoinbaseFailure(
  new McpToolResultError(`HTTP 400: ${"x".repeat(5_000)}`),
);
assert.ok(long.message.length < 600, `Unbounded diagnostic: ${long.message.length}`);

console.log("COINBASE_FAILURE_DIAGNOSTICS_VERIFIED");
