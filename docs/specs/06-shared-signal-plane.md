# Spec 6: Typed shared-signal plane

Status: Draft for implementation after Specs 1–5

Date: 2026-08-14

Product target: `NORTH_STAR.md`

Dependencies:

- `specs/01-independent-workspace-runtimes.md`
- `specs/02-versioned-strategy-packs.md`
- `specs/03-public-source-adapters.md`
- `specs/04-congressional-signals-house.md`
- `specs/05-insider-clusters.md`

## Plain-language objective

Let specialized strategy agents notice when their independently produced public
signals point to the same company, without letting the agents read one another's
conversations, memories, instructions, tools, or full findings.

For example, Congressional Signals may detect a qualifying House disclosure for
an issuer while Insider Clusters independently detects a qualifying Form 4
cluster at that issuer. With explicit owner permission, each strategy can
publish a small, typed projection of that signal to an owner-scoped shared
signal plane. A subscribed convergence workspace can match the two projections,
explain the public overlap, and alert the owner. The original workspaces remain
isolated and independently runnable.

This is not a shared context window, a mother agent, or a universal investment
score. It is a narrow, permissioned exchange of versioned public signal records.

## How to use this specification

Implement only after Specs 4 and 5 have stable signal schemas and deterministic
fixtures. Reuse Spec 1 for runtime, ownership, budgets, alerts, and routing;
Spec 2 for pack installation and capability composition; and Spec 3 for public
evidence. This specification adds canonical entity resolution, promotion,
subscriptions, bounded queries, correction propagation, and a reference
cross-strategy convergence detector.

Every implementation item is a checklist. Complete sprints in order. Do not
create generic cross-workspace memory or expose a workspace store merely because
two strategies belong to the same owner.

## Goal and acceptance experience

The completed foundation must support this scenario:

1. The owner has independently running `Congressional Signals`, `Insider
   Clusters`, and `Public Signal Convergence` sessions.
2. Through the session manager or natural language in each producing workspace,
   the owner explicitly permits only selected signal types to be promoted.
3. Congressional Signals produces a qualifying public House signal and Insider
   Clusters produces a qualifying public Form 4 cluster for the same canonical
   issuer inside a configured freshness window.
4. Each producer writes an immutable, schema-validated projection containing
   only approved public fields, source-fact references, local band, timestamps,
   and correction lineage. No conversation, workspace brief, private note,
   instruction, or undeclared field crosses the boundary.
5. The convergence workspace is explicitly subscribed to those two signal types.
   A bounded deterministic query resolves the common issuer and creates one
   versioned match.
6. Eve sends one **Public Signal Convergence** alert identifying the two public
   strategies, explaining the overlap and important limitations, and linking to
   each owning workspace through **Discuss** actions. It does not switch the
   selected workspace automatically.
7. A source correction, strategy rescore, expiry, replay, or revoked permission
   updates or retracts the match without duplicate alerts or leaked history.
8. A different workspace without the declared subscription cannot enumerate,
   query, or infer the promoted signals.

## Agreed product decisions

- [ ] Workspace conversation history, goals, briefs, durable findings, strategy
  configuration, and capabilities remain isolated by default.
- [ ] Source-global canonical public facts from Spec 3 are evidence, not shared
  strategy conclusions.
- [ ] A workspace finding is never shareable merely because its evidence is
  public. Sharing requires a reviewed promoted-signal schema, a pack projection
  policy, and explicit owner authorization.
- [ ] Promotion is default-deny for every workspace and signal type.
- [ ] Subscribing to a signal type is also default-deny and separate from
  permission to publish it.
- [ ] Version 1 accepts only public-source-derived strategy signals. Private
  artifacts, messages, portfolio data, broker data, approvals, and personal
  financial context are excluded.
- [ ] The shared plane is scoped to one authenticated owner. No cross-owner
  publishing, discovery, matching, or aggregate learning is permitted.
- [ ] Shared projections are typed, versioned, immutable, bounded, and validated
  before storage. There is no free-form shared-memory field.
- [ ] Canonical entity identity is explicit and versioned. Ticker or name
  equality alone is insufficient for a match.
- [ ] Company/issuer identity and security/instrument identity remain distinct.
- [ ] Producer-local scores and bands retain their original meaning and cannot
  be numerically added or compared as if they share a scale.
- [ ] The shared plane finds typed overlap. A consuming strategy owns any
  convergence rule, interpretation, score, finding, and alert.
- [ ] Version 1 includes one narrow `Public Signal Convergence` reference pack
  for Congressional Signals plus Insider Clusters; it is not a universal
  strategy combiner.
- [ ] Revocation stops future query/use immediately and retracts derived active
  matches according to explicit lineage. It does not rewrite immutable audit
  receipts.
- [ ] Pausing or archiving a producer pauses new production under Spec 1 but
  does not fabricate retractions for still-valid signals. Expiry and explicit
  strategy corrections determine validity.
- [ ] Starting fresh in a workspace preserves its promotion settings and
  durable signal lineage because it replaces temporary conversation history
  only.
- [ ] Telegram remains deferred. Photon/iMessage and Spectrum are the version 1
  user surfaces.
