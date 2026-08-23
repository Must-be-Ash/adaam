# Focused unit — transport root cause, per-strategy attribution, and a fully armed fleet

You are taking on **one focused unit**, not a roadmap sprint. Do not start
Sprint 5, 6, 8, or 9. Sprint 4 (U4 Congressional) is closed and accepted; this
unit follows up on what that acceptance did *not* prove and finishes arming the
owner's background fleet.

Repository: `/Users/ashnouruzi/dev/adaam`

## Read first, in this order, before touching anything

1. **`GOAL.md`** — the owner's product target. Read it before planning any
   change; understand what they are building toward before acting.
2. **`AGENTS.md`** — project instructions; they override default behavior.
3. **`docs/workspace-runtime-pitfalls.md`** — failure modes that have already
   cost this project real money and debugging time, including the
   "Cross-strategy safety" and "Attributing a failure to a strategy" sections
   that bear directly on this unit.
4. **`docs/plans/2026-08-21-2129-roadmap-eve-gap-closure-plan.md`** — read the
   "Ground rules for the implementing agent" section in full; it is binding.
   Sprint 7 ("Fleet activation") is the home of the arming work below.
5. The U4 acceptance receipt in
   `docs/plans/2026-08-20-2017-refactor-strategy-application-boundary-migrations-plan.md`.

**The code is the only source of truth for how the system currently behaves.**
`HANDOFF.md` is stale; do not plan from it.

## The situation, stated precisely

Three background monitors are armed and healthy: `Inverse Cramer Live`,
`IPO Live`, `Tracker Live`. **Earnings (U3) and Congressional (U4) are not
armed, and neither has ever completed an occurrence.** Every acceptance
workspace for both shows `lastCompletedAt: null`:

- `Congressional U4 Acceptance` — the occurrence fired and acquired against the
  live House endpoint, which returned `public_source_acquisition_total
  outcome: "uncertain"`, `errorCode: "acquisition_uncertain"`, `stage:
  "transport"`. No outcome was ever committed; the monitor paused as
  `worker_recovery_outcome_missing`. $0 paid.
- `Earnings U3 Acceptance 0823` and `0823b` — both terminal with
  `worker_recovery_outcome_missing`, no completion.

So U4's acceptance proved **the retry repair** — a deterministic acquisition
failure terminalizes once instead of redispatching five times. That was the
sprint's actual deliverable and it is genuinely done. It did **not** prove that
Congressional can acquire, classify, commit a finding, and deliver an alert.
Same for Earnings. That end-to-end path is what this unit closes.

## Task 1 — root-cause the transport failure (do this first)

The U4 agent concluded the transport failure "wasn't our code" but could not
name the cause. Do not accept or reject that conclusion; determine it.

**A strong lead they did not have:** `Tracker Live` hit the *identical*
classification — `acquisition_uncertain`, `stage: "transport"` — at
2026-08-23 11:26 PT against the **X API**, roughly forty minutes before the
Congressional failure against the **House disclosures endpoint** at 12:07 PT.
Two unrelated third-party endpoints, two different source adapters, the same
stage and the same error code within the hour. That correlation points at the
**shared transport/acquisition layer**, not at either endpoint. Start there:
find where `acquisition_uncertain` is raised, what conditions produce it, and
whether an ordinary upstream timeout, TLS reset, abort-signal expiry, or
non-2xx response is being collapsed into "uncertain" when it is in fact
determinate.

An `uncertain` acquisition is expensive by design: it cannot be safely retried,
so it terminalizes the occurrence. If determinate failures are being
misclassified as uncertain, every strategy loses occurrences it should have
survived.

- Reproduce or characterize red-first before changing behavior.
- If it truly is upstream flakiness, prove that with evidence and say so — then
  make the system degrade well (bounded, attributable, and recorded) rather
  than silently burning an occurrence.

## Task 2 — attribution in the acquisition layer

Recent work (`0ceeafa`) made occurrence failures name their strategy: the
bounded `console.error` summary now carries `packId` alongside `monitorId`, and
the previously silent recovery path emits the same summary. Extend that
principle to the source-acquisition layer so a `public_source_failure_total`
can be attributed and diagnosed.

**Respect the existing privacy design — do not weaken it.**
`workspaceRuntimeObservationSchema` is `.strict()` and carries only `counter`,
`errorCode`, `outcome`, `value`, and
`verify:workspace-runtime:observability` asserts that owner, workspace,
monitor, conversation, alert, prompt, credential, and provider values never
reach an observation. **Do not add identity to a counter.** Attribution belongs
in the bounded `console.error` summary, where a pack id is acceptable because
it is registry identity rather than owner data. Never log a source URL that
carries credentials, or raw upstream response text.

