# Spec 1 Pass A: final handoff

## Goal

Finish, verify, and integrate the existing Pass A work. Do not restart the prior
investigation and do not begin Pass B, Pass C, deployment, or live Photon work.

## Current state

- Code worktree: `/Users/ashnouruzi/dev/adaam-spec-01-remediation-r2`
- Code branch: `codex/spec-01-remediation-r2`
- Code head: `9d979f6` (`spec-01: isolate schedule claim failures`)
- Documentation worktree: `/Users/ashnouruzi/dev/adaam-spec-roadmap-r2-learnings`
- Documentation branch: `codex/spec-roadmap-r2-learnings`
- Documentation head: `b012b7c` (`docs: preserve fulfilled scheduler claims`)
- Integration worktree: `/Users/ashnouruzi/dev/adaam-spec-01`
- Integration branch: `codex/spec-01-independent-workspaces`
- Redis is installed at `/opt/homebrew/bin/redis-server`.

The code and documentation worktrees are clean. Commit `9d979f6` was committed
but was interrupted before its final independent review. The documentation
branch has not been merged into the code branch, and the code branch has not
been merged into the Spec 1 integration branch.

## Do exactly this

1. **Review the final scheduler fix.** Review `8d08405..9d979f6`. Confirm that a
   failed legacy claim does not prevent fulfilled workspace jobs from running,
   a failed workspace claim does not prevent fulfilled legacy jobs from running,
   and the aggregate error is reported only after the fulfilled batch runs.

2. **Run all Pass A verification.** Run the recovery-schedule, finding-store,
   monitor-store, SEC worker, compiled scheduled-worker, TypeScript, and diff
   checks. Run the real Redis Lua race test with
   `REDIS_SERVER_BIN=/opt/homebrew/bin/redis-server`.

3. **Fix only verified failures.** If the review or a test fails, make the
   smallest correction, add or update the failing regression test, rerun the
   same verification, and create one atomic commit. Do not broaden the scope.

4. **Accept the checklist.** After every check passes, merge
   `codex/spec-roadmap-r2-learnings` into `codex/spec-01-remediation-r2`. Mark A3,
   A4, and the Redis identity/outcome race proof complete in
   `specs/SPEC_01_REVIEW_FINDINGS.md`, then commit that acceptance update.

5. **Merge the implementation.** Merge `codex/spec-01-remediation-r2` into
   `codex/spec-01-independent-workspaces`. Rerun the Spec 1 local phase gate and
   fix only merge regressions.

6. **Push and stop.** Push the updated branches and report the final commit
   hashes and verification results. Do not deploy, run live Photon/SEC/provider
   tests, or continue into another remediation phase.

## Important boundary

This handoff finishes and integrates **Pass A only**. Later Pass B/C and R3-R6
items remain tracked in the specifications and are not part of this task.
