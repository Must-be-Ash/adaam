# Spec 1 durable state diagrams

These diagrams freeze the contract exercised by `state-machines.json`. They are
not evidence that the production stores exist yet. A transition absent from the
machine manifest is denied by default.

## `owner_mapping`, `workspace_assignment`, `finding`, and `alert`

```mermaid
flowchart LR
  owner_configured["Owner configured"] --> owner_revoked["Owner revoked"]
  assignment_unassigned["Assignment unassigned"] --> assignment_assigned["Assignment assigned (immutable)"]
  finding_staged["Finding staged"] --> finding_committed["Finding committed"]
  finding_staged --> finding_rejected["Finding rejected"]
  alert_staged["Alert staged"] --> alert_ready["Alert ready"] --> alert_retired["Alert retired"]
```

## `photon_ingress`

```mermaid
stateDiagram-v2
  [*] --> received
  received --> assigned
  received --> intercepted
  received --> held
  held --> assigned
  assigned --> dispatching
  dispatching --> dispatched
  dispatched --> completed
  intercepted --> completed
  dispatching --> uncertain
  dispatched --> uncertain
  uncertain --> quarantined
  quarantined --> resolved
```

## `dispatch`

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> dispatching
  dispatching --> dispatched
  dispatched --> completed
  dispatching --> uncertain
  dispatched --> uncertain
  uncertain --> quarantined
  quarantined --> resolved
```

## `workspace`

```mermaid
stateDiagram-v2
  [*] --> active
  active --> archived
  archived --> active
  active --> retired
  archived --> retired
```

## `monitor`

```mermaid
stateDiagram-v2
  [*] --> enabled
  enabled --> paused
  enabled --> paused_failure
  enabled --> suspended_archived
  paused --> suspended_archived
  paused_failure --> suspended_archived
  suspended_archived --> paused
  paused --> enabled
  paused_failure --> enabled
  enabled --> retired
  paused --> retired
  paused_failure --> retired
  suspended_archived --> retired
```

## `run`

```mermaid
stateDiagram-v2
  [*] --> due
  due --> leased
  leased --> dispatched
  dispatched --> running
  running --> no_match
  running --> finding_staged
  running --> retryable_failure
  running --> terminal_failure
  finding_staged --> alert_staged
  alert_staged --> completed
```

## `budget`

```mermaid
stateDiagram-v2
  [*] --> available
  available --> reserved
  reserved --> reconciled
  reserved --> released
  reserved --> uncertain
  uncertain --> reconciled
  uncertain --> released
```

## `delivery`

```mermaid
stateDiagram-v2
  [*] --> staged
  staged --> delivering
  staged --> retryable_failure
  delivering --> delivered
  delivering --> retryable_failure
  retryable_failure --> delivering
  delivering --> delivery_uncertain
  delivery_uncertain --> resolved
```

## `routing_decision`

```mermaid
stateDiagram-v2
  [*] --> received
  received --> held
  held --> assigned
  held --> expired
  assigned --> dispatched
  dispatched --> completed
```
