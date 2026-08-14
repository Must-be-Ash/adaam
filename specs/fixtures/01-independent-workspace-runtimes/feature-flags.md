# Spec 1 feature flags and rollback contract

All new workspace-runtime surfaces are disabled unless their environment value
is exactly `1`. Unknown, empty, or differently formatted values fail closed.
Reads of already-created workspace-runtime records remain available to owner-
authorized recovery and operator inspection when dispatch is disabled.

| Environment variable | Effective behavior when enabled |
| --- | --- |
| `EVE_WORKSPACE_STATE_ENABLED` | Enables versioned workspace-runtime state. Every other new flag also requires this master state flag. |
| `EVE_WORKSPACE_MONITOR_WRITES_ENABLED` | Enables new workspace-monitor mutations and automatically disables creation of legacy event-trigger records. |
| `EVE_WORKSPACE_DISPATCH_ENABLED` | Allows new workspace-monitor worker dispatch. Turning it off is the primary rollback: records, checkpoints, leases, findings, alerts, and ledgers are retained. |
| `EVE_WORKSPACE_PAID_RESEARCH_ENABLED` | Allows the paid-research reservation path only while workspace dispatch is also enabled. Capability grants and sufficient budget remain separately required. |
| `EVE_PHOTON_WORKSPACE_ALERTS_ENABLED` | Allows delivery attempts for staged workspace alerts. Turning it off preserves the alert/outbox and delivery receipts. |
| `EVE_WORKSPACE_SOURCE_EVENTS_ENABLED` | Allows authenticated source-event ingestion. Polling remains the fallback and has a separate dispatch gate. |
| `EVE_LEGACY_TRIGGER_CREATION_ENABLED` | Defaults enabled while workspace-monitor writes are off. Set to `0` to stop legacy creation earlier; it can never override enabled workspace-monitor writes. |

## Rollout order

1. Enable workspace state and read-only inspection.
2. Enable workspace-monitor writes; legacy trigger creation stops at this step.
3. Enable polling dispatch with paid research and Photon workspace alerts still
   disabled.
4. Enable Photon workspace alerts after fixture and read-only live smokes pass.
5. Enable paid research only after a provider-specific review and noninteractive
   authorization exist.
6. Enable source events last, under their independent kill switch, while polling
   remains available.

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
