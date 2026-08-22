---
title: Eve Gap Closure Roadmap
type: roadmap
date: 2026-08-21
execution: code
---

# Eve Gap Closure Roadmap

Everything left to reach the owner's stated end state (`GOAL.md`): many isolated
strategy agents on shared plumbing, running in parallel in Production, alerting
via iMessage without cross-context pollution, researching autonomously within
their total budget envelope, and remembering their durable task across Start
fresh. This roadmap adds no new strategies, no new channels, no push/webhook
ingress, and no autonomous trading.

Verified baseline (2026-08-21, `main` @ `35faf0b`): the platform largely exists
and is production-accepted — isolated workspace runtimes, versioned packs,
shared SEC/House/earnings/X/official-web adapters, deterministic → cheap-model →
frontier routing, nested budgets covering model + paid-tool spend, findings and
alerts with Discuss, and the bounded research lane (Exa + document fetch,
replay-safe receipts, executive briefs, artifacts) shipped for IPO and Inverse
Cramer. What remains is the tail of the strategy migrations, durable Start
Fresh continuity, fleet activation, and one end-of-line regression/E2E pass.

## Ground rules for the implementing agent

- **Authorities.** `GOAL.md` is the product target. **The code is the only
  source of truth for how the system currently behaves** — verify every
  behavioral claim against it. Sprints 1–5 execute the remaining units of
  `docs/plans/2026-08-20-2017-refactor-strategy-application-boundary-migrations-plan.md`
  ("the migration plan"), which stays the detailed authority for those units;
  do not duplicate its content here and never delete or rewrite its recorded
  done-markers or receipts.
- **One thing at a time.** One sprint at a time; within a sprint one step at a
  time; check each box (with commit/receipt) before the next. Only one
  Production acceptance may be in flight at any moment.
- **Smallest change.** Reuse existing plumbing. No new architecture, registries,
  frameworks, or memory systems. Strategy behavior stays strategy-owned; generic
  plumbing selects behavior via declared contracts, never pack-ID branches (pack
  IDs remain valid as provenance/registry/binding identity).
- **No mid-flight hardening.** Per-sprint verification is focused: that sprint's
  gates, directly changed shared contracts, typecheck, Eve build, app build.
  The full battery and the end-to-end pass happen once, in Sprint 8, when code
  churn is over. Non-blocking discoveries go to `BACKLOG.md`, not into scope.
- **Production is a test bed.** No users in prod. Push to `main` auto-deploys
  Production on Vercel. Prefer one real bounded Production acceptance over
  local workarounds. Vercel CLI is available for logs/observability; GitHub CLI
  for repo operations.
- **Acceptance discipline** (applies to every sprint's Production proof, same as
  the migration plan): fresh zero-usage disposable workspace, one occurrence,
  stop on first terminal result, pause/archive with `nextOccurrenceAt: null`,
  record the receipt. A failed first occurrence stops the unit — record the
  first failing stage, make one focused repair, use the next natural
  occurrence; never retry the same occurrence.
- **Cost honesty.** Always report reserved budget separately from actual spend.
- **Worktrees.** At most two at all times: `main` plus one active implementation
  worktree; remove the implementation worktree after landing.
- **Non-negotiable invariants.** Absolute workspace isolation (no instructions,
  configuration, findings, alerts, budget, or history across workspaces);
  background alerts never become an inbound turn in Main or any other
  workspace; monitor research authority is never trading authority;
  approval-gated Coinbase behavior unchanged.
- **Finish clean.** Defer-not-ignore items go to `BACKLOG.md`. The last sprint
  updates `HANDOFF.md` as a TLDR of current state (not a progress report),
  merges everything to `main`, and leaves no test monitors, temporary routes,
  secrets, or stray worktrees behind.

## Progress tracker

- [ ] Sprint 1 — Close U1: Inverse Cramer live alert proof *(no code work left;
      waiting on a live Cramer statement — does not block Sprints 2–5)*
- [ ] Sprint 2 — U2: Public Commentary Tracker migration *(start here)*
- [ ] Sprint 3 — U3: Earnings Call Changes migration
- [ ] Sprint 4 — U4: Congressional repair + migration
- [ ] Sprint 5 — U5: Final boundary and isolation audit
- [ ] Sprint 6 — Durable Start Fresh continuity
- [ ] Sprint 7 — Fleet activation
- [ ] Sprint 8 — Regression close-out and end-to-end proof
- [ ] Sprint 9 — Docs, cleanup, and final merge

## Sprint 1 — Close U1: Inverse Cramer live alert proof

