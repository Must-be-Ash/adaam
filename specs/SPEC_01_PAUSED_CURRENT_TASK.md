# Spec 1 functional-completion handoff

This is the canonical live status for Spec 1. The product contract remains in
`01-independent-workspace-runtimes.md`; `SPEC_01_REVIEW_FINDINGS.md` is a
historical hardening ledger and must not be treated as the product-first work
queue.

## Current status

The local polling product is implemented and independently reviewed. The
ordinary owner workflow now reaches the complete application path:

1. create or explicitly migrate an `IPO Filings` workspace monitor;
2. persist its authenticated Photon delivery subscription;
3. claim its schedule and run the compiled isolated Eve worker;
4. fetch and deterministically evaluate the exact SEC S-1 feed;
5. commit a typed finding, alert, and checkpoint;
6. deliver the alert to Photon with the authoritative workspace name, observed
   time, canonical public source, **Discuss**, and **Manage** actions;
7. route Discuss context to the selected workspace's next turn; and
8. show monitor schedule, sources, health, last/next run, budget limits, current
   token/paid usage, and active workers in the session manager.

The previously isolated R3 work was completed, reviewed, and merged into local
`main`. The remaining functional-completion work is on
`codex/spec-01-functional-completion` and is to be merged locally after its
documentation commit. Nothing has been pushed or deployed.

Use at most two worktrees: `/Users/ashnouruzi/dev/adaam` on `main` and one
temporary worktree for the active bounded slice. Merge each accepted slice back
to local `main`, then remove its worktree and branch.

## Product work completed in the final pass

- Added the missing production scheduled-outcome → Photon alert caller.
- Added durable Photon alert subscriptions for both newly created and explicitly
  migrated legacy monitors.
- Split the outbound Photon adapter from the inbound channel so the scheduler
  and compiled Eve build do not initialize the channel as an import side effect.
- Added **Discuss** and **Manage** to the delivered alert app.
- Resolved the current authoritative workspace name at delivery and Discuss
  time; retained the finding observation time and canonical public source URL.
- Proved a realistic 40-fact SEC outcome exceeds the old 32 KiB record limit and
  commits under a still-bounded 128 KiB ceiling.
- Made the manager visibly render schedule/timezone, sources, monitor counts and
  health, budget limits, daily/monthly usage, and active worker count.
- Added an explicit Photon rollout matrix: fully absent/off new configuration
  preserves legacy chat/session-manager/approval behavior; partial or enabled
  configuration fails closed; complete configuration uses durable owner and
  ingress receipts.
- Independently reviewed both the alert-delivery slice and the final functional
  slice; all ordinary-path findings were fixed and the final review found no
  remaining product blocker.

## Verification completed

- TypeScript typecheck.
- Eve production build.
- Next.js 16 webpack production build.
- Owner workflow, monitor CRUD/migration, manager, rollout, budget, findings,
  alert store/subscription/delivery/context/reply/app, recovery schedule,
  start-fresh, owner/workspace isolation, Photon approval/workspace regressions,
  and compiled scheduled SEC worker acceptance.

The compiled acceptance still prints intentional negative-fixture failures and
an Eve workflow teardown warning after its pass marker. Its exit status is zero;
clean teardown is retained below as test/framework hardening rather than a
functional blocker.

## Not performed because it requires owner authorization

- Production environment changes.
- Deployment or enabling runtime flags.
- A real Photon/iMessage alert, Discuss, and manager smoke.
- Pushes, PRs, or changes to remote `main`.

Those are rollout operations, not missing local application code.

## Deliberately deferred until after the remaining product specs

The following are real hardening/operations work, but they are not blockers to
the ordinary polling application and should not displace Specs 2–6:

- no-follow redirect transport, fixture-bridge defense in depth, stricter
  cross-field SEC identity validation, and compiled-worker teardown proof;
- crash-only recovery for stranded alert, ingress, response, Discuss, and held-
  reply intermediate states;
- expired reservation reconciliation, ambiguous worker-start accounting, and
  concurrent brief/strategy/budget revision revalidation;
- atomic archive/restore convergence, production log/privacy catalog cleanup,
  quarantine/operator reports, retention, metrics, and the private Eve runtime
  version boundary.

Sprint 7 RSS/WebSub source-event ingestion is also deferred. It is a separate
feature, not required by the agreed polling-first IPO workflow, and should be
specified after the versioned source-adapter foundation in Spec 3 rather than
holding Spec 1's working polling application open.

## Next project action

After merging and removing the temporary functional-completion worktree, begin
`02-versioned-strategy-packs.md` on one new temporary worktree. Production
rollout can be performed separately whenever the owner explicitly authorizes
it. Return to the hardening ledger only after the remaining product specs are
implemented, unless a deferred item becomes an observed ordinary-path failure.