- [ ] No private artifact system is required.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Canonical public fact | Source-global immutable evidence produced under Spec 3, without strategy interpretation. |
| Workspace finding | Private-to-workspace strategy interpretation produced under Spec 1 or a strategy pack. |
| Promoted signal schema | Reviewed versioned definition of the exact fields a signal type may share. |
| Projection policy | Deterministic pack code that converts one eligible workspace finding revision into a promoted signal. |
| Promotion grant | Owner authorization allowing one workspace binding to publish one schema/type under bounded conditions. |
| Promoted signal | Immutable owner-scoped projection safe for subscribed strategy consumers. |
| Subscription | Owner authorization allowing one workspace binding to query specified promoted types using bounded filters. |
| Canonical entity | Versioned identity for an issuer/company or security, supported by source identifiers and evidence. |
| Match | Immutable deterministic record that selected promoted signals satisfy a consumer's rule. |
| Convergence finding | Workspace-owned interpretation created from a match by a consuming pack. |
| Retraction | Immutable lifecycle event declaring that a prior signal or match is no longer active. |
| Expiry | Deterministic end of a signal's configured useful lifetime; not a source correction. |

## Scope

### In scope

- Owner-scoped canonical issuer and security identities with versioned aliases.
- Deterministic entity-resolution evidence, ambiguity handling, and corrections.
- Versioned promoted-signal schema registry.
- Pack-declared projection policies with bounded field allowlists.
- Explicit publish grants and consumer subscriptions.
- Immutable promotions, supersession, expiry, correction, and retraction.
- Bounded, typed, capability-gated signal queries.
- Idempotent match creation and derived-finding lineage.
- Reference `public-signal-convergence@1.0.0` pack matching qualifying
  Congressional Signals and Insider Clusters projections.
- Photon alerts, **Discuss** routing, natural-language controls, and Spectrum
  visibility using existing Spec 1 paths.
- Deterministic isolation, replay, correction, authorization, and leakage evals.

### Out of scope

- Shared chat history, summaries, workspace briefs, goals, instructions, tools,
  skills, scratchpads, model state, or arbitrary memories.
- A supervisor or mother model with automatic access to every workspace.
- Cross-owner, household, team, or public signal exchanges.
- Private documents, email, messaging, calendar, broker, portfolio, order,
  approval, payment, credential, or personal-finance data.
- Copy trading, automatic order proposals, position sizing, or broker access.
- A universal alpha score, ranking model, portfolio optimizer, or recommendation
  engine.
- Adding scores from different packs or silently normalizing them onto one scale.
- Fuzzy entity matching performed by an unconstrained model.
- A general-purpose analytics lake or unrestricted SQL/search interface over all
  owner data.
- Strategy-to-strategy messaging or direct worker invocation.
- Automatic publication by every existing or future strategy pack.
- Cramer Inverse, valuation, earnings language, social, crypto, or other future
  convergence rules.
- Telegram delivery or session management.

## Non-negotiable invariants

- [ ] Every read and write derives `ownerId` and `workspaceId` from authenticated
  execution context. Model-provided identity fields are ignored or rejected.
- [ ] Cross-owner access fails before entity, schema, grant, signal,
  subscription, match, or audit state is returned.
- [ ] A worker can read only signal types named by its active binding's reviewed
  capability manifest and an active owner subscription.
- [ ] A producer can promote only the exact schema/type allowed by both its pack
  manifest and an active owner grant.
- [ ] Promotion validation rejects unknown fields, free-form hidden payloads,
  unbounded arrays/text, private classifications, and unsupported schema
  versions.
- [ ] Promoted signals contain references to canonical public facts and
  producer-owned finding revisions, not copied source documents or full private
  findings.
- [ ] Consumers never dereference a producer finding, brief, configuration, run,
  conversation, or tool output through those references.
- [ ] Entity resolution never merges on ticker/name similarity alone. Ambiguous
  mappings remain unresolved and cannot produce convergence.
- [ ] One issuer match never implies that two disclosed securities are
  equivalent. Security-level rules require an explicit canonical security
  mapping.
- [ ] Publication and subscription are independent. A workspace cannot read a
  type merely because it publishes that type.
- [ ] Promoted records and lifecycle events are append-only. Corrections and
  revocations supersede or retract; they never mutate historical payloads.
- [ ] Every match is reproducible from exact signal revisions, entity-resolution
  revision, consumer rule version, configuration revision, and as-of time.
- [ ] Expired, retracted, unauthorized, ambiguous, or schema-incompatible
  signals cannot enter a new active match.
- [ ] A repeated promotion, query, match evaluation, correction, or alert is
  idempotent.
- [ ] Producer-local score, confidence, or band is namespaced by pack and policy
  version. The shared plane never recalibrates it.
- [ ] A consumer model cannot choose match membership, freshness, entity
  equality, lifecycle status, or numeric contributions.
- [ ] Disabling the signal plane stops new promotion/query/match dispatch while
  preserving durable records for rollback and audit.
- [ ] Logs and metrics never contain owner/workspace IDs, entity names, tickers,
  CIKs, securities, source URLs, signal IDs, finding IDs, configurations, or
  payload fields.

## Separation of records

The implementation must preserve these boundaries:

| Record | Scope | Contains interpretation? | Readable by |
| --- | --- | --- | --- |
| Canonical public fact | Source-global | No | Authorized source/strategy code through Spec 3 |
| Workspace finding | Owner + one workspace | Yes | Owning workspace only |
| Promoted signal | Owner + typed grant | Bounded producer interpretation | Explicitly subscribed bindings only |
| Match | Owner + consumer workspace | Deterministic overlap only | Owning consumer workspace |
| Convergence finding | Owner + consumer workspace | Yes | Owning consumer workspace only |

- [ ] Do not reuse the workspace finding table as the promoted-signal store.
- [ ] Do not add a cross-workspace bypass to existing finding-read tools.
- [ ] Do not make source-global facts directly enumerable by strategy workers.
- [ ] Keep audit references opaque to consumers unless a separate capability
  resolves them to an approved public-source link.
- [ ] Treat a match as consumer-owned durable state, not a mutation of either
  producer's signal or workspace.

## Target architecture

```text
public source
    |
    v
Spec 3 canonical facts
    |
    +-------------------------+
    |                         |
    v                         v
Congressional workspace   Insider workspace
private finding           private finding
    |                         |
    | explicit grant +        | explicit grant +
    | reviewed projection     | reviewed projection
    v                         v
typed promoted signal     typed promoted signal
    \                         /
     \ owner-scoped, typed   /
      v                     v
       shared signal plane
              |
              | explicit consumer subscription
              v
       Convergence workspace
       deterministic match
       private convergence finding
              |
              v
       Spec 1 alert + Discuss routing
```

- [ ] The signal plane must be a durable service boundary, not prompt assembly.
- [ ] Promotion and matching must run as bounded Eve execution steps with
  application-level idempotency.
- [ ] Runtime workers receive only the query result required for the current
  monitor occurrence.
- [ ] Interactive sessions see the workspace's own convergence findings, not a
  raw dump of every promoted signal.
- [ ] Use separate kill switches for promotion, query, matching, and alerting.

## Canonical entity registry

### Entity model

- [ ] Define `CanonicalEntity` with at least:
  - immutable `entityId`;
  - `entityType` of `issuer` or `security` in version 1;
  - lifecycle status;
  - created/effective timestamps;
  - current resolution revision pointer; and
  - no owner-private content.
- [ ] Define immutable `EntityResolutionRevision` with:
  - canonical entity ID;
  - normalized reviewed identifiers;
  - exact evidence fact references;
  - resolver/version;
  - status of `resolved`, `ambiguous`, `superseded`, or `retracted`;
  - effective interval; and
  - predecessor/successor lineage.
- [ ] Define typed aliases for identifiers actually supported by reviewed
  sources, such as SEC CIK, normalized legal issuer name, exchange+ticker with
  effective dates, and security identifiers when lawfully/publicly available.
- [ ] Model issuer-to-security relationships explicitly and time-bound them.
- [ ] Preserve mergers, name changes, ticker reuse, multiple share classes, and
  issuer reorganizations without rewriting old evidence.

### Resolution policy v1

- [ ] Resolve exact stable identifiers first.
- [ ] Permit reviewed deterministic crosswalks only when their source,
  effective date, and version are stored.
- [ ] Treat exchange+ticker as a time-bound alias, not permanent identity.
- [ ] Use normalized legal name only to generate a candidate requiring
  corroboration; never finalize a merge from name similarity alone.
- [ ] Reject model-proposed entity merges at runtime.
- [ ] Require an operator-reviewed/versioned rule or source crosswalk for
  previously ambiguous mappings.
- [ ] Make resolution return `unresolved` or `ambiguous` with reason codes
  instead of guessing.
- [ ] Re-evaluate dependent active matches when a resolution revision is
  corrected, split, merged, superseded, or retracted.
- [ ] Ensure fixture entity IDs are deterministic and production IDs do not
  leak into test snapshots.

## Promoted-signal schema registry

### Schema definition

- [ ] Define immutable `PromotedSignalSchemaDefinition` with:
  - schema ID and semantic version;
  - owning pack ID and compatible pack versions;
  - human-readable purpose;
  - JSON/data schema with strict unknown-field rejection;
  - maximum encoded bytes, array counts, string lengths, and source references;
  - allowed entity types;
  - lifecycle and default expiry policy;
  - projection policy ID/version;
  - public-data classification declaration;
  - compatibility/migration rules; and
  - reviewed digest.
- [ ] Compile the registry at build/deploy time like the Spec 2 catalog.
- [ ] Reject duplicate schema ID/version with different bytes.
- [ ] Reject a schema that includes arbitrary metadata, free-form model context,
  private content, secrets, credentials, raw documents, or tool outputs.
- [ ] Require a security/privacy review before a new schema becomes promotable.
- [ ] Treat a new optional field as schema drift requiring an explicit compatible
  version and provider/pack review.

### Version 1 producer schemas

- [ ] Define `congressional.house.signal@1` with only reviewed fields needed for
  matching/explanation, such as:
  - canonical issuer ID and, only if resolved, canonical security ID;
  - producer pack and local policy version;
  - producer signal kind and local alert band;
  - public event/transaction interval;
  - filing/publication time and disclosure-lag bucket;
  - bounded member-count, transaction-count, and cluster-kind summaries;
  - exact public fact references;
  - validity/expiry time; and
  - material unknown flags.
