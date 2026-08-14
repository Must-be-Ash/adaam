# Eve handoff

Use this as the starting prompt for a new agent taking over the repository.
It is a snapshot and a distillation of prior work, not a substitute for reading
the code.

Snapshot date: 2026-08-13

Repository branch: `main`

Production alias: <https://adaam.vercel.app>

Production tracks Git-backed `main`. Run `vercel inspect adaam.vercel.app` for
the current immutable deployment ID.

That deployment includes the combined Masterkey/Photon work, MCP
normalizer and bounded-stdio fixes, the public artifact publisher, the Blob-backed
artifact route, and the crypto-research skill. Do not assume production is
identical to the current checkout; verify the deployment ID and branch before
changing production.

The public artifact foundation and the in-context normalizer fixes now exist, but
automatic MCP-result ingestion and owner-private artifact storage do not; that
remaining work is scoped under "Wire tool output into the durable artifact store"
in `BACKLOG.md`, and `MCP_ADAPTER_PATTERN.md` is the guide for how MCP output must
be handled. Preserve existing work and inspect it before staging, deleting, or
committing anything.

## Instructions to the receiving agent

You are taking over Eve. Before changing anything:

1. Run `git status --short --branch` and `git log -10 --oneline`.
2. Read this file, `README.md`, and the files listed under **Code map**.
3. Read the relevant installed Eve documentation under `node_modules/eve/docs/`.
4. Verify any claim that matters against current code. Code defines current
   behavior; `NORTH_STAR.md` contains target architecture as well as current
   notes.
5. Run `npm run typecheck` and, for substantive changes, `npm run build`.
6. Do not begin work from the gaps listed below unless the owner asks.

The x402 research retest succeeded. The generic public artifact foundation also
passed its real iMessage smoke test using the natural prompt “Make me a short
public report about Bitcoin and send me a link I can open.” Eve inferred
`publish_artifact`, returned a standalone internal URL, and Photon delivered the
mini-app card. The resulting artifact is
<https://adaam.vercel.app/artifacts/78b6dbde54050a8d04d5d6f923e3eb4a>.

The owner does not need to say “public,” name `publish_artifact`, provide a host,
or choose a format. Public-data reports default to public shareable Eve URLs.
Private portfolio/account/personal data remains excluded because owner-private
artifact delivery is not implemented.

## How to work with the owner

The owner values hardening, but only after the intended core behavior has been
confirmed. Follow this order:

1. Confirm the product requirement and upstream integration semantics. If
   anything material is uncertain, ask the owner before designing a fix.
2. Reproduce the exact user-visible failure and identify the first failing
   layer. Separate the root failure from downstream fallback/error copy.
3. Implement the smallest change that restores the intended complete path.
4. Run focused local tests and type-checking.
5. When the owner authorizes production testing, deploy and ask for one exact
   end-to-end prompt through the real channel.
6. Only after that path works should you broaden tests, harden adjacent paths,
   refactor, or run specialist/subagent reviews.

Do not use multiple subagents or broad reviews to compensate for an unresolved
requirement. A thoroughly reviewed implementation of the wrong behavior is
still wrong. Explain changed assumptions promptly, and ask before expanding
scope beyond the current failing path.

## What we are building

Eve is a forkable, single-owner personal investment-agent template. It began as
an earnings-call research agent and is intended to provide reusable plumbing for
research, data access, dynamic monitoring, isolated chat sessions, evaluations,
and safely approved trading.

The primary interface is iMessage through Photon. HTTP and Telegram also exist,
but the richer session and approval UX is currently centered on iMessage.

The product priorities established so far are:

- get the complete user-visible path working before adding broad abstractions;
- verify core behavior in the real channel before adjacent hardening;
- isolate unrelated conversations;
- require exact human approval for financial mutations;
- keep model context and paid-tool responses bounded;
- use simple iMessage-native controls rather than slash commands;
- prefer direct authoritative sources, using Masterkey/x402 as fallback;
- let the owner create monitoring rules dynamically rather than shipping preset
  alerts.

This is designed as a one-owner deployment, not a hosted multi-tenant service.
That is the product target; a general deployment-wide owner allowlist is not yet
implemented. Coinbase has its own separate principal allowlist.

## Current working baseline

Across prior deployments, the owner tested these paths successfully:

- natural-language Coinbase balance requests through Eve's normal tool path;
- Coinbase spot-order preview and creation;
- order approval through the Spectrum mini app;
- order approval and denial through one-word text replies on the pre-0.33
  deployment;
- natural-language requests opening the session manager;
- creating, selecting, renaming, archiving, restoring, and starting sessions
  fresh;
- isolated context between named iMessage sessions;
- session-labeled iMessage replies.

Useful historical checkpoints:

- `working-photon-miniapp-2026-08-11`
- `working-photon-approvals-2026-08-11`

These tags predate the latest session-routing work. Use them for diagnosis, not
as a blanket rollback target.

Current production evidence from 2026-08-13:

- the primary iMessage identity received a fresh Eve response after recovery;
- a Coinbase order was placed successfully through the recovered session;
- the same x402/Coinbase research prompt was rerun after the policy fix;
- its turn completed normally and returned to `session.waiting` without an Eve
  approval pause;
- four `masterkey-x402__run_service` actions succeeded and two later calls
  failed at Eve's signed-output-URL sanitizer, but the agent recovered;
- the owner received the complete answer and a public report at
  <https://hype-recovery-analysis-2026.miniup.app/>, which returns HTTP 200.

Do not treat the historical text-denial result as current 0.33 verification.
Eve 0.32 changed a negative tool-approval response from `deny` to `cancel`;
current Photon delivery code still needs a separately scoped verification and,
if reproduced, a targeted compatibility fix.

## 2026-08-13 incident and active verification

Adding the second owner phone identity did not itself break Eve. The required
redeploy activated accumulated repository changes that had not been exercised
against the existing production conversation:

1. The old iMessage session had been created on Eve 0.31.3, while the public
   quickstart commit upgraded the deployed app to Eve 0.33.0. That durable run
   stopped processing new messages. It was cancelled and replaced with the
   isolated `Recovery` session.
2. The recovered session worked for a Coinbase order.
3. A chained research request successfully ran market-data and Masterkey
   discovery tools, then emitted `input.requested` at
   `masterkey-x402__run_service`.
4. The local wrapper—not Masterkey—was forcing every user `run_service` call
   into Eve's `user-approval` flow. Photon did not support that approval, and
   its attempted auto-denial used an OIDC self-request that returned 401. The
   resulting `[Session: unavailable]` text was fallback noise, not the root
   failure and not a Masterkey result.
5. Production now treats user-initiated Masterkey tools as
   `not-applicable` for Eve-side approval while retaining the runtime/scheduled
   denial. Masterkey remains responsible for its own sensitive-action approval
   and spend enforcement.
6. The generation-2 `Recovery` retest completed the requested research and
   public HTML report. This confirms the minimal approval-policy fix. Do not
   reopen the routing or blanket-approval theories without new contrary
   evidence.

The earlier 6,156-character response was collapsed behind a
`[Session: Recovery]` preview because the old response path prepended a visible
session label and posted only text. The current deployment no longer prepends
session labels or asks the model to repeat routing metadata; session isolation
and the manager remain unchanged.

## User-facing UX contract

- Say **session** in user-facing copy. `workspace` is only an accepted alias and
  an internal implementation term.
- Recognized session-management requests should send only the Spectrum manager,
  with no model-written companion reply.
- Normal replies do not prepend `[Session: ...]`. Session identity remains in
  routing state and the manager; mention it in prose only when the user asks.
- A safe internal Eve artifact URL or allowlisted MiniUp URL in a completed
  response produces a Spectrum mini-app card. An explicit `ARTIFACT_URL:` line
  is converted to a standalone fallback URL before posting.
- Artifact cards accept only credential-free, query-free HTTPS URLs on the
  deployment's `/artifacts/<id>` path or on `miniup.app` and its subdomains.
  They do not render generic citations.
- **Start fresh** advances only the selected session's model-history generation.
  Old-continuation cleanup can be uncertain, so do not promise hard deletion.
- The manager UI is intentionally minimal: dark charcoal/grayscale, no blue
  accents, no active badge, no redundant Eve/logo header, and a light
  `#d8d8d8` border for the active session.
- Keep the current button layout.
- Use the supplied Eve logo only for favicon/app metadata.
- Financial approval buttons are **Approve** and **Deny**. Exact one-word text
  fallbacks accepted by the parser are `yes`/`approve` and
  `no`/`deny`/`cancel`.
- General conversational consent is not financial authorization.

## Current architecture

