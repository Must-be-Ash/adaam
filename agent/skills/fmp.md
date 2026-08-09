---
description: Use Financial Modeling Prep for earnings transcripts, company profiles, congressional disclosures, corporate insider trades, and beneficial-ownership research.
---

# Financial Modeling Prep

Use this procedure whenever a request needs data from the `fmp` connection.

## Find and call the right operation

1. Discover the `fmp` connection with a query describing the dataset and filter needed.
2. Call the narrowest operation that answers the question. Avoid broad latest-data calls
   when a ticker or person-specific operation is available.
3. Never ask for or supply `apikey`; Eve injects `FMP_API_KEY` at execution time.
4. Treat FMP as a structured secondary source. Verify material filing conclusions against
   SEC EDGAR whenever a primary filing is available.

## Dataset workflows

### Earnings calls

1. Call `listEarningCallTranscriptDates` for the ticker.
2. Map the requested period to fiscal year and quarter; do not assume calendar quarter.
3. Call `getEarningCallTranscript` only for the periods needed.
4. Preserve the call date, fiscal period, speakers, and prepared-remarks/Q&A boundaries.
5. Prefer a transcript supplied by the user when it conflicts with FMP, and report the
   discrepancy.

### Company identity

- Call `getCompanyProfile` to map a ticker to company name, exchange, sector, and CIK.
- Normalize a CIK to ten digits for SEC data APIs and remove leading zeros for SEC archive
  paths.

### Senate and House disclosures

- Use the by-symbol operations for company research, by-name operations for member
  research, and latest-disclosure operations only for broad monitoring.
- Report chamber, member, owner, asset, transaction date, disclosure date, action, and
  disclosed value range.
- STOCK Act reports can be delayed and values are ranges. Do not present them as exact,
  real-time positions or as corporate-insider filings.

### Corporate insiders

1. Use `listInsiderTradesBySymbol` for transactions and
   `getInsiderTradeStatistics` for a coarse screen.
2. Use `searchInsidersByReportingName` only to resolve an insider or reporting CIK.
3. Distinguish open-market purchase code P from grants, exercises, gifts, tax withholding,
   automatic plans, and dispositions.
4. Verify material transactions with the SEC Form 4 document before drawing a conclusion.
5. Call activity a cluster only when at least two distinct insiders made qualifying
   open-market purchases in the stated window.

### Beneficial ownership

- Use `getBeneficialOwnershipAcquisitions` to find ownership-change disclosures, then
  verify material ownership percentages and control claims against the linked SEC filing.

## Errors and access limits

- `402 Restricted Endpoint` with an upgrade message is an FMP subscription restriction.
  It is not an x402 payment challenge. Do not retry, attempt payment, or imply that the
  dataset was checked successfully.
- Authentication errors mean the deployment's `FMP_API_KEY` must be checked.
- On rate limiting, reduce calls and avoid requesting pages not needed for the answer.
- State missing coverage explicitly and continue with user-provided sources or SEC data
  when those sources can answer the question.

## Evidence

For every material result, identify the FMP dataset, ticker or person filter, covered
period, and source URL when returned. Separate FMP-derived facts from SEC-verified facts
and from interpretation.
