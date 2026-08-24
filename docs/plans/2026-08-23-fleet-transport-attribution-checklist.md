# Working checklist — fleet transport & attribution unit

Living progress tracker for `docs/prompts/fleet-transport-and-attribution-unit.md`.
Engineering is owned by the implementing agent; **product decisions are escalated
to the owner** (stop, describe, ask). Updated as work proceeds.

Status key: ✅ done & verified · 🔧 in progress · ⏳ todo · ⛔ blocked on product · 🔎 needs verification

Baseline verified 2026-08-23 on `main`: 37/38 strategy suites pass, typecheck clean.
The prompt was written at `c9f4e9d`; repo is ~21 commits ahead (commentary unit,
now retired). Code is the source of truth.

---

## Item 1 — Repair the three red gates  [gates 1 & 2 ✅ green; gate 3 subscription ✅, research-harness deferred with a home]

### 1a. `verify:agentic-durable-research:u4` — version drift
- ✅ Pinned the receipt to the version U4 covered (`ipo-filings@1.1.1`), matching
  the file's exact-version design, instead of tracking a moving `listLatestModelSafe()`.
  `1.1.2` was a later funding-only bump. **Verified green.**
- ✅ Removed from `BACKLOG.md` §7.

### 1b. `verify:workspace-runtime:sec-ipo-scheduled-compiled` — ✅ DONE (was 3 layers)
- ✅ Layer 1 (DNS abort): `startHybridEvidenceWorkerTask` read the job + bound the
  session capability via default env KV (`fixture.invalid`). Fixed prod-neutrally:
  `readHybridEvidenceJob` now resolves the fixture jobs client; `sessionCapabilityStore`
  uses an in-memory map under the existing fixture-runtime gate. No unhandled rejection.
- ✅ Layer 2 (deployment URL): added `PHOTON_MINI_APP_BASE_URL` to the test env
  (alert staging builds a mini-app URL; string-only, no network).
- ✅ Layer 3 (Vercel Blob): threaded `publishReport` through the compiled fixture RPC
  (resolver + test RPC handler + in-memory fixture echoing the deterministic id),
  mirroring `fetchSource`.
- ✅ The `WorkflowRunNotFoundError` was a consequence of intentional error-path
  scenarios, not a blocker. **Gate green; `verify:strategies` 38/38, typecheck clean.**
- ✅ Removed from `BACKLOG.md` §7.
- Note: monitors here have no `managedBy`, so the research-runtime path (see 1c) is
  not exercised — this gate was bounded to storage fixtures.

### 1c. `verify:strategy-packs:acceptance` — multi-layer
- ✅ Layer 1 (subscription): injected an in-memory `alertDeliverySubscription` client
  (the real `store()` needs KV creds this offline test lacks) + a seam assertion that
  creation ensures the monitor's delivery subscription.
- ✅ PRODUCT DECISION (owner, 2026-08-23): **research-only**. Non-research pack
  versions are historical iterations, not kept alive; every pack has the research lane;
  the agent decides per-signal whether to research (IPO researches; Inverse Cramer /
  Trump-Oil do not). Captured in `GOAL.md`. `1.0.0` stays *resolvable* (u4 receipt
  anchors on it) but is not the runtime target.
- 🚧 DEFERRED (engineering call): greening the gate now means rebuilding the test's
  worker dispatch onto the research path — `resolveSecIpoResearchRuntime` needs model
  routing config, and a research pack **requires** `publicSourcePath ===
  "public_source_adapter"` (worker line 569), so the injected `fetchSource` must be
  replaced with a full public-source-adapter + research-session harness. That
  **duplicates the passing dedicated `sec-ipo` suites** (which already exercise real
  SEC evaluation + research) and **overlaps the separate signal-quality/research unit**.
  Home: Sprint 8 "repair the pre-existing red gate" (see roadmap). Two clean paths for
  whoever picks it up: (A) full research-acceptance harness, or (B) re-scope this
  framework test to a fixture worker and let the `sec-ipo` suites own worker execution.
- Note: `verify:strategy-packs:acceptance` is NOT in the `verify:strategies` aggregate,
  so it does not block the cross-strategy guard.

---

## Item 2 — Determinate HTTP status vs `acquisition_uncertain`  ✅ DONE
- ✅ VERIFIED the prompt's data-loss premise is wrong for transport failures:
  `commitPublicSourceAcquisition` refuses any result without a non-null
  `proposedNextCursor`, so a transport-stage failure never advances the cursor →
  no data loss regardless of classification. (The "cursor advances on failure"
  risk is a *post-acquisition* failure mode, not transport.)
