# Spec 1: Independent workspace runtimes

Status: Draft for implementation

Date: 2026-08-13

Product target: `NORTH_STAR.md`

Reference acceptance workspace: `IPO Filings`

## How to use this specification

This is the first bounded implementation specification on the path to the Eve
North Star. It covers the shared foundation that lets multiple specialized
workspace agents remain continuously active without permanently running model
processes. It does not implement the complete Congressional Signals, Insider
Clusters, or Cramer Inverse strategies.

Every implementation item is a checklist entry. Complete the sprints in order.
Do not mark an item complete until its tests and the sprint exit gate pass. If
implementation reveals a product decision that contradicts this specification,
stop and resolve it with the owner instead of silently widening the scope.

## Goal

Allow every enabled workspace to own durable monitors that wake bounded,
isolated workers on schedules or source events, even when another workspace is
selected for the owner's current iMessage conversation.

The selected workspace controls only where an ordinary unqualified iMessage is
routed. It does not start, stop, or pause background work in other workspaces.

The completed foundation must support this experience:

1. The owner creates an `IPO Filings` workspace.
2. In that workspace, the owner asks Eve to check for new SEC S-1 filings every
   day at 9:00 AM in the owner's timezone.
3. The owner later says, “Also run this at 4:00 PM,” and Eve edits the same
   workspace-owned monitor.
4. The owner switches to `Insider Clusters`; the IPO monitor continues running.
5. A bounded IPO worker detects a new filing and sends an iMessage alert headed
   **IPO Filings** without changing the selected workspace.
6. The owner taps **Discuss in IPO Filings**. Eve atomically selects that
   workspace and makes the referenced alert available to its next turn.
7. The session manager shows the monitor's schedule, sources, budget, status,
   last run, next run, and pause/resume controls.
8. Starting the workspace fresh preserves its monitors, brief, and findings.
   Archiving it pauses its monitors; restoring it leaves them paused until the
   owner explicitly resumes them.

## Agreed product decisions

- [ ] Use one user-facing Eve identity and a deterministic control plane. Do
  not introduce a model-powered “mother agent” with access to every workspace.
- [ ] Treat each workspace as the durable specialized agent. A workspace owns
  its goal, bounded brief, structured findings, monitors, capabilities, and
  budget.
- [ ] Execute background work through bounded Eve task sessions that wake for
  one run and then exit. Do not keep idle model processes alive.
- [ ] Implement Photon/iMessage only. Keep core records independent of Photon
  delivery mechanics so another delivery adapter can be added later.
- [ ] Bind each monitor immutably to one workspace. Its schedule, sources,
  instruction, status, capabilities, and budget may be edited; moving it to
  another workspace requires an explicit clone or replacement operation.
- [ ] Support natural-language monitor management inside the owning workspace
  and monitor visibility/control in the existing session manager.
- [ ] Allow paid research only when the workspace explicitly permits the
  provider and has sufficient configured budget.
- [ ] Never allow a background worker to submit a live broker mutation. It may
  produce research, signals, and a proposed order, but live execution retains
  fresh preview, revalidation, and exact owner approval.
- [ ] Deliver alerts from non-selected workspaces without silently changing the
  conversation's selected workspace.
- [ ] Implement recurring polling first. Only after its complete acceptance
  gate passes, add the source-event ingestion phase defined later in this spec.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Owner | The one person who controls this deployment. Approved Photon principals may be aliases of that owner. |
| Conversation | One authenticated Photon principal and physical iMessage thread. |
| Selected workspace | The workspace that receives ordinary unqualified messages in a conversation. This is a routing pointer, not a runtime status. |
| Workspace | A durable specialized agent container with isolated state, monitors, tools, skills, and budget. |
| Session generation | Temporary Eve conversation history for a workspace. `Start fresh` replaces it without deleting workspace state. |
| Monitor | An editable, durable instruction and trigger configuration owned by one workspace. |
| Worker | A stateless, bounded Eve task session for one monitor occurrence. It is not user-facing and cannot read workspace chat history. |
| Finding | A structured, provenance-bearing result written by a worker to its workspace. |
| Alert | A workspace-labeled notification derived from a durable finding and delivered through the control plane. |
| Control plane | Deterministic application code for identity, routing, lifecycle, budgets, monitor control, alert delivery, and approvals. It runs no strategy. |

## Scope

### In scope

- Stable owner and workspace identity for Photon-created background work.
- Deployment-owner authorization across Photon session routing, session and
  monitor management, background dispatch, and alert delivery.
- Immutable Photon ingress receipts, one durable workspace assignment before
  model dispatch, idempotent completion, and uncertain-delivery quarantine.
- Workspace-owned durable briefs and structured findings.
- Default-deny workspace capability manifests.
- Configurable per-workspace run, concurrency, token, and paid-research budgets.
- Editable one-time, interval, and local-time daily schedules.
- Concurrent runs across different workspaces using isolated Eve task sessions.
- Exact source fencing, source checkpoints, idempotent run state, and durable
  alert delivery.
- Workspace-labeled Photon alerts with **Discuss in workspace** and **Manage
  sessions** actions.
- Safe confirmation for a likely reply to an alert from a non-selected
  workspace.
- Natural-language monitor CRUD in the owning workspace.
- Monitor and budget controls in the Spectrum session manager.
- Explicit migration of existing owner/conversation event triggers.
- A polling-first `IPO Filings` reference implementation and deterministic SEC
  Atom fixtures.
- A normalized source-event envelope and a later source-event ingestion sprint.

### Out of scope

- Complete Pelosi/Congressional copy-trading logic.
- Complete Insider Clusters, Cramer Inverse, or other strategy packs under
  `idea/`.
- Automatic live trading or any relaxation of financial approval invariants.
- General topic-change detection for all ordinary messages. This spec adds only
  the bounded alert-reply routing guard needed for workspace alerts.
- Telegram or HTTP workspace routing and delivery.
- Sharing one workspace across multiple Photon conversations. This spec creates
  stable owner and delivery abstractions but retains one originating Photon
  conversation per workspace subscription.
- Cross-workspace chat-history access or automatic merging of workspace notes.
- Cross-workspace convergence scoring. A later spec may promote typed public
  signals through a reviewed shared-evidence plane.
