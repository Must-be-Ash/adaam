# Eve handoff

This is the canonical onboarding document for an agent taking over this
repository. It is the compressed result of reading the product documents,
tracing the implementation, checking the installed Eve and Next.js semantics,
and reviewing the regression coverage. Use it to form the initial system model;
then verify task-specific details against current code before making a change.

Snapshot date: 2026-08-13

Repository branch: `main`

Production alias: <https://adaam.vercel.app>

Production follows Git-backed `main`, but the alias and local checkout can
diverge. Inspect both before diagnosing or deploying. Never commit, push,
deploy, or mutate an external service unless the owner asks.

## Executive summary

Eve is a forkable, single-owner personal investment and research agent. Its
primary interface is iMessage through Photon. It combines durable named chat
sessions, public-market research, guarded paid data access, public report
delivery, dynamic monitoring, and approval-gated Coinbase operations.

The repository contains a working product and a more ambitious target
architecture. Keep them distinct:

| Area | Implemented now | Not implemented yet |
| --- | --- | --- |
| Conversation | Durable named iMessage sessions with isolated Eve histories | Strategy-bound workspaces shared consistently across every ingress |
| Research | Direct sources, public feeds, FMP/SEC-oriented skills, and guarded Masterkey fallback | Durable private ingestion of every paid or temporary result |
| Trading | Allowlisted Coinbase reads and preview-bound spot-order approval | A generally safe live-trading surface or account-wide reconciliation |
| Deliverables | Public-data reports and media on stable Eve URLs | Owner-private artifacts for portfolio, account, or personal data |
| Monitoring | User-created event triggers with restricted scheduled runs | Immutable trigger-to-workspace binding and full strategy state |
| Authorization | Principal-scoped state plus a separate Coinbase allowlist | One owner-global authorization boundary across all capabilities |

`NORTH_STAR.md` describes the intended strategy-workspace architecture; it is
not a statement of current behavior. `BACKLOG.md` is the canonical inventory of
gaps and parked work; it is context, not authorization to begin a roadmap item.
`MCP_ADAPTER_PATTERN.md` is the mandatory contract for any MCP integration.

## Product and interaction contract

### What the owner should experience

- Ordinary research, monitoring, and trading requests are expressed in natural
  language. Do not add phrase-specific channel routing for domain requests.
- The primary channel is iMessage. The richer session manager, approval flow,
  and artifact-card experience are Photon-specific.
- Say **session** in user-facing copy. `workspace` is an accepted alias and the
  internal storage term.
- Recognized session-management intent opens only the Spectrum session manager;
  it does not also produce a model-written reply.
- Normal replies do not carry a `[Session: ...]` prefix. Session identity lives
  in routing state and the manager unless the user asks about it.
- Public-data deliverables should produce a stable Eve artifact URL without
  requiring the user to name the publishing tool, host, or format.
- The exact `ARTIFACT_URL:` marker in a completed response is converted into a
  standalone fallback URL before Photon posts the message.
- A safe internal artifact URL, or an allowlisted query-free MiniUp URL, can be
  delivered as a Spectrum card. Generic citations do not become cards.
- Financial approval uses **Approve** and **Deny**. Exact text fallbacks are
  `yes`/`approve` and `no`/`deny`/`cancel`. Conversational consent is never
  financial authorization.
- **Start fresh** advances only the selected session's model-history
  generation. Old-continuation cleanup is best effort, so do not promise hard
  deletion.

The session manager's intentionally minimal design is dark charcoal/grayscale,
has no blue accents or active badge, uses a light `#d8d8d8` active border, and
does not repeat the Eve/logo header. Preserve its button layout unless the owner
requests a redesign.

### How to work with the owner

Establish the intended user-visible behavior before hardening or abstracting it.
For a regression, reproduce the exact channel path and find the first divergent
layer; downstream fallback copy is often not the root cause. Restore the
smallest complete path, verify it locally, and use a real-channel smoke only
when the owner authorizes production testing. Do not expand into adjacent
backlog work without a request.

## Runtime architecture

### Agent and execution model

