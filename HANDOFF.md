# Eve handoff

This is the canonical onboarding document for an agent taking over this
repository. It is the compressed result of reading the product documents,
tracing the implementation, checking the installed Eve and Next.js semantics,
and reviewing the regression coverage. Use it to form the initial system model;
then verify task-specific details against current code before making a change.

> **Specification status:** Specs 1–4 and Specs 4A–4B are implemented and production accepted.
> Specs 1 and 2 are on `main`; Spec 3 was deployed from the exact reviewed
> source commit `9b6e01f` on `codex/spec-03` without pushing or merging it.
> Spec 2's versioned strategy-pack framework and
> `IPO Filings@1.0.0` passed staged production scheduling, real SEC/Photon,
> Discuss, managed-worker, cleanup, and rollback acceptance on 2026-08-15.
> Spec 3's shared SEC/House acquisition, canonical facts, isolated projections,
> and rollback controls passed staged production acceptance on 2026-08-16. The
> Spec 4 `Congressional Signals` strategy, official current House roster,
> deterministic history/evidence policy, real Photon alert/Discuss route, and
> kill-switch rollback passed staged production acceptance on 2026-08-16. Spec
> 4A's shared deterministic-first hybrid evidence jobs, bounded Eve worker,
> extraction recovery, workspace semantic lane, repeated real-model corpus,
> and child-first rollback passed final acceptance on 2026-08-16. Spec 4B's
> reviewed JPM discovery, transcript comparison, cited judgment, pack vertical,
> real Photon alert/Discuss, and rollback passed final acceptance on 2026-08-17;
> all new earnings, hybrid, dispatch, and alert flags remain off. The
> spec files remain the authoritative split between production evidence and
> deliberately deferred work.

Snapshot date: 2026-08-17

Repository baseline: `main`. Inspect the current Git log and merged PR for the
accepted Spec 4B landing commit; immutable rollout receipts are recorded below.

Production alias: <https://adaam.vercel.app>

Production follows Git-backed `main`. The owner-authorized Spec 4B full-
rollback artifact is `dpl_4AKpjdy1cWMCTY1QPQA9uvauRviE`; its canonical alias
returned HTTP 200 for `/` and `/skill`, its removed acceptance route returned
404, and its bounded error-log query was empty. A later Git-backed landing or
documentation-only deployment may replace the current artifact without
changing this acceptance receipt. Query the alias and Vercel project before
diagnosing or deploying. Never commit, push, deploy, or mutate an external
service unless the owner asks.

## Executive summary

Eve is a forkable, single-owner personal investment and research agent. Its
primary interface is iMessage through Photon. It combines durable named chat
sessions, public-market research, guarded paid data access, public report
delivery, dynamic monitoring, and approval-gated Coinbase operations.

The repository contains a working product and a more ambitious target
architecture. Keep them distinct:

| Area | Implemented now | Not implemented yet |
| --- | --- | --- |
| Conversation | Durable named iMessage sessions plus Photon workspace briefs, manifests, budgets, monitors, findings, alerts, and immutable durable-mode assignment | The same workspace broker across Telegram and authenticated HTTP |
| Research | Direct sources, public feeds, FMP/SEC-oriented skills, and guarded Masterkey fallback | Durable private ingestion of every paid or temporary result |
| Trading | Allowlisted Coinbase reads and preview-bound spot-order approval | A generally safe live-trading surface or account-wide reconciliation |
| Deliverables | Public-data reports and media on stable Eve URLs | Owner-private artifacts for portfolio, account, or personal data |
| Monitoring | Workspace-bound schedules, isolated compiled workers, deterministic SEC, Congressional, and earnings findings, durable Photon alert delivery, manager controls, versioned pack-managed monitors, source-global SEC/House/earnings adapters, immutable canonical facts, isolated workspace projections, bounded hybrid recovery/semantic evidence, and real Specs 1–4B production acceptance | Push source events, a second Spec 4C consumer, broader reviewed issuer discovery, and crash/operations hardening remain deferred |
| Authorization | Fail-closed deployment-owner mapping for Photon workspace paths plus a separate Coinbase allowlist | Owner-global enforcement across Telegram, HTTP, and every remaining private capability |

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
caps. `agent/instructions/00-shared.md` plus dynamic instruction modules define
the model's source priority, tool rules,
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

