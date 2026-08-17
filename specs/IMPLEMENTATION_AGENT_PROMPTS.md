# Copy-ready phased implementation prompts

Do not delegate an entire specification to one implementation task. Use one
implementation task per bounded plan unit or spec sprint, one independent
review task per phase, and a bounded remediation task only when the review
produces verified findings.

The sequence is:

1. implement one bounded unit or sprint on a fresh phase branch and stop;
2. independently review that phase without editing it;
3. have the coordinating agent verify the findings;
4. remediate only verified findings and re-review;
5. merge a reviewed current-plan unit into local `main`, or a later spec sprint
   into its spec integration branch;
6. start the next unit or sprint in a fresh task and worktree; and
7. after all sprints are reviewed and integrated, run a separate whole-spec
   integration/release review before merging into local `main`.

`specs/IMPLEMENTATION_PROTOCOL.md` is authoritative. These prompts intentionally
repeat only the scope and evidence rules that a task must keep in immediate
context.

An assigned spec's explicit workflow can override the legacy per-sprint review
loop. Specs 4A and 4B do so: keep one implementation context, commit and report
each sprint, continue only with owner direction, run one final independent
review, then complete the spec's push/PR/merge landing pass without rerunning an
already-green broad suite when landing changed no code.

## Current implementation target

Spec 1's polling-first application is implemented, independently reviewed,
merged, and pushed to `main`. Work Packages 1 and 2 of U1 coexist on the U1
branch, are complete, and have received their combined review. Use the bounded
prompt in
[`docs/prompts/spec-01-sprint-implementation.md`](../docs/prompts/spec-01-sprint-implementation.md)
for the completed work-package record. The executable sequence is
[`docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md`](../docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md).
The final combined local regression gate has passed, U1 is integrated into
`main`, and owner-authorized production acceptance completed successfully on
2026-08-15. Spec 1 is complete. The next implementation target is U2 only when
the owner authorizes starting Spec 2; production pack activation remains
unauthorized.

## Current plan-unit kickoff prompt

Use this with U2-U8 from the implementation-ready plan. U1 uses the smaller
work-package prompt linked above.

```text
Implement only [U_ID] from
`docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md`.
Do not implement a later unit in this task.

Before editing, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, Spec 1, and the entire Spec 2. Read the
relevant research/backlog files named by Spec 2. Inspect the merged Spec 1
runtime contracts, current tests, schemas, scripts, package commands, and recent
Git history. Read the relevant installed Eve and Next.js documentation before
changing framework code, and search the Eve registry before implementing an
integration.

Verify local `main` contains the reviewed Spec 1 merge, then create the one
temporary worktree and unit branch directly from that exact commit. Use
`codex/spec-02-uN` for U2-U8. If Codex already supplied a fresh isolated
worktree at the correct base, use it and do not create a nested worktree.
Preserve all unrelated changes. If another temporary worktree exists or the
dependency/base is wrong, stop and report the exact state instead of creating a
second worktree or rebuilding Spec 1. After independent review, the coordinator
merges the unit to local `main` and removes its worktree/branch before the next
unit begins.

Follow `specs/IMPLEMENTATION_PROTOCOL.md`. Work through only the assigned unit.
Inspect first, implement the smallest complete behavior, add the narrowest
deterministic test, run focused verification, review the diff, and create atomic
local commits at verified boundaries. Track progress in Git and the handoff, not
by adding a chronological ledger to the specs or plan.

An exit gate is proven only when a test exercises the real production contract
or caller expected at this phase. Source-text assertions, mock-only success,
fixture runtimes, typechecking, and builds may supplement evidence but cannot
stand in for a required integration path. Test forbidden transitions and
bounded failure fixtures explicitly.

Spec 2 owns versioned strategy-pack contracts and the IPO reference pack. Do not
implement Spec 3's source-adapter platform, Spec 4/5 strategy behavior, Spec 6
sharing, Telegram, private artifacts, or live trading. Pack declarations cannot
weaken Spec 1 owner, capability, budget, isolation, or financial-safety limits.

After the assigned unit's verification passes, stop. Report the phase base/head
commits, requirements covered, exact commands and results, remaining work, and
risks. Do not start the next unit, review or merge your own branch, push, open a
PR, deploy, or mutate remote/production state.
```

## Later-sprint implementation prompt template