**Status: U1 implementation is complete. No code work remains in this sprint.**

Authority: migration plan §U1. Every U1 repair is written, verified, committed,
and deployed to Production (through commit `996de7d`; deployment
`dpl_7L8qD64uMnRC7uaoGQidaSVFozWm`). The migration, the citation/fan-out/
pack-identity/research-sizing/replay/alert-bound repairs, and the
multi-statement session sizing all landed and passed their gates. Two
Production occurrences terminalized cleanly, and one real iMessage alert with a
working Discuss control was delivered and confirmed by owner screenshot.

The single open item is **observational, not implementation**: one occurrence
must fire whose window contains a genuinely material Jim Cramer statement, so
the delivered alert can be checked for the executive brief and artifact
reference (the earlier delivered alert predates the `5252611` alert-bound
repair and carried the raw finding-identifier fallback). Workspace
`Inverse Cramer Live` (`inverse-cramer@1.4.7`, monitor
`4a699d5a-b726-5d96-83b0-79cff0ce640c`) is armed and enabled on its normal
12-hour cadence, deliberately left unarchived, waiting for that statement.
Cramer's posting cadence, not Eve, is the constraint — this can take days.

- [ ] When a material statement occurs, confirm the delivered iMessage alert
  carries the executive brief and artifact reference (not the raw
  finding-identifier fallback) and that Discuss routes to the producing
  workspace.
- [ ] If the occurrence instead exposes a defect: record it, make one focused
  repair per the migration plan's stop conditions, and wait for the next
  natural occurrence.
- [ ] Reconcile the U1 checklist in the migration plan: the earlier unchecked
  "one fresh zero-usage Production occurrence terminal" box under the focused
  correction is already satisfied by the `Inverse Cramer U1 Green 0822` and
  `Inverse Cramer U1 Brief 0822` receipts — check it with a pointer note.
  Never delete or rewrite existing entries.
- [ ] Mark U1 and its Progress Tracker entry complete in the migration plan.

### Do not wait on this sprint — proceed to Sprint 2

Sequencing note: because the remaining U1 work is purely observational, Sprint 2
characterization and implementation may proceed in the worktree while this
window is open. Prefer landing Sprint 2 on `main` only after the U1 alert proof:
U2 touches shared commentary plumbing, and landing it would change the deployed
code under the live Cramer monitor before the proof fires. If Cramer stays quiet
for days and U2 is fully green locally, landing it anyway is acceptable — U2's
gates include the Inverse Cramer regression fixtures that guard the live path,
and the eventual alert then proves the combined deployment. Either way, Sprint
2's Production acceptance waits until U1 is closed (one acceptance in flight at
a time).

Because nothing here is implementation work, **Sprint 1 must not block the
roadmap.** Start at Sprint 2 and let the Cramer window
resolve on its own schedule in the background. Concretely:

- Sprint 2 characterization, implementation, local gates, commit, push, and
  Production deploy may all proceed while `Inverse Cramer Live` waits. U2's
  local gate set includes the Inverse Cramer regression fixtures
  (`verify:public-commentary-signals:*`, the strategy boundary corpus, the
  frozen real-source fixture), so a green U2 is direct evidence that the live
  Cramer path still behaves. Those gates are the guard that makes this safe.
- The one hard rule is **one Production acceptance in flight at a time.** Do
  not create or arm U2's disposable acceptance workspace while an unproven
  Cramer occurrence is pending. If the Cramer alert has not fired by the time
  U2 is deployed and ready for its acceptance, pause the `Inverse Cramer Live`
  monitor first, run and clean up the U2 acceptance, then re-enable it.
- Do not archive, reconfigure, or retire `Inverse Cramer Live` for any other
  reason; it is the live proof and is intentionally unarchived.
- When the alert fires — whatever sprint is then active — verify it, close U1
  in the migration plan, and tick Sprint 1 here. Closing U1 is a bookkeeping
  step that can land at any point; it is not a gate on Sprints 2–5.

## Sprint 2 — U2: Public Commentary Tracker migration

Execute migration plan §U2 in full (steps, gates, acceptance, cleanup live
there). Confirmed as of 2026-08-21: the remaining generic
`public-commentary-tracker` branches are in
`agent/lib/strategy-pack-service.ts` (~lines 1368, 1371); re-read current code
first. Reuse U1's monitor lifecycle and worker/evidence contracts without a
tracker-specific branch; the tracker keeps its own identity, sources,
thresholds, and abstention policy; own local corpus plus one zero-usage
Production acceptance (the Inverse Cramer receipt does not count for this
pack).

- [ ] §U2 checklist complete in the migration plan (marked there).

