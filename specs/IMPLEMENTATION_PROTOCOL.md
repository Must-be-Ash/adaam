# Specification implementation protocol

Use this protocol for implementing Specs 1–6. One implementation task owns one
sprint phase, not an entire spec. Every phase is implemented, independently
reviewed, remediated if necessary, and integrated before a fresh task starts the
next sprint. The protocol exists so phase prompts can stay short and consistent
without asking one context window to implement and judge a whole specification.

## Repository and branch setup

- Maintain one local integration branch for the assigned spec. Suggested
  integration branches:
  - `codex/spec-01-independent-workspaces`
  - `codex/spec-02-strategy-packs`
  - `codex/spec-03-source-adapters`
  - `codex/spec-04-congressional-signals`
  - `codex/spec-05-insider-clusters`
  - `codex/spec-06-shared-signal-plane`
- Create a fresh dedicated worktree and phase branch for the assigned sprint
  from the latest reviewed commit on the spec integration branch. Suggested
  phase branches use `codex/spec-NN-sprint-N`. If Codex already created a fresh
  isolated worktree at the correct base, use it and do not create a nested
  worktree.
- For Sprint 0, create the spec integration branch from the latest merged
  dependency base, then create the Sprint 0 phase branch from it. For each later
  sprint, start only after the previous sprint has passed independent review and
  has been merged into the integration branch.
- Start from the latest agreed base containing every completed dependency spec.
  Specs are sequential: Spec 2 starts after Spec 1 is merged, Spec 3 after Spec
  2, and so on.
- Before editing, inspect `git status`, the current branch, recent commits, and
  `git worktree list`. Preserve all unrelated or pre-existing changes. Never
  stash, discard, reset, overwrite, or commit another person's changes.
- If the assigned spec or a completed dependency is missing from the base,
  stop and report the exact branch/commit dependency instead of recreating it.
- Local atomic commits, reviewed phase-to-integration merges, and the final safe
  integration-to-`main` merge are authorized by this protocol. An implementation
  task must stop at its phase handoff; it does not review or merge its own phase.
  Do not push, rebase published work, open a pull request, deploy, or otherwise
  alter remote/production state unless the user separately asks.

## Required orientation

Before implementation:

1. Read the repository `AGENTS.md` completely and follow it.
2. Read `HANDOFF.md` completely. Follow its links to the files relevant to the
   assigned spec; do not treat the handoff as a substitute for inspecting code.
3. Read `NORTH_STAR.md` completely enough to understand the product boundary
   and the strategy examples affected by the spec.
4. Read the assigned spec completely, including dependencies, exclusions,
   invariants, sprint exit gates, rollout, and definition of done. Implement
   only the sprint named in the task prompt.
5. Read every preceding spec on which the assigned spec depends. Verify its
   required implementation exists in the current branch; do not build a
   parallel replacement for a dependency-owned subsystem.
6. Read only the relevant research files under `idea/` and relevant backlog
   entries explicitly named by the assigned spec.
7. Inspect the current code, tests, schemas, scripts, package commands, and
   recent Git history that implement the affected area.
8. Before writing Eve integration code, locate and read the relevant installed
   Eve package documentation. Search the Eve registry before implementing an
   integration from scratch, as required by `AGENTS.md`.
9. Before writing Next.js code, locate and read the relevant installed Next.js
   documentation required by `AGENTS.md`; do not rely on remembered APIs.
10. Write a concise implementation plan containing only the assigned sprint,
    its exit gate, and its phase handoff. Keep exactly one checklist task in
    progress at a time.

Do not spend the first implementation turn rewriting the spec. If code and the
spec disagree, gather evidence, explain the mismatch, and make the smallest
safe correction only when it is necessary to implement the agreed product.

## One-task-at-a-time loop

Work from the first incomplete checklist item in the assigned sprint.
For every item:

1. Quote or identify the exact checklist item being attempted.
2. Inspect the existing implementation and tests before editing. If it may
   already be complete, verify it rather than reimplementing it.
3. Read any framework or provider documentation specifically needed for that
   item.
4. Implement only that item and the smallest inseparable support it requires.
   Do not opportunistically implement later sprint work.
5. Add or update the narrowest deterministic test that proves the behavior.
6. Run that focused test. Also run the narrowest relevant static check, schema
   validation, lint, typecheck, build, or fixture validation needed to catch
   errors the focused test cannot catch.
7. Review the diff for scope, security boundaries, private-data leakage,
   generated files, and unrelated changes.
8. Mark the spec checkbox `[x]` only after the implementation exists and the
   verification passes. Commit the code, test, and checkbox update together.
