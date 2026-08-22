# Gap-closure sprint implementation

You are taking ownership of executing the Eve gap-closure roadmap, one sprint at
a time.

Repository: `/Users/ashnouruzi/dev/adaam`

Canonical roadmap and progress tracker:
`docs/plans/2026-08-21-2129-roadmap-eve-gap-closure-plan.md`

Detailed authority for Sprints 1–5 (migration units U1–U5):
`docs/plans/2026-08-20-2017-refactor-strategy-application-boundary-migrations-plan.md`

Start by inspecting git status and the current branch. Confirm the tree is clean
before editing.

## Sources of truth

**The code is the only source of truth for how the system currently behaves.**
Verify every behavioral claim against it.

`GOAL.md` is the product target — what the owner is building toward.

`HANDOFF.md` is a stale snapshot of the owner's personal notes. Do not trust its
descriptions of current state, architecture, flags, or monitor status, and do not
plan a change from it. If you need a fact it mentions, confirm it in code first.

## Orient once, narrowly

1. Read `AGENTS.md`.
2. Read `GOAL.md`.
3. Read the complete roadmap.
4. For Sprints 1–5, read that unit's section of the migration plan.
5. Read only the active sprint's code, packs, contracts, and focused tests. Do
   not read the whole codebase.

## How to work

- One sprint at a time. Within a sprint, one step at a time. Check each box in
  the roadmap only after that step is genuinely done, with its commit or receipt
  recorded next to it. Never check a box in advance.
- For Sprints 1–5, execute the detailed steps from the migration plan and mark
  its per-unit checklists there, then tick the sprint-level box in the roadmap.
  Never delete, rewrite, or reflow existing entries or receipts in that plan; it
  is the owner's progress record. Append only.
- Make the smallest change that completes the sprint. Reuse existing plumbing.
  No new architecture, registries, frameworks, or memory systems. Strategy
  behavior stays strategy-owned; generic plumbing selects behavior through
  declared contracts, never pack-ID branches. Pack IDs remain valid as
  provenance, registry keys, and immutable binding identity.
- No hardening or refactoring mid-flight. Per-sprint verification is focused:
  that sprint's gates, directly changed shared contracts, typecheck, Eve build,
  app build. The full regression battery and the end-to-end pass happen once, in
  Sprint 8, after code churn stops. Anything non-blocking you discover goes to
  `BACKLOG.md`, not into scope.
- At most two worktrees at all times: `main` plus one active implementation
  worktree. Remove the implementation worktree after landing.
- Production is a test bed. There are no users in prod. Pushing to `main`
  auto-deploys Production on Vercel. Prefer one real bounded Production
  acceptance over local workarounds. You have Vercel CLI for deploys, logs, and
  observability, and GitHub CLI for repo operations.
- Acceptance discipline, every time: fresh zero-usage disposable workspace, one
  occurrence, stop on the first terminal result, pause and archive with
  `nextOccurrenceAt: null`, record the receipt. A failed first occurrence stops
  that unit. Record the first failing stage, make one focused repair, and use the
  next natural occurrence. Never retry the same occurrence.
- Only one Production acceptance may be in flight at any moment.
- Always report reserved budget separately from actual spend.
- Never break these: absolute workspace isolation; background alerts never become
  an inbound turn in Main or another workspace; monitor research authority is
  never trading authority; approval-gated Coinbase behavior unchanged.
- Never attempt a git history rewrite.

## Current state

- U1 (Inverse Cramer) implementation is COMPLETE. Every repair is written,
  verified, committed, and deployed through commit `996de7d`. Do not reopen it,
  re-verify it, or treat it as unfinished work.
- The only thing left in U1 is observational: workspace `Inverse Cramer Live` is
  armed on a 12-hour cadence waiting for a genuinely material Jim Cramer
  statement, so one delivered alert can be checked for the executive brief and
  artifact reference. Cramer's posting cadence is the constraint. This can take
  days.
- Therefore Sprint 1 does not block anything.
- Do not archive, reconfigure, or retire `Inverse Cramer Live`. It is the live
  proof and is intentionally left enabled and unarchived. As of 2026-08-22 it is
  the only dispatchable monitor in Production; every other monitor, including all
  Congressional ones, is retired, paused, or archived with no next occurrence.
- Before arming Sprint 2's disposable acceptance workspace, pause the
  `Inverse Cramer Live` monitor if its alert has not yet fired, run and clean up
  the U2 acceptance, then re-enable it. One acceptance in flight at a time.
- When the Cramer alert eventually fires, verify it, close U1 in the migration
  plan, and tick Sprint 1 in the roadmap. That bookkeeping can land during any
  sprint.

## Where to begin

Begin with **Sprint 2 — U2: Public Commentary Tracker migration**.

## Reporting

At the end of each sprint, report: what changed, the exact verification that
passed, any receipt or deployment identifiers, actual versus reserved spend if a
Production occurrence ran, and what the next sprint requires. Then stop and ask
whether to continue. Stay in this same task for later sprints and do not repeat
orientation or rerun unchanged green checks.
