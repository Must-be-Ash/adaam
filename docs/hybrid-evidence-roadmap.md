# Hybrid evidence roadmap and Spec 4C handoff

Snapshot: 2026-08-17  
Repository baseline: `main` at `0f6c8107eb4e6b5a0c6956254a1b290f911ff267`

## Purpose

Eve is being built as a single-owner investment and research agent that can run
multiple isolated strategy workspaces. Each workspace may monitor different
sources and apply different research policies without sharing its conversation,
private configuration, budget, or derived strategy state with another
workspace.

The hybrid evidence track gives those strategies a shared way to combine:

- deterministic processing for exact, known, and reliably validated data;
- inexpensive models for bounded extraction or recovery when a supported
  layout cannot be parsed reliably;
- frontier reasoning models for interpretation, pattern recognition,
  forecasting, recommendations, and connecting evidence across a large body of
  information.

Models are expected to provide useful investment judgment, including possible
implications, scenarios, correlations, forecasts, and portfolio relevance. The
result must remain connected to cited evidence and explain the reasoning that
supports it. Research may inform a human decision, but it does not itself
authorize or execute a trade.

## What has been completed

The foundation was developed in this order:

1. **Spec 1 — Independent Workspace Runtimes** established isolated durable
   workspaces, schedules, workers, findings, alerts, budgets, and Photon
   management and discussion flows.
2. **Spec 2 — Versioned Strategy Packs** made strategy behavior installable,
   immutable by version, capability-bound, and independently configurable per
   workspace.
3. **Spec 3 — Public Source Adapters** added shared acquisition, source
   identity, canonical public facts, corrections, and isolated workspace
   projections.
4. **Spec 4 — Congressional Signals** became the first specialized strategy,
   primarily proving deterministic public-document acquisition and signal
   production from authoritative House data.
5. **Spec 4A — Hybrid Evidence and Reasoning** added the shared
   deterministic-first hybrid layer. It covers immutable evidence artifacts,
   bounded model jobs, validation, citations, provenance, quarantine, budgets,
   replay, workspace isolation, and model-derived semantic interpretation.
6. **Spec 4B — Earnings Call Changes** became the first complete hybrid strategy.
   It acquires authoritative earnings materials, compares ordered periods,
   extracts cited facts, evaluates meaningful changes, and produces supported
   interpretations, forecasts, recommendations, findings, and alerts.
7. **Spec 4B.1 — Adaptive Model Routing** added central task-aware selection:
   no model for deterministic work, a qualified inexpensive model for bounded
   extraction, and a qualified frontier model for consequential semantic
   judgment.

Specs 1–4B.1 are implemented and production accepted. Their detailed evidence,
rollout state, and remaining hardening are recorded in the specifications,
`HANDOFF.md`, and `BACKLOG.md`. The relevant hybrid, earnings, workspace-dispatch,
and Photon-alert production flags are intentionally left off after acceptance.

Two owner-path regressions discovered after Spec 4B were also repaired: legacy
Main-workspace Coinbase access no longer requires a persisted strategy document,
and archived sessions no longer consume the active-workspace limit while create
failures remain visible in the manager UI.

## Why Spec 4C exists

Earnings Call Changes proves that the hybrid system works for authoritative,
long-form, ordered transcripts. That is only one source and content shape.

Spec 4C is the second real specialized strategy. Its purpose is to demonstrate
that the shared foundation also works for materially different evidence without
recreating strategy-specific workers, model plumbing, provenance, budgets,
quarantine, workspace isolation, scheduling, or alert delivery.

Without this second consumer, the shared architecture may still contain
earnings-specific assumptions that have not been exposed.

## The unresolved Spec 4C choice

No exact Spec 4C strategy or provider has been selected. This was intentional.
The choice depends on source reliability, access terms, cost, provenance,
operational stability, and whether the source can support a credible controlled
acceptance.

The second strategy should use a shorter or faster-changing semantic source and
a connector/content shape different from earnings transcripts. Candidate shapes
include:

- RSS or reviewed news commentary;
- monitored website changes;
- public social posts or commentary;
- spreadsheets or changing tabular reports;
- another authoritative API or document family.

The social-post example discussed previously is illustrative rather than a
settled product decision. In that example, deterministic code would preserve
the author, timestamp, canonical URL, and exact text; model reasoning would
identify relevant entities, stance, possible market implications, affected
assets, alternative interpretations, and supporting or contradicting evidence.

## What Spec 4C needs to accomplish

The selected strategy needs to provide one complete owner-visible research
vertical:

