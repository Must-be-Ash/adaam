# Eve handoff

Use this as the starting prompt for a new agent taking over the repository.
It is a snapshot and a distillation of prior work, not a substitute for reading
the code.

Snapshot date: 2026-08-11  
Application baseline before this handoff: `161762b` on `main`  
Production alias: <https://earnings-call-analyser.vercel.app>

## Instructions to the receiving agent

You are taking over Eve. Before changing anything:

1. Run `git status --short --branch` and `git log -10 --oneline`.
2. Read this file, `README.md`, and the files listed under **Code map**.
3. Read the relevant installed Eve documentation under `node_modules/eve/docs/`.
4. Verify any claim that matters against current code. Code defines current
   behavior; `NORTH_STAR.md` contains target architecture as well as current
   notes.
5. Run `npm run typecheck` and, for substantive changes, `npm run build`.
6. Do not begin work from the gaps listed below unless the owner asks.

There is no unfinished feature assignment at this snapshot. The latest work was
the accepted session-manager UI polish.

## What we are building

Eve is a forkable, single-owner personal investment-agent template. It began as
an earnings-call research agent and is intended to provide reusable plumbing for
research, data access, dynamic monitoring, isolated chat sessions, evaluations,
and safely approved trading.

The primary interface is iMessage through Photon. HTTP and Telegram also exist,
but the richer session and approval UX is currently centered on iMessage.

The product priorities established so far are:

- get the complete user-visible path working before adding broad abstractions;
- isolate unrelated conversations;
- require exact human approval for financial mutations;
- keep model context and paid-tool responses bounded;
- use simple iMessage-native controls rather than slash commands;
- prefer direct authoritative sources, using Masterkey/x402 as fallback;
- let the owner create monitoring rules dynamically rather than shipping preset
  alerts.

This is designed as a one-owner deployment, not a hosted multi-tenant service.
That is the product target; a general deployment-wide owner allowlist is not yet
implemented. Coinbase has its own separate principal allowlist.

## Current working baseline

The owner tested these paths successfully before this handoff:

- natural-language Coinbase balance requests through Eve's normal tool path;
- Coinbase spot-order preview and creation;
- order approval through the Spectrum mini app;
- order approval and denial through one-word text replies;
- natural-language requests opening the session manager;
- creating, selecting, renaming, archiving, restoring, and starting sessions
  fresh;
- isolated context between named iMessage sessions;
- session-labeled iMessage replies.

Useful historical checkpoints:

- `working-photon-miniapp-2026-08-11`
- `working-photon-approvals-2026-08-11`

These tags predate the latest session-routing work. Use them for diagnosis, not
as a blanket rollback target.

## User-facing UX contract

- Say **session** in user-facing copy. `workspace` is only an accepted alias and
  an internal implementation term.
- Recognized session-management requests should send only the Spectrum manager,
  with no model-written companion reply.
- Every routed iMessage model reply identifies the session that produced it.
- **Start fresh** advances only the selected session's model-history generation.
  Old-continuation cleanup can be uncertain, so do not promise hard deletion.
- The manager UI is intentionally minimal: dark charcoal/grayscale, no blue
  accents, no active badge, no redundant Eve/logo header, and a light
  `#d8d8d8` border for the active session.
- Keep the current button layout.
- Use the supplied Eve logo only for favicon/app metadata.
- Financial approval buttons are **Approve** and **Deny**. Exact one-word text
  fallbacks accepted by the parser are `yes`/`approve` and
  `no`/`deny`/`cancel`.
- General conversational consent is not financial authorization.

## Current architecture

### Agent and channels

- `agent/agent.ts` configures `google/gemini-3.6-flash`, high reasoning, 75%
  compaction, a seven-day session timeout, and no cumulative token caps.
- `agent/channels/photon.ts` is the primary iMessage ingress and response path.
- `agent/channels/photon-workspace-app.ts` is the Spectrum session manager.
- `agent/channels/photon-approval-app.ts` is the Spectrum approval app.
- `agent/channels/eve.ts` exposes the HTTP Eve API.
- `agent/channels/telegram.ts` handles Telegram.
- `agent/schedules/event-triggers.ts` runs the one-minute trigger dispatcher.

### iMessage sessions

User-facing sessions are `PhotonWorkspace` records internally.

- The registry is stored in Redis per authenticated principal and physical
  iMessage thread.
- `Main` preserves the original physical-thread continuation.
- Additional sessions use synthetic Eve thread IDs containing workspace ID and
  generation; the adapter maps replies back to the physical iMessage thread.