### Agent and channels

- `agent/agent.ts` configures `google/gemini-3.6-flash`, high reasoning, 75%
  compaction, a seven-day session timeout, and no cumulative token caps.
- `agent/channels/photon.ts` is the primary iMessage ingress and response path.
- `agent/channels/photon-workspace-app.ts` is the Spectrum session manager.
- `agent/channels/photon-approval-app.ts` is the Spectrum approval app.
- `agent/channels/eve.ts` exposes the HTTP Eve API.
- `agent/channels/telegram.ts` handles Telegram.
- `agent/schedules/event-triggers.ts` runs the one-minute trigger dispatcher.

### iMessage sessions

User-facing sessions are `PhotonWorkspace` records internally.

- The registry is stored in Redis per authenticated principal and physical
  iMessage thread.
- `Main` preserves the original physical-thread continuation.
- Additional sessions use synthetic Eve thread IDs containing workspace ID and
  generation; the adapter maps replies back to the physical iMessage thread.
- Registry mutations use revisions, mutation IDs, and atomic Redis Lua.
- An active Photon approval blocks session mutations.
- The manager capability is a 15-minute bearer token carried in the URL
  fragment.
- The live router is `agent/lib/photon-workspace-store.ts`.
- `agent/lib/photon-session-store.ts` is legacy migration code and is not used
  by live Photon routing.

The Photon project now has two registered owner phone identities. Because the
project uses shared Photon lines, each identity has its own assigned agent line
and must initiate its conversation before outbound messaging is allowed. Both
owner principals are configured for Coinbase access. Never copy their real
numbers or principal values into tracked files, logs, or test fixtures.

The Chat SDK adapter uses `concurrency: "queue"`. Normal iMessage dispatch sends
to Eve with `turnPolicy: "steer"`; approval continuations use
`turnPolicy: "queue"`. Eve 0.33 also made `steer` the framework default. There
is no evidence that queueing caused the August 13 x402 failure; that failure was
the wrapper's explicit approval policy. Do not change concurrency or turn policy
without a specific reproduced scheduling problem.

### Coinbase

- Access is limited by `COINBASE_ALLOWED_PRINCIPALS`.
- Allowlisted reads such as balances, accounts, orders, and fills do not need a
  separate approval.
- Spot-order creation requires `coinbase_preview_order`, a signed exact-order
  token that expires after five minutes, and `coinbase_create_order`.
- Execution revalidates the unchanged order, uses a deterministic client-order
  ID, and stores a Redis operation receipt.
- Photon approvals are bound to the request, exact action, principal, thread,
  Eve session, internal workspace ID, workspace generation, and expiration.
- Text approvals resume directly through the authenticated Photon bridge. Do
  not route them through an OIDC-protected self-HTTP request.
- Never automatically retry an order with an uncertain result.

The uncertain-order guard is limited: it is Eve-session scoped, expires after
24 hours, and is not account-wide broker reconciliation. There is no automated
unblock procedure. Inspect Coinbase's authoritative order state and ask the
owner before further action; do not delete Redis guards to force progress.

The dynamic Coinbase MCP surface also registers conversions, transfers,
portfolio mutations, and generic edit/cancel tools. These are outside the
approved core template. Photon's custom approval path rejects unsupported
Coinbase mutations, but they are not globally disabled. Do not describe the
repository as broadly live-trading ready.

### MCP and data access

Every MCP must follow `MCP_ADAPTER_PATTERN.md`.

- Raw MCP `CallToolResult` data must never enter model history.
- Use a curated tool surface, provider-specific normalization, shared
  `normalizeMcpToolResult()`, explicit bounds/timeouts, approval for writes, and
  regression coverage.
- Preserve exact identifiers, monetary decimal strings, timestamps, cursors,
  statuses, and provenance.
- Strip duplicate envelopes, credentials, unsafe URLs, and inline binary data.
- Inline binary is stripped, but the normalizer no longer discards an entire
  result just because auxiliary media rides along. When usable structured or
  text data is present, that data is kept and the result is annotated
  `inlineArtifactsOmitted: true`. A result is rejected only when the media is
  the sole deliverable and there is no durable URL.
- Retention failures are explicit and distinct from provider failure. When a
  paid service delivered a result Eve cannot safely keep (inline-only media, a
  credential-bearing output URL, or an over-limit transport response), the
  error states the call may have completed and been charged, and instructs the
  model not to repay or retry — recover via the provider's job or usage history.