- Full conversion of the `idea/` research corpus into versioned strategy packs.
- Production activation of a specific paid provider in task-mode workers. This
  spec delivers the capability, budget, and reservation contracts plus a fake
  provider test adapter; each real provider requires a focused security review.
- Owner-private storage for large files or raw paid outputs. This project does
  not need that capability for this foundation; findings stay bounded and
  public source files are referenced by canonical URL.
- Permanent model processes, model-managed queues, or model-owned scheduling.

## Non-negotiable invariants

- [ ] Every authenticated Photon message that can cause a control-plane or model
  action receives one immutable ingress receipt. An ordinary message is assigned
  to exactly one workspace before any workspace model sees it.
- [ ] Duplicate Photon webhooks reuse the original ingress receipt and cannot
  cause a second model dispatch, control action, paid call, or response.
- [ ] A dispatch or outbound delivery whose completion cannot be proven is
  quarantined for reconciliation; it is never replayed blindly.
- [ ] The selected-workspace pointer affects interactive routing only. It never
  controls whether another workspace's monitors run.
- [ ] A worker receives only its workspace ID, monitor configuration, bounded
  brief, approved structured findings, declared sources, and allowed
  capabilities.
- [ ] A worker cannot read any workspace's raw chat history, including its own.
- [ ] No workspace can read or mutate another workspace's brief, findings,
  monitors, budget, runs, or alerts.
- [ ] Model-supplied owner IDs and arbitrary workspace IDs are never trusted.
  Interactive tools derive the current workspace from authenticated routing
  context; runtime tools derive it from signed control-plane auth.
- [ ] A session manager action changes control-plane state only and cannot
  authorize a financial mutation.
- [ ] Background runtime capabilities always deny live broker mutations,
  transfers, withdrawals, leverage, credential changes, and interactive HITL.
- [ ] A workspace capability setting may tighten deployment limits but cannot
  loosen a hard global safety limit.
- [ ] Paid operations reserve budget before execution. An uncertain paid result
  is not automatically retried.
- [ ] Every ingress, assignment, dispatch, run, source event, finding, alert,
  delivery, and control action has a durable idempotency key.
- [ ] At-least-once Eve delivery must not create duplicate alerts or duplicate
  paid calls.
- [ ] Alerts do not silently switch the selected workspace.
- [ ] Public-source facts preserve canonical URL, source identity, observed time,
  published/updated time when available, content hash, and access classification.
- [ ] Logs and metrics never include message bodies, alert bodies, source URLs,
  owner/principal IDs, workspace IDs, monitor IDs, or other high-cardinality or
  private values.

## Target architecture

```mermaid
flowchart LR
    P["Photon / iMessage"] --> I["Ingress receipt and durable assignment"]
    I --> C["Deterministic Eve control plane"]
    C --> R["Conversation routing pointer"]
    C --> M["Session and monitor manager"]
    C --> D["Photon delivery adapter"]

    W1["IPO Filings workspace"] --> B1["Brief, findings, capabilities, budget"]
    W2["Insider Clusters workspace"] --> B2["Brief, findings, capabilities, budget"]

    S["Minute dispatcher"] --> Q["Durable monitor queue and leases"]
    E["Normalized source events"] --> Q
    Q --> X1["Bounded worker run"]
    Q --> X2["Bounded worker run"]
    X1 --> B1
    X2 --> B2
    X1 --> O["Durable workspace alert outbox"]
    X2 --> O
    O --> C
    D --> P
```

The control plane knows workspace manifests and routing metadata, not strategy
histories. Workers run in separate Eve task sessions. Two workspaces may run at
the same time; the same monitor is single-flight.

## Durable records

All records are versioned schemas validated at every read boundary. Storage
keys must include the stable owner and workspace scope where applicable.

### Owner identity

`OwnerIdentity` provides one stable deployment owner ID and an explicit set of
approved Photon principal aliases.

- [ ] Add a server-side owner mapping that fails closed for an unmapped Photon
  principal.
- [ ] Keep real principals in encrypted deployment configuration, never tracked
  source or Redis values that are returned to the model.
- [ ] Store a non-reversible stable alias for ownership checks and indexes.
- [ ] Enforce the owner mapping before reading or mutating Photon session state,
  monitor state, runtime state, manager capabilities, or alert destinations.
- [ ] Add negative tests proving an authenticated but unmapped Photon principal
  cannot list sessions, select a workspace, manage monitors, start workers, or
  receive owner-only workspace data.
- [ ] Keep the existing Coinbase allowlist separate; it is not the general
  deployment owner boundary.

### Conversation routing record

`ConversationRoutingRecord` remains scoped to the authenticated Photon
conversation and contains:

- owner ID;
- physical conversation address stored only in the delivery layer;
- selected workspace ID;
- revision and last mutation ID; and
- recent alert-routing candidates containing IDs and timestamps, not bodies.

The existing workspace registry may remain conversation-originated in this
spec. A later cross-conversation session-broker spec can make workspaces
shareable across owner conversations without changing monitor or alert identity.

### Photon ingress and workspace dispatch receipts

Every authenticated Photon webhook that can cause a control-plane or model
action first creates or reuses an immutable `PhotonIngressReceipt`. Ordinary
messages then receive one immutable workspace assignment before dispatch.
Approval replies and explicit session-management requests may be intercepted by
their deterministic control protocols, but they use the same ingress dedupe and
completion contract.

The ingress and dispatch records include:

- ingress ID, Photon webhook/event dedupe key, owner ID, conversation ID, and
  received time;
- input classification of ordinary message, approval reply, session-management
  request, or held alert reply, without copying message text into indexes or
  logs;
- for ordinary or held messages, the assigned workspace ID, session generation,
  routing-pointer revision, assignment reason, and assignment time;
- dispatch request ID, attempt state, Eve continuation target, and timestamps;
- control-action, model-dispatch, response-delivery, and completion receipt IDs
  where applicable; and
- bounded failure code, quarantine reason, and operator resolution metadata.

The durable state machines are:

```text
received -> assigned -> dispatching -> dispatched -> completed
received -> intercepted -> completed
received -> held -> assigned -> dispatching -> dispatched -> completed
dispatching|dispatched -> uncertain -> quarantined -> resolved
```

- [ ] Authenticate and authorize the Photon principal before creating an
  owner-scoped receipt or reading any workspace state.