- Registry mutations use revisions, mutation IDs, and atomic Redis Lua.
- An active Photon approval blocks session mutations.
- The manager capability is a 15-minute bearer token carried in the URL
  fragment.
- The live router is `agent/lib/photon-workspace-store.ts`.
- `agent/lib/photon-session-store.ts` is legacy migration code and is not used
  by live Photon routing.

Normal iMessage requests use queued Chat SDK handling and
`turnPolicy: "experimental-steer"`. Approval continuations use a queued Eve
turn. Do not change these policies casually; earlier queue/migration changes
blocked working requests.

### Coinbase

- Access is limited by `COINBASE_ALLOWED_PRINCIPALS`.
- Allowlisted reads such as balances, accounts, orders, and fills do not need a
  separate approval.
- Spot-order creation requires `coinbase_preview_order`, a signed exact-order
  token that expires after five minutes, and `coinbase_create_order`.
- Execution revalidates the unchanged order, uses a deterministic client-order
  ID, and stores a Redis operation receipt.
- Photon approvals are bound to the request, exact action, principal, thread,
  Eve session, internal workspace ID, workspace generation, and expiration.
- Text approvals resume directly through the authenticated Photon bridge. Do
  not route them through an OIDC-protected self-HTTP request.
- Never automatically retry an order with an uncertain result.

The uncertain-order guard is limited: it is Eve-session scoped, expires after
24 hours, and is not account-wide broker reconciliation. There is no automated
unblock procedure. Inspect Coinbase's authoritative order state and ask the
owner before further action; do not delete Redis guards to force progress.

The dynamic Coinbase MCP surface also registers conversions, transfers,
portfolio mutations, and generic edit/cancel tools. These are outside the
approved core template. Photon's custom approval path rejects unsupported
Coinbase mutations, but they are not globally disabled. Do not describe the
repository as broadly live-trading ready.

### MCP and data access

Every MCP must follow `MCP_ADAPTER_PATTERN.md`.

- Raw MCP `CallToolResult` data must never enter model history.
- Use a curated tool surface, provider-specific normalization, shared
  `normalizeMcpToolResult()`, explicit bounds/timeouts, approval for writes, and
  regression coverage.
- Preserve exact identifiers, monetary decimal strings, timestamps, cursors,
  statuses, and provenance.
- Strip duplicate envelopes, credentials, unsafe URLs, and inline binary data.

Masterkey is a guarded paid fallback, not the default source. FMP, SEC, supplied
files, and official public feeds should be preferred when they answer the
request. Paid Masterkey `run_service` currently needs approval that Photon's
custom handler does not support, so do not claim paid Masterkey calls work end
to end in iMessage.

Coinbase uses a fresh credential-isolated stdio MCP process per call. Its result
is normalized before entering model history, but the stdio transport does not
yet impose a byte limit before parsing the complete response.

Financial Datasets is referenced in older prose and an OpenAPI file exists, but
there is no active Financial Datasets connection at this snapshot.

### Dynamic event triggers

There are no preset alerts. Authenticated private-channel principals can create,
list, update, pause, resume, and delete rules.

Current store limits:

- minimum cadence: 15 minutes;
- maximum 10 triggers per current principal-derived owner key;
- maximum 96 aggregate runs per key per day;
- global daily budget: 500;
- maximum eight combined sources;
- 90-day trigger lifetime;
- automatic pause after five consecutive failures.

Scheduled runs use isolated runtime sessions with restricted tools, exact source
fencing, and no private chat history, user OAuth, shell/filesystem tools, or
Coinbase access.

Triggers are not yet bound to immutable iMessage session IDs. The create/update
tool schemas also accept more sources than the store; the store's combined limit
of eight is authoritative.

## Code map

Read the files relevant to the task:

- `README.md`: operator-facing setup and supported behavior.
- `NORTH_STAR.md`: product target and strategy/data-source index; some sections
  are aspirational or stale.
- `MCP_ADAPTER_PATTERN.md`: mandatory MCP rules.
- `agent/instructions.md`: Eve's model instructions.
- `agent/channels/photon.ts`: iMessage dispatch, session routing, text approval,
  and lifecycle handling.
- `agent/lib/photon-workspace.ts`: synthetic thread mapping and session intent.
- `agent/lib/photon-workspace-store.ts`: durable session registry.
- `agent/channels/photon-workspace-app.ts`: session-manager HTML/CSS/actions.
- `agent/lib/photon-approval.ts`: approval rendering and text decisions.
- `agent/lib/photon-approval-store.ts`: durable approval state machine.
- `agent/channels/photon-approval-app.ts`: approval mini app.
- `agent/lib/photon-mini-app.ts`: public mini-app URL selection.
- `agent/lib/mcp-tool-result.ts`: shared result sanitizer.
- `agent/lib/masterkey-mcp.ts` and `agent/tools/masterkey_mcp.ts`: Masterkey.
- `agent/lib/coinbase-access.ts`, `agent/lib/coinbase-order.ts`,
  `agent/tools/coinbase_preview_order.ts`,
  `agent/tools/coinbase_create_order.ts`, and
  `agent/tools/coinbase_mcp.ts`: Coinbase.
