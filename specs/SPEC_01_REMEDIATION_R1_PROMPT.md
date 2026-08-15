# Spec 1 remediation R1 prompt

Use this prompt in a fresh Codex task. Do not resume the original long-running
implementation task for this phase.

```text
Implement only Spec 1 remediation R1: close the workspace worker's
provider-managed `web_search` capability leak. Do not work on R2 or any other
review finding in this task.

Candidate integration branch: `codex/spec-01-independent-workspaces`
Candidate head before remediation: `32370db`
Review findings: `specs/SPEC_01_REVIEW_FINDINGS.md`
Specification: `specs/01-independent-workspace-runtimes.md`

Before editing, read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`, the entire Spec
1, `/Users/ashnouruzi/dev/adaam/specs/IMPLEMENTATION_PROTOCOL.md`, and
`/Users/ashnouruzi/dev/adaam/specs/SPEC_01_REVIEW_FINDINGS.md`. Read the installed
Eve default-harness, tool-disabling, compilation, and subagent documentation.
Inspect the candidate code and compiled worker manifest. Do not rely on the
dynamic application registry alone.

Create a fresh worktree and phase branch `codex/spec-01-remediation-r1` from
`32370db`. Merge the latest local `main` documentation commits into the phase
branch with a normal local merge so the phase contains the current protocol and
review record. Confirm that local `main` includes `bd0f3cb` and both current
Spec 1 review/remediation Markdown files. If Codex already supplied a fresh
isolated worktree at the exact base, use it and do not create a nested worktree.
Preserve all unrelated changes. Do not modify the existing
`/Users/ashnouruzi/dev/adaam-spec-01` worktree.

Reproduce the finding first:

- the IPO capability manifest hard-denies `web_search`;
- the worker has no matching `agent/subagents/workspace-worker/tools/web_search.ts`
  disable sentinel; and
- the fully compiled Eve worker exposes provider-managed web search for its
  Gateway model.

Then make the smallest complete correction:

1. Explicitly disable the worker's `web_search` built-in using the installed
   Eve version's documented `disableTool()` slot.
2. Add a deterministic test that inspects the fully resolved compiled worker
   tool surface and fails if `web_search`, or any other undeclared built-in or
   provider tool, is exposed. A source-text assertion or dynamic-registry-only
   test is insufficient.
3. Preserve the exact approved dynamic tools and existing hard denials.
4. Run the focused compiled-surface test, existing worker capability/isolation
   tests, typecheck, and a fixture-configured `eve build`.
5. Review the diff for scope and generated files. Update only the affected Spec
   1 checklist/progress evidence if necessary, and create one atomic local
   commit containing the fix, test, and documentation evidence.

Stop after R1 passes. Report the phase base/head commits, exact commands and
results, and any residual risk. Do not start R2, merge or review your own branch,
push, deploy, configure production, send Photon/iMessage traffic, or mutate
remote state.
```