- [ ] Atomically create the receipt by Photon event dedupe key so concurrent
  duplicate webhooks cannot both continue.
- [ ] Resolve and persist the target workspace and session generation before
  constructing the workspace model turn. Once dispatch begins, that assignment
  is immutable even if the conversation's selected-workspace pointer changes.
- [ ] Make dispatch completion idempotent by ingress and dispatch request IDs.
- [ ] Record outbound response delivery separately from model dispatch so an
  uncertain Photon send is not mistaken for an unexecuted model turn.
- [ ] Quarantine uncertain model dispatch or response delivery instead of
  replaying it. Recovery may resume only after authoritative reconciliation or
  an explicit owner/operator resolution recorded on the receipt.
- [ ] Bound receipt payloads and retention. Store only the references or digests
  needed for dedupe, routing, recovery, and audit; never emit message content in
  logs or metrics.

### Workspace record

Extend the current `PhotonWorkspace` contract or add an adjacent versioned
record with:

- stable owner ID and workspace ID;
- display name and lifecycle state;
- optional strategy-pack reference and version;
- current session generation;
- brief revision;
- capability-manifest revision;
- budget-policy revision;
- created/updated timestamps; and
- optimistic concurrency revision.

Do not embed monitor arrays, findings, source payloads, or Photon destinations
inside the workspace record.

### Workspace brief

`WorkspaceBrief` is bounded durable rehydration state, independent of session
history:

- workspace goal and thesis;
- approved strategy-pack configuration;
- watchlist/entity references;
- source policy;
- bounded current findings summary;
- open questions and last material change;
- schema and content revision; and
- provenance for every machine-promoted fact.

- [ ] Define a strict serialized byte ceiling and per-field bounds.
- [ ] Update through compare-and-set so concurrent workers cannot overwrite a
  newer brief.
- [ ] Do not let a worker rewrite safety policy, its capability manifest, or its
  budget through a brief update.
- [ ] Keep bounded structured findings in owner-scoped storage. Reference public
  filings by canonical URL and reject private or unbounded large outputs.

### Capability manifest

`WorkspaceCapabilityManifest` is default-deny and names only what the workspace
may use:

- skill IDs and versions;
- model-facing tool IDs;
- source IDs and exact source URL origins;
- optional connection/provider IDs;
- whether paid research is allowed;
- maximum data access classification;
- worker model policy; and
- hard-denied capabilities inherited from the shared core.

Default-deny means an omitted tool, skill, source, provider, or data class is
unavailable. It does not prevent the owner from explicitly expanding the
workspace's research abilities within hard deployment limits.

- [ ] Compare each connected provider's current tool inventory and schemas with
  the reviewed manifest. Report removed, newly discovered, and schema-changed
  tools; never expose a new or changed tool automatically.
- [ ] Keep newly discovered mutations disabled even when a provider dynamically
  registers them.
- [ ] Return a typed unavailable-capability reason—authorization, safety policy,
  runtime restriction, missing integration, or provider drift—rather than
  hallucinating a result or claiming the provider lacks the capability.
- [ ] Add deterministic drift fixtures for a removed tool, a new read tool, a
  new mutation, and a schema-changing existing tool.

### Workspace budget policy

`WorkspaceBudgetPolicy` includes:

- maximum scheduled runs per day;
- maximum concurrently running workers;
- maximum input/output tokens per run and per day;
- optional paid-research ceiling per call;
- optional paid-research ceiling per day and per calendar month;
- unknown-price fallback ceiling;
- owner timezone for calendar windows; and
- policy revision and effective time.

Money is stored and compared as decimal strings or integer minor units, never
binary floating point. `null` means “inherit the deployment cap,” not unlimited.

### Workspace monitor

`WorkspaceMonitor` includes:

- stable monitor ID, owner ID, and immutable workspace ID;
- name and bounded evidence-based instruction;
- lifecycle state and reason;
- schedule or source-event trigger;
- timezone and next occurrence;
- optional owner-defined end time (no automatic 90-day expiry);
- declared source IDs and canonical URLs;
- required skill/tool/provider capabilities;
- optional monitor-level limits that only tighten the workspace budget;
- configuration revision;
- source checkpoint/window;
- last/next run metadata and consecutive failures;
- originating delivery-subscription ID; and
- created/updated timestamps.

Supported schedule variants:

```text
one_time(at)
interval(anchor, everyMinutes)
daily_local(timezone, times[HH:mm])
source_event(subscriptionIds[])   # enabled in the later source-event sprint
```

The `daily_local` form is required for “9 AM and 4 PM” and must not be reduced
to a drifting interval. A recurring monitor continues until the owner pauses,
archives, retires, or explicitly time-bounds it.

### Monitor run

`WorkspaceMonitorRun` snapshots everything needed for deterministic execution:

- run ID and deterministic occurrence key;
- owner, workspace, and monitor IDs;
- monitor configuration revision;
- brief, capability, and budget revisions;
- scheduled/event occurrence and evaluation window;
- lease owner and expiry;
- reserved run/token/paid budget;
- source-attempt and source-success sets;
- outcome and bounded error code; and
- finding/alert IDs created by the run.

### Finding and alert

`WorkspaceFinding` contains structured public or private evidence with schema
version, producer workspace, monitor/run IDs, provenance, as-of time, access
classification, content hash, and optional durable artifact references.

`WorkspaceAlert` references a finding and contains bounded presentation data,
workspace display metadata, source references, and a stable alert ID. It never
contains a Photon thread ID.

`AlertDeliverySubscription` and `AlertDeliveryReceipt` live in the delivery
layer. This spec supports one originating Photon conversation subscription per
workspace monitor while keeping the core alert channel-independent.

## State and transition contracts

### Workspace lifecycle

```text
active -> archived -> active
active|archived -> retired
```

- [ ] Archiving atomically prevents new interactive routing, pauses/suspends all
  monitors, revokes pending workspace approvals, and selects a replacement if
  the archived workspace was selected.
- [ ] Restoring returns the workspace to `active` but converts its monitors to
  manual `paused`; none resume automatically.
- [ ] Starting fresh advances the session generation and revokes approvals tied
  to the old generation while preserving briefs, findings, monitors,
  capabilities, budgets, and delivery subscriptions.