- `agent/lib/event-trigger-store.ts` and
  `agent/tools/scheduled_tool_guard.ts`: scheduled monitoring.
- `evals/` and `scripts/verify-*.mjs`: actual regression coverage.

The generated `.eve/agent-summary.json` is useful for static routes, tools,
connections, and schedules after a build. It does not enumerate every dynamic
Coinbase or Masterkey tool.

## Durable lessons: do not repeat these failures

1. **Raw MCP output caused extreme token replay.** Duplicate envelopes and
   inline base64 drove one observed session to roughly 9.76 million input
   tokens. Keep the shared sanitizer and provider policies. Verify with
   `npm run verify:context`.
2. **Phrase-specific balance routing was a regression.** A channel-level
   balance matcher made only selected wording work. Normal research/trading
   language must go through Eve; only explicit control protocols such as session
   management and approval replies belong in channel dispatch.
3. **iMessage polls were the wrong approval UI.** Keep the Spectrum mini app and
   strict text fallback.
4. **Automatic session migration blocked ordinary requests.** Do not restore
   the old migration control turn.
5. **Passing Eve evals did not prove Photon worked.** They bypass the webhook,
   adapter, URL generation, Redis delivery, Spectrum UI, and iMessage response.
   Channel changes require channel-level smoke tests.
6. **Preview URLs opened Vercel login.** Keep mini-app origin precedence in
   `agent/lib/photon-mini-app.ts`: explicit override, then
   `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`.
7. **OIDC self-HTTP broke text approval with 401.** Keep direct authenticated
   Photon continuation.
8. **Generic failure cannot release an uncertain order guard.** Release only
   after execution is known to have succeeded or safely failed.
9. **Delayed text could approve a newer request.** Keep activation-time checks,
   zero clock-skew grace, and stable event deduplication.
10. **UI pre-checks did not prevent Redis races.** Keep atomic Lua operations,
    registry revisions, expected generations, and mutation IDs.
11. **Hardening while the main path was broken wasted time.** Restore and test
    the smallest complete path, preserve a checkpoint, then audit or expand.

## Remaining work

`BACKLOG.md` is the canonical inventory of incomplete, postponed, and parked
work. It separates release blockers from foundations, maintenance, and optional
expansion. The list is context, not permission to begin a roadmap; wait for the
owner's next request.

## Verification and operation

Use Node 24, the version declared in `package.json`.

```bash
npm install
cp .env.example .env.local
npm run typecheck
npm run dev
npm run build
```

Use `npm run dev` on a clean checkout so `predev` generates the ignored embedded
Coinbase CLI source. For headless development:

```bash
npm run prepare:coinbase
npm exec -- eve dev --no-ui
```

Focused checks:

```bash
npm run verify:context
npm run verify:approvals
npm run verify:sessions
npm run verify:workspaces
npm run verify:approvals:redis
npm run verify:workspaces:redis
npm run eval:coinbase
```

The Redis checks require their environment variables to be exported; they do
not load `.env.local`. Coinbase evals are local-only, fixture-backed, and make
no real Coinbase call. They test model/tool behavior, not Photon end to end.

The existing deployment also depends on project-specific Vercel Connect Photon
and Masterkey connectors plus Upstash. `eve link` does not provision those
resources for a new fork.

Before deploying, verify the local Vercel project link. Do not commit, push,
deploy, or mutate an external service unless the owner asks.

## Non-negotiable safety rules

- Never remove, bypass, or weaken an existing security control.
- Never put secrets, credentials, real principal values, or signed capabilities
  in source, logs, tests, or documentation.
- Never log message bodies, direct user PII, balances, order amounts, or full
  account/request objects.
- Never use IDs, principals, URLs, timestamps, hashes, or user data as metric
  tags.
- No financial mutation from model prose, prior consent, alerts, schedules, or
  inferred preference.
- A changed financial action requires a fresh preview and approval.
- Never automatically retry an uncertain mutation.
- Session-manager actions cannot authorize financial mutations.
- Raw MCP output cannot enter model history.

When code and this snapshot differ, inspect the change and update this handoff
with durable facts only. Do not turn it into a chronological transcript or a
speculative roadmap.
