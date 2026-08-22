# Spec 7: Strategy Platform Boundary and Durable Continuity

Status: Ready for implementation

Date: 2026-08-20

Product target: `NORTH_STAR.md`

Dependencies:

- `specs/01-independent-workspace-runtimes.md`
- `specs/02-versioned-strategy-packs.md`
- `specs/03-public-source-adapters.md`
- The accepted strategy implementations through Spec 4C

This specification does not depend on Spec 5 or Spec 6 and must not implement
either of them.

## Plain-language objective

Complete two small gaps in the platform that already exists:

1. Finish the separation between shared platform plumbing and declarative
   strategy applications. Strategies must retain their unique behavior without
   making generic workspace, scheduling, worker, or manager code branch on a
   named strategy.
2. Make explicit workspace instructions and operational state survive `Start
   fresh`. `Start fresh` clears only that workspace's old chat history and
   temporary model context. It does not erase what the strategy is supposed to
   do or any durable state that supports that work.

This is a bounded completion of existing architecture. It is not a new plug-in
framework, marketplace, connector project, memory platform, or financial
redesign.

## Why this work exists

The repository already has the desired overall architecture:

- Shared source and connection plumbing fetches, normalizes, validates, and
  records reusable evidence.
- Versioned strategy packs declare how a specialized strategy uses that
  plumbing.
- Each installed pack runs in its own durable, isolated workspace with its own
  configuration, monitors, findings, alerts, budget, and chat generation.

The remaining gaps are narrower:

- Some shared implementation paths still ask whether a pack is a particular
  named strategy before deciding presentation, scheduling, activation,
  backfill, recovery, or configuration behavior.
- Durable workspace records survive `Start fresh`, but the replacement
  interactive generation is not automatically given the bounded structured
  state it needs to continue the workspace's task.
- Clear conversational instructions that change a goal, thesis, watchlist, or
  monitoring task do not have one explicit, reliable same-turn persistence
  contract.

## Scope guardrails

Every implementation decision must satisfy all of these rules:

1. Make the smallest change that closes the two gaps above.
2. Reuse the existing pack catalog, source adapters, capability manifests,
   workspace stores, monitors, findings, alerts, and worker isolation.
3. Do not create parallel registries or storage systems when an existing one can
   carry the required information.
4. Do not add a general extension DSL, dependency injection framework, remote
   loader, marketplace, or arbitrary code execution mechanism.
5. Do not broaden the work because an adjacent improvement appears useful.
6. Do not add speculative hardening or solve hypothetical edge cases that are
   not required by the ordinary accepted flows in this specification.
7. Preserve every existing isolation, authorization, capability, budget, and
   exact pack-version/digest invariant.
8. Stop when the acceptance examples in this specification pass.

## Explicitly out of scope

The implementation agent must not add or redesign any of the following:

- A remote strategy registry, marketplace, upload flow, signing service, or PR
  submission workflow
- Runtime execution of arbitrary JavaScript, TypeScript, shell, templates, or
  remote code supplied by a strategy pack
- A new source connector, X/Twitter connection, RSS reader, YouTube transcript
  integration, provider integration, or general connector framework
- Cross-workspace signals, convergence, shared strategy memory, or reuse of one
  workspace's conclusions by another workspace
- Owner-private artifacts or paid-result retention
- Coinbase architecture, paper trading, broker abstraction, trading approvals,
  order reservations, or any other financial change
- Fresh-fork onboarding, deployment defaults, web access, Telegram, or another
  channel
- Automatic transcript summarization or restoration of old chat history
- Multiple packs in one workspace, pack merging, remote pack installation, or a
  graphical strategy editor
- New investment strategies except a bounded test-only fixture if it is the
  smallest way to prove the generic contract
- Production deployment, live provider calls, paid calls, or live financial
  actions
- Broad cleanup of unrelated code

If implementation uncovers a real adjacent issue, record it only if it is
genuinely worth revisiting. Do not fix it under this specification. Add it to
`BACKLOG.md` at the end only when deferring it is an intentional product
decision, not merely because it was noticed.

## Terminology

### Shared plumbing

Reviewed application code that can be reused by more than one strategy:

- Provider connections and authentication
- Source acquisition and fetching
- Normalization, provenance, canonical facts, and corrections
- Registered research tools and capabilities
- Reusable extraction or semantic interpretation pipelines
- Generic workspace lifecycle, schedules, budgets, findings, alerts, and
  presentation dispatch

Shared plumbing may know stable adapter, capability, schema, evidence-contract,
and presentation IDs. Generic plumbing must not need to know the ID of a
strategy pack in order to operate it.

### Strategy application

A reviewed, declarative, versioned strategy pack installed into one workspace.
The strategy application owns:

- Its thesis and workspace instructions
- Its configurable identities, entities, accounts, symbols, topics, watchlists,
  and monitoring objective
- The stable shared source and capability IDs it requires
- Its monitor templates and schedule configuration
- Its strategy-specific deterministic rules and policy assets
- Its semantic interpretation instructions and abstention rules
- Its finding schema and presentation contract references
- Its evidence requirements, evaluations, and expected behavior
- Pack defaults that may tighten shared limits but cannot grant authority or
  loosen shared limits

The strategy application does not own credentials, provider clients, source
fetching, generic workspace lifecycle, or arbitrary executable runtime code.

### Registered capability

A reviewed shared implementation primitive referenced by a stable ID. A new
strategy that reuses an existing capability must not require that capability's
registry or implementation to be edited.

A future strategy that genuinely requires a new reusable parser, evaluator, or
source primitive may add one reviewed registered capability in separate shared
plumbing and reference its stable ID. That future contribution is allowed to
contain application code, but it must be capability-oriented and reusable. It
must not add a named-strategy conditional to generic scheduling, lifecycle,
manager, or dispatch code.

This specification does not implement such a new capability. It only makes the
existing boundary consistent.

## Required strategy-platform behavior

### Pack-driven behavior

The effective runtime behavior of a strategy workspace must be derived from:

- The exact installed pack ID, version, and content digest
- Its validated configuration
- Its declared sources, capabilities, skills, monitor templates, finding schema,
  evidence contracts, and presentation contracts
- The workspace's authorized capability manifest, budget, and monitor state

The pack ID remains valid provenance and catalog identity. The restriction is
not "never read a pack ID." The restriction is:

> Generic shared implementation must not branch on a named pack ID to select
> behavior that can be declared through the pack or dispatched through a stable
> registered contract.

### Strategy-specific behavior must remain possible

This work must not flatten strategies into one generic prompt or one generic
scoring policy.

For example, two strategies may use the same shared public-commentary plumbing
while differing in all of the following:

- The public identity being monitored
- The entities and topics considered relevant
- The materiality and confidence thresholds
- The affected assets
- The interpretation of positive, negative, escalation, or de-escalation
  language
- The resulting long, short, no-view, or abstention research conclusion
- The evidence and counterevidence required before producing a finding
- Their schedules, alert policies, instructions, and evaluation suites

Those differences belong in validated pack configuration, instructions, policy
assets, schemas, and evaluations. They must not be rewritten as conditionals in
the shared scheduler, workspace manager, or worker runner.

### Stable contract dispatch

Where the current shared implementation contains strategy-ID branches, replace
them only with the smallest applicable existing or minimally extended contract:

- Configuration-field behavior must follow the field kind or declared policy,
  not the identity of the pack containing it.
- Schedule and initial-run behavior must follow validated monitor declarations,
  not a named strategy.
- Activation, watermark, backfill, and retry behavior must follow a monitor,
  source, or capability contract.
- Semantic evaluation must dispatch through a registered capability or evidence
  contract.
- Finding and alert rendering must dispatch through a presentation contract and
  provide a bounded generic fallback.
- Strategy-specific evaluation code may validate its own expected capability or
  contract. Generic workspace code must not validate by enumerating pack names.

Add only the minimum metadata required to express behavior already used by the
current accepted strategies. Do not design metadata for imagined future
strategies.

### Allowed registry edits

The following distinction is mandatory:

- Adding a new strategy that uses existing shared plumbing may add pack files,
  validated assets, and pack evaluations. It must not edit the shared capability
  implementation or add its pack ID to generic core code.
- Adding genuinely new shared plumbing may add one source adapter, tool,
  evaluator, schema, or presentation registration. That is a plumbing change,
  not a strategy exception.

The spec is successful when this distinction is enforced by validation rather
than left as documentation only.