- [ ] Retirement is recoverable product state. Do not claim hard deletion of
  Eve or external provider records.

### Monitor lifecycle

```text
enabled -> paused
enabled|paused -> suspended_archived
suspended_archived -> paused
enabled -> paused_failure
paused|paused_failure -> enabled
any nonterminal state -> retired
```

- [ ] Store why and when a monitor paused.
- [ ] Pause automatically after the configured consecutive-failure threshold.
- [ ] Require an explicit owner action to resume after archive restoration,
  budget exhaustion requiring policy change, or uncertain alert checkpoint.
- [ ] Updating a monitor increments its revision; an old claimed run must fail
  revalidation before executing tools or committing results.

### Run lifecycle

```text
due -> leased -> dispatched -> running
running -> no_match | finding_staged | retryable_failure | terminal_failure
finding_staged -> alert_staged -> completed
```

- [ ] Claims are atomic, leases expire, and expired work is recoverable.
- [ ] The same occurrence key can never produce two committed findings or
  alerts.
- [ ] Different workspaces may run concurrently.
- [ ] A monitor is single-flight. Default workspace concurrency is one worker;
  the owner may raise it only within a hard deployment cap.
- [ ] Concurrent writes to one workspace use compare-and-set and retry only the
  state merge, never an already-completed paid call.

### Alert delivery lifecycle

```text
staged -> delivering -> delivered
staged|delivering -> retryable_failure
delivering -> delivery_uncertain
```

- [ ] A delivered alert is deduplicated by stable alert and destination IDs.
- [ ] If Photon accepted the message but receipt persistence is uncertain,
  quarantine the delivery and pause the monitor instead of sending it again.
- [ ] A failed alert does not advance the source checkpoint until safe retry or
  explicit operator resolution.

## Scheduling semantics

- [ ] Retain one static minute dispatcher. It atomically claims due monitor
  occurrences and dispatches bounded Eve task sessions through the existing
  internal runner pattern.
- [ ] Represent local daily schedules as timezone plus unique sorted `HH:mm`
  values.
- [ ] On a spring-forward nonexistent local time, run once at the next valid
  local instant.
- [ ] On a fall-back repeated local time, run once using a local-date/time
  occurrence key.
- [ ] Editing a schedule recomputes the next occurrence without replaying a
  time already completed under the new revision.
- [ ] After downtime, execute at most the newest missed occurrence inside a
  configured recovery window; record older occurrences as skipped so recovery
  cannot create a catch-up storm.
- [ ] Reserve daily run capacity when enabling or expanding a schedule. Reject
  a change whose projected cadence exceeds the workspace or deployment cap.
- [ ] Preserve existing global trigger limits until explicitly replaced by
  equal or stricter deployment limits.

Eve provides durable task sessions, but dynamic schedules remain application
state. Delivery is at least once, so occurrence keys and application-level
idempotency are mandatory.

## Worker execution contract

Each occurrence starts a new isolated Eve task session addressed by the stable
run ID. It must not send a message to the workspace's interactive continuation.

The control plane provides signed runtime auth containing only opaque owner,
workspace, monitor, run, and revision claims. Runtime tools re-read authoritative
records and verify all claims before acting.

The worker receives:

- shared safety instructions;
- the workspace's allowed strategy skill(s);
- a bounded workspace brief;
- the monitor instruction and evaluation window;
- exact configured sources;
- bounded relevant prior findings; and
- dynamically registered tools permitted by the capability manifest.

The worker does not receive:

- raw interactive chat history;
- another workspace's manifest, state, or alerts;
- arbitrary web/search access unless explicitly allowed;
- user OAuth that could pause for authorization;
- session-manager or approval capabilities;
- broker mutation tools; or
- shell/filesystem tools unless a later reviewed capability explicitly needs
  them and the shared core permits them.

- [ ] Build worker prompts from typed records, not concatenated model prose from
  another session.
- [ ] Enforce exact source fencing in both prompt and tool execution.
- [ ] Require every configured source to be attempted at most once per run and
  successfully covered before committing no-match or alert state.
- [ ] Keep provider result normalization and transport byte limits in force.
- [ ] Write findings through a scoped control-plane tool that derives workspace
  and run identity from runtime auth.
- [ ] Treat a final model answer without the required completion/finding tool as
  a failed evaluation, not a successful checkpoint.

## Capability and budget enforcement

Capabilities are resolved dynamically for each worker step from the current
manifest and the run's snapshotted revision. A revoked capability makes an old
run stale before tool execution.

- [ ] Separate control-plane capabilities, research capabilities, and financial
  capabilities in code and schemas.
- [ ] Make the runtime guard authoritative even when a tool is accidentally
  registered elsewhere.
- [ ] Add a provider-independent paid-research reservation interface.
- [ ] Reserve the known maximum or configured unknown-price ceiling before a
  paid call.
- [ ] Reconcile reservation versus actual cost when the provider returns a
  trustworthy charge.
- [ ] Keep an uncertain charge reserved until reconciled or expired through an
  owner-visible process.
- [ ] When a budget blocks a run, record a bounded reason and notify the owner
  once; do not generate an alert on every minute tick.
- [ ] Let the owner change workspace budgets through authenticated manager
  actions and natural-language tools operating in that workspace.
- [ ] Make paid providers disabled by default. Enabling one requires an existing
  noninteractive authorization, explicit capability grant, and sufficient
  budget.
- [ ] Test paid budget behavior with a deterministic fake provider. Enabling
  Masterkey for scheduled runtime work is a later provider-specific change and
  must not be assumed by this foundation.

## Monitor management contract

Interactive monitor tools derive the current workspace from authenticated
Photon routing context. The model never chooses an arbitrary workspace ID.

The Photon router must project typed internal metadata containing owner,
conversation, workspace, and generation identity. Tools read that metadata or
signed auth through Eve's channel context; they must not parse a workspace name,
synthetic thread suffix, or model-visible routing sentence to establish scope.

Required operations:

- create a monitor in the current workspace;
- list current-workspace monitors;
- update instruction, schedule, sources, and tightening limits;
- pause and resume;
- clone explicitly into another owner-selected workspace;
- retire/delete through an approved recoverable operation; and
- inspect last run, next run, source checkpoint, failure, and budget status.

