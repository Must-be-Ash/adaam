# Spec 2: Versioned strategy packs and workspace installation

Status: Product contract reviewed; implementation plan ready; local Spec 1 dependency complete

Date: 2026-08-14

Product target: `NORTH_STAR.md`

Dependency: `specs/01-independent-workspace-runtimes.md`

Reference pack: `IPO Filings`

## Plain-language objective

Make specialized strategy agents easy to create without rebuilding their
workspace plumbing each time.

Spec 1 provides the engine: durable workspaces, isolated workers, monitors,
schedules, capabilities, budgets, findings, and alerts. This specification adds
reusable recipes for that engine. A **strategy pack** says what a specialized
agent is for, which instructions and sources it uses, which abilities it needs,
which monitor templates it offers, what its findings look like, and which tests
prove it works.

The reusable pack and the owner's installed agent remain different things:

- `IPO Filings@1.0.0` is a versioned recipe in the repository.
- The owner's `IPO Filings` workspace is one configured installation of that
  recipe, with its own schedule, budget, conversation, monitors, and findings.

This specification builds the installation system and proves it with the small
public-data IPO workflow. It does not build every investment strategy.

## How to use this specification

Implement this specification only after the applicable local Spec 1 polling
milestone is merged and green. Owner-authorized Spec 1 production rollout and
its explicitly deferred post-Spec-6 hardening are not Spec 2 dependencies. Reuse
Spec 1's owner, workspace, capability, budget, monitor, finding, alert, ingress,
and lifecycle contracts rather than creating parallel stores.

The implementation sequence, file-level work, and verification commands live in
[`docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md`](../docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md).
This file remains the product contract. Do not duplicate progress ledgers here;
use the plan for execution and Git commits for evidence. If implementation
requires weakening a Spec 1 invariant, stop and resolve the conflict with the
owner rather than widening this specification.

## Goal and acceptance experience

The completed feature must support this experience:

1. The owner asks Eve to create an IPO-filings session that checks for new SEC
   S-1 filings at 9:00 AM and 4:00 PM in the owner's timezone.
2. Eve selects the reviewed `IPO Filings` pack, pins its exact version and
   content digest, creates a new pack-bound workspace, and applies only the
   capabilities and sources that the deployment and owner allow.
3. The pack supplies the workspace's compact purpose, detailed playbook,
   official SEC source definition, IPO monitor template, structured finding
   contract, and pack-specific evaluations.
4. The requested monitor is enabled because the owner explicitly requested its
   schedule. Merely browsing or installing a pack without requesting a monitor
   does not silently start background work.
5. Other workspaces remain general-purpose or use different packs. They do not
   see the IPO pack's instructions, skills, tools, configuration, or findings.
6. The session manager shows the installed pack, version, configuration,
   capabilities, sources, and monitor health.
7. Reconfiguring or removing the pack is explicit, revision-checked, and
   non-destructive. It never silently starts work or deletes durable findings.

## Agreed product decisions

- [x] A strategy pack is a declarative, versioned repository package, not a
  permanently running model, remote agent, or independent user identity.
- [x] A workspace may have zero or one installed strategy pack. A workspace
  with no pack remains a general-purpose Eve research session.
- [x] The workspace owns its conversation, configuration overrides, monitors,
  findings, and budgets. The reusable pack never owns or receives that data.
- [x] Packs are pinned to an exact semantic version and immutable content
  digest. Configuration and removal are explicit control-plane actions.
- [x] Pack content can request capabilities but cannot grant them. Effective
  access remains the intersection of deployment policy, owner authorization,
  workspace policy, pack requirements, monitor scope, and runtime hard denials.
- [x] Packs may tighten shared safety and budget limits but never loosen them.
- [x] A pack definition contains no credentials, owner data, executable scripts,
  provider tokens, or arbitrary remote code.
- [x] Source adapters, tools, schemas, and migrations are reviewed application
  code referenced by stable IDs. A pack manifest cannot execute code by itself.
- [x] Installing a pack does not silently activate preset monitors. Background
  work starts only when the owner's request or manager action explicitly enables
  the resulting monitor and schedule.
- [ ] Removing a pack does not rewrite or delete workspace findings. Managed
  resources are paused or retired for owner review.
- [ ] Pack mutations use the existing workspace lifecycle and advance the session
  generation so old instructions and capabilities cannot remain active.
- [x] User-facing copy continues to say **session**. **Strategy pack** is the
  user-facing term for the reusable recipe installed in a session.
- [x] The first catalog is local and repository-owned. Do not build a public
  marketplace, remote download service, or automatic update service.
- [x] The reference pack uses public SEC data only. No owner-private artifact
  system is needed or introduced by this specification.
- [x] No pack can enable live broker mutations. Trading remains governed by a
  later workspace-aware financial control-plane specification.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Strategy pack | A repository-owned, declarative and versioned recipe for one specialized research strategy. |