`agent/agent.ts` configures `google/gemini-3.6-flash` with high reasoning, 75%
context compaction, a seven-day session timeout, and no cumulative input/output
caps. `agent/instructions.md` defines the model's source priority, tool rules,
artifact behavior, monitoring contract, and financial boundaries.

Eve's system identity is the owner's single personal investment and research
agent, not an earnings-call-only agent. Earnings calls, crypto research, public
market research, monitoring, artifacts, and guarded brokerage are specialized
workflows under that one user-facing identity.

Eve sessions and workflows are durable. A step interrupted before its checkpoint
may run again while completed steps are not rerun, so external side effects must
be idempotent. Structured responses do not steer an active turn. Dynamic tools
must execute inline with the step that registered them so replay remains valid.

The app runtime has normal Node.js access and secrets. Eve's sandbox is a
separate capability boundary and does not inherit environment variables.
Task-mode schedules cannot pause for interactive OAuth or human approval.

There are no configured Eve subagents. The static `.eve/agent-summary.json` is
useful for routes, channels, schedules, and static tools, but it does not
enumerate every dynamic Coinbase or Masterkey tool.

### Photon message path

`agent/channels/photon.ts` is the main ingress and delivery path. Photon uses
Chat SDK Redis state and either the Vercel Connect integration or explicit
Photon secrets. Channel concurrency is `queue`.

For each inbound message, Photon:

1. resolves the authenticated principal and physical iMessage thread;
2. deduplicates the channel event;
3. handles an exact pending approval decision before any model turn;
4. blocks unrelated messages while an approval is pending or being delivered;
5. intercepts recognized session-manager intent; and
6. routes ordinary text to the selected session's Eve continuation with
   `turnPolicy: "steer"`.

Approval continuations use `turnPolicy: "queue"`. Do not change channel
concurrency or turn policy without a reproduced scheduling problem.

### Named iMessage sessions

User-facing sessions are stored as `PhotonWorkspace` records. The registry key
is derived from the authenticated principal and physical iMessage thread.

- `Main` keeps the physical thread's original Eve continuation.
- Additional sessions use a synthetic Eve thread ID containing the internal
  workspace ID and generation. Replies are mapped back to the physical thread.
- The registry supports at most 12 sessions and uses revisions, stable mutation
  IDs, expected generations, and atomic Redis Lua operations.
- A current financial approval is an atomic lock against session mutations.
- The manager is authorized by a 15-minute capability token in the URL fragment,
  keeping it out of server access logs and query strings.
- Starting fresh increments the chosen session generation and makes a
  best-effort reset of the old Eve session.
- `agent/lib/photon-workspace-store.ts` is the live registry.
  `agent/lib/photon-session-store.ts` exists only for legacy migration.

The production Photon project currently has two registered owner identities.
Shared Photon lines give each identity an assigned agent line, and the owner
must initiate a conversation before outbound delivery is allowed. Both were in
the Coinbase principal allowlist at this snapshot. Never copy their real phone
numbers or principal values into source, fixtures, documentation, or logs.

### Approval state machine

Photon's financial approval is durable application state, not model prose. The
Redis state machine is:

`draft -> active -> delivering -> delivered | unavailable`

An approval is bound to the authenticated principal, physical thread, Eve
session, tool request, internal workspace ID, workspace generation, exact
action, and expiry. The Spectrum mini app and exact one-word replies operate on
the same state. Activation timestamps, zero clock-skew grace, stable event IDs,
and atomic transitions prevent a delayed reply or duplicate webhook from
authorizing a newer request.

Text decisions resume Eve directly through the authenticated Photon bridge.
They must not go through an OIDC-protected self-HTTP request. Photon currently
has rich approval support for `coinbase_create_order` and trigger deletion; the
latter still needs a purpose-built confirmation presentation instead of order
language.

### Coinbase

Coinbase is private-channel-only and has its own
`COINBASE_ALLOWED_PRINCIPALS` boundary. Reads such as balances, accounts,
orders, and fills are allowlisted. Spot-order creation follows an exact flow:

1. validate the spot product and canonical order schema;
2. call `coinbase_preview_order`;
3. issue a principal-bound, HMAC-signed token for that exact canonical order;
4. obtain Photon approval within the five-minute token lifetime;
5. revalidate that the order is unchanged; and
6. call `coinbase_create_order` with a deterministic client-order ID and Redis
   operation receipt.