Use this template for Specs 3-6 in a fresh task. Spec 2 uses the plan-unit prompt
above. Replace every bracketed field. The previous sprint must already be
independently reviewed and merged into the spec integration branch.

```text
Implement only Sprint [SPRINT_NUMBER] — [SPRINT_TITLE] — from Spec
[SPEC_NUMBER], `[SPEC_PATH]`. Do not implement any later sprint in this task.

Before editing, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, the entire assigned spec, and every preceding
dependency spec. Read the research/backlog files explicitly named by the
assigned sprint. Inspect the current production callers, contracts, tests,
schemas, scripts, package commands, and recent Git history. Read the relevant
installed Eve and Next.js documentation before framework changes, and search
the Eve registry before implementing an integration.

Confirm `[INTEGRATION_BRANCH]` points to the reviewed merge of Sprint
[PREVIOUS_SPRINT_NUMBER]. Create a fresh worktree and phase branch
`[PHASE_BRANCH]` from that exact commit. If Codex already supplied a fresh
isolated worktree at the correct base, use it and do not create a nested
worktree. Preserve unrelated changes. If a dependency is missing, stop and
report the exact branch/commit gap instead of creating a parallel subsystem.

Follow `specs/IMPLEMENTATION_PROTOCOL.md`. Work through only the assigned
sprint, one checklist item at a time. For each item: inspect first, implement the
smallest complete behavior, add the narrowest deterministic test, run focused
verification, review the diff, mark only that item after it passes, and make an
atomic local commit containing behavior, test, and checkbox. Use Git and the
handoff as the progress record rather than appending a chronological spec
ledger.

Before checking the sprint exit gate, prove the behavior through the real
production caller or entry point expected by the spec. Do not substitute a
fixture runtime, prompt/source inspection, isolated store test, mock-only
success, typecheck, or build for cross-layer evidence. Add replay, concurrency,
stale-revision, forbidden-access, and crash-window coverage wherever the sprint
contains durable state or external side effects.

Stay inside the assigned spec and sprint. Preserve all owner authorization,
workspace isolation, default-deny capability, idempotency, budget,
alert-routing, privacy, and no-background-trading invariants. Do not pull later
spec behavior, Telegram, private artifacts, paid/live operations, deployment,
or production mutation into this phase unless the assigned checklist item
explicitly requires it and the owner separately authorizes it.

After the assigned sprint exit gate passes, stop. Report the phase base/head
commits, checked items, exact commands and results, remaining unchecked work,
and risks. Do not start the next sprint, review or merge your own branch, push,
open a PR, deploy, or mutate remote/production state.
```

Use these branch values:

| Spec | Spec path | Integration branch | Phase branch pattern |
| --- | --- | --- | --- |
| 3 | `specs/03-public-source-adapters.md` | `codex/spec-03-source-adapters` | `codex/spec-03-sprint-N` |
| 4 | `specs/04-congressional-signals-house.md` | `codex/spec-04-congressional-signals` | `codex/spec-04-sprint-N` |
| 4A | `specs/04a-hybrid-evidence-reasoning.md` | `codex/spec-04a-hybrid-evidence` | same integration branch; sprint commits |
| 4B | `specs/04b-earnings-call-changes.md` | `codex/spec-04b-earnings-call-changes` | same integration branch; sprint commits |
| 5 | `specs/05-insider-clusters.md` | `codex/spec-05-insider-clusters` | `codex/spec-05-sprint-N` |
| 6 | `specs/06-shared-signal-plane.md` | `codex/spec-06-shared-signal-plane` | `codex/spec-06-sprint-N` |

## Independent sprint-review prompt template

Run this in a separate fresh task after an implementation phase stops.

