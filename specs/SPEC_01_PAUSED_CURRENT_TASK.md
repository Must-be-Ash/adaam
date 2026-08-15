# Spec 1 canonical delivery handoff

This is the single canonical status and delivery handoff for Spec 1. If another
Spec 1 document conflicts with this file about what is complete or what remains,
this file controls. The detailed product requirements remain in
`01-independent-workspace-runtimes.md`; the detailed remediation acceptance
criteria remain in `SPEC_01_REVIEW_FINDINGS.md` after its latest documentation
branch is merged.

## Mandate for the next agent

Manage Spec 1 from the current local branches through completion. Preserve work
already implemented, finish every remaining remediation phase, require review
and acceptance before each phase merge, integrate the branches, push the final
reviewed work, and stop before deployment unless the owner separately authorizes
production mutation.

## Exact current branch state

- **Spec 1 integration branch:** `codex/spec-01-independent-workspaces`
  - Worktree: `/Users/ashnouruzi/dev/adaam-spec-01`
  - Head: `6e88955` (`docs: define Spec 1 remediation R2`)
  - Contains the original implementation plus accepted R1.
- **Active R2 code branch:** `codex/spec-01-remediation-r2`
  - Worktree: `/Users/ashnouruzi/dev/adaam-spec-01-remediation-r2`
  - Head: `3afe526` (`docs: record R2 Pass A verification`)
  - Clean and not merged into the Spec 1 integration branch.
- **Latest remediation documentation branch:**
  `codex/spec-roadmap-r2-learnings`
  - Worktree: `/Users/ashnouruzi/dev/adaam-spec-roadmap-r2-learnings`
  - Head: `b012b7c` (`docs: preserve fulfilled scheduler claims`)
  - Clean and merged into the R2 code branch at `5ab1858`.
- Main and all three Spec 1 branches are pushed to `origin`.
- Redis is installed at `/opt/homebrew/bin/redis-server`.
- No Spec 1 production deployment or real Photon acceptance has been performed.

## Required local worktree cleanup

These directories are temporary Git worktrees, not separate projects. The next
agent must not create additional worktrees: use at most one active Spec 1
worktree alongside the canonical `/Users/ashnouruzi/dev/adaam` checkout, with
the pushed remote branches preserving work between phases.

- Remove `/private/tmp/adaam-spec01-review.SRTq3I/repo`; it is an obsolete
  detached review worktree.
- Remove `/Users/ashnouruzi/dev/adaam-spec-01-remediation-r1`; R1 is already
  integrated into `codex/spec-01-independent-workspaces`.
- Remove `/Users/ashnouruzi/dev/adaam-spec-roadmap-r2-learnings`; its work is
  already merged into `codex/spec-01-remediation-r2` and pushed.
- Keep `/Users/ashnouruzi/dev/adaam-spec-01-remediation-r2` only until R2 is
  accepted and merged into `codex/spec-01-independent-workspaces`, then remove
  it immediately.
- Keep `/Users/ashnouruzi/dev/adaam-spec-01` as the sole Spec 1 integration
  worktree. After reviewed Spec 1 is merged and pushed to `main`, remove it too.

Handoff is not complete while obsolete Spec 1 worktrees remain registered or on
disk. Preserve the remote branches and commits; the cleanup target is the local
worktree directories and registrations.

## Implemented work that must not be rebuilt

The following foundation already exists. Retest it when a remediation touches
the path, but do not restart or replace it wholesale.

### Original Spec 1 implementation

- Sprint 0 contracts, failure fixtures, feature flags, rollback definitions,
  bounded error codes, and fixture Photon harness.
- Sprint 1 deployment-owner authorization, owner/workspace-scoped stores,
  versioned workspace state, durable briefs and strategies, capability manifests,
  provider drift detection, budget ledgers, and Start fresh isolation.
- Sprint 2 workspace monitor records, CRUD, revisions, leases, schedules, DST and
  missed-run semantics, static minute dispatch, concurrency budgets, source
  coverage, legacy compatibility, and Redis-backed runtime fixtures.