- [ ] Do not promote member notes, watchlist rationale, private owner thresholds,
  hidden score traces, conversation text, or full transaction history.
- [ ] Define `insider.cluster.signal@1` with only reviewed fields needed for
  matching/explanation, such as:
  - canonical issuer ID and, only if resolved, canonical security ID;
  - producer pack and local policy version;
  - producer signal kind and local alert band;
  - cluster window and most recent qualifying transaction time;
  - bounded distinct-insider and qualifying-purchase counts;
  - plan-status/history-coverage unknown flags;
  - exact public fact references;
  - validity/expiry time; and
  - material unknown flags.
- [ ] Do not promote insider names, private thresholds, full transaction rows,
  model prose, hidden score traces, or workspace history unless a later schema
  explicitly reviews a necessary public field.

## Grants and subscriptions

### Promotion grant

- [ ] Define immutable/revisioned `SignalPromotionGrant` with:
  - authenticated owner and producing workspace binding;
  - exact pack ID/version or compatible range;
  - exact signal schema ID/version;
  - allowed local signal kinds/bands if configured;
  - maximum freshness/retention override within platform bounds;
  - enabled/paused/revoked status;
  - configuration revision;
  - creator surface and authorization receipt; and
  - effective/revoked timestamps.
- [ ] Creating a workspace or installing a pack creates no promotion grant.
- [ ] Grants require clear owner intent in Spectrum or a revision-bound natural
  language change plan under Spec 2.
- [ ] Pack upgrades adding or widening a promotable schema require a new plan;
  they cannot inherit broader rights silently.
- [ ] Pausing a grant stops new promotion. Revocation also prevents future query
  use of its active signals and triggers match re-evaluation.

### Consumer subscription

- [ ] Define immutable/revisioned `SignalSubscription` with:
  - authenticated owner and consuming workspace binding;
  - consumer pack ID/version;
  - exact allowed producer schema IDs/compatible versions;
  - entity type and bounded time-window filters;
  - maximum results/query and calls/run;
  - enabled/paused/revoked status;
  - configuration revision; and
  - authorization receipt.
- [ ] Installing a convergence-capable pack creates no active subscription
  unless the installation plan explicitly requests it.
- [ ] A subscription cannot widen the consumer pack capability manifest.
- [ ] Natural-language edits must show exactly which strategy types become
  readable before applying.
- [ ] Archive pauses subscriptions owned by that workspace; restore leaves them
  paused; start-fresh retains them under the Spec 1 lifecycle.

## Promotion contract

- [ ] Define immutable `PromotedSignal` with:
  - unique signal revision ID and stable lineage ID;
  - authenticated owner scope;
  - producing workspace binding and generation as non-queryable audit metadata;
  - producer pack ID/version and local policy version;
  - schema ID/version/digest;
  - canonical entity references and resolution revision;
  - projection payload;
  - exact producer finding revision reference;
  - exact canonical public fact references;
  - observed/effective/as-of/expiry timestamps;
  - lifecycle status;
  - predecessor/successor/retraction lineage; and
  - idempotency key.
- [ ] Calculate the idempotency key from authenticated owner, producer binding,
  finding lineage/revision, schema version, and projection-policy version.
- [ ] Run projection in deterministic application code, never by copying model
  output wholesale.
- [ ] Re-validate the resulting bytes against the registered schema and maximums.
- [ ] Verify every public fact reference belongs to the producer finding's
  authorized evidence lineage.
- [ ] Verify the entity resolution was active at the projection as-of time.
- [ ] Refuse promotion when entity identity is ambiguous, public evidence is
  missing, the grant is inactive, the pack version is incompatible, the schema
  is blocked, or a required field is unknown.
- [ ] Record a bounded reason-coded `SignalPromotionReceipt` for promoted,
  unchanged, refused, superseded, expired, and retracted outcomes.
- [ ] Never expose the producing workspace's raw ID through consumer APIs or
  model context. User-facing attribution may use its current authorized display
  title through a separate routing lookup.

## Lifecycle, corrections, and retention

- [ ] Model lifecycle as immutable events: `active`, `superseded`, `expired`,
  `retracted_by_source`, `retracted_by_strategy`, `retracted_by_grant`, or
  `blocked_schema`.
- [ ] A strategy finding correction must enqueue promotion re-evaluation using
  the new exact finding revision.
- [ ] A source-fact correction from Spec 3 must flow through the owning strategy
  first; the signal plane cannot reinterpret source data on its own.
- [ ] A new valid producer revision supersedes the prior active signal instead
  of editing it.
- [ ] Expiry uses durable scheduled work and deterministic as-of time, not a
  process-local timer.
- [ ] Expiry prevents new matches and triggers re-evaluation of active matches.
- [ ] Revoking a grant makes its active signals unavailable immediately and
  creates durable retraction lineage asynchronously/idempotently.
- [ ] Historical promotion receipts retain only bounded audit metadata under a
  documented retention period.
- [ ] Payload retention must not outlive the owning public facts or applicable
  product retention policy.
- [ ] Deletion UX must explain that deleting a workspace is distinct from
  revoking shared projections and must require explicit, safe lifecycle choices.
- [ ] No deletion path may leave queryable orphan signals or matches.

## Bounded signal query contract

