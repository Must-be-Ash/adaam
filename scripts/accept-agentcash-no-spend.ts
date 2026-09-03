import assert from "node:assert/strict";

import { agentcashWalletStatus } from "../agent/lib/agentcash-access";
import { callAgentcashMcpTool } from "../agent/lib/agentcash-mcp";

assert.deepEqual(
  agentcashWalletStatus(),
  { evm: true, solana: true },
  "Configure valid X402_PRIVATE_KEY and X402_SOLANA_PRIVATE_KEY values before running AgentCash acceptance.",
);

const result = await callAgentcashMcpTool("discover_api_endpoints", {
  includeGuidance: false,
  url: "https://stableenrich.dev",
});
assert.equal(typeof result, "object");
assert.notEqual(result, null);
assert.equal(
  Array.isArray(Reflect.get(result, "endpoints")),
  true,
  "AgentCash discovery should return the provider endpoint catalog.",
);

console.log(
  "AgentCash production-shaped wallet and discovery acceptance passed; actual spend: $0.00.",
);
