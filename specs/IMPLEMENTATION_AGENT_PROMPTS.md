# Copy-ready implementation-agent prompts

Use one prompt at a time, after the preceding spec has been implemented,
reviewed, and merged into the base branch. Each prompt delegates the whole spec,
but the agent must execute it one verified checklist task at a time according to
`specs/IMPLEMENTATION_PROTOCOL.md`.

## Spec 1 prompt

```text
Implement Spec 1, `specs/01-independent-workspace-runtimes.md`, to completion.

Before doing any implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and the entire assigned spec. Follow the
handoff's relevant links and inspect the existing code, tests, schemas, scripts,
package commands, and recent Git history so you understand the application and
do not rebuild systems that already exist. Read the relevant installed Eve and
Next.js documentation before changing framework code, and search the Eve
registry before implementing integrations.

Create a fresh dedicated worktree on branch
`codex/spec-01-independent-workspaces` from the latest agreed `main`; if the
environment already supplied a fresh isolated worktree, use it and do not create
another. Verify the branch contains the committed specification set. Preserve
all unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with only one
checklist task in progress. For each task: inspect first, implement the smallest
complete change, add or update a deterministic test, run focused verification,
review the diff, mark the checkbox only after it passes, update the concise
implementation-progress table, and create an atomic local commit containing the
behavior, test, and checkbox. Continue automatically to the next task unless
genuinely blocked. Never bulk-check boxes or claim completion from intention.

Spec 1 owns the durable independent-workspace runtime foundation. Keep strategy
pack compilation, general public-source adapters, Congressional/Insider strategy
logic, cross-strategy sharing, Telegram, private artifacts, and live/background
trading out of scope unless the spec explicitly requires a narrow interface.
After every spec requirement passes, make final review and safe local merge into
`main` the last task, exactly as defined by the implementation protocol. Do not
push, open a PR, deploy, or mutate remote/production state without separate
authorization.

Begin now with orientation, dependency/code audit, a sprint-ordered plan, and
the first incomplete Sprint 0 checklist item. Continue until the complete spec
is verified or an external/product blocker truly requires my decision.
```

## Spec 2 prompt

```text
Implement Spec 2, `specs/02-versioned-strategy-packs.md`, to completion.

Before doing any implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, Specs 1 and 2 completely, and the relevant
research/backlog files named by Spec 2. Follow the handoff's relevant links and
inspect the existing code, tests, schemas, scripts, package commands, and recent
Git history. Read the relevant installed Eve and Next.js documentation before
changing framework code, and search the Eve registry before building an
integration.

Create a fresh dedicated worktree on branch `codex/spec-02-strategy-packs` from
local `main` after Spec 1's reviewed branch has been merged; if the environment
already supplied a fresh isolated worktree from that base, use it and do not
create another. First confirm Spec 1's required runtime contracts and tests
exist; if they do not, report the exact missing dependency rather than building
a parallel runtime. Preserve unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with only one
checklist task in progress. For each task: inspect first, implement the smallest
complete change, add or update a deterministic test, run focused verification,
review the diff, mark the checkbox only after it passes, update the concise
implementation-progress table, and create an atomic local commit containing the
behavior, test, and checkbox. Continue automatically unless genuinely blocked.

Spec 2 owns the versioned strategy-pack framework and IPO reference pack. Do not
pull Spec 3's general source-adapter platform, Spec 4/5 strategy behavior, Spec
6 cross-workspace signal sharing, Telegram, private artifacts, or live trading
into this implementation. Pack-declared capabilities must remain default-deny
and cannot override Spec 1 runtime limits. After every requirement passes, make
final review and safe local merge into `main` the last task, exactly as defined
by the implementation protocol. Do not push, open a PR, deploy, or mutate
remote/production state without separate authorization.

Begin now with orientation, verification of the Spec 1 dependency, a
sprint-ordered plan, and the first incomplete Sprint 0 checklist item. Continue
until the complete spec is verified or an external/product blocker truly
requires my decision.
```