| Pack definition | The immutable manifest, instruction files, resource references, and eval declaration for one exact pack version. |
| Pack catalog | The build-generated, application-owned index of validated pack definitions available in the deployment. |
| Pack binding | The durable record pinning one workspace to one exact pack version, digest, configuration, and resource mapping. |
| Pack configuration | Owner-selected values accepted by the pack's bounded configuration schema, such as timezone, daily times, or watchlist references. |
| Pack-managed resource | A workspace monitor, source subscription, or bounded brief section created from a stable resource ID in the installed pack. |
| Owner override | A validated workspace-owned change to a field the pack explicitly declares configurable. |
| Catalog status | `available`, `deprecated`, or `blocked` state assigned by reviewed application code to one pack version. |

## Scope

### In scope

- A versioned strategy-pack schema and repository layout.
- A deterministic build-time catalog and pack validation command.
- Exact version and content-digest pinning.
- Bounded pack identity, instructions, playbook, configuration fields, sources,
  capability requirements, monitor templates, finding schemas, and eval suites.
- Durable workspace pack bindings and mutation receipts.
- Installation into a newly created pack-bound workspace.
- Explicit configuration and non-destructive removal flows.
- Pack-managed resource provenance and atomic install/configuration/removal mutations.
- Dynamic composition of only the installed pack's additional mission and
  playbook for interactive sessions, plus the exact allowed source/tool subset
  for scheduled workers. Existing shared Eve tools remain governed by Spec 1
  authorization until a later root-tool refactor can remove them conditionally.
- Natural-language pack selection/configuration in the owning workspace.
- Strategy-pack visibility and controls in the existing Spectrum session manager.
- A complete `IPO Filings@1.0.0` reference pack using the Spec 1 SEC fixtures.
- Pack schema, lifecycle, isolation, runtime, and behavior evaluations.

### Out of scope

- Complete Congressional Signals, Insider Clusters, Cramer Inverse, or other
  candidate strategy implementations.
- A remote pack registry, marketplace, billing system, signing authority, or
  automatic download/update mechanism.
- Arbitrary user-authored, uploaded, or third-party pack installation.
- Runtime execution of JavaScript, TypeScript, shell, or templates supplied by
  a pack manifest.
- More than one pack installed in one workspace.
- Automatic merging of two packs or their prompts, scores, findings, or rules.
- Cross-workspace evidence sharing or convergence scoring.
- Backtesting, historical performance claims, or strategy-alpha validation.
- Production activation of paid data providers for background work.
- Owner-private artifact storage or automatic paid-result retention.
- Live order placement, trading approvals, broker reservations, or reconciliation.
- General topic-change detection and held-message routing.
- Telegram or HTTP workspace routing and strategy-pack management.
- Cheaper worker-model routing or pack-selected model providers.
- A graphical strategy-pack editor.
- Automatic adoption of pre-existing hand-configured monitors. The first
  rollout creates new pack-bound sessions; equivalent existing resources are
  reported as conflicts and never mutated implicitly.
- Generalized pack update, downgrade, replacement, and rollback workflows.
  Define these only when a real second pack version requires them.

## Dependency on Spec 1

Spec 2 extends these completed Spec 1 records and behaviors:

- stable deployment owner and immutable workspace identity;
- versioned workspace record and session generation;
- bounded workspace brief and structured findings;
- default-deny capability manifest and provider drift reporting;
- workspace budget policy and atomic reservations;
- workspace-owned monitor schema, leases, schedules, and checkpoints;
- isolated interactive and task-session runtime context;
- authenticated natural-language and Spectrum manager mutations;
- ordinary-path archive, restore, and start-fresh behavior plus the implemented
  durable-mode ingress, alert, and delivery paths; and
- the deterministic and live-smoke `IPO Filings` source behavior.

Spec 2 does not assume that Spec 1's unchecked rollout-neutral ingress,
crash-recovery, alert/checkpoint, lifecycle-atomicity, or privacy-log guarantees
are complete. Any Spec 2 feature that directly requires one of those guarantees
must promote the smallest necessary prerequisite into its own sprint.

- [ ] Refuse to enable strategy-pack feature flags if the required Spec 1 schema
  versions or runtime guards are absent.
- [x] Add adjacent records and indexes; do not duplicate or fork Spec 1 stores.
- [x] Keep a general-purpose workspace valid and fully usable without a pack.

## Non-negotiable invariants

- [x] A pack ID, version, or workspace ID supplied by a model is never trusted as
  authorization. The control plane derives the current workspace and owner from
  authenticated routing or signed runtime context.
- [x] A pack manifest is configuration, never authority. Every tool, skill,
  source, provider, budget, and data class is revalidated against authoritative
  deployment and workspace policy before exposure or execution.