```text
Trusted source
    -> reviewed acquisition
    -> immutable evidence
    -> deterministic parsing when reliable
    -> inexpensive model extraction or recovery when needed
    -> frontier interpretation, pattern analysis, forecasts, and recommendations
    -> validation and exact citations
    -> workspace-isolated finding
    -> material alert
    -> Discuss and Manage in the correct workspace
```

Its specification needs to make clear:

- which investment-research question the strategy answers and why it is useful;
- which sources are authoritative or otherwise sufficiently trustworthy;
- what the connector collects and how source identity and revisions are
  preserved;
- which facts remain deterministic and which outputs are model-derived;
- where inexpensive extraction ends and frontier judgment begins;
- what signals, explanations, forecasts, recommendations, counterevidence, and
  invalidation conditions are retained;
- how conclusions remain traceable to exact evidence;
- what the owner can select, configure, schedule, pause, inspect, and discuss;
- what constitutes a material new result versus a baseline, replay, duplicate,
  correction, or non-actionable change;
- how failure, ambiguity, unsupported claims, invalid citations, and hostile
  source content abstain or enter quarantine;
- what evidence demonstrates the connector, strategy, model routes, isolation,
  alert path, and rollback work as one complete vertical.

## Existing foundation available to Spec 4C

Spec 4C inherits working shared capabilities for:

- isolated workspace state, schedules, budgets, workers, findings, and alerts;
- versioned strategy packs and capability declarations;
- guarded public-source acquisition and immutable evidence artifacts;
- canonical facts, corrections, lineage, and workspace projections;
- deterministic parsing and ordered evidence bundles;
- bounded extraction and semantic-reasoning jobs;
- inexpensive-versus-frontier model selection;
- model, prompt, policy, evidence, token, and cost provenance;
- validation, abstention, quarantine, replay, and deduplication;
- Photon alert delivery plus workspace-correct Discuss and Manage actions.

The goal is to reveal whether these shared contracts work for a new source—not
to replace them or build a parallel copy. A genuinely missing shared capability
may emerge from the second consumer, but it should be identifiable as a concrete
need exposed by that vertical.

## Boundaries

Spec 4C represents one strategy and one new connector/content family. It is not
the project for every future connector, several simultaneous strategies, a
universal crawler, or a redesign of the completed hybrid architecture.

It also does not absorb:

- Spec 5 Insider Clusters;
- Spec 6 cross-strategy signal sharing;
- automatic trade execution;
- unrelated deferred operations and crash hardening;
- broad paid or private-source retention that requires a separate rights and
  storage design.

## What follows Spec 4C

The agreed sequence after the second hybrid consumer is:

1. Revisit and improve **Spec 5 — Insider Clusters** using what the two real
   hybrid consumers revealed. Authoritative SEC Form 4 XML and numerical cluster
   logic should remain deterministic where exact processing is superior; the
   hybrid layer is available for justified semantic evidence or recovery.
2. Implement **Spec 6 — Shared Signal Plane** after Congressional Signals,
   Earnings Call Changes, Spec 4C, and Insider Clusters have demonstrated which
   public signal fields genuinely need to cross strategy boundaries. Strategy
   conversations, private settings, budgets, and hidden reasoning remain
   isolated.
3. Add further source connectors and strategies as small reviewed extensions
   that reuse the established evidence and reasoning foundation.

## Authoritative references

- `HANDOFF.md` — current implemented architecture, production state, operating
  boundaries, and known gaps.
- `NORTH_STAR.md` — intended product architecture and near-term sequence.
- `BACKLOG.md` — deliberately deferred work; it is context, not evidence that a
  roadmap item has been started.
- `specs/01-independent-workspace-runtimes.md` — workspace runtime foundation.
- `specs/02-versioned-strategy-packs.md` — strategy-pack framework.
- `specs/03-public-source-adapters.md` — shared public-source contracts.
- `specs/04-congressional-signals-house.md` — deterministic reference strategy.
- `specs/04a-hybrid-evidence-reasoning.md` — shared hybrid architecture and
  original follow-on sequence.
- `specs/04b-earnings-call-changes.md` — first real hybrid strategy and reusable
  ordered-evidence contracts.
- `specs/04b1-adaptive-model-routing.md` — task-aware model selection.
- `specs/05-insider-clusters.md` — existing future strategy to revisit after
  Spec 4C.
- `specs/06-shared-signal-plane.md` — later typed cross-strategy signal layer.
- `idea/` — candidate strategy scenarios and evidence needs, including social
  signals, credit/equity dislocations, post-bankruptcy equities, and other
  research directions.

## Current handoff state

Spec 4C has not been designed or implemented. The next unresolved product
decision is the strategy and source family that can best prove the second
connector/content shape. Everything before that point is represented in the
completed specifications and current `main`.
