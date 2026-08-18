for context read this: /Users/ashnouruzi/dev/adaam/docs/hybrid-evidence-roadmap.md

Spec 4C TL;DR
Build a second real specialized research strategy.
Use a different source and content format from earnings-call transcripts—such as RSS, website changes, social posts, spreadsheets, or another API.
Choose the exact strategy only after checking source reliability, access terms, cost, and testability. It was intentionally not selected yet.
Reuse the existing hybrid system:deterministic parsing when reliable;
cheap/fast models for extraction or recovery;
frontier models for interpretation, forecasting, and recommendations.

Produce cited facts, signals, explanations, forecasts, and actionable research—not automated trades.
Reuse existing workers, budgets, provenance, quarantine, workspace isolation, scheduling, alerts, and Discuss routing. Do not rebuild the architecture.
Prove the shared foundation works beyond one strategy before revisiting Spec 5 and then Spec 6.

## What Spec 4C is

Spec 4C is supposed to build the second real specialized research agent on Eve’s shared infrastructure.

What already exists:

- Spec 4A built the reusable hybrid research engine.
- Spec 4B proved it with Earnings Call Changes:
  - collect earnings materials;
  - compare current and previous calls;
  - extract facts;
  - use an LLM to interpret changes;
  - produce cited forecasts and recommendations;
  - alert the user.
- Spec 4B.1 added model selection:
  - deterministic code when possible;
  - cheap models for extraction;
  - frontier models for judgment and forecasting.

Spec 4C must prove that this infrastructure is genuinely reusable and not secretly designed only for earnings calls.

## What it should build

It should select and implement one new investment-research strategy that uses a substantially different source.

Possible source shapes include:

- RSS feeds;
- changing webpages;
- social posts;
- spreadsheets;
- another authoritative API;
- another document type.

The exact strategy was deliberately not selected. The first step is choosing one that has:

- trustworthy sources;
- usable access terms;
- manageable cost;
- stable enough data for reliable monitoring;
- meaningful investment value;
- a content format different from earnings transcripts.

## How the finished strategy should work

```text
Trusted source
    ↓
Fetch new information
    ↓
Deterministic parser handles known structure
    ↓
Cheap model recovers or extracts difficult content when needed
    ↓
Frontier model interprets meaning, patterns, implications, and forecasts
    ↓
Validate facts and citations
    ↓
Save a workspace-isolated finding
    ↓
Alert the user
    ↓
User opens Discuss and continues in the correct workspace
```

For example, if the chosen strategy monitors public social posts:

- the connector collects posts from reviewed accounts;
- deterministic code records author, time, URL, and exact text;
- a cheap model may normalize or classify straightforward information;
- a frontier model determines what the post could mean for companies, sectors, commodities, or market expectations;
- the result explains its reasoning and cites the original posts and supporting evidence;
- Eve alerts the user when the resulting signal is material.

That is only an example—not the already-selected Spec 4C strategy.

## What should be reused

Spec 4C should reuse the infrastructure already built for:

- scheduled monitoring;
- source acquisition and immutable evidence;
- deterministic parsing;
- hybrid model jobs;
- cheap-versus-frontier model routing;
- budgets and cost tracking;
- citations and provenance;
- validation and quarantine;
- replay and deduplication;
- workspace isolation;
- findings and alerts;
- Photon Discuss and Manage actions;
- versioned strategy packs.

If the new strategy requires rebuilding those systems, the architecture has failed its reuse goal. Small shared changes are acceptable only when the new source exposes a genuine missing capability.

## What the spec itself must define

The Spec 4C document should clearly specify:

- the selected strategy and why it was chosen;
- the authoritative sources and connector;
- what information is collected;
- what deterministic code handles;
- when cheap models are used;
- when frontier reasoning is used;
- what signals, forecasts, or recommendations are produced;
- how every conclusion remains connected to evidence;
- what causes an alert;
- what the user can configure;
- failure, abstention, and quarantine behavior;
- workspace isolation and budget limits;
- focused tests and one real end-to-end acceptance;
- staged rollout and rollback;
- implementation sprints and completion checklists.

## What it should not become

Spec 4C should not attempt to:

- build every future connector;
- implement several strategies at once;
- redesign the hybrid architecture;
- create a universal web crawler;
- implement Spec 5 Insider Clusters;
- create cross-strategy signal sharing from Spec 6;
- place trades automatically;
- add speculative hardening unrelated to the working path.

## Why we need it

After Spec 4C, we should know that Eve can support multiple genuinely different research agents using the same foundation.

That gives us confidence to:

1. revisit and improve Spec 5 Insider Clusters;
2. build Spec 5 using the proven shared components;
3. implement Spec 6 so independently isolated strategies can share carefully structured signals without mixing their conversations or private context.

Take ownership of designing Spec 4C for Eve. Do not begin implementation yet.

Start from current GitHub main at 0f6c8107eb4e6b5a0c6956254a1b290f911ff267.

First read:

- HANDOFF.md
- NORTH_STAR.md
- BACKLOG.md
- specs/04a-hybrid-evidence-reasoning.md
- specs/04b-earnings-call-changes.md
- specs/04b1-adaptive-model-routing.md
- the relevant strategy ideas under idea/

Specs 1–4B.1 are complete. Spec 4C is the second real consumer of the hybrid evidence architecture.

The exact Spec 4C strategy and source were intentionally left undecided. Select them only after comparing a small number of useful candidates based on:

- authoritative or demonstrably trustworthy sources;
- legal and operational access;
- cost;
- source stability and testability;
- meaningful investment-research value;
- a connector/content shape materially different from earnings transcripts.

Spec 4C should:

- introduce one different connector/content shape;
- use deterministic acquisition and parsing where reliable;
- use fast, inexpensive models for bounded extraction or recovery;
- use frontier reasoning models for interpretation, patterns, forecasts, implications, and recommendations;
- preserve citations, evidence lineage, uncertainty, and workspace isolation;
- deliver the complete monitor → finding → alert → Discuss/Manage owner workflow;
- reuse the existing artifact, job, worker, budget, provenance, quarantine, model-routing, scheduling, and alert infrastructure;
- avoid changing shared architecture unless an observed requirement proves a small change is necessary;
- exclude automated trade execution.

Keep the spec proportionate. Break implementation into clear sprints with checklists and exit gates, but do not require broad reviews or full regression runs after every sprint. Use focused checks while building, then one final independent review, fixes, one final relevant regression gate, controlled acceptance, documentation updates, and landing to main.

Explain your recommended Spec 4C strategy to me in plain language before finalizing the spec if selecting it requires a meaningful product choice. Otherwise, create the proposed Spec 4C Markdown file and report the choice, rationale, sprint breakdown, and any genuine unresolved decisions.

If something is unclear, ask me about it before designing the spec