## Required durable-continuity behavior

### Meaning of Start Fresh

`Start fresh` must do exactly this:

1. Retire or reset the selected workspace's old interactive chat continuation.
2. Advance that workspace's session generation.
3. Start the replacement generation without the old transcript or temporary
   reasoning context.
4. Preserve and rehydrate the selected workspace's authorized durable state.

It must not reset, delete, recreate, or silently alter:

- The installed strategy pack, exact version, or digest
- Strategy configuration
- The workspace goal, thesis, watchlist, or open questions
- Monitoring instructions or selected sources
- Enabled or paused monitor state
- Schedules, occurrence checkpoints, or source cursors
- Findings, finding summaries, or alert state
- Capability manifests or budgets
- Pack-managed resource provenance

### Explicit same-turn persistence

When the owner gives a clear instruction that changes the workspace's ongoing
task, Eve must persist the change to that workspace during the same turn before
claiming it will remember or act on it.

Examples include:

- "Add NVDA to this strategy's watchlist."
- "Stop monitoring this source."
- "Monitor this supported source every hour."
- "Change this workspace's thesis to focus on margin deterioration."
- "Keep this question open until the next earnings call."

The persistence path must:

- Use trusted owner and active-workspace scope, not model-supplied scope
- Validate the requested mutation against the installed pack and current
  workspace capabilities
- Update only the durable record that owns the behavior
- Return a bounded confirmation of what changed
- Fail visibly rather than claiming persistence when the change was rejected
- Never write another workspace's state

Ordinary discussion, brainstorming, speculative questions, quoted text, and
source content must not be silently promoted into durable memory. This spec does
not add transcript summarization.

If a requested change is not supported by the installed pack or available
plumbing, Eve must explain that it was not persisted. It must not invent a
monitor, source, capability, or durable task.

### Bounded rehydration

Every new interactive generation for a strategy workspace must receive a
bounded, structured, workspace-authorized continuity projection containing only
the state needed to resume work:

- Workspace identity and generation
- Installed strategy identity and current configuration summary
- Current goal and thesis
- Watchlist and open questions
- Current findings summary and bounded references to recent findings
- Enabled and paused monitor summary, including supported source and schedule
  information needed for discussion
- Last material change relevant to the workspace's task

Large findings, raw source content, and old chat messages remain outside the
projection and are retrieved through existing authorized tools only when needed.

The projection must be composed from durable records after the trusted
workspace assignment is resolved. It must not accept an owner ID, workspace ID,
or generation supplied by the model.

### Isolation remains absolute

Continuity must not weaken the existing isolation boundary:

- A workspace receives only its own brief, strategy configuration, monitors,
  findings, and alerts.
- A workspace never receives another workspace's transcript, summary, task,
  pack instructions, configuration, watchlist, findings, or alerts.
- `Start fresh` for one workspace cannot change another workspace's generation
  or durable state.
- Interactive rehydration cannot give scheduled workers access to interactive
  history.
- Scheduled workers continue to receive only their scoped typed state and
  allowed capabilities.
- Owner-global connector configuration does not become strategy memory and is
  not copied into the rehydration projection.

## Acceptance examples

### Example A: shared plumbing, different strategies

Given two strategy packs use the same registered public-commentary capability,
when each pack declares a different identity, objective, topics, impact
hypotheses, assets, and evaluation behavior, then each workspace produces its
own configured behavior without a new strategy-ID branch in shared scheduling,
worker, service, monitor, or manager code.

### Example B: new strategy using existing plumbing

Given a bounded test-only strategy fixture references only existing registered
sources, capabilities, schemas, and presentations, when the catalog is
generated and the fixture is installed, then it validates, composes, schedules,
and runs without changing shared capability implementation or adding its pack ID
to generic core code.

The fixture is not a new production investment strategy and must be removed or
kept strictly test-only after it proves the contract.

### Example C: explicit instruction survives Start Fresh

Given the owner tells Workspace A to add a symbol to its watchlist and enable a
supported monitor, when Eve confirms both changes and the owner selects `Start
fresh`, then the new generation knows the updated watchlist and enabled monitor.
The old chat transcript is absent.

### Example D: unsupported instruction is not fabricated

Given the owner asks a strategy to monitor a source that is not declared or
available, when the request is processed, then Eve reports that the source was
not added. No durable monitor or false memory is created.