- [ ] Expose only typed query tools, not SQL, vector search, generic full-text
  search, filesystem access, or arbitrary predicates.
- [ ] A query derives owner/consumer binding from execution context and requires:
  - active Spec 2 capability;
  - active subscription;
  - compatible schema versions;
  - exact entity IDs or a bounded set resolved before query;
  - fixed time range within subscription limits;
  - fixed result limit and deterministic ordering; and
  - one monitor occurrence/run identity.
- [ ] The query service returns only active, unexpired, authorized projections
  and bounded public-source link descriptors.
- [ ] Do not return promotion grants, producer configuration, producer workspace
  IDs, nonmatching signal counts, or existence side channels.
- [ ] Apply maximum queries/run, results/query, entities/query, lookback,
  response bytes, and execution time.
- [ ] Reserve any metered query budget atomically under Spec 1.
- [ ] Return explicit reason codes for unavailable schema, disabled plane,
  missing subscription, incompatible version, ambiguous entity, bounded result
  truncation, and revoked signal.
- [ ] Cache only owner-scoped, subscription-scoped results with revision-aware
  keys and bounded lifetime.
- [ ] Replays must return the same ordered result for the same as-of snapshot or
  fail explicitly if that snapshot is outside retention.

## Match and convergence contract

- [ ] Define immutable `SignalMatchRevision` with:
  - stable match lineage ID and immutable revision ID;
  - authenticated owner and consumer workspace binding;
  - consumer pack/rule/configuration versions;
  - exact promoted signal revision IDs;
  - canonical entity and resolution revision;
  - evaluated as-of time and freshness interval;
  - deterministic rule result/factor trace;
  - active/superseded/expired/retracted lifecycle;
  - predecessor/successor lineage; and
  - idempotency key.
- [ ] Match identity must be stable regardless of input retrieval order.
- [ ] One signal cannot satisfy two required legs of a rule unless the rule
  explicitly declares that behavior; the reference rule forbids it.
- [ ] A match references only signals visible through the consumer's active
  subscription at evaluation time.
- [ ] Changes to signals, entity resolution, grants, subscriptions, consumer
  rules, or configuration schedule exact dependent re-evaluation.
- [ ] A consumer creates its own private convergence finding from a match. The
  promoted-signal store never writes into producer workspaces.
- [ ] Alert idempotency includes match lineage/revision and alert-policy version.
- [ ] A retracted/expired match can produce at most one correction alert when
  owner policy requests correction notices.

## Reference pack: Public Signal Convergence

### Pack definition

- [ ] Create `public-signal-convergence@1.0.0` through Spec 2.
- [ ] State the mission narrowly: identify public issuer-level overlap between
  eligible Congressional Signals and Insider Clusters signals.
- [ ] Require only:
  - typed subscription/query capability for
    `congressional.house.signal@1` and `insider.cluster.signal@1`;
  - deterministic entity/match tools;
  - workspace finding/completion tools;
  - Spec 1 alert capability when enabled; and
  - no source fetching, shell, filesystem, broker, portfolio, order, approval,
    private artifact, or generic cross-workspace read capability.
- [ ] Include no producer workspace prompt, playbook, tool, or conversation in
  its runtime context.
- [ ] Install with subscriptions and monitors disabled unless the owner
  explicitly requests activation.

### Reference rule v1

- [ ] Require one active eligible `congressional.house.signal@1` and one active
  eligible `insider.cluster.signal@1`.
- [ ] Require the same resolved canonical issuer. Security-level equality may be
  displayed only when both signals share an explicit resolved security.
- [ ] Require each signal to be within its own validity period and inside the
  owner-configured convergence lookback.
- [ ] Default the lookback to 90 days and permit only a reviewed bounded range.
- [ ] Require producer-local band eligibility declared by configuration; do not
  convert bands into shared numeric scores.
- [ ] Store each producer band with its namespaced policy version.
- [ ] Produce deterministic factors:
  - issuer identity basis;
  - signal-type presence;
  - event-time distance;
  - filing/publication-time distance;
  - whether security identity also aligns;
  - producer-local bands as labels;
  - each signal's important unknown flags; and
  - public evidence references.
- [ ] Do not infer causation, coordination, insider knowledge, political intent,
  illegality, expected return, or trade direction.
- [ ] Do not create a match if either entity is ambiguous or either projection is
  unauthorized, expired, retracted, schema-blocked, or incompatible.
- [ ] Create one match lineage per canonical issuer and rule/configuration
  version for an overlapping active set; revise it as members change.
- [ ] Historical backfill creates findings labeled historical and sends no live
  alerts.

### Reference alert

- [ ] Label the source workspace as **Public Signal Convergence**.
- [ ] State that two independently defined public research signals overlap at
  the same canonical issuer.
- [ ] Name each strategy type and show public event/filing dates, local bands,
  freshness, and important unknowns without presenting a universal score.
- [ ] Link to bounded public evidence summaries.
- [ ] Provide separate **Discuss Congressional Signals**, **Discuss Insider
  Clusters**, and **Discuss Convergence** actions when the owner is authorized.
- [ ] Reuse Spec 1's one-time, revision-bound held-message and routing behavior.
- [ ] Never switch the selected workspace automatically.
- [ ] Include neutral language: overlap is a research lead, not proof of shared
  information, wrongdoing, or future performance.

