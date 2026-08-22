---
title: Earnings Call Changes — make the existing strategy solid
type: fix
date: 2026-08-22
execution: code
---

# Earnings Call Changes — make the existing strategy solid

Fix the known defects in Earnings Call Changes without expanding it. Keep the
current first-party listing-contract architecture. JPMorgan stays the one
supported issuer; anyone who wants another company adds its listing contract.

**Run this after U3 completes.** It builds on U3's contract migration and edits
the same files, so do not run both at once.

## What this is not

Not a new data provider, not FMP, not automatic multi-company coverage, not a
new pack framework, and not a rewrite. Financial Datasets was evaluated and
rejected: it has no transcript endpoint at all. Do not add either provider.

## The defects

Verified in code on 2026-08-22:

1. **Long calls abstain.** The frozen aggregate semantic envelope makes a
   transcript above it abstain explicitly instead of being analyzed. Real
   transcripts are routinely that long, so the strategy mostly produces nothing
   even when its source works. This is the defect that matters most.
2. **Alerting is gated by a hardcoded phrase list.** `alertEligible` in
   `agent/lib/earnings-call-materiality.ts` requires a deterministic score to
   clear a threshold, and that score comes from `HEDGING_PHRASES` in
   `agent/lib/earnings-call-language-metrics.ts`. A real change worded
   differently is silently never alerted.
3. **Unavailable issuers look configurable.** Four of five families in
   `agent/lib/earnings-call-reviewed-source-families.ts` are
   `coverage_unavailable` (`listing_contract_not_reviewed`). An owner can select
   one and get permanent silence with no explanation.

## Sprint 1 — Analyze long calls

- [ ] Analyze a long transcript section by section and synthesize one result,
      reusing the existing section and synthesis semantic contracts rather than
      adding new ones.
- [ ] Transcript length alone must no longer cause abstention. Genuine
      ambiguity still abstains.
- [ ] Size the envelope for the real shape of the work: the shared worker
      session (64,000 input / 16,000 output) plus one semantic child per
      analyzed section, inside one occurrence. Paid ceilings unchanged.
- [ ] Preserve exact current/prior citations across sections — a synthesized
      conclusion must still cite the specific passages it came from.
- [ ] Tests: a transcript that previously abstained now produces a cited result;
      section fan-out fits the envelope; replay produces no duplicate paid calls.

## Sprint 2 — Model-judged materiality

- [ ] The frontier model decides whether the change is material. Deterministic
      language metrics are passed to it as evidence in the signed input and must
      not gate whether it runs or whether an alert is eligible.
- [ ] Keep the owner's threshold only as a post-hoc filter over the model's
      judgment, not as a precondition for reaching it.
- [ ] Preserve unchanged: correction handling, no-change behavior, replay
      safety, workspace isolation, budget nesting, and the rule that a
      no-new-facts occurrence spends nothing on frontier reasoning or research.
- [ ] Tests: a materially changed call with wording outside `HEDGING_PHRASES`
      now alerts; a cosmetic change still does not.

## Sprint 3 — Honest coverage

- [ ] Configuring an issuer whose `discoveryPolicy.state` is not `supported`
      must fail at configure time with a clear reason naming the issuer, rather
      than installing a monitor that can never produce a result.
- [ ] Surface each configured issuer's coverage state in the owner-visible
      monitor status so a silent issuer is explainable without reading code.
- [ ] Write a short `docs/adding-an-earnings-issuer.md`: what a listing contract
      is, the fields required, how JPM's is shaped, and how to verify a new one
      before enabling it. Keep it under one page.
- [ ] Ship Sprints 1–3 as one new immutable pack version. Historical versions
      and installed workspaces keep their exact contracts and digests.

## Sprint 4 — Acceptance and cleanup

- [ ] Run the Earnings gates (sprints 0–5, production-wiring, source-lifecycle,
      worker-recovery-corrections), directly affected shared-contract checks,
      workspace isolation, typecheck, Eve build, app build, `git diff --check`.
- [ ] Deploy, verify Production health, then run one bounded acceptance on a
      fresh JPM workspace. Report source reads, section handling, model
      judgment, alert or correct no-signal result, and reserved versus actual
      spend.
- [ ] Pause and archive the acceptance workspace, restore Main, remove the
      worktree, record the receipt.
- [ ] Update `BACKLOG.md`: close the long-call reduction item, keep reviewed
      listing discovery for other issuers open as owner-optional work, and
      record Financial Datasets and FMP as evaluated and deliberately not
      adopted.

## Definition of done

- A long JPM transcript is analyzed and cited instead of abandoned.
- Materiality is the model's judgment, with deterministic metrics as evidence.
- An owner cannot silently configure an issuer that can never report, and can
  see why an issuer is quiet.
- Adding a company is documented, even though it still requires a reviewed
  listing contract.
- Existing packs, workspaces, findings, and the accepted JPM evidence are
  unchanged.
- One Production acceptance is recorded and cleaned up.

## Notes for the implementer

Production is a test bed; there are no users. Pushing to `main` auto-deploys.
Two owner monitors run unattended (`Inverse Cramer Live`, `IPO Live`) — never
deploy while an occurrence is in flight, and do not reconfigure or archive them.
Another agent owns `public-commentary-*` and `photon-workspace-*`; do not touch
those files. The session registry may be full (`retained_capacity_exhausted`)
until that agent ships session deletion, which blocks the Sprint 4 acceptance
only. `verify:strategy-packs:acceptance` fails identically on unmodified `main`
(`sec_ipo_monitor_invalid`) and is a known Sprint 8 item, not a regression.
