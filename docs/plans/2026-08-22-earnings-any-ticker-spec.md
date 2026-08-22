---
title: Earnings Call Changes — any ticker, owner-defined watchlist
type: feat
date: 2026-08-22
execution: code
---

# Earnings Call Changes — any ticker

Make the Earnings strategy work for any company the owner names, monitored
together in one workspace, with materiality judged by the model rather than a
hardcoded phrase score.

## The problem

Three defects, all verified in code on 2026-08-22:

1. **Only JPMorgan works.** `agent/lib/earnings-call-reviewed-source-families.ts`
   defines each issuer by a hand-written investor-relations URL regex, a bespoke
   payload parser (`jpm_quarterly_earnings_json_v1`), and hand-curated baseline
   URLs. Four of five families are `coverage_unavailable` with reason
   `listing_contract_not_reviewed`. Adding a company means writing a new scraper
   for its IR site, which does not scale and breaks whenever a site changes.
2. **Alerting is gated by a hardcoded phrase list.** `alertEligible` requires the
   deterministic score in `agent/lib/earnings-call-materiality.ts` to clear a
   threshold, and that score is built from `HEDGING_PHRASES` in
   `agent/lib/earnings-call-language-metrics.ts`. A genuinely material change
   that uses different wording is silently not alerted.
3. **Long calls abstain.** The frozen aggregate semantic envelope causes calls
   above it to abstain explicitly rather than be analyzed. Most real transcripts
   are long, so this would be the common case once discovery works.

## Target behavior

- The owner names up to 10 tickers in one Earnings workspace. No per-company
  code, no new source contract, no separate pack per company.
- Eve discovers each ticker's available transcripts and compares the newest
  against the prior one.
- The frontier model judges whether the change matters. Deterministic language
  metrics are given to it as evidence, never as a gate.
- A long transcript is analyzed section by section and synthesized, not
  abandoned.

## Source decision

Use **FMP**, already connected with a production key
(`agent/connections/fmp.ts`):

- `/stable/earning-call-transcript-dates` — discovery for any ticker
- `/stable/earning-call-transcript` — one transcript by ticker, year, quarter

Financial Datasets was evaluated and rejected for this purpose: its
`/earnings` endpoint returns an EPS/revenue snapshot and the API has no
transcript endpoint at all. It remains a candidate later as *supplementary*
evidence (reported numbers alongside the language read), which is out of scope
here.

## Scope boundaries

**In scope:** one FMP-backed transcript source adapter keyed by ticker; an
owner-editable watchlist of up to 10 tickers; model-judged materiality; section
-wise handling of long calls; one new immutable pack version; one Production
acceptance.

**Out of scope:** other strategies, the Public Commentary Tracker or session
deletion (another agent owns those), new channels, trading, Financial Datasets
integration, historical backfill beyond the prior call needed for comparison,
and any change to Inverse Cramer or IPO.

## Sprint 1 — FMP transcript source

- [ ] Add a reviewed FMP transcript source contract and adapter: bounded
      requests, allowlisted origin, explicit timeout and byte caps, normalized
      canonical facts, provenance, and an idempotent acquisition journal entry,
      following the existing public-source adapter pattern.
- [ ] Discovery is `transcript-dates` by ticker; the artifact is one transcript
      by ticker/year/quarter. No per-issuer regex, parser, or baseline anywhere.
- [ ] Retire `earnings-call-reviewed-source-families.ts` as the coverage
      authority. Keep the accepted JPM evidence and any stored facts intact; do
      not delete durable records.
- [ ] Handle the ordinary failure modes explicitly: ticker not covered by FMP,
      only one transcript available (no prior to compare), provider error, and
      rate limiting. Each returns a distinct reason code, never a fabricated
      comparison.
- [ ] Focused tests for each of those paths plus replay safety. Typecheck, Eve
      build, app build.

## Sprint 2 — Owner watchlist

- [ ] Replace the locked issuer configuration with a `tickers` list, 1 to 10
      entries, owner-editable after install.
- [ ] Validate tickers against FMP's available-ticker list at configure time and
      reject unknown symbols with a clear reason. Configuration must not accept
      a ticker that can never produce a transcript.
- [ ] One occurrence evaluates every configured ticker that has a new transcript
      since its own durable checkpoint. Each ticker keeps an independent cursor,
      so one failure cannot block the others.
- [ ] Size the per-run envelope for real fan-out: earnings cluster, so several
      tickers can report in one window. The envelope must exceed the shared
      worker session (64,000 input / 16,000 output) plus one semantic child per
      evaluated ticker. Paid ceilings unchanged.
- [ ] Tests: 10-ticker fan-out inside the envelope, per-ticker cursor isolation,
      one failing ticker does not fail the occurrence, no duplicate paid calls on
      replay.

## Sprint 3 — Model-judged materiality and long calls

- [ ] The frontier model decides materiality. Deterministic language metrics are
      passed to it as evidence in the signed input; they must not gate whether it
      runs or whether an alert is eligible.
- [ ] Keep `selectedSymbols`-style deterministic filtering and the owner's
      threshold only as post-hoc alert filters over the model's judgment.
- [ ] Analyze long transcripts section by section and synthesize one result,
      reusing the existing section and synthesis semantic contracts rather than
      adding new ones. Abstention remains available for genuinely unclear cases,
      but transcript length alone must no longer cause it.
- [ ] Preserve unchanged: exact current/prior citations, correction handling,
      no-change behavior, replay safety, workspace isolation, budget nesting,
      and the rule that a no-new-facts occurrence spends nothing on frontier
      reasoning or research.
- [ ] Ship as a new immutable pack version. Historical versions and any installed
      workspace keep their exact contracts and digests.

## Sprint 4 — Acceptance and cleanup

- [ ] Run the Earnings gates (sprints 0–5, production-wiring, source-lifecycle,
      worker-recovery-corrections), directly affected shared-contract checks,
      workspace isolation, typecheck, Eve build, app build, `git diff --check`.
- [ ] Deploy, verify Production health, then run one bounded acceptance on a
      fresh workspace with a real multi-ticker watchlist. Report source reads,
      per-ticker outcome, model judgment, alert or correct no-signal result, and
      reserved versus actual spend.
- [ ] Pause and archive the acceptance workspace, restore Main, remove the
      worktree, and record the receipt.
- [ ] Update `BACKLOG.md`: close the "reviewed ongoing listing discovery" and
      "long-call reduction" items, and record Financial Datasets as evaluated and
      deferred for supplementary numeric evidence.

## Definition of done

- An owner can name up to 10 tickers in one workspace and Eve compares each
  one's newest earnings call against its prior call.
- Adding a company requires no code, no new source contract, and no new pack.
- Materiality is the model's judgment, with deterministic metrics as evidence.
- Long transcripts are analyzed rather than abandoned.
- Existing packs, workspaces, findings, and the JPM evidence are unchanged.
- One Production acceptance is recorded and cleaned up.

## Notes for the implementer

Production is a test bed; there are no users. Pushing to `main` auto-deploys.
Two owner monitors run unattended (`Inverse Cramer Live`, `IPO Live`) — never
deploy while an occurrence is in flight, and do not reconfigure them. Another
agent owns `public-commentary-*` and `photon-workspace-*`; do not touch those
files. The session registry may be full (`retained_capacity_exhausted`) until
that agent ships session deletion, which blocks the Sprint 4 acceptance only.
`verify:strategy-packs:acceptance` fails identically on unmodified `main`
(`sec_ipo_monitor_invalid`) and is a known Sprint 8 item, not a regression.
