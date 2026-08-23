# Focused unit — finish the transport story and arm the full fleet

You are taking on **one focused unit**, not a roadmap sprint. Do not start
Sprint 5, 6, 8, or 9. Sprint 4 (U4 Congressional) is closed and accepted, and a
follow-up diagnosability pass has already landed. This unit finishes what those
left open.

Repository: `/Users/ashnouruzi/dev/adaam`

## Todo list

1. Repair the three red verifier gates (two are wrongly filed in `BACKLOG.md`).
2. Release orphaned budget reservations that permanently consume paid headroom.
3. Decide whether a determinate HTTP status should still classify as
   `acquisition_uncertain`, and act on the answer.
4. Capture the actual status code from the next real acquisition failure.
5. Decide how `verify:strategies` is enforced, and record the rule.
6. Get Congressional to one successful committing occurrence, then arm it.
7. Get Earnings (U3) to one successful committing occurrence, then arm it.
8. Confirm the three already-armed monitors are still healthy.
9. Archive the leftover acceptance workspace and the three stale ones.

Work them in order. One at a time; finish and verify each before the next.

## Read first, in this order

1. **`GOAL.md`** — the owner's product target. Read it before planning any
   change; understand what they are building toward before acting.
2. **`AGENTS.md`** — project instructions; they override default behavior.
3. **`docs/workspace-runtime-pitfalls.md`** — failure modes that have already
   cost this project real money and debugging time. The "Cross-strategy
   safety" and "Attributing a failure to a strategy" sections bear directly on
   this unit.
4. **`docs/plans/2026-08-21-2129-roadmap-eve-gap-closure-plan.md`** — read
   "Ground rules for the implementing agent" in full; it is binding. Sprint 7
   ("Fleet activation") is the home of the arming work.

**The code is the only source of truth for how the system currently behaves.**
`HANDOFF.md` is stale; do not plan from it.

## Verified starting state (checked 2026-08-23, `main` @ `c9f4e9d`)

**No regressions.** All 38 per-strategy suites were run individually against
the U4 follow-up work: **37 pass**. The single failure,
`verify:workspace-runtime:sec-ipo-scheduled-compiled`, is a pre-existing red
gate (unhandled fetch rejection on `fixture.invalid`) recorded in `BACKLOG.md`
*before* that work — not caused by it. Typecheck clean, `npm run build` clean.
Production is deployed and on latest `main`. **Do not re-litigate this**; it has
been checked.

Already landed, do not redo:
- `a631998` — `fetchOfficialPublicSourceBytes` threw a bare `Error` with the
  HTTP status interpolated into a sentence, so every caller's status-checking
  branch was unreachable and the status was destroyed. It now throws a typed
  `PublicSourceHttpStatusError` carrying `status` as a field.
- `2601607` — the X adapter distinguishes an HTTP status from a thrown
  exception, bounded to a safe charset. This covers the Tracker.
- `0ceeafa` — occurrence-failure logs carry `packId` beside `monitorId`; the
  previously silent recovery path emits the same bounded summary; and
  `npm run verify:strategies` runs all 38 suites in ~90s.

## 1. Repair the red gates

Three verifier suites are red on unmodified `main`. All three are active work,
not backlog: a gate nobody can run proves nothing, and while
`verify:workspace-runtime:sec-ipo-scheduled-compiled` is red the whole
`verify:strategies` aggregate can never pass, which makes the cross-strategy
guard worth less than it looks.

- **`verify:workspace-runtime:sec-ipo-scheduled-compiled`** —
  `TypeError: fetch failed` / `getaddrinfo ENOTFOUND fixture.invalid`. The
  fixture expects an unresolvable host to fail closed locally, but the check
  reaches real DNS and the rejection is never caught, so the process aborts
  instead of the assertion reporting. Decide whether it needs an injected fetch
  or a network-free host assertion.
- **`verify:agentic-durable-research:u4`** — asserts the latest `ipo-filings`
  version is `1.1.1`, but `44d83c6` published `1.1.2` without updating it.
  Decide whether the assertion should track the latest version or pin the
  version the U4 receipt covered.
