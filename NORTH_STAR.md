# Eve North Star

## Purpose

Eve is a forkable, single-owner investment-agent template for semi-technical
operators. A user should be able to fork the repository, bring their own
credentials and capital, choose or modify strategy packs, and reuse the hard
parts: data access, source provenance, monitoring, context management, model
budgets, evaluations, and safe trade execution.

This repository is not intended to become a hosted multi-tenant trading service.
Each deployment belongs to one owner and keeps that owner's credentials, data,
strategies, and risk settings isolated.

## Product architecture

Eve has one user-facing identity. Under that identity, many specialized
strategy runtimes may research and monitor in parallel. They are represented
internally as strategy-bound workspaces rather than separate channel identities
or permanent Eve processes.

- **Eve** is the single user-facing persona in a deployment.
- The **owner** controls that deployment. Authenticated channel principals can
  be configured as aliases of the same owner.
- A **conversation** is one authenticated channel, principal, and thread. Each
  initialized conversation has exactly one active-workspace pointer. Its first
  message creates and selects `Main`.
- A **workspace** is a durable named container for research state and may bind
  to zero or one versioned strategy pack.
- A **strategy pack** is a reusable definition; a workspace holds the owner's
  configured instance of it.
- A **session generation** is temporary model history for one workspace.
- A **worker** is a stateless, bounded internal task and is never another Eve.

In product language, a strategy-bound workspace may be described as a
specialized agent: it has its own thesis, context, durable findings, monitors,
budgets, and tool permissions. Internally, it remains part of the owner's one
Eve deployment and uses bounded worker runs rather than a permanently running
model process.

The iMessage or Telegram conversation is the inbox.

- A deterministic control plane routes each ordinary message to one named
  workspace before any workspace model processes it.
- Each workspace has isolated conversation history, summaries, files, pending
  tasks, strategy settings, budgets, and tool permissions.
- Shared adapters and canonical source facts are reused across workspaces.
- Optional worker models may perform bounded extraction, parsing, or
  classification jobs with fresh context. They are implementation details, not
  user-facing agents or durable workspaces.

Examples of workspaces are `Earnings Calls`, `Insider Clusters`,
`Congressional Signals`, `Portfolio`, and `Image Experiments`. Switching
selects that workspace's current session generation; it does not create a new
generation or require another phone number. `Start fresh` retires the current
session generation while retaining durable workspace state.

The active workspace controls only where unqualified interactive messages go.
Workspace monitors have a separate explicit enabled/paused state, so a
background tracker can continue without becoming the active chat context.
Archiving the active workspace requires an atomic selection of its replacement.
HTTP requests provide an explicit workspace ID and do not use a conversation's
active pointer.

## Concurrent strategy runtimes

A single Eve deployment is intended to run multiple enabled strategies at the
same time. For example, one workspace may monitor public Jim Cramer commentary
for an inverse-signal strategy while another monitors delayed congressional
trade disclosures, another watches insider-buying clusters, and another tracks
credit-equity or real-world social signals. Each strategy owns separate context,
durable state, schedules, findings, budgets, and permissions.

The active workspace controls only which strategy receives an unqualified
interactive message. It does not start, stop, or pause the other strategies.
Background monitors continue on their own schedules and send alerts labeled
with the strategy that produced them. Multiple due monitor runs may execute
concurrently through bounded isolated workers.

Strategy runtimes may produce research, alerts, and proposed orders. They do not
turn public commentary or delayed disclosures into automatic trading
authorization. Every supported live broker mutation remains behind the shared
control plane's exact preview, revalidation, and fresh owner approval.

## Workspace routing and UX

The target Photon experience combines two interaction patterns:

1. A Spectrum **Manage Eve Sessions** mini app for creating, selecting,
   renaming, archiving, starting fresh, and explicitly deleting workspaces.
2. A compact Spectrum mini-app card when a lightweight topic detector sees a
   high-confidence mismatch with the active workspace. Its actions are to stay,
   switch to a suggested existing workspace, or create a new workspace. Plain
   text remains the fallback when the Spectrum launcher is unavailable.

The detector may suggest routing but must never silently switch workspaces. To
prevent contamination, a suspected topic-change message is held outside every
workspace until the owner chooses; the selected workspace then receives that
message through a serialized dispatch. Durable assignment and dispatch receipts
make retries idempotent; an uncertain dispatch is quarantined for recovery
rather than blindly replayed. A detector may inspect only that bounded message
plus workspace manifests while it remains unassigned; it cannot see workspace
histories or invoke tools.