- [ ] Replace generic event-trigger wording with user-facing **monitor** wording
  while retaining a compatibility layer for existing tools during migration.
- [ ] Align create and update validation with the authoritative store limit of
  eight combined sources. UI, tool schemas, and storage must reject the same
  ninth source with the same bounded error code.
- [ ] Replace the order-specific trigger-deletion success and denial copy with
  monitor-specific confirmation, or remove deletion from the rich approval
  protocol and use a dedicated recoverable monitor-retirement action.
- [ ] Resolve ambiguous monitor references by listing candidates or asking the
  owner; never edit the nearest name match silently.
- [ ] Support additive schedule language such as “also run at 4 PM” without
  replacing the existing 9 AM occurrence.
- [ ] Require an explicit timezone for local schedules and preserve it on edits.
- [ ] Normalize and validate added sources before committing a configuration
  revision.
- [ ] Keep source credentials out of URLs and workspace/model state.
- [ ] Use Eve call IDs as idempotency keys for natural-language mutations.

## Photon alert and routing UX

An alert is delivered into the physical iMessage conversation with a clear
workspace header. It does not rename the iMessage thread and does not switch the
selected workspace.

The alert card provides:

- workspace name;
- concise event title and why it matched;
- published/observed time and safe source link(s);
- **Discuss in <workspace>**; and
- **Manage sessions**.

### Discuss action

- [ ] Mint a short-lived owner-, conversation-, workspace-, alert-, and revision-
  bound capability in the URL fragment.
- [ ] On tap, atomically select the alert's workspace using the current
  conversation revision.
- [ ] Store a one-time pending alert-context reference for the selected
  workspace; do not inject the full alert into another workspace.
- [ ] On the next user message, load the bounded finding/alert reference into
  that workspace's turn context and consume the pending reference.
- [ ] Do not start a model turn merely because the owner tapped **Discuss**.
- [ ] If the workspace is archived, retired, or no longer belongs to the owner,
  fail closed and open the manager with a clear status.
- [ ] Make stale and repeated taps harmless.

### Ambiguous plain-text reply

Add a bounded alert-reply routing guard, not a general mother agent.

- [ ] It may inspect only the new message, the selected workspace manifest, and
  recent alert envelopes containing workspace name, title, time, and alert ID.
- [ ] It cannot read workspace histories or invoke research tools.
- [ ] A quoted Photon reply to a known alert is treated as a strong binding when
  Photon supplies stable reply metadata.
- [ ] A high-confidence reference to a recent alert from another workspace is
  held outside all workspace histories and prompts the owner to choose that
  workspace or remain in the selected one.
- [ ] The held message is dispatched exactly once after an owner choice using a
  durable assignment and dispatch receipt.
- [ ] Low-confidence text continues to the selected workspace; never silently
  route based on weak topical similarity.

## Session manager additions

Extend the existing Spectrum manager; do not create a second unrelated admin
surface.

Each workspace view shows:

- lifecycle and selected status;
- monitor count and enabled/paused/error counts;
- each monitor's name, schedule, timezone, sources, status, last run, next run,
  and latest bounded failure;
- workspace run/token/paid budget and current usage;
- pause/resume controls;
- schedule editor for supported schedule variants; and
- workspace budget editor constrained by deployment caps.

- [ ] Keep the existing owner-bound short-lived manager capability and URL
  fragment transport.
- [ ] Add request IDs, expected revisions, expirations, and one-time durable
  consumption to every manager mutation.
- [ ] Keep monitor and session actions separate from financial approval
  protocols.
- [ ] Make status inspection read-only and safe to refresh.
- [ ] Preserve the manager's current minimal visual language and button layout
  hierarchy.
- [ ] Provide plain-text/natural-language fallbacks for every essential monitor
  operation.

## Reference acceptance workspace: IPO Filings

The reference is deliberately smaller than a full investment strategy. Its job
is to prove the foundation with an authoritative, inexpensive source.

### Source and behavior

- Use an official SEC EDGAR latest-filings RSS/Atom search filtered to new
  `S-1` registration statements.