- When context bounds drop data, the model view says what is missing:
  objects over 100 keys report `fieldsOmittedNames`, the depth cutoff names the
  depth limit, and a provider-supplied durable artifact URL is prioritized so it
  survives the budget rather than being trimmed and then rejected.
- The in-code normalizer work (preserve-accompanying-data and explicit retention
  states) is implemented, and the generic public artifact store exists. The
  missing durable half — automatic capture of an MCP response before
  normalization plus owner-private storage for outputs that cannot be made
  public — is scoped in `BACKLOG.md` under "Wire tool output into the durable
  artifact store". `MCP_ADAPTER_PATTERN.md` is the guide for the handling rules.

Masterkey is a guarded paid fallback, not the default source. FMP, SEC, supplied
files, and official public feeds should be preferred when they answer the
request.

Do not add a blanket Eve approval to `masterkey-x402__run_service`. The local
wrapper now returns `not-applicable` for Eve-side approval in a user session;
scheduled/runtime sessions remain denied and cannot use paid services.
Masterkey owns the downstream policy:

- approval pauses are action-sensitive, not price-sensitive: curated
  `needsApproval` operations, communication/ecommerce/payments-billing/social
  categories, and recipient-shaped fields can pause;
- spend limits hard-reject rather than creating a human approval prompt;
- the current owner-supplied defaults are no per-call maximum, a $50 monthly
  limit, and a $1 fallback ceiling only when price is unknown;
- a cumulative run-budget waitpoint exists only when a run explicitly opts into
  a nonzero budget.

These are upstream Masterkey semantics supplied by the owner. Recheck upstream
code or ask the owner before changing this integration. The wrapper fix is live
and the paid iMessage path is now confirmed by the generation-2 `Recovery`
retest.

That successful turn was not error-free. Two paid-service responses contained
credential-bearing output URLs, so `assertSafeOutputUrls()` rejected them after
the provider returned. Keeping those URLs out of model history is correct;
losing the delivered artifact is not. Do not weaken the sanitizer or
automatically repay/retry. The rejection message is now explicit that the paid
call may have completed and that the model must recover via the provider job or
usage history rather than repaying. The remaining safe fix is owner-scoped
artifact ingestion built on the existing `agent/lib/artifact-store.ts`, scoped in
`BACKLOG.md` under "Wire tool output into the durable artifact store" but not yet
wired into the normalizer. The same old deployment also failed `bash` and `glob` because its
just-bash template was unavailable. The current deployment built a fresh
template; runtime success still needs an ordinary live turn to confirm.

Coinbase uses a fresh credential-isolated stdio MCP process per call. Its result
is normalized before entering model history, and the stdio transport now imposes
a pre-parse byte limit. `agent/lib/bounded-stdio-transport.ts` wraps the child
process with an 8 MiB per-frame cap that aborts and surfaces
`McpResponseTooLargeError` before an oversized JSON-RPC frame is parsed or can
accumulate without bound, matching the bounded HTTP fetch used by Masterkey.
Both pending and already-newline-terminated oversized frames are covered. Spawn semantics
(environment inheritance, stdio wiring, abort teardown) are otherwise identical
to the upstream `Experimental_StdioMCPTransport`.

Financial Datasets is referenced in older prose and an OpenAPI file exists, but
there is no active Financial Datasets connection at this snapshot.

### Public artifacts

`publish_artifact` provides one generic public-data layer for reports, images,
audio, video, PDFs, and downloadable files:

- Vercel Blob is the single artifact store. Upstash Redis remains required for
  sessions, approvals, and triggers; it is not a second artifact database.
- Every artifact has a deterministic 32-character ID derived from the Eve tool
  call ID and a versioned JSON manifest under `artifacts/<id>/manifest.json`.
- Reports are typed JSON rendered by Eve's deterministic, mobile-first React
  components. The model does not write or host arbitrary HTML. Text blocks
  safely render CommonMark as a fallback (raw HTML and embedded images remain
  disabled), while tool/schema instructions tell Eve to prefer native heading,
  bullet, metric, table, and chart fields.
- Public media is fetched server-side from credential-free HTTPS, with redirect,
  DNS/private-address, content-type/signature, timeout, and 100 MB checks before
  Blob publication. Text files can be plain text, CSV, or JSON.