## Sprint 3 — U3: Earnings Call Changes migration

Execute migration plan §U3 in full. Confirmed as of 2026-08-21: remaining
generic `earnings-call-changes` branches are in
`agent/lib/workspace-monitor-store.ts` (~lines 288, 348, 946, 1240) and — not
listed in the plan's original inventory — `agent/schedules/event-triggers.ts`
(~line 150); include that site in the characterization. Preserve issuer
discovery, transcript comparison, correction, materiality, and citation policy;
adopt the shared research/executive-output contracts at the strategy-owned
materiality boundary; one zero-usage Production acceptance (a naturally
no-change live source is acceptable per the plan).

- [ ] §U3 checklist complete in the migration plan (marked there).

## Sprint 4 — U4: Congressional repair + migration

Execute migration plan §U4 in full. First repair the recorded defect
(`docs/congressional-monitor-retry-defect.md`): a deterministic House
source-acquisition failure must terminalize the occurrence exactly once instead
of redispatching (observed 5× dispatch + repeated spend), while genuine
pre-outcome infrastructure interruptions keep bounded recovery. Prove the
repair red-first, add the retry verifier to `package.json`, then migrate the
strategy onto contract-driven plumbing and run one zero-usage Production
acceptance.

- [ ] Retry-defect repair green before migration begins (marked in the plan).
- [ ] §U4 checklist complete in the migration plan (marked there).

## Sprint 5 — U5: Final boundary and isolation audit

Execute migration plan §U5 in full: classify every remaining occurrence of the
five pack IDs in generic modules (provenance/binding checks stay; behavioral
branches go), prove cross-pack composition through contracts, prove Main plus
multiple strategy workspaces hold contradictory instructions and separate
findings without leakage, verify all disposable acceptance state is
non-dispatchable. Read-only — no new paid Production occurrence.

- [ ] §U5 checklist complete in the migration plan (marked there).

## Sprint 6 — Durable Start Fresh continuity

The one remaining architecture phase. Requirements baseline: the migration
plan's "Deferred continuity completion contract" plus `specs/07` Sprint Group B
(design input). Verified current facts (2026-08-21): `startFreshPhotonWorkspace`
only bumps the generation and drops the session ID — durable records already
survive; interactive session start composes only the static pack
`workspaceInstruction` (`agent/instructions/strategy-pack.ts`), so a fresh
generation receives no durable-state summary; the `brief` workspace document
(`agent/lib/workspace-state-store.ts`, 32 KB bound) is written at pack
install/configure and read by workers, but interactive Eve has no same-turn
write path for explicit mission/watchlist/open-question changes.

- [ ] Characterize with focused red tests: a fresh generation receives no
  durable-state summary; an explicit "add NVDA to the watchlist" instruction
  is not persisted in the same turn (outside `configure_strategy_pack`).
- [ ] Define the supported explicit-change set, reusing existing stores only:
  pack configuration and declared watchlists (existing configure service),
  monitors/sources (existing monitor tools), budgets (existing tool), plus
  bounded free-text mission/thesis/open-questions in the existing `brief`
  document. No new storage system, no memory framework.
- [ ] Implement same-turn persistence: when the owner states a supported
  change, Eve persists it through the authenticated workspace services in that
  turn before claiming it will remember. Unsupported changes get an honest
  "I can't durably record that" — never fabricated memory.
- [ ] Compose a bounded rehydration summary into each new generation at
  session start: pack instruction + brief + configuration + a digest of
  monitor/finding/alert state. Bounded by existing instruction limits; never
  the old transcript; never another workspace's state.
- [ ] Prove Start fresh clears only old messages, temporary conversational
  context, and temporary reasoning; monitors, schedules, checkpoints,
  findings, alerts, pack binding, configuration, and budgets survive
  unchanged; approvals bound to the old generation are revoked.
- [ ] Isolation regression: no state from another workspace can enter the
  fresh generation.
- [ ] Focused gates green (workspace, strategy-pack, isolation suites;
  typecheck; Eve build; app build). Commit, push, deploy, Production health.
- [ ] One Production acceptance on a disposable workspace over real iMessage:
  state an explicit supported change, Start fresh, verify the new generation
  continues the mission and knows the change without the old transcript; then
  archive and verify non-dispatchable.

## Sprint 7 — Fleet activation

Turning the migrated platform into the running fleet — the owner's end-state
moment. Owner participates in the sign-offs.

- [ ] Owner reviews per-strategy budgets using each acceptance's
  reserved-vs-actual numbers; set the real ceilings.
