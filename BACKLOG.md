# Eve backlog and parked work

Snapshot date: 2026-08-17
Application baseline: Specs 1–4A are production accepted; global workspace
dispatch, pack-managed dispatch, Photon alerts, and Congressional execution are
rolled back off.

This is the inventory of work that was explicitly postponed, remains incomplete,
or is known to be needed before Eve can satisfy the full product direction.
It is not authorization to start work. The owner chooses what comes next.

## Current status

No user-tested core path was reported broken at handoff. These were working:

- Coinbase balance requests through Eve;
- Coinbase spot-order preview and creation;
- Spectrum and text approval/denial;
- iMessage session creation, switching, isolation, and Start fresh;
- session-manager launch from natural-language requests;
- the accepted grayscale session-manager UI; and
- the merged Spec 1 polling path: workspace-bound monitors, isolated compiled
  workers, deterministic SEC findings, durable Photon alerts with Discuss and
  Manage actions, manager status/budgets, and legacy/durable rollout gating;
- the production-accepted Spec 2 strategy-pack framework and
  `IPO Filings@1.0.0` reference pack, with interactive pack surfaces on and
  scheduled/alert dispatch rolled back off;
- the production-accepted Spec 3 canonical SEC/House public-source foundation;
  and
- the production-accepted Spec 4 `Congressional Signals` House strategy,
  official roster, deterministic history/evidence policy, and verified real
  Photon alert/Discuss path, with scheduled execution and alerts rolled back
  off; and
- the production-accepted Spec 4A deterministic-first hybrid evidence
  foundation, with bounded source-global recovery and workspace semantic lanes,
  repeated real-model acceptance, and all hybrid child flags rolled back off.

The items below are product, safety, testing, and operational gaps around that
working baseline.

Priority labels:

- **Release blocker:** required before broader access or claiming live-broker
  readiness.
- **Next foundation:** required for the intended session/strategy architecture.
- **Parked:** only pursue if the owner explicitly selects it.
- **Maintenance:** bounded cleanup or documentation work.

## 1. Release blockers

### Deployment-wide owner authorization

- [x] Add one deployment-owner identity with approved Photon-principal aliases.
- [x] Enforce it across Photon sessions, workspace monitoring, workers, manager,
  and alert delivery.
- [ ] Extend the same owner boundary to Telegram, HTTP, and any remaining private
  capabilities before those channels gain workspace access.
- [x] Keep `COINBASE_ALLOWED_PRINCIPALS` as a separate Coinbase capability
  allowlist; it is not general application authorization.
- [x] Add negative Photon tests proving an authenticated but unmapped principal
  cannot access session, monitor, worker, manager, or alert state.
- [ ] Add equivalent negative tests when Telegram or HTTP receives owner-scoped
  workspace support.

Current state: Spec 1 added the fail-closed deployment-owner mapping for Photon.
Telegram and HTTP remain outside that owner-global boundary and must not gain
workspace access until they adopt it.

### Contain the Coinbase capability surface

- [ ] Disable conversions, transfers, portfolio mutations, and other
  out-of-scope Coinbase mutations by default.
- [ ] Keep native order creation and credential switching hidden behind
  application-owned workflows.
- [ ] Decide whether edit/cancel belongs in the initial live surface; if yes,
  implement its exact preview and safety protocol before enabling it.
- [ ] Make the enabled capability set explicit and testable rather than relying
  on Photon rejecting unsupported approval requests.

Current state: these tools are dynamically registered for eligible principals,
although Photon's custom approval path supports only `coinbase_create_order`.

### Reconcile uncertain financial mutations

- [ ] Add an account-wide uncertain-mutation gate.
- [ ] Reconcile against authoritative Coinbase order state.
- [ ] Define a supported operator recovery/unblock procedure.
- [ ] Ensure a different thread, channel, session, call ID, or expired TTL cannot
  bypass an unresolved mutation.
- [ ] Never treat guard expiry as proof that a broker mutation did not execute.

Current state: the Photon processing guard is Eve-session scoped, expires after
24 hours, and has no automated reconciliation.

### Complete financial execution safety

- [ ] Run an owner-authorized, read-only live Coinbase authentication smoke;
  local compatibility coverage reaches only a fake provider and must not be
  represented as proof of provider authentication.
- [ ] Bind every enabled mutation to owner, principal, workspace/session,
  generation, broker account, exact normalized action, displayed-preview hash,
  request ID, and expiry.
- [ ] Revalidate unchanged actions immediately before submission.
- [ ] Add market-order price collars and freshness checks.
- [ ] Handle partial fills, resting orders, cancellation, expiration, and
  uncertain outcomes explicitly.
- [ ] Add owner-global exposure, loss, asset, account, and concurrency limits.
- [ ] Add atomic capital reservations so concurrent sessions cannot
  over-allocate.
- [ ] Persist broker-operation audit and reconciliation records.
- [ ] Provide a paper-only reference workflow before live brokerage is enabled
  in a fresh fork.

