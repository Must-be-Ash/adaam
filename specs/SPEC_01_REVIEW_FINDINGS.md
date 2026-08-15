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

- [x] Wire the versioned SEC parser/evaluator into the real scheduled worker
  path. In the reviewed pre-R2 state, `evaluateSecIpoPage()` was called only by
  fixtures and the standalone live smoke.
- [x] Persist the required SEC facts as typed fields, including CIK, accession,
  form type, filing/file number, registration/amendment identity, classification,
  and canonical filing URL. In the reviewed pre-R2 state, the generic finding
  schema stored only a summary, provenance, time, and artifact references.
- [x] Prove scheduler → compiled worker → exact fenced fixture fetch → typed
  finding/no-match → checkpoint → alert behavior and replay through the real
  caller chain.

Evidence:

- `agent/lib/workspace-finding-facts.ts` defines the strict versioned SEC IPO
  fact union, and `agent/lib/workspace-finding-store.ts` accepts those facts
  only on the internal deterministic candidate contract.
- `agent/lib/sec-ipo-workspace-worker.ts` exposes one composite capability that
  performs the exact fenced fetch, deterministic normalization/evaluation,
  typed finding/no-match commit, checkpoint transition, and alert staging.
- `agent/schedules/event-triggers.ts` dispatches the production bounded worker
  and treats an already terminal occurrence reservation as authoritative, while
  `agent/lib/eve-workspace-worker-runtime.ts` uses Eve's rehydratable framework
  schedule adapter for the durable task session.
- `scripts/verify-sec-ipo-scheduled-compiled-worker.ts` drives the authored
  schedule through the production control plane and actual compiled Eve worker
  to terminal events. The official Eve test model only requests the resolved
  composite tool; SEC facts, classification, dedupe, and checkpoints remain
  deterministic application output. Coverage includes baseline, later S-1,
  related S-1/A, malformed/truncated/redirected/stale/ambiguous rejection,
  occurrence and filing replay, and isolated state in two workspaces.
- The compiled fixture bridge is available only under `NODE_ENV=test` outside
  Vercel. It substitutes deterministic storage/source clients, not Eve's
  runtime, model orchestration, worker graph, capability resolution, or SEC
  evaluator. The local workflow world and transformed step-registration
  harness use Eve private internals and remain part of R6's framework-boundary
  replacement/version-guard work.

#### R2 independent re-review and remediation

The original R2 phase-gate claims above are not accepted until this checklist
passes independent re-review. A checked item below means only that remediation
is implemented on the R2 phase branch and is still pending that review.

- [x] **Implemented, pending independent re-review — occurrence/crash-tail
  recovery.** An unchanged or already-terminal occurrence resumes from its
  durable outcome, finishes the schedule tail, and advances the next occurrence
  instead of remaining due after a worker exit or replay.
- [ ] **Exact no-follow source transport.** An exact-fenced request rejects a
  redirect response before any second outbound request, including when the
  redirect destination would otherwise satisfy the host policy.
- [x] **Implemented, pending independent re-review — stable filing identity.**
  Filing deduplication uses durable source-native identity and does not create a
  second fact or alert merely because observation or source-update timestamps
  changed.
- [ ] **Legitimate maximum-feed durability.** Every valid feed at the declared
  40-entry ceiling fits the durable outcome limits or is handled by a
  deterministic lossless batching contract.
- [ ] **Test-fixture bridge lockdown.** Any fixture bridge in the compiled
  runtime requires explicit acceptance-only opt-in, loopback-only transport,
  strong ephemeral credentials, and a built-output negative activation test.
- [ ] **Strict SEC identity relationships.** Validation proves the relationships
  among accession, CIK, form/file number, registration/amendment identity,
  classification, and canonical filing URL rather than validating each field's
  shape independently.
- [ ] **True concurrent compiled-worker isolation and teardown.** Two production-
  path compiled workers overlap in execution, reach clean terminal outcomes,
  retain isolated state/capabilities, and leave no worker/runtime teardown leak.

Pass A re-review did not accept the occurrence-recovery or Redis-atomicity
claims. The remaining acceptance work is:

- [ ] **A3 — reclaimed-attempt occurrence recovery.** Production lease expiry
  assigns a new run ID for the same occurrence. A non-model recovery admission
  must run before normal model concurrency and budget gates, then recover and
  apply the prior outcome using occurrence identity. Acceptance keeps attempt
  1's uncertain budget reserved, reclaims attempt 2, and proves attempt 2 makes
  no reservation, model call, source fetch, or provider charge. R5 owns
  reconciliation of attempt 1's reservation; A3 must not release or claim it
  settled.
- [ ] **A4 — invalid recovery fails durably.** Missing, corrupt, incompatible, or
  stale recovery data must create an explicit durable failure state with a
  bounded reason and must never fall through to a fresh model execution. A
  failure to persist recovery quarantine or clean up its lease may be swallowed
  only after an authoritative re-read proves that a concurrent lifecycle,
  configuration, or occurrence change superseded that exact operation;
  otherwise the schedule must fail visibly.
- [ ] **Redis identity/outcome race proof — unverified in this environment.** Run
  the new Lua identity/outcome transaction against real ephemeral Redis with
  competing claims and recovery attempts, proving one canonical outcome and no
  duplicate model, fetch, finding, alert, or charge.

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
