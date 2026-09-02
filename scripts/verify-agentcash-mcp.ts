import assert from "node:assert/strict";

process.env.X402_PRIVATE_KEY = `0x${"1".repeat(64)}`;

const { callAgentcashMcpTool } = await import(
  "../agent/lib/agentcash-mcp"
);

const settings = await callAgentcashMcpTool("get_settings", {});
assert.equal(
  typeof settings,
  "object",
  "AgentCash get_settings should return a normalized object.",
);
assert.notEqual(settings, null);

console.log("Embedded AgentCash MCP handshake verification passed.");