9. Record the verification in the commit message/body or the spec's progress
   log described below.
10. Move to the next checklist item in the assigned sprint without waiting for
    approval unless a real blocker, destructive action, external credential,
    paid service, production mutation, or material product choice requires the
    user. Stop after the assigned sprint exit gate and phase handoff; never begin
    the next sprint in the same task.

“One task” normally means one checklist item. A small group may be implemented
together only when the items are technically inseparable and share one testable
outcome. State that grouping before editing; do not use it to absorb a whole
sprint into one change.

## What counts as verified

- Prefer deterministic unit, integration, contract, fixture, and race tests.
- A parser task needs representative success, malformed, missing-field,
  duplicate, and bounded-input fixtures as applicable.
- An authorization or isolation task needs both allowed and denied cases,
  including forged identity input where applicable.
- An idempotency task needs replay and concurrent/race coverage, not only a
  single successful call.
- A UI task needs state/route tests and, when practical, a real rendered or
  browser smoke for the changed interaction.
- A migration needs forward, retry, partial-failure, and rollback proof.
- An operational runbook or schema-only task may use lint, schema validation,
  fixture execution, link checking, or a rehearsed dry run when a code test is
  not meaningful.
- A live-source acceptance item is complete only after the bounded live smoke
  described by the spec actually runs. A fixture cannot be relabeled as a live
  smoke.
- An integration or sprint-exit claim needs a test through the real production
  caller or entry point. A fixture runtime, prompt inspection, source-text
  assertion, isolated store test, or build may supplement that proof but cannot
  replace it.
- For each durable-write-plus-side-effect sequence, test the crash boundaries
  before and after the side effect. A retry must complete safely or reach an
  explicit recoverable/quarantined state; silently returning from an
  intermediate record is a failure.
- Do not mark an item complete because code compiles, because a mock returns the
  expected value, or because the intended behavior is documented.
- If an existing test is too broad or flaky to prove the item, add a focused
  deterministic test before checking it off.

After each meaningful change, run the focused verification. At the assigned
sprint exit gate, run all focused tests accumulated for that sprint plus the
relevant regression suite, then stop for independent review. At final spec
completion, a separate integration/release task runs every command required by
the spec and repository for type safety, tests, build, migrations,
security/isolation, and fixture/live-smoke acceptance.

## Checklist and progress rules

- The assigned spec is the authoritative implementation checklist.
- Never bulk-change unchecked boxes to checked.
- Never check an invariant, acceptance criterion, exit gate, rollout item, or
  definition-of-done item before the repository and verification evidence make
  it true.
- For an “agreed decision” checkbox, mark it complete only when the implemented
  contracts/configuration enforce the decision, or when the item is a pure
  design freeze explicitly completed by the current contract sprint.
- If an item was already implemented, cite the exact code and passing test, then
  mark it complete in a documentation-only atomic commit.
- If an item is obsolete, contradictory, unsafe, or impossible, leave it
  unchecked. Add a concise note to the progress log and ask the user for the
  smallest decision needed. Do not silently reinterpret the requirement.
- Do not mark a sprint exit gate until every prerequisite behavior for that gate
  passes, even if later independent checklist items remain.
- A sprint implementation task may update only its sprint items, its exit gate,
  and its progress rows. Only the final integration/release task may check
  cross-sprint acceptance criteria, rollout completion, or definition-of-done
  items.
- Update `HANDOFF.md`, `NORTH_STAR.md`, and `BACKLOG.md` only where the spec asks
  and only with durable implemented facts. Do not describe planned work as
  shipped.

Maintain a concise `## Implementation progress` section at the end of the
assigned spec. Add one row per completed atomic task or inseparable group:

| Date | Checklist item | Verification |
| --- | --- | --- |
| YYYY-MM-DD | Short exact item description | `focused command` — passed |

Keep verification entries short. Do not paste logs, secrets, payloads, owner
identifiers, or private content into the spec. The atomic commit containing the
row is the commit record; do not create self-referential placeholder SHAs or
rewrite history merely to put a commit hash inside the document.

## Commit policy

- Make small, reviewable commits at verified boundaries, normally one checklist
  item or one declared inseparable group per commit.
- Include the related test and spec checkbox in the same commit as the behavior.
- Use messages such as:
  - `spec-01: persist immutable ingress receipts`
  - `spec-03: reject oversized source responses`
  - `spec-05: classify Form 4 purchase eligibility`
- Do not commit failing tests, debug output, credentials, local `.env` files,
  downloaded source documents, private artifacts, or unrelated formatting.
- Generated files should be committed only when repository policy requires them
  and the generating command is deterministic.
