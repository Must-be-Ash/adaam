# Spec 4B.1 implementation prompt

Pass the text below to one fresh Codex **Project** task rooted at
`/Users/ashnouruzi/dev/adaam`.

```text
Take ownership of implementing Spec 4B.1, Adaptive Model Routing, in this
repository:

- Worktree: /Users/ashnouruzi/dev/adaam
- Required base: clean current GitHub main containing Spec 4B at or after
  82b636a
- Canonical spec and progress ledger:
  specs/04b1-adaptive-model-routing.md

Use one Project task, one branch named
codex/spec-04b1-adaptive-model-routing, and the existing repository worktree
for Sprints 0-4. Do not create a second worktree, a separate implementation
plan, per-sprint branches, or a parallel checklist. The spec is authoritative.

Before editing, orient once:

1. Read AGENTS.md and HANDOFF.md completely.
2. Read NORTH_STAR.md, specs/04b1-adaptive-model-routing.md, and the workflow
   override at the top of specs/IMPLEMENTATION_PROTOCOL.md.
3. Read only the relevant contracts and completion evidence in Specs 4A and 4B;
   do not re-review completed specs.
4. Inspect the current hybrid definitions, schemas, auth envelopes, job store,
   budgets, workers, workspace capabilities, Earnings worker, strategy pack,
   package scripts, and recent Git history named by Spec 4B.1.
5. Resolve and read the relevant installed Eve 0.33 task/model/budget/
   instrumentation docs. Search the Eve registry before implementing an
   integration from scratch, as AGENTS.md requires.

Then implement Sprint 0 only. Use proof-first fixtures at the new contract
seams, make the smallest production changes required for Sprint 0, run its
focused verifier plus typecheck and the affected build when applicable, mark
only verified Sprint 0 checkboxes in the spec, commit the sprint, and report:

- commit and changed files;
- checklist items completed;
- focused verification actually run;
- exact next sprint;
- any authorization or genuine blocker.

Stop at the Sprint 0 boundary and ask whether to continue. When told to
continue, use the same task, branch, and context for the next sprint.

Important architecture boundaries:

- Keep Eve's root conversational model stable. Route only fresh bounded hybrid
  tasks.
- Typed scheduled tasks declare deterministic, objective_extraction, or
  semantic_judgment. Do not add an LLM call merely to choose a model.
- Strategies and pack definitions must not name provider/model IDs. Central,
  immutable, qualified policy resolves the exact model and reasoning setting.
- Preserve every v1 durable record and earnings-call-changes@1.0.0 exactly.
  Add explicit v2 records and earnings-call-changes@1.1.0; never silently
  migrate a workspace.
- Add a model-independent logical route and separate model-specific attempts.
  Enforce at most one validator-eligible fast-to-frontier escalation with CAS,
  separate budgets, and complete provenance.
- Evidence, citations, scope, tools, authorization, safety rules, and financial
  permissions cannot widen with a stronger model.
- Do not add a middle tier, model-router LLM, cross-model outage fallback, new
  UI, new connector, paid research, Spec 4C, broker access, or trading.

Efficient verification is mandatory:

- A green sprint receipt remains valid until relevant production code,
  contracts, configuration, fixtures, base, environment, or its test command
  changes.
- Do not reread the whole spec/codebase, repeat orientation, rerun an identical
  broad suite, or start another independent review at the next sprint merely
  to reconfirm the work you just completed.
- At each sprint, run the new focused verifier and only affected prior checks.
- Sprint 4 owns exactly one independent whole-spec review, targeted fixes, and
  one broad regression gate after the final code change.
- Reuse Spec 4B's accepted source acquisition and Photon alert/Discuss evidence
  unless this branch changes those paths.
- Documentation, commits, push/PR/merge, and an automatic Git-backed deployment
  do not invalidate a green code gate. Rerun only checks affected by an actual
  code/configuration/conflict change.

Do not run live models, paid calls, production flags, or manual deployment
without grouped owner authorization at the sprint that needs them. The spec
already authorizes the final Git commit/push/PR/merge and automatic Git-backed
deployment once the local exit gate is green. In Sprint 4, finish the checklist,
backlog/handoff/North Star updates, landing, production verification, flag
rollback, and cleanup in the same task instead of reporting “complete” before
GitHub main is complete.

Begin with Sprint 0 now.
```
