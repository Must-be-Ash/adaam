# Capitol Trades API

Free, no API key required. Data scraped directly from capitoltrades.com via Next.js RSC endpoint.

## What You Get

| Field | Example |
|---|---|
| Politician name | Nancy Pelosi, Rick Allen |
| Trade type | buy / sell |
| Ticker | AAPL:US, AMD:US, NVDA:US |
| Issuer name | Apple Inc, Advanced Micro Devices |
| Trade date | 2026-02-02 |
| Publication date | 2026-03-13T13:01:57Z |
| Trade amount range | $1K–$15K (low/high bounds) |
| Reporting delay | Days between trade and filing |
| Politician ID | STOCK Act ID (e.g. B001277) |
| Chamber | House / Senate |
| Party | Democrat / Republican |

Coverage: 34,821 trades, 201 politicians, $2.3B volume, last 3 years.

## How to Fetch

Capitol Trades is a Next.js app. To get structured data, request the page with the `RSC: 1` header — this returns the React Server Component payload with embedded JSON data instead of rendered HTML.

### Request

```bash
curl -s "https://www.capitoltrades.com/trades?page=1" \
  -H "User-Agent: Mozilla/5.0" \
  -H "RSC: 1" \
  -H "Next-Router-State-Tree: %5B%22%22%2C%7B%22children%22%3A%5B%22(public)%22%2C%7B%22children%22%3A%5B%22trades%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D"
```

### Pagination

Append `?page=N` to paginate through results.

### Parsing the Response

The response is an RSC stream (not JSON). Extract fields using regex:

```python
import re

# Key fields to extract
pub_dates = re.findall(r'"pubDate":"([^"]+)"', data)
tx_types = re.findall(r'"txType":"([^"]+)"', data)
tx_dates = re.findall(r'"txDate":"([^"]+)"', data)
issuers = re.findall(r'"issuerName":"([^"]+)"', data)
tickers = re.findall(r'"issuerTicker":"([^"]+)"', data)
politicians = re.findall(r'"fullName":"([^"]+)"', data)
amounts_low = re.findall(r'"txAmountRangeLow":(\d+)', data)
amounts_high = re.findall(r'"txAmountRangeHigh":(\d+)', data)
```

### Example Output

```
2026-02-02 | Robert Aderholt  | sell | 3M Co                  | MMM:US
2026-02-04 | Jake Auchincloss | sell | 3M Co                  | MMM:US
2026-02-02 | Rick Allen       | buy  | Advanced Micro Devices | AMD:US
2026-02-02 | Earl Blumenauer  | buy  | Apple Inc              | AAPL:US
2026-02-12 | Cliff Bentz      | sell | AT&T Inc               | T:US
2026-02-02 | Stephanie Bice   | buy  | Boeing Co              | BA:US
2026-02-12 | John Boozman     | sell | Broadcom Inc           | AVGO:US
```

## Sort Options

The frontend supports these sort params (may work as query params):
- `-pubDate` — Publication date newest first (default)
- `pubDate` — Publication date oldest first
- `-txDate` — Trade date newest first
- `txDate` — Trade date oldest first
- `reportingGap` — Reporting delay shortest first
- `-reportingGap` — Reporting delay longest first

## Rate Limits

No known rate limits. No authentication required. Be respectful — add delays between requests if polling frequently.

## Notes

- Data covers the last 3 years only
- Tickers use format `AAPL:US` — strip `:US` suffix to match Hyperliquid tickers
- This is an unofficial method — Capitol Trades could change their frontend at any time
- For a more stable scraper, see: https://apify.com/saswave/capitol-trades-scraper/api
- Rust client that reverse-engineers the same endpoints: https://github.com/TommasoAmici/capitoltrades/tree/main/crates/capitoltrades_api
