# Spec 3 implementation prompt

Use this prompt in a fresh Codex task attached to the existing Spec 3 worktree.

---

You own implementation of
`specs/03-public-source-adapters.md` from its current tracked state through its
final exit gate.

## Start here

- Worktree: `/private/tmp/adaam-spec-03`
- Branch: `codex/spec-03`
- Base before Spec 3 work: `44128c6581296c7efebc1f8b37d783bcc407ecf2`
- Specs 1 and 2 are complete. Their deferred hardening is nonblocking and must
  not be pulled into Spec 3.
- Production dispatch and Photon workspace-alert flags remain intentionally off.
- Do not create another branch or worktree.

Read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`, and the complete Spec 3
once. Read only the relevant sections of Specs 1, 2, and 4 needed for the current
sprint. Before code changes, read the relevant installed Eve docs and search the
Eve registry as required by `AGENTS.md`.

## Existing paused WIP

The worktree contains uncommitted Sprint 0 work from an agent that used the
older, bloated Spec 3:

- `package.json`
- `scripts/verify-public-source-adapter-contracts.ts`
- `scripts/fixtures/public-source-adapters/`

Do not assume this WIP is correct or complete, and do not discard it blindly.
Begin with the first Sprint 0 checklist item: compare each change with the
revised Spec 3, retain useful SEC/House fixtures and contract work, trim work
that belongs to later sprints, and record what was reused or deferred. In
particular, the old crash/concurrency matrix and overlap fixture are not Sprint
0 requirements. The current House fixtures are synthetic seeds, not the
representative real-layout corpus required by the revised feasibility gate.

## Working rules

- Follow the Spec 3 sprint ledger in order. Work on one sprint only.
- The spec is authoritative. Do not create a second implementation plan.
- Keep the source/fact plane channel-neutral. Do not add Photon, webhook/WebSub,
  model/OCR extraction, unused generic formats, strategy scoring, or exhaustive
  hardening unless the spec explicitly brings that work into the current sprint.
- Reuse and extend completed Spec 1/2 contracts and the existing guarded source
  fetcher. Do not build parallel schedulers, catalogs, monitor stores, or HTTP
  clients.
- Make the smallest informed implementation choice that satisfies the current
  sprint. Ask only when a missing decision would materially change product scope
  or requires owner authorization.
- Preserve unrelated user changes. Do not push, merge, deploy, enable production
  flags, perform live reads, send messages, or use paid services without explicit
  authorization.

## End of each sprint

1. Run the focused tests required by that sprint.
2. Run typecheck and the affected build when production code changed.
3. Mark only genuinely completed Spec 3 checklist items and add concise
   evidence where useful.
4. Commit the sprint on `codex/spec-03`.
5. Report:
   - commit and changed files;
   - checklist items completed;
   - verification run;
   - deferred/nonblocking items;
   - the exact next sprint and whether owner authorization is needed.
6. Stop and ask whether to continue.

Do not request or perform an independent review after each sprint. Spec 3 has one
independent diff-scoped review and one broad regression pass in Sprint 5.

Start now with Sprint 0 only.