- ✅ DECISION (engineering): a determinate *transient* status the server signals as
  retryable (429, 502/503/504) is not ambiguous — classify it as a bounded
  `retryable_failure` (retryAfterSeconds 60) so a temporary upstream hiccup recovers
  fast instead of terminalizing and waiting a full cadence. 4xx/500 and genuine
  transport exceptions stay `uncertain` (safe). Directly improves Congressional
  (item 5) resilience; mirrors the X adapter's 429 handling.
- ✅ Implemented in the House adapter via one shared `houseHttpStatusError` classifier
  used by BOTH the thrown-error path (`mappedError`) and the response-object path
  (`validateResponse`) — they can no longer drift on the same status. Added the
  `service_unavailable` shared error code (enum is passthrough-validated; no exhaustive
  switch to update).
- ✅ Red-first: the existing 503 tests asserted `uncertain`; updated them to
  `retryable_failure`/`service_unavailable`/retryAfterSeconds and added 429→rate_limit
  and 404→uncertain cases proving the transient/non-transient split.
- ✅ `verify:strategies` 38/38 before AND after; typecheck clean; adapter
  contracts/sec/runtime green.
- Note (follow-up, not a defect): sec/earnings/official-web still map all non-2xx to
  uncertain, and X handles only 429. A single shared HTTP-status classifier across all
  five adapters would remove the residual asymmetry — extra hardening, all paths are
  safe today.

## Item 3 — Capture the actual status  ✅ DONE (instrumentation confirmed)
- ✅ The instrumentation carries the number: `a631998`'s typed error + item 2's
  `houseHttpStatusError` make the bounded log detail `http_<status>` (asserted in the
  house tests) and the durable acquisition/health record carry a specific errorCode
  class (`service_unavailable`/`rate_limit_exhausted`/`acquisition_uncertain`) that
  distinguishes transient from ambiguous. No code deliverable; no occurrence spent.
- ⏳ Opportunistic: read production durable records during the item 5-6 fleet-health
  check for any recent acquisition failure and record its status number there.

## Item 4 — Cross-strategy guard enforcement  ✅ DONE
- ✅ DECISION: `verify:strategies` stays an **explicit gate, not in `prebuild`** — one
  of its 38 suites compiles the agent (`sec-ipo-scheduled-compiled`), so `prebuild`
  would compile twice per build and put a ~90s battery in the deploy critical path.
  It is the mandatory pre-deploy check + the "touch a shared module → run it" rule.
- ✅ Recorded in `docs/workspace-runtime-pitfalls.md` "Cross-strategy safety" (where
  the rule already lives and the next agent looks), with CI noted as the long-term home.

## Deploy (owner-authorized 2026-08-23)
- ✅ Committed items 1-4 to `main` (3 commits: gates, house retryable, docs) and deployed
  `vercel deploy --prod --yes`. Deployment `earnings-call-analyser-kd5vr5k2s.vercel.app`
  Ready; `adaam.vercel.app` alias confirmed (HTTP 200). No occurrence in flight at deploy.
- Registry capacity: cap 48, main registry at 25 → room to create (no `retained_capacity_exhausted`).

## Item 5 — Arm Congressional  🔧 IN PROGRESS
- ✅ Owner created "Congressional Testing" via the Manage Sessions mini-app (owner drove
  the UI; I gave exact settings). Congressional Signals 1.4.0, America/Vancouver, check
  22:55 (fire-in-5-min), "Start this schedule now" checked. Session: 1 monitor · 1 enabled
  · 0 errors. Durable store confirms: enabled, `nextOccurrenceAt 2026-08-24T05:55:00Z`
  (future), fresh (lastCompletedAt null, 0 fails). Note: Congressional's lifecycle contract
  is `initialOccurrence: "scheduled"`, so a near-now check time (not the activate checkbox)
  is what triggers the first run. "managed_monitor_missing" is a benign "never-run" fallback.
- ❌ Occurrence (05:55 UTC) FAILED at House transport → monitor auto-paused
  (`paused_failure`, lastErrorCode `worker_recovery_outcome_missing`; the underlying
  chain: `evaluate_congressional_signals` → `congressional_source_unavailable` ←
  House acquisition `transport:failed:acquisition_uncertain`). First failing stage
  recorded; did NOT retry the same occurrence.