### Photon end-to-end regression coverage

- [ ] Build a test that exercises Photon webhook ingestion, Chat SDK state,
  session routing, Eve, Redis approval state, mini-app URL generation,
  Spectrum callbacks, text replies, and final iMessage delivery.
- [ ] Cover balance requests, order preview, approve, deny, stale replies,
  duplicate webhooks, session switching, Start fresh, failure, cancellation, and
  uncertain order outcomes.
- [ ] Make clear which parts use fixtures and ensure no test can reach real
  Coinbase mutation endpoints.

Current state: model evals and lower-level verification scripts pass, but no test
covers the complete production channel.

### Correct unsupported or misleading approval UX

- [x] Remove `delete_event_trigger` from the order-shaped rich approval protocol
  and use authenticated recoverable workspace-monitor retirement.
- [ ] Add a safe Photon approval experience for paid Masterkey `run_service`
  calls if paid Masterkey is meant to work in iMessage.
- [x] Keep unsupported requests fail-closed.

Current state: workspace-monitor retirement no longer uses order copy. Paid
Masterkey approvals remain denied by the Photon approval allowlist.

### Replace placeholder HTTP authentication

- [ ] Choose and implement production HTTP authentication.
- [ ] Add owner/workspace scoping and authorization tests.
- [ ] Keep HTTP unavailable to unapproved browser users until this exists.

Current state: `agent/channels/eve.ts` still uses `placeholderAuth()`.

### Bound Coinbase stdio transport before parsing — done

- [x] Add a byte limit to the Coinbase stdio MCP transport before accepting and
  parsing the complete response.
- [x] Preserve the existing timeout and result-normalization limits.
- [x] Add oversized-response regression coverage.

Current state: done. `agent/lib/bounded-stdio-transport.ts` wraps the Coinbase
child process with an 8 MiB per-frame byte cap that aborts before an oversized
JSON-RPC frame (complete or pending) is buffered and parsed, propagating the
failure to the call's `AbortSignal`. Timeouts and post-parse normalization are
unchanged. `npm run verify:transport` covers framing round-trips and oversized
aborts and runs in `prebuild`.

## 2. Session and control-plane foundation

### Durable ingress assignment and delivery

- [x] In durable Photon mode, give each actionable message an immutable ingress
  receipt.
- [x] In durable Photon mode, record one workspace/session assignment before a
  workspace model sees it.
- [x] In durable Photon mode, serialize assignment and dispatch.
- [x] In durable Photon mode, record dispatch completion idempotently.
- [x] Quarantine uncertain model or Photon delivery rather than replaying
  blindly on the ordinary path.
- [ ] Add recovery tooling and tests for lost responses and duplicate webhooks.

### Durable session state

- [x] Add bounded per-session rehydration briefs.
- [ ] Store files and large artifacts outside model history and retrieve them on
  demand.
- [x] Persist strategy configuration, bounded briefs/findings, monitors,
  open questions, budgets, and tool permissions.
- [x] Ensure Start fresh rehydrates only durable state into a new model-history
  generation.
- [x] Keep compaction and temporary reasoning session-local.

Current state: Photon sessions now have the Spec 1 durable runtime documents and
workspace-bound monitors. Owner-private artifacts, portfolio state, strategy
packs, cross-channel workspace brokerage, and the remaining North Star layers
are still incomplete.

### Wire tool output into the durable artifact store

Goal: stop discarding results a paid provider actually delivered. The normalizer
already handles the *context* half (bounded model view, explicit retention-failure
states, accompanying-data preservation; see `MCP_ADAPTER_PATTERN.md` for the
rules). This item is the *retention* half: capture the complete artifact outside
model history and hand the model a compact internal reference.

What already exists (do not rebuild):

- `agent/lib/artifact-store.ts` on Vercel Blob, with SSRF-guarded server-side
  download (`assertPublicRemoteUrl`), manual redirect handling, magic-byte
  signature validation, a streamed 100 MB (`MAX_ARTIFACT_BYTES`) cap, and manifest
  writes. Exposes `publishRemoteMediaArtifact` (URL source), `publishTextFileArtifact`,
  `publishReportArtifact`, `artifactIdForCall(callId)` (deterministic, replay-stable
  id), and `readArtifactManifest`.
- The narrow `agent/tools/publish_{report,chart,image,audio,video,pdf,file}.ts`
  surface, `#artifact-schema`, and the `app/artifacts/` page already consume the
  store. The chart tool requires concrete numeric data; one turn-bound final
  guard rejects incomplete report requirements without retrying publication.

Key design decisions to make first:

- **Keep `normalizeMcpToolResult` pure and synchronous.** Ingestion is async I/O;
  do it in the adapter/transport layer (`masterkey-mcp.ts`, `coinbase-mcp.ts`)
  *before* the sync normalizer runs. Detect inline media / signed URLs on the raw
  `CallToolResult`, ingest to the store, rewrite the result to carry only the safe
  internal `publicUrl`, then normalize as today. Do not make the normalizer async.