## Natural-language and Spectrum controls

- [ ] In a producing workspace, support intents equivalent to:
  - “Allow high Congressional Signals to be used by my convergence agent.”
  - “Stop sharing Insider Cluster signals.”
  - “Show what this workspace is allowed to publish.”
- [ ] In the convergence workspace, support intents equivalent to:
  - “Watch for Congressional and Insider overlap within 90 days.”
  - “Pause convergence alerts but keep the findings.”
  - “Only match the qualifying bands shown in this change plan.”
- [ ] Resolve every mutation through a deterministic, revision-bound Spec 2
  plan; the model does not directly grant access.
- [ ] Ambiguous requests such as “share this with my other agents” must ask which
  reviewed signal types and consumers, not create broad access.
- [ ] The session manager must show, per workspace:
  - promoted signal types and status;
  - consumer subscriptions and status;
  - compatible pack/schema versions;
  - freshness/lookback and bounded eligibility settings;
  - last promotion/query/match and next run;
  - blocked/unavailable reason;
  - pause/resume/revoke controls; and
  - clear separation from workspace conversation/history.
- [ ] Revocation requires a confirmation that states active matches may retract.
- [ ] Stale mini-app actions fail safely against grant/subscription/configuration
  revisions.
- [ ] Spectrum and Photon natural-language changes mutate the same authoritative
  records.

## Deterministic fixture suite

- [ ] Build fixed fixtures for:
  - exact CIK match across House issuer and SEC issuer;
  - ticker/name match without stable corroboration, which remains ambiguous;
  - ticker reuse across effective dates;
  - multiple share classes under one issuer;
  - issuer name change and merger/split lineage;
  - one qualifying Congressional signal;
  - one qualifying Insider Cluster signal;
  - signals inside and outside the convergence window;
  - producer signal correction, expiry, and retraction;
  - grant and subscription revocation;
  - incompatible/unknown/blocked schema versions;
  - unknown extra projection fields and oversized payloads;
  - duplicated and reordered delivery;
  - cross-owner and unsubscribed-workspace attempts; and
  - malicious model content containing forged IDs or private fields.
- [ ] Snapshot promoted projections, rejection reason codes, matches, factor
  traces, convergence findings, and alerts.
- [ ] Assert fixture snapshots contain no raw conversations, briefs, private
  configuration, insider/member private notes, workspace IDs, credentials,
  provider payloads, or arbitrary model prose.
- [ ] Use fake owner/workspace/entity identifiers only.
- [ ] Make time deterministic for validity, lookback, expiry, and correction
  tests.

## Implementation sprints

### Sprint 0 — contracts, threat model, and failing fixtures

Objective: freeze the isolation boundary and make unsafe behavior fail before
storage or UI work begins.

- [ ] Define the five record scopes: fact, finding, promoted signal, match, and
  convergence finding.
- [ ] Define entity, schema, grant, subscription, promotion, lifecycle, query,
  match, and audit contracts.
- [ ] Freeze version 1 producer schemas and reference convergence rule.
- [ ] Document field-level public/private classification and maximum sizes.
- [ ] Threat-model cross-owner reads, workspace enumeration, hidden fields,
  prompt injection, forged IDs, schema drift, ticker collision, replay,
  correction races, revocation races, and side-channel counts.
- [ ] Add failing fixtures and authorization/isolation tests.
- [ ] Define feature flags and kill switches.

Exit gate:

- [ ] Contract tests fail for every forbidden cross-workspace/private-context
  path and pass for no production promotion path yet.
- [ ] Security review agrees the design introduces no generic workspace-reading
  capability.

### Sprint 1 — canonical entities and deterministic resolution

Objective: give public strategies a reliable shared issuer/security identity
without guessing from names or tickers.

- [ ] Implement canonical entity and resolution revision stores.
- [ ] Implement exact identifier normalization and versioned crosswalk import.
- [ ] Implement issuer/security relationships and effective-date aliases.
- [ ] Add deterministic resolve/unresolved/ambiguous APIs and reason codes.
- [ ] Integrate Spec 4 House issuer facts and Spec 5 SEC issuer facts.
- [ ] Add correction/split/merge lineage and dependent-work discovery.
- [ ] Pass collision, name-change, multi-class, and effective-date fixtures.

Exit gate:

- [ ] Reference Congressional and Insider fixtures resolve the intended common
  issuer, while ticker-only/name-only and conflicting cases cannot match.
- [ ] Resolution replay produces identical revisions and no duplicate entities.

### Sprint 2 — schemas, grants, and promotion

Objective: publish the minimum reviewed public signal projection and nothing
else.

- [ ] Implement compiled promoted-signal schema registry and digest checks.
- [ ] Implement default-deny promotion grants and authorization receipts.
- [ ] Implement deterministic projection policies for Specs 4 and 5.
- [ ] Implement strict validation, storage, idempotency, and promotion receipts.
- [ ] Add schema compatibility/blocking and provider/pack drift behavior.
- [ ] Add supersession, correction, expiry, retraction, and grant-revocation
  workflows.
- [ ] Prove unknown fields, hidden payloads, ambiguous entities, incompatible
  versions, and forged identities fail closed.

Exit gate:

