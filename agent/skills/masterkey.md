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

Discover the service by description if an expected ID is not returned. Do not substitute
`agentstools-congress-trades` for Senate research: that source is House-only. If the
required service is absent from Masterkey, report the gap instead of calling an unrelated
result.

## Discovery and payment workflow

1. Call `get_limits` before the first paid Masterkey call in a research request.
2. Call `search_services` with a narrow description of the missing dataset.
3. Call `get_service` and verify the input schema, provider, coverage, and status.
4. Call `estimate_cost` before `run_service`.
5. If the known cost is more than $0.10, is dynamic, or is unclear, ask the user before
   running it. Otherwise, make only the minimum calls needed.
6. Call `run_service` once with the exact documented input. Supply an idempotency key only
   when retrying the same logical paid call after an interruption; never reuse it for a
   new request.
7. Call `get_result` at most once only when `run_service` returns an asynchronous job
   whose output is needed for the analysis.

Masterkey handles provider payment and applies the user's configured limits. Never ask
the user for an x402 wallet key, provider API key, or Masterkey access token.

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