- **Ordering vs. the sanitizer.** Signed URLs pass the store's SSRF guard (public
  host, HTTPS) but `assertSafeOutputUrls()` rejects them. Ingestion must run before
  the normalizer so the credential-bearing URL is consumed server-side and never
  reaches it; the sanitizer stays unchanged as the backstop.
- **Owner scoping / visibility.** The store currently writes `visibility: "public"`
  (capability-URL by unguessable id). Decide whether paid results need
  owner-scoped/authenticated retrieval before storing potentially sensitive
  provider output this way.

Phase 1 — inline + signed media (closes the Gap A/B retention half):

- [ ] Add a store entrypoint that ingests raw bytes / base64 (not only a source
  URL): e.g. `publishInlineMediaArtifact({ bytes, contentType, kind, ... })`,
  reusing the existing signature/size/manifest validation.
- [ ] In the Masterkey adapter, when a result carries inline base64 media or a
  credential-bearing output URL, ingest it (`artifactIdForCall(callId)` for
  replay-stable ids) and replace it with the internal `publicUrl` before
  normalization.
- [ ] Preserve the current explicit failure contract: if the provider delivered
  but storage fails, report a distinct "delivered but not retained" state, keep
  the provider job id, and never auto-repay/retry.
- [ ] Extend `verify:artifacts`/`verify:context` with: inline base64 stored and
  referenced; signed URL consumed server-side and replaced; storage-failure
  distinct from provider-failure; no auto-retry after storage failure.

Phase 2 — large structured results (closes the Gap D/E retention half):

- [ ] Persist the complete raw structured result (compressed JSON artifact) when
  the model view is externalized, keyed by an immutable content hash.
- [ ] Return a bounded projection that already reports counts, `fieldsOmittedNames`,
  and a `resultRef`, plus a `status` of `complete` / `externalized` / `partial`.
- [ ] Add a bounded retrieval tool (selected fields, JSON path, page, record
  range) that reads back from the stored artifact without loading the whole result.
- [ ] Tests: an omitted field is retrievable later; hashes are stable; financial
  pages never appear complete when records were externalized.

Phase 3 — transport coverage:

- [ ] Decide how oversized (>8 MiB Masterkey / >8 MiB Coinbase frame) media should
  stream directly into the store instead of aborting, within `MAX_ARTIFACT_BYTES`.

Current state: the store exists and is used by the artifact-card path, but the MCP
result path does not yet ingest inline media, signed URLs, or large structured
results into it. Rejections are currently explicit and safe, but the delivered
data is still lost.

### Default-deny capability manifests

- [x] Define the tools, data classes, mutation rights, schedules, and budgets
  available to each session/strategy pack.
- [x] Make capability changes explicit and testable.
- [x] Ensure workspace manifests can tighten shared safety limits but never loosen
  them.
- [x] Detect provider tool drift: compare the live MCP tool inventory against the
  manifest and report removed, newly discovered, and schema-changed tools rather
  than silently hiding a needed tool or exposing a changed one. New tools are
  reviewed before exposure, never auto-surfaced; mutations stay default-deny.
- [x] When a task needs an intentionally hidden or unsupported capability, report
  which capability is unavailable and why (authorization, safety policy, runtime
  restriction, or missing integration) instead of hallucinating an answer or
  claiming the provider lacks it.
- [ ] Consider compact two-stage discovery (a capability index, then load full
  tool schemas only for the selected category) if static allowlists become a
  token or coverage problem.

### Topic-change routing

- [ ] Add a bounded detector that sees only the unassigned message and session
  manifests, not session histories or tools.
- [ ] Trigger only on high-confidence mismatch.
- [ ] Hold the message outside all sessions until the owner chooses.
- [ ] Offer stay, switch, or create through a compact Spectrum card.
- [ ] Never switch silently.
- [ ] Add held-message recovery and duplicate-action tests.

The durable ingress/dispatch foundation now exists; general topic-change routing
remains parked until the owner selects it.

### Telegram session broker

- [ ] Route Telegram private chats through the same named-session control plane.
- [ ] Preserve channel-specific authentication and delivery behavior.
- [ ] Add Telegram session-isolation tests.

Current state: Telegram maps a private chat directly to one Eve continuation.

### HTTP session routing

- [ ] Require an explicit session/workspace ID for authenticated HTTP requests.
- [ ] Do not use an iMessage-style active pointer for HTTP.
- [ ] Add authorization and isolation tests.

### Session lifecycle completion

- [x] Make archive pause session-bound monitors and revoke pending
  session-bound approvals.
- [x] Define recoverable retirement semantics.
- [ ] Offer hard deletion only after product-owned retained data can actually be
  deleted and external safety records are correctly excluded.
