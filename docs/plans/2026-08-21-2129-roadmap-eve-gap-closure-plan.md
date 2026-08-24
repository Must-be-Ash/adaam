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
- **What `BACKLOG.md` is for** (owner's rule, 2026-08-23). Wishlist features and
  extra hardening only — work that is genuinely optional for a first working
  version. **Nothing that should be addressed goes there.** A failing gate, a
  defect that consumes budget or loses data, a regression, or anything stopping
  a monitor from working is active work: it belongs in this roadmap or in the
  current unit's todo list. If a discovery is non-blocking *and* optional, file
  it; if it is non-blocking but real, it still needs an owner and a home. Filing
  a real problem as backlog hides it.
- **Shared plumbing is shared.** Five strategies use the same generic modules.
  Run `npm run verify:strategies` (38 per-strategy suites, ~90s) before and
  after any change to one, not just your own sprint's gates.
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
- **Owner-held access.** Never mint or engineer a Manage Sessions capability
  token or URL. Ask the owner; they will text Eve "manage sessions" and paste
  the URL. Do not add temporary Production endpoints or edit Redis directly.
- **Live unattended monitors.** `Inverse Cramer Live` and `IPO Live` are the
  owner's deliberately enabled background monitors. Do not archive, retire, or
  reconfigure them; pause only as the acceptance rules below require, and
  re-enable afterward.
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
- [x] Sprint 2 — U2: Public Commentary Tracker migration *(complete 2026-08-22, `main` @ `e35ae74`, receipt `U2 Tracker Acceptance 0822`)*
- [x] Sprint 3 — U3: Earnings Call Changes migration *(migration complete and landed 2026-08-23, `main` @ `3b63fd3`; strategy parked behind a disabled Production flag)*
- [x] Sprint 4 — U4: Congressional repair + migration *(complete 2026-08-23,
      `main` @ `899cba1`/`e3e9c36`; the one Production occurrence hit a
      genuine external transport failure rather than a clean terminal
      result — owner reviewed the receipt and accepted it in place of a
      second acceptance)*
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

**Blocker found and repaired during Sprint 2 (2026-08-22, `e6c3dc5`).** Commit
`aec122c` added research contract version `1.0.1` and taught the worker's
candidate selection to accept it, but left the gate that decides whether a pack
has an agentic research runtime pinned to `1.0.0`. `inverse-cramer@1.4.7` — the
pack bound to `Inverse Cramer Live` — declares `1.0.1`, so
`resolveInverseCramerResearchRuntime` returned `null` and the live monitor
skipped the executive brief and artifact entirely. The proof below could not
have passed as deployed. The gate and the candidate filter now share one
supported-version list, characterized across the 1.4.x lineage in
`scripts/verify-inverse-cramer-strategy-boundary.ts`, and the repair is live in
deployment `dpl_HzGpPuertindUerKyPXQoXqw77to`.

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

- Sprint 2 characterization, implementation, and local gates may proceed freely
  in the worktree while `Inverse Cramer Live` waits. None of that touches
  Production.
- **Pause `Inverse Cramer Live` before pushing any commentary change to
  `main`,** then land, deploy, verify health, and re-enable it. U2 edits the
  shared commentary worker and vertical that this monitor executes, and a push
  auto-deploys. U2's gates include the Inverse Cramer fixtures, but those gates
  passed repeatedly during U1 while this same subsystem failed in Production
  eight times, so they are necessary and not sufficient.
- **Never deploy while an occurrence is in flight.** A killed worker yields
  `worker_recovery_outcome_missing`, which pauses a monitor immediately rather
  than after five failures. Check `activeWorkers` and `nextOccurrenceAt` first.
- **One Production acceptance in flight at a time.** Pause both live monitors
  before arming a disposable acceptance workspace, then re-enable them after
  cleanup.
- Do not archive, reconfigure, or retire the live monitors for any other
  reason; they are the live proofs and are intentionally unarchived.
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

- [x] §U2 checklist complete in the migration plan (marked there).

Landed 2026-08-22. The four remaining `pack.id` branches in the shared
commentary vertical, the install-time pinned-identity rule, and the shared
explain tool's gate are now selected by declared contract, configuration kind,
and declared capability. `public-commentary-tracker@1.2.0` declares the
interpretation and monitor lifecycle contracts and resizes its per-run envelope
above the shared worker session's own limits. One zero-usage Production
occurrence terminalized green with a correct no-signal result over 30 real
White House statements, $0 paid, and was archived non-dispatchable.

Two pre-existing defects surfaced and were repaired along the way, both
recorded in the migration plan: the install-time X identity lookup could not be
funded from `Main` (`0990fa2`), and the manager route dropped the identity
receipt before the create service saw it (`e35ae74`). A third, found during U2
characterization, was blocking Sprint 1 rather than Sprint 2 — see below.

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

**Migration complete and landed; strategy parked (2026-08-23).** The U3
contract migration is on `main` @ `3b63fd3` and deployed
(`dpl_84qpebFTbMat2SaWzN5fLS6mNAWy`). All five confirmed generic branches are
gone: `workspace-monitor-store.ts` (empty-source eligibility, activation
watermark, and reviewed-source admission on both create and enable) and
`event-triggers.ts` (deferred source retry) now resolve the declared
`monitor.earnings-call-transcripts/v1` lifecycle contract, and
`explain_earnings_call_change` admits by declared capability. The monitor store
no longer imports the earnings issuer catalog at all. Issuer discovery,
source-family selection, and the transcript comparison contract are unchanged.
Local gates are green: `verify:earnings-call-changes:sprint-5` at 49 gates
including typecheck, `eve build`, and `next build`, plus the new
`:boundary` gate.

Two pack versions shipped. `1.1.0` declares the lifecycle and research
contracts and resizes the per-run envelope above the shared worker session's own
limits. `1.2.0` sizes the comparison session to hold a real transcript pair: a
reviewed JPM pair measures about 50,000 estimated input tokens against the
frozen policy envelope's 24,000, so every earlier version overflowed the planner
and abstained without analyzing anything. The policy envelope stays frozen
because its literals feed the comparison digests published packs declare; the
session size and planner limits are version-scoped instead, so `1.0.1` and
`1.1.0` keep exactly what they shipped with.

**The strategy is parked, not complete.** Two Production acceptances were
attempted and both failed for the same reason:
`EarningsCallWorkspaceWorkerError: earnings_call_execution_disabled`. Earnings
execution is disabled in Production, so the worker throws before doing any work.
This is a configuration gap, not a code defect, and it means Earnings Call
Changes has never executed in Production. Actual spend across both attempts was
10,962 input tokens, 2,654 output tokens, and $0.00 paid; every disposable
workspace was archived and left non-dispatchable. Full receipts and the flag
chain are in the migration plan under §U3.

Reviving the strategy needs a Production flag change the owner controls, then
one occurrence. Nothing in the code is known to be blocking.

`docs/plans/2026-08-22-earnings-hardening-spec.md` is **parked with this
strategy, not deleted.** Its defect 1 (long calls abstain) is what `1.2.0`
addresses for a single-job pair; its defects 2 and 3 (the hardcoded hedging
phrase list gating `alertEligible`, and coverage-unavailable issuers appearing
selectable) remain open and unaddressed.

## Sprint 4 — U4: Congressional repair + migration

Execute migration plan §U4 in full. First repair the recorded defect
(`docs/congressional-monitor-retry-defect.md`): a deterministic House
source-acquisition failure must terminalize the occurrence exactly once instead
of redispatching (observed 5× dispatch + repeated spend), while genuine
pre-outcome infrastructure interruptions keep bounded recovery. Prove the
repair red-first, add the retry verifier to `package.json`, then migrate the
strategy onto contract-driven plumbing and run one zero-usage Production
acceptance.

- [x] Retry-defect repair green before migration begins (marked in the plan,
      2026-08-23, `main@14c7626`).
- [x] §U4 checklist complete in the migration plan (marked there,
      2026-08-23). Contract migration, local gates, deploy, and cleanup are
      done (`main@899cba1`/`e3e9c36`). The one Production occurrence
      terminalized via a genuine live House-endpoint transport failure rather
      than a clean committed outcome; it was not retried, and the owner
      reviewed and accepted the receipt in place of a second acceptance.

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

**Owner-directed unit landed 2026-08-22, ahead of this sprint.** The Public
Commentary Tracker decided relevance by literal substring matching in
`classifyPublicCommentaryImpact` before the model ever saw a statement, and
attributed every match to a hard-coded hypothesis asset. That is the same defect
U1 fixed for Inverse Cramer with direct-model actionability. Four commits:

- `bbfcc83` — `public-commentary-tracker@1.3.0` declares
  `public-commentary-impact-actionability`, a compact strategy-owned contract at
  low reasoning. The model reads every statement, decides materiality, names the
  market the statement is about, and returns the implied direction.
  `monitoringObjective`, `topics`, and `impactHypotheses` travel to it as signed
  `semanticContext` guidance instead of acting as a matcher; `selectedSymbols`
  stays a deterministic post-hoc alert filter and the registered
  preserve-direction policy is unchanged. Selection is by declared evaluation
  contract, never a pack identifier. Versions 1.0.0–1.2.0 keep the deterministic
  path they shipped with. Also sizes paid ceilings from the sources a
  configuration actually resolves, since the tracker declares a first-party feed
  but resolves to a paid X timeline whenever the sensitive-event gate does not
  divert it.
- `bce7215` — a run's paid envelope must cover the monitor's source read. It was
  derived only from a declared research contract, so a strategy with a paid
  source and no research lane got a parent ceiling of zero and its first
  timeline read terminalized the occurrence as `budget_exhausted`.
- `fbf7bf0` — the worker model policy capped sessions at 12,000 output tokens
  while the workspace worker agent declares 16,000 for itself, making the
  agent's own limit unreachable. A real inconsistency, though not the cause of
  the failure it was first attributed to.
- `1f3f9be` — `public-commentary-tracker@1.3.1` pins classification contract
  `1.0.1`, which declares no paid allowance. The `1.0.0` contract reserved
  $0.25 per attempt for a call it has no tool surface to make — no research
  lane, `maximumPages: 0`, `maximumRows: 0` — and the source read consumed the
  envelope first, so every classification after it was refused. Proven at the
  ledger: with a $1.00 envelope and the timeline read taken, a four-statement
  fan-out commits zero classifications at the old ceiling and all four at the
  new one. A zero ceiling is stricter, not looser: reconciliation refuses any
  actual paid cost above a reservation.

`Tracker Live` (`public-commentary-tracker@1.3.1`, KobeissiLetter numeric ID
3316376038) is enabled and unarchived on a six-hour cadence alongside
`Inverse Cramer Live` and `IPO Live`. Its first committing occurrence classified
four statements and persisted a finding on a post naming Visa, Berkshire,
Mastercard and Cintas — carrying none of the configured topics or hypothesis
phrases, which is precisely what the keyword matcher would have discarded
unseen.

**Alert delivery repair, `main` @ `9aa0ee0`, deployed
`dpl_2J9cZaRva2GS5W2HrhooSzuFajW2`.** That occurrence committed and no iMessage
arrived, which exposed two independent defects in the alert path:

- The worker commits its outcome inside its own tool, before the schedule tick
  sees the end of the session. `agent/schedules/event-triggers.ts` threw on a
  terminal session failure directly above the delivery call, so a session that
  failed after committing — including one the harness had already retried after
  an empty model response — cost the owner the alert for a finding that was
  already durable. Delivery is now attempted for a committed outcome first, and
  the session failure surfaces afterwards with its existing code.
- A managed monitor names the delivery subscription its alerts route through,
  but naming one never created it: `savePhotonAlertDeliverySubscription` was
  reachable only from the two interactive monitor tools. Pack installs now
  ensure the record, failing closed with an explicit message. Latent on this
  deployment, where the conversation-level subscription already existed, and
  total on a fresh fork where no pack-installed monitor could ever alert.

Both proven red-first. Note for Sprint 8: the alert path had no end-to-end
coverage, which is how both survived.

**Cost and failure-integrity unit, 2026-08-23, `main` @ `481a926`, deployed
`dpl_HcqNbrvvSPgaDf3tmDobnLhZ13cV`.** Tracker Live failed every occurrence and
could not be diagnosed, because nothing recorded what threw: the bounded runtime
observation carries a counter and a fixed code, so any unrecognized error
collapsed to `evaluation_failed`, and Vercel's retained window rolled before it
could be caught by hand.

- `0999238` - log a bounded failure summary beside the observation; distinguish
  `workspace_alert_delivery_failed` from a session failure, which delivery
  running inside the same try had made indistinguishable; and name
  `evaluate_public_commentary_signals` in the worker instructions, which listed
  the IPO, Congressional and Earnings evaluators but never the commentary one,
  so that worker was never told its evaluator is the single completion path.
- `95b970e` - never issue an unbounded timeline read. The request builder could
  emit one with neither `start_time` nor `since_id` when a pack asks for no
  backfill and the cursor has never advanced, which answers with the newest page
  of the whole timeline: one poll billed 102 posts for a 12-hour window holding a
  handful, and failures compounded it because an occurrence that dies before
  committing leaves the cursor unadvanced. The bound is request-only and
  deliberately carries no semantics - an earlier attempt threaded it through
  `firstRunStartAt` and silently broke baseline establishment, which would have
  left the cursor never anchoring and every occurrence re-acquiring forever.
- `44cc54f` - `inverse-cramer-market-view-actionability@1.0.1` declares no paid
  ceiling and `inverse-cramer@1.4.8` pins it. The job has no paid tool surface,
  so its $0.25 reservation competed with the timeline read for one envelope.
- `481a926` - a session that fails having committed nothing reports the missing
  outcome rather than a generic failure. The stated reason this was deferred,
  that the accurate code drags a monitor into immediate auto-pause, did not
  hold: the threshold of one is passed explicitly by the recovery quarantine and
  is not attached to the code. Pause semantics are now pinned in tests.

First occurrences after recreation: Inverse Cramer $0.51 -> $0.01 (reserved
$3.50), Tracker Live $0.77 -> $0.005 (reserved $1.00), both `lastErrorCode:
null`. A tool-call/loop cap was considered and deliberately not built: these
jobs are single-shot with a runtime cap, runaway protection already exists at
three layers, and the limits schema is digest-covered so adding a field would
re-version every contract and every pack that pins one.

**Congressional arming blocked by a Vercel->House egress block, 2026-08-24
(fleet transport & attribution unit).** Two acceptance occurrences
(`Congressional Testing`, `Congressional Test 2`) both failed at the House
transport stage: `evaluate_congressional_signals` -> `congressional_source_unavailable`
<- House acquisition `transport:failed:acquisition_uncertain`, a fetch exception
(not an HTTP status), watermark never advancing. Diagnosis (store + logs + local
probes, all read-only):

- SEC (IPO) and X (Cramer/Tracker) fetch fine from Vercel in the same window;
  only `disclosures-clerk.house.gov` fails, and only since ~2026-08-23 20:07 (it
  returned a `complete` acquisition on 2026-08-22 19:32).
- The House URL returns HTTP 200 (56 KB) to every User-Agent from a residential
  IP. Deploying a WAF-friendly `Mozilla/5.0 (compatible; ...)` UA (`5b819ec`)
  changed nothing on the second occurrence.
- So it is a House-side block/throttle of Vercel's datacenter egress IPs, not a
  header/code issue. Item 2's retryable classification does not apply - it covers
  HTTP 429/5xx statuses, not fetch exceptions.

Both occurrences failed at transport before any inference, so ~$0 actual each.
Congressional stays archived, blocked upstream (owner chose defer, 2026-08-24).
Getting it running needs one of: a proxy through a non-datacenter IP (new standing
dependency), the reviewed third-party congressional-data API adapter (changes
provenance from "House Clerk" to an aggregator; owner deferred it), or waiting out
the block. Owner decision required before spending more.

Diagnosability follow-up: the House exception path's fetch cause (undici
`.cause.code`) never reaches a retrievable place on the live congressional path -
`coordinatePublicSourceOccurrence` does not surface it, and a631998 fixed only the
HTTP-status path. `5b819ec` enriches the House adapter's exception detail with the
errno, but it must be logged or made durable on the coordination path to help the
next such failure describe itself.