Control events are distinct from workspace messages. Workspace commands,
mini-app callbacks, and financial approvals use server-minted request IDs,
revisions, expirations, and one-time durable consumption. Workspace mini-app
actions change routing state only; they use a separate protocol and cannot
approve a trade or other financial mutation.
Stale or repeated actions are harmless no-ops.

Every workspace-model response and workspace-scoped alert identifies its
workspace; owner-global control-plane responses identify themselves separately.
An alert carries a bound reply target. If an ambiguous reply refers to an alert
from a workspace other than the active one, Eve holds it for confirmation
instead of routing it by proximity. Plain-text workspace controls remain a
fallback so the core product does not depend on a particular Photon client
capability.

Archive freezes new routing, pauses monitors, and revokes pending workspace
approvals. `Delete` begins as a recoverable retirement; hard deletion can be
offered only for product-owned data after active work and uncertain financial
operations are resolved. External broker and legally required safety records
are never presented as deletable chat data.

## Context and durable state

A workspace outlives any session generation.

- **Session-generation state:** recent messages, the current task, and temporary
  reasoning.
- **Workspace state:** strategy configuration, watchlists, theses, findings,
  monitors, open questions, and a bounded rehydration brief.
- **Owner-global state:** connector configuration, normalized entity IDs,
  portfolio safety controls, broker-operation reconciliation, and presentation
  preferences.
- **Authoritative external state:** live balances, positions, orders, prices,
  and filings, which must be fetched rather than trusted from memory.

Compaction remains workspace-local. Before a session generation can be retired,
the bounded workspace brief and relevant structured records must already be
durable. Expiry, reset, or `Start fresh` then revokes approvals bound to the old
generation, starts a replacement, and rehydrates only that durable state. Raw
transcripts, filings, PDFs, and other large artifacts belong in durable storage
and are retrieved on demand.

Cross-workspace analysis uses typed, provenance-bearing signals. It must not
achieve “convergence” by merging chat histories. A promoted signal carries its
schema version, source provenance, as-of time, producing workspace, and access
classification. Private broker results and unpromoted workspace notes never
enter this shared evidence plane.

## Template layers

### Shared core

The forkable core owns:

- channel authentication and owner allowlisting;
- workspace registry, routing, lifecycle, and durable message deduplication;
- provider adapters and the mandatory MCP result-normalization boundary;
- source provenance, freshness, rate-limit, and failure semantics;
- scheduling, idempotency, retries, budgets, and operational status;
- paper execution plus broker contracts;
- exact-action previews, expiring approvals, reconciliation, and audit records;
- owner-global hard exposure, loss, asset, account, and concurrency controls;
- atomic capital reservations so concurrent workspaces cannot over-allocate;
- invariant evaluations for isolation, safety, reliability, and cost.

### Strategy packs

Each strategy pack owns its thesis, instructions, required data sources,
schedules, scoring rules, risk defaults, and strategy-specific evaluations. A
workspace may instantiate one pack or remain a general-purpose container.
Pack-level risk settings may only tighten shared core limits, never loosen
them.

Strategy packs may produce research and proposed orders. Live execution remains
behind a non-model control-plane protocol. A single-use approval binds the
authenticated owner, principal, workspace, session generation, broker account,
complete normalized action, displayed-preview hash, price collar, request ID,
and expiry. Revalidation may accept or reject the unchanged action; any change
requires a new preview and approval. Natural-language model interpretation
never constitutes authorization.

Freshness applies at preview, submission, amendment, and reconciliation; a
resting order can fill later at the broker. The core must explicitly handle
partial fills, cancellations, expiration, and uncertain outcomes. An uncertain
mutation blocks further financial mutations until authoritative reconciliation.

The initial live capability surface is spot order submission, edit, and cancel.
Transfers, withdrawals, credential changes, leverage, margin, and unsupported
derivatives are outside the core template unless separately designed and
reviewed.

### Optional integrations

Concrete paid data providers, alternative brokers, crypto-specific features,
Photon-rich UI, backtesting, and specialized model workers should remain
replaceable modules. Removing one provider, including Masterkey, must not change
the workspace or strategy contracts.

## Current implementation gap

This document describes the target architecture. Spec 1 implements the Photon
polling/runtime foundation, and Spec 2 implements and production-accepts the
versioned-pack framework and IPO Filings reference workflow. Later strategy
behavior, source adapters, cross-channel support, private artifacts, and
financial layers remain incomplete.