There is one declared internal Eve subagent, `workspace-worker`, for bounded
monitor occurrences. Its hosted build uses Vercel Sandbox with deny-all network
policy; local verification uses `just-bash`. The static
`.eve/agent-summary.json` is useful for routes, channels, schedules, and static
tools, but it does not enumerate every dynamic Coinbase or Masterkey tool.

### Photon message path

`agent/channels/photon.ts` is the main ingress and delivery path. Photon uses
Chat SDK Redis state and either the Vercel Connect integration or explicit
Photon secrets. Channel concurrency is `queue`.

For each inbound message, Photon:

1. selects the explicit legacy or durable rollout mode from fail-closed runtime
   configuration;
2. in durable mode, resolves the deployment owner, conversation identity, and
   immutable ingress receipt before workspace access;
3. deduplicates the channel event;
4. handles an exact pending approval decision before any model turn;
5. blocks unrelated messages while an approval is pending or being delivered;
6. intercepts recognized session-manager intent; and
7. durably assigns ordinary text to the selected session before routing it to
   that session's Eve continuation with
   `turnPolicy: "steer"`.

With every new runtime flag off and all new owner configuration absent, Photon
preserves the pre-Spec legacy path. Partial or explicitly enabled configuration
fails closed; authorization or storage failures never fall back to legacy mode.

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

### Independent workspace runtimes

The completed local Spec 1 path makes each Photon session a durable runtime
container in addition to its isolated chat history. A workspace can own a
bounded brief, strategy configuration, default-deny capability manifest, budget
policy, monitors, structured findings, and alerts. Starting fresh changes only
the interactive history generation and preserves those records.

The single minute dispatcher claims due workspace-monitor occurrences and starts
fresh bounded Eve task sessions. Workers receive signed runtime scope, typed
workspace state, exact declared sources, and only allowed tools; they cannot read
interactive history, cross workspace boundaries, use Masterkey/Coinbase, or
perform live trading. The `IPO Filings` reference uses deterministic SEC S-1
evaluation and a bounded 40-fact outcome path.

Every new or explicitly assigned legacy monitor persists an authenticated Photon
delivery subscription. A completed scheduled outcome stages a channel-independent
alert and invokes the Photon delivery adapter. Delivered cards retain the
authoritative workspace name, observation time, canonical public source, and
**Discuss** and **Manage** actions. Discuss atomically selects the workspace and
provides a one-time bounded alert reference to its next user turn without
switching the selected workspace merely because the alert arrived.

The Spectrum manager renders monitor schedule/timezone, sources, health,
enabled/paused/error counts, last/next run, budget limits, token/paid usage, and
active workers. The real iMessage alert/Discuss/manager flow passed production
acceptance on 2026-08-15. Dispatch and Photon workspace alerts were returned to
off afterward; workspace state and monitor writes remain on.

The accepted run used commit `7db61b4`, acceptance deployment
`dpl_GExEuFouN3j2jqVYrkFSZ3pnVjrP`, and rollback deployment
`dpl_AkkAbHddZxS42Ga7YYvi8urpeZy4`. Bounded receipt-chain evidence is recorded
in `specs/01-independent-workspace-runtimes.md`: one live SEC source attempt and
success, one completed worker run, one finding, one alert, one delivered Photon
receipt, inert duplicate delivery, Discuss-bound next-turn assignment, a 200
manager state read, and zero new worker runs across two post-rollback scheduler
ticks. The disposable monitor is retired, its workspace is archived but
retained, and `Main` is selected.