- [x] **Blocker: the session registry is full** (48/48 retained records,
  2026-08-22) and nothing can be created. Archived sessions are retained
  forever and there is no delete path, so U1's disposable acceptance
  workspaces exhausted it. Add owner-authorized hard deletion of archived
  sessions (see `BACKLOG.md`) before this sprint, and expect Sprints 3–5 to
  consume more records. Restoring and renaming an archived session does not
  help when the pack pins an immutable field: `xIdentity` is
  `mutableAfterInstall: false`, so a tracker cannot be repointed at a
  different account.
  **Cleared 2026-08-22, `main` @ `20230b3`.** Owner-authorized deletion of
  archived sessions landed on the manager action surface and in the session
  manager UI: archived only, never the selected session, never the last
  record, behind the same owner check, approval guard, and single-use request
  claim as every other manager mutation. It removes the registry record, the
  brief, capability manifest, and strategy binding, and the monitor records and
  index; the monitor purge refuses while anything could still dispatch, and the
  route proves the target is archived before purging. The workspace budget
  policy and ledger are retained for financial audit. 28 disposable acceptance
  workspaces were deleted, taking the registry from 48/48 to 20/48.
- [x] Owner reviews per-strategy budgets using each acceptance's
  reserved-vs-actual numbers; set the real ceilings.
  **Done 2026-08-23.** Two defects had to be fixed before this was possible at
  all. The paid ceilings were set once at install and no owner surface could
  change them - the budget editor only ever wrote concurrency and runs per day
  (`f1409f5` exposes the daily and monthly ceilings, refusing a month below its
  own day). And the defaults contradicted themselves: $10 a month is $0.33 a day
  averaged against a $2 a day cap, so the month cap was the real limit and would
  have starved a monitor long before the day cap bound (`2d6ab5b` raises
  paid-source defaults to $10 a day and $50 a month, asserted as relationships
  rather than magic numbers). The per-call ceiling stays unexposed: it bounds one
  provider call rather than the agent's spend, is already sized to one worst-case
  poll, and a refused reservation never bills - lowering it costs results, not
  money.