- [x] Pack versions are immutable. The same pack ID and version cannot resolve
  to different bytes or a different digest across builds.
- [x] A workspace binds to exactly one version and digest at a time. There is no
  floating `latest`, version range, or silent production upgrade.
- [x] Installing a pack may declare and bind reviewed source contracts, but no
  fetch, cadence, monitor run, paid access, or broader capability begins without
  an explicit owner request or manager action describing that activation.
- [x] Pack instructions, research documents, and other packs are not loaded into
  a workspace unless required by its exact active binding.
- [x] Pack instructions cannot override shared safety, authorization, approval,
  source-fencing, budget, privacy, or financial rules.
- [x] Background pack workers never receive private chat history, interactive
  HITL, user OAuth, shell, filesystem, or broker-mutation tools.
- [ ] Installing, configuring, or removing a pack never deletes workspace findings,
  alerts, audit records, or retained monitor history.
- [x] Pack-managed records retain stable pack resource IDs and workspace IDs so
  an atomic mutation cannot confuse one resource with another or cross
  workspaces.
- [ ] Every pack mutation is revision-checked, atomic, and idempotent. Failure
  changes no durable key and creates no duplicate monitor or repeated paid work.
- [ ] A missing, invalid, blocked, or digest-mismatched pack fails closed. Its
  pack-managed monitors pause before another worker starts.
- [x] Pack configuration and instruction sizes remain bounded. Raw research
  documents never become durable conversation state or default prompt content.
- [ ] Logs and metrics contain no message text, instructions, configuration
  values, owner IDs, workspace IDs, source URLs, watchlists, or high-cardinality
  pack digests.

## Target architecture

```mermaid
flowchart LR
    F["Repository strategy-pack files"] --> G["Build-time validator and catalog generator"]
    G --> C["Compiled immutable pack catalog"]

    U["Owner request or Spectrum action"] --> P["Revision-checked pack mutation"]
    C --> P
    P --> B["Workspace pack binding"]
    B --> R["Pack-managed workspace resources"]

    B --> D["Dynamic Eve capability composition"]
    C --> D
    D --> I["Interactive workspace generation"]
    D --> W["Bounded monitor worker"]

    R --> M["Spec 1 monitors, budgets, findings, and alerts"]
    W --> M
```

The catalog is compiled into the deployment. Production runtime must not scan
untraced source files from the server filesystem. This follows the existing
production lesson used for Photon assets: build-time generation produces an
imported module that server functions can load reliably.

## Repository package format

Use a declarative layout similar to:

```text
strategy-packs/
  ipo-filings/
    1.0.0/
      pack.json
      workspace.md
      playbook.md
      monitors/
        detect-new-s1.md
      evals.json
```

The exact filenames may change, but these rules do not:

- [x] `pack.json` is data validated by one authoritative application schema. It
  cannot import modules or contain executable expressions.
- [x] `workspace.md` is a short, bounded always-on mission and interpretation
  contract for an interactive workspace using the pack.
- [x] `playbook.md` is a load-on-demand Eve skill containing the detailed
  research procedure. Its description is a bounded routing hint.
- [x] Each monitor instruction is a separate bounded file so a worker receives
  only the instructions for its claimed monitor, not the complete pack.
- [x] The pack references the application-owned SEC eval-suite ID. It does not
  copy the existing fixture corpus into the version directory or expose fixture
  bodies to production model sessions.
- [x] All referenced paths stay inside the exact version directory, reject path
  traversal and symlink escape, and have per-file and aggregate byte ceilings.
- [x] Pack files contain no secret placeholders that encourage credentials in
  tracked configuration. Provider connections are referenced by stable IDs and
  configured outside the pack.
- [x] Reject credential fields and credential-bearing URLs in the bounded v1
  schema. Broader corpus scanning is deferred until packs accept more varied
  content or a publication boundary makes it necessary.
- [x] Generate a typed catalog module during repository preparation/build. Do
  not depend on runtime filesystem discovery in Vercel functions.

## Strategy-pack definition contract

`StrategyPackDefinition` contains the following versioned sections.

### Identity and compatibility

- schema version;
- stable lowercase pack ID;
- exact semantic pack version;
- canonical content digest;
- display name, bounded description, and maturity of `reference`,
  `experimental`, `stable`, or `deprecated`;
- explicit supported core/workspace/pack-schema versions; and
- repository-relative references to the bounded instruction files.

- [x] Reject mutable aliases such as `latest`, URL-based pack IDs, build
  timestamps as versions, and duplicate ID/version pairs.
- [x] Canonicalize and hash the manifest plus every referenced instruction and
  schema file in a deterministic order.
- [x] Reject a pack whose explicit supported versions exclude the deployed
  core, workspace, or strategy-pack schema. A generalized semver-range engine
  and release-history ledger wait for a real second version or publication.