A changed order always requires a new preview and approval. Never automatically
retry a mutation with an uncertain result. The current uncertain-order guard is
Eve-session-scoped and expires after 24 hours; it is not account-wide broker
reconciliation. Resolve an uncertain result against Coinbase's authoritative
state and ask the owner before further action. Do not delete the guard to force
progress.

Each Coinbase tool call uses a fresh credential-isolated CLI MCP process with
history disabled and a minimal environment. `bounded-stdio-transport.ts` limits
each JSON-RPC frame to 8 MiB before parsing and preserves upstream spawn,
framing, abort, and teardown semantics.

The dynamically curated Coinbase surface still exposes conversions, transfers,
portfolio mutations, and generic edit/cancel operations beyond the initial
approved spot-order scope. Photon's custom approval rejects unsupported rich
mutations, but the tools are not globally removed. Treat this as a release
blocker; do not describe Eve as generally live-trading ready.

### MCP and research data

Raw MCP `CallToolResult` objects must never enter model history. Every MCP uses
an application-owned tool surface, provider policy, explicit timeout and byte
bounds, and `normalizeMcpToolResult()` before returning data to the model.

Normalization:

- prefers usable structured data over duplicate text envelopes;
- preserves exact identifiers, monetary decimal strings, timestamps, cursors,
  statuses, and provenance;
- redacts credentials and credential-bearing URLs;
- removes inline binary and unsafe media;
- bounds depth, keys, arrays, strings, and total serialized context;
- reports omissions rather than silently implying a complete result; and
- preserves a durable safe artifact URL when one exists.

Auxiliary inline media does not invalidate otherwise usable data; the retained
result is marked `inlineArtifactsOmitted: true`. Inline-only media, unsafe
signed output URLs, and over-limit transport responses are retention failures,
not necessarily provider failures. The paid operation may already have
completed. Do not repay or automatically retry; recover through the provider's
job or usage history.

The missing layer is pre-normalization durable ingestion. Eve cannot yet retain
a paid inline result or credential-bearing temporary output in owner-private
storage before sanitizing the model view.

Source priority is direct and authoritative first: user-supplied material,
official filings and feeds, SEC/FMP-oriented tools, and other public sources.
Masterkey/x402 is a guarded paid fallback, not the default. Financial Datasets
has an older OpenAPI artifact in the repository but no active connection.

### Masterkey

Masterkey tools are registered dynamically per step. In an authenticated user
session, the local wrapper returns `not-applicable` for Eve-side approval on
`run_service`; Masterkey owns its own sensitive-action approval and spend
policy. Runtime and scheduled sessions are denied Masterkey entirely.

Do not restore a blanket Eve approval around `masterkey-x402__run_service`.
Masterkey's upstream policy is action-sensitive rather than simply
price-sensitive: sensitive operation categories or recipient-shaped inputs can
pause, while spend-limit breaches reject. Limits are external configuration and
can change; inspect the active policy rather than encoding assumed amounts in
the wrapper. Reconfirm upstream semantics before changing this boundary.

The client uses bounded 8 MiB HTTP responses, a 90-second timeout, no automatic
retry, safe error mapping, and the idempotency key `eve:${callId}`. User OAuth is
provided through Vercel Connect.

### Public artifacts

Seven narrow model-facing publishers deliver public artifacts:
`publish_report`, `publish_chart`, `publish_image`, `publish_audio`,
`publish_video`, `publish_pdf`, and `publish_file`. The former generic
`publish_artifact` tool is removed so the requested primary medium determines
the tool and schema.

- Only authenticated user sessions can publish, and callers must assert
  `publicDataOnly: true`.
- The 32-character artifact ID is deterministic from the Eve tool-call ID.
- Vercel Blob stores the versioned manifest and any copied media. Upstash is not
  an artifact database.
- Reports and chart-first artifacts are typed JSON rendered by deterministic,
  mobile-first React components. The model does not author or host arbitrary
  HTML. Chart-first pages persist as `kind: "chart"`, not as generic reports.