- Sprint 3 signed isolated worker envelopes, workspace-scoped Eve task sessions,
  default-deny dynamic tools, finding/checkpoint tools, the IPO Filings SEC
  reference implementation, and deterministic two-workspace fixtures.
- Sprint 4 immutable Photon ingress/assignment/dispatch/response records,
  duplicate-webhook handling, alert/outbox records, Discuss/Manage routing,
  pending context, held replies, and deterministic Photon integration fixtures.
- Sprint 5 natural-language monitor management, additive schedules and sources,
  budget/status management, session-manager monitor controls, archive/restore,
  Start fresh behavior, and stale action coverage.
- The local portions of Sprint 6: deterministic suites, schedule runbook,
  concurrent workspace and budget tests, SEC read-only smoke, Eve build, Next.js
  build, and typecheck.

### Accepted remediation

- **R1 is complete and merged.** The workspace worker explicitly disables Eve's
  provider-managed `web_search`, and the compiled worker tool surface is tested.
  Do not execute `SPEC_01_REMEDIATION_R1_PROMPT.md` again.

### Implemented R2 work awaiting final acceptance

- The scheduled production worker uses the deterministic SEC IPO evaluator.
- SEC filing facts are stored as typed durable facts.
- The authored schedule reaches the actual compiled Eve workspace worker.
- Unchanged occurrences and interrupted crash tails recover and advance.
- Filing deduplication uses durable source-native identity rather than observation
  timestamps.
- Reclaimed attempts recover before model budget admission and do not create a
  second Eve session, fetch, coverage record, reservation, or model charge.
- Invalid recovery becomes a bounded durable failure instead of falling through
  to a new model run.
- Recovery revalidates current owner, workspace, monitor, configuration, source,
  capability, occurrence, and lease state.
- Stored outcomes bind their occurrence-form run ID and nested finding identity
  to the parent outcome.
- Recovery, first-attempt workspace, and legacy jobs are isolated so one job's
  failure is surfaced only after unrelated claimed work receives an opportunity.
- The real-Redis identity/outcome race passed using distinct competing outcomes
  with overlapping filing identities.

Do not redo those R2 changes. The immediate task is to accept or minimally fix
their final unreviewed boundary.

## Remaining work, in required delivery order

### 1. Finish R2 Pass A acceptance

- Independently review commit `9d979f6` against `8d08405`.
- Accept or minimally fix the two asymmetric claim-isolation cases: a failed
  legacy claim must not discard fulfilled workspace work, and a failed workspace
  claim must not discard fulfilled legacy work.
- Independently confirm the completed Pass A regression matrix and real-Redis
  evidence.
- Fix only verified failures and commit each correction atomically.
- Mark A3, A4, and the Redis race proof finally accepted after independent
  review; they are already implemented, locally verified, documented, and
  pushed.

### 2. Finish the rest of R2

- Prevent exact-fenced SEC requests from following any redirect before rejection.
- Prove a valid SEC feed at the declared 40-entry ceiling fits durable storage,
  or implement a deterministic lossless batching contract.
- Lock the compiled test-fixture bridge to explicit acceptance-only opt-in,
  loopback-only transport, strong ephemeral credentials, and production denial.
- Validate the relationships among accession, CIK, form/file number,
  registration/amendment identity, classification, and canonical filing URL.
- Prove two compiled production-path workers genuinely overlap, retain isolated
  state and capabilities, terminate cleanly, and leave no runtime teardown leak.
- Independently review R2, correct only confirmed findings, commit the accepted
  checklist state, and merge R2 into `codex/spec-01-independent-workspaces`.

### 3. Complete R3: production alert delivery and recovery

- Add the production caller that drains staged workspace alerts to Photon.
- Make finding, alert staging, checkpoint advancement, and delivery retry one
  crash-safe durable contract with no silent alert loss.
- Recover or quarantine crashes before Photon send and ambiguous crashes after
  Photon acceptance but before receipt persistence.
- Review, fix, commit, and merge R3 into the Spec 1 integration branch.