### Configuration schema

The pack declares bounded owner-editable fields using an application-owned
discriminated schema. Initial field kinds are deliberately limited to what the
reference pack needs: an IANA timezone and unique sorted local daily times. Add
other field kinds only when a concrete pack requires them.

Each field declares its key, label, description, type, required/default state,
bounds, whether it may be changed after installation, and whether changing it
requires monitor pause or session-generation rollover.

- [x] Reject unknown configuration fields and values outside declared bounds.
- [x] Treat defaults as suggested configuration, not permission to activate a
  monitor or spend money.
- [x] Keep owner overrides separate from pack defaults so configuration changes
  never rewrite the immutable definition.
- [x] Never permit credential, free-form executable instruction, URL template,
  arbitrary JSON Schema, or arbitrary code fields in owner configuration.

### Capability and source requirements

The definition lists stable references to:

- Eve skill IDs and exact pack-provided skill version;
- application-owned tool IDs;
- application-owned source contract IDs, exact contract versions and digests,
  and allowed public origins;
- optional provider/connection IDs;
- maximum access classification;
- required capabilities; and
- explicit hard denials for the pack.

- [x] Resolve the effective manifest by intersection with Spec 1 policy. A pack
  requirement that is not granted remains unavailable and is reported with the
  typed reason from Spec 1.
- [x] A missing required capability blocks activation. Optional-capability and
  degraded-mode behavior waits until a real pack requires it.
- [ ] Run provider tool-inventory/schema drift checks before declaring a pack
  healthy. Newly discovered tools remain disabled.
- [x] Reject credentials, signed URLs, mutable redirectors, and unrestricted web
  origins in source definitions.
- [x] Pin every source reference as `{sourceId, contractVersion,
  contractDigest, allowedOrigins}`. Spec 3 owns the generalized source-adapter
  implementation; this specification only establishes the minimum stable
  reference needed by the IPO pack.
- [x] Before a pack-managed source can activate, the exact-fenced fetch path
  rejects redirects before a second request and covers private and undeclared
  redirect targets with deterministic fixtures.
- [x] Reject every broker mutation, transfer, withdrawal, leverage, credential,
  shell, and unrestricted filesystem capability from this specification's pack
  schema.

### Monitor templates

Each template includes:

- stable pack resource ID and display name;
- bounded monitor-instruction reference;
- supported schedule/configuration bindings;
- exact source references;
- required capability subset;
- finding schema ID and alert presentation ID;
- suggested budget limits that only tighten workspace policy; and
- activation default, which must always be `paused` or `draft`.

- [x] Validate template schedules against Spec 1 cadence, timezone, source-count,
  concurrency, and run-budget limits.
- [x] Materialize templates as ordinary Spec 1 workspace monitors with immutable
  workspace identity plus pack ID, version, resource ID, and binding revision.
- [ ] Let the owner edit only template fields declared overridable. Record those
  values as workspace-owned overrides rather than altering the pack definition.
- [x] Treat owner-created monitors as separate resources that pack
  mutations can never rewrite or remove.

### Findings, outputs, and evaluations

The pack references application-owned, versioned schemas for structured
findings and alert projections. It also declares the deterministic eval suite
required for that exact version.

- [x] Require every production pack to declare at least one fixture-backed
  positive case, no-match case, replay/idempotency case, malformed-input case,
  and forbidden-capability case.
- [x] Require provenance, source identity, observed/as-of time, producing
  workspace, pack version, monitor/run identity, and schema version on every
  pack-produced finding.
- [x] Keep scoring and interpretation rules pack-specific. Do not add one shared
  universal investment score to the core schema.
- [x] Keep wording-quality judges optional and non-authoritative. Isolation,
  schema, source, capability, and idempotency gates are deterministic.

## Compiled pack catalog

`StrategyPackCatalog` is the immutable deployment view of validated definitions.
It is not a mutable database and does not contain workspace installations.

- [x] Add a generator that validates all pack versions, resolves files, computes
  digests, and emits one typed imported catalog module.
- [x] Sort catalog entries deterministically by pack ID and semantic version.
- [x] Detect duplicate resource IDs, missing references, path escape, oversize
  instructions, incompatible schemas, capability conflicts, and missing evals.
- [x] Generate a compact model-safe catalog projection containing only pack ID,
  display name, version, description, maturity, configuration summary, and
  availability. Do not expose every instruction or schema while listing packs.
- [x] Let reviewed application configuration mark a vulnerable or incorrect
  version `blocked` without editing historical pack bytes.
- [x] Keep installed historical versions in the build until no durable binding
  references them or an explicit migration has completed.
- [x] Add `verify:strategy-packs` and run it in `prebuild` and CI.

## Durable workspace pack binding