- [ ] One authorized fixture signal from each producer promotes once; replay is
  unchanged; ungranted/private/ambiguous/schema-drift cases promote nothing.
- [ ] Stored projections contain only fields listed in their reviewed schemas.

### Sprint 3 — subscriptions, bounded query, and lifecycle propagation

Objective: let an authorized consumer retrieve only the typed signals required
for one bounded run.

- [ ] Implement default-deny subscriptions and capability checks.
- [ ] Implement typed entity/time/schema query APIs and all bounds.
- [ ] Add stable as-of ordering, pagination/truncation behavior, and replay
  semantics.
- [ ] Implement owner/subscription-scoped caching and invalidation.
- [ ] Implement revocation, expiry, correction, schema-block, and entity-change
  propagation to dependent queries/matches.
- [ ] Add budget reservations if any query path is metered.
- [ ] Pass concurrency and Redis race tests for grant/subscription changes during
  promotion/query.

Exit gate:

- [ ] The convergence fixture sees the two authorized projections and nothing
  else; another workspace and another owner learn nothing about their existence.
- [ ] Revocation takes effect before the next query and dependent work is
  scheduled exactly once.

### Sprint 4 — reference convergence pack and alerts

Objective: prove the plane with one useful cross-strategy workflow.

- [ ] Create and validate `public-signal-convergence@1.0.0`.
- [ ] Implement the issuer-level Congressional plus Insider reference rule.
- [ ] Implement immutable match revisions, stable identity, factor trace, and
  lifecycle.
- [ ] Create workspace-owned convergence findings without producer writes.
- [ ] Add live versus historical behavior and idempotent correction alerts.
- [ ] Add Photon alert copy and three revision-bound **Discuss** actions.
- [ ] Verify selected-workspace routing never changes on alert receipt.
- [ ] Pass positive, no-match, stale, ambiguous, correction, expiry, revoked,
  duplicated, and reordered fixtures.

Exit gate:

- [ ] The acceptance fixture produces one convergence finding and one alert with
  exact lineage and public evidence; replay produces neither duplicate.
- [ ] Correction/revocation retracts the match and, when enabled, sends one
  accurate correction alert.

### Sprint 5 — owner controls, end-to-end proof, and rollout

Objective: make sharing understandable, controllable, observable, and safe in
production.

- [ ] Add natural-language plan/apply flows for promotion and subscription.
- [ ] Add Spectrum visibility, pause/resume/revoke, health, and stale-action
  handling.
- [ ] Run an end-to-end fixture with three simultaneously active workspaces.
- [ ] Run a bounded live-read smoke using public House and SEC evidence only;
  require an actual convergence only if current live data happens to satisfy the
  deterministic rule.
- [ ] Verify no-match live runs complete successfully and visibly.
- [ ] Run load/race tests for duplicate promotion, concurrent query, expiry,
  correction, revocation, archive, and start-fresh.
- [ ] Validate metrics/log redaction, retention, quarantine, kill switches,
  deployment, and rollback runbooks.
- [ ] Roll out entity resolution first, then promotion, query, matching, UI, and
  alerts behind separate flags.

Exit gate:

- [ ] The full acceptance experience passes with fixtures and bounded public
  live-source smoke without private artifacts or broker capabilities.
- [ ] Operators can stop all new sharing/matching without deleting source facts,
  workspace findings, promotion audit, or prior matches.

## Planned code areas

Exact paths must follow the architecture present when implementation begins.
Expected responsibilities include:

- `agent/lib/`: entity resolution, promoted-schema registry, projection,
  authorization, typed query, lifecycle, match identity, and redaction.
- `agent/data/` or equivalent: reviewed entity crosswalks and compiled promoted
  schema definitions; no raw research documents in worker context.
- `agent/workflows/`: promotion/correction/expiry/revocation and convergence
  monitor workflows using Eve durable execution.
- `agent/tools/`: narrow workspace tools for viewing/applying grants and
  subscriptions and for writing consumer-owned matches/findings.
- `agent/strategy-packs/`: versioned public-signal-convergence pack plus reviewed
  projection declarations in Congressional and Insider packs.
- `app/` and existing Spectrum capability routes: typed signal-sharing controls
  and health.
- `agent/evals/`, `evals/`, and `scripts/verify-*.mjs`: isolation, schema,
  resolution, lifecycle, race, alert, and live-read coverage.

Do not add a general `read_other_workspace`, `search_all_findings`, shared
conversation table, or universal model context aggregator.

## Verification matrix

