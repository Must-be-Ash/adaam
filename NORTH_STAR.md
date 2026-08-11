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

Eve has one user-facing identity, not a permanent manager agent delegating to a
fleet of permanent strategy agents.

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

## Workspace routing and UX

The target Photon experience combines two interaction patterns:

1. A Spectrum **Manage Eve Workspaces** mini app for creating, selecting,
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

This document describes the target architecture, not a claim that workspace
isolation already exists.

- Photon now has a durable conversation workspace registry, one active-workspace
  pointer, isolated workspace continuation addresses, session-generation
  rollover, serialized webhook handling, revision-checked lifecycle controls,
  and Redis-backed Chat SDK state. The initial `Main` workspace adopts the
  conversation's prior continuation so enabling workspaces does not discard the
  confirmed working session. Durable ingress assignment/dispatch receipts,
  quarantined uncertain delivery, bounded workspace briefs, and automatic topic
  mismatch detection are still not implemented.
- The tap-to-open Spectrum **Manage Eve Workspaces** mini app now supports
  create, select, rename, archive, restore, and start-fresh actions through an
  owner-bound short-lived capability. Plain-text controls provide the fallback.
  Compact topic-change cards, inline `live: true` rendering, and hard deletion
  remain unimplemented.
- Telegram also maps a private chat directly to one continuation. It needs the
  same workspace broker before workspace routing is enabled there. Every channel
  must enforce the deployment owner allowlist; Coinbase's separate allowlist is
  not a general channel access control.
- Existing event triggers are owner/conversation scoped and must gain immutable
  workspace IDs before workspace alerts are enabled.
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

- [`../idea/earnings-call-language-analysis.md`](../idea/earnings-call-language-analysis.md):
  quarter-over-quarter management-language, specificity, hedging, guidance, and
  Q&A evasion analysis.
- [`../idea/insider-buying-clusters.md`](../idea/insider-buying-clusters.md):
  opportunistic Form 4 purchase clusters and multi-signal convergence.
- [`../idea/congressional-trading-signals.md`](../idea/congressional-trading-signals.md):
  committee relevance, disclosure lag, member quality, and political-trade
  clusters.
- [`../idea/social-signal-arbitrage.md`](../idea/social-signal-arbitrage.md):
  real-world demand changes that may lead reported financial results.
- [`../idea/post-bankruptcy-equities.md`](../idea/post-bankruptcy-equities.md):
  fresh-start financials, creditor selling, and post-emergence operating quality.
- [`../idea/credit-equity-dislocations.md`](../idea/credit-equity-dislocations.md):
  disagreements between credit-market and equity-market signals.
- [`../idea/buffett-modern-playbook.md`](../idea/buffett-modern-playbook.md):
  the long-horizon value framework, kill criteria, concentration, and use of
  other signals as confirmation.

These documents can disagree because they describe different candidate packs.
Shared agent identity or safety instructions must not flatten those differences
into one universal strategy.

## Canonical data-source research

- [`../idea/data/house-disclosures-api.md`](../idea/data/house-disclosures-api.md):
  official House Clerk ZIP/XML index and PTR PDF workflow; the primary House
  disclosure source.
- [`../idea/data/congressional-data-sources.md`](../idea/data/congressional-data-sources.md):
  source comparison and the House/Senate coverage plan.
- [`../idea/data/capitol-trades-api.md`](../idea/data/capitol-trades-api.md):
  derived House and Senate data used as enrichment or fallback, especially for
  the Senate gap.
- [`../idea/data/finnhub-api.md`](../idea/data/finnhub-api.md):
  quotes, Form 4 transactions, news, metrics, recommendations, and earnings
  enrichment; congressional trades are paywalled.

## Canonical watchlists

- [`../idea/congressional-leaders-watchlist.json`](../idea/congressional-leaders-watchlist.json):
  researched 119th Congress leadership, committee members, active traders, and
  evidence-based signal tiers.
- [`../idea/informed-traders-watchlist.json`](../idea/informed-traders-watchlist.json):
  tracked 13F managers, 13D activists, short sellers, and deprioritized sources.
- [`../idea/watchlist.json`](../idea/watchlist.json):
  currently appears to mirror the congressional watchlist and should be
  reconciled before it is treated as a separate canonical dataset.

The research corpus currently lives beside this repository. Before publishing
the template, migrate these files—without combining them—into versioned
`docs/strategies`, `docs/data-sources`, and `config/watchlists` directories so a
fork contains its own north-star sources.

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

1. Specify state machines and eval fixtures for ingress, routing isolation,
   lifecycle, tool permissions, stale actions, session rollover, and approvals.
2. Add deployment-wide owner mapping, durable ingress/artifact storage,
   deduplication, serialized conversation controls, serialized workspace
   delivery, and assignment/dispatch receipts.
3. Add bounded workspace briefs and structured state, then build the
   workspace-aware session broker, explicit manual routing, and generation
   rollover.
4. Add default-deny capability manifests and migrate monitors to immutable
   workspace IDs.
5. Disable out-of-scope Coinbase mutations, then make order-create/edit/cancel
   risk reservations, previews, collars, approvals, revalidation, uncertainty
   gates, and audit records workspace-aware before enabling multi-workspace live
   trading.
6. Add high-confidence topic-change detection and held-message recovery.
7. Add the authenticated Spectrum workspace-management mini app and compact
   topic-change cards as progressive UX, retaining plain-text fallbacks.
8. Migrate Telegram to the workspace broker.
9. Convert the research documents into versioned strategy packs and versioned
   data-source documentation/adapters.
10. Introduce cheaper bounded worker models only where evals show no quality or
    safety regression.
