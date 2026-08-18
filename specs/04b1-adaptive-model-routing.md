# Spec 4B.1: Task-Aware Model Selection

Status: Implemented and production accepted

Date: 2026-08-17

Product target: `NORTH_STAR.md`

Dependencies:

- `specs/04a-hybrid-evidence-reasoning.md`
- `specs/04b-earnings-call-changes.md`

Implementation guidance:

- [Vercel: Best AI Models for Developers](https://vercel.com/i/best-ai-models-for-developers)
- [Vercel: Cost-Aware Model Routing](https://vercel.com/kb/guide/cost-aware-model-routing-with-ai-gateway)
- [Vercel: AI Gateway provider routing](https://vercel.com/changelog/sort-providers-by-cost-latency-or-throughput-on-ai-gateway)

## Objective

Use the hybrid execution system that already exists while matching model cost
and capability to the task:

```text
Deterministic parsing                 -> no model
Bounded extraction or layout recovery -> fast, inexpensive model
Interpretation, patterns, forecasts,
recommendations, or portfolio meaning -> frontier reasoning model
```

This sprint changes model selection, not the hybrid architecture. Existing
evidence bounds, citations, validators, budgets, isolation, fresh workers,
findings, and human decision-making remain authoritative.

## Product rule

Eve should use model intelligence whenever deterministic code cannot reliably
extract or understand the needed information. It should also use its strongest
reasoning model to make sense of evidence: identify signals and relationships,
compare patterns with prior events, explain plausible implications, produce
bounded forecasts or portfolio-research recommendations, and surface evidence a
human might miss across a large dataset.

These outputs must cite their supporting sources, distinguish fact from
inference/forecast/recommendation, show concise evidence-to-conclusion logic,
include material counterevidence and invalidation conditions, and abstain when
the accepted evidence is insufficient. The owner decides whether to act. Model
output never becomes trading authorization.

## What already exists

Specs 4A and 4B already provide:

- deterministic-first parsing with bounded LLM recovery;
- fresh isolated hybrid workers;
- signed evidence, exact citations, deterministic validators, and abstention;
- workspace/source budgets and recorded model usage/cost;
- semantic earnings analysis producing facts, inferences, forecasts,
  recommendations, counterevidence, and rationale; and
- production-accepted source-to-finding and alert/Discuss flows.

Do not rebuild or replace these systems.

## Required behavior

### Three execution classes

1. **No model:** fetching, parsing, normalization, comparison, or scoring that
   deterministic code can complete correctly.
2. **Fast model:** bounded extraction, schema mapping, document/spreadsheet/PDF
   layout recovery, factual classification, or summarization whose material
   output can be checked against supplied evidence.
3. **Frontier model:** semantic interpretation, ambiguous classification,
   signal identification, cross-evidence pattern recognition, historical
   analogy, causal/scenario analysis, forecasting, research recommendations,
   and portfolio implications.

A task's registered hybrid purpose selects the class. The router itself does
not call another LLM. Future connectors and strategies can reuse these classes
without choosing provider-specific models.

### Central model selection

- Add one small shared resolver that accepts the registered task purpose and
  returns the configured model ID and reasoning effort.
- Keep exact models centrally configurable and replaceable. Strategy code must
  request a class, not hard-code Haiku, Flash, Opus, GPT, or another provider.
- Configure at least one fast model and one frontier model. House extraction
  recovery may retain two independently executed fast models where its existing
  acceptance contract requires corroboration.
- Use low or provider-default reasoning for fast work and high reasoning for
  frontier work. The exact choice must be carried into the fresh worker through
  the existing signed task boundary.
- The selected model must still be allowed by the existing hybrid definition,
  workspace/deployment capability policy, and budget. Missing or invalid
  configuration fails before a model call.
- Eve's root conversational model is unchanged. This resolver applies only to
  fresh bounded hybrid tasks.

### Existing task mapping

- House PTR, spreadsheet-role, and earnings-transcript layout recovery use the
  fast class.
- Earnings comparison and other workspace semantic interpretation use the
  frontier class.
- Deterministic source fetching and normalizers remain model-free.
- Fetching/searching tools and future connectors are not added here. When those
  capabilities are added, mechanical acquisition remains deterministic while
  model-assisted extraction and judgment use these same classes.

### Compatibility

- Existing hybrid jobs and accepted results remain readable; do not introduce
  a new job store or route-chain state machine.
- Existing `earnings-call-changes@1.0.0` remains immutable and usable.
- Because its evidence-contract digests include the allowed semantic model,
  publish the smallest new immutable pack version only if required to run the
  configured frontier model. Do not build generalized pack migration; prove a
  new binding while leaving existing bindings untouched.
- A model change may create a different existing-style job identity. There is
  no automatic retry or fast-to-frontier escalation in this sprint.

### Model qualification

- Select candidate model IDs from the current Vercel AI Gateway catalog at
  implementation time. Haiku/Flash and Opus/Terra are examples of capability
  classes, not required hard-coded IDs; use models actually available through
  Eve's Gateway runtime.
- Evaluate the fast candidate on the existing Spec 4A extraction-recovery
  corpus. It must preserve zero unsafe accepts and invalid citations, 100%
  abstention/quarantine on unsafe cases, and at least the existing 80%
  supported-recovery threshold.
- Confirm the fast candidate is materially cheaper than the selected frontier
  candidate for accepted extraction work. Otherwise select another qualified
  fast candidate or leave fast routing disabled.
- Reuse the accepted Spec 4B frontier-model evidence when the exact model,
  reasoning, prompt, schema, validator, and corpus still match. Do not rerun an
  identical accepted benchmark merely because routing now selects it.
- Existing result records already retain model ID, token usage, paid cost, and
  validation trace. Add only the smallest bounded observation needed to prove
  the selected class/reasoning; do not create a separate analytics platform.

## Scope boundaries

### In scope

- One central no-model/fast/frontier resolver.
- Fast/frontier model and reasoning configuration.
- Wiring existing extraction recovery and semantic reasoning callers.
- The minimum signed-envelope compatibility needed to apply reasoning effort.
- Focused routing tests, fast-model qualification, affected pack revision if
  required, and one controlled production routing smoke.

### Deferred to `BACKLOG.md`

- Automatic fast-to-frontier retry or escalation.
- Route chains, multi-attempt state machines, or new routing stores.
- A middle model tier, LLM-based router, shadow traffic, or automatic policy
  optimization.
- Cross-model outage fallback beyond AI Gateway's provider handling.
- New connectors, research tools, paid sources, or Spec 4C behavior.

## Implementation ledger

Use one Project task and one branch for the full change. This file is the only
progress checklist. A passing check remains valid unless relevant code,
configuration, fixture, environment, or dependency changed.

### Sprint 1 — Select and wire models

- [x] Add the central task-purpose-to-model-class resolver and strict
  configuration validation.
- [x] Pass the selected model and reasoning effort through the existing signed
  fresh-worker boundary without weakening existing authorization.
- [x] Wire current extraction-recovery callers to fast and semantic callers to
  frontier; keep deterministic work model-free.
- [x] Preserve existing definition, capability, budget, citation, validation,
  and result-storage checks.
- [x] Add one focused routing verifier covering no-model, fast, frontier,
  missing/partial configuration, denied model, and unchanged root model.
- [x] Run the focused verifier, typecheck, and Eve build; mark verified items
  and commit Sprint 1.

Exit gate: deterministic fixtures make no model call; extraction dispatches the
configured fast model at low/default reasoning; semantic judgment dispatches
the configured frontier model at high reasoning.

### Sprint 2 — Qualify, prove, and land

- [x] Qualify the selected fast model against the existing extraction corpus
  and compare its accepted-work cost with the frontier model.
- [x] Reuse matching Spec 4B frontier evidence or run only the missing/stale
  frontier qualification.
- [x] If required by immutable evidence-contract digests, publish the smallest
  new Earnings pack version and prove old/new coexistence without migration.
- [x] Run the affected hybrid, Earnings, strategy-pack, worker, budget,
  isolation, typecheck, Eve-build, and application-build regression once after
  the final code change.
- [x] Perform one final diff-scoped review. Fix confirmed findings and rerun only
  affected checks, not the entire suite unless shared production code changed.
- [x] With owner authorization, run one controlled production task confirming
  the expected class, exact model, reasoning, citations, validation, usage, and
  cost; then restore routing/hybrid flags to their prior off state.
- [x] Mark this spec complete, move only genuine deferred work to `BACKLOG.md`,
  update `HANDOFF.md` and `NORTH_STAR.md`, commit, push, merge to GitHub `main`,
  verify production health, and clean up the branch in the same task.

Exit gate: the existing hybrid system demonstrably uses a qualified cheap model
for objective extraction and a qualified frontier model for judgment, without
changing evidence quality, authority, or the human decision boundary.

Implementation evidence:

- `anthropic/claude-haiku-4.5` at provider-default reasoning passed two repeated
  extraction-corpus runs with 100% supported recovery and safety, zero unsafe
  accepts, invalid citations, accepted unknowns, or forbidden tool calls, and
  cost about 62% below the equivalent `openai/gpt-5.4` accepted work.
- `earnings-call-changes@1.0.1` binds the GPT-5.4/high semantic contracts at
  content digest `a2ee79e5d63ac2d94c5ed43bbdf71bf74a2765b62e0e5a3be7e8c8a01e969105`;
  deterministic production wiring proves `1.0.0` and `1.0.1` coexist without
  migration.
- Complete-diff review run `20260817-172121-f44f75b3` produced six validated
  findings; all were repaired and their affected checks pass.
- The 48-gate regression was executed once. Its one missing-route fixture
  failed closed, was repaired, and that gate plus every not-yet-run downstream
  gate, typecheck, Eve build, and application build passed.
- The owner-authorized live frontier acceptance used root run
  `wrun_01M09B53ZT3V5CV3VCG4E2RY6H` and signed turn
  `wrun_01M09B542327KMZMDPJJ2DW4FT`. The exact `openai/gpt-5.4`/high worker
  called `read_hybrid_evidence_bundle` once and
  `complete_hybrid_evidence_job` once, durably completed job
  `hybrid-job.a870a3c662055aa09c9d36b2ece5bd0346274d758ed6a7538f36dab34b3cec19`,
  and returned accepted facts and inferences with three exact bounded
  citations. Gateway generations `gen_01M09B549ACRV8276CQ5QEP50B` and
  `gen_01M09B58B6A5HX4QZWEDQ0Z40D` recorded 15,692 input tokens, 9,399 output
  tokens, 4,608 cached-input tokens, and total cost USD 0.169847. The focused
  production validator verifies the same citation, schema, completion, usage,
  and signed-tool contract; completion-triggered cancellation closes the Eve
  stream without permitting another paid generation.
- Production has the four exact routing values configured, while
  `EVE_HYBRID_EVIDENCE_ENABLED`, both hybrid child flags, and
  `EVE_WORKSPACE_DISPATCH_ENABLED` remain `0`. The owner-path repair merge
  `a460f69` was rebased into this branch without production-code conflicts; its
  recorded passing evidence was reused and the already-passing 48-gate
  regression was not repeated.

## Definition of done

- [x] No-model, fast, and frontier tasks select the correct execution class.
- [x] Models and reasoning effort are centrally configured rather than
  strategy-hard-coded.
- [x] Existing extraction and semantic tasks use the intended models through
  the existing fresh hybrid worker.
- [x] Fast-model evals meet the existing safety/quality threshold and show a
  meaningful cost advantage.
- [x] Semantic outputs retain citations, facts/inferences/forecasts/
  recommendations, counterevidence, invalidation conditions, and concise
  rationale.
- [x] Existing durable records and Earnings `1.0.0` remain valid; any required
  new pack version coexists without migration.
- [x] Focused and affected regression checks, one diff review, one controlled
  production routing smoke, rollback, documentation, merge, and cleanup pass.