- `publish_chart` cannot be called without real numeric series, bars, slices,
  OHLC candles, or bid/ask levels. `publish_report` requires a non-empty
  declaration of requested elements and checks the corresponding blocks.
- Every narrow publisher shares one turn-bound final validation guard. A failed
  guard returns `status: "not_published"` and `retryAllowed: false`; durable
  session state blocks another publisher in the same turn rather than creating
  a repair loop.
- The renderer supports structured text, callouts, metrics, tables, line/bar/pie
  charts, candlesticks, and order-book depth. Dense time-series bars,
  candlesticks, and depth are responsive client views rather than fixed-width
  canvases: candles expose OHLC inspection and a right-side price scale, while
  depth exposes both filled book sides, best bid/ask, spread, cumulative-size
  ticks, and level inspection. Safe CommonMark is a fallback; raw HTML and
  embedded Markdown images remain disabled, and internal session metadata is
  stripped from fallback report content.
- Source records render as high-contrast external links with an arrow, visible
  hover/focus treatment, and a 44-pixel mobile target.
- Remote media ingestion is server-side and checks HTTPS, redirects, DNS and
  private addresses, content type, file signature, timeout, and a 100 MB limit.
- Public pages live at `/artifacts/<id>` and are `noindex`.
- Photon cards accept only same-deployment artifact URLs or credential-free,
  query-free `miniup.app` URLs.

All manifests and media are public by design. Never publish portfolio, account,
personal, credential-bearing, signed-URL, or otherwise private data through
this path. Owner-private artifacts and automatic MCP-output capture are not
implemented.

Photon icons are generated into an imported TypeScript module during the
project's preparation hooks. Keep this design: reading untraced asset files at
server-function startup previously passed builds but crashed production
webhooks.

### Dynamic event triggers

There are no preset alerts. An authenticated private-channel principal can
create, list, update, pause, resume, and delete a rule. The one-minute static
schedule claims due triggers and launches isolated runtime tasks.

Current authoritative store limits are:

- minimum cadence: 15 minutes;
- maximum 10 triggers per principal-derived owner key;
- maximum 96 runs per owner key per day and 500 globally;
- maximum eight combined sources;
- lifetime: 90 days; and
- automatic pause after five consecutive failures.

Claims, leases, budgets, checkpoints, and mutations use Redis atomicity. A
scheduled run receives only its exact declared sources, each at most once, and
must obtain complete source coverage. Alert timestamps and origins are checked
against the evaluation window. If delivery succeeds but checkpoint persistence
is uncertain, the trigger pauses rather than risking duplicate notification.

Scheduled tasks have no private chat history, user OAuth, Masterkey, Coinbase,
shell, filesystem, or search tools. Public feed fetching is restricted to
approved `.gov` sources, 2 MiB responses, a 20-second timeout, disabled XML
entities, and exact time-window evaluation. Truncated scheduled input is
rejected.

Triggers are keyed to the current principal-derived owner, not immutably bound
to an iMessage session or future strategy workspace. Tool schemas accept more
sources than the store; the store's combined limit of eight is authoritative.

### Other channels and HTTP

Telegram supports a simpler direct continuation and does not use Photon's named
session broker or Spectrum UX. The HTTP Eve channel still uses
`placeholderAuth`, which fails closed with 401 in production. Eve route
protection authenticates requests but does not by itself prove session
ownership. Do not expose HTTP or add cross-channel session access without an
explicit owner-bound authorization design.

## Non-negotiable invariants

### Financial actions

- No mutation may originate from model prose, prior consent, an alert, a
  schedule, inferred preference, or a session-manager action.
- Approval binds one exact action to the current principal, thread, session,
  workspace generation, request, and expiry.
- Any changed action requires a fresh preview and approval.
- Never retry an uncertain financial mutation automatically.
- Preserve deterministic operation IDs and durable receipts around side effects.

### Secrets, privacy, and observability

- Never place secrets, credentials, real principals, phone numbers, or signed
  capabilities in source, logs, fixtures, or documentation.
- Never log message bodies, direct PII, balances, order amounts, or complete
  account/request objects.
- Never use IDs, principals, URLs, timestamps, hashes, or user data as metric
  tags.