```text
Perform a read-only independent review of Spec [SPEC_NUMBER], Sprint
[SPRINT_NUMBER] on `[PHASE_BRANCH]`.

Phase base: `[BASE_COMMIT]`
Phase head: `[HEAD_COMMIT]`
Specification: `[SPEC_PATH]`

Do not edit files, check boxes, commit, merge, rebase, push, deploy, mutate
production, or message the implementation task. Use a fresh isolated or
detached review worktree at the phase head. Read `AGENTS.md`, `HANDOFF.md`,
`NORTH_STAR.md`, `specs/IMPLEMENTATION_PROTOCOL.md`, the entire assigned spec,
and the relevant dependency specs. Inspect the complete phase diff and the real
production callers; do not infer correctness from progress rows or green tests.

Verify every checkbox changed by the phase and the sprint exit gate. Prioritize:

- real caller-to-side-effect wiring rather than isolated modules;
- owner authorization, workspace isolation, and forged/stale identity cases;
- replay, concurrency, compare-and-set, lease, and crash-window behavior;
- default-deny capability and financial-safety enforcement at runtime;
- bounded data, privacy-safe logs/metrics, and explicit failure states;
- rollout and backward compatibility when new configuration is absent; and
- whether tests can actually fail when the production behavior is disconnected.

Run focused deterministic and Redis-backed tests as needed, plus the narrowest
relevant typecheck/build. Do not use paid providers, real financial actions,
production, or live messaging.

Return findings only, ordered P0–P3. For each finding include a tight file/line
range, observed evidence, violated requirement, reproducible impact, missing
test, and smallest remediation plus acceptance test. Also list verified claims,
premature/unproven checkboxes, commands run/results, and anything not tested.
Do not implement fixes or propose later-sprint scope.
```

## Verified-finding remediation prompt template

Use only after the coordinating agent has reproduced the review findings.

```text
Remediate only the verified findings below on `[PHASE_BRANCH]` for Spec
[SPEC_NUMBER], Sprint [SPRINT_NUMBER]. Do not begin another sprint or expand the
product scope.

[PASTE VERIFIED FINDINGS WITH FILES, FAILURE SCENARIOS, AND ACCEPTANCE TESTS]

Read `AGENTS.md`, `HANDOFF.md`, `specs/IMPLEMENTATION_PROTOCOL.md`, the assigned
spec/sprint, and the current phase diff. Reproduce each finding before editing.
If a finding is no longer valid, report the contrary evidence and do not make a
speculative change.

Fix one finding at a time. Add a regression test that fails for the reproduced
bug and passes after the smallest safe correction. Run the focused test and
relevant sprint regressions, review the diff, correct any prematurely checked
spec item, and make one atomic local commit per finding or inseparable failure
mode. Preserve unrelated changes.

Stop after all verified findings are resolved. Report commits and exact test
results. Do not review or merge your own work, start the next sprint, push,
deploy, or mutate remote/production state.
```

## Reviewed phase-integration prompt template

Use only after independent review and any remediation re-review are clean.

```text
Integrate the reviewed Spec [SPEC_NUMBER], Sprint [SPRINT_NUMBER] phase branch
`[PHASE_BRANCH]` into the local spec integration branch
`[INTEGRATION_BRANCH]`.

This is a bounded local Git integration task. Read `AGENTS.md` and the repository
and merge sections of `specs/IMPLEMENTATION_PROTOCOL.md`. Verify both branch
heads and the recorded clean-review head before changing Git state. Confirm the
integration worktree is clean and contains no unrelated user changes. If it is
dirty or has advanced unexpectedly, stop and report the exact state; never
stash, discard, reset, overwrite, or absorb unrelated work.

Merge without squashing away the phase's atomic commits. Resolve only deliberate
in-scope conflicts, run the sprint's critical verification after the merge, and
report the resulting integration commit. Do not merge to `main`, start the next
sprint, push, open a PR, deploy, or mutate production.
```

## Whole-spec integration/release prompt template

Use after every sprint phase is reviewed and merged into the integration branch.

```text
Perform the final whole-spec review and safe local merge for Spec [SPEC_NUMBER]
from `[INTEGRATION_BRANCH]` into local `main`.

Read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, the entire assigned spec, and every dependency
spec. Review the complete integration-branch diff from its `main` merge base.
Independently verify every sprint exit gate, verification-matrix boundary,
rollout requirement, definition-of-done item, documentation update, and the
production call graph. Run the complete required deterministic, Redis, typecheck,
build, migration, isolation/security, fixture, and authorized live-smoke matrix.

Do not merge a red or incompletely checked branch. If an external acceptance
step is unauthorized or any finding remains, stop and report it. If all evidence
passes, confirm local `main` is clean, integrate any newer local `main` commit
normally, rerun critical verification, and merge with an explicit local merge
commit while preserving atomic history.

Do not push, open a PR, deploy, or mutate remote/production state unless the
owner separately authorizes that exact action. Report the final local merge
commit and the exact base commit required by the next spec.
```
