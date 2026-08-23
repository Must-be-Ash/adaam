# Sprint 4 — U4: Congressional repair + migration

You are taking on **Sprint 4 only** of the Eve gap-closure roadmap. Sprints 1–3
are already resolved or landed. Do not start Sprint 5 or any later sprint, and
do not "improve" anything outside U4 along the way.

Repository: `/Users/ashnouruzi/dev/adaam`

## Read these first, in this order, before touching anything

1. **`GOAL.md`** — the owner's product target. Read it before you plan any
   change. The owner asked specifically that you understand what they are
   building toward before jumping into action.
2. **`AGENTS.md`** — project instructions; they override default behavior.
3. **`docs/workspace-runtime-pitfalls.md`** — failure modes that have already
   cost this project real money and real debugging time. Several were
   rediscovered twice in one night. Read it before debugging any monitor
   occurrence; the Diagnosis and Scheduling sections in particular will save you
   hours if you touch the workspace runtime.
4. **`docs/plans/2026-08-21-2129-roadmap-eve-gap-closure-plan.md`** — the
   roadmap. Read the "Ground rules for the implementing agent" section in full;
   it is binding. Your sprint is the "Sprint 4 — U4" section.
5. **`docs/plans/2026-08-20-2017-refactor-strategy-application-boundary-migrations-plan.md`**
   — §U4 is the detailed authority for this sprint. Append only: never delete,
   rewrite, or reflow existing entries or receipts.
6. **`docs/congressional-monitor-retry-defect.md`** — the recorded defect you
   are repairing first.

**The code is the only source of truth for how the system currently behaves.**
Verify every behavioral claim against it. `HANDOFF.md` is a stale snapshot of
the owner's own notes — do not plan from it.

## The task

Execute migration plan §U4 in full, in two ordered halves:

**Half 1 — repair the retry defect, red-first.** A deterministic House
source-acquisition failure must terminalize the occurrence exactly once instead
of redispatching (the defect doc records 5× dispatch plus repeated spend), while
genuine pre-outcome infrastructure interruptions keep bounded recovery. Prove it
red-first: the test must fail before your fix and pass after. Add the retry
verifier to `package.json`. This half must be green before migration begins.

**Half 2 — migrate the strategy onto contract-driven plumbing**, then run one
zero-usage Production acceptance.

Tick the two boxes in the roadmap's Sprint 4 section and complete the §U4
checklist in the migration plan, each with its commit or receipt.

## Starting state (verified 2026-08-23 12:00 PT)

- `main` is clean and synced with `origin/main` at `23a4dab`. One worktree.
- Typecheck, `npm run build`, and these suites are green: all six
  `verify:congressional-signals:sprint-0..5`, `verify:workspaces`,
  `verify:strategy-packs`, `verify:artifacts`, `verify:sessions`.
- Recent work (2026-08-22/23) fixed the workspace alert path. It touched shared
  plumbing you will also use:
  - `agent/lib/workspace-worker-control-plane.ts` — the unkeyed-first alert
    staging rule was extracted into `stageWorkspaceAlertPresentations`, and an
    empty presentation list now stages one alert instead of none.
  - `agent/lib/workspace-alert-dispatch.ts` — gained dependency-injection
    points; production defaults unchanged.
  - `agent/schedules/event-triggers.ts` — failure codes are now
    self-describing (`alert_delivery.<cause>`, `worker_outcome_missing`).
  - **Congressional behavior is unchanged by all of it.** Congressional passes
    only the singular `alertPresentation`, never `alertPresentations`, so it
    takes the identical code path as before. Verified, not assumed.
- New verifier available and worth using: `verify:workspace-runtime:alert-dispatch`
  covers commit → store → read → deliver as one path.

## Do not break these

- **Live unattended monitors.** `Inverse Cramer Live`, `IPO Live`, and
  `Tracker Live` are the owner's deliberately enabled background monitors, all
  currently `enabled` and healthy. Do not archive, retire, or reconfigure them.
  Pause only if the acceptance rules require it, and re-enable afterward.
- **Non-negotiable invariants.** Absolute workspace isolation (no instructions,
  configuration, findings, alerts, budget, or history across workspaces);
  background alerts never become an inbound turn in Main or any other
  workspace; monitor research authority is never trading authority;
  approval-gated Coinbase behavior unchanged.
- **Never mint, forge, derive, or engineer a Manage Sessions capability token or
  URL.** When you need one, stop and ask the owner; they will text Eve
  "manage sessions" and paste the URL back. Do not work around this by reading
  secrets, signing your own capability, or adding a temporary route.
- **This repository is public.** Never write a token into a file, commit, log,
  or command that gets recorded.
- Do not add temporary Production endpoints, edit Redis directly (read-only
  queries for diagnosis are fine), or invoke workers manually.
- Never attempt a git history rewrite. Never deploy while an occurrence is in
  flight. Deploys are manual: `vercel deploy --prod --yes` (the GitHub webhook
  is unreliable) — confirm the alias afterward with `vercel inspect`.

## Scope discipline

Make the smallest change that completes U4 and reuse existing plumbing. Generic
plumbing selects behavior via declared contracts, never pack-ID branches (pack
IDs remain valid as provenance, registry keys, and binding identity). No new
architecture, registries, or frameworks. Non-blocking discoveries go to
`BACKLOG.md`, not into scope. Per-sprint verification is focused: this sprint's
gates, directly changed shared contracts, typecheck, Eve build, app build — the
full battery happens once in Sprint 8.

## Acceptance discipline

Fresh zero-usage disposable workspace, one occurrence, stop on the first
terminal result, pause/archive with `nextOccurrenceAt: null`, record the
receipt. **A failed first occurrence stops the unit** — record the first failing
stage, make one focused repair, and use the next natural occurrence. Never retry
the same occurrence.

Always report reserved budget separately from actual spend.

## Two habits that were learned expensively here

- **Do not spend a paid Production occurrence to test a hypothesis you formed by
  reading code.** Make the failure describe itself in durable state first, then
  run once and read the fact. Five occurrences were burned in one night guessing
  at a cause a single read-only store query answered for free.
- **Do not trust `vercel logs` as your diagnostic channel.** The window is about
  50 distinct rows, `--json` duplicates every row, and polling
  `/eve/v1/photon-workspaces/state` during a run evicts the rows you need. Read
  the durable monitor record instead.

## Open items that are NOT yours

Leave these alone; they are recorded and owned elsewhere:

- Sprint 1 (U1) is waiting on a live Inverse Cramer statement. Observational
  only, not a blocker.
- The public-commentary classifier declares `maximumInputTokens: 24_000`, which
  is too small for a large first-run backfill (`SESSION_TOKEN_LIMIT_REACHED`).
  Fixing it needs a new evidence-contract version plus a new immutable pack
  version. Commentary only — it does not affect Congressional.
- Giving the tracker a research lane and artifacts, and removing the hardcoded
  `packId !== "inverse-cramer"` gate in
  `agent/lib/public-commentary-workspace-worker.ts`.

## Finish clean

Leave the system safe and complete: pause any unintended work, remove temporary
routes, secrets, test state, and stray worktrees. Defer-not-ignore items go to
`BACKLOG.md`. Report what you completed, what you deferred and why, and the
reserved-versus-actual spend.