- Public artifacts contain public data only.
- Capability-bearing URLs belong in fragments where supported, not query
  strings or access logs.

### Context, paid calls, and scheduled work

- Raw MCP responses cannot enter model history.
- Do not weaken sanitization to rescue an unsafe result.
- Provider success and Eve retention success are separate outcomes.
- Do not repeat a paid request merely because retention failed.
- Runtime/scheduled work cannot gain user OAuth, private history, paid services,
  trading, or interactive approval.

### Durable state

- Keep event deduplication, activation-time checks, revisions, expected
  generations, stable mutation IDs, and Redis atomic transitions.
- Treat any uncheckpointed external side effect as potentially repeated.
- Never bypass an uncertain-operation guard by deleting state.

## Current gaps and boundaries

The most important differences between the working app and `NORTH_STAR.md` are:

1. **Authorization is fragmented.** The app is intended for one owner, but
   there is no deployment-wide owner policy. Photon state is principal-derived,
   Coinbase has a separate allowlist, and HTTP ownership is unfinished.
2. **Sessions are not full strategy workspaces.** They isolate conversation
   history but do not own a durable strategy brief, capability manifest,
   portfolio state, or immutable ingress assignment.
3. **Triggers are not workspace-bound.** They belong to the principal-derived
   owner key and cannot yet guarantee immutable strategy/session association.
4. **Artifacts are public-only.** Private portfolio/account deliverables and
   safe recovery of paid temporary outputs require owner-private storage.
5. **MCP ingestion is incomplete.** Normalized model context is safe and
   bounded, but raw provider output is not durably captured before reduction.
6. **Financial recovery is session-scoped.** The uncertain-order guard is not
   account-wide reconciliation, and the dynamic Coinbase mutation surface is
   broader than the approved product scope.
7. **Cross-channel parity does not exist.** Photon owns the full session,
   approval, and artifact UX; Telegram and HTTP do not.

Other known edges:

- verify current Eve 0.33 negative text-decision behavior (`deny` versus
  `cancel`) before changing compatibility logic;
- old durable sessions can become unusable across incompatible Eve upgrades;
  create a new generation instead of attempting automatic migration;
- delete-trigger confirmation still uses approval infrastructure whose
  presentation was designed for orders; and
- the event-trigger schemas and Redis store disagree on source count, with the
  store's eight-source limit winning; and
- the current sandbox template was rebuilt after an earlier deployment lacked
  its shell/glob template, but ordinary live sandbox execution still deserves a
  direct smoke before it is treated as proven; and
- the newly imported `notes/` directory is uncurated scratch material, not a
  product source of truth. It contains credential-shaped plaintext that must be
  treated as exposed, rotated, and removed in a separately authorized security
  cleanup; never copy or use those values.

Do not start one of these items merely because it is listed here. Use
`BACKLOG.md` for priority and acceptance context after the owner selects a slice.

## Verification and operational baseline

The project requires Node 24. Its deployed operation depends on Upstash Redis,
Vercel Blob, and project-specific Vercel Connect integrations for Photon and
Masterkey. `eve link` does not provision those resources for a new fork.

The preparation hooks embed the Coinbase CLI and Photon assets before local
development, typechecking, and builds. If generated imports are missing, inspect
`scripts/embed-coinbase-cli.mjs` and `scripts/embed-photon-assets.mjs` rather
than adding runtime filesystem reads.

Focused regression scripts map to the important boundaries:

| Script | What it proves |
| --- | --- |
| `verify:context` | MCP normalization and Masterkey user/runtime policy |
| `verify:transport` | stdio framing and pre-parse oversized-frame rejection |
| `verify:approvals` | Photon approval parsing, binding, and lifecycle behavior |
| `verify:sessions` | legacy session migration behavior |
| `verify:workspaces` | named-session registry and Photon routing |
| `verify:artifacts` | narrow input schemas, chart data, chart display math, one-shot guard, manifests, deterministic IDs, and safe URLs |
| `verify:approvals:redis` | approval transitions against a real Redis instance |
| `verify:workspaces:redis` | workspace atomicity against a real Redis instance |
| `eval:coinbase` | fixture-backed model/tool behavior with no real Coinbase call |