- The public page is `/artifacts/<id>`. Photon accepts only same-deployment
  internal artifact URLs or explicitly allowlisted MiniUp URLs for its card.
- Publication is allowed only from an authenticated user session and requires
  `publicDataOnly: true`. All manifests and media are public by design. Never put
  portfolio, account, personal, credential-bearing, signed-URL, or other private
  data in this path.
- Owner-private artifact delivery is not implemented. The normalizer also does
  not yet hand rejected inline/signed paid outputs to this store automatically.

Production deployment `dpl_J48yK7F4CZYJw21QMEZGAADUyYJK` passed the full build.
The direct publication smoke created and rendered
<https://adaam.vercel.app/artifacts/dfc28f90f63210ba10d0455a0d19eb0c>
at a 390-pixel viewport with no browser console errors. This proves Blob write,
manifest read, public routing, and report rendering; it does not prove the
iMessage tool-selection/card path.

The first iMessage artifact-smoke prompt exposed a deployment-only startup
failure in that deployment: the Eve server function tried to read Photon icon
files from `/var/task/agent/assets/photon`, but Eve/Nitro had not traced that
unsupported asset directory into the function. Every webhook returned 500
before chat initialization, so the prompt never reached Eve. Deployment
`dpl_AJXBoxYKNtGFsWfm3oNLEX92iw7o` fixes this by generating an imported
TypeScript module with embedded SVG/PNG data during `prebuild`, `predev`, and
`pretypecheck`. A production cold-start probe now initializes Photon and reaches
the expected webhook authentication rejection instead of crashing. The lost
prompt must be sent again; webhooks are not replayed automatically.

The resent natural Bitcoin prompt completed the channel smoke, but its report
input used one text block containing a full Markdown document and internal
`Recovery` session metadata. Deployment
`dpl_6Vc2Xb5bwxvMJ41dy8MRzZWg7mKq` now renders that existing artifact with safe
Markdown formatting, removes internal routing metadata and duplicate document
titles, normalizes heading levels, and instructs future tool calls to use
structured blocks. Production visual and accessibility checks passed with no
browser console errors.

### Dynamic event triggers

There are no preset alerts. Authenticated private-channel principals can create,
list, update, pause, resume, and delete rules.

Current store limits:

- minimum cadence: 15 minutes;
- maximum 10 triggers per current principal-derived owner key;
- maximum 96 aggregate runs per key per day;
- global daily budget: 500;
- maximum eight combined sources;
- 90-day trigger lifetime;
- automatic pause after five consecutive failures.

Scheduled runs use isolated runtime sessions with restricted tools, exact source
fencing, and no private chat history, user OAuth, shell/filesystem tools, or
Coinbase access.

Triggers are not yet bound to immutable iMessage session IDs. The create/update
tool schemas also accept more sources than the store; the store's combined limit
of eight is authoritative.

## Code map

Read the files relevant to the task:

- `README.md`: operator-facing setup and supported behavior.
- `NORTH_STAR.md`: product target and strategy/data-source index; some sections
  are aspirational or stale.
- `MCP_ADAPTER_PATTERN.md`: mandatory MCP rules.
- `agent/instructions.md`: Eve's model instructions.
- `agent/channels/photon.ts`: iMessage dispatch, session routing, text approval,
  and lifecycle handling.
- `agent/lib/photon-workspace.ts`: synthetic thread mapping and session intent.
- `agent/lib/photon-workspace-store.ts`: durable session registry.
- `agent/channels/photon-workspace-app.ts`: session-manager HTML/CSS/actions.
- `agent/lib/photon-approval.ts`: approval rendering and text decisions.
- `agent/lib/photon-approval-store.ts`: durable approval state machine.
- `agent/channels/photon-approval-app.ts`: approval mini app.
- `agent/lib/photon-mini-app.ts`: internal mini-app URLs plus safe public
  MiniUp artifact detection.
- `agent/lib/artifact-schema.ts`, `agent/lib/artifact-store.ts`, and
  `agent/lib/public-app-url.ts`: public artifact contracts, Blob persistence,
  guarded remote ingestion, and stable Eve URLs.
- `agent/lib/photon-app-icon.ts` and `scripts/embed-photon-assets.mjs`: embedded
  Photon app icons that do not depend on runtime filesystem tracing.