- **`verify:strategy-packs:acceptance`** — recorded red since 2026-08-21 and
  already owned by Sprint 8's "repair the pre-existing red gate" item. Fix it
  here if it is cheap; otherwise leave it to Sprint 8 and say so.

The first two are recorded in `BACKLOG.md` §7. **Remove them from that file as
you fix them** — by the owner's rule below they never belonged there.

Do not silence a gate, and do not exclude one from the aggregate.

## 2. Release orphaned budget reservations

A parent run reservation whose paid figure is never reconciled keeps counting
its **reserved** amount against the workspace's day and month, forever.

`workspace-budget-ledger.ts:240` returns
`reconciledPaidMicros ?? paidMicros` — so when nothing set the reconciled
figure, the full reservation is what the ceiling sees. A run that completes
records paid child attempts and resolves to actual; a run that fails before
recording any does not, and `finishWorkspaceBudget` is called from
`event-triggers.ts` with actual token counts but **no `actualPaidCost`**.
`prune()` then keeps `reserved` and `uncertain` records regardless of calendar
month, and `reconcileWorkspaceRunBudget` only accepts a caller still holding the
run ID — which a dead worker does not.

Observed 2026-08-22/23: failed occurrences showed `$1.00` against the day while
actual spend was about `$0.02`; successful ones showed the true `$0.025`. Each
failure permanently consumes paid headroom. That was tolerable when every
workspace was disposable, but the three live monitors are long-lived and
accumulate them, so a monitor can eventually be starved of budget having spent
almost nothing.

Give an unreconciled reservation a bounded lifetime, or a sweep that releases it
once its occurrence can no longer complete — without ever releasing one a live
run still holds. Prove both directions. Note this is **not** the same as the
budget work already landed (`2d6ab5b` defaults, `f1409f5` owner-settable
ceilings, `1f3f9be`/`44cc54f` phantom classification ceilings); none of those
release a stale reservation.

## 3. Determinate status vs `acquisition_uncertain`

`a631998`'s own comment states the case plainly: *"A non-2xx response is a
determinate fact — the exact status code — not an ambiguous transport
condition."* But the code still maps it to `acquisition_uncertain` /
`"uncertain"`. Only the diagnostics changed; the classification did not.

That matters because an uncertain acquisition cannot be safely retried, so it
terminalizes the occurrence — and a failed occurrence can still leave the
source cursor advanced, permanently consuming the window. A determinate 503 or
429 may deserve different handling from a genuinely ambiguous transport state.

Decide this deliberately and prove it red-first. **It is a legitimate outcome
to conclude the current behavior is correct** — uncertain-by-default is
safe-by-default — but say why in the code, not just in a commit message. If you
do change it, `verify:strategies` before and after: the acquisition layer is
shared by all five strategies.

## 4. Capture the actual status

The status code for both original failures is unrecoverable — it was destroyed
before the fix and the log window has rolled. Nothing to recover; do not spend
occurrences hunting it.

What is needed: when the next acquisition failure happens, confirm the log
actually carries the number, and record it. Prefer the durable health records
over `vercel logs` (bounded window; `--json` duplicates rows; bare
`vercel logs <url> --json` only tails forward — use `--since`/`--until`).

Note for context: the X failure and the House failure landed about an hour
apart while SEC succeeded cleanly in between on the same infrastructure. That
argues against a broad platform outage and toward two independent upstream
hiccups. Treat it as the current best reading, not as settled.

## 5. Cross-strategy guard

`npm run verify:strategies` exists. Decide whether it belongs in `prebuild` or
stays an explicit gate — it costs ~90s per build — and record the decision plus
the rule ("touch a shared module, run it") where the next agent will find it.

Watch for **strategy-shaped asymmetry**: where one vertical passes an optional
argument and the others do not, that branch is untested by four-fifths of the
suite. That is exactly where the alert-keying defect lived, undetected for
months, while another strategy using the same code worked perfectly.

## 6-8. Arm the fleet

The owner wants every background agent running so they receive real texts.

Currently armed and healthy: `Inverse Cramer Live`, `IPO Live`, `Tracker Live`.
Confirm each is still enabled; re-arm any that a failed run has paused.
**Do not otherwise reconfigure or archive them.**

