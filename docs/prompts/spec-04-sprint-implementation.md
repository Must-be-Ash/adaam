# Spec 4 implementation prompt

Use this prompt in a fresh Codex task attached to the existing clean Spec 3
worktree. It starts Spec 4 without creating another worktree.

---

You own implementation of
`specs/04-congressional-signals-house.md` from its current tracked state through
its final exit gate.

## Start here

- Worktree: `/private/tmp/adaam-spec-03`
- Expected starting branch: `codex/spec-03`
- Required ancestry: Spec 4 preparation commit
  `214d2d0e9fb215b0eae9751c17908b2689d7af2d`
- Verify that the worktree is clean and contains that commit, then create and
  switch this existing worktree to `codex/spec-04` from its current HEAD. Do not
  create another worktree.
- Specs 1–2 are production-complete. Spec 3's implementation and read-only source
  smoke are complete at `9b6e01f`; its production acquisition flags remain off.
  Earlier deferred hardening is nonblocking and must not be pulled into Spec 4
  unless a measured Spec 4 gate makes a focused dependency fix necessary.
- Production public-source dispatch and Photon workspace-alert flags remain
  intentionally off. Do not change them without explicit owner authorization.
- After that one branch creation, do not create another branch, worktree, or
  implementation plan.

Read `AGENTS.md`, `HANDOFF.md`, `NORTH_STAR.md`, and the complete Spec 4 once.
Read only the relevant sections of Specs 1–3 and current code needed for the
active sprint. Before code changes, read the relevant installed Eve docs and
search the Eve registry as required by `AGENTS.md`.

`HANDOFF.md` predates the Spec 3 branch. Use the Spec 3 ledger and current code
for its implementation state; do not repeat a general Spec 3 audit.

The Spec 4 sprint ledger is authoritative. It already reflects the reviewed
product and architecture decisions; do not reopen or broadly re-review it before
working. If code reality contradicts a requirement, record the exact evidence
and make the smallest correction needed to preserve the objective.

## Working rules

- Work on one sprint at a time and follow the ledger in order.
- Start with Sprint 0 only. Its real-PTR extraction coverage gate is intentionally
  first because Spec 3's latest live sample was an unsupported image-only PDF.
- A live public-source sample requires explicit owner authorization. Ask once at
  that boundary; do not perform live reads merely because this prompt exists.
- If the viability gate fails, stop. Report the measured result and the smallest
  focused Spec 3 extraction extension required. Do not build strategy logic on
  an empty or unreliable transaction stream.
- Keep the source/fact plane and strategy channel-neutral. Photon is only the
  existing delivery adapter.
- Reuse Specs 1–3. Do not build another source client, scheduler, monitor store,
  pack lifecycle, alert outbox, session router, or authorization path.
- Do not add numeric scoring, subjective member tiers, research-watchlist claims,
  market/news/legislation factors, Senate coverage, generalized rescoring, broker
  capability, or deferred hardening.
- Use the exact ordinal policy and uncertainty rules in the spec. Models may
  explain validated records but may not author evidence, bands, identities,
  mappings, or public-person alert prose.
- Preserve unrelated user changes. Do not push, merge, deploy, enable flags, send
  messages, use paid services, or mutate production without explicit owner
  authorization.

## End of each sprint

1. Run the focused tests required by that sprint.
2. Run typecheck and the affected Eve/application build when production code
   changed.
3. Mark only genuinely completed Spec 4 checklist items and add concise evidence
   where it prevents later re-investigation.
4. Commit that sprint on `codex/spec-04` with a clear Spec 4 subject.
5. Report:
   - commit and changed files;
   - checklist items completed;
   - verification run;
   - deferred/nonblocking items;
   - the exact next sprint; and
   - whether owner authorization is required.
6. Stop and ask whether to continue.

Do not request or perform an independent review after each sprint. Sprint 5 has
one independent diff-scoped review, one broad regression pass, and the controlled
production acceptance.

Begin now with Sprint 0. First inspect the existing House extraction and
projection fixtures, then ask for authorization before the bounded live PTR
sample if it has not already been captured and reviewed.