### Versioned strategy packs

Spec 2 adds a deterministic generated catalog, one authoritative versioned pack
binding inside the existing strategy document, and atomic replay-safe
create/configure/remove mutations across the existing registry, state,
capability, monitor, and receipt records. Eve tools and Spectrum actions use the
same owner-authorized application service. Configuration and removal advance
the session generation; removal pauses or retires only managed resources and
preserves findings, alerts, checkpoints, history, and owner-created monitors.

Interactive sessions compose only the exact active pack's bounded mission and
playbook. Scheduled preparation binds the exact workspace generation, binding
revision, pack digest, capability revision, source contracts, and managed
resource; mismatches fail before source access. Pack content never grants
capabilities, and hard denials still exclude paid, private, and trading paths.

`IPO Filings@1.0.0` is the first reference package and reuses the Spec 1 SEC
normalizer, fixture corpus, worker, finding, alert, and delivery path. Local
vertical acceptance proved inert install-only, an explicit 9 AM/4 PM schedule,
production scheduler and worker preparation, deterministic findings and alerts,
the Photon delivery adapter, Discuss selection/context, next-ingress routing,
duplicate suppression, and independent rollback switches. The generated
catalog digest is `23906ba142505adf2ddd083ba409112d3570ea53ca7e61d0efa1ff54f3d47849`;
the reference pack digest is
`509e1a06a7bf2d8de6cd216ff894f9353870cc8062fff0945cde4ba7ad2a0fce`.
Production acceptance additionally proved an owner-approved SEC replay through
one delivered Photon alert and real Discuss action, plus a pack-managed no-match
whose durable worker snapshot carried the exact pack/resource identity. The
accepted framework merge is `d5da00c`; production exposed a fresh-baseline
source-coverage edge fixed in `7a04b3d`. Acceptance deployments were
`dpl_7Uhww7Do2fT2XrWuq8hFsLrp8sbA` and
`dpl_vpthJGpcS9Rm35hG7SvRijwznUCo`; rollback deployment was
`dpl_3Sdbty7p8BCpnq9UKaZzkEwv5ubp`. Bounded evidence and final flag state are in
`specs/02-versioned-strategy-packs.md`. Global dispatch, pack-managed dispatch,
and Photon alerts are off; catalog, mutation, interactive runtime, workspace
state, and monitor writes remain on. Disposable bindings were removed, their
workspaces archived, all disposable monitors retired, and `Main` restored.
Two post-rollback scheduler ticks claimed no workspace monitor and started no
worker.

### Public-source adapters and canonical facts

Spec 3 adds a versioned approved-source registry and validated source instances,
an idempotent acquisition journal, immutable canonical fact revisions with
explicit correction heads, and workspace-isolated subscriptions, projections,
and delivery cursors. Acquisition and facts are source-global; one workspace
cannot read another workspace's subscription or projection state.

The SEC adapter preserves the reviewed S-1/S-1/A behavior while moving flagged
execution through the shared coordinator. Turning its adapter flag off selects
the explicit legacy workspace-worker rollback path. The House adapter reads the
official bounded yearly ZIP/XML index and only the exact selected PTR PDFs.
Reviewed text layouts produce filing and range-preserving transaction facts;
ambiguous, partial, malformed, or image-only documents remain explicitly
partial or unsupported and never produce invented fields.

Production rollout used exact source commit `9b6e01f`. It promoted all-off
deployment `dpl_EwzsXYB4PRpufQZqKCv5DZCKcmBM`, SEC-only deployment
`dpl_4zj1yZfQEkzPR4QtdXJxvCNMwttq`, the all-off deployment again as a real
rollback, SEC-only again, and finally SEC-plus-House deployment
`dpl_CkAobXMjsDraBwnAJntNTfgSh4kB`. The production alias and `/skill` returned
HTTP 200 at each promoted stage, and bounded error-log queries were empty. The
all-off deployment remains the direct rollback target and does not require data
deletion or fact reversal.