- [ ] **Release blocker as of 2026-08-22: sessions cannot be deleted, and the
  registry is now full at 48/48 retained records.** Creation fails with
  `retained_capacity_exhausted`, so no new strategy session can be installed at
  all. Archiving frees active-selection capacity but never retained capacity,
  and each disposable acceptance workspace consumes one record permanently —
  U1 alone spent roughly forty. Add owner-authorized deletion of archived
  sessions that removes the registry record and its workspace-scoped state,
  while preserving anything required for safety or financial audit. Needed
  before fleet activation and before Sprints 3–5 create more acceptances.
- [ ] Broaden and evaluate natural-language session-manager intent detection
  without adding channel shortcuts for ordinary domain requests.

Plain-text session mutation commands are not a current requirement. The owner
explicitly chose manager-only responses for session-management requests.

### Spec 1 deferred hardening and rollout

The ordinary polling application is complete. The authoritative item-level
acceptance criteria for its deliberately deferred work now live in
[`specs/01-independent-workspace-runtimes.md`](specs/01-independent-workspace-runtimes.md#deferred-hardening--after-specs-26).
Keep these parked until Specs 2–6 are implemented unless one becomes an observed
ordinary-path failure:

- [ ] Harden exact redirect transport, fixture-bridge activation, SEC cross-field
  identity, and overlapping compiled-worker teardown.
- [ ] Add crash recovery/quarantine across alert outbox delivery, Photon
  dispatch/response receipts, Discuss context, held replies, and intercepted
  control actions.
- [ ] Reconcile expired reservations, ambiguous worker starts, pre-session
  failures, and stale brief/strategy/budget revisions.
- [ ] Add atomic archive/restore convergence, runtime log/privacy catalog
  enforcement, and a guarded public-or-pinned Eve runtime boundary.
- [ ] Complete owner-authorized deployment, real Photon alert/Discuss/manager
  acceptance, event-stream inspection, and recorded rollback evidence under
  Spec 1 Sprint 6.

- [ ] When a selected public source has a documented production push contract,
  add authenticated source-event/RSS/WebSub ingress on Spec 1 occurrence and
  Spec 3 adapter/fact contracts, including identity-bound verification, replay
  windows, rate/concurrency limits, deduplication, fallback, and rollback.

### Spec 3 deferred hardening

- [ ] Add broader public-source stale-reference, manager health-fallback, late
  subscriber lag, multi-owner key-isolation, and cross-process crash/race tests
  after an observed ordinary-path failure or before adapter generalization.
- [ ] Evaluate fixed-concurrency write/fetch tuning only with production latency
  evidence; the current document, fact, and projection work is explicitly
  bounded and remains sequential for deterministic failure behavior.
- [ ] Expand House parser hardening with CPU-adversarial PDF/ZIP fuzzing,
  broader OCR layouts, and long archive replay.
- [ ] Expose bounded public-source health through Eve's workspace inspection
  tools when interactive agent diagnosis becomes a product requirement.

### Spec 4 deferred hardening

- [ ] Automate official House source-year rollover and immutable roster refresh
  before a year boundary, including published-date, digest, vacancy, and prior
  catalog/pack preservation checks.
- [ ] Add exhaustive cross-process crash/race coverage around deferred
  projection acknowledgement, workspace outcome commits, signal correction,
  replay, and alert outbox handoff before increasing worker concurrency.
- [ ] Generalize historical rescoring only after a versioned evidence-policy
  migration contract exists; numeric scoring or historical-alpha claims require
  a separate validation plan and must not be inferred from the v1 ordinal bands.
- [ ] Treat Senate disclosures, broader OCR coverage, and price/news/
  legislation/voting/valuation evidence as separate reviewed source and policy
  extensions rather than silently widening House v1 coverage.

### Spec 4A follow-on consumers and hardening

- [x] Implement Spec 4B Earnings Call Changes as the first real transcript
  consumer of the shared workspace semantic lane, including its reviewed
  connector, strategy, schema, corpus, production smoke, and rollback.
- [x] Implement Spec 4C's different X/public-commentary connector and content
  shape after validating source viability, terms, cost, and acceptance data;
  reuse the shared job, artifact, budget, provenance, and quarantine APIs
  without widening them by default.
- [ ] Keep broader OCR layouts, parser fuzzing, long archive replay, and new
  document/content types in their owning connector specs unless an observed
  shared-layer failure justifies a bounded Spec 4A hardening change.
- [x] Keep the parent and both hybrid children off until a consumer-specific
  production smoke is owner-authorized. Spec 4B completed that smoke and
  returned the parent, both children, earnings, dispatch, and alerts to off.

### Spec 4B deferred hardening

- [ ] Add reviewed ongoing listing discovery for Microsoft, Meta, FedEx, and
  Disney before promising forward monitoring for those issuers. JPM is the only
  v1 family with an accepted bounded first-party listing feed; the other locked
  families remain explicit baseline-only or coverage-unavailable states.
- [ ] Design and evaluate a coverage-preserving long-call reduction contract
  before widening the frozen 24,000-token aggregate semantic envelope. Calls
  above it currently abstain explicitly rather than silently truncating.
- [ ] Add a deployment-wide janitor for private ephemeral earnings artifacts
  before relying on cleanup after abrupt process death. Normal success,
  failure, correction, and replay paths delete deterministically; a killed
  process can leave a blob until the same occurrence runs again.

## 3. Event-trigger work

- [x] Bind each new workspace monitor and alert reply target to an immutable
  workspace ID; retain explicit legacy-assignment compatibility.
- [x] Move workspace-runtime limits from channel-principal scope to the
  deployment owner after owner aliases exist.
- [x] Make archive/pause behavior workspace-aware.
- [x] Align workspace monitor and compatibility tool schemas with the
  store's maximum of eight combined sources.
- [x] Add deterministic monitor/runtime verification suites.
- [x] Add Redis-backed tests for leasing, budgets, retries, watermarks,
  consecutive-failure pause, expiration, and uncertain alert delivery.
- [x] Add a local schedule-test runbook; the internal runner route deliberately
  returns 404 and Eve dev does not run cron automatically.
- [x] Remove legacy trigger deletion from the order-shaped rich approval path
  and use recoverable workspace-monitor retirement for the new runtime.

### Optional production monitoring launch (owner decision)

- [ ] When continuous production monitoring is desired—not as a Spec 2 or
  Spec 3 blocker—approve the production schedules, budgets, and Photon alert
  destinations; enable `EVE_WORKSPACE_DISPATCH_ENABLED`, then the applicable
  `EVE_STRATEGY_PACK_MANAGED_DISPATCH_ENABLED`, then
  `EVE_PHOTON_WORKSPACE_ALERTS_ENABLED` in stages; verify one live run before
  leaving them enabled. Until that decision, keeping all three flags off is the
  intended safe production state.

## 4. Strategy packs and research corpus

### Strategy-pack framework

- [x] Define a versioned strategy-pack schema for thesis, instructions,
  required sources, schedules, scoring, risk defaults, outputs, and evals.
- [x] Let a session instantiate one configured pack or remain general purpose.
- [x] Keep each pack's rules separate; do not merge conflicting strategies into
  one universal prompt.
- [x] Add pack-specific evaluation fixtures and acceptance criteria.

Current state: the repository generates a deterministic owner-only catalog,
pins one authoritative binding per session, provides replay-safe create,
configure, and non-destructive remove services shared by Eve and Spectrum, and
composes exact pack snapshots into interactive and scheduled runtimes. The full
local gate and owner-authorized staged production SEC/Photon/managed-worker
acceptance passed for `IPO Filings@1.0.0`; the second production-accepted pack,
`Congressional Signals@1.3.0`, now proves the shared configuration, catalog,
worker, alert, and owner-surface abstractions. Generalized upgrades, downgrades,
and replacements remain deferred until the owner selects that product work.

### Candidate packs documented but not implemented

- [x] Spec 4B Earnings Call Changes as a versioned transcript-backed pack.
- [x] Spec 4C Inverse Cramer as a versioned public-commentary pack, with
  revocable X evidence, provider-neutral reuse, and production execution off by
  default.
- [ ] Insider-buying clusters.
- [x] Congressional trading signals — House v1 is production accepted; Senate
  or broader congressional coverage remains a separate source/policy extension.
- [ ] Social-signal arbitrage.
- [ ] Post-bankruptcy equities.
- [ ] Credit/equity dislocations.
- [ ] Buffett-style long-horizon value research.

### Move external research into the repository

- [ ] Migrate strategy documents into `docs/strategies/`.
- [ ] Migrate data-source research into `docs/data-sources/`.
- [ ] Migrate watchlists into `config/watchlists/`.
- [ ] Preserve each source document rather than flattening them together.
- [ ] Reconcile `idea/watchlist.json`, which appears to duplicate the
  congressional watchlist.

Current state: these files are referenced from `NORTH_STAR.md` but live beside
the repository, so a fresh fork does not contain them.

## 5. Data providers and shared evidence

- [ ] Decide whether to register and support Financial Datasets or remove its
  remaining product references.
- [ ] If added, implement it through the mandatory bounded adapter pattern.
- [ ] Add typed, versioned, provenance-bearing signals for intentional
  cross-session analysis.
- [ ] Include source, as-of time, producing session, schema version, and access
  classification.
- [ ] Never share private broker results or unpromoted notes through that plane.
- [ ] Define canonical entity identifiers and freshness semantics across
  providers.
- [ ] Keep large transcripts, filings, PDFs, and media in durable artifact
  storage rather than repeated model context.

### Parked optional provider work

- [ ] Evaluate Agentcash or Bazaar only when direct sources and the guarded
  Masterkey path cannot supply a required dataset.
- [ ] Keep any added x402 provider replaceable and behind the same adapter,
  approval, cost, idempotency, and context bounds.
- [ ] Do not add providers merely to expand the tool catalog.

## 6. Model routing and token efficiency

Deterministic/fast/frontier routing is complete in
`specs/04b1-adaptive-model-routing.md`. Keep only follow-on runtime and routing
ideas here.

- [ ] Add a first-class Eve runtime primitive for per-call output/time ceilings
  or cancellation immediately after a terminal tool result. Spec 4B.1 does not
  depend on it: its semantic worker uses one bounded evidence bundle read and
  completion-triggered cancellation, and the controlled production journey
  durably completed and validated. The primitive would simplify future
  multi-tool jobs.
- [ ] Add a middle/balanced model tier only if repository-owned workload evals
  demonstrate a useful quality/cost boundary beyond the initial fast/frontier
  policy.
- [ ] Add a bounded classifier for genuinely ambiguous free-form delegation
  only after typed task routing proves value; scheduled registered tasks should
  continue to route from immutable metadata without a classifier call.
- [ ] Add shadow routing, continuous model-drift evaluation, or automatic
  policy optimization only when production volume justifies the complexity.
- [ ] Consider cross-model availability fallback only after the actual served
  model and fallback chain can be durably attributed. Same-model provider
  failover remains the AI Gateway boundary in Spec 4B.1.
- [ ] Measure context size and paid-tool payload size in regression tests.
- [ ] Preserve MCP deduplication, binary rejection, output ceilings, and
  workspace-local compaction.
- [ ] Do not reintroduce blunt cumulative session token caps as the primary cost
  control.

Current state: Spec 4B.1 production-accepts a shared registered-purpose router
for no-model, fast, and frontier work. Haiku 4.5/provider-default is qualified
for bounded extraction and GPT-5.4/high is bound to the immutable Earnings
1.0.1 pack. Production routing is configured, while the hybrid and workspace
dispatch flags remain off by rollout choice. There is intentionally no linked
fast-to-frontier route chain.

## 7. Testing, CI, and observability

- [ ] Add the Photon end-to-end harness described above.
- [x] Add deterministic workspace-monitor and compiled scheduled-worker
  integration coverage.
- [x] Add tests for Photon deployment-owner authorization.
- [x] Add workspace and scheduled-worker history isolation tests.
- [ ] Add owner-private file/result isolation tests when that storage exists.
- [x] Add tests for workspace capability manifests and scheduled-tool denial.
- [ ] Add account-wide financial idempotency and reconciliation tests.
- [ ] Add strategy-pack eval suites as packs are introduced.
- [ ] Expand routed-worker eval coverage after Spec 4B.1 when new task profiles,
  modalities, or model lanes are introduced.
- [ ] Run a full application security and reliability review after the live
  capability surface is finalized and before calling the template
  live-broker-ready.
- [ ] Re-run adversarial approval/session state-machine review after any
  material routing or trading change.
- [ ] Add automated browser checks for Spectrum approval/session apps,
  including expired/stale capabilities and mobile layout.
- [ ] Decide on a standard `npm test` entry point; none exists today.
- [ ] Add CI for typecheck, build, deterministic verification, and safe
  fixture-backed evals. No `.github` workflow exists today.
- [ ] Decide whether Redis integration suites run in protected CI or remain
  manual.
- [ ] Record a production smoke-test checklist for Photon, Telegram, schedules,
  and stable mini-app URLs.
- [ ] Add bounded cost/context observations without logging message text,
  balances, financial amounts, credentials, or PII.

### Verifier drift found during U3 (2026-08-22)

Both reproduce identically on unmodified `main` and are not U3 regressions.
`tsconfig.json` excludes `scripts/`, so no typecheck catches fixture drift in
verifiers; that is the common cause of the first item and of the
already-repaired `verify:adaptive-model-routing:sprint-1` envelope
(`2c5a577`).

- [ ] `verify:agentic-durable-research:u4` asserts the latest `ipo-filings`
  version is `1.1.1`; `44d83c6` published `1.1.2` without updating it. Decide
  whether the assertion should track the latest version or pin the version the
  U4 receipt covered.
- [ ] `verify:workspace-runtime:sec-ipo-scheduled-compiled` fails with
  `getaddrinfo ENOTFOUND fixture.invalid`. The fixture expects an unresolvable
  host to fail closed locally, but the check reaches real DNS. Decide whether
  it needs an injected fetch or a network-free host assertion.
- [ ] Consider extending `tsconfig.json` `include` to `scripts/**/*.ts`, or
  adding a second project for them, so verifier fixtures fail at typecheck
  instead of at run time.

### Monitor enable-transition source admission (2026-08-22)

- [ ] `updateWorkspaceMonitor` evaluates the declared source-admission contract
  against `current.sources`, not against `input.patch.sources`. A single call
  that both changes sources and enables the monitor is therefore admitted on
  the pre-patch source set. U3 preserved this behavior deliberately rather than
  widen its diff; no caller does this today (the strategy-pack service pauses
  before reconfiguring sources). Decide whether the check should read the
  effective post-patch sources.

### Fix failing Coinbase order-approval evals

- [ ] Reconcile `evals/coinbase/order-approval.eval.ts` and
  `evals/coinbase/order-denial.eval.ts` with the current approval emission.
- [ ] First determine whether this is a stale eval or a real approval-shape
  regression on the financial path; treat it as release-relevant until proven to
  be only the eval.
- [ ] Once fixed, keep both green in `eval:coinbase` and in CI when it exists.

Current state: `npm run eval:coinbase` fails `order-approval` and `order-denial`
at the `requireInputRequest` gate (the `coinbase_preview_order` and pending
`coinbase_create_order` gates pass). The harness reports one pending request
exists but does not match the expected shape
(`optionIds: ["approve", "deny"]`, `toolName: "coinbase_create_order"`, a `$1
BTC-USD` market buy). The three `balance-language` evals pass, so tool discovery
and the read path are healthy. This is pre-existing: it reproduces identically on
`HEAD` and is unrelated to the MCP-normalizer and bounded-stdio changes. Inspect
the actual pending request's `optionIds`/`toolName`/`input` before deciding
whether to update the eval or fix the approval emission.
- [ ] If metrics are introduced, keep identifiers, principals, URLs,
  timestamps, hashes, and user data out of tags.

## 8. Documentation and operational debt

- [ ] Change README development commands to use `npm run dev`; the direct
  `npm exec -- eve dev` command skips `predev` generation on a clean clone.
- [ ] Update `README.md` to remove stale session-migration logging language.
- [ ] Clarify in `README.md` that HTTP browser auth is unfinished.
- [ ] Remove or qualify the inactive Financial Datasets claim.
- [ ] Qualify the paid Masterkey iMessage path until Photon supports its
  approval request.
- [ ] Correct claims that mini-app capability tokens themselves are one-time:
  decisions are consumed/idempotent, while manager tokens are reusable during
  their 15-minute lifetime.
- [ ] Clarify that Start fresh advances routing even when old-continuation
  cleanup is uncertain.
- [ ] Correct `.env.example` so `COINBASE_ALLOWED_PRINCIPALS` is described as a
  Coinbase capability allowlist, not Eve's general owner allowlist.
- [x] Reconcile `NORTH_STAR.md` with the implemented Spec 1 session runtime,
  monitor, alert, and manager foundation.
- [x] Remove completed Spec 1 items from its near-term sequence.
- [ ] Preserve the owner decision that current session management is mini-app
  only, despite older plain-text fallback language.
- [ ] Add a clean-fork provisioning runbook for Vercel, Photon, Vercel Connect,
  Upstash REST/TLS Redis, Telegram, FMP, SEC, and Coinbase.
- [ ] Document that `eve link` does not provision Photon/Masterkey connectors.
- [ ] Document local event-schedule testing.
- [ ] Decide whether to list optional runtime environment aliases in
  `.env.example`.
- [ ] Remove the empty/unsupported `agent/generated/` directory or otherwise
  eliminate Eve's non-blocking discovery warning.
- [ ] Record deployed commit metadata and a tested rollback procedure instead
  of relying only on an operator-observed production alias.
- [ ] Add an auditable inventory for runtime dynamic Coinbase and Masterkey
  tools, which are not fully enumerated by `.eve/agent-summary.json`.
- [x] Keep `HANDOFF.md` and this backlog updated through the Spec 1 polling
  milestone; update them again after production rollout or later specs
  changes.

## 9. Parked product expansion

These are valid future directions, not current commitments:

- [ ] Backtesting.
- [ ] Additional brokers.
- [ ] Additional asset classes.
- [ ] Specialized model workers beyond proven objective tasks.
- [ ] Richer Photon cards after core state protocols are complete.
- [ ] Replaceable paid-data integrations beyond current needs.

Explicit non-goals unless the owner changes direction:

- hosted multi-tenant service;
- custodying many customers' credentials;
- silently activating strategies or switching sessions;
- treating signal scores, alerts, model prose, or prior consent as trading
  authorization;
- loading every strategy, provider schema, or raw artifact into every model
  call;
- transfers, withdrawals, leverage, margin, or unsupported derivatives in the
  core template.

## 10. Completed decisions: do not reopen as backlog

- [x] Generic natural-language Coinbase requests go through Eve; the
  phrase-specific balance shortcut was removed intentionally.
- [x] Native iMessage polls were replaced with the Spectrum approval app.
- [x] Text approval resumes directly through the authenticated Photon bridge.
- [x] The blocking automatic session-migration control turn was removed.
- [x] Coinbase read operations are approval-free for allowlisted principals.
- [x] Coinbase spot-order creation has an exact five-minute preview and explicit
  approval.
- [x] Approval state and mutation replay protection are Redis-backed.
- [x] MCP results use shared normalization and provider-specific policy.
- [x] Public-feed triggers are dynamically created rather than preset.
- [x] iMessage has named isolated model-history sessions.
- [x] Session management uses a dedicated Spectrum mini app.
- [x] User-facing terminology is **session**.
- [x] The accepted session-manager UI is minimal charcoal/grayscale with a light
  active-session border and custom favicon.
- [x] `HANDOFF.md` is the canonical takeover prompt.

## 11. How to maintain this file

When an item is completed:

1. Check it off and add the completing commit.
2. Update `HANDOFF.md` if current behavior or a durable lesson changed.
3. Remove stale claims from `README.md` or `NORTH_STAR.md`.
4. Record the exact verification that passed.
5. Do not add speculative work unless the owner explicitly parks or requests it.
# Proposed: Public Commentary Strategy Builder

The shipped `public-commentary-tracker@1.0.0` is deliberately structured and
bounded. A future owner-authored builder could support additional reviewed
people, first-party sources, and registered policy transforms only after adding
source-contract review, sensitive-event classification, policy registration,
eval generation, and provenance-safe upgrade semantics. Do not turn the
current template into a free-form arbitrary-person/arbitrary-policy execution
surface.

# Proposed: Widen the commentary worker's family binding (found during U2, 2026-08-22)

`agent/lib/public-commentary-workspace-worker.ts` validates that a claimed
monitor is managed by one of `["inverse-cramer", "public-commentary-tracker"]`,
and types the pipeline's pack reference as that same union. This is binding
validation, not behavioral selection, so U2 retained it. It does mean a third
commentary strategy cannot be added by pack alone: the family list has to be
widened first. Replacing the list with "the managed pack resolves a public
commentary interpretation contract" would close that gap. Not blocking, no
current strategy needs it, and it touches the live monitor's hot path.

# Proposed: Move workspace-presentation selection behind a contract (found during U2, 2026-08-22)

`agent/channels/photon-workspace-app.ts` picks which workspace presentation to
read by enumerating pack IDs (`earnings-call-changes`, then `inverse-cramer` or
`public-commentary-tracker`). That is behavioral selection a presentation
contract could own, but the site spans the earnings pack too, so U2 left it for
the U5 boundary audit to classify alongside U3's migration rather than editing
one half of a shared switch.

# Proposed: retire the three dead paid ceilings on classification contracts (found 2026-08-22)

`public-commentary-impact-actionability@1.0.1` dropped its `maximumPaidCostUsd`
to zero because the job has no paid tool surface: no research lane in the worker
contract registry, `maximumPages: 0`, `maximumRows: 0`. Three sibling contracts
still declare `"0.2500"` for the same structurally impossible call:

- `createCommentarySemanticDefinition` (`public-commentary-semantics.ts`)
- `createInverseCramerSemanticDefinition`
- `createInverseCramerActionabilityDefinition`

Real and must stay: `inverse-cramer-research.ts` and `sec-ipo-semantics.ts`,
which do declare a research lane with an approved URL policy.

None is failing today. The defect only bites a pack whose source is paid and
which declares no research lane, because a research budget otherwise absorbs the
classification reservations inside the run's paid envelope. Each fix needs its
own immutable contract version plus a pack version that pins it, so this is
bookkeeping rather than a one-line change.

# Orphaned budget reservations are never released (found 2026-08-22)

A run reservation that is never reconciled — the occurrence died before the
schedule tick could finish it — stays in the workspace ledger in state
`reserved` forever. `prune()` in `agent/lib/workspace-budget-ledger.ts` keeps
`reserved` and `uncertain` records regardless of calendar month, and
`reconcileWorkspaceRunBudget` only accepts a caller that still holds the run ID,
which a dead worker does not. One such record ($1.00) exists on a workspace that
has since been deleted, so it is unreachable through any owner surface.

Harmless today: it only constrains the daily cap of its own workspace, and that
workspace is gone. It would matter for a long-lived workspace that accumulates
them, since each one permanently consumes daily and monthly paid headroom.

# Deferred: missing-outcome taxonomy after a failed session (found 2026-08-22)

`agent/schedules/event-triggers.ts` now delivers a committed outcome before
surfacing a terminal session failure. A session that fails *without* committing
still raises `workspace_worker_session_failed`, recorded as
`workspace_worker_failed`, rather than the more accurate missing-outcome code.
Left alone deliberately: `worker_outcome_missing` drives the immediate-pause
recovery path, and changing which failures pause a monitor after five
consecutive errors versus immediately does not belong inside a delivery fix.

## Pre-existing red gate: `verify:workspace-runtime:sec-ipo-scheduled-compiled`

Fails on unmodified `main` with an unhandled promise rejection:
`TypeError: fetch failed` / `getaddrinfo ENOTFOUND fixture.invalid`. The suite
reaches a deliberately unresolvable fixture host and does not catch the
rejection, so the process aborts rather than the assertion reporting.

Surfaced 2026-08-23 by the first run of the new `verify:strategies` aggregate
gate; not caused by that change, which only adds a script entry. Belongs with
the other recorded red gate (`verify:strategy-packs:acceptance`) in Sprint 8's
"repair the pre-existing red gate" item.
