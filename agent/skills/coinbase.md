---
description: Use Coinbase for Agents to read spot-market and portfolio data, preview and place spot orders, manage orders and portfolios, transfer funds between portfolios, and convert USD/USDC.
---

# Coinbase for Agents

Use Coinbase only for an allowlisted user in a private iMessage or Telegram
conversation. The API key is scoped to an operator-selected Advanced Trade portfolio.
Coinbase tools are unavailable to scheduled runtime sessions.

Treat `https://docs.cdp.coinbase.com/coinbase-for-agents` as the canonical capability
reference. The dynamic tools use Coinbase's native MCP schemas. Use
`coinbase_access_status` for setup status; never ask the user to paste credentials into
chat.

## Safety boundary

- Spot products only. Never trade perpetuals, futures, leverage, or margin.
- Read-only Coinbase calls do not require a separate approval prompt. Private balances,
  portfolio details, orders, and fills remain restricted to the allowlisted owner in a
  private chat.
- For a balance or holdings request, call `coinbase_balance` once with `limit: 200` and
  `show_zero: false`. Use `show_zero: true` instead only when the user explicitly asks
  for zero-balance currencies. Do not repeat a successful balance read with the opposite
  setting. Do not fetch product prices, tickers, or fiat valuations unless the user asks
  for a valuation.
- Every state-changing action requires approval: create, edit, or cancel an order;
  execute a conversion; create, edit, or delete a portfolio; or transfer funds.
- Never make a trade, transfer, conversion, or portfolio change from a scheduled check,
  inferred preference, prior conversation, price alert, or vague request.
- Do not present a trade as certain, guaranteed, or personalized investment advice.

## Spot-order workflow

1. Resolve the exact product with `coinbase_products_get`. Confirm `product_type` is
   `SPOT`, status is online, and the base/quote currencies match the user's wording.
   Never silently substitute `ETH-USD` for `ETH-USDC`, or vice versa.
2. If sizing depends on holdings, request the relevant balance with
   `coinbase_balance`.
3. Call `coinbase_preview_order` for the exact order. Do not use a raw native
   `coinbase_orders_preview` or `coinbase_orders_create`; they are intentionally hidden.
4. Show the user the exact product, side, order type, base or quote size, estimated fill,
   fees, and slippage, then call `coinbase_create_order` with the unchanged fields and
   fresh preview token. Do not ask for a separate preliminary confirmation: the tool's
   owner-bound Photon mini app is the sole explicit authorization step. Its Approve and
   Deny buttons are authoritative; a thread-bound `YES` or `NO` reply is the fallback.
5. The preview token expires after five minutes and generates a stable Coinbase client
   order ID for retry safety.
6. Report the create response. Do not automatically fetch, edit, or cancel the order
   afterward unless the user asks.

### Size rules

- Market BUY: use `quoteSize`, the amount of USD or USDC to spend.
- Market SELL: use `baseSize`, the quantity of the asset to sell.
- Limit BUY or SELL: use `baseSize` and `limitPrice`.
- Stop-limit: use `baseSize`, `limitPrice`, `stopPrice`, and `stopDirection`.
- Never include both base and quote size.

## Existing orders

Use `coinbase_orders_list`, `coinbase_orders_get`, and `coinbase_orders_fills` for
status and reconciliation. Before editing or cancelling, identify the exact open order
and summarize the requested change. `coinbase_orders_edit` and
`coinbase_orders_cancel` always require approval.

## Portfolio operations

Use `coinbase_portfolios_list` and `coinbase_portfolios_get` to resolve exact portfolio
UUIDs. Before any transfer, state the source portfolio, destination portfolio, currency,
and amount. `coinbase_transfer` moves funds immediately between Coinbase portfolios and
requires approval; it is not an external withdrawal tool.

Creating, renaming, or deleting a portfolio also requires approval. Never delete a
portfolio unless the user explicitly names it and confirms it is empty.

## USD/USDC conversions

Call `coinbase_convert_quote` first and show the rate, fee, amount, currencies, and quote
expiry. Call `coinbase_convert_execute` only after explicit authorization and only with
the matching fresh quote ID. Use `coinbase_convert_get` to inspect status when asked.

## Result handling

- Preserve Coinbase product IDs, portfolio UUIDs, order IDs, quote IDs, amounts,
  currencies, fees, and timestamps exactly as returned.
- Preserve returned pagination cursors. If a normalized list reports omitted items,
  request a narrower page or continue with the exact cursor instead of assuming complete
  coverage.
- Distinguish available balance from funds on hold.
- If a write times out or returns an uncertain result, do not retry automatically.
  Inspect the resulting order or conversion status, or ask the user to reconcile the
  transfer before proceeding.
- Never include API keys, secrets, raw authentication errors, or full account objects in
  logs.
