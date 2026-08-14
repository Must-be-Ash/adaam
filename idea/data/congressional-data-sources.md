# Congressional Trade Data Sources — Comparison

## The Answer: No RSS Feed Exists

There is **no free RSS feed** for congressional stock trades from official government sources. The House Clerk and Senate eFD sites don't offer RSS/Atom feeds. Third-party RSS feeds (like FMP) are paywalled.

## Best Free Approach: House Clerk ZIP (No Scraping)

The House Clerk publishes a **single ZIP file** updated daily containing an XML index of all filings for the year. This is the approach we should use.

### Why This Wins

- **No scraping** — it's a single file download, not crawling pages
- **No API key** — completely free, public government data
- **No rate limits** — download once every few hours
- **Primary source** — everyone else (Capitol Trades, Quiver, Finnhub) derives from this
- **PDFs are tiny** — ~87KB, 2 pages each. Easy to pass to Claude for parsing

### How to Detect New Filings (Polling, Not Scraping)

```
Every 4-6 hours:
  1. Download ZIP → https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip
  2. Parse XML → filter for FilingType=P (Periodic Transaction Reports)
  3. Compare DocIDs against previously seen set
  4. For new DocIDs → download PDF, parse trades, trigger signals
```

This is functionally equivalent to an RSS feed — you're checking a single file for new entries.

## All Sources Tested

### 1. House Clerk ZIP (WINNER)
- **URL**: `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip`
- **Cost**: Free
- **Auth**: None
- **Format**: XML index + PDF filings
- **Coverage**: House members only
- **Freshness**: Updated same day as filing
- **Scraping**: No — single file download
- **Status**: ✅ Working — tested and confirmed
- **Details**: See `house-disclosures-api.md`

### 2. Capitol Trades RSC Endpoint
- **URL**: `https://www.capitoltrades.com/trades?page=N` (with RSC headers)
- **Cost**: Free
- **Auth**: None
- **Format**: RSC stream (parse with regex)
- **Coverage**: House + Senate (combined)
- **Freshness**: Hours delay from official filing
- **Scraping**: Technically yes (hitting their Next.js endpoint)
- **Status**: ✅ Working — tested and confirmed
- **Risk**: Could break if they change frontend
- **Details**: See `capitol-trades-api.md`

### 3. Finnhub Congressional Trading
- **URL**: `https://finnhub.io/api/v1/stock/congressional-trading`
- **Cost**: **Paid** (premium only)
- **Auth**: API key required
- **Status**: ❌ Paywalled — returns "You don't have access"
- **Free endpoints are useful for enrichment** (quotes, insider trades, analyst data)
- **Details**: See `finnhub-api.md`

### 4. Senate eFD Search
- **URL**: `https://efdsearch.senate.gov/search/home/`
- **Cost**: Free
- **Auth**: CSRF token required
- **Format**: HTML/JSON via AJAX POST
- **Coverage**: Senate members only
- **Status**: ⚠️ Currently under maintenance. Requires CSRF dance when up.
- **Scraping**: Semi — need to maintain session cookies

### 5. Financial Modeling Prep (FMP)
- **URL**: `https://financialmodelingprep.com/api/v4/senate-trading-rss-feed`
- **Cost**: **Paid** (requires API key, demo key rejected)
- **Has**: Senate Trading RSS, House Disclosure RSS
- **Status**: ❌ Not free — even free tier may not include these endpoints

### 6. Quiver Quantitative
- **URL**: `https://api.quiverquant.com/beta/bulk/congresstrading`
- **Cost**: $10/mo minimum
- **Auth**: API key required
- **Status**: ❌ Paid only — returns 401 without key

### 7. HillSignals
- **URL**: `https://hillsignals.com/latest`
- **Cost**: Free to browse, no API/RSS
- **Freshness**: Updated every 2.3 hours
- **Status**: ❌ No API, no RSS, website only

### 8. Other Trackers
- **TraderCongress** (tradercongress.com) — alerts but no free API
- **InsiderFinance** (insiderfinance.io/congress-trades) — alerts but paid
- **CongressStock** (congressstock.com) — website only
- **NancyPelosiStockTracker** (nancypelosistocktracker.org) — website only

## Recommendation for the Agent

### Primary: House Clerk ZIP
- Poll every 4-6 hours
- Diff DocIDs for new PTR filings
- Download PDFs (tiny, ~87KB each)
- Pass to Claude for structured extraction (ticker, buy/sell, amount, date)

### Backup/Enrichment: Capitol Trades
- Already has parsed data (ticker, politician, type, date, amount)
- Use as fallback or to get Senate data (House Clerk only covers House)
- Use RSC endpoint — no scraping library needed

### Enrichment: Finnhub Free Tier
- Real-time quotes when a signal fires
- Corporate insider activity (double-signal detection)
- Analyst consensus
- Financial metrics for filtering

## Senate Gap

The House Clerk ZIP only covers **House members**. For Senate:
- Capitol Trades covers both (best free option for Senate data)
- Senate eFD (efdsearch.senate.gov) when it's not under maintenance
- FMP has Senate RSS but it's paid

For v1, **House + Capitol Trades for Senate** covers everything.