- DIAGNOSIS (store + logs, read-only): House-specific, upstream/network, NOT my code:
  - House acquisition `complete` on 2026-08-22 19:32; every attempt since 2026-08-23
    20:07 fails `transport:failed:acquisition_uncertain` (20:07, 21:00, and mine 05:55).
  - SEC (IPO) + X (Cramer/Tracker) fetch fine from Vercel in the same window; House URL
    returns HTTP 200 (56KB) to a local curl. So it's the Vercel→House fetch specifically.
  - It's the EXCEPTION path (fetch throwing: timeout/reset/TLS), not an HTTP status, so
    item 2's retryable classification does not apply.
  - The exact cause is NOT captured anywhere retrievable: the exception path records only
    `acquisition_uncertain` durably, and no cause reaches the logs (a631998-style gap, but
    for the exception path). Fallback UA is `EarningsCallAnalyser/0.1 public-feed-monitor`.
- CONFIRMED it's NOT a UA issue (owner chose "confirm with one occurrence", 2026-08-24):
  - Local test: disclosures-clerk.house.gov serves the ZIP to EVERY UA (old bot, new
    crawler, empty, default) from a residential IP, HTTP 200 in <0.2s.
  - Deployed a WAF-friendly `Mozilla/5.0 (compatible; ...)` UA + errno-capture in the House
    exception path (`5b819ec`), then ran a 2nd occurrence ("Congressional Test 2", 06:46 UTC):
    FAILED again identically at House transport. UA change had no effect.
  - Even a prompt (~13s) log pull captured only the wrapper `congressional_source_unavailable`,
    not the House adapter's errno detail → `coordinatePublicSourceOccurrence` does not surface
    the fetch cause to the logs (diagnosability gap beyond a631998; FOLLOW-UP below).
  - CONCLUSION: a Vercel→disclosures-clerk.house.gov block/throttle (House-side, started
    ~Aug 23; SEC + X fetch fine from Vercel; House serves residential IPs fine). Not
    cheaply code-fixable; my item-2 retryable path doesn't apply (it's a fetch exception).
- Spend: 2 paid occurrences, both failed at TRANSPORT before any inference → ~$0 actual
  each ($0 paid today/month per the pack summary); reservations settle on failure handling.
- 🚧 DEFERRED (owner chose, 2026-08-24): Congressional stays archived, blocked upstream by
  the Vercel→House egress block. Homed in roadmap Sprint 7 with the full diagnosis + the
  three paths (proxy / third-party API / wait). Owner to archive the 2 test sessions so
  none stays dispatchable. Getting it running needs a proxy or the (deferred) API.
- FOLLOW-UP (give it a home): the House exception path's fetch cause (errno) never reaches
  a durable/retrievable place on the live congressional path — a631998 fixed only the
  HTTP-status path. Capturing `.cause.code` durably (not just in a console.warn that
  either isn't emitted here or rolls) would make the next such failure self-describing.

## Item 6 — Arm Earnings (U3)  🚧 DEFERRED (owner: "Congressional first")
- 🚧 Owner chose Congressional first (2026-08-24); Earnings not attempted. Its two flags
  (`EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED`, `EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED`)
  remain OFF, unconfirmed. Also note: Earnings' House-independent source is `data.sec.gov`
  (works from Vercel) — so Earnings is not blocked by the House egress issue; it's simply
  deferred pending the owner enabling its flags + a follow-up acceptance.

## Fleet hygiene (items 5–6 support)  ✅ CONFIRMED HEALTHY
- ✅ Read-only store query confirmed `IPO Live`, `Inverse Cramer Live`, `Tracker Live` all
  `enabled`, future `nextOccurrenceAt`, recent clean completions, 0 failures. No re-arming
  needed; left untouched (no reconfigure/archive).

---

## Standing rules (do not break)
- Never mint/forge a Manage Sessions capability token or URL — ask owner.
- Public repo: no tokens in files/commits/logs.
- No temporary prod endpoints; no direct Redis writes. Read-only store queries OK.
- Never deploy while an occurrence is in flight; only one prod acceptance at a time.
- Deploys are manual (`vercel deploy --prod --yes`), confirm alias with `vercel inspect`.
- Report reserved budget separately from actual spend.
- Don't spend a paid occurrence to test a code-read hypothesis — instrument first.
- Roadmap/migration receipts are append-only.

## Finish clean
- Report completed / deferred (+why) / reserved-vs-actual spend / final armed state.
- Leave no test monitor dispatchable, no temp routes, no stray worktrees.