- [ ] Enable Exa-backed research for background monitors in Production
  (owner decision 2026-08-21: enable at activation), staged in dependency
  order; verify one bounded research pass reconciles actual paid cost inside
  the workspace envelope.
- [ ] Arm the real monitors: IPO (already enabled and healthy), Inverse Cramer
  Live (already armed), an owner-configured Public Commentary Tracker
  instance, Earnings with owner-selected issuers, Congressional (post-Sprint
  4). Each with alerts enabled and its normal cadence.
  **Three of five armed 2026-08-23**, all recreated on corrected packs with the
  owner's authorization to lose their checkpoints: `Inverse Cramer Live`
  (`inverse-cramer@1.4.8`, 12-hour cadence), `IPO Live` (`ipo-filings@1.1.2`,
  00/06/12/18 America/Vancouver) and `Tracker Live`
  (`public-commentary-tracker@1.3.1`, KobeissiLetter, 6-hour cadence) - the
  owner-configured tracker instance this item asks for. Alerts enabled on both
  commentary monitors, and both re-baselined cleanly with `lastErrorCode: null`.
  Earnings and Congressional remain unarmed.
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
  (recorded 2026-08-21 during U1). Diagnosed 2026-08-23 (fleet transport &
  attribution unit): two layers. (1) It injected no `alertDeliverySubscription`,
  so managed-workspace creation hit the KV-backed `store()` and threw
  `photon_alert_subscription_unavailable` — **fixed** there (in-memory recorder +
  a seam assertion that creation ensures the monitor's delivery subscription).
  (2) The test installs the historical non-research `ipo-filings@1.0.0`, but the
  worker now requires a research pack for any `ipo-filings` monitor
  (`resolveSecIpoResearchRuntime` throws `sec_ipo_monitor_invalid`). Owner
  confirmed **research-only** (2026-08-23; see `GOAL.md`), so the fix is not a
  product question but a harness rebuild: a research pack also requires model
  routing config and `publicSourcePath === "public_source_adapter"` (worker
  ~line 569), so the injected `fetchSource` must become a full public-source
  adapter + research-session harness. That duplicates the **passing** dedicated
  `sec-ipo` suites and overlaps the signal-quality/research unit — deferred here
  deliberately. Two clean paths: (A) build the research-acceptance harness, or
  (B) re-scope this framework test to a fixture worker and let the `sec-ipo`
  suites own real worker execution.
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
