import assert from "node:assert/strict";
import { base58 } from "@scure/base";

process.env.X402_PRIVATE_KEY = `0x${"1".repeat(64)}`;
process.env.X402_SOLANA_PRIVATE_KEY = base58.encode(
  new Uint8Array(32).fill(9),
);

const [{ agentcashChildEnvironment }, { callAgentcashMcpTool }] =
  await Promise.all([
    import("../agent/lib/agentcash-cli"),
    import("../agent/lib/agentcash-mcp"),
  ]);

const childEnvironment = agentcashChildEnvironment();
assert.equal(childEnvironment.X402_PRIVATE_KEY, process.env.X402_PRIVATE_KEY);
assert.equal(
  base58.decode(childEnvironment.X402_SOLANA_PRIVATE_KEY!).length,
  64,
  "AgentCash should receive a normalized 64-byte Solana secret key.",
);

const settings = await callAgentcashMcpTool("get_settings", {});
assert.equal(
  typeof settings,
  "object",
  "AgentCash get_settings should return a normalized object.",
);
assert.notEqual(settings, null);

console.log("Embedded AgentCash two-wallet MCP handshake verification passed.");