The Redis checks require exported environment variables and do not load
`.env.local`. Model evals do not exercise the Photon webhook, Redis delivery,
Spectrum UI, or iMessage response path.

At this snapshot, the six deterministic verification scripts, TypeScript, the
Eve build, and the Vercel build have passed. Real-channel smokes have validated
named-session operations and isolation, Coinbase balance and spot-order flows,
Spectrum order approval, guarded Masterkey research, public report publication,
and natural-language artifact-card delivery. These establish a baseline, not a
guarantee that the current checkout and production alias are identical.

The first post-deployment report-with-charts smoke produced metrics, all three
requested financial-chart blocks, a table, and linked sources. Its fixed-width
chart presentation prompted the responsive renderer revision above, which now
has deterministic, typecheck, Eve-build, Next-build, and local mobile/desktop
layout coverage but still needs owner visual sign-off after deployment.
Chart-only and image-only iMessage smokes remain outstanding.

## Diagnostic lessons that remain relevant

1. **Trace the first divergent event.** A visible fallback such as
   `[Session: unavailable]` can be secondary noise after an earlier policy or
   continuation failure.
2. **Channel behavior needs channel tests.** Eve evals bypass Photon webhooks,
   URL construction, Redis delivery, Spectrum, and iMessage.
3. **Keep domain language in the model path.** A phrase-specific balance router
   made only selected wording work. Channel interception is for explicit
   control protocols such as sessions and approval replies.
4. **A deploy activates accumulated changes.** Compare outgoing and incoming
   commits and framework versions before attributing a regression to the
   configuration change that triggered deployment.
5. **Durable sessions can cross incompatible runtime versions.** The Eve 0.31
   to 0.33 upgrade left an existing continuation unable to process messages;
   recovery used a fresh isolated session generation.
6. **Do not invent upstream approval semantics.** Forcing every Masterkey
   service call into Eve approval broke the user path. Confirm provider policy
   before wrapping it.
7. **Successful answers can conceal tool failures.** Inspect event streams and
   error logs, especially for paid results and artifact retention.
8. **Build success does not prove serverless file tracing.** Required Photon
   icons must remain imported/generated assets, and deployment changes that
   affect startup need a cold-start probe.
9. **Structured schemas need safe fallbacks.** A model can still place a full
   Markdown document into one text block; deterministic rendering must remain
   safe and readable.
10. **UI checks do not prevent state races.** Redis Lua, revisions, generations,
    and mutation IDs are the authoritative concurrency controls.
11. **Tool shape is part of model reliability.** One generic artifact union let
    the model wrap charts and images in text reports. Narrow publisher names and
    schemas, required chart data, and one terminal completeness guard make the
    requested primary medium explicit without a model repair loop.
12. **Valid chart data does not guarantee a usable chart.** Fixed-width SVGs
    clipped financial series on mobile and let axis text overlap candles. Keep
    the data contract strict, but derive responsive geometry, readable ticks,
    and trading context in the deterministic renderer.

## Code map

Read the files for the area being changed; the groupings below show how the
system is divided.

### Product and agent behavior

- `README.md`: supported behavior and operator-facing configuration.
- `NORTH_STAR.md`: target architecture; explicitly separate target from current.
- `BACKLOG.md`: incomplete, postponed, and parked work.
- `MCP_ADAPTER_PATTERN.md`: required MCP design and review contract.
- `agent/agent.ts`: model, context, session, and runtime configuration.
- `agent/instructions.md`: model behavior and tool policy.
- `agent/skills/`: earnings, crypto, public-source, FMP, Exa, Masterkey, and
  monitoring workflows.
- `idea/`: canonical candidate strategy, data-source, and watchlist research
  referenced by `NORTH_STAR.md`. It is planning input, not active agent
  behavior; keep distinct strategy packs separate, and reconcile the duplicate
  watchlist before treating it as a second dataset.

### Channels, sessions, and approvals

- `agent/channels/photon.ts`: iMessage dispatch, routing, approval interception,
  artifact delivery, and lifecycle handling.