- Photon has a durable conversation workspace registry, one active-workspace
  pointer, isolated continuation addresses, session-generation rollover,
  fail-closed deployment-owner mapping, immutable durable-mode ingress and
  assignment receipts, bounded workspace briefs, strategy configuration,
  capability manifests, budgets, monitors, findings, alerts, and uncertain-send
  quarantine. The initial `Main` workspace adopts the prior continuation so
  enabling durable mode does not discard the confirmed session. General topic
  mismatch detection and some crash-only receipt/outbox recovery remain parked.
- The tap-to-open Spectrum **Manage Eve Sessions** mini app now supports
  create, select, rename, archive, restore, and start-fresh actions through an
  owner-bound short-lived capability. Explicit session-management requests open
  only this mini app; `workspace` remains an accepted input alias, while all
  user-facing labels say `session`. It also renders workspace-monitor schedule,
  sources, health, usage, and budget controls. Compact general topic-change
  cards, inline `live: true` rendering, and hard deletion remain unimplemented.
- Telegram also maps a private chat directly to one continuation. It needs the
  same workspace broker before workspace routing is enabled there. Every channel
  must enforce the deployment owner allowlist; Coinbase's separate allowlist is
  not a general channel access control.
- New workspace monitors are immutably bound to owner/workspace IDs and the
  scheduler can execute isolated compiled workers with workspace state, budgets,
  permissions, deterministic findings, and Photon alert routing. Legacy triggers
  retain their restricted compatibility runner until explicitly assigned.
  Owner-authorized production rollout and the real iMessage alert, Discuss,
  next-turn, manager, and rollback acceptance passed on 2026-08-15. Dispatch and
  Photon workspace alerts returned to off afterward; source-event/RSS/WebSub
  ingestion remains deferred until a reviewed adapter has a real push contract.
- A generated repository catalog now validates and pins immutable strategy-pack
  definitions. Sessions remain general purpose or bind to one exact version and
  digest; Eve and Spectrum use the same atomic create/configure/remove services.
  `IPO Filings@1.0.0` reuses the accepted SEC normalizer, worker, finding,
  alert, and delivery path. Install-only is paused, scheduled work receives an
  exact pack/resource snapshot, and independent pack/workspace/alert switches
  preserve durable evidence when disabled. The complete local gate and staged
  production SEC, Photon delivery, Discuss, exact pack-managed worker, cleanup,
  and rollback acceptance passed on 2026-08-15. Interactive pack surfaces remain
  on; global dispatch, pack-managed dispatch, and Photon alerts are off.
- Exact previews currently protect order creation only. Edit/cancel use generic
  approval, market-order collars are not yet enforced by the approval protocol,
  and uncertain operations do not yet block subsequent mutations. All mutation
  paths must become workspace-, generation-, request-, account-, displayed-
  preview-, and reconciliation-gate-bound before multi-workspace live trading.
- The current Coinbase MCP surface includes approved conversions, transfers,
  and portfolio mutations. Those are outside the initial core target and must
  be disabled before any live-broker release or isolated in a separately
  reviewed, disabled-by-default pack.
- Hard deletion of Eve's retained session data is not currently established;
  the initial workspace lifecycle therefore supports archive and session
  retirement rather than promising complete erasure.

## Canonical strategy research

The detailed strategy-research documents remain separate. Each describes a
candidate strategy pack. This index records what each one contributes without
copying its rules:

- [`idea/earnings-call-language-analysis.md`](idea/earnings-call-language-analysis.md):
  quarter-over-quarter management-language, specificity, hedging, guidance, and
  Q&A evasion analysis.
- [`idea/insider-buying-clusters.md`](idea/insider-buying-clusters.md):
  opportunistic Form 4 purchase clusters and multi-signal convergence.
- [`idea/congressional-trading-signals.md`](idea/congressional-trading-signals.md):
  committee relevance, disclosure lag, member quality, and political-trade
  clusters.
- [`idea/social-signal-arbitrage.md`](idea/social-signal-arbitrage.md):
  real-world demand changes that may lead reported financial results.
- [`idea/post-bankruptcy-equities.md`](idea/post-bankruptcy-equities.md):
  fresh-start financials, creditor selling, and post-emergence operating quality.
- [`idea/credit-equity-dislocations.md`](idea/credit-equity-dislocations.md):
  disagreements between credit-market and equity-market signals.
- [`idea/buffett-modern-playbook.md`](idea/buffett-modern-playbook.md):
  the long-horizon value framework, kill criteria, concentration, and use of
  other signals as confirmation.