### Example E: no cross-workspace pollution

Given Workspace A and Workspace B contain distinct canary goals, watchlists,
open questions, findings, and monitor configurations, when Workspace A starts
fresh, then its continuity projection contains every expected A canary and none
of the B canaries. Workspace B's generation and durable records remain
unchanged.

### Example F: background operation continues

Given a strategy monitor is enabled before `Start fresh`, when the interactive
generation is replaced, then the monitor remains enabled, retains its checkpoint
and schedule, and its next bounded run uses the correct workspace state without
receiving old chat history.

## Implementation workflow

### One-worktree rule

The implementation must use exactly one non-main worktree for the entire spec.

- Create one `codex/` branch and one linked worktree before Sprint 1.
- Use that same worktree for every sprint and every fix through final regression.
- Do not create a new worktree per sprint.
- Do not implement directly on `main`.
- Keep `main` unchanged until the entire specification is complete and the final
  gate passes.
- Do not merge partial sprint work to `main`.

### Progress rule

Each step below begins unchecked. The implementation agent must:

1. Work on only the current sprint.
2. Complete steps in listed order unless a step explicitly says otherwise.
3. Mark a step `[x]` only after its code and targeted verification pass.
4. Record the exact verification command and bounded result under that sprint's
   receipt section.
5. Do not begin the next sprint while the current sprint has an unchecked step
   or failing verification.
6. Do not mark a sprint complete based only on typechecking.

No sprint authorizes production deployment, paid calls, live provider mutation,
or live financial activity.

## Sprint Group A: Finish the strategy-platform boundary

This group must complete before Sprint Group B begins.

### Sprint 1: Inventory and freeze the boundary

Goal: establish the exact current exceptions and the smallest contracts needed
to express behavior already in use.

- [ ] Create the single spec worktree and record its absolute path, branch, base
      commit, and clean starting status.
- [ ] Inventory direct named-strategy conditionals in generic workspace,
      scheduling, monitor, service, worker-runner, and manager/presentation code.
- [ ] Classify each conditional as configuration-field behavior, monitor policy,
      source/capability dispatch, presentation dispatch, or genuinely
      strategy-owned evaluation behavior.
- [ ] Identify the existing stable contract that can replace each conditional.
- [ ] Where no existing declaration can express current accepted behavior,
      specify only the minimum additional generic metadata needed by that current
      behavior.
- [ ] Add a contract test that distinguishes a strategy-only contribution from a
      new shared-plumbing contribution.
- [ ] Verify that the proposed boundary preserves exact version/digest binding,
      capability intersection, source contracts, budgets, monitor provenance,
      and worker hard denials.
- [ ] Run the existing pack catalog and runtime isolation verification.
- [ ] Record the Sprint 1 receipt and mark the sprint complete.

Sprint 1 receipt:

- Worktree:
- Branch:
- Base commit:
- Commands:
- Result:
- Remaining unchecked steps: 0 required before Sprint 2

### Sprint 2: Remove named-strategy behavior from generic paths

Goal: make current accepted strategies operate through declarations and stable
contracts instead of pack-name branches.

- [ ] Replace configuration validation branches with generic field-kind or
      declared-policy behavior where applicable.
- [ ] Replace initial scheduling, activation, watermark, backfill, and retry
      pack-name branches with the minimum monitor/source/capability declarations
      established in Sprint 1.
- [ ] Replace manager and alert pack-name branches with presentation-contract
      dispatch plus the existing or a bounded generic fallback.
- [ ] Ensure registered evaluators dispatch by capability or evidence contract,
      not by enumerating strategy pack IDs in generic code.
- [ ] Keep strategy-specific instructions, thresholds, hypotheses, abstention
      rules, and evaluations in their owning pack assets.
- [ ] Confirm that a strategy reusing an existing capability does not require an
      edit to the capability's implementation or registry.
- [ ] Do not refactor strategy-owned evaluators merely to make files look
      uniform.
- [ ] Run targeted tests for every generic path changed in this sprint.
- [ ] Run all existing Congressional, earnings, inverse-Cramer, public-commentary,
      IPO, strategy-owner-surface, and workspace-runtime verifications affected
      by the changes.
- [ ] Record the Sprint 2 receipt and mark the sprint complete.

