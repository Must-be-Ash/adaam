# Adaam

Your own AI investment & research agent built on top of Eve by Vercel

## What you get

- **Personal markets agent** that investigates public companies, strategy ideas, and news on demand
- **iMessage-native** — talk to Adaam from your phone (optional HTTP + Telegram adapters too)
- **Guarded brokerage** via Coinbase — read balances freely; every trade needs your explicit approval, principal allowlist, and exact-order preview
- **Research artifacts** — shareable reports, charts, and media at stable URLs
- **Specialized workflows** — currently the IPO Filings, Public Commentary Tracker, and Inverse Cramer strategy packs (more in progress)

## Get started

Paste this into your agent:

```
Read https://adaam.vercel.app/skill & help me launch my own agent.
```

It forks, configures, connects iMessage + Coinbase, deploys, and verifies with you — one guided step at a time. **This guided flow is the recommended path** — it handles the storage, connector, and secret-generation steps the deploy button below can't.

### Or deploy manually

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FMust-be-Ash%2Fadaam&project-name=adaam&repository-name=adaam&env=AI_GATEWAY_API_KEY,FMP_API_KEY,COINBASE_KEY_ID,COINBASE_KEY_SECRET,COINBASE_ALLOWED_PRINCIPALS,SEC_USER_AGENT,PHOTON_CONNECTOR_ID,EVE_DEPLOYMENT_OWNER_ID,EVE_PHOTON_OWNER_PRINCIPALS&envDescription=API%20keys%20and%20connector%20IDs%20Adaam%20needs%20to%20run&envLink=https%3A%2F%2Fgithub.com%2FMust-be-Ash%2Fadaam%2Fblob%2Fmain%2F.env.example)

The button clones the repo and prompts for the core API keys. **It does not fully provision Adaam** — after it deploys you still need to complete these steps ([`.env.example`](.env.example) documents every variable):

1. **Redis** — connect the Upstash integration so Vercel injects `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and `REDIS_URL`.
2. **Blob storage** — create a public store and a separate private one:
   ```bash
   vercel blob create-store adaam-artifacts --access public --yes
   # private store injects EVE_HYBRID_EVIDENCE_READ_WRITE_TOKEN
   ```
3. **iMessage** — add the Photon connector: `eve add channel/photon-imessage`.
4. **Generate secrets** — set each HMAC/AES key, e.g.:
   ```bash
   EVE_OWNER_ALIAS_HMAC_SECRET="$(openssl rand -base64 32)"
   ```

## Coinbase API key

Use a **dedicated, minimally funded** Advanced Trade spot portfolio — never your main holdings. Create a secret key at [portal.cdp.coinbase.com/api-keys/secret](https://portal.cdp.coinbase.com/api-keys/secret):

- Leave the **IP allowlist empty** and enable **Opt-out of IP allowlisting** (Vercel egress isn't fixed)
- Open **Advanced settings** → under **Coinbase App & Advanced Trade**, select **only** your dedicated portfolio
- Enable exactly four permissions: **View**, **Trade**, **Transfer**, **Receive** — and nothing else
- Keep **Export (private key)** and **Manage (policies)** disabled
- Keep **Ed25519 (Recommended)** — do not switch to ECDSA

Store the key in your password manager and paste `COINBASE_KEY_ID` + `COINBASE_KEY_SECRET` straight into Vercel's Production env vars. Never put credentials in chat, source, or commits.

> [!WARNING]
> Early and experimental — not intended for production use. Three strategies work today (IPO Filings, Public Commentary Tracker, and Inverse Cramer); others are in progress. Not financial advice.

---

<div align="center">

Built on [Vercel](https://vercel.com/) · [X](https://developer.x.com/) · [Photon](https://photon.codes/) · [Coinbase](https://www.coinbase.com/)

</div>
