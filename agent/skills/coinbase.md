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
   `coinbase_balance`. Resolve proportional wording ("half", "50%", "all of it")
   against the *available* balance you just read, never against a holding
   remembered from earlier in the conversation.
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

## One order per approval, and stop

Run exactly one order through steps 1-6 at a time. Never preview a second order,
and never request a second approval, while an earlier order in the same request
is still previewing, awaiting approval, or executing. A conversation holds one
active approval at a time: a second overlapping request is refused outright, and
the user silently loses that trade.

A request that chains trades is several tasks, not one. "Sell 50% of my BTC and
buy SOL with it" is:

1. Sell 50% of the BTC.
2. Buy SOL with the USD that sale actually realized.

Finish task 1 completely, then **stop and hand the decision back**. Report the
fill - filled size, average price, and the exact proceeds from the create
response - then ask whether to proceed with the next trade, naming the amount now
available. Do not preview, size, or place the second order until the user answers.

This is not only a safety rule, it is the only correct order of operations. Sale
proceeds do not exist until the sell fills, so a buy sized before then is sized
against stale funds and Coinbase rejects it - typically as a quote size below the
product's `quote_min_size`. When the user does authorize the follow-on trade,
re-read `coinbase_balance` and size the buy from the settled balance rather than
from the proceeds you predicted.

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
- When a Coinbase call is rejected, relay the reason it gives verbatim and say what
  would satisfy it. A rejection ends the current task: report it and stop rather
  than silently retrying a different size, a different product, or the next trade
  in the request.
- Never include API keys, secrets, raw authentication errors, or full account objects in
  logs.
