# Spec 1 remediation R2 prompt

This is a coordinator-managed phase. Implement only R2, stop at its handoff,
and leave review and integration to a separate task.

```text
Implement only Spec 1 remediation R2: put the deterministic SEC IPO evaluator
and typed SEC filing facts on the real scheduled workspace-worker path. Do not
work on R3 or any later review finding in this task.

Integration branch: `codex/spec-01-independent-workspaces`
Phase branch: `codex/spec-01-remediation-r2`
The coordinator will provide the exact reviewed integration base commit.
Review findings: `specs/SPEC_01_REVIEW_FINDINGS.md`
Specification: `specs/01-independent-workspace-runtimes.md`

Before editing, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`, the entire Spec
1, `specs/IMPLEMENTATION_PROTOCOL.md`, and
`specs/SPEC_01_REVIEW_FINDINGS.md`. Read the installed Eve documentation for
the execution model and durability, schedules, subagents, authored tools,
dynamic capabilities, hooks, and sessions/runs. Run `eve registry search sec`
before adding integration code and record whether a suitable reviewed SEC
integration exists. Inspect the complete current scheduler, compiled worker,
source-fencing, finding, checkpoint, alert-staging, and fixture code paths.

Create a fresh worktree from the exact integration base and use the phase branch
`codex/spec-01-remediation-r2`. If Codex already supplied an isolated worktree
at the exact base, use it and do not create a nested worktree. Preserve all
unrelated changes and do not modify another worktree.

First reproduce and document the disconnect:

- `agent/schedules/event-triggers.ts` starts the real bounded workspace worker;
- `evaluateSecIpoPage()` is reached only by fixture/live-smoke paths; and
- the persisted generic finding cannot carry the required typed SEC facts.

Then implement the smallest complete R2 correction, one verified atomic task at
a time:

1. Define a versioned, validated SEC IPO fact payload that preserves at least
   CIK, accession number, form type, SEC file number when present,
   registration identity, amendment identity/classification, canonical filing
   URL, company name, filed/updated time, source identity, observation time,
   and content evidence. Keep the general finding contract extensible for later
   strategy/source specs; do not flatten these facts into prose or allow the
   model to author authoritative classifications.
2. Wire the existing exact-source fetch normalization and
   `evaluateSecIpoPage()` into the production scheduled worker caller chain.
   The SEC classification, dedupe identity, baseline/no-match decision,
   checkpoint candidate, finding candidate, and alert candidate must be
   deterministic application code. The model must not interpret raw Atom XML
   into authoritative facts.
3. Preserve every existing boundary: authenticated owner/workspace scope,
   immutable monitor binding, signed worker envelope, exact source fence,
   default-deny capabilities, budget reservation, single-flight lease, bounded
   worker context, and idempotent occurrence/finding/alert identity. No worker
   may read chat history or another workspace.
4. Prove the real caller chain with deterministic fixtures:
   authored schedule dispatcher -> production scheduler/control-plane path ->
   actual compiled Eve workspace worker -> exact fenced SEC fixture fetch ->
   deterministic versioned evaluation -> typed finding or no-match -> source
   checkpoint -> staged alert. A fake runner, prompt assertion, isolated parser
   test, or direct evaluator call is supporting evidence only and cannot be the
   acceptance test.
5. Cover at minimum: first-run baseline with no alert; a later S-1; S-1/A tied
   to the same registration; malformed/truncated/redirected/stale/ambiguous
   source rejection; replay of the same occurrence; replay of the same filing;
   and two workspaces proving isolated identities and state. Assert that retry
   cannot duplicate the finding, checkpoint transition, or staged alert.
6. Keep alert delivery out of this phase. R2 may stage the durable alert exactly
   as the current architecture requires, but it must not add a Photon outbox
   drainer, consume the Photon rollout flag, or claim delivery recovery; those
   are R3. Do not add Spec 2 strategy packs, Spec 3 general source adapters,
   source-event ingestion, Telegram, deployment, or remote mutations.

Architecture constraint: use only public Eve APIs when they can prove the real
path. If the existing private Eve runtime boundary remains necessary, do not
expand it casually. Isolate and version-guard any unavoidable usage and record
the residual boundary for the later Eve-compatibility phase. A compiled worker
must reach a terminal event in the acceptance test.

Verification and documentation:

- Make the new production-path acceptance test fail for the pre-R2 disconnect
  before relying on it as evidence.
- After each atomic task, run its focused deterministic test and the narrowest
  relevant regression/static check.
- At the phase gate, run the new real-path SEC acceptance test, existing SEC
  parser/fixture/live-smoke-safe tests, workspace worker isolation/capability
  tests, finding/checkpoint/alert store tests, schedule/dispatch tests,
  typecheck, fixture-configured `eve build`, and the relevant production build.
  Do not make a live SEC request merely to repeat an already completed smoke.
- Review the complete phase diff for scope, secrets/private identifiers,
  generated files, provider calls, and checkbox truth.
- Update only the R2 checklist/evidence in
  `specs/SPEC_01_REVIEW_FINDINGS.md` and the directly affected Spec 1
  checklist/progress rows. Reopen any earlier checked gate if it is not actually
  proven; never mark R3+ work complete.
- Create small local atomic commits at verified boundaries. Do not squash them.

Stop when R2 and its phase verification pass. Report the exact base/head
commits, ordered commits, changed contracts and caller chain, exact commands and
results, any skipped test with reason, and residual risks. Do not review or
merge your own branch, begin R3, push, deploy, configure production, send
Photon/iMessage traffic, make paid calls, or mutate remote state.
```