`WorkspaceStrategyPackBinding` is the authoritative installed state and contains:

- owner and immutable workspace IDs;
- pack ID, exact version, and content digest;
- binding lifecycle and revision;
- validated configuration and separate owner overrides;
- effective capability-manifest revision;
- map from pack resource IDs to workspace monitor/source IDs;
- installation/configuration/removal request IDs and mutation receipts;
- installed, activated, configured, and generation-rollover timestamps; and
- bounded health/unavailable reason codes.

This binding is the versioned successor to Spec 1's existing
`WorkspaceStrategyConfiguration` record, not a second source of strategy truth.
Use dual-version readers and an explicit compare-and-set migration, never a
write-on-read migration. A v1 null pack becomes v2 unbound; a v1 non-null pack
becomes unavailable/legacy-unverified and is never silently activated or used
to adopt existing monitors. Keep the dual reader and historical catalog entries
while durable references exist.

Do not copy full instruction files, research documents, fixture bodies, or pack
schemas into the binding or workspace brief. Store stable references, versions,
digests, and the bounded owner configuration.

Immutable mutation receipts are adjacent records, not a second binding store.
All v1 pack state uses the same Redis transaction domain, so create/install,
configuration, and removal each use one bounded multi-key compare-and-write.
After prevalidation, the transaction writes the complete authoritative state
and receipt or writes nothing. It does not serialize archive, restore, Start
fresh, or unrelated owner-created monitor mutations.

### Binding lifecycle

```text
unbound -> active
active -> active
active -> unbound
active -> unavailable
unavailable -> active | unbound
```

- [ ] Use one bounded multi-key compare-and-write on expected workspace,
  binding, capability, monitor, and selection revisions for every transition.
- [ ] Use one stable mutation ID for every install/configure/remove attempt and
  return the prior receipt on replay.
- [x] Keep at most one active binding per workspace.
- [x] Derive owner, conversation, and source assignment from authenticated
  routing. The control plane generates and persists the target workspace ID;
  neither the model nor Spectrum supplies authoritative ownership or grants.
- [x] A failed or stale mutation changes no durable key and creates no success
  receipt. Replaying the same canonical request returns its prior receipt.

## Installation, configuration, and removal mutations

The first milestone needs one small atomic mutation engine, not a general
package-upgrade or recovery system. Each install, configuration change, or
removal validates one canonical request and atomically records the complete
state change plus immutable receipt against expected revisions.

- [x] Reconcile resources by stable pack resource ID, never display name or
  array position.
- [x] Reject a stale expected revision as a harmless conflict; never merge it
  best-effort.
- [x] Keep newly materialized monitor templates paused unless the same explicit
  owner request supplies and enables their schedule.
- [ ] Validate configuration before committing it, pause affected monitors when
  required, and advance the session generation with the binding revision.
- [x] Resolve runtime state by the exact workspace, generation, binding
  revision, pack digest, capability revision, and reciprocal managed-resource
  provenance. An unmatched tuple fails closed.
- [ ] Removal pauses or retires pack-managed resources and preserves findings,
  checkpoints, alerts, and audit history.
- [ ] Derive stable request identity in application code so Photon/Eve/Spectrum
  replay reaches the same receipt while a later intentional request receives a
  new ID. The ID is never a bearer capability.

## Runtime capability composition

Eve remains one user-facing agent. Strategy packs specialize a workspace by
dynamically composing capabilities from the authenticated workspace binding.

### Interactive workspace sessions

- [x] At workspace session start, resolve the exact pack binding and catalog
  digest from trusted routing context.
- [x] Compose shared Eve safety instructions with the pack's bounded
  `workspace.md`; pack text always has lower authority than shared core rules.
- [x] Advertise only the installed pack's `playbook.md` as a dynamic Eve skill.
  Do not advertise skills for every catalog entry.
- [x] Compose only the active pack's additional mission and playbook. Existing
  shared root tools remain subject to Spec 1 workspace authorization; every
  pack-management executor re-reads authoritative scope before acting.
- [x] Use Eve's dynamic-capability APIs at a lifecycle boundary compatible with
  durable replay. If dynamic tools are emitted, their `execute` functions follow
  Eve's inline-function requirement so replayed steps retain the executor.
- [ ] Pack install, configuration, and removal create a new workspace session
  generation rather than altering an already-running generation's identity.
- [x] Keep pack catalog browsing a compact control-plane operation; it must not
  load all pack instructions into the model prompt.

### Scheduled workspace workers

- [x] Add pack ID, version, digest, binding revision, and pack resource ID to the
  Spec 1 worker envelope and run snapshot.
- [x] Resolve only the claimed monitor instruction, exact source definitions,
  bounded workspace brief, relevant findings, and effective tools.
- [x] Revalidate the binding, capability, monitor, and pack digest immediately
  before source access and before committing findings.
