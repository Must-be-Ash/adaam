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

## Item 5 — Arm Congressional
- ⏳ Get one successful committing occurrence, then arm with alerts. Needs deploy +
  a paid occurrence + a Manage Sessions capability URL (owner-provided). Assert
  `nextOccurrenceAt > now` from the durable record after arming.

## Item 6 — Arm Earnings (U3)
- ⛔ Gated behind `EVE_EARNINGS_CALL_CHANGES_EXECUTION_ENABLED` and
  `EVE_EARNINGS_CALL_SOURCE_ADAPTER_ENABLED`. **Confirm flag state with owner before
  enabling anything in Production.** Then one committing occurrence, then arm.

## Fleet hygiene (items 5–6 support)
- 🔎 Confirm `Inverse Cramer Live`, `IPO Live`, `Tracker Live` still enabled/healthy
  via read-only store query; re-arm any a failed run paused (assert `nextOccurrenceAt > now`).
  Do not otherwise reconfigure/archive.

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