The final production values are exactly `1` for
`EVE_PUBLIC_SOURCE_ACQUISITION_ENABLED`,
`EVE_PUBLIC_SOURCE_PROJECTIONS_ENABLED`,
`EVE_SEC_PUBLIC_SOURCE_ADAPTER_ENABLED`, and
`EVE_HOUSE_PUBLIC_SOURCE_ADAPTER_ENABLED`. An exact before/after environment
audit showed all unrelated entries unchanged. Global workspace dispatch and
Photon workspace alerts remain off and were never mutated, so no scheduled
acquisition, projection delivery, alert, or message ran during the flag
rollout.

The separately authorized read-only live gate observed three normalized SEC
S-1/S-1/A filings without findings or alerts. The current House index contained
1,547 members and 351 PTR rows; the deterministic latest selection, DocID
`9116292` filed `8/13/2026`, was a bounded two-page image-only PDF and correctly
returned `pdf_scanned_unsupported`. No signal, alert, message, paid call, or
state mutation was produced by that observation.

### Congressional Signals

Spec 4 adds the `congressional-signals` pack and deterministic House PTR
interpretation inside one authorized workspace. It retains disclosed amount
ranges, separates baseline from live facts, resolves members and securities
against immutable catalogs, records coverage/history/cluster/correction state,
emits fixed neutral reason traces, and stages at most one filing alert. It cannot
use paid research, infer intent or wrongdoing, place a trade, or treat a signal as
financial approval.

The owner-authorized official Clerk roster snapshot was retrieved from
`https://clerk.house.gov/xml/lists/MemberData.xml` on
`2026-08-16T19:59:10.000Z`. Its 556,140 source bytes have SHA-256
`4ccea8259aff2df6a175545e45bdac2dfcdf0085a9cc7ab6c46aa80527bc524b`
and contain 441 rows: 437 current members and four vacancies. Immutable member
catalog `1.2.0` has digest
`ac8780e513f32730cc9aa253fa47cb73275f937098036b183e8d1876fa5a3cc0`;
`congressional-signals@1.3.0` has digest
`5c93463b5659ef694980c4ebf82e75c9b2edc1078ccfbad3ecda3d5655f27acc`.
Pack versions `1.0.0`–`1.2.0` remain registered with their original digests.

Production acceptance ID `4bc5dabf-aeae-4230-ab53-7c9842191e3d` used the
official current-year House index digest
`5b3ce10fe839abed08e14e0cd79dda573e7b9c9c2abc77ee55ac2007dd0536f0`.
DocID `20035134` established baseline checkpoint
`8195b1b2a28d6f4fd0f214d132ff8439e2976ed353b219cf6616c6707f092489`;
DocID `20035196` produced live checkpoint
`8a1932e4d29e5a743046c939d5bb5422af728a85642ae1e31a96ef038db48d64`,
signal revision
`congressional-signal-revision.4929f5c2256cfad9796d941d372b20251034cb2b2a980be36ff44cf089de4e4a`,
finding `finding_d2e1e661711606682292414496bcfeddb47966520680c635e2f204fcb8ef3fbb`,
and alert `alert_6bf03df6bcfb425df310477adfa9c94f95653dca31f6aec80993f99dc46544eb`.
The real Photon send completed at `2026-08-16T20:55:05.244Z` as delivery
`delivery_461f4b1b36f8b1e912c024822e1ee9bdfc7c5ef6ede29dc36f32201a23ca0be5`;
Discuss selected the disposable session and its bounded context was consumed.