Sprint 2 receipt:

- Changed contract surfaces:
- Commands:
- Result:
- Existing pack behavior preserved:
- Remaining unchecked steps: 0 required before Sprint 3

### Sprint 3: Prove strategy composition without core exceptions

Goal: prove the boundary with existing plumbing rather than adding a new product
feature.

- [ ] Add the smallest test-only strategy fixture that reuses an existing source,
      capability, schema, and presentation contract with meaningfully different
      strategy configuration and instructions.
- [ ] Prove catalog generation, exact binding, installation, runtime composition,
      monitor creation, worker capability exposure, finding validation, and
      presentation without adding the fixture's pack ID to generic code.
- [ ] Add a focused architecture regression that fails if the known production
      strategy IDs are reintroduced into the generic paths cleaned by Sprint 2.
      Scope this check to those paths; do not create a repository-wide string
      ban.
- [ ] Prove that adding new shared plumbing still has an explicit reviewed
      registration path and is not confused with adding a strategy.
- [ ] Remove the fixture from production catalog output or keep it under an
      unmistakably test-only path.
- [ ] Run the full strategy-pack, strategy-runtime, source-contract, worker
      isolation, manager, and alert regression set.
- [ ] Record the Sprint 3 receipt and mark Sprint Group A complete.

Sprint 3 receipt:

- Proof fixture:
- Generic paths checked:
- Commands:
- Result:
- Group A complete: yes/no
- Remaining unchecked steps: 0 required before Sprint Group B

## Sprint Group B: Durable isolated continuity

Do not begin this group until Sprint Group A is complete and green.

### Sprint 4: Persist explicit workspace intent

Goal: give clear conversational instructions one workspace-scoped durable write
path without summarizing the conversation.

- [ ] Define the bounded set of existing durable fields and control actions that
      explicit conversational intent may update: goal, thesis, watchlist, open
      questions, supported monitor configuration, and enabled/paused monitor
      state.
- [ ] Reuse existing strategy and monitor mutation paths wherever they already
      own the requested behavior.
- [ ] Add only the minimum workspace-scoped control needed for brief fields that
      currently lack an authorized mutation path.
- [ ] Require trusted owner and active-workspace scope for every mutation.
- [ ] Validate mutations against the current pack binding, capabilities, source
      declarations, and current revisions.
- [ ] Make Eve persist a clear instruction before confirming that it will
      remember or perform it.
- [ ] Make rejected or unsupported changes visible and leave durable state
      unchanged.
- [ ] Add tests proving quoted source text, speculative discussion, and another
      workspace's content cannot trigger a durable mutation.
- [ ] Add tests proving two workspaces can update identically named fields
      without reading or overwriting each other.
- [ ] Run targeted authorization, revision, pack-runtime, monitor, and workspace
      isolation tests.
- [ ] Record the Sprint 4 receipt and mark the sprint complete.

Sprint 4 receipt:

- Durable fields/actions supported:
- Commands:
- Result:
- Cross-workspace mutation test:
- Remaining unchecked steps: 0 required before Sprint 5

### Sprint 5: Rehydrate a fresh generation

Goal: make the replacement interactive generation resume from bounded durable
state without restoring chat history.

- [ ] Define one bounded continuity projection from existing authorized
      workspace records.
- [ ] Include only the fields required by the Bounded rehydration section of this
      specification.
- [ ] Compose the projection after trusted workspace assignment and before the
      first model turn of the new generation.
- [ ] Preserve static installed-pack instructions and keep the continuity
      projection distinct from untrusted source content.
- [ ] Do not include raw transcripts, temporary reasoning, full raw findings,
      connector credentials, or another workspace's records.
- [ ] Keep `Start fresh` generation rollover and old-continuation reset behavior
      otherwise unchanged.
- [ ] Prove pack binding, brief, monitors, schedules, checkpoints, findings,
      alerts, capabilities, and budgets remain durable across rollover.
- [ ] Prove the old chat continuation is not reattached to the new generation.
- [ ] Prove scheduled workers still receive no interactive transcript.
- [ ] Run targeted Start Fresh, context-composition, instruction-composition,
      monitor-continuity, and worker-isolation tests.
- [ ] Record the Sprint 5 receipt and mark the sprint complete.

Sprint 5 receipt:

