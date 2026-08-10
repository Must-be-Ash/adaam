---
description: Use Masterkey as a paid x402 fallback when direct financial-data sources cannot provide the required evidence.
---

# Masterkey fallback

Use this procedure only after checking user-provided material and the relevant direct
Financial Datasets, FMP, or SEC connection. Masterkey supplements those sources; it does
not replace them.

## When to use it

Use Masterkey when a direct source is unavailable, subscription-restricted, missing the
requested dataset, or materially incomplete. Do not make a paid call merely to duplicate
evidence already retrieved from a direct source.

Preferred fallback services for this agent are:

- `alphavantage-earnings-call-transcript` for a full transcript that is unavailable from
  a direct provider.
- `x402stock-congress-trades` for House and Senate STOCK Act disclosures that are
  unavailable from a direct provider.
- Follow the `exa` skill for `exa`, `exa-contents`, `exa-answer`, and
  `exa-find-similar` web-research calls.

Discover the service by description if an expected ID is not returned. Do not substitute
`agentstools-congress-trades` for Senate research: that source is House-only. If the
required service is absent from Masterkey, report the gap instead of calling an unrelated
result.

## Discovery and payment workflow

Masterkey's guarded `masterkey-x402__*` tools are already available. Do not call
`connection_search` for Masterkey: that raw MCP path is intentionally disabled so
duplicate response envelopes and binary media do not enter durable model context.

1. Call `masterkey-x402__get_limits` before the first paid Masterkey call in a research
   request.
2. Call `masterkey-x402__search_services` with a narrow description of the missing
   dataset. It returns at most ten results.
3. Call `masterkey-x402__get_service` and verify the input schema, provider, coverage,
   and status.
4. Call `masterkey-x402__estimate_cost` before `masterkey-x402__run_service`.
5. If the known cost is more than $0.10, is dynamic, or is unclear, ask the user before
   running it. Otherwise, make only the minimum calls needed.
6. Call `masterkey-x402__run_service` once with the exact documented input. Eve requires
   explicit user approval and injects a replay-stable idempotency key; never invent or
   request an idempotency key.
7. Call `masterkey-x402__get_result` at most once only when
   `masterkey-x402__run_service` returns an asynchronous job whose output is needed for
   the analysis.

Masterkey handles provider payment and applies the user's configured limits. Never ask
the user for an x402 wallet key, provider API key, or Masterkey access token.
Treat a quoted price as a baseline when request options affect provider work. In
particular, Exa deep search, synthesis, and content retrieval can settle above the
headline search price; use the settled Masterkey charge rather than a provider-reported
cost field when reporting spend.

Masterkey results are compacted before they enter model history: structured output is
preferred over duplicate text envelopes, catalog arrays are bounded, and inline binary
media is replaced by its durable URL. Use `outputs[].url` to show or reuse generated
media; never request or reconstruct base64 bytes when a URL is available.

## Evidence quality

- Treat the provider returned by Masterkey as the source, not Masterkey itself.
- Preserve the provider name, requested ticker or person, covered period, transaction or
  call date, and source links.
- Verify material financial or insider conclusions against SEC filings when possible.
- For congressional disclosures, preserve the chamber, filer, transaction date,
  disclosure date, amount range, and official disclosure URL. These reports are delayed
  and values are ranges.
- If the fallback conflicts with a primary document or user-supplied transcript, prefer
  the primary material and state the discrepancy.