- `agent/tools/publish_artifact.ts`: authenticated public artifact tool.
- `app/artifacts/[artifactId]/`: deterministic report/media renderer.
- `agent/skills/crypto-asset-research.md`: default dossier workflow for vague
  crypto research prompts.
- `agent/lib/mcp-tool-result.ts`: shared result sanitizer.
- `agent/lib/mcp-response-limit.ts` and `agent/lib/bounded-stdio-transport.ts`:
  pre-parse transport byte bounds for HTTP (bounded fetch) and stdio.
- `agent/lib/masterkey-mcp.ts`, `agent/lib/masterkey-mcp-policy.ts`, and
  `agent/tools/masterkey_mcp.ts`: Masterkey transport, normalization and
  Eve-side exposure/approval policy.
- `agent/lib/coinbase-access.ts`, `agent/lib/coinbase-order.ts`,
  `agent/tools/coinbase_preview_order.ts`,
  `agent/tools/coinbase_create_order.ts`, and
  `agent/tools/coinbase_mcp.ts`: Coinbase.
- `agent/lib/event-trigger-store.ts` and
  `agent/tools/scheduled_tool_guard.ts`: scheduled monitoring.
- `evals/` and `scripts/verify-*.mjs`: actual regression coverage.

The generated `.eve/agent-summary.json` is useful for static routes, tools,
connections, and schedules after a build. It does not enumerate every dynamic
Coinbase or Masterkey tool.

## Durable lessons: do not repeat these failures

1. **Raw MCP output caused extreme token replay.** Duplicate envelopes and
   inline base64 drove one observed session to roughly 9.76 million input
   tokens. Keep the shared sanitizer and provider policies. Verify with
   `npm run verify:context`.
2. **Phrase-specific balance routing was a regression.** A channel-level
   balance matcher made only selected wording work. Normal research/trading
   language must go through Eve; only explicit control protocols such as session
   management and approval replies belong in channel dispatch.
3. **iMessage polls were the wrong approval UI.** Keep the Spectrum mini app and
   strict text fallback.
4. **Automatic session migration blocked ordinary requests.** Do not restore
   the old migration control turn.
5. **Passing Eve evals did not prove Photon worked.** They bypass the webhook,
   adapter, URL generation, Redis delivery, Spectrum UI, and iMessage response.
   Channel changes require channel-level smoke tests.
6. **Preview URLs opened Vercel login.** Keep mini-app origin precedence in
   `agent/lib/photon-mini-app.ts`: explicit override, then
   `VERCEL_PROJECT_PRODUCTION_URL`, then `VERCEL_URL`.
7. **OIDC self-HTTP broke text approval with 401.** Keep direct authenticated
   Photon continuation.
8. **Generic failure cannot release an uncertain order guard.** Release only
   after execution is known to have succeeded or safely failed.
9. **Delayed text could approve a newer request.** Keep activation-time checks,
   zero clock-skew grace, and stable event deduplication.
10. **UI pre-checks did not prevent Redis races.** Keep atomic Lua operations,
    registry revisions, expected generations, and mutation IDs.
11. **Hardening while the main path was broken wasted time.** Restore and test
    the smallest complete path in the real channel, preserve a checkpoint, then
    audit or expand.
12. **A configuration change can deploy unrelated accumulated code.** Adding a
    second phone identity required a redeploy that also activated the Eve 0.33
    upgrade and a new Masterkey wrapper. Compare the outgoing and incoming
    deployment before attributing a regression to the requested configuration.
13. **Do not invent upstream approval semantics.** The wrapper incorrectly
    forced every Masterkey `run_service` call into Eve approval. Confirm the
    provider contract with code, documentation, or the owner before adding an
    app-level gate.
14. **A fallback message is not necessarily the root error.** The observed
    `[Session: unavailable]` followed a failed auto-denial after the real
    `run_service` approval mistake. Trace the event stream to the first divergent
    event before designing a fix.
15. **Reviews cannot validate an unsettled requirement.** Establish intended
    behavior and prove a minimal implementation first. Use specialist or
    adversarial reviews after that, or when a confirmed high-risk change
    specifically warrants them.
16. **A successful final answer can conceal tool failures.** The recovered
    research turn completed despite sandbox, signed-URL, and fetch errors.
    Verify the event stream and error logs, not only the final bubble.
17. **Do not automatically retry a paid call after artifact ingestion fails.**
    Provider execution and Eve retention are separate outcomes. Recover from the
    original provider job/result before authorizing another charge.
