# Spec 1 Work Package 2 Prompt

Use this prompt only after Work Package 1 commit `1b7921d` has been independently reviewed and merged into local `main`.

```text
Resume Spec 1 in the `adaam` repository. Implement only Work Package 2: the exact-origin redirect fence. Do not begin production acceptance or deferred hardening in this task.

## Orientation

Before editing:

1. Read `AGENTS.md` and the relevant workspace-runtime sections of `HANDOFF.md` and `NORTH_STAR.md`.
2. Read these Spec 1 sections: `Non-negotiable invariants`, `Reference acceptance workspace: IPO Filings`, `Implementation status`, `Local production prerequisites`, `Verification matrix`, and `Definition of done`.
3. Read the one-task loop, verification rules, checklist rules, and commit policy in `specs/IMPLEMENTATION_PROTOCOL.md`.
4. Read R2 and U1 in `docs/plans/2026-08-15-0905-feat-spec-01-acceptance-and-strategy-packs-plan.md`.
5. Inspect the current fetch caller, SEC evaluator, focused fixtures/tests, package commands, branch/worktrees, and working tree. Preserve unrelated changes and do not create a second temporary worktree.
6. Read installed Eve or Next.js documentation only if the implementation changes those framework APIs. Search the Eve registry only if adding an integration; this work package should not need one.

## Settled starting point

Spec 1 Sprints 0–6 are locally complete. Work Package 1 made workspace schedule/worker logs privacy-safe. Do not reopen or re-audit that work. If its reviewed commit is not present in local `main`, stop and report the missing dependency.

## Work Package 2

Complete the only unchecked item under `Local production prerequisites`:

> Before Spec 2 activates a pack-managed source, reject exact-fenced redirects before issuing any second outbound request, including redirects to private or undeclared origins.

Required behavior:

- Validate every redirect destination against the source contract before following it.
- Never make a second request to a private, non-HTTPS, credential-bearing, or undeclared origin.
- Preserve accepted same-origin behavior and existing response-size, timeout, source-attempt, and SEC normalization rules.
- Keep this as a narrow change to the existing fetch/source boundary; do not build Spec 3's adapter platform.

## Execution and verification

1. Inspect the production fetch caller and existing redirect/evaluation tests before editing.
2. Implement the smallest coherent fence and focused deterministic fixtures.
3. Prove through the real fetch caller that off-origin redirects make exactly one request. Cover a permitted `.gov` but undeclared origin and a private/invalid destination.
4. Run the focused source-fence and SEC regression tests, `npm run typecheck`, and `npm run build:agent`. Do not run the Next.js build or the full Photon/Redis/manager matrix because this package does not change those paths.
5. Review the diff for scope, request leakage, unrelated changes, and accidental Spec 3 work.
6. After the production-caller test and required checks pass, mark only the exact-origin item under `Local production prerequisites` complete. Do not mark production acceptance, the exit gate, the global privacy invariant, or deferred hardening.
7. Commit the behavior, tests, and checkbox together as one local commit.
8. Stop and report the base/head commits, files changed, exact verification results, remaining production acceptance, and confirmation that no remote or production state changed.

After this package, one independent review should cover the combined U1 diff from Work Packages 1 and 2. The full Spec 1 regression/deployment-readiness gate runs once after that review, immediately before owner-authorized production acceptance; it is not a third implementation package.

Do not review or merge your own work, push, open a PR, deploy, send a real Photon message, use paid services, or mutate production state unless the user separately authorizes it.
```