These documents can disagree because they describe different candidate packs.
Shared agent identity or safety instructions must not flatten those differences
into one universal strategy.

## Canonical data-source research

- [`idea/data/house-disclosures-api.md`](idea/data/house-disclosures-api.md):
  official House Clerk ZIP/XML index and PTR PDF workflow; the primary House
  disclosure source.
- [`idea/data/congressional-data-sources.md`](idea/data/congressional-data-sources.md):
  source comparison and the House/Senate coverage plan.
- [`idea/data/capitol-trades-api.md`](idea/data/capitol-trades-api.md):
  derived House and Senate data used as enrichment or fallback, especially for
  the Senate gap.
- [`idea/data/finnhub-api.md`](idea/data/finnhub-api.md):
  quotes, Form 4 transactions, news, metrics, recommendations, and earnings
  enrichment; congressional trades are paywalled.

## Canonical watchlists

- [`idea/congressional-leaders-watchlist.json`](idea/congressional-leaders-watchlist.json):
  researched 119th Congress leadership, committee members, active traders, and
  evidence-based signal tiers.
- [`idea/informed-traders-watchlist.json`](idea/informed-traders-watchlist.json):
  tracked 13F managers, 13D activists, short sellers, and deprioritized sources.
- [`idea/watchlist.json`](idea/watchlist.json):
  currently appears to mirror the congressional watchlist and should be
  reconciled before it is treated as a separate canonical dataset.

The research corpus lives in the repository's `idea/` directory. Before
publishing the template, migrate these files—without combining them—into
versioned `docs/strategies`, `docs/data-sources`, and `config/watchlists`
directories so a fork contains its own north-star sources.

## Non-goals

- Hosting many customers or taking custody of their credentials.
- Promising returns or treating a signal score as trading authorization.
- Silently routing messages or silently activating strategies.
- Treating workspace UI, memory, or model prose as financial authorization.
- Loading every strategy document, provider schema, or raw artifact into every
  model call.
- Building every broker, asset class, data vendor, and UI before the contracts
  are proven.
- Measuring eval success by historical alpha alone.

## Success invariants

- No message, summary, file, approval, or private tool result leaks across
  workspaces.
- A routing detector may inspect a bounded unassigned message, but one immutable
  workspace assignment is recorded before any workspace model sees it.
- Stale polls, cards, and approval replies are harmless no-ops.
- No broker mutation is submitted without authoritative revalidation and exact,
  unexpired, one-time owner approval for the displayed action.
- Scheduled research cannot access trading mutations or private chat history.
- Tool output and model context stay bounded without losing provenance.
- Core evals cover isolation, authorization, idempotency, failure recovery, and
  cost; each strategy pack separately evaluates its signal logic.
- A fresh fork can run a paper-only reference workflow before live brokerage is
  enabled.

## Near-term sequence

1. Specs 1–4A are complete: isolated runtimes, versioned packs, shared SEC/House
   public facts, Congressional Signals, and the deterministic-first hybrid
   evidence/reasoning foundation. Hybrid child flags remain rolled back off.
2. Prove that foundation with two real consumers: Spec 4B Earnings Call Changes,
   then Spec 4C using a different connector and content shape.
3. Revisit Spec 5 Insider Clusters after those proofs, then implement Spec 6's
   typed shared-signal plane without weakening workspace isolation.
4. Extend the deployment-owner boundary and workspace broker to Telegram and
   authenticated HTTP before enabling workspace access there.
5. Add owner-private artifact retention and pre-normalization capture for paid
   or temporary provider output.
6. Disable out-of-scope Coinbase mutations, then make order-create/edit/cancel
   risk reservations, previews, collars, approvals, revalidation, uncertainty
   gates, and audit records workspace-aware before enabling multi-workspace live
   trading.
7. Add high-confidence general topic-change detection and held-message crash
   recovery.
8. Return to the explicit Spec 1 deferred-hardening phase after Specs 2–6 unless
   an item becomes an observed ordinary-path failure sooner.
9. Introduce cheaper bounded worker models only where evals show no quality or
   safety regression.

Owner-authorized Spec 1 production rollout completed on 2026-08-15 at commit
`7db61b4`. One live canonical SEC replay produced one durable finding, one
single-attempt Photon delivery, a Discuss-bound next turn, and a matching
manager state read; rollback then disabled dispatch and alerts without deleting
workspace records. Bounded fingerprints and deployment evidence live in
`specs/01-independent-workspace-runtimes.md` and `HANDOFF.md`.
