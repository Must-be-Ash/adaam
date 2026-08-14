import assert from "node:assert/strict";

import { BoundedStdioMCPTransport } from "../agent/lib/bounded-stdio-transport.ts";

function timeout(ms, label) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms),
  );
}

// 1) Faithful JSON-RPC framing: a newline-delimited request/response round-trip
// must still parse correctly through the bounded buffer.
const echoChild = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }) + "\\n",
      );
    }
  }
});
`;

{
  const transport = new BoundedStdioMCPTransport({
    args: ["-e", echoChild],
    command: process.execPath,
    maximumBytes: 1024 * 1024,
    stderr: "ignore",
  });
  const received = new Promise((resolve) => {
    transport.onmessage = resolve;
  });
  await transport.start();
  await transport.send({
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {},
  });
  const message = await Promise.race([
    received,
    timeout(3_000, "round-trip response"),
  ]);
  assert.equal(message.id, 1);
  assert.equal(message.result.echoed, "initialize");
  await transport.close();
}

// 2) A single oversized frame (no newline) must abort before the buffer grows
// without bound, surfacing a McpResponseTooLargeError rather than parsing.
{
  const floodChild = `process.stdout.write("x".repeat(5_000_000));`;
  let limitError;
  const transport = new BoundedStdioMCPTransport({
    args: ["-e", floodChild],
    command: process.execPath,
    maximumBytes: 1_024,
    onLimitExceeded: (error) => {
      limitError = error;
    },
    stderr: "ignore",
  });
  const errored = new Promise((resolve) => {
    transport.onerror = resolve;
  });
  await transport.start();
  const error = await Promise.race([
    errored,
    timeout(3_000, "oversized abort"),
  ]);
  assert.match(error.message, /exceeded 1024 bytes/u);
  assert.ok(limitError);
  assert.match(limitError.message, /exceeded 1024 bytes/u);
  await transport.close();
}

// 3) A complete oversized frame that already contains its newline must be
// rejected before JSON.parse. The bound applies to each frame, not only an
// unterminated pending buffer.
{
  const completeFloodChild = `
const message = {
  jsonrpc: "2.0",
  id: 1,
  result: { payload: "x".repeat(5_000) },
};
process.stdout.write(JSON.stringify(message) + "\\n");
`;
  const transport = new BoundedStdioMCPTransport({
    args: ["-e", completeFloodChild],
    command: process.execPath,
    maximumBytes: 1_024,
    stderr: "ignore",
  });
  const errored = new Promise((resolve) => {
    transport.onerror = resolve;
  });
  await transport.start();
  const error = await Promise.race([
    errored,
    timeout(3_000, "complete oversized frame"),
  ]);
  assert.match(error.message, /exceeded 1024 bytes/u);
  await transport.close();
}

// 4) A positive-integer byte limit is required.
assert.throws(
  () =>
    new BoundedStdioMCPTransport({
      command: process.execPath,
      maximumBytes: 0,
    }),
  /positive integer/u,
);

console.log("BOUNDED_STDIO_TRANSPORT_VERIFIED");