- At the assigned sprint boundary, provide a concise checkpoint containing the
  phase base and head commits, completed checklist items, verification
  commands/results, remaining work, and risks. Stop and wait for independent
  review even when unblocked.

## Scope, safety, and blockers

- Preserve the ownership, workspace-isolation, default-deny capability,
  idempotency, budget, alert-routing, and no-background-trading invariants in the
  specs and handoff.
- Do not add Telegram work, private artifact infrastructure, live trading,
  broker mutation, unrelated strategies, or later-spec systems early.
- Fixture and development paths must not call paid providers or mutate external
  production state.
- Use official or reviewed public sources required by the spec. Do not add an
  unreviewed third-party source merely to make a test pass.
- A blocked external live smoke does not justify checking the item off. Complete
  all safe local work, record the exact blocker and evidence, and ask for the
  credential/authority or environmental change needed.
- Ask before destructive migrations, irreversible data changes, paid calls,
  production deployment, any push or pull-request operation, any merge other
  than a reviewed phase-to-integration merge or the final local
  integration-to-`main` merge, or any meaningful expansion beyond the assigned
  spec.

## Independent phase review and integration

The implementation task must not review or approve its own sprint. After it
stops at the phase boundary:

1. Start a fresh read-only review task from the phase head. The reviewer reads
   the spec and complete phase diff, runs focused tests, and checks production
   wiring, failure semantics, privacy/security boundaries, and checkbox truth.
2. The reviewer returns findings only. It does not edit, check boxes, commit,
   merge, push, deploy, or contact the implementation task.
3. A coordinating agent verifies each material finding against current code.
   Unproven or incorrect findings are discarded with evidence.
4. Send the verified findings to a bounded remediation task on the same phase
   branch. Each fix receives a focused regression test and atomic commit.
5. Re-run an independent review of the changed areas and the sprint exit gate.
6. Only after the review is clean, merge the phase branch into the spec
   integration branch with a normal local merge and verify the merge result.
7. Start the next sprint in a fresh task and worktree from that reviewed
   integration commit.

Review findings must cite tight file/line ranges, a reproducible failure
scenario, the violated requirement, and the smallest acceptance test that would
prove remediation. Treat generated volume, naming, or style as findings only
when they create a concrete correctness, security, operational, or
maintainability risk.

## Final review and local merge

Whole-spec review and merge are a separate final integration/release task for
every spec. Do not begin this task until
all applicable implementation checklist items, sprint exit gates, verification
matrix boundaries, rollout requirements, and definition-of-done items are
checked with evidence.

1. Review the complete branch diff from its merge base, not only the last
   commit. Check scope, correctness, architecture ownership, migrations,
   security/privacy boundaries, error handling, test quality, generated files,
   and spec/progress accuracy.
2. Run the complete final verification required by the assigned spec and the
   repository. Resolve every failure; do not merge a red branch.
3. Confirm the target `main` worktree and index contain no uncommitted changes.
   Never stash, discard, overwrite, or include someone else's work to make the
   merge possible.
4. If `main` advanced after the integration branch was created, integrate the
   latest local `main` into the integration branch with a normal merge, resolve
   conflicts deliberately, and rerun final verification. Do not rewrite
   published history.
5. Merge the reviewed integration branch into local `main` without squashing
   away its atomic task commits. Use an explicit merge commit when practical so
   the spec boundary remains visible.
6. Verify the post-merge commit graph and working tree, then rerun the narrowest
   critical smoke that proves the merge did not change behavior.
7. Do not push `main` or the integration branch unless the user separately
   authorizes remote changes.

If `main` is dirty, checked out somewhere inaccessible, has an unresolved
conflict, or cannot accept the branch safely, do not pretend the merge occurred.
Report the exact blocker and leave the fully reviewed branch ready to merge.

## Final handoff

A sprint-phase assignment ends after its exit gate is locally verified and its
phase handoff is reported. It is not authorized to begin the next sprint, merge
itself, or claim the whole specification complete. The phase becomes accepted
only after the independent review and integration sequence above.

The assignment is complete only when every applicable checklist item, sprint
exit gate, verification-matrix boundary, rollout requirement, and definition of
done is checked with evidence and the final review/local merge has succeeded, or
when the user explicitly narrows the scope.

At completion, report:

- the implemented outcome in product language;
- the branch and ordered commits;
- the specs/sprints/checklist items completed;
- exact tests, checks, builds, migrations, and live smokes run and their results;
- any unchecked item and why;
- rollout/rollback state and whether any production action remains; and
- the local `main` merge commit and the next spec's exact required base commit.

Do not claim the spec is complete while any required item remains unchecked.
