# Spec 1 independent-review findings

Review target: `codex/spec-01-independent-workspaces` at `32370db`

Merge base: `154d1b9`

Status: **not ready for deployment or merge**

The independent reviewer inspected the complete 53-commit branch, traced the
production paths, ran the deterministic verification matrix, typecheck, Eve
build, and Next.js production build, and reproduced the intermediate receipt
states with a disposable crash probe. The coordinating review then checked the
material findings against the final branch and installed Eve documentation.

No production, paid, financial, real Photon/iMessage, push, or deployment action
was performed. Redis-backed tests were not independently rerun because the
review environment did not have a `redis-server` executable.

## Verified remediation checklist

### R1 — worker provider-tool isolation

- [x] Explicitly disable Eve's provider-managed `web_search` tool in the
  workspace worker. The installed Eve harness enables Exa-backed `web_search`
  for Gateway models when no matching disable file exists.
- [x] Verify the fully compiled worker tool surface, not only the application
  dynamic registry or source files. Fail if any undeclared built-in/provider
  tool is exposed.

Evidence:

- `agent/lib/sec-ipo-reference.ts` hard-denies `web_search`.
- `agent/subagents/workspace-worker/tools/web_search.ts` disables the matching
  provider-managed built-in through Eve's filename-based `disableTool()` slot.
- `scripts/verify-workspace-worker-compiled-tools.ts` compiles and resolves the
  Gateway worker, then requires its provider-resolved model tool surface to be
  exactly the approved `load_skill` bridge with no undeclared built-in or
  provider tool.
- `node_modules/eve/docs/concepts/default-harness.md` documents default Gateway
  web search and the filename-based `disableTool()` mechanism.

### R2 — deterministic IPO production path

- [ ] Wire the versioned SEC parser/evaluator into the real scheduled worker
  path. `evaluateSecIpoPage()` is currently called only by fixtures and the
  standalone live smoke.
- [ ] Persist the required SEC facts as typed fields, including CIK, accession,
  form type, filing/file number, registration/amendment identity, classification,
  and canonical filing URL. The generic finding schema currently stores only a
  summary, provenance, time, and artifact references.
- [ ] Prove scheduler → compiled worker → exact fenced fixture fetch → typed
  finding/no-match → checkpoint → alert behavior and replay through the real
  caller chain.

### R3 — production alert outbox and delivery recovery

- [ ] Add a production caller that drains staged workspace alerts to Photon.
  `deliverWorkspaceAlertToPhoton()` currently has no caller outside its direct
  test, and the `photonAlerts` rollout flag is not consumed by delivery code.
- [ ] Do not advance a source checkpoint into silent alert loss. Define the
  durable relationship between finding, alert staging, checkpoint, and delivery
  retry/reconciliation.
- [ ] Make `delivering` recoverable. Add crash tests before Photon send and after
  Photon acceptance but before delivery persistence; ambiguous acceptance must
  pause/quarantine rather than silently return or blindly replay.

### R4 — Photon ingress, response, and alert-routing crash safety

- [ ] Recover or quarantine a dispatch receipt stranded in `dispatching` before
  `bridge.send`. A duplicate currently returns without dispatch or quarantine.
- [ ] Recover or quarantine a response receipt stranded in `staged` before it
  becomes `delivering`. A duplicate currently returns silently.
- [ ] Make pending Discuss context and held replies recoverable. They are
  destructively consumed/assigned before workspace lookup, selection, durable
  assignment, and model dispatch complete.
- [ ] Give intercepted approval/session-manager control actions explicit durable
  terminal outcomes instead of leaving only the initial ingress receipt.
- [ ] Add crash and lifecycle-race tests at every durable-write/external-side-
  effect boundary.

### R5 — worker recovery and authoritative freshness

- [ ] Reconcile expired global and workspace run reservations after process
  death. Reserved global entries currently survive day pruning and can consume
  concurrency indefinitely.
- [ ] Record and recover failures before a worker session starts; do not leave
  only a released budget and an expiring monitor lease.
- [ ] Re-read and compare brief, strategy, and budget revisions before worker
  outcome commit. The signed envelope carries these revisions, but the commit
  path currently revalidates only capabilities and monitor/source state.
- [ ] Distinguish known-not-started release from ambiguous started/paid work and
  retain uncertainty where required.

### R6 — rollout, lifecycle, presentation, privacy, and framework boundary

- [ ] Make the new owner/ingress path safely deployable. Ordinary Photon chat
  currently requires the new owner mapping and ingress storage even when all
  workspace runtime flags are off. Add absent/partial/complete configuration
  matrix tests without introducing an insecure authorization fallback.
- [ ] Store and display the authoritative workspace name separately from the
  monitor name. Include the bounded event time and safe source evidence required
  by the alert contract.
- [ ] Make archive/restore converge atomically or through a durable idempotent
  lifecycle intent; current sequential monitor and workspace mutations can
  leave partial state after failure.
- [ ] Remove raw workspace/monitor IDs and arbitrary `error.message` values from
  new runtime logs. Connect production logging to the fixed low-cardinality
  catalog and test actual call sites.
- [ ] Replace Eve private runtime imports with a public API if available. Until
  then, pin/guard the compatible Eve version, document the boundary, and run a
  real compiled fixture worker to a terminal event as an upgrade gate.

## Claims that must be reopened or re-proven

The implementation should correct any affected checked item or exit gate until
the corresponding production-path acceptance test passes. In particular:

- Sprint 3's worker tool-isolation and scheduled IPO exit gate;
- Sprint 4's Photon integration, alert delivery, dispatch/delivery uncertainty,
  and durable-outcome exit gate;
- Sprint 5's complete owner-workflow exit gate; and
- Sprint 6's local verification claim where it relies on the above gates.

## Intentionally deferred work

These are not review defects and remain unchecked until separately completed:

- authorized deployment and production environment configuration;
- real Photon/iMessage alert, Discuss, and manager acceptance;
- the Sprint 6 production exit gate;
- all Sprint 7 source-event/RSS/WebSub work;
- remaining operations, operator reconciliation, and retention work;
- definition of done, durable documentation refresh, final review, and merge.

## Remediation order

Work in bounded reviewed phases: R1, R2, R3, R4, R5, and then split R6 into
rollout, lifecycle, presentation/privacy, and Eve-compatibility phases. Each
phase uses a fresh task/worktree, atomic commits, an independent review, and a
phase-to-integration merge before the next phase. Do not deploy until the local
remediation phases and their reviews are complete.