- [x] Mark a run stale before side effects if the pack changed, was blocked,
  became unavailable, or no longer matches the snapshotted digest.
- [x] Preserve Eve step replay semantics: every source fetch, finding, alert, and
  external side effect retains an application-level idempotency key.
- [x] Do not represent pack instances as Eve subagents. Spec 1's fresh bounded
  task session remains the worker isolation boundary.

## Natural-language management contract

Pack management begins in an authenticated conversation and source workspace.
The model never mutates another workspace by supplying an arbitrary ID. A
new-session operation targets a server-generated workspace through one atomic
control-plane mutation.

Required application-owned operations:

- list compact available packs;
- inspect one pack's purpose, version, required capabilities, configurable
  fields, and suggested monitors;
- inspect the current workspace binding and health;
- create a new workspace from a selected pack through a deterministic
  control-plane operation that installs the binding;
- configure declared owner-editable fields;
- remove the pack non-destructively; and
- explain missing capabilities or configuration without pretending the pack or
  provider lacks them.

- [ ] Use Eve call IDs and explicit request IDs as idempotency keys.
- [x] Resolve ambiguous pack names by presenting compact candidates; never pick
  the nearest string match silently.
- [x] A request such as “create an IPO agent that checks at 9 AM and 4 PM” may
  atomically create the workspace, install the pack, configure the times, and
  enable the exact requested monitor because activation was explicit.
- [x] A request such as “show me the IPO pack” or “install the IPO pack” may
  inspect it or create a new bound session, but cannot infer an active schedule
  the owner did not request; templates remain paused.
- [x] The creation response completes in the source workspace continuation.
  Selecting the new workspace affects only the next owner message, which starts
  the target workspace's initial generation. Later configuration or removal
  advances that generation.
- [x] Generic session-management language such as “create a new session” opens
  the existing manager. A concrete pack-plus-configuration request reaches the
  pack-aware path or a prefilled manager flow. Both surfaces call the same
  owner-authorized application service.
- [ ] Configuration and removal requests identify affected resources before
  application and require an explicit owner confirmation that managed work will
  pause and future messages will start a fresh conversation generation. Durable
  brief and findings remain.
- [x] Pack-management tools cannot authorize financial actions or bypass the
  Spectrum manager's owner-bound mutation capabilities.

## Spectrum session-manager additions

Extend the existing session manager rather than building a separate pack app.
The selected session view shows:

- installed pack name, exact version, maturity, and health;
- compact purpose and configurable values;
- required capabilities with available or denied status;
- declared sources and pack-managed monitors;
- pending request state and its resource/cadence/budget effects, while an atomic
  mutation is in flight; and
- create, configure, and remove controls appropriate to current state.

The manager uses these owner-visible states:

| Binding state | Presentation | Available action |
| --- | --- | --- |
| `unbound` | General-purpose session; no pack installed | Browse or inspect the bounded catalog and create a new pack-bound session; distinguish an empty catalog from load failure |
| `unavailable` | Exact version or required-capability failure; managed monitors paused | Inspect the cause or remove non-destructively |
| `active` | Exact pack and required capabilities are healthy | Configure declared fields or remove non-destructively |

Pending, conflict, and failure are request/UI states, not partially committed
binding states. Disable conflicting controls while the request is pending;
afterward render only authoritative `unbound`, `active`, or `unavailable` state
plus the immutable receipt or bounded error.

- [x] Preserve the manager's accepted grayscale visual language and user-facing
  **session** terminology.
- [x] Keep catalog list responses compact and paginate or bound them even though
  the first catalog is small.
- [ ] Bind every mutation to owner, conversation, workspace, generation,
  expected binding revision, mutation ID, and one-time request ID.
- [ ] Make stale, repeated, cross-workspace, and expired actions harmless.
- [ ] Do not reuse financial approval copy or state for strategy-pack changes.
- [x] Keep pack details progressively disclosed so monitor controls remain easy
  to reach on mobile.

Information priority is fixed: session identity and health first, monitor
controls second, a collapsed pack summary third, and request details only while
an install, configuration change, or removal is pending.

## Reference pack: IPO Filings 1.0.0

The reference pack converts Spec 1's hand-configured acceptance workspace into
the first packaging foundation. It proves one safe installation shape; it does
not by itself prove that every future strategy fits the same abstraction. It is
intentionally a monitor, not a complete investment strategy.

### Pack definition

`IPO Filings@1.0.0` declares:

- pack ID `ipo-filings` and maturity `reference`;
- a compact purpose: detect newly published SEC S-1 registrations and
  distinguish amendments from new candidates;
- configuration fields for IANA timezone and one or more unique local daily
  check times;
- the application-owned official SEC latest-filings Atom adapter;
- one `detect-new-s1` monitor template, initially paused;
- the public-event-monitoring skill plus the minimum scoped source/finding/alert
  tools from Spec 1;