The successful staged deployments were all-off
`dpl_4MAkVWi4r4CNALBbFevfk2vxq9eG`, dispatch-only
`dpl_EkgS53LZds5SLbFVQgnu9Tj8YDHB`, execution-on/alerts-off
`dpl_9phHxzSTgE3d3ps6Am9ZL76DpkBT`, one-alert
`dpl_4TkRx7rXCVWJpASfQ7XZp8Egd2zn`, alert rollback
`dpl_CRB5zgJHrEixpALxK1A8i4TKoPDL`, full rollback
`dpl_GB3iMcUf9U9YgXEiqnVJFMTXefwe`, and final temporary-route-free artifact
`dpl_7BaxMhGw5bmkEMYZ8dZqDmQxDQw3`. The final Linux Eve build traced
`pdfjs-dist` and `@napi-rs/canvas`; the alias returned 200 for `/` and `/skill`,
404 for the removed acceptance route, and no bounded error logs.
Repeated delivery after alert rollback failed with
`acceptance_alert_flag_off`. The accepted workspace and five preflight
workspaces were archived, all monitors retired, isolated temporary source state
removed, and the prior source session restored.

Final production values are `1` for source acquisition/projections, SEC/House
adapters, pack catalog/mutations/runtime, workspace state, and monitor writes;
they are `0` for pack-managed dispatch, global workspace dispatch, Photon
alerts, Congressional execution, and paid research. Temporary acceptance
authorization and token variables are absent. No paid or broker/trading
capability was used. Production acceptance also established two deployment
requirements: `pdfjs-dist` must load its explicitly traced native canvas and
worker modules in Next server functions, and new pack-managed monitors must bind
the authenticated Photon conversation subscription rather than a placeholder.

### Earnings Call Changes

Spec 4B ships `earnings-call-changes@1.0.0` through the existing catalog,
workspace worker, public-source coordinator, hybrid semantic lane, findings,
and Photon alert path. Owner configuration accepts one to eight immutable SEC
issuer IDs. Reviewed source-family instances remain source-global while
subscriptions, semantic results, budgets, findings, and alert context remain
workspace-isolated. Familiar qualifying layouts normalize deterministically;
registered layout changes may use the bounded Spec 4A recovery worker. Exact
current/prior citations, deterministic language metrics, model facts,
inferences, forecasts, recommendations, counterevidence, and invalidation
conditions converge into one replay-safe finding. No broker capability is
available to the worker or pack.

The Sprint 5 independent review closed 16 validated findings, and the broad
regression passed 46/46 gates. The repeated real-model benchmark and a live
JPM Q2/Q1 source smoke both used `openai/gpt-5.4`. The live acquisition produced
comparison `comparison.6d4f2c802720afd79f49e48ba01c21f7b1066f9e` and accepted
finding
`earnings-finding.7d3a2b8967a5d2dd3c2dba1ef10fa2cff2c1ffcd5b961587`
with deterministic materiality score 86. Real Photon alert
`alert_live_2ff5596971a9c6d2f913044e0dc0ccd7d34073a66f0194d7331a0b9b3dbf5e9b`
completed as delivery
`delivery_658a5eedf4d7149dd98ec1ff9322989dc33d0e1b19d8403d66bc712fa0e5bfb7`;
Discuss was applied and its bounded context consumed. The existing conversation
was already at its 12-session cap, so acceptance reused the active session and
left its selection unchanged.

The accepted staged sequence was source-only
`dpl_2k54WvEA3jhLMCxyVC1sjoZZhxkn`, corrected hybrid
`dpl_4h6N8EVLBHxjWMuyPLHF1Mx6teR2`, execution-on/alerts-off
`dpl_GMEdWaa5WwhzjAoRxwdAzUNGtzEo`, one-alert
`dpl_J4H33p3GzTPDuP1RuEYpUAiruHXD`, alert rollback
`dpl_8UJkM2Hp2ATHhQVRKbWXoyeLcLdN`, and full rollback
`dpl_4AKpjdy1cWMCTY1QPQA9uvauRviE`. The final staged alias returned 200 for
`/` and `/skill`, the temporary acceptance route returned 404, and bounded
error logs were empty. Final production values are `0` for the earnings source
and execution flags, the hybrid parent and both children, workspace and pack-
managed dispatch, and Photon alerts. The short-lived acceptance endpoint and
secret were removed. JPM is the only v1 source family with accepted ongoing
first-party listing discovery; other locked issuers remain explicit baseline-
only or coverage-unavailable states. Over-envelope calls abstain without silent
truncation, and crash-only ephemeral cleanup hardening is parked in
`BACKLOG.md`.