### 4. Complete R4: Photon ingress and routing crash safety

- Recover or quarantine dispatch receipts stranded before model dispatch.
- Recover or quarantine response receipts stranded before delivery.
- Make Discuss context and held replies recoverable across workspace lookup,
  selection, assignment, and dispatch failures.
- Give intercepted approval and session-manager actions explicit durable terminal
  outcomes.
- Cover every durable-write/external-side-effect crash boundary and lifecycle
  race.
- Review, fix, commit, and merge R4 into the Spec 1 integration branch.

### 5. Complete R5: worker recovery and authoritative freshness

- Reconcile expired global and workspace reservations after process death,
  including the intentionally unresolved attempt-1 reservation from R2.
- Persist and recover failures that occur before an Eve worker session starts.
- Revalidate brief, strategy, budget, capability, monitor, and source revisions
  before accepting a worker outcome.
- Preserve uncertainty for possibly started or paid work; release only work known
  not to have started.
- Review, fix, commit, and merge R5 into the Spec 1 integration branch.

### 6. Complete R6: rollout, lifecycle, presentation, privacy, and Eve boundary

- Make absent, partial, and complete owner/ingress configuration safely roll out
  without an insecure authorization fallback.
- Store and display the authoritative workspace name, bounded event time, and
  safe source evidence separately from monitor naming.
- Make archive/restore converge through an atomic or durable idempotent lifecycle
  contract.
- Remove raw workspace/monitor IDs and arbitrary exception messages from runtime
  logs; use the bounded operational catalog at real call sites.
- Replace Eve private runtime imports with public APIs where available; otherwise
  pin and guard the supported Eve version and retain a compiled-worker upgrade
  gate.
- Review, fix, commit, and merge each bounded R6 phase into the Spec 1 integration
  branch.

### 7. Finish the remaining primary Spec 1 gates

- Complete the owner-authorized production deployment and real Photon/iMessage
  IPO alert, Discuss, session-manager, and monitor-management acceptance.
- Verify event streams and durable delivery receipts, not only the final message.
- Record rollback evidence before enabling the runtime by default.
- Complete Sprint 7 source-event delivery: authenticated normalized ingress,
  conditional RSS, supported verified WebSub, subscription routing through the
  same monitor queue, replay/signature/order/fan-out/isolation coverage, and its
  separate kill switch.
- Complete production observability, quarantine reporting, retention, and owner-
  visible monitor health.
- Reconcile every affected checkbox and exit gate in
  `01-independent-workspace-runtimes.md`; its unchecked top-level requirements
  are not a reliable live status until this reconciliation is done.
- Update `HANDOFF.md`, `NORTH_STAR.md`, and the focused verification map to match
  the delivered architecture.
- Perform the final full-branch independent review, fix confirmed findings,
  commit the final accepted state, merge the integration branch, and push.

Production deployment, real Photon messages, production environment changes,
and other remote mutations still require explicit owner authorization at the
time they are performed.

## Role of every Spec 1 document

- `SPEC_01_PAUSED_CURRENT_TASK.md` — **canonical current status and delivery
  ownership. Start here.**
- `01-independent-workspace-runtimes.md` — product requirements and full
  definition of done. Its checkbox state is not the canonical implementation
  status until final reconciliation.
- `SPEC_01_REVIEW_FINDINGS.md` — detailed R1-R6 acceptance ledger. Its newest
  version is currently on `codex/spec-roadmap-r2-learnings` and must be merged.
- `SPEC_01_INDEPENDENT_REVIEW_PROMPT.md` — historical prompt for the original
  review at `32370db`. Do not execute it again.
- `SPEC_01_REMEDIATION_R1_PROMPT.md` — historical R1 implementation prompt. R1
  is complete and merged; do not execute it again.

## Definition of handoff completion

The next agent is finished managing Spec 1 only when all remaining sections
above are implemented, verified, independently reviewed, committed, merged into
the integration branch, reflected accurately in the product and review
checklists, pushed, and the temporary worktrees listed above are cleaned up. A
production rollout is a separate owner-authorized act.
