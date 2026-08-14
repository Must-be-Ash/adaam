# Finnhub API

Free tier with API key. 60 calls/minute. Congressional trading endpoint is **paywalled** (premium only), but many other useful endpoints are free.

API Key stored in `.env` as `FINNHUB_API_KEY`.

## What's Free vs Paid

### Free (confirmed working)

| Endpoint | What You Get |
|---|---|
| `/quote` | Real-time price, open, high, low, close, change % |
| `/stock/insider-transactions` | Corporate insider buys/sells (SEC Form 4) — name, shares, price, date |
| `/company-news` | Recent news articles with headlines, source, summary |
| `/stock/recommendation` | Analyst consensus — strong buy/buy/hold/sell counts |
| `/stock/metric` | 100+ financial metrics — P/E, beta, 52wk high/low, EV, margins, growth rates |
| `/calendar/earnings` | Upcoming earnings dates with EPS/revenue estimates |
| `/stock/lobbying` | Lobbying activity data |

### Paywalled (returns "You don't have access")

| Endpoint | What It Would Give You |
|---|---|
| `/stock/congressional-trading` | Congressional trades by ticker — the one we actually wanted |

## How to Use

### Base URL

```
https://finnhub.io/api/v1
```

### Authentication

Append `&token=YOUR_API_KEY` to every request.

### Rate Limits

- **60 calls/minute** on free tier
- No daily limit mentioned

## Useful Endpoints for the Agent

### 1. Real-time Quote

```bash
curl "https://finnhub.io/api/v1/quote?symbol=NVDA&token=$FINNHUB_API_KEY"
```

Response:
```json
{
  "c": 180.25,    // current price
  "d": -2.89,     // change
  "dp": -1.578,   // change %
  "h": 186.09,    // high
  "l": 179.94,    // low
  "o": 184.92,    // open
  "pc": 183.14    // previous close
}
```

### 2. Corporate Insider Transactions (SEC Form 4)

```bash
curl "https://finnhub.io/api/v1/stock/insider-transactions?symbol=NVDA&token=$FINNHUB_API_KEY"
```

Response (per transaction):
```json
{
  "name": "Puri Ajay K",
  "change": -24940,           // shares (negative = sell)
  "transactionCode": "S",     // S=sell, P=purchase, A=award
  "transactionDate": "2026-03-10",
  "transactionPrice": 183.114,
  "filingDate": "2026-03-11",
  "share": 3318547,           // shares held after
  "source": "sec",
  "symbol": "NVDA"
}
```

### 3. Company News

```bash
curl "https://finnhub.io/api/v1/company-news?symbol=NVDA&from=2026-03-01&to=2026-03-13&token=$FINNHUB_API_KEY"
```

Response (per article):
```json
{
  "headline": "Stock Market Today, March 13: Nvidia Slips as GTC 2026 Conference Looms",
  "summary": "On March 13, 2026, investors weighed Nvidia's GTC outlook...",
  "source": "Yahoo",
  "datetime": 1773437382,
  "url": "https://finnhub.io/api/news?id=..."
}
```

### 4. Analyst Recommendations

```bash
curl "https://finnhub.io/api/v1/stock/recommendation?symbol=NVDA&token=$FINNHUB_API_KEY"
```

Response (per month):
```json
{
  "period": "2026-03-01",
  "strongBuy": 25,
  "buy": 42,
  "hold": 5,
  "sell": 1,
  "strongSell": 0
}
```

### 5. Financial Metrics

```bash
curl "https://finnhub.io/api/v1/stock/metric?symbol=NVDA&metric=all&token=$FINNHUB_API_KEY"
```

Returns 100+ metrics including:
- `beta`: 2.39
- `52WeekHigh` / `52WeekLow`
- `currentRatioAnnual`: 3.91
- `enterpriseValue`: $4.5T
- Revenue/earnings growth rates
- Price return over various periods

### 6. Earnings Calendar

```bash
curl "https://finnhub.io/api/v1/calendar/earnings?from=2026-03-10&to=2026-03-20&token=$FINNHUB_API_KEY"
```

Response (per company):
```json
{
  "symbol": "BTCS",
  "date": "2026-03-20",
  "epsEstimate": 0.1632,
  "epsActual": null,
  "revenueEstimate": 4590000,
  "hour": "bmo"          // bmo=before market open, amc=after market close
}
```

## Value for the On-Chain Autopilot

Finnhub can't give us congressional trades (paywalled), but it's excellent for **enriching signals from Capitol Trades**:

1. **Get real-time price** (`/quote`) — know the current price when a politician's trade is disclosed
2. **Check insider activity** (`/insider-transactions`) — are corporate insiders also buying? Double signal.
3. **Analyst sentiment** (`/recommendation`) — is Wall Street bullish too?
4. **Financial health** (`/stock/metric`) — filter out fundamentally weak companies
5. **News context** (`/company-news`) — is there a catalyst driving the trade?

## Docs

- Full API docs: https://finnhub.io/docs/api
- Rate limits: 60 calls/minute free tier