### Hybrid evidence and reasoning

Spec 4A adds two deterministic-first lanes over one shared foundation. Lane A
can recover only allowlisted partial, suspicious, or unsupported public-source
inputs, is deployment-funded and source-global, and may promote a House result
only after independent document, row, and OCR validation. Lane B is
workspace-funded, authorized from exact pack, binding, capability, source, and
definition revisions, and persists model-derived semantic evidence without
mutating canonical facts or another workspace. Both lanes use immutable
content-addressed artifacts, expiring signed single-job envelopes, exact
locators, durable lifecycle, budget, and lineage records, quarantine, and fixed
observability.

The fresh Eve task worker exposes only signed evidence-read and controlled
completion tools. Its reviewed job definition carries bounded, digested
definition-specific instructions; production House, spreadsheet, and semantic
contracts therefore do not depend on model knowledge of schema identifiers.
PDF and workbook decoding runs in permission-restricted, memory/output-bounded
child processes with hard timeout/reap behavior. Owner inspection combines
bounded source-global and workspace state while preserving scope isolation.

Independent review run `20260816-182623-5fc08538` closed 16 validated findings.
The one broad gate passed 31/31 stages. The real Gateway corpus
`hybrid-evidence-core@1.0.0` ran twice on `openai/gpt-5.4`; both runs achieved
100% supported recovery and 100% safety, with zero false material fields,
invalid accepted citations, unsafe accepts, or forbidden tool calls. Production
staged all-off, parent-only, extraction-only, extraction rollback,
semantic-only, semantic rollback, parent rollback, and dependency rollback.
Final staged acceptance artifact `dpl_8oAhy3xys7pCjhCAQQ4QaVPSe5eT` was Ready;
`adaam.vercel.app` and `/skill` returned HTTP 200 and bounded error logs were
empty. PR #9 then merged the exact accepted implementation commit through
`a1b6b15de23b8459f58ba2dc6c7c6cddfea3e55d`; GitHub bound that merge to
Git-backed production deployment `dpl_81qfYCffFyKuF9S8ETJRr1N25p48`, which
repeated the same alias health and empty bounded error-log checks.

Final production values are `0` for `EVE_HYBRID_EVIDENCE_ENABLED`,
`EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED`,
`EVE_HYBRID_SEMANTIC_REASONING_ENABLED`, and the temporarily enabled
`EVE_WORKSPACE_DISPATCH_ENABLED`. The distinct configured models are
`openai/gpt-5.4` for extraction and `google/gemini-3-flash` for independent OCR;
budget ceilings are two workers, 100,000 input/20,000 output tokens per day,
USD 1 per call, USD 10 per day, and USD 100 per month. Specs 4B and 4C own any
consumer-specific connector, strategy, and rollout; do not enable a child merely
because the foundation exists.

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
They must not go through an OIDC-protected self-HTTP request. Photon's rich
approval surface supports `coinbase_create_order`. Spec 1 removed legacy trigger
deletion from the order-shaped approval path; workspace monitors use
authenticated recoverable retirement instead.

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

### Monitoring

There are no preset alerts. In durable Photon mode, authenticated monitor tools
derive the current workspace from trusted routing scope and can create, list,
update, pause, resume, explicitly assign a legacy trigger, and recoverably retire
a monitor. Workspace monitors are immutably bound to their owner/workspace and
support one-time, interval, and timezone-aware daily schedules. Create/update
tools, manager validation, and storage share the eight-source ceiling.