The goal: when the owner asks "which agent failed and why," a log window
answers it without cross-referencing manager state. During a period when a
Congressional acceptance and a commentary monitor were both live, a
Congressional failure was misread as the tracker's for exactly this reason.

## Task 3 — cross-strategy guard

`npm run verify:strategies` already exists (`0ceeafa`): 38 per-strategy suites
across all five verticals, about 90 seconds. **Run it before and after any
change to a shared module** — `workspace-worker-control-plane.ts`,
`workspace-alert-dispatch.ts`, `workspace-alert-store.ts`,
`agent/schedules/event-triggers.ts`, and the public-source adapter layer you
will be touching in Task 1.

Judgement call for you: decide whether it should be wired into `prebuild` or
stay an explicit gate, and say why. It costs ~90s per build if wired in.

Watch for **strategy-shaped asymmetry**: where one vertical passes an optional
argument and the others do not, that branch is untested by four-fifths of the
suite. That is exactly where the alert-keying defect lived.

## Task 4 — arm the full fleet

The owner wants all background agents running so they receive real texts, and
wants their logs distinguishable afterward.

- Confirm `Inverse Cramer Live`, `IPO Live`, and `Tracker Live` are enabled and
  healthy. **Do not reconfigure or archive them** beyond re-arming if a run has
  paused one; re-enable anything you pause.
- Get **Congressional** to one successful committing occurrence, then arm it on
  a sensible cadence with alerts enabled.
- Get **Earnings** to one successful committing occurrence, then arm it with
  owner-selected issuers. Note it is gated behind
  `EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED` /
  `EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED` — confirm flag state with the
  owner before enabling anything in Production.
- Cadence discipline: hours, not minutes. Six or twelve hours is right; nothing
  should run every fifteen minutes.
- Three stale workspaces hold active-registry slots and can be archived
  (Sprint 7 has this item): `Inverse Cramer 1.3.0 retrying`,
  `IPO Overnight Test`, `Congressional Overnight Test`. Archive only —
  findings, alerts, and receipts are retained, never deleted.

## Standing rules you must not break

- **Never mint, forge, derive, or engineer a Manage Sessions capability token
  or URL.** Stop and ask the owner; they will text Eve "manage sessions" and
  paste the URL back. Do not work around this by reading secrets, signing your
  own capability, or adding a temporary route.
- **This repository is public.** Never write a token into a file, commit, log,
  or command that gets recorded.
- Do not add temporary Production endpoints or edit Redis for writes. Read-only
  store queries for diagnosis are fine and encouraged.
- **Non-negotiable invariants:** absolute workspace isolation; background
  alerts never become an inbound turn in Main or another workspace; monitor
  research authority is never trading authority; approval-gated Coinbase
  behavior unchanged.
- Never attempt a git history rewrite. Never deploy while an occurrence is in
  flight. Deploys are manual (`vercel deploy --prod --yes`; the GitHub webhook
  is unreliable) — confirm the alias with `vercel inspect` afterward.
- Only one Production acceptance in flight at a time. A failed first occurrence
  stops that unit: record the first failing stage, make one focused repair, use
  the next natural occurrence, never retry the same one.
- Always report reserved budget separately from actual spend.
- Migration plan and roadmap receipts are append-only. Never delete, rewrite,
  or reflow existing entries.

## Two habits learned expensively here

- **Do not spend a paid Production occurrence to test a hypothesis formed by
  reading code.** Make the failure describe itself in durable state, then run
  once and read the fact.
- **`vercel logs` is a weak channel.** ~50-row rolling window, `--json`
  duplicates every row, and polling `/eve/v1/photon-workspaces/state` during a
  run evicts the rows you need. Bare `vercel logs <url> --json` only tails
  forward — use `--since`/`--until` for a historical window. Prefer the durable
  monitor record and the Redis stores.

## Not yours

- `verify:workspace-runtime:sec-ipo-scheduled-compiled` and
  `verify:strategy-packs:acceptance` are pre-existing red gates recorded in
  `BACKLOG.md` for Sprint 8.
- The commentary classifier's `maximumInputTokens: 24_000`, too small for a
  large first-run backfill.
- Giving the tracker a research lane and artifacts, and removing the hardcoded
  `packId !== "inverse-cramer"` gate in
  `agent/lib/public-commentary-workspace-worker.ts`.

## Finish clean

Report what you completed, what you deferred and why, reserved-versus-actual
spend, and the final armed state of every background monitor. Leave no test
monitors dispatchable, no temporary routes, no stray worktrees. Defer-not-ignore
items go to `BACKLOG.md`.