- Follow the [SEC developer resources](https://www.sec.gov/about/developer-resources)
  and fair-access policy, including an identifying user agent and aggregate
  request rate below the SEC limit.
- Treat `S-1` as a potential IPO registration, not proof that an IPO will occur.
- Treat `S-1/A` as an update to an existing registration, not a new company.
- Deduplicate each filing by accession number and form type; preserve CIK,
  company name, filing/file number when available, canonical filing URL, and
  observed time.
- Use public data only and no paid provider for the reference monitor.

The reference workspace capability manifest allows only the public-event
monitoring skill, the exact SEC source, source fetch, structured finding write,
alert staging, and run completion. It denies general web search, Masterkey,
Coinbase, private history, shell, and filesystem.

### Deterministic fixtures

- [ ] Add a fixture with an initial SEC Atom page containing known S-1 entries.
- [ ] First run establishes the checkpoint without alerting on the entire
  historical page.
- [ ] Add one later S-1 entry and verify exactly one structured finding and one
  alert.
- [ ] Replay the same feed and run occurrence; verify no duplicate finding,
  alert, or delivery.
- [ ] Add an S-1/A associated by filer CIK and registration file number and
  verify it is classified as an update rather than a new IPO candidate.
- [ ] Add malformed, oversized, stale, redirected, and incomplete source cases.
- [ ] Add a second fixture workspace due at the same time and prove both workers
  run independently with no shared context or state.

### Live smoke

- [ ] Perform a read-only fetch of the real SEC feed with the configured user
  agent.
- [ ] Verify parsing and checkpoint creation without requiring a new real filing
  to arrive.
- [ ] Use an injected post-checkpoint fixture event to exercise real Photon
  delivery deterministically.
- [ ] Keep live-source availability outside the deterministic CI pass/fail gate.

## Source-event phase

This phase begins only after every polling acceptance test and the polling
production smoke pass. RSS normally requires polling unless a source advertises
a push protocol such as WebSub; “RSS arrival” must not be represented as push
when it is actually a poll.

Define a normalized `SourceEventEnvelope` with:

- source adapter and source identity;
- stable provider event ID or derived content ID;
- observed, published, and updated times;
- canonical URL/origin and content hash;
- schema version and access classification;
- durable payload/artifact reference rather than unbounded inline content; and
- authentication and provenance metadata not exposed to the model.

- [ ] Add an authenticated internal source-event ingress that validates body
  size before parsing, verifies signatures before enqueueing, and deduplicates
  before fan-out.
- [ ] Add conditional RSS ingestion using ETag/Last-Modified and emit normalized
  events only for new or materially updated entries.
- [ ] Add WebSub only for sources that advertise and successfully verify a hub;
  otherwise retain conditional polling.
- [ ] Map an event to exact monitor subscriptions without invoking a model in the
  HTTP request.
- [ ] Enqueue the same bounded worker contract used by scheduled polling.
- [ ] Fetch one shared public source fact once when safe, then provide only the
  explicitly subscribed public fact to each workspace worker.
- [ ] Prevent private or workspace-scoped findings from entering shared source
  storage.
- [ ] Test duplicate webhook delivery, reordered events, invalid signatures,
  replay windows, oversized payloads, source updates, and fan-out to two isolated
  workspaces.
- [ ] Put source-event ingestion behind its own kill switch and retain polling as
  the fallback until production evidence is sufficient.

## Migration and compatibility

Existing event triggers are owner/conversation-scoped and cannot be assigned to
a workspace safely by guessing.

- [ ] Introduce a new versioned workspace-monitor schema without rewriting
  legacy records in place.
- [ ] Stop creating legacy records after the feature flag is enabled.
- [ ] Continue legacy execution temporarily through the existing restricted
  runner, labeled as a legacy monitor, without granting workspace state or new
  capabilities.
- [ ] Preserve the store's maximum of eight combined sources during migration;
  do not accept records through a tool schema that the store cannot represent.
- [ ] Show unassigned legacy monitors in the manager and require the owner to
  choose a target workspace.
- [ ] On assignment, atomically create the workspace monitor, carry forward the
  safe source checkpoint and schedule, and disable the legacy trigger.
- [ ] Never copy old runtime session history into the workspace brief.
- [ ] Preserve current workspace IDs and generations; add adjacent versioned
  state rather than resetting confirmed conversations.
- [ ] Provide a rollback mode that disables new dispatch while preserving all
  new records for later recovery.
- [ ] Add Redis-backed migration and runtime coverage for leasing, competing
  claims, run budgets, retries, watermarks/checkpoints, consecutive-failure
  pause, expiration, archive/pause races, and uncertain alert delivery.
- [ ] Add a local schedule-test runbook that explains the internal runner's
  deliberate 404 behavior and that Eve development mode does not run cron
  automatically.

## Photon integration coverage

The feature is not accepted from isolated store tests alone. Add a deterministic
Photon integration harness that exercises webhook authentication and owner
authorization, ingress dedupe, Chat SDK state, workspace assignment, Eve
dispatch, response delivery, and the Spectrum session manager without reaching
real Coinbase mutation endpoints.

- [ ] Cover an ordinary message routed to the selected workspace and prove the
  assignment is durable before the workspace model sees it.
- [ ] Cover concurrent duplicate webhooks and prove only one dispatch and one
  response-delivery attempt can begin.
- [ ] Cover session switching, archive/restore, and `Start fresh`, including a
  stale generation and a selected-pointer change after assignment.
- [ ] Cover an alert from a non-selected workspace, **Discuss**, an ambiguous
  reply, a stale/replayed action, and an uncertain Photon delivery.
- [ ] Cover owner-denied access to session, monitor, manager, runtime, and alert
  state.
- [ ] Use fixture-backed Eve and Photon adapters and keep all live financial
  mutation capabilities unavailable in the harness.

## Implementation sprints

### Sprint 0 — contracts and failure fixtures

- [x] Add state diagrams and schema fixtures for owner mapping, Photon ingress,
  assignment, dispatch, workspace, monitor, run, budget, finding, alert,
  delivery, and routing-decision records.
- [x] Write failing tests for cross-workspace access, duplicate dispatch,
  duplicate webhooks, immutable assignment, dispatch/delivery uncertainty,
  duplicate alert delivery, stale configuration, capability drift, budget
  exhaustion, archive, restore, start-fresh, and ambiguous alert replies.
- [x] Define the fixture-backed Photon integration harness and prove it cannot
  reach real Coinbase mutation endpoints.
- [x] Define low-cardinality error codes and operational counters.
- [x] Document feature flags and rollback behavior.

Exit gate:

- [x] Every state transition and forbidden transition is represented by a
  deterministic failing test before production implementation begins.

### Sprint 1 — owner, workspace state, capabilities, and budgets

- [x] Add stable deployment-owner mapping for approved Photon principals.
- [ ] Enforce that mapping before Photon session, monitor, manager, worker, and
  alert access; add negative tests for an authenticated unmapped principal.
- [ ] Project typed owner/conversation/workspace/generation metadata from the
  Photon router and reject missing or mismatched tool scope.
- [ ] Add versioned, bounded workspace brief, durable strategy configuration,
  capability manifest, and budget stores.
- [ ] Add owner/workspace-scoped authorization helpers used by every store.
- [ ] Add atomic run and paid-budget reservation/reconciliation primitives.
- [ ] Add default-deny dynamic capability resolution for runtime sessions.
- [ ] Add provider tool-inventory/schema drift reporting and typed unavailable-
  capability reasons; newly discovered tools remain disabled.
- [ ] Verify `Start fresh` retains the new workspace state and revokes stale
  generation-bound approvals.

Exit gate:

- [ ] Two workspaces can hold different briefs, skills, tools, sources, and
  budgets, and adversarial tests cannot cross either boundary.

### Sprint 2 — workspace monitor store and polling dispatcher

- [ ] Add the workspace-monitor schema, indexes, CRUD, revisions, leases, and
  occurrence keys.
- [ ] Add local-time daily schedules with DST and missed-run behavior.
- [ ] Adapt the existing minute dispatcher to claim workspace monitor runs.
- [ ] Enforce workspace and global concurrency/run budgets before dispatch.
- [ ] Preserve exact source fencing and complete-coverage checkpoints.
- [ ] Align monitor create/update tools, manager validation, and storage on the
  maximum of eight combined sources.
- [ ] Add legacy trigger compatibility and explicit immutable-workspace
  assignment flow.
- [ ] Add Redis-backed tests for leases, competing claims, budgets, retries,
  checkpoints, failure pause, archive/pause races, expiration, and uncertain
  alert delivery.

Exit gate:

- [ ] Polling occurrences are deterministic, single-flight per monitor,
  concurrent across workspaces, recoverable after lease expiry, and unable to
  exceed configured budgets.

### Sprint 3 — isolated worker and IPO reference

- [ ] Build the typed worker envelope and signed runtime auth.
- [ ] Dynamically expose only the workspace's permitted skills and tools.
- [ ] Add scoped finding and completion tools.
- [ ] Implement the `IPO Filings` reference manifest and SEC Atom normalizer.
- [ ] Complete all reference fixture tests, including concurrent workspaces.
- [ ] Prove the worker has no interactive history or cross-workspace state.

Exit gate:

- [ ] A scheduled IPO fixture occurrence produces one correct durable finding or
  no-match checkpoint with bounded context and no duplicate side effects.

### Sprint 4 — durable alerts and reply-safe Photon routing

- [ ] Add immutable ingress, workspace-assignment, dispatch, completion, and
  outbound response-delivery receipts for every actionable Photon webhook.
- [ ] Deduplicate concurrent Photon webhooks before dispatch and quarantine
  uncertain model dispatch or response delivery for reconciliation.
- [ ] Add channel-independent alert/outbox records and Photon delivery receipts.
- [ ] Render workspace-headed alert cards with **Discuss** and **Manage**.
- [ ] Implement atomic workspace selection and one-time pending alert context.
- [ ] Route held alert replies through the same ingress assignment and dispatch
  state machine as ordinary messages.
- [ ] Add delivery uncertainty quarantine and explicit recovery controls.
- [ ] Complete the deterministic Photon integration harness for routing,
  duplicate webhooks, session switching, `Start fresh`, alerts, and stale
  actions.

Exit gate:

- [ ] Every fixture Photon message has one durable outcome, duplicate or
  uncertain delivery cannot cause blind replay, and an IPO alert arriving while
  another workspace is selected can be discussed safely without cross-routing.

### Sprint 5 — natural-language and Spectrum management

- [ ] Add workspace-derived monitor CRUD tools and compatibility aliases.
- [ ] Support “also run at 4 PM,” source additions, budget changes, and status
  questions through natural language.
- [ ] Extend the session manager with monitor details, pause/resume, schedule,
  and workspace budget controls.
- [ ] Implement archive/restore/start-fresh monitor lifecycle behavior.
- [ ] Correct trigger-deletion approval copy or replace it with the dedicated
  recoverable monitor-retirement action.
- [ ] Add stale/replayed mini-app action tests and plain-text fallbacks.

Exit gate:

- [ ] The complete agreed owner workflow works without editing Redis,
  environment variables, or tracked files.

### Sprint 6 — polling production smoke and hardening

- [ ] Run all deterministic suites, Redis-backed race tests, typecheck, Eve
  build, and application build.
- [ ] Publish and execute the local schedule-test runbook.
- [ ] Verify two simultaneous workspace runs and controlled budget exhaustion.
- [ ] Run the SEC read-only live smoke.
- [ ] With owner authorization, deploy behind flags and execute the real Photon
  IPO alert/discuss/manager flow.
- [ ] Verify event streams and delivery receipts, not only the final iMessage.
- [ ] Record rollback evidence before enabling by default.

Exit gate:

- [ ] Polling is proven end to end in Photon with no context leakage, duplicate
  alerts, unexpected workspace switch, or unauthorized capability.

### Sprint 7 — source-event ingestion

- [ ] Implement the normalized source-event envelope and authenticated ingress.
- [ ] Implement conditional RSS change events and optional verified WebSub.
- [ ] Route subscribed events through the same monitor queue and worker contract.
- [ ] Complete replay, signature, ordering, fan-out, and isolation tests.
- [ ] Deploy under a separate kill switch while polling remains available.

Exit gate:

- [ ] A fixture source event and one supported live source wake the correct
  workspace worker exactly once without coupling ingestion to Photon or model
  execution.

## Planned code areas

Prefer adjacent versioned modules over turning the existing trigger store into a
single oversized file. Final names may change, but ownership must remain clear.

- `agent/lib/owner-identity.ts`: stable owner and Photon alias mapping.
- `agent/lib/photon-ingress-store.ts`: immutable ingress, assignment, dispatch,
  completion, delivery, and quarantine receipts.
- `agent/lib/workspace-state-store.ts`: briefs and structured workspace state.
- `agent/lib/workspace-capabilities.ts`: manifest schema, runtime resolution,
  provider drift reports, and unavailable-capability reasons.
- `agent/lib/workspace-budget-store.ts`: atomic run/token/paid reservations.
- `agent/lib/workspace-monitor-store.ts`: monitor configuration, indexes, leases,
  schedules, and checkpoints.
- `agent/lib/workspace-finding-store.ts`: scoped structured findings.
- `agent/lib/workspace-alert-store.ts`: alerts, outbox, and delivery receipts.
- `agent/lib/workspace-runtime-auth.ts`: signed worker claims and validation.
- `agent/channels/workspace-monitor-runner.ts`: isolated Eve task dispatch.
- `agent/schedules/workspace-monitors.ts`: static minute dispatcher.
- `agent/channels/photon.ts`: selected-workspace routing and alert-reply guard.
- `agent/channels/photon-workspace-app.ts`: monitor and budget management UI.
- `agent/lib/photon-workspace-store.ts`: lifecycle integration and conversation
  pointer revisions.
- `agent/tools/`: workspace monitor CRUD, scoped finding/alert/completion, and
  budget tools.
- `agent/lib/public-feeds.ts` and `agent/tools/fetch_public_source.ts`: SEC
  reference source and normalization.
- `scripts/verify-*.mjs` and `evals/`: deterministic, Redis, and model behavior
  coverage.

Do not duplicate the shared MCP normalizer, bounded transport, artifact store,
approval state machine, or Photon mini-app capability helpers.

## Verification matrix

| Boundary | Required proof |
| --- | --- |
| Identity | Unmapped Photon principals fail closed before session, monitor, worker, manager, or alert state is read; aliases resolve only to the configured owner. |
| Ingress | Every actionable Photon webhook has one immutable receipt and, when model-bound, one workspace/generation assignment recorded before dispatch. |
| Dispatch | Concurrent duplicate webhooks cause one model dispatch; completion is idempotent; uncertain dispatch or response delivery is quarantined instead of blindly replayed. |
| Isolation | A worker cannot read or write another workspace even with forged IDs in model input. |
| Scheduling | Daily local times, DST, edits, downtime, leases, and stale revisions behave deterministically. |
| Concurrency | Different workspaces run concurrently; the same monitor remains single-flight. |
| Context | Worker prompt/history contains no interactive transcript or unrelated skill/tool. |
| Capabilities | Omitted tools/providers are unavailable; hard runtime denials cannot be loosened; new or schema-changed provider tools remain disabled and are reported accurately. |
| Budgets | Reservations are atomic; concurrent runs cannot overspend; uncertain cost remains reserved. |
| Sources | Exact source fencing, at-most-once fetch per run, complete coverage, and provenance survive retries. |
| Findings | Duplicate occurrences cannot create duplicate structured findings. |
| Alerts | Duplicate/uncertain delivery cannot spam the owner or advance an unsafe checkpoint. |
| Routing | Alert receipt does not switch workspaces; Discuss and held-message choices are one-time and revision-bound. |
| Lifecycle | Archive pauses, restore stays paused, and start-fresh retains durable workspace state. |
| UX | Natural-language and Spectrum operations agree on authoritative state. |
| Photon integration | Fixture webhooks cover routing, duplicate delivery, switching, Start fresh, alerts, stale actions, and owner denial without access to real broker mutations. |
| Financial safety | Runtime workers cannot access live mutation tools; proposed orders still require fresh approval. |
| Migration | Legacy triggers are never guessed into a workspace and can be explicitly assigned without replaying history. |

## Observability and operations

- [ ] Emit low-cardinality counters for claimed, started, completed, no-match,
  retryable failure, terminal failure, budget-deferred, alert delivered, alert
  uncertain, ingress deduplicated, dispatch quarantined, response delivery
  quarantined, and routing-confirmation outcomes.
- [ ] Emit bounded error codes rather than exception bodies or provider payloads.
- [ ] Provide owner-visible monitor health in the manager.
- [ ] Add kill switches for all workspace dispatch, paid runtime research,
  Photon workspace alerts, and source-event ingestion.
- [ ] Add an operator command/report that lists quarantined ingress dispatches,
  response deliveries, runs, and uncertain alert deliveries without exposing
  private content.
- [ ] Define retention for runs, findings, alerts, receipts, and budget ledgers;
  never use model context as the only retained record.

## Definition of done

This specification is complete only when:

- [ ] Every sprint exit gate passes.
- [ ] Every actionable Photon webhook receives one immutable ingress receipt;
  every model-bound message is durably assigned before dispatch; duplicates and
  uncertain outcomes cannot cause blind replay.
- [ ] The `IPO Filings` fixture and live-source smoke pass.
- [ ] Two workspaces run concurrently without cross-context, cross-tool, budget,
  or state leakage.
- [ ] The owner can create and edit the 9 AM/4 PM monitor conversationally.
- [ ] The session manager accurately shows and controls monitors and budgets.
- [ ] An alert from a non-selected workspace is labeled, delivered once, and
  does not change routing until the owner taps **Discuss** or confirms a held
  reply.
- [ ] Archive, restore, and start-fresh follow the agreed lifecycle.
- [ ] Paid research is impossible without both an explicit capability and
  available budget.
- [ ] Background live trading is impossible even if a model requests it.
- [ ] Existing approved financial and Photon safety tests remain green.
- [ ] The fixture-backed Photon integration harness passes routing, duplicate
  webhook, switching, `Start fresh`, alert, stale-action, and owner-denial cases.
- [ ] Rollback can stop new dispatch without deleting durable state.
- [ ] `HANDOFF.md`, `NORTH_STAR.md`, and the focused verification map are updated
  with durable implemented facts after rollout—not before.

## Follow-on specifications

Completion of this foundation does not authorize these projects. Each needs its
own bounded implementation spec:

1. [`Spec 2: Versioned strategy packs and workspace installation`](02-versioned-strategy-packs.md).
2. [`Spec 3: Versioned public-source adapters and canonical facts`](03-public-source-adapters.md).
3. [`Spec 4: Congressional Signals v1 — House PTRs`](04-congressional-signals-house.md).
4. [`Spec 5: Insider Clusters`](05-insider-clusters.md).
5. [`Spec 6: Typed shared-signal plane`](06-shared-signal-plane.md).
6. Cramer Inverse source acquisition, quote attribution, and signal rules.
7. Workspace-aware proposed-order, reservation, preview, approval, and broker
   reconciliation.
8. General topic-change detection and held-message recovery.
9. Telegram migration to the workspace broker.

## Implementation progress

| Date | Checklist item | Verification |
| --- | --- | --- |
| 2026-08-14 | Add state diagrams and schema fixtures for durable workspace-runtime records | `node scripts/verify-workspace-runtime-contracts.mjs` and `jq empty specs/fixtures/01-independent-workspace-runtimes/*.json` — passed |
| 2026-08-14 | Write deterministic pre-implementation failure fixtures for isolation, idempotency, uncertainty, drift, budgets, lifecycle, and alert routing | `node scripts/verify-workspace-runtime-failures.mjs` — passed |
| 2026-08-14 | Define a fixture-backed Photon integration harness with no live broker or network surface | `node scripts/verify-workspace-photon-harness.mjs` — passed |
| 2026-08-14 | Define fixed runtime error codes, counters, and routing-confirmation outcomes | `node scripts/verify-workspace-runtime-observability.mjs` and `tsc --noEmit` — passed |
| 2026-08-14 | Document and enforce fail-closed rollout flags and non-destructive rollback behavior | `node scripts/verify-workspace-runtime-flags.mjs` and `tsc --noEmit` — passed |
| 2026-08-14 | Sprint 0 exit gate: exercise every declared allowed and forbidden transition | All `verify:workspace-runtime:*`, `verify:workspaces`, `verify:approvals`, and `tsc --noEmit` — passed |
| 2026-08-14 | Add fail-closed deployment-owner mapping with HMAC-derived Photon aliases | `node scripts/verify-owner-identity.mjs` and `tsc --noEmit` — passed |
