# Spec 1 independent-review prompt

Use this prompt in a new Codex task. The reviewer must not edit the
implementation branch. Return the review to the coordinating agent before any
finding is sent to the Spec 1 implementer.

```text
Perform a read-only, independent engineering review of the completed local
portion of Spec 1.

Candidate branch: `codex/spec-01-independent-workspaces`
Candidate head: `32370db`
Merge base: `154d1b9`
Existing implementation worktree: `/Users/ashnouruzi/dev/adaam-spec-01`
Specification: `specs/01-independent-workspace-runtimes.md`

Do not modify the candidate branch or its worktree. Do not edit checkboxes,
commit, merge, rebase, push, deploy, configure production, send Photon/iMessage
traffic, or contact the previous implementer. If the Codex task is not already
in a fresh isolated worktree, create a separate detached review worktree at the
candidate head. Any dependency link or generated test output must remain
untracked and disposable.

Start by reading `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`,
`specs/IMPLEMENTATION_PROTOCOL.md`, and the entire Spec 1. Inspect the complete
diff from `154d1b9..32370db`, the ordered commit history, relevant current code,
tests, package scripts, and installed Eve/Next.js documentation. Do not infer
correctness from commit messages, progress-table entries, green typechecking,
or checked boxes.

Scope the review correctly:

- Sprints 0–5 and the checked local items in Sprint 6 are implementation claims
  that must be verified.
- The production Photon rollout, Sprint 6 exit gate, all of Sprint 7,
  observability/operations checklist, definition of done, documentation update,
  final review, and merge are intentionally incomplete. Report them as remaining
  work, not implementation defects.
- Do not review style or naming unless it creates a correctness, safety,
  maintainability, or operational risk.

Review the following boundaries in priority order:

1. Trace every checked sprint exit gate from the real production entry point to
   its durable side effects. A fixture runtime, prompt inspection, source-text
   assertion, isolated store test, or build is not proof that the production
   path calls the tested behavior.
2. Test crash windows surrounding every sequence of durable receipt creation,
   model dispatch, Photon send, alert send, checkpoint commit, lease release,
   and budget reconciliation. Verify retries either finish safely or enter an
   explicit quarantine; they must not silently return from an intermediate
   state.
3. Verify owner authorization and rollout compatibility on the ordinary Photon
   path. Determine what happens before and after feature flags when new owner or
   runtime environment variables are absent, invalid, or only partly deployed.
4. Verify worker isolation and freshness at commit time, including brief,
   strategy, capability, budget, monitor, source, generation, and lifecycle
   revisions. Check forged IDs and cross-workspace reads/writes.
5. Verify the IPO reference acceptance path uses the real scheduler, real Eve
   worker dispatch, exact SEC fetch tool, canonical structured finding,
   checkpoint, alert outbox, and Photon delivery path. Confirm the durable
   finding preserves every SEC identifier and provenance field required by the
   specification.
6. Verify alerts are labeled with the owning workspace display name rather than
   a monitor name, and that Discuss/held replies cannot switch or dispatch to a
   stale, archived, retired, foreign, or changed-generation workspace.
7. Verify logs, metrics, error records, operator views, and fixtures obey the
   privacy and low-cardinality rules. Search for message bodies, principals,
   session/workspace/monitor/run IDs, URLs, timestamps, hashes, and exception
   bodies in logs or metric tags.
8. Review failure recovery before a worker session starts, after it starts, and
   after it produces an outcome. Confirm leases, budgets, run health, failure
   counters, and checkpoints cannot remain silently stranded.
9. Identify version-fragile framework usage, especially private imports from
   Eve's `dist` internals, and determine whether a pinned compatibility test and
   documented upgrade boundary are sufficient.
10. Judge the tests themselves. Distinguish real production-path integration,
    ephemeral-Redis concurrency, fixtures, mocks, and source-code assertions.
    Look for tests that merely restate the implementation or omit the relevant
    caller.

The following are audit leads, not assumed conclusions. Independently prove or
disprove each one:

- A dispatch receipt left in `dispatching` by a crash before `bridge.send` may
  cause a retry to return without dispatching or quarantining.
- A response receipt left in `staged` before it is marked `delivering` may cause
  a retry to return without delivery or quarantine.
- SEC IPO evaluation appears heavily fixture-tested, but may not be called by
  the actual scheduled workspace worker.
- The generic finding schema may not retain CIK, accession number, form type,
  filing/file number, and canonical filing URL as structured fields.
- Photon owner mapping and ingress receipt creation may be unconditional even
  when workspace runtime feature flags are disabled.
- Workspace alerts may derive `workspaceName` from `monitor.name`.
- The worker envelope carries brief and strategy revisions, but the commit path
  may not re-read and compare them.
- Early worker-preparation failures may release budget but leave the lease and
  health state to expire without a durable failure record.
- New schedule logging may include raw workspace and monitor IDs.
- The Eve worker launcher imports a private compiled runtime module.

Run the narrow deterministic and Redis-backed tests needed to validate findings,
plus typechecking and builds when useful. Do not run paid, live financial,
production, or real Photon operations. Do not expose secret values in commands
or output. If the complete suite is too expensive, prioritize tests that can
falsify checked exit gates and state exactly what was not run.

Return a review report only. Use this format:

1. Verdict: `not ready`, `ready after fixes`, or `locally ready pending the
   intentionally deferred external work`.
2. Findings ordered by severity (`P0` critical through `P3` minor). For every
   finding include:
   - concise title;
   - exact file and tight line range;
   - observed code path and evidence;
   - violated specification requirement or invariant;
   - concrete failure scenario and impact;
   - missing or misleading test coverage;
   - smallest safe remediation and the acceptance test that should prove it.
3. Checked claims that you verified and the evidence for them.
4. Checked claims that remain unproven or are checked prematurely.
5. Intentionally incomplete work that remains after remediation.
6. Commands run and results, including skipped commands and why.

Do not provide vague advice. Do not propose new product scope. Do not implement
fixes. If an audit lead is disproven, say why and cite the exact code/test that
disproves it.
```