## Spec 3 prompt

```text
Implement Spec 3, `specs/03-public-source-adapters.md`, to completion.

Before doing any implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and Specs 1–3 completely. Read the relevant
source/research files named by Spec 3. Follow the handoff's links and inspect the
current runtime, pack framework, source code, tests, fixtures, schemas, scripts,
package commands, and recent Git history. Read relevant installed Eve and
Next.js documentation before changing framework code. Search the Eve registry
before implementing a source integration yourself.

Create a fresh dedicated worktree on branch `codex/spec-03-source-adapters` from
local `main` after Spec 2's reviewed branch has been merged; if the environment
already supplied a fresh isolated worktree from that base, use it and do not
create another. Confirm the Spec 1 runtime and Spec 2 pack contracts exist and
pass before relying on them; report missing dependencies rather than duplicating
them. Preserve unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with one
checklist task in progress. Inspect, implement narrowly, add deterministic
success/failure/bounds/replay fixtures as applicable, run focused verification,
review the diff, mark the item complete only after it passes, update the concise
progress table, and make an atomic local commit. Continue automatically unless
genuinely blocked.

Spec 3 owns reusable reviewed public-source fetch, parsing, normalization,
canonical facts, receipts, checkpoints, polling integration, and the reference
SEC/House adapters. It does not own Congressional or Insider scoring, generic
web crawling, private artifacts, Telegram, or financial actions. Preserve
workspace subscription isolation even when safe public fetches/facts are reused.
After every requirement passes, make final review and safe local merge into
`main` the last task, exactly as defined by the implementation protocol. Do not
push, open a PR, deploy, make paid calls, or mutate remote/production state
without separate authorization.

Begin now with orientation, dependency verification, a sprint-ordered plan, and
the first incomplete Sprint 0 checklist item. Continue until the complete spec
is verified or an external/product blocker truly requires my decision.
```

## Spec 4 prompt

```text
Implement Spec 4, `specs/04-congressional-signals-house.md`, to completion.

Before implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and Specs 1–4 completely. Read the
Congressional strategy research and House source references named by Spec 4.
Inspect the merged runtime, pack system, source adapters, canonical facts,
tests, fixtures, schemas, scripts, package commands, and recent Git history.
Read relevant installed Eve and Next.js documentation before changing framework
code, and search the Eve registry before adding integrations.

Create a fresh dedicated worktree on branch
`codex/spec-04-congressional-signals` from local `main` after Spec 3's reviewed
branch has been merged; if already in a fresh isolated worktree from that base,
use it and do not create another. Confirm Specs 1–3 contracts and tests exist;
do not build a separate scheduler, pack system, source store, adapter framework,
or alert path. Preserve unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with one
checklist task in progress. For each item, inspect first, implement the smallest
complete behavior, add deterministic tests/fixtures, run focused checks, review
the diff, check the item only after it passes, update the concise progress
table, and create an atomic local commit. Continue automatically unless blocked.

Spec 4 is House PTR Congressional Signals v1—not a Pelosi copy-trading system
and not a claim of wrongdoing. It owns deterministic House strategy
normalization, member history, versioned references, clusters, local scoring,
neutral alerts, and pack behavior while consuming Spec 3 evidence. Senate,
third-party scraped completeness claims, cross-strategy convergence, private
artifacts, Telegram, and trading remain out of scope. After every requirement
passes, make final review and safe local merge into `main` the last task, exactly
as defined by the implementation protocol. Do not push, open a PR, deploy, or
mutate remote/production state without separate authorization.

Begin now with orientation, dependency verification, a sprint-ordered plan, and
the first incomplete Sprint 0 checklist item. Continue until the complete spec
is verified or an external/product blocker truly requires my decision.
```

## Spec 5 prompt