| Boundary | Required proof |
| --- | --- |
| Owner isolation | Another owner cannot discover schemas in use, grants, signals, entities queried, matches, counts, or timing details. |
| Workspace isolation | Producer and consumer conversations, briefs, tools, configuration, histories, and full findings never cross. |
| Default deny | No install, upgrade, source fact, finding, or workspace creation silently creates publish/read access. |
| Schema safety | Only registered compatible fields and bounded bytes can be stored or returned; drift blocks safely. |
| Entity identity | Stable evidence resolves the positive case; ticker/name collisions, ambiguity, and effective-date conflicts cannot match. |
| Promotion | Exact finding revision projects once with verified public evidence, active grant, compatible pack/schema, and complete lineage. |
| Query | Authenticated consumer, capability, active subscription, exact types, entity/time bounds, result limits, and deterministic order are all enforced. |
| Scores | Producer bands remain namespaced; no universal numeric score or silent calibration is created. |
| Matching | Exact signal revisions, entity revision, rule/configuration version, and as-of time reproduce every match. |
| Lifecycle | Correction, supersession, expiry, retraction, revocation, schema block, and entity correction update dependent matches once. |
| Replay/concurrency | Duplicate/reordered promotion, query, matching, alerts, and simultaneous permission changes remain idempotent and race-safe. |
| Routing | Alerts label the convergence workspace and Discuss actions route explicitly without changing selection on receipt. |
| Lifecycle UX | Archive pauses owned monitors/subscriptions, restore stays paused, start-fresh preserves durable grants/findings, and deletion leaves no queryable orphan. |
| Financial safety | No path exposes portfolio, broker, order, approval, payment, or live mutation capability. |
| Regression | Specs 1–5 continue to work independently when signal-plane flags are disabled. |

## Observability and operations

- [ ] Emit low-cardinality counters for entity resolved/ambiguous/corrected,
  promotion applied/refused/superseded/retracted, subscription denied, query
  completed/truncated/denied, match created/revised/retracted, alert delivered,
  and dependent re-evaluation quarantined.
- [ ] Never use owner/workspace/entity/schema payload/signal/match/source values as
  metric labels.
- [ ] Emit bounded reason codes rather than payloads, identifiers, exception
  bodies, or model text.
- [ ] Provide owner-visible health without exposing another workspace's private
  details.
- [ ] Provide operator reports for blocked schemas, ambiguous entity backlog,
  quarantined lifecycle propagation, and active feature flags using aggregate
  counts only.
- [ ] Add independent kill switches for entity updates, promotion, query,
  matching, convergence alerts, and live-source smoke.
- [ ] Define retention and compaction for entity revisions, grants,
  subscriptions, promotions, receipts, matches, and expired projections.
- [ ] Document schema blocking, grant revocation, entity correction, dependent
  recomputation, quarantine replay, and rollback procedures.

## Rollout and rollback

- [ ] Keep the feature available only to the configured deployment owner during
  initial rollout.
- [ ] Deploy schema/entity stores dark before allowing promotion.
- [ ] Enable fixture promotion before public live-read promotion.
- [ ] Enable query before match creation, match creation before UI, and UI before
  Photon alerts.
- [ ] Require a reviewed deploy manifest containing schema digests, projection
  policy versions, entity resolver version, reference rule version, flags, and
  smoke results.
- [ ] Rollback must stop new promotions, queries, matches, and alerts while
  retaining durable source facts, workspace findings, grants/subscriptions,
  promotion receipts, and match history.
- [ ] Blocking a faulty schema version must make its active signals unavailable
  and schedule bounded dependent re-evaluation; it must not fall back to another
  version.
- [ ] Do not delete historical schema or policy versions while durable records
  reference them.

## Definition of done

This specification is complete only when:

- [ ] Every sprint exit gate passes.
- [ ] Canonical issuer/security resolution is deterministic, versioned, and
  safely ambiguous when stable evidence is absent.
- [ ] No signal is published or readable without separate explicit grants and
  subscriptions.
- [ ] Promoted records contain only reviewed public, bounded, schema-valid
  fields and cannot dereference private producer state.
- [ ] Congressional Signals and Insider Clusters each promote one authorized
  fixture signal exactly once.
- [ ] `public-signal-convergence@1.0.0` creates one reproducible issuer-level
  match/finding/alert from the positive fixture and no result from all negative
  fixtures.
- [ ] Two producer workspaces and one consumer workspace remain independently
  active with no cross-context, cross-tool, cross-config, or cross-finding
  leakage.
- [ ] Correction, expiry, retraction, revocation, schema blocking, and entity
  correction update dependent state and alerts idempotently.
- [ ] Natural language and Spectrum show and mutate the same authoritative grant,
  subscription, and convergence state.
- [ ] Archive, restore, start-fresh, deletion, alert routing, and stale actions
  follow Specs 1–2.
- [ ] No private artifact, portfolio, broker, order, approval, or live financial
  mutation path is introduced.
- [ ] All Specs 1–5, Photon, financial-safety, build, typecheck, and focused race
  regressions remain green.
- [ ] Rollback stops new sharing without deleting durable evidence or audit.
- [ ] `HANDOFF.md`, `NORTH_STAR.md`, and `BACKLOG.md` are updated with implemented
  facts and completing commits only after rollout.

## Follow-on work

Spec 6 completes the initial platform-to-strategy sequence. It does not mean the
product is finished. Future work should be proposed as focused specs only when a
real strategy or operating boundary requires it, for example:

1. Cramer Inverse source acquisition, attributable-statement extraction, stance
   policy, and pack behavior.
2. Workspace-aware proposed-order, reservation, preview, approval, and broker
   reconciliation that consumes a workspace finding without granting background
   trading authority.
3. Senate congressional-disclosure ingestion and House/Senate policy alignment.
4. Additional reviewed signal schemas and consumer-specific convergence rules.
5. General topic-change detection and held-message recovery.
6. Telegram migration after Photon behavior is stable.

None of those projects is authorized by completion of this specification.
