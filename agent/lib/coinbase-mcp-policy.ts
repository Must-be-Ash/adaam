import type { CallToolResult } from "@ai-sdk/mcp";

import {
  normalizeMcpToolResult,
  type JsonValue,
  type McpNormalizationPolicy,
} from "#mcp-tool-result";

export const COINBASE_MAX_PAGE_ITEMS = 200;
const COINBASE_COLLECTION_KEYS = [
  "orders",
  "fills",
  "accounts",
  "portfolios",
  "products",
  "trades",
  "candles",
] as const;
const COINBASE_PRIMARY_COLLECTION: Readonly<Record<string, string>> = {
  coinbase_balance: "accounts",
  coinbase_orders_fills: "fills",
  coinbase_orders_list: "orders",
  coinbase_portfolios_list: "portfolios",
  coinbase_products_candles: "candles",
  coinbase_products_list: "products",
  coinbase_products_ticker: "trades",
};

export function validateCoinbaseMcpInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (input.limit === undefined) return input;
  if (
    typeof input.limit !== "number" ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > COINBASE_MAX_PAGE_ITEMS
  ) {
    throw new Error(
      `Coinbase result limits must be integers between 1 and ${COINBASE_MAX_PAGE_ITEMS}.`,
    );
  }
  return input;
}

export function coinbaseMcpNormalizationPolicy(
  toolName: string,
): McpNormalizationPolicy {
  const primaryCollection = COINBASE_PRIMARY_COLLECTION[toolName];
  const collectionPriority = primaryCollection
    ? [
        primaryCollection,
        ...COINBASE_COLLECTION_KEYS.filter(
          (key) => key !== primaryCollection,
        ),
      ]
    : COINBASE_COLLECTION_KEYS;
  return {
    maxArrayItems: COINBASE_MAX_PAGE_ITEMS,
    maxOutputCharacters: 120_000,
    maxResultItems: COINBASE_MAX_PAGE_ITEMS,
    priorityKeys: [
      "success",
      "failure_reason",
      "error_response",
      "cursor",
      "has_next",
      ...collectionPriority,
      "order_id",
      "client_order_id",
      "product_id",
      "portfolio_id",
      "trade_id",
      "fill_id",
      "quote_id",
      "conversion_id",
      "transfer_id",
      "account_uuid",
      "uuid",
      "id",
      "order",
      "status",
      "side",
      "type",
      "base_size",
      "quote_size",
      "filled_size",
      "limit_price",
      "stop_price",
      "price",
      "average_filled_price",
      "size",
      "amount",
      "currency",
      "base_increment",
      "quote_increment",
      "base_min_size",
      "base_max_size",
      "quote_min_size",
      "quote_max_size",
      "fee",
      "commission",
      "total_value_after_fees",
      "total_fees",
      "created_time",
      "created_at",
      "last_fill_time",
      "trade_time",
      "time",
      "fees",
      "result",
    ],
    rejectArrayTruncation: true,
  };
}

export function normalizeCoinbaseMcpToolResult(
  result: CallToolResult,
  toolName: string,
): JsonValue {
  return normalizeMcpToolResult(
    result,
    coinbaseMcpNormalizationPolicy(toolName),
  );
}