- `agent/channels/photon-workspace-app.ts`: Spectrum session manager.
- `agent/channels/photon-approval-app.ts`: Spectrum approval app.
- `agent/channels/eve.ts` and `agent/channels/telegram.ts`: other ingress paths.
- `agent/lib/photon-workspace.ts`: intent parsing and synthetic thread mapping.
- `agent/lib/photon-workspace-store.ts`: live durable registry.
- `agent/lib/photon-session-store.ts`: legacy migration only.
- `agent/lib/photon-approval.ts` and `agent/lib/photon-approval-store.ts`:
  approval rendering, parsing, and durable state machine.
- `agent/lib/photon-mini-app.ts`: safe internal manager, approval, and artifact
  URLs.

### Coinbase and MCP

- `agent/lib/mcp-tool-result.ts`: shared normalization and sanitization.
- `agent/lib/mcp-response-limit.ts`: bounded HTTP response handling.
- `agent/lib/bounded-stdio-transport.ts`: bounded stdio JSON-RPC transport.
- `agent/lib/masterkey-mcp.ts`, `agent/lib/masterkey-mcp-policy.ts`, and
  `agent/tools/masterkey_mcp.ts`: Masterkey client, policy, and dynamic tools.
- `agent/lib/coinbase-access.ts`, `agent/lib/coinbase-order.ts`,
  `agent/lib/coinbase-operation-store.ts`, and `agent/lib/coinbase-cli.ts`:
  Coinbase authorization, canonical orders, receipts, and isolated CLI access.
- `agent/tools/coinbase_preview_order.ts`,
  `agent/tools/coinbase_create_order.ts`, and `agent/tools/coinbase_mcp.ts`:
  Coinbase model-facing tools.

### Artifacts and public app

- `agent/lib/artifact-schema.ts`: versioned public artifact contract.
- `agent/lib/artifact-store.ts`: Blob persistence and guarded media ingestion.
- `agent/lib/artifact-validation.ts`: requested-element checks and the durable
  one-failure-per-turn publication guard.
- `agent/lib/artifact-publication.ts`: shared authorization, persistence, and
  bounded model-output behavior for the narrow publishers.
- `agent/lib/public-app-url.ts`: stable public Eve URLs.
- `agent/tools/publish_{report,chart,image,audio,video,pdf,file}.ts`: narrow
  authenticated public-data publication tools.
- `agent/skills/artifact-publishing.md`: primary-medium routing and publication
  procedure loaded on demand.
- `app/artifacts/[artifactId]/`: report and media renderer;
  `financial-charts.tsx` owns responsive financial interactions and
  `chart-display.ts` owns tested tick, precision, quote-prefix, and cumulative
  depth calculations.
- `agent/lib/photon-app-icon.ts` and `scripts/embed-photon-assets.mjs`: traced
  Photon app assets.
- `app/page.tsx`, `app/layout.tsx`, and `app/skill/route.ts`: landing page,
  metadata, and fork/deploy onboarding prompt; this is not a live web chat.

### Monitoring

- `agent/lib/event-trigger-store.ts`: trigger state, leasing, budgets, and
  checkpoints.
- `agent/lib/event-trigger-owner.ts`: current principal-derived ownership.
- `agent/schedules/event-triggers.ts`: one-minute dispatcher.
- `agent/channels/event-trigger-runner.ts`: isolated runtime execution.
- `agent/tools/scheduled_tool_guard.ts`: capability restrictions.
- `agent/lib/public-feeds.ts`, `agent/tools/fetch_public_source.ts`, and
  `agent/tools/list_public_sources.ts`: fenced public feed access.
- trigger tools under `agent/tools/`: CRUD, alert emission, and completion.

### Regression coverage

- `scripts/verify-*.mjs`: deterministic boundary tests.
- `evals/`: model/tool evals; not end-to-end channel coverage.
- installed `node_modules/eve/docs/`: authoritative Eve execution and channel
  semantics for the installed version.
- installed `node_modules/next/dist/docs/`: authoritative Next.js 16 behavior;
  do not rely on older Next.js conventions.

When code and this handoff differ, determine whether the implementation or the
document is stale and update the handoff with the resulting durable fact. Keep
it a system model—not a chronological incident log, deployment diary, generic
setup guide, or speculative roadmap.
