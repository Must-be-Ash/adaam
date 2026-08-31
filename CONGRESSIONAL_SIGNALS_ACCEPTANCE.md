# Congressional Signals release acceptance

Status (2026-08-31, 20:01 UTC): **Committed baseline delivery is complete.**
The owner-enabled monitor has a durable `no_match` checkpoint, no committed
backlog, no active worker/reservation, and no current error. Historical source
coverage remains incomplete: 263 filings are queued, excluded from research and
alerts until independently validated. A natural new selected-member research
and iMessage delivery remains unproven in production; no synthetic signal or
manual test message is authorized.

## Current finish-line verification

The real August 31 12:43 America/Vancouver occurrence and automatic continuation
finished the final two baseline batches. Both durable outcomes and both ledgers
prove zero model tokens and **$0 actual spend** for those runs. Subscription
acknowledgement revision 9 points to the last committed acquisition, source
revision remains 13, and the initial baseline remains frozen through revision
12. The 500-entry bounded history view contains no live or alert-eligible rows.
Its size is not a total filing or canonical-fact count.

The saved owner settings are 32 scheduled runs/day and daily 12:43
America/Vancouver, with the existing $1/call, $2/day and $8/month limits.
This task does not change those settings, the watchlist, source cursor, pending
queue, baseline, model routes, workspace binding, or delivery subscription.
The next saved occurrence is September 1 at 12:43 Vancouver.

The finish-line patch corrects three verified defects:

- Source health follows the committed House journal instead of subtracting an
  acknowledgement count from an unrelated source revision. The current source
  reports `caught_up`, lag 0, while extraction remains `degraded`. Regression
  coverage includes a migrated sequence starting at revision 4 and empty
  no-change batches. Missing sequence metadata reports unavailable; source and
  workspace storage are not mutated by inspection.
- Manager and chat budget inputs share the backend's existing 1–144 run schema.
  Invalid/cancelled manager entries are handled before submission. This changes
  input consistency, not any saved budget or deployment safety ceiling.
  Usage labels explicitly include reservations and unresolved costs rather than
  presenting the whole amount as money already paid.
- Research-worker capability discovery uses the same session authorization
  resolver as execution. An expired initiator no longer hides completion when
  a valid stored/current capability exists. Expired-only and conflicting-job
  sessions remain denied; privileged operations still check the durable claim.

### Audit of the older review

The older review's nineteen actionable findings were checked against the release
code and owning fixtures, not counted as current defects:

| Prior findings | Current implementation and verification |
| --- | --- |
| 1, 7, 8, 9, 20 | Frozen per-subscription baseline and per-filing first observation; complete-filing projection, durable pending queue, fair retry/new-work selection and unchanged-archive fast path. House acquisition and Congressional Sprint 5 exercise partial progress, late recovery, replay, and ordered delivery. |
| 3, 4, 5, 18 | Scoped durable recovery receipts are exposed by workspace status. Accepted finalization is replayable; completed candidates resume validation; expired claims become uncertain; operational failures do not quarantine valid evidence. Hybrid Sprints 1–2 cover replay and settlement. |
| 10, 11, 12, 14, 16 | Execution attempts own workspace/global receipts, cancelled admissions are repairable, released global reservations cannot be reused, extraction and OCR models are allowlisted, and aggregate OCR admission precedes dispatch. Unknown costs retain conservative allowances. |
| 13, 17 | Canonical amount ranges support open-ended J/K; OCR explicitly preserves capital-gains evidence. The digest-pinned 123-row public capture and canonical replay remain covered. |
| 2, 15, 19 | Parameterized Earnings source families receive recovery budgets; local denial leaves source-global work reusable; preparation is inside reservation cleanup. Existing shared recovery fixtures cover these paths; no new Earnings feature is introduced. |

The residual timing concern is no longer 270s extraction plus OCR: extraction is
bounded at 150s, OCR at 60s/page with concurrency four, so eight pages require at
most two model-call waves (270s combined). This leaves model-call headroom, not a
promise that every storage/provider operation finishes within 300s. Production
House forces independent OCR even when embedded text exists. Admission and
accepted-result schemas accommodate 580,000 input / 52,000 output tokens without
raising limits; boundary fixtures reject overflow. The remaining stale-session
discovery defect is addressed by this patch.

