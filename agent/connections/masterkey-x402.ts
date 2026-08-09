import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const MASTERKEY_MCP_URL = "https://www.masterkey.sh/mcp";

export default defineMcpClientConnection({
  url: MASTERKEY_MCP_URL,
  description:
    "Masterkey paid x402 data-service fallback. Use it only when user-provided sources and direct Financial Datasets, FMP, or SEC access are unavailable, restricted, or missing the required dataset. It can discover a service, show its schema and price, enforce the user's spend limits, pay the provider, and return the result.",
  auth: connect({
    connector: "www.masterkey.sh/masterkey",
    displayName: "Masterkey",
    tokenParams: {
      resources: [MASTERKEY_MCP_URL],
      scopes: ["mcp:read", "mcp:run"],
    },
  }),
  approval: ({ session }) =>
    session.auth.current?.principalType === "runtime"
      ? {
          type: "denied",
          reason: "Scheduled public-feed checks cannot use paid services.",
        }
      : "not-applicable",
  tools: {
    allow: [
      "search_services",
      "get_service",
      "estimate_cost",
      "get_limits",
      "get_usage",
      "run_service",
      "get_result",
    ],
  },
});
