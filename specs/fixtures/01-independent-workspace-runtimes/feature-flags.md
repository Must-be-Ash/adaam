# Spec 1 feature flags and rollback contract

All new workspace-runtime surfaces are disabled unless their environment value
is exactly `1`. Unknown, empty, or differently formatted values fail closed.
Reads of already-created workspace-runtime records remain available to owner-
authorized recovery and operator inspection when dispatch is disabled.

Photon ingress has a separate compatibility boundary. Complete owner mapping
(`EVE_DEPLOYMENT_OWNER_ID`, `EVE_PHOTON_OWNER_PRINCIPALS`, and
`EVE_OWNER_ALIAS_HMAC_SECRET`) plus one complete Redis REST URL/token pair
switches Photon to durable owner-authorized ingress even when all workspace
runtime flags remain `0`. Partial owner or Redis configuration fails closed.
Returning to legacy ingress requires all runtime flags off and removal of the
complete owner configuration; disabling dispatch alone does not do that.

| Environment variable | Effective behavior when enabled |
| --- | --- |
| `EVE_WORKSPACE_STATE_ENABLED` | Enables versioned workspace-runtime state. Every nested workspace-runtime flag requires it, but durable Photon ingress is selected separately by complete owner-plus-Redis configuration. |
| `EVE_WORKSPACE_MONITOR_WRITES_ENABLED` | Enables new workspace-monitor mutations and automatically disables creation of legacy event-trigger records. |
| `EVE_WORKSPACE_DISPATCH_ENABLED` | Allows new workspace-monitor worker dispatch. Turning it off is the primary rollback: records, checkpoints, leases, findings, alerts, and ledgers are retained. |
| `EVE_WORKSPACE_PAID_RESEARCH_ENABLED` | Allows the paid-research reservation path only while workspace dispatch is also enabled. Capability grants and sufficient budget remain separately required. |
| `EVE_PHOTON_WORKSPACE_ALERTS_ENABLED` | Allows delivery attempts for staged workspace alerts. Turning it off preserves the alert/outbox and delivery receipts. |
| `EVE_WORKSPACE_SOURCE_EVENTS_ENABLED` | Allows authenticated source-event ingestion. Polling remains the fallback and has a separate dispatch gate. |
| `EVE_LEGACY_TRIGGER_CREATION_ENABLED` | Defaults enabled while workspace-monitor writes are off. Set to `0` to stop legacy creation earlier; it can never override enabled workspace-monitor writes. |

Strategy packs add four nested, independently failing-closed switches. They do
not change the durable-ingress boundary above.

| Environment variable | Effective behavior when enabled |
| --- | --- |
| `EVE_STRATEGY_PACK_CATALOG_ENABLED` | Exposes the compiled repository catalog to the configured deployment owner while workspace state is enabled. Disabling it preserves bindings and records. |
| `EVE_STRATEGY_PACK_MUTATIONS_ENABLED` | Allows create/configure/remove through the shared service while catalog, workspace state, and monitor writes are enabled. |
| `EVE_STRATEGY_PACK_RUNTIME_ENABLED` | Composes an exact active binding into interactive and worker runtimes. Disabling it makes bound sessions unavailable rather than general purpose. |
| `EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED` | Allows pack-managed monitors to pass worker preparation only while pack runtime and workspace dispatch are enabled. |

## Rollout order

1. Configure and verify the complete owner mapping plus Redis pair. This is the
   durable-ingress cutover; unmapped principals and storage failures must deny
   rather than fall back to legacy dispatch.
2. Enable workspace state and read-only inspection.
3. Enable workspace-monitor writes; legacy trigger creation stops at this step.
4. Enable polling dispatch with paid research and Photon workspace alerts still
   disabled.
5. Enable Photon workspace alerts after fixture and read-only live smokes pass.
6. Enable paid research only after a provider-specific review and noninteractive
   authorization exist.
7. Enable source events last, under their independent kill switch, while polling
   remains available.

For strategy packs, deploy the dual-reader release with all four pack switches
off. Verify mixed unbound/v1/v2 reads before enabling catalog inspection,
mutations in fixture/dev, runtime composition, Spectrum controls, managed
dispatch, and finally an owner-authorized Photon smoke. Treat every flag change
as a deployment/propagation event and capture the resolved values.

## Rollback behavior

The safe rollback is to set `EVE_WORKSPACE_DISPATCH_ENABLED=0`. No new worker is
dispatched. A worker or delivery already known to have started must settle into
its durable terminal or uncertain state; it is never blindly replayed. New
workspace records are not deleted or rewritten into legacy records.

Disable `EVE_PHOTON_WORKSPACE_ALERTS_ENABLED` to stop new Photon alert sends
without discarding staged alerts or receipts. Disable
`EVE_WORKSPACE_PAID_RESEARCH_ENABLED` to block new paid reservations; uncertain
charges remain reserved for reconciliation. Disable
`EVE_WORKSPACE_SOURCE_EVENTS_ENABLED` to reject new source-event ingress while
retaining polling and previously accepted records.

If workspace-monitor creation itself must roll back, disable
`EVE_WORKSPACE_MONITOR_WRITES_ENABLED`; legacy creation may then resume only if
`EVE_LEGACY_TRIGGER_CREATION_ENABLED` is not `0`. Existing workspace monitors
remain versioned and recoverable. No rollback mode guesses a legacy trigger's
workspace, deletes durable state, advances an uncertain checkpoint, or enables
background financial mutations.

This worker rollback preserves durable Photon ingress. Return to legacy ingress
only as a separate, deliberate compatibility rollback after every runtime flag
is off and the complete owner mapping is removed. Never remove owner mapping as
the first response to an in-flight dispatch or alert incident.

Pack rollback is additive to those controls: disable managed dispatch first,
then runtime composition, mutations, and catalog exposure as needed. Keep the
reader-compatible binary and every compiled version still referenced by a
durable binding. Bindings, managed monitors, mutation receipts, findings,
alerts, checkpoints, and retired-resource provenance remain readable. To block
a faulty version, mark that exact catalog entry blocked, disable managed
dispatch during propagation, inspect bound sessions through the owner-only
manager/service, and verify the scheduler starts no managed worker before
re-enabling unaffected versions. Failure must never select a different version
or turn a bound session into a general-purpose session.