- explicit denials for general web search, Masterkey, Coinbase, shell,
  filesystem, private history, and interactive approval;
- `ipo-registration-filing/v1` structured finding schema; and
- the required deterministic eval suite.

The finding schema preserves accession number, CIK, company name, form type,
file number when present, filed/published/observed times, canonical filing URL,
classification of `new_registration` or `amendment`, content hash, pack version,
and source provenance.

### Installation fixture

- [x] From a general-purpose conversation, create a new workspace bound to
  `ipo-filings@1.0.0` with
  timezone `America/Vancouver` and daily times `09:00` and `16:00`.
- [x] Verify one pack binding, one pack-managed monitor, one exact version/digest,
  and no duplicate resources on replay.
- [x] Verify the monitor is enabled only when the fixture owner request explicitly
  asks to begin that schedule; an inspect/install-only fixture leaves it paused.
- [x] Verify another workspace sees neither the IPO skill nor its scoped tools,
  sources, configuration, or findings.

### Behavior fixtures

- [x] Reuse Spec 1's initial-checkpoint, one-new-S-1, replay, S-1/A, malformed,
  oversized, stale, redirected, incomplete-source, and concurrent-workspace
  fixtures rather than creating conflicting source semantics.
- [x] Assert the pack-specific skill is available in the installed workspace and
  unavailable in a general-purpose or differently packed workspace.
- [x] Assert the worker receives only `detect-new-s1` instructions and exact SEC
  capabilities, not the full catalog or other strategy research.
- [x] Assert every finding matches `ipo-registration-filing/v1` and records the
  exact pack version and digest.

### Removal and unavailable-version fixtures

- [ ] Removal pauses or retires pack-managed resources without deleting their
  checkpoints, findings, alerts, or history.
- [ ] A digest mismatch, missing version, or blocked version pauses managed
  monitors and fails closed before another worker executes.
- [ ] Replaying a removal returns the original receipt and creates no duplicate
  resource mutations.


## Failure contracts

- [x] Invalid pack at build: fail catalog generation with bounded file and error
  code; do not emit a partial production catalog.
- [ ] Missing installed version after deployment: mark the binding unavailable,
  pause its managed monitors, preserve workspace data, and allow only inspection
  or non-destructive removal.
- [x] Same version/different digest: treat as an integrity failure, never an
  allowed mutation.
- [ ] Missing required capability: keep the binding inactive or unavailable and
  report the precise unavailable-capability reason.
- [ ] Duplicate install/configure/remove request: return the original mutation
  receipt and never create duplicate resources or generations.
- [ ] Concurrent workspace mutation: reject the stale expected revision; do not
  merge blindly.
- [ ] Atomic mutation failure: change no durable key and create no success
  receipt.
- [ ] Deployment rollback: continue using the exact compiled historical version
  when present; otherwise fail closed as unavailable rather than substituting a
  different version.
- [ ] Pack blocked after activation: prevent new runs immediately, pause managed
  monitors, show a bounded owner-visible reason, and preserve evidence.
- [x] Instruction or tool resolution failure: fail the turn/run before model or
  source execution; do not fall back to all global instructions or tools.

## Implementation plan

The implementation-ready sequence is maintained once in
[`docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md`](../docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md).
Its units cover the Spec 1 production prerequisites, catalog generation,
in-place strategy-record evolution, bounded pack mutations, Eve/worker runtime
composition, the IPO reference pack, Eve/Spectrum parity, integration, and
owner-authorized rollout. Git commits and verification output record progress;
this product contract does not maintain a second sprint ledger or planned-file
inventory.

## Verification matrix

| Boundary | Required proof |
| --- | --- |
| Package integrity | Paths stay inside the version directory; bytes are bounded; ID/version/digest is immutable and reproducible. |
| Compatibility | Incompatible core, workspace, schema, capability, source, or finding references fail before activation. |
| Authorization | Pack tools derive owner/workspace from authenticated context; forged IDs and cross-workspace actions fail. |
| Installation | Replay and concurrent requests create one binding, generation transition, and resource set. |
| Configuration | Unknown or invalid values fail; owner overrides remain separate from immutable pack defaults. |
| Capabilities | Pack requirements do not grant access; effective access remains default-deny and provider drift is visible. |
| Activation | Pack browsing/install-only starts no monitor; an explicit schedule request enables only the requested monitor. |
| Context isolation | Only the active pack's added mission/playbook appears; other packs and raw research documents remain absent; shared Eve tools retain Spec 1 authorization. |
| Worker isolation | A run receives one monitor instruction and exact sources, not interactive history, catalog contents, or other packs. |
| Mutation safety | Install, configuration, and removal are revision-bound, replay-safe, and explicit about affected cadence, budget, source, capability, and resources. |
| Removal | Managed resources pause or retire safely; findings and history remain; generation rollover invalidates stale work. |
| Source pinning | Every source uses an exact application-owned contract version/digest and allowed-origin set. |
| Unavailable/blocked | Missing, mismatched, or blocked versions pause managed work and never fall back to a different pack. |
| Eve durability | Dynamic executors survive replay; atomic mutation failure changes no key; workers remain idempotent at application boundaries. |
| Reference behavior | IPO installation, S-1 detection, amendment classification, dedupe, alerts, and no-match behavior pass deterministic fixtures. |
| UX | Natural language and Spectrum display and mutate the same authoritative binding and mutation state. |
| Regression | General workspaces and every accepted Spec 1 behavior continue to work without a strategy pack. |

