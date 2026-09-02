---
description: Use for research, a dossier, or an investment overview of a cryptocurrency, token, or crypto spot market, including vague prompts such as "research HYPE."
---

# Crypto-asset research

Turn a vague crypto-research request into a complete, evidence-backed dossier without
requiring the user to enumerate every research dimension. Do not use this workflow for
stocks, earnings calls, funds, or private portfolio analysis.

## Default depth

For a prompt such as “research HYPE,” run the full dossier automatically. Multiple x402
calls are allowed within the configured AgentCash limits. Each paid call uses Eve's native
approval; do not ask for a second conversational approval. Ask a focused question only when the asset identity or
requested market is genuinely ambiguous.

The default dossier covers:

1. Resolve the asset, symbol, network, and relevant Coinbase spot product. Do not silently
   substitute a different quote currency or a similarly named token.
2. Market behavior: current context, 30-day volume versus the prior 30 days, 60-day
   candles, return/volatility context, and notable regime changes.
3. Coinbase liquidity when listed: spread, visible bid/ask depth, concentration, and the
   approximate size likely to move through the displayed book. State the observation
   time because order books change continuously.
4. Capital-flow evidence: exchange flows, labeled-wallet behavior, holder changes, or
   other defensible proxies. Never call generic price or volume movement “smart money.”
   State when wallet labels or onchain coverage are incomplete.
5. Public sentiment across more than one relevant source. Distinguish measured
   sentiment, engagement, and anecdotal posts; do not infer a population-wide view from
   a small sample.
6. Current project, ecosystem, regulatory, token-supply, and macro catalysts that could
   help or hurt price. Separate dated facts from scenarios.
7. Strongest evidence, counterevidence, risks, data gaps, and a calibrated conclusion.

## Tool workflow

- Load the `coinbase` skill before Coinbase calls. Use public product, candle, ticker,
  and order-book data only unless the user separately asks for private account data.
- Load the `agentcash` skill before x402 discovery or execution, and the `exa` skill for
  Exa-backed web research.
- Prefer authoritative direct sources when they answer the question. Use x402 to fill
  distinct missing datasets, not to buy duplicate evidence.
- Check the AgentCash balance when cost is material, discover narrowly, inspect each
  endpoint's schema and cost, then run only calls that add a distinct research dimension.
- Do not retry a paid service merely because Eve could not retain or render its output.
  Recover the original result or report the gap.
- Record provider, covered period, observation time, and source URL as evidence is
  gathered. Keep raw tool envelopes and generated binary data out of the report.

## Deliverable

For a substantial dossier, load the `artifact-publishing` skill and call
`publish_report` with `publicDataOnly: true`. This is the default for a public-data
dossier; the user does not need to say “public,” request a link, name the tool, or choose
a host. Supply structured report blocks rather than writing HTML or pasting a Markdown
document into one text block:

- executive summary, confidence, and verdict;
- metric cards for the highest-signal facts;
- a candlestick chart for OHLC data;
- a line or bar chart for comparative volume;
- a depth chart for order-book levels;
- text/callout blocks for flows, sentiment, catalysts, risks, and data gaps;
- source records for every material claim.

Set `requirements` to `metrics`, `candlestick-chart`, `line-chart` or `bar-chart`
(matching the volume representation), `depth-chart`, and `sources` when those datasets
are available. If a required dataset is unavailable, do not invent it or publish a
different block under that label; explain the gap before publication.

The deterministic renderer owns typography, layout, mobile behavior, and chart
presentation. Keep the chat response concise and end with the exact `artifactMarker`
returned by the publication tool. Keep prose inside report fields plain; use the schema's
heading, bullet, metric, table, and chart fields for structure. Do not include the
internal session/workspace name or routing metadata in the report.

Never place balances, holdings, account identifiers, order history, user information, or
other private data in a public report. If the request mixes public research with private
portfolio context, answer the private portion only in the authenticated chat and publish
only the public-data subset.
