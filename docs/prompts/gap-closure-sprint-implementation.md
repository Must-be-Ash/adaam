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

## Operational access

- **Never mint, forge, derive, or engineer a Manage Sessions capability token or
  URL.** When you need one, stop and ask the owner. They will text Eve "manage
  sessions" and paste the URL back to you. Do not attempt to work around this by
  reading secrets, signing your own capability, or adding a temporary route.
- A manager URL looks like
  `https://adaam.vercel.app/eve/v1/photon-workspaces#<token>`; the part after `#`
  is the capability token. **It is valid for two hours.** Reuse the owner's
  current token for as long as it works, and when it returns HTTP 410 or an
  expired-link error, simply ask the owner for a fresh one. Never write a token
  into a file, commit, log, or command that gets recorded — this repository is
  public.
- Driving the manager over HTTP with that token is supported and preferred over
  asking the owner to click through the UI:
  `POST /eve/v1/photon-workspaces/state` with `{"managerToken": "<token>"}`
  returns the registry `revision`, `activeWorkspaceId`, `workspaces` (with
  monitors and budgets), `strategyPackCatalog`, and a server-minted
  `packMutationIdentity`. Pass that identity straight through to
  `POST /eve/v1/photon-workspaces/pack-action` for `strategy-pack-create`,
  `-configure`, or `-remove`, and use `POST /eve/v1/photon-workspaces/action`
  for `select`, `archive`, `restore`, `rename`, and `start-fresh`. Creating a
  pack session selects it, so restore the owner's intended active session
  afterward.
- Do not add temporary Production endpoints, edit Redis directly, or invoke
  workers manually. Use the existing owner-authorized backend services.

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
- Do not archive, reconfigure, or retire the owner's live unattended monitors,
  currently `Inverse Cramer Live` and `IPO Live`. They are intentionally enabled
  and unarchived so real signals exercise the alert path. Every other monitor,
  including all Congressional ones, is retired, paused, or archived with no next
  occurrence.
- **`IPO Live` runs on `ipo-filings@1.1.2`, which is not yet proven.** The
  earlier 1.1.1 session sized its whole frontier research session at 2,000 output
  tokens against a route hard-bound to high reasoning, and its per-occurrence
  envelope was 2,000 output as well; its single Production occurrence on
  2026-08-22 terminalized as `worker_recovery_outcome_missing`. Commit `44d83c6`
  added research definition `1.0.2` (12,000 output) and `ipo-filings@1.1.2`
  (160,000 input / 40,000 output per run, paid ceilings unchanged), and the
  session was recreated on it. **That repair is now proven for the outer
  worker:** the first `1.1.2` occurrence completed at 2026-08-22T17:45:54Z with
  `lastErrorCode: null`, zero consecutive failures, and zero active workers,
  using 6,342 input and 1,196 output tokens. The old envelope reserved the whole
  2,000-token per-run output allowance while the shared worker session alone
  declares 16,000, which is why it could never commit.
- **The IPO frontier research path is still unproven.** That first green
  occurrence found no new filings past the source cursor, so it correctly spent
  nothing on frontier reasoning, research, or artifacts — `paidMicrosToday` is 0.
  Definition `1.0.2`'s 12,000-token research session has therefore still never
  executed. It needs an occurrence whose window contains a genuinely new S-1.
  Until then, do not describe IPO research as proven.
- `IPO Live` is temporarily on a dense same-day schedule (10:45 through 16:00
  Vancouver) purely to iterate on that proof. Once one occurrence terminalizes
  cleanly, restore its normal `["10:00", "16:00"]` cadence through the
  `monitor-schedule` runtime action so it stops consuming runs.
- Three stale active sessions carry `paused_failure` monitors and are not part
  of any sprint: `IPO Overnight Test` (bound to the superseded
  `ipo-filings@1.0.0`), `Congressional Overnight Test`, and
  `Inverse Cramer 1.3.0 retrying`. Leave them alone unless the owner asks for
  cleanup; they hold durable evidence and none of them can dispatch.
- When the Cramer alert eventually fires, verify it, close U1 in the migration
  plan, and tick Sprint 1 in the roadmap. That bookkeeping can land during any
  sprint.

## Protecting the two live monitors

Two owner monitors are running unattended in Production while you work, and
Sprint 2 edits the very code one of them executes. Follow this exactly.

1. **Develop freely in the worktree.** Characterization, implementation, and
   local gates never touch Production. Nothing below restricts that work.
2. **Pause `Inverse Cramer Live` before you push any commentary change to
   `main`.** Inverse Cramer and Public Commentary Tracker share
   `public-commentary-workspace-worker.ts` and `public-commentary-vertical.ts`,
   pushing to `main` auto-deploys Production, and that monitor would then run
   your changed code unattended. Local gates are necessary but have repeatedly
   passed while this exact subsystem failed in Production, so do not treat them
   as sufficient. Pause it, land and deploy, verify Production health, then
   re-enable it.
3. **Never deploy while an occurrence is in flight.** Check each live
   workspace's `activeWorkers` and `nextOccurrenceAt` first. A deploy that kills
   a running worker produces `worker_recovery_outcome_missing`, and that class of
   error pauses a monitor immediately rather than after the usual five
   consecutive failures. `IPO Live` is currently on a dense hourly schedule, so
   its quiet windows are short — wait for one.
4. **Pause both live monitors before arming any disposable acceptance
   workspace**, run the acceptance, clean it up, then re-enable them. One
   acceptance in flight at a time.
5. **Re-enable what you paused.** Leaving an owner monitor paused silently ends
   the proof it exists for. If you cannot re-enable it, say so explicitly in
   your report rather than leaving it paused quietly.

## Where to begin

Begin with **Sprint 2 — U2: Public Commentary Tracker migration**.

## Reporting

At the end of each sprint, report: what changed, the exact verification that
passed, any receipt or deployment identifiers, actual versus reserved spend if a
Production occurrence ran, and what the next sprint requires. Then stop and ask
whether to continue. Stay in this same task for later sprints and do not repeat
orientation or rerun unchanged green checks.