## Observability and operations

- [ ] Emit low-cardinality counters for catalog validation, install,
  configuration, removal, mutation conflict/failure, binding unavailable,
  pack run stale, and capability unavailable.
- [ ] Use pack ID only where its catalog cardinality is deliberately bounded;
  never tag metrics with owner/workspace IDs, versions, digests, config values,
  source URLs, watchlists, or instructions.
- [ ] Emit bounded error codes rather than manifest bodies, prompts, owner
  configuration, or source data.
- [ ] Add operator reports for installed version counts, unavailable/blocked
  bindings, failed mutations, and retired resources without private
  workspace content.
- [x] Add kill switches for pack installation/mutation, dynamic pack composition,
  and pack-managed monitor dispatch independently.
- [ ] Define retention for mutation receipts and retired-resource metadata.
- [ ] Document how to block a faulty pack version, inspect affected bindings,
  disable the feature safely, and verify that no managed worker remains active.

## Rollout and rollback

- [x] Keep the pack catalog visible only to the configured deployment owner.
- [ ] Enable catalog inspection first, then installation in fixture/dev, then
  runtime composition, then Spectrum controls, and finally the Photon live smoke.
- [ ] Keep general-purpose sessions and Spec 1 monitor behavior available while
  pack feature flags are disabled.
- [ ] Feature rollback may stop new pack mutations and pack-managed dispatch
  while preserving bindings, monitors, findings, and receipts.
- [x] Do not remove a compiled pack version while a durable active binding still
  references it.
- [ ] Record the deployed commit, catalog digest, reference-pack digest, feature
  flag state, smoke result, and rollback verification without owner data.

## Definition of done

This specification is complete only when:

- [ ] Every implementation-plan unit passes and a clean fork produces the same
  validated catalog and reference-pack digest.
- [x] A general-purpose session remains valid with no pack.
- [x] The owner can create a new IPO Filings session, pin its exact pack and
  source-contract digests, and explicitly configure and enable its 9 AM/4 PM
  monitor.
- [x] Inspect/install-only starts no background work, while forbidden or missing
  capabilities and pack/source mismatches fail closed.
- [x] Concurrent pack-bound and general sessions show no cross-workspace
  instruction, skill, tool, configuration, or finding leakage.
- [x] Natural-language and Spectrum operations agree on the authoritative
  binding, health, configuration, and mutation status.
- [ ] Non-destructive removal preserves findings, alerts, checkpoints, history,
  and owner-created resources.
- [ ] Spec 1 regressions, builds, privacy and redirect gates, owner-authorized
  production acceptance, and feature rollback all pass before rollout.
- [ ] `HANDOFF.md`, `NORTH_STAR.md`, and `BACKLOG.md` record only verified
  implementation facts and remaining follow-ons.

## Follow-on specifications

Completion of this framework authorizes no strategy or financial action by
itself. Focused follow-on specifications may use it for:

- A real second pack or second released version must validate which abstractions
  are genuinely reusable before adding generalized update, downgrade,
  replacement, rollback, or automatic-adoption workflows.

1. [`Spec 3: Versioned public-source adapters and canonical facts`](03-public-source-adapters.md)
   for reviewed fetch, parse, normalize, checkpoint, and source-event plumbing.
2. [`Spec 4: Congressional Signals v1 — House PTRs`](04-congressional-signals-house.md)
   for House disclosure analysis, member history, clusters, and local scoring.
3. [`Spec 5: Insider Clusters`](05-insider-clusters.md) for official Form 4
   history, transaction classification, clusters, and local scoring.
4. [`Spec 6: Typed shared-signal plane`](06-shared-signal-plane.md) for explicit,
   bounded cross-strategy signal promotion and convergence without shared
   workspace context.
5. Cramer Inverse source acquisition, attributable statement extraction,
   stance classification, and signal rules.
6. Workspace-aware proposed-order, reservation, preview, approval, and broker
   reconciliation.
7. General topic-change detection beyond the bounded alert-reply guard.
8. Telegram migration to the workspace broker and pack-aware session manager.