**Neither Congressional nor Earnings has ever completed an occurrence** — every
acceptance workspace for both shows `lastCompletedAt: null`. U4's acceptance
proved the retry repair, which was its actual deliverable; it did not prove
Congressional can acquire, classify, commit, and alert. Get each to one
successful committing occurrence, then arm it with alerts enabled.

Earnings is gated behind `EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED` and
`EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED` — **confirm flag state with the
owner before enabling anything in Production.**

Cadence discipline: hours, not minutes. Six or twelve hours is right.

## 9. Cleanup

`Congressional U4 Acceptance 2` is non-dispatchable but not archived — the
previous agent's Manage Sessions token expired mid-investigation. Archive it.

These three hold active-registry slots and can also be archived (Sprint 7 has
the item): `Inverse Cramer 1.3.0 retrying`, `IPO Overnight Test`,
`Congressional Overnight Test`. Archive only — findings, alerts, and receipts
are retained, never deleted.

## Standing rules you must not break

- **Never mint, forge, derive, or engineer a Manage Sessions capability token
  or URL.** Stop and ask the owner; they will text Eve "manage sessions" and
  paste the URL back. Tokens expire mid-task — when yours does, ask for a new
  one. Do not work around this by reading secrets, signing your own capability,
  or adding a temporary route.
- **This repository is public.** Never write a token into a file, commit, log,
  or command that gets recorded.
- Do not add temporary Production endpoints or write to Redis directly.
  Read-only store queries for diagnosis are fine and encouraged.
- **Non-negotiable invariants:** absolute workspace isolation; background
  alerts never become an inbound turn in Main or another workspace; monitor
  research authority is never trading authority; approval-gated Coinbase
  behavior unchanged.
- **Do not weaken the observability privacy design.**
  `workspaceRuntimeObservationSchema` is `.strict()` and
  `verify:workspace-runtime:observability` asserts owner, workspace, monitor,
  conversation, alert, prompt, credential, and provider values never reach an
  observation. Attribution belongs in the bounded `console.error` summary,
  where a pack id is acceptable as registry identity. Never log a credentialed
  URL or raw upstream response text.
- Never attempt a git history rewrite. Never deploy while an occurrence is in
  flight. Deploys are manual (`vercel deploy --prod --yes`; the webhook is
  unreliable) — confirm the alias with `vercel inspect` afterward.
- Only one Production acceptance in flight at a time. A failed first occurrence
  stops that unit: record the first failing stage, make one focused repair, use
  the next natural occurrence, never retry the same one.
- Always report reserved budget separately from actual spend.
- Roadmap and migration-plan receipts are append-only.

## Two habits learned expensively here

- **Do not spend a paid Production occurrence to test a hypothesis formed by
  reading code.** Make the failure describe itself in durable state, then run
  once and read the fact.
- **Re-read the durable record before believing a monitor is armed.** Resuming
  a paused monitor reuses its old interval anchor and can silently advance the
  schedule a full cadence. Assert `nextOccurrenceAt > now`.

## Not yours

- The commentary classifier's `maximumInputTokens: 24_000`, too small for a
  large first-run backfill. Real and owned, not backlog — it is recorded for the
  commentary follow-up unit.
- The tracker's missing research lane and the hardcoded
  `packId !== "inverse-cramer"` gate in
  `agent/lib/public-commentary-workspace-worker.ts`.

## What `BACKLOG.md` is for

Owner's rule, 2026-08-23: **wishlist features and extra hardening only** — work
genuinely optional for a first working version. **Nothing that should be
addressed goes there.** A failing gate, a defect that consumes budget or loses
data, a regression, or anything stopping a monitor from working is active work
and belongs in the roadmap or in this todo list. Two items in this unit
(the red gate, the orphaned reservations) were wrongly filed as backlog and
have been moved back out. If you find something real, give it an owner and a
home — do not park it.

## Finish clean

Report what you completed, what you deferred and why, reserved-versus-actual
spend, and the final armed state of every background monitor. Leave no test
monitor dispatchable, no temporary routes, no stray worktrees.
