# Earnings Call Analyser

An eve research agent that compares management language across earnings calls,
quantifies linguistic shifts, cross-checks them against financial and SEC data, and
monitors official public feeds for user-defined events.

It accepts public URLs and PDF, image, Markdown, or plain-text attachments through the
HTTP API and Telegram. Photon-backed iMessage messages use the same agent workflow.

## Configure

Copy the non-secret template and fill values in `.env.local`:

```bash
cp .env.example .env.local
```

- `FMP_API_KEY` must have access to FMP's earnings-call transcript endpoints.
- `SEC_USER_AGENT` must identify your application and include a monitored contact,
  following SEC fair-access guidance.
- Configure a model credential directly or run `npm exec -- eve link` for Vercel AI
  Gateway.

Never commit `.env.local`.

## Telegram

Create a bot with BotFather, set `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_BOT_USERNAME` (without `@`), and a random
`TELEGRAM_WEBHOOK_SECRET_TOKEN`. After deployment, register the webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_HOST/eve/v1/telegram","secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'","allowed_updates":["message","callback_query"]}'
```

## iMessage

The Photon project and app-scoped Vercel Connect connector are provisioned. The channel
resolves its project credential through Vercel Connect, so no Photon project secret is
stored in source or `.env.local`.

## Masterkey fallback

Masterkey is connected through the user-scoped Vercel Connect connector
`www.masterkey.sh/masterkey`. It is a paid x402 fallback for datasets that a
user-supplied source or direct Financial Datasets, FMP, or SEC connection cannot provide;
it is not the primary financial-data source.

The first Masterkey tool call for an Eve user may return an authorization link. Sign in
to Masterkey and approve it once; Vercel Connect stores and refreshes the OAuth grant.
No Masterkey token or provider wallet key belongs in `.env.local`.

Eve calls Masterkey through guarded local wrappers rather than exposing the raw MCP
results. The wrappers keep one structured response, cap broad catalog results, bound
oversized data, and remove inline base64 media while preserving durable output URLs.
This prevents generated image bytes and duplicate response envelopes from being replayed
through every later model call. No raw declarative Masterkey connection is registered,
so connection discovery cannot fetch its catalog outside those transport bounds.

### Exa web research

Eve can use Exa through Masterkey for semantic search, grounded structured output,
known-URL content extraction, cited answers, and similar-page discovery. The first-party
x402 routes are used for Search and Contents; Masterkey currently routes Answer and
Find Similar through its StableEnrich backend. Eve defaults to `auto` search with
highlights, bounds first-party x402 searches to 10 results, and reserves deep modes or
forced live crawls for requests that need them.

An `EXA_API_KEY` is not required for Eve's x402 path and is never passed to Masterkey.
If one is configured locally, it is only an optional direct-API comparison credential.

### Coinbase for Agents

Eve loads the official `@coinbase/coinbase-cli` MCP schemas through a local stdio bridge.
This keeps Coinbase's market, account, order, portfolio, conversion, and transfer tool
contracts current without hand-maintaining one wrapper per endpoint. The bridge starts a
fresh credential-isolated MCP process for each call and disables CLI history. Every
result passes through the shared MCP normalizer with a Coinbase policy that preserves
exact financial identifiers, decimal strings, timestamps, and pagination cursors while
bounding lists and removing unsafe data.

Configure `COINBASE_KEY_ID` and `COINBASE_KEY_SECRET` from a CDP key scoped to a
dedicated, minimally funded Advanced Trade portfolio. Then add the intended private-chat
identities to `COINBASE_ALLOWED_PRINCIPALS`. From that iMessage or private Telegram
conversation, ask Eve to call `coinbase_access_status`; it returns the exact principal
ID without exposing credentials or account data. Copy the complete value, including its
`imessage:` or `telegram:` prefix; a bare phone number is not a principal ID. This is
Eve's separate owner allowlist, so the iMessage number does not need to be associated
with the Coinbase account authenticated by the CDP key. Each fork configures its own
credentials and allowed principals in its deployment environment—no owner's identity is
hardcoded in the template.

Market data is read-only. Private balances, portfolios, orders, and fills require human
approval, as does every mutation. Live order creation uses Eve's separate
preview-token flow: the user must review an exact preview and approve an unchanged order
within five minutes. Native unguarded order creation, credential switching, and
non-spot position closing are not exposed. Scheduled event checks cannot access
Coinbase.

### MCP adapter standard

Every future HTTP or stdio MCP must follow
[the mandatory adapter pattern](./MCP_ADAPTER_PATTERN.md). Raw MCP results must not enter
Eve history directly. Each provider gets a small normalization policy and reuses the
shared result sanitizer; HTTP providers also use the bounded streaming transport.

## Public feeds and dynamic event triggers

Eve has a curated catalog of official SEC, issuer IR, Federal Reserve, BLS, BEA,
FTC/DOJ, and relevant sector-regulator sources. The catalog includes fixed RSS/Atom
feeds plus templates for company-specific EDGAR, openFDA, and NHTSA queries.

There are no preset alerts. From iMessage or a private Telegram chat, a user can ask Eve
to create, list, change, pause, resume, or delete a trigger. Telegram groups cannot
manage triggers. For example:

- “Watch Apple's 8-K feed every 15 minutes and alert me only for guidance changes.”
- “List my event triggers.”
- “Pause the Apple filing alert.”
- “Delete that alert.”

Rules are isolated by authenticated user and persisted in the `eve-feed-triggers`
Upstash Redis resource. Vercel injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`; do
not put their values in source control. A single one-minute Vercel Cron dispatcher
atomically leases due rules. Each check runs in a fresh task session with app identity,
restricted tools, exact source fencing, and no access to the user's conversation history
or OAuth grants. It advances its watermark only after every configured source succeeds,
then posts a matching alert directly to the conversation where the rule was created.

Recurring checks have a 15-minute minimum cadence, expire after 90 days unless renewed,
and are bounded by a 96-run aggregate daily capacity per user plus a global daily budget.
Each user can keep at most 10 triggers, but Eve rejects a new cadence that would exceed
that aggregate capacity. If a channel post succeeds but its Redis checkpoint is
uncertain, Eve pauses the trigger for manual review instead of automatically risking a
duplicate alert.

## Run

```bash
npm run typecheck
npm exec -- eve dev
```

For controllable server-only development, use `npm exec -- eve dev --no-ui`.