- Continuity projection fields:
- Commands:
- Result:
- Old transcript absent:
- Remaining unchecked steps: 0 required before Sprint 6

### Sprint 6: End-to-end isolation and final regression

Goal: prove the complete ordinary path and finish without leaving partial work or
temporary state.

- [ ] Create two isolated test workspaces with different strategy bindings or
      configurations and distinct canary goals, theses, watchlists, questions,
      findings, monitors, and alerts.
- [ ] In Workspace A, issue a clear conversational watchlist change and supported
      monitor change; verify both are durable before the reply claims success.
- [ ] Start fresh in Workspace A and verify the new generation receives the
      expected A continuity projection without the old A transcript.
- [ ] Verify no Workspace B canary appears in Workspace A's projection, prompt,
      tools, findings, alerts, or response context.
- [ ] Verify Workspace B's generation and durable state did not change.
- [ ] Verify Workspace A's enabled monitor retained its schedule and checkpoint
      and can complete its next bounded run without interactive history.
- [ ] Run the test-only strategy-composition proof from Sprint 3 in the same final
      test run.
- [ ] Run `npm run typecheck`.
- [ ] Run every existing focused verification affected by strategy catalogs,
      pack runtime, workspace contracts, workspace isolation, Start Fresh,
      public sources, Congressional Signals, earnings, public commentary,
      strategy owner surfaces, manager presentation, findings, and alerts.
- [ ] Run `npm run build`.
- [ ] Inspect the full branch diff for unrelated refactors, speculative hardening,
      temporary fixtures in production catalogs, secrets, credentials, or test
      state. Remove any such material.
- [ ] Confirm no production deployment, paid call, provider mutation, or
      financial action occurred.
- [ ] Record exact final commands and results below.
- [ ] Mark Sprint Group B and the implementation complete only when every command
      is green.

Sprint 6 final receipt:

- Worktree:
- Branch:
- Final commit:
- End-to-end command:
- Regression commands:
- Build result:
- Isolation result:
- Strategy composition result:
- Temporary state removed:
- Group B complete: yes/no
- Entire specification complete: yes/no

## Merge and documentation sequence

Do not merge until every sprint step is checked and Sprint 6 is green.

After the entire implementation passes:

1. Review the complete one-worktree branch diff against this specification.
2. Confirm that no out-of-scope work was added.
3. Merge the completed branch to `main` once, following the repository's normal
   merge workflow.
4. Verify the merge result on `main` with the final focused regression commands.
5. Update `HANDOFF.md` with the durable facts that are now true:
   - Strategy applications use shared contracts without named-strategy behavior
     in the generic paths covered by this spec.
   - Explicit conversational workspace changes persist during the same turn.
   - `Start fresh` clears chat history while the new generation rehydrates only
     bounded state from that workspace.
   - The exact verification receipts and remaining deliberate limitations.
6. Update `BACKLOG.md` only for genuine intentional deferrals discovered during
   implementation. Do not copy the Explicitly out of scope list into the backlog
   unless the owner separately decides an item should be planned later.
7. Remove the implementation worktree after the merged state and documentation
   are verified.

No production deployment is part of this sequence. Deployment requires separate
owner authorization.

## Definition of done

This specification is complete only when all of the following are true:

- Every sprint checkbox is checked with a recorded verification receipt.
- Existing strategies retain their strategy-specific behavior and pass their
  existing evaluations.
- A strategy using existing plumbing can be added and run without adding its
  strategy ID to the generic shared paths covered by this spec.
- Generic code dispatches through validated pack declarations and stable
  contracts rather than named-strategy conditionals.
- Clear conversational changes to durable workspace intent persist before Eve
  confirms them.
- `Start fresh` removes old chat history but preserves and rehydrates the
  workspace's current task and operational state.
- Two-workspace canary tests prove there is no context or state pollution.
- Scheduled workers remain isolated from interactive chat history.
- Typecheck, affected focused regressions, the end-to-end continuity test, and
  the production build pass in the single spec worktree.
- The branch contains no new connector, financial work, cross-workspace sharing,
  private artifact system, marketplace, arbitrary pack code execution, broad
  hardening, or unrelated refactor.
- The completed branch is merged once, `main` remains green, and `HANDOFF.md` is
  updated with verified facts.