- [ ] Enable Exa-backed research for background monitors in Production
  (owner decision 2026-08-21: enable at activation), staged in dependency
  order; verify one bounded research pass reconciles actual paid cost inside
  the workspace envelope.
- [ ] Arm the real monitors: IPO (already enabled and healthy), Inverse Cramer
  Live (already armed), an owner-configured Public Commentary Tracker
  instance, Earnings with owner-selected issuers, Congressional (post-Sprint
  4). Each with alerts enabled and its normal cadence.
- [ ] Archive superseded historical workspaces (e.g. the paused Inverse Cramer
  1.1/1.2/1.3 lineage) to free the 12-active-session cap. Archiving only —
  findings, alerts, and receipts are retained, never deleted.
- [ ] Live parallel proof: with Main selected and responsive, at least two
  different background strategies deliver labeled alerts with working Discuss;
  verify no alert entered Main's or another workspace's context and Discuss
  selects only the producing workspace.
- [ ] Soak for a few days of natural occurrences: watch bounded Vercel
  logs/observability and the budget ledgers; record reserved-vs-actual per
  strategy; owner signs off on steady-state cost.

## Sprint 8 — Regression close-out and end-to-end proof

No new features. Code should be churn-free before this sprint starts.

- [ ] Repair the pre-existing red gate: `verify:strategy-packs:acceptance`
  fails on unmodified `main` (recorded 2026-08-21 during U1).
- [ ] Triage the two failing Coinbase evals (`order-approval`, `order-denial`
  in `eval:coinbase`): determine stale eval vs. real approval-shape regression
  (financial path — release-relevant until proven eval-only; details in
  `BACKLOG.md` §7), then fix whichever it is.
- [ ] Run the full verification battery: all applicable `verify:*` suites
  (including the Redis-backed ones), `eval:coinbase`, typecheck, Eve build,
  Next production build, catalog generation, `git diff --check`. Fix only
  regressions it exposes.
- [ ] One bounded real-channel E2E checklist over iMessage, recorded step by
  step: session create/switch/rename; Start fresh + rehydration; a background
  alert → Discuss → bounded next turn; approval Approve and Deny on a
  preview-bound spot order; artifact delivery as a card.
- [ ] Anything non-blocking discovered goes to `BACKLOG.md`, not into this
  sprint.

## Sprint 9 — Docs, cleanup, and final merge

- [ ] Verify clean end state: only the `main` worktree remains; no disposable
  or test monitor is dispatchable; no temporary routes, acceptance secrets, or
  test state anywhere; Production healthy on the final `main` commit.
- [ ] Update `BACKLOG.md` with the deliberate deferrals: push/webhook source
  ingress (deferred 2026-08-21); owner-private artifacts and paid-result
  retention; Telegram/HTTP workspace broker; topic-change mini-app card;
  Spec 5 Insider Clusters and Spec 6 shared signal plane; the future
  autonomous-trading spec — including the Coinbase mutation-surface scoping
  decision (owner explicitly retains the wide tool surface for future
  autopilot trading; scheduled workers remain fully denied Coinbase today);
  the undiagnosed `public_source_correction_total` re-acquisition observation;
  remaining crash-only hardening items.
- [ ] Rewrite `HANDOFF.md` as a TLDR snapshot of the current system (it is
  stale at 2026-08-19). State model, not progress report.
- [ ] Update `docs/plans/done.md` and this file's Progress tracker; commit,
  push, verify Production health one final time.

## Definition of done

- All five catalog strategies run on contract-driven shared plumbing with
  per-strategy Production receipts; generic modules contain no pack-ID
  behavior branches (provenance/binding checks remain).
- Multiple background strategies run in parallel in Production, alert to
  iMessage with Discuss, and never pollute Main's or each other's context.
- Background research uses tools and web search autonomously inside each
  workspace's total budget envelope; reserved vs. actual spend is visible.
- Explicit owner changes persist in the same turn; Start fresh preserves the
  mission and operational state and rehydrates a bounded summary — never the
  old transcript, never another workspace's state.
- Full regression battery green; one recorded real-channel E2E pass;
  `HANDOFF.md` current; every deferral recorded in `BACKLOG.md`.

## Explicitly out of scope

New strategies (House PTR coverage via `congressional-signals` already exists;
"Pelosi copy-trade" style packs come later), new channels (Telegram, HTTP,
web), push/webhook/RSS event ingress, autonomous or auto-pilot trading and any
Coinbase protocol change, owner-private artifact storage, new connectors or
provider integrations, cross-workspace signal sharing (Spec 6), memory
frameworks, and session-manager redesign.
