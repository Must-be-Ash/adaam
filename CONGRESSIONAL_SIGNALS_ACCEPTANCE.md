# Congressional Signals release acceptance

Status: extraction and Congressional 1.5.0 research pass isolated acceptance;
production release and monitored acceptance are still pending. The existing
production monitor remains paused. Do not treat a local capture as a deployment
receipt.

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
cleanup. Shared research U1–U4 and semantic Sprint 3 checks pass. The complete
cross-strategy/build suite (`verify:strategies`) also passes, with its offline
Redis fixture URL and local browser launch permission.

## Release safeguards

Preserve the original dirty checkout. Publish only the isolated release tree.
Confirm the exact production commit, then upgrade the existing Congressional
binding with its watchlist, schedule, source/history/checkpoints, and owner
budget intact. Keep it paused until the binding and capabilities agree. Run one
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