The one-minute static schedule handles both workspace monitors and the restricted
legacy trigger path. Workspace claims, leases, occurrence keys, budgets,
checkpoints, findings, and alerts use Redis atomicity and bounded recovery. Daily
local schedules cover DST gaps/folds and newest-missed recovery without catch-up
storms. A scheduled workspace run receives only its exact declared sources and
approved runtime capabilities.

Legacy event triggers remain available for compatibility when the new runtime is
off. They retain their existing principal-derived limits and restricted runner;
they gain workspace state only through explicit authenticated assignment. Do not
silently migrate or guess a target workspace.

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

1. **Owner and workspace parity is Photon-only.** Durable owner mapping,
   assignment, runtimes, monitors, alerts, and manager controls exist for
   Photon's durable mode. Telegram and HTTP do not use that broker.
2. **A second hybrid consumer and later strategies remain.** The versioned pack
   framework, IPO reference pack, canonical SEC/House public-source adapters,
   and Congressional Signals are production accepted.
   [`Spec 4A`](specs/04a-hybrid-evidence-reasoning.md) implements the shared
   deterministic-first/model-recovery foundation, and Spec 4B production-
   accepts the first transcript consumer. Spec 4C must prove a different
   connector/content shape before Insider Clusters and shared signals resume in
   Specs 5–6.
3. **Artifacts are public-only.** Private portfolio/account deliverables and
   safe recovery of paid temporary outputs require owner-private storage.
4. **MCP ingestion is incomplete.** Normalized model context is safe and
   bounded, but raw provider output is not durably captured before reduction.
5. **Financial recovery is session-scoped.** The uncertain-order guard is not
   account-wide reconciliation, and the dynamic Coinbase mutation surface is
   broader than the approved product scope.
6. **Deferred Spec 1 hardening remains.** Crash-only receipt/outbox recovery,
   ambiguous worker-start accounting, revision freshness, atomic lifecycle
   convergence, log/privacy catalog enforcement, and Eve private-runtime
   compatibility are parked after the remaining product specs.

Other known edges:

- verify current Eve 0.33 negative text-decision behavior (`deny` versus
  `cancel`) before changing compatibility logic;
- old durable sessions can become unusable across incompatible Eve upgrades;
  create a new generation instead of attempting automatic migration;
- legacy event triggers remain a compatibility path and must gain workspace
  state only through explicit authenticated assignment;
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

For Photon connector recovery, first confirm the repository is linked to the
intended Vercel project and that its existing `photon/<project-slug>` Connect
integration is attached. Resolve app-scoped credentials lazily through
`connectPhotonCredentials(...)`; never print, persist, or copy the returned
values into source or documentation. Explicit Photon credentials may remain in
the ignored local environment for operator tooling, but Vercel marks production
connector values sensitive and does not export them through ordinary CLI env
downloads. Verify access with a bounded read before any delivery smoke.

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
| `verify:workspace-runtime:owner-workflow` | local owner monitor creation/assignment and runtime initialization contract |
| `verify:workspace-runtime:sec-ipo-scheduled-compiled` | schedule through the production control plane and compiled Eve worker to deterministic finding/no-match outcomes |
| `verify:workspace-runtime:alerts`, `:alert-delivery`, `:alert-context`, `:alert-replies`, `:alert-app` | alert staging, subscription delivery, presentation, Discuss context, held replies, and app actions |
| `verify:workspace-runtime:manager` | visible monitor schedule/source/health/budget/usage manager contract |
| `verify:workspace-runtime:photon-rollout` | explicit legacy/durable configuration and fail-closed authorization matrix |
| `verify:workspace-runtime:redis` | workspace leases, budgets, checkpoints, lifecycle, migration, and alert uncertainty against Redis |
| `eval:coinbase` | fixture-backed model/tool behavior with no real Coinbase call |
| `verify:strategy-packs` and `verify:strategy-pack-*` | deterministic catalog, atomic mutations, runtime isolation, owner-surface parity, privacy-safe observability, and Spectrum behavior |
| `verify:strategy-packs:acceptance` | empty-state local vertical path through pack creation, scheduler, worker evaluation, durable alert, Photon adapter, Discuss, next ingress, and rollback switches |
| `verify:public-source-adapters:contracts` | minimal SEC/House contracts, representative House layout feasibility, channel neutrality, and fixed observation catalogs |
| `verify:public-source-adapters:sec` | acquisition journal, immutable SEC facts, parity, correction/replay, and explicit legacy rollback behavior |
| `verify:public-source-adapters:house` | bounded official index/PTR parsing, filing and transaction facts, corrections, partial/scanned handling, and resource limits |
| `verify:public-source-adapters:runtime` | source-global acquisition reuse, workspace-isolated projections, coordinator flags, source health, and manager privacy |
| `verify:congressional-signals:sprint-0` through `:sprint-5` | live-layout viability, versioned policy/evidence, history/corrections/clusters, owner surfaces, full official roster, replay, and workspace isolation |

