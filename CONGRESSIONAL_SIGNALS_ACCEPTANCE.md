# Congressional Signals release acceptance

Status (2026-08-31): Congressional 1.5.0 is deployed and the owner's existing
binding is active. The monitor remains paused pending acceptance of the source
progress fixes below. Extraction and research canaries are not evidence that
the owner's scheduled monitor has reached its durable baseline.

## Source progress release

Complete, independently validated filings can proceed while unresolved filings
remain queued. Unsupported filing rows never enter strategy history or research.
Each subscription freezes its initial baseline; pending filings retain their
first observation so late historical recovery cannot generate historical alerts.
An existing live subscription migrates from its own acknowledged journal, and
previously live filing corrections retain that classification.

Committed journals drain in order before another acquisition. The existing
acknowledgement receipt pins the delivery frontier before history or research
can commit, so another workspace's acquisition cannot change an interrupted
occurrence's coverage calculation. Acknowledgement still waits for the durable
outcome. Optional gap fields are first-observation audit evidence, not retry
identity. The agent status tool exposes Congressional coverage and source health.
Research evidence explicitly limits conclusions to the filing and its revisions,
and cannot establish current holdings, first-ever activity, or complete history.

Offline worker checks cover partial progress, durable baseline, new selected
filings, silent historical recovery, two consecutive legacy corrections and a
retraction, two-workspace migration, zero-download ordered backlog delivery,
and an interrupted occurrence while the shared source advances. Coverage retry
checks include pre-upgrade receipts and changed shared queue counts. No model,
research service, production message, or trade is used by these fixtures.

The pre-release production observation found source revision 13, nine undelivered
committed batches, 263 queued filings, no strategy history/checkpoint, and zero
active budget reservations. Thirteen of the twenty daily scheduled attempts
were already used. Acceptance must respect the remaining seven attempts; it
must not reset counters, raise budgets/recovery limits, or manufacture coverage.
Leave the normal monitor paused if the bounded run cannot reach acceptance.

### Production checkpoint after the first batch

PR #20 deployed commit `3f5086d6ca59f1a547135c5c2c8f797df81f8d5e` to
production on August 31. The custom app alias was verified against that deployment.
The first scheduled batch committed a durable `source_pending` outcome and
acknowledged delivery revision 1. Its initial baseline is frozen through source
revision 12. History contains 42 active baseline transactions, zero live or
alert-eligible entries, and explicitly incomplete coverage. The source remained
at revision 13 with all 263 unresolved filings queued. Eight committed batches
remain undelivered.

The parent reserved a $1 admission ceiling and reconciled to **$0 actual spend**
and zero model tokens. No reservation remains active or unreconciled. Fourteen
of twenty daily attempts are now used. The owner watchlist, strategy, capabilities,
and budget documents were unchanged; the original daily 20:35 America/Vancouver
schedule was restored with the monitor paused.

This probe also exposed a scheduling gap: pending-source completion wrote a
near-term retry, but scheduled selection still used the original calendar.
The follow-up fix records that continuation on the existing monitor and lets
the ordinary scheduler claim it with a stable occurrence identity. Completion
returns to the owner's calendar; scheduling edits and pauses cancel the marker.
Tests now claim continuation through the real scheduler for one-time, daily,
and interval schedules, including duplicate suppression, bounded recovery,
and cancellation. This is not yet evidence of a completed production baseline.

## Verified recovery

Definition 1.0.18 recovered all 123 transactions in public House filing 8221359,
including both distinct K selections. Haiku 4.5 extracted the supported grid;
Gemini 3 Flash independently transcribed the source row strips. Exact values,
row order, duplicate rows, signed source provenance, 124 canonical facts,
complete acquisition, baseline without alerts, accounting, and replay passed.

The real attempt settled $0.185881 (201005 input / 15786 output tokens), against
an admission ceiling of $1. Its public capture and offline replay instructions
are in `scripts/fixtures/public-source-adapters/house/live-review-2026-08-30/`.
Page-4 transaction 21 is B; the earlier acceptance note incorrectly called it A.
No production fact was changed to match a fixture or model response.

The implementation rejects ambiguous/erased marks, forged crops, missing or
extra physical rows, invalid dates, and factual disagreement. Missing-page
retries preserve completed extraction/OCR work and charge only remaining work,
with uncertain spend retained conservatively. Hard daily/monthly limits remain
unchanged; the parent occurrence envelope is soft.

## Congressional 1.5.0

The new immutable pack uses the existing isolated frontier research worker.
Source acquisition and historical triage remain deterministic. Valid live
selected-member filings reach frontier materiality assessment even when a
reported ticker or catalog mapping is missing. Baseline performs no research.
The frontier can choose report-now or use shared bounded research, and its
inference/tool costs share the workspace budget.

New alerts respect the configured frontier band. Prior alerts receive factual
corrections or retractions. Corrections cover amount, owner, asset, trade date,
notification date, and filing date changes, including changes beyond the first
corrected row. An immutable pre-occurrence history snapshot preserves the prior
alert through a crash after history persistence. Corrections and retractions
use finding identities consistent with their stored facts.

Separate filing briefs become one bounded report with direct numbered sources,
uncertainty, confidence, and conditional implications. No trade capability is
granted. Semantic usage accepts six-decimal USD receipts consistently with the
shared budget ledger.

A real GPT-5.4 report-now canary assessed the validated 123-row capture and
returned a review signal with spouse ownership, range uncertainty, and delayed
disclosure caveats. It used 17339 input / 4415 output tokens and reported
$0.092581, below its $0.40362 preflight ceiling and explicit $0.50 cap. The
registered validator and report schema accepted it; offline replay also passes.
This proves the report-now model path, not a live paid-search or production
message-delivery run.

Offline checks cover baseline suppression, frontier materiality, report
publication, a crash before finding commit followed by replay without another
model call, six-decimal child reconciliation, all 224 rows of a dense filing,
source/disposition rejection, record-only abstention, and temporary evidence
cleanup. Shared research U1–U4 and semantic Sprint 3 checks pass. The cross-strategy
and build checks in `verify:strategies` pass with the offline Redis fixture URL.
The browser-only check was excluded from this source-progress release in
accordance with the owner's no-UI instruction.

## Release safeguards

Preserve the original dirty checkout. Publish only the isolated release tree.
Confirm the exact production commit and preserve the existing Congressional
1.5.0 binding, watchlist, schedule, source/history/checkpoints, and owner budget.
Keep it paused until the binding and capabilities agree. Run one
bounded production acceptance and require a durable outcome/checkpoint, ordered
source continuation, no historical alert, and reconciled accounting. Pause the
affected monitor if acceptance fails. Never reset the source frontier or use
fixture rows in production.

Vercel's local environment runner returns blank values for some protected
settings. Blank local values are not evidence that production settings are
missing and must never be written back over them.

## Diagnostic spend

The current extraction/research task has $1.267748 in confirmed reported model
costs, including the two successful canaries above. Separate failed requests
lack authoritative receipts: two full attempts were each bounded by $1 and one
early rejected request by less than $0.10. Those ceilings are exposure bounds,
not actual spend. The preceding handoff reported a separate $0.724631 confirmed
plus one unknown completion bounded by $0.022. No further extraction debugging
is needed after the successful recovery proof.
