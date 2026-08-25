# Eve

Your own AI investment & research agent built on top of Eve by Vercel

## What you get

- **Personal markets agent** that investigates public companies, strategy ideas, and news on demand
- **iMessage-native** — talk to Eve from your phone (optional HTTP + Telegram adapters too)
- **Guarded brokerage** via Coinbase — read balances freely; every trade needs your explicit approval, principal allowlist, and exact-order preview
- **Research artifacts** — shareable reports, charts, and media at stable URLs
- **Specialized workflows** — like public-event monitoring and congressional & insider signals

## Get started

Paste this into your agent:

```
Read https://adaam.vercel.app/skill & help me launch my own agent.
```

It forks, configures, connects iMessage + Coinbase, deploys, and verifies with you — one guided step at a time.

## Coinbase API key

Use a **dedicated, minimally funded** Advanced Trade spot portfolio — never your main holdings. Create a secret key at [portal.cdp.coinbase.com/api-keys/secret](https://portal.cdp.coinbase.com/api-keys/secret):

- Leave the **IP allowlist empty** and enable **Opt-out of IP allowlisting** (Vercel egress isn't fixed)
- Open **Advanced settings** → under **Coinbase App & Advanced Trade**, select **only** your dedicated portfolio
- Enable exactly four permissions: **View**, **Trade**, **Transfer**, **Receive** — and nothing else
- Keep **Export (private key)** and **Manage (policies)** disabled
- Keep **Ed25519 (Recommended)** — do not switch to ECDSA

Store the key in your password manager and paste `COINBASE_KEY_ID` + `COINBASE_KEY_SECRET` straight into Vercel's Production env vars. Never put credentials in chat, source, or commits.