```text
Implement Spec 5, `specs/05-insider-clusters.md`, to completion.

Before implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and Specs 1–3 plus Spec 5 completely. Read
the Insider Clusters research/watchlist files named by Spec 5. Also inspect Spec
4's implemented patterns where reuse is appropriate, without introducing a
runtime dependency on Congressional strategy state. Inspect code, tests,
fixtures, schemas, scripts, package commands, and recent Git history. Read the
relevant installed Eve and Next.js documentation, and search the Eve registry
before building an integration.

Create a fresh dedicated worktree on branch `codex/spec-05-insider-clusters`
from local `main` after Spec 4's reviewed branch has been merged; if already in
a fresh isolated worktree from that base, use it and do not create another.
Confirm the required Specs 1–3 contracts exist and pass; do not create parallel
runtime, pack, source, fact, or alert systems. Preserve unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with one
checklist task in progress. Inspect first, implement narrowly, add deterministic
Form 4 success/exclusion/history/correction/replay/race fixtures as applicable,
run focused verification, review the diff, mark the item complete only after it
passes, update the concise progress table, and create an atomic local commit.
Continue automatically unless genuinely blocked.

Spec 5 owns official SEC Form 4 ingestion details, workspace insider history,
eligibility, routine/opportunistic classification, cluster detection, local
scoring, neutral alerts, and pack behavior. Missing history or 10b5-1 evidence
must remain unknown rather than becoming model-inferred conviction. 13D/13F,
third-party scraping, Congressional behavior, Spec 6 convergence, private
artifacts, Telegram, and trading remain out of scope. After every requirement
passes, make final review and safe local merge into `main` the last task, exactly
as defined by the implementation protocol. Do not push, open a PR, deploy, make
paid calls, or mutate remote/production state without separate authorization.

Begin now with orientation, dependency verification, a sprint-ordered plan, and
the first incomplete Sprint 0 checklist item. Continue until the complete spec
is verified or an external/product blocker truly requires my decision.
```

## Spec 6 prompt

```text
Implement Spec 6, `specs/06-shared-signal-plane.md`, to completion.

Before implementation, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and Specs 1–6 completely. Inspect the merged
Congressional and Insider signal schemas, entity evidence, pack/runtime
capabilities, durable records, tests, fixtures, scripts, package commands, and
recent Git history. Read relevant installed Eve and Next.js documentation before
framework changes, and search the Eve registry before building an integration.

Create a fresh dedicated worktree on branch
`codex/spec-06-shared-signal-plane` from local `main` after Spec 5's reviewed
branch has been merged; if already in a fresh isolated worktree from that base,
use it and do not create another. Confirm all dependency contracts and tests
exist. If producer signal schemas are not stable, report the exact dependency
gap rather than weakening the Spec 6 boundary. Preserve unrelated changes.

Follow the implementation protocol exactly. Work in sprint order with one
checklist task in progress. Inspect first, implement the smallest complete
behavior, add deterministic authorization/isolation/schema/entity/lifecycle/
replay/race tests, run focused verification, review the diff, check the item
only after it passes, update the concise progress table, and create an
atomic local commit. Continue automatically unless genuinely blocked.

Spec 6 is a typed, explicit, owner-scoped signal exchange—not shared memory and
not a mother agent. Only reviewed bounded public signal projections may cross
workspace boundaries through separate default-deny promotion grants and
subscriptions. Never expose conversations, briefs, configuration, full
findings, private artifacts, portfolio/broker/order data, or a generic
cross-workspace read tool. Producer scores remain namespaced; the reference
consumer owns its convergence finding. Telegram and trading remain out of scope.
After every requirement passes, make final review and safe local merge into
`main` the last task, exactly as defined by the implementation protocol. Do not
push, open a PR, deploy, or mutate remote/production state without separate
authorization.

Begin now with orientation, dependency verification, a sprint-ordered plan, and
the first incomplete Sprint 0 checklist item. Continue until the complete spec
is verified or an external/product blocker truly requires my decision.
```
