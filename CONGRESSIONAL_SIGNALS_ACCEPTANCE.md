# Congressional Signals release acceptance

Status: **not ready for production activation**. Reliability fixes are complete;
the exact legacy filing still fails real-model acceptance. No production deploy,
monitor activation, cursor reset, or canonical-source write was performed by
this release-validation task. Keep the Congressional monitor paused.

## Completed

- Six validated code-review findings fixed: ordered replay and legacy migration;
  cross-parent daily/monthly accounting; midnight retention of uncertain spend;
  safely reclaimable cancelled-admission receipts; expired-claim accounting and
  fencing; and OCR completion lost-ack reconciliation.
- Signed page-number binding removes model-generated opaque citation hashes.
- Exact-PDF offline test covers 123 transactions, two distinct K transactions,
  all row values/order/duplicates, canonical projection, baseline alert
  suppression, unchanged replay, partial OCR retry, and both budget ledgers.
- Gemini 3 Flash's native minimal-thinking setting prevents its OCR output
  allowance being exhausted on reasoning. The portable setting did not do so in
  the measured request. This fixes truncation, not checkbox-reading accuracy.
- Independent evidence accepts only presentation-equivalent amount dash spacing
  and the printed K wording, `Spouse/DC Amount over $1,000,000`. Tests still reject
  different numbers, J substituted for K, missing/extra rows, and bad citations.
- Rechecked every fixture row against all five rendered source pages. Corrected
  five manual amount entries: page 1 transaction 20 D to C; page 4 transactions
  16 and 21 B to A; page 5 transaction 3 B to C and transaction 6 C to D. These
  are directly visible checked cells, not changes made to accommodate a model.
  No production fact was altered.

Review receipt: `20260830-154016-86b92cc9`, status complete, all six actionable
findings addressed. External adversarial export was blocked before transmission;
local adversarial review supplied the fallback coverage.

## Verification evidence

- Full `verify:strategies` suite passed, including headless browser checks,
  Earnings/Commentary/SEC regressions, Eve/Next build, and compiled worker tests.
  Log: `/private/tmp/congressional-finish-final-regressions-allowed.log`.
- Final focused House fixture tests, typecheck, and diff whitespace check passed
  after the native OCR setting and presentation normalization changes.
- Real five-page canary was **rejected**, with spend settled at $0.153498.
  Public-only capture: `/private/tmp/congressional-real-8221359-v13.json`.
  Haiku inserted an account heading as a transaction and misread checkbox columns.
  Default Flash OCR exhausted its allowance after only a few rows per page.
- Focused native Flash OCR completed with zero reasoning tokens. A right-half
  detail view plus the full page enabled correct page-1 transcription, but this
  view remains a temporary diagnostic, not production implementation.
- Separate Haiku, Sonnet 4.6, Flash 2.5, and Pro 3.1 attempts did not establish a
  correct independent extraction/verification pair. Pro's literal-letter test
  still shifted checked columns, proving the failure is not label conversion.
- Confirmed aggregate paid diagnostic spend: $0.724631. One timed-out page call
  has no authoritative receipt and is additionally bounded by $0.022. All calls
  are finished; reservations are not described as actual spend.

Offline fixture success is not real-model or production acceptance. The fixture
supplies independently specified expected text; it must not become production
source data or be used to patch model results.

## Remaining release gate

A grid-aware legacy-form path is needed before more full-filing paid canaries.
Use the existing bounded PDF/evidence plumbing to locate rows and checkbox cells;
retain signed provenance and independent validation. Do not weaken agreement,
hardcode this filing's transactions, change other strategies' model routes, or
increase the hard daily/monthly budgets. This is additional extraction scope and
has not been implemented or approved as a new architecture.

Then: prove all 123 real rows including both K selections, rerun regressions,
merge the isolated release branch to main, deploy its clean commit, and run one
bounded monitored production acceptance. Require durable outcome/checkpoint,
ordered continuation of the existing source frontier, no historical alerts, and
reconciled accounting. Pause the affected monitor on any failed acceptance.