The Redis checks require exported environment variables and do not load
`.env.local`. Model evals do not exercise the Photon webhook, Redis delivery,
Spectrum UI, or iMessage response path.

At this snapshot, the Specs 1–4 deterministic matrices, Redis races, TypeScript,
the compiled Eve build, the Next.js production build, and read-only live
SEC and House observations have passed. Production acceptance additionally
proved real SEC polling, Photon alert delivery, Discuss routing/context, exact
pack-managed worker composition, manager state, the Spec 3 SEC/House staged
cutovers, the Spec 4 official House source-to-signal path, and kill-switch
rollback paths described above. Earlier real-channel
smokes validated
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
13. **A fresh source baseline can predate its monitor.** A quiet feed's newest
    event may be older than the newly created monitor window. Permit that cursor
    only for an authenticated initial no-finding baseline with no prior
    checkpoint; ordinary runs must retain the stricter window fence.

## Code map

Read the files for the area being changed; the groupings below show how the
system is divided.

### Product and agent behavior

- `README.md`: supported behavior and operator-facing configuration.
- `NORTH_STAR.md`: target architecture; explicitly separate target from current.
- `BACKLOG.md`: incomplete, postponed, and parked work.
- `MCP_ADAPTER_PATTERN.md`: required MCP design and review contract.
- `agent/agent.ts`: model, context, session, and runtime configuration.
- `agent/instructions/00-shared.md` and `agent/instructions/`: shared model
  behavior plus dynamically composed pack policy.
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

- `agent/lib/workspace-monitor-store.ts`: workspace monitor configuration,
  schedules, leases, occurrence keys, and checkpoints.
- `agent/lib/workspace-state-store.ts`, `workspace-capabilities.ts`, and
  `workspace-budget-ledger.ts`: bounded runtime state, default-deny manifests,
  and run/token/paid accounting.
- `agent/lib/workspace-finding-store.ts` and `workspace-alert-store.ts`: scoped
  findings and channel-independent alerts/outbox receipts.
- `agent/lib/workspace-runtime-auth.ts` and
  `agent/lib/eve-workspace-worker-runtime.ts`: signed worker scope and compiled
  Eve task execution.
- `agent/schedules/event-triggers.ts`: shared one-minute dispatcher for workspace
  monitors and restricted legacy triggers.
- `agent/lib/photon-alert-delivery.ts`,
  `agent/lib/photon-alert-subscription-store.ts`,
  `agent/channels/photon-alert-app.ts`, and
  `agent/channels/photon-workspace-app.ts`: outbound alert delivery,
  subscriptions, Discuss/Manage actions, and manager controls.
- `agent/lib/event-trigger-store.ts`, `agent/lib/event-trigger-owner.ts`, and
  `agent/channels/event-trigger-runner.ts`: legacy compatibility path.
- `agent/tools/scheduled_tool_guard.ts`: legacy capability restrictions.
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