18. **Public artifact publication is not private storage.** Blob URLs and Eve
    artifact pages are intentionally public. Portfolio, account, personal, and
    credential-bearing data require an owner-private design that does not exist
    yet.
19. **A structured report is data, not model-written HTML.** Keep layout,
    responsive behavior, and charts in the deterministic renderer. Extend the
    versioned schema/components when a new presentation is needed.
20. **A successful build does not prove runtime files were traced.** The first
    artifact-smoke deployment passed local and Vercel builds but every Photon
    webhook crashed on a missing icon file. Embed small required runtime assets
    in generated source (or explicitly verify function tracing), then force a
    production cold start before asking the owner to test.
21. **A structured schema does not guarantee the model uses its structure.**
    The first live report put a complete Markdown document into one text block.
    Give the model explicit plain-prose/block guidance, but also render the
    fallback safely so Markdown syntax never leaks into the public page.

## Remaining work

The natural-language iMessage report/card smoke is complete. The owner can
choose the next independently verifiable slice:

1. run one vague `research HYPE` dossier through the new
   `crypto-asset-research` skill and public report renderer;
2. smoke-test one public image, then audio/video/PDF/file presentation;
3. design owner-private artifacts for portfolio/account data; or
4. wire MCP normalization to durable capture so already-paid inline or temporary
   outputs can be recovered without another paid call.

`BACKLOG.md` is the canonical inventory of incomplete, postponed, and parked
work. It separates release blockers from foundations, maintenance, and optional
expansion. The list is context, not permission to begin a roadmap; wait for the
owner's next request.

## Verification and operation

Use Node 24, the version declared in `package.json`.

```bash
npm install
cp .env.example .env.local
npm run typecheck
npm run dev
npm run build
```

Use `npm run dev` on a clean checkout so `predev` generates the ignored embedded
Coinbase CLI and Photon icon sources. For headless development:

```bash
npm run prepare:coinbase
npm run prepare:photon
npm exec -- eve dev --no-ui
```

Focused checks:

```bash
npm run verify:context
npm run verify:transport
npm run verify:approvals
npm run verify:sessions
npm run verify:workspaces
npm run verify:artifacts
npm run verify:approvals:redis
npm run verify:workspaces:redis
npm run eval:coinbase
```

`npm run verify:transport` exercises `bounded-stdio-transport.ts`: a JSON-RPC
round-trip proves framing is preserved, and oversized frames (pending and
newline-terminated) abort before parsing. It runs in `prebuild`.

`npm run verify:context` asserts that normal user Masterkey tools have no
Eve-side approval while runtime sessions remain denied. `npm run
verify:artifacts` covers schemas, deterministic IDs, and safe internal URLs.
Production deployment `dpl_6Vc2Xb5bwxvMJ41dy8MRzZWg7mKq` passed
`verify:context`, `verify:transport`, `verify:approvals`, `verify:sessions`,
`verify:workspaces`, `verify:artifacts`, TypeScript, the Eve build, and the full
Vercel build. The real iMessage x402 retest passed, and direct production report
publication/rendering plus the natural-language internal artifact-card smoke
passed.

The Redis checks require their environment variables to be exported; they do
not load `.env.local`. Coinbase evals are local-only, fixture-backed, and make
no real Coinbase call. They test model/tool behavior, not Photon end to end.

The existing deployment also depends on project-specific Vercel Connect Photon
and Masterkey connectors plus Upstash. `eve link` does not provision those
resources for a new fork.

Before deploying, verify the local Vercel project link. Do not commit, push,
deploy, or mutate an external service unless the owner asks.

## Non-negotiable safety rules

- Never remove, bypass, or weaken an existing security control.
- Never put secrets, credentials, real principal values, or signed capabilities
  in source, logs, tests, or documentation.
- Never log message bodies, direct user PII, balances, order amounts, or full
  account/request objects.
- Never use IDs, principals, URLs, timestamps, hashes, or user data as metric
  tags.
- No financial mutation from model prose, prior consent, alerts, schedules, or
  inferred preference.
- A changed financial action requires a fresh preview and approval.
- Never automatically retry an uncertain mutation.
- Session-manager actions cannot authorize financial mutations.
- Raw MCP output cannot enter model history.

When code and this snapshot differ, inspect the change and update this handoff
with durable facts only. Do not turn it into a chronological transcript or a
speculative roadmap.
