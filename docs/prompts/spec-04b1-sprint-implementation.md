# Spec 4B.1 implementation prompt

Pass the text below to one fresh Codex **Project** task rooted at
`/Users/ashnouruzi/dev/adaam`.

```text
Take ownership of implementing Spec 4B.1, Task-Aware Model Selection.

Repository: /Users/ashnouruzi/dev/adaam
Canonical spec and progress ledger: specs/04b1-adaptive-model-routing.md

First inspect git status and current branch. The planning commit must be present
and the worktree must be clean. Use one branch,
codex/spec-04b1-adaptive-model-routing, and this same Project task for both
sprints. Do not create another plan, checklist, worktree, or per-sprint branch.

Orient once before editing:

1. Read AGENTS.md and HANDOFF.md.
2. Read NORTH_STAR.md and the complete Spec 4B.1.
3. Read only the relevant completed Spec 4A/4B contracts and current hybrid
   definition, auth-envelope, worker, source-recovery, semantic, Earnings,
   strategy-pack, capability, budget, and verification code.
4. Read the relevant installed Eve 0.33 dynamic-model/reasoning/task docs and
   search the Eve registry before adding an integration.

The existing hybrid architecture is complete. Do not redesign it. The required
change is:

- deterministic parsing -> no model;
- bounded extraction/layout recovery -> centrally configured cheap fast model
  with low or provider-default reasoning;
- semantic interpretation, pattern recognition, forecasting,
  recommendations, and portfolio meaning -> centrally configured frontier
  model with high reasoning.

Use registered task purpose, not another LLM call, to choose the class.
Strategies must not hard-code providers. Preserve all existing evidence,
citations, validators, budgets, isolation, fresh-worker execution, result
records, and human authorization boundaries.

Do not implement automatic escalation, route chains, new routing stores, a
middle tier, an LLM router, shadow traffic, cross-model outage fallback, new
connectors, Spec 4C, broker access, or trading. Publish a minimal new Earnings
pack version only if its immutable model-bound evidence-contract digest makes
that necessary; never mutate 1.0.0 or migrate an existing workspace.

Implement Sprint 1 only. Add the smallest central resolver, configure fast and
frontier model/reasoning choices, wire existing extraction and semantic callers,
and add focused routing verification. Run the Sprint 1 verifier, typecheck, and
Eve build. Mark only verified Sprint 1 checkboxes, commit, report what changed
and the exact Sprint 2 work, then stop and ask whether to continue.

When told to continue, remain in this same task and context. Do not repeat
orientation or rerun unchanged green checks. Sprint 2 owns model qualification,
the one affected regression pass, one diff-scoped review, owner-authorized
production routing smoke/rollback, documentation, push/PR/merge, production
verification, and branch cleanup.

Do not make live model calls, change production flags, use paid services, or
deploy manually without grouped owner authorization when Sprint 2 reaches that
boundary. Final commit/push/PR/merge and automatic Git-backed deployment are
authorized once the local exit gate is green.

Begin Sprint 1 now.
```