### Release checks

The 43 non-browser strategy/follow-up checks and 17 focused source, budget,
research and isolation checks passed. TypeScript, production build and diff
checks passed. Code review `20260831-131639-b464a5af` completed with no P0/P1;
its one P2 missing-sequence finding was fixed and verified red/green, with no
unapplied findings. Browser interaction was excluded by owner instruction.
Post-deployment acceptance uses the authenticated manager response and served
page, plus exact comparisons of the saved owner documents and operational state.

### Accounting limits and retained uncertainty

The earlier interrupted August 31 acquisition has two reconciled child receipts:
$0.036764 + $0.017945 = **$0.054709**. Its parent still carries a **$1 uncertain
allowance**, so the dashboard's $1 daily usage must not be described as a known
$1 provider charge. An August 28 model attempt has no durable usage receipt and
retains another $1 uncertainty allowance. No evidence justifies zeroing those
records; no counters, allowances, or budgets were reset for acceptance. Old
leased occurrence records are historical records, not proof of active leases.
No new paid call is required to validate this reporting/authentication patch.

A live material filing may legitimately trigger research and an alert during
normal monitoring. Its outcome, artifact, isolated delivery, and actual-cost
receipts must be evaluated then. Historical fixtures and a no-match baseline do
not prove that unobserved production branch. Over-limit and ambiguous documents
remain explicit coverage gaps; this release does not promise every PDF format.

## Historical checkpoints (superseded operational state)

The following records preserve prior acceptance evidence. Their paused monitor,
twenty-run allowance, old schedule and remaining-baseline counts are historical;
use the current checkpoint above for operating state.

Status (2026-08-31, 19:08 UTC): The fixes are deployed and seven production
batches have completed successfully. The monitor is safely paused at the
unchanged daily limit of twenty attempts, with two committed batches still
undelivered. Congressional 1.5.0 and the owner's existing binding remain active.
Full baseline acceptance and normal monitoring are **not yet complete**.

## Latest production checkpoint

PR #20 shipped independent filing progress; PR #21 fixed scheduled continuation.
The app alias was verified on production commit
`2c67193dae352c069eca134f5ce34f8de60c0ffe` before the final bounded run.

One initial batch and six resumed batches completed, including automatic
scheduled continuations and a historical filing from a watched member. All
seven outcomes are durably `source_pending`, with no finding. Every new parent
reservation reconciled to **$0 actual spend** and zero model tokens; no active
or unreconciled reservation remains from acceptance. A $1 admission ceiling
per parent was a reservation limit, not a charge.

The subscription acknowledged delivery revision 7 and retains its frozen
initial baseline through source revision 12. Source revision 13 did not move;
all 263 unresolved filings remain queued. Two committed batches remain. The
current active history contains 500 baseline entries, zero live or alert-eligible
entries, and explicitly incomplete coverage. The monitor's aggregate source
checkpoint is intentionally still unset while delivery is pending; each
completed occurrence has its own durable outcome and checkpoint.

The final monitor is paused at configuration revision 94, with no next
occurrence or continuation marker. Its original daily 20:35 America/Vancouver
schedule is restored. Strategy, watchlist, capabilities, brief, and budget
documents were checked unchanged. No UI, manual test message, trade, cursor
reset, pending-work deletion, model-route change, or budget increase was used.

### Remaining acceptance

The August 31 daily allowance is exhausted (20/20), despite this acceptance
having no paid model cost. Its next calendar window begins September 1 at
00:00 America/Vancouver. Do not reset or raise the allowance to continue early.
After the normal reset, resume through the existing backend monitor and delivery
queue; do not rerun pack preparation, binding migration, or budget initialization.
Drain the two remaining committed batches, verify the final durable monitor
checkpoint and reconciled accounting, and check that historical filings remain
silent. Enable the preserved normal schedule only after acceptance passes.
Unresolved filings must remain visible coverage gaps; full-history conclusions
remain unavailable while coverage is incomplete. No automatic follow-up or
normal monitor was left running by this acceptance.

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
