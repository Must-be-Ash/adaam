import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "./mcp-tool-result";

const EVAL_PRINCIPAL_ID = "imessage:local-eval-fixture";

export function coinbaseEvalFixtureEnabled(): boolean {
  return (
    process.env.COINBASE_EVAL_FIXTURE === "1" &&
    !process.env.VERCEL_ENV &&
    !process.env.VERCEL_URL
  );
}

export function coinbaseEvalPrincipalId(): string {
  return EVAL_PRINCIPAL_ID;
}

export function coinbaseEvalChildEnvironment(): Record<string, string> {
  const root = join(tmpdir(), "eve-coinbase-eval-fixture");
  const home = join(root, "home");
  const config = join(root, "config");
  mkdirSync(home, { mode: 0o700, recursive: true });
  mkdirSync(config, { mode: 0o700, recursive: true });
  return {
    CI: "1",
    COINBASE_CONFIG_DIR: config,
    COINBASE_ENV: "live",
    COINBASE_KEY_ID: "local-eval",
    COINBASE_KEY_SECRET: "local-eval-fixture",
    COINBASE_NO_HISTORY: "1",
    COINBASE_NO_UPDATE_CHECK: "1",
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
  };
}

export function callCoinbaseEvalTool(
  name: string,
  input: Record<string, unknown>,
): JsonValue {
  switch (name) {
    case "coinbase_balance":
      return {
        accounts: [
          {
            available_balance: { currency: "BTC", value: "0.0125" },
            currency: "BTC",
            hold: { currency: "BTC", value: "0" },
          },
          {
            available_balance: { currency: "USD", value: "25.00" },
            currency: "USD",
            hold: { currency: "USD", value: "0" },
          },
        ],
        has_next: false,
      };
    case "coinbase_products_get":
      return {
        base_currency_id: "BTC",
        base_increment: "0.00000001",
        base_min_size: "0.00000001",
        price: "100000.00",
        product_id:
          typeof input.product_id === "string" ? input.product_id : "BTC-USD",
        product_type: "SPOT",
        quote_currency_id: "USD",
        quote_increment: "0.01",
        status: "ONLINE",
      };
    case "coinbase_orders_preview":
      return {
        best_ask: "100000.00",
        commission_total: "0.01",
        order_total: "1.01",
        preview_id: "local-eval-preview",
        product_id: "BTC-USD",
        quote_size: "1.00",
        side: "BUY",
      };
    case "coinbase_orders_create":
      return {
        success: true,
        success_response: {
          order_id: "local-eval-order",
          product_id: "BTC-USD",
          side: "BUY",
        },
      };
    default:
      throw new Error(`Unsupported Coinbase eval fixture tool: ${name}`);
  }
}
