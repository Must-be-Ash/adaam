# Spec 4A: Hybrid evidence and reasoning foundation

Status: In progress; Sprint 3 complete, Sprint 4 next

Date: 2026-08-16

Product target: `NORTH_STAR.md`

Dependencies:

- `specs/01-independent-workspace-runtimes.md`
- `specs/02-versioned-strategy-packs.md`
- `specs/03-public-source-adapters.md`
- `specs/04-congressional-signals-house.md`

Next consumers:

- Spec 4B: Earnings Call Changes
- Spec 4C: a second reference strategy using a different source/content shape
- `specs/05-insider-clusters.md`, revisited after Specs 4B and 4C

## Objective

Add one reusable hybrid evidence layer between source acquisition and strategy
logic. Deterministic code remains the first path for known formats. A bounded,
fresh-context model worker may recover structured evidence when a reviewed
document layout changes, or interpret meaning when the required result is
inherently semantic. Deterministic validators decide whether the result is safe
to accept or quarantine; execution failures become explicit failed or uncertain
jobs.

This foundation prevents every future strategy from building its own PDF,
spreadsheet, transcript, or semantic-analysis plumbing. It does not attempt to
support every connector or ship another full investment strategy.

## What this enables

After this spec:

1. A reviewed parser still handles familiar input without a model call.
2. A supported but changed PDF or spreadsheet layout can invoke a reviewed
   extraction job instead of immediately becoming unusable.
3. A registered job can classify bounded transcript, article, RSS, or
   social-style evidence from meaning rather than an exact keyword list once a
   reviewed connector supplies it. Spec 4A does not ship those connectors.
4. Accepted results are structured, cited, versioned, auditable, and labeled as
   model-derived; ambiguous evidence is quarantined or explicitly abstained.
5. Source-global extraction can be reused across subscribed workspaces, while
   strategy interpretation and derived signals remain isolated per workspace.

## Implementation workflow

This file is the authoritative progress ledger. The sprint checklists below are
the only completion checklist; requirements are not duplicated as checkboxes.
This workflow overrides the older per-sprint review/worktree loop in
`specs/IMPLEMENTATION_PROTOCOL.md` for Spec 4A.

Create or reuse one `codex/spec-04a-hybrid-evidence` branch and one associated
worktree from current GitHub `main`; keep them for all sprints. Do not create a
new branch/worktree per sprint.

For each sprint:

1. Read only the relevant current code and installed Eve/Next.js documentation.
2. Search the Eve registry before implementing an integration or parser.
3. Implement only the current sprint and its directly required dependency fix.
4. Run focused verification plus typecheck and the affected build when production
   code changed.
5. Mark only verified sprint items, record concise evidence, commit the sprint,
   and report the next sprint. Continue only when the owner says to continue.

Do not restart repository orientation, rewrite this spec, or run an independent
review after each sprint. Sprint 4 owns the one final independent review and
broad regression pass.

When Sprint 4's final gate is green, finish the same landing pass: mark the
verified checklist complete, move only genuinely deferred hardening to
`BACKLOG.md`, update `HANDOFF.md` and `NORTH_STAR.md` where reality changed,
commit, push the branch, open and merge the PR, and confirm the exact commit is
on GitHub `main`. Do not rerun the broad suite merely because those final
documentation and Git operations occurred; rerun only affected checks if code
changed during review, conflict resolution, or landing. The push, PR merge, and
automatic deployment caused by that authorized merge are part of this landing
pass. Manual deployments, live model/source calls, flag changes, and external
messages remain separately owner-authorized.

## Scope

### In scope

- A versioned hybrid-job definition registry for extraction recovery and
  workspace semantic interpretation.
- Durable public evidence artifacts and bounded locators for PDF pages,
  spreadsheet ranges, text spans, and existing canonical source facts.
- One idempotent job/result store with explicit accepted, quarantined, failed,
  and uncertain outcomes.
- One fresh-context Eve evidence worker using per-turn structured output and
  only the evidence tools permitted by the job definition.
- Focused extensions to the existing workspace/global budget ledgers, with
  independently keyed hybrid attempts and exact token/paid attribution.
- Source-global extraction recovery that can feed a reviewed Spec 3 fact schema
  after deterministic citation, relationship, and independent value validation.
- Workspace-scoped semantic results that can be consumed by a reviewed strategy
  pack without crossing workspace boundaries.
- Fixed low-cardinality observability, owner-visible status, and bounded error
  codes without raw source content, prompts, model output, or identifiers in
  logs.
- Deterministic local fixtures and model-backed evals proving one PDF recovery,
  one spreadsheet schema-drift recovery, and one semantic text interpretation.

### Out of scope

- General crawling, arbitrary URLs, browser automation, or production X/RSS,
  website, earnings-call, spreadsheet-upload, email, or authenticated API
  connectors; each needs a reviewed acquisition contract.
- A complete strategy; Specs 4B and 4C own the first two real consumers.
- Automatic model fallback for unregistered, oversized, unauthorized, or
  over-budget input; fine-tuning, embeddings, long-term model memory, generated
  runtime policy, and multi-model voting are also deferred.
- Owner-private evidence, paid-provider artifacts, raw provider payloads,
  chain-of-thought, or unbounded prompt/result retention.
- Cross-workspace semantic-signal promotion, broker/trade actions, performance
  claims, and exhaustive crash/race or provider optimization work.

## Architecture and ownership

```mermaid
flowchart LR
    C["Reviewed connector / Spec 3 adapter"] --> D["Deterministic parser"]
    D -->|complete| F["Validated canonical facts"]
    D -->|partial or supported-layout failure| J["Source-global extraction job"]
    C --> A["Immutable public evidence artifact"]
    A --> J
    J --> V["Schema, citation, and domain validation"]
    V -->|accepted| F
    V -->|ambiguous or invalid| Q["Quarantine"]
    F --> P["Authorized workspace projection"]
    P --> S["Workspace semantic job"]
    S --> W["Validated workspace-derived evidence"]
    W --> R["Strategy policy, finding, and alert"]
```

Ownership is deliberately split:

- Connectors and Spec 3 adapters own transport, source identity, raw response
  bounds, deterministic parsing, canonical facts, corrections, and projections.
- The hybrid evidence layer owns evidence artifacts, registered job definitions,
  isolated model execution, common result provenance, citations, validation
  state, budgets, and quarantine.
- A source adapter owns the domain validator that can promote an extraction
  candidate into its canonical fact schema.
- The application-owned hybrid registry owns semantic output schemas. A strategy
  pack references reviewed job/schema digests and owns only its deterministic
  policy for consuming accepted workspace-derived evidence.
- Spec 1 owns schedules, worker dispatch, lifecycle, workspace isolation,
  findings, alerts, and channel routing.
- Photon remains only the first alert adapter; no hybrid record contains a
  Photon principal, thread, card, or Mini App contract.

## Two processing lanes

### Lane A — source-global extraction recovery

Use this lane when a reviewed source has valid bounded evidence but its
deterministic parser returns a specifically allowlisted partial or unsupported
layout outcome.

1. Retain the exact public source artifact and digest before model execution.
2. Resolve an immutable extraction-job definition matching adapter, content
   type, source policy, and intended canonical fact schema.
3. Reuse an accepted result for the same artifact digest and job-definition
   digest. Otherwise create one durable job against the deployment source-
   recovery budget; retain the initiating workspace only as audit provenance.
4. Give the fresh worker only bounded page images/text, cell grids, or other
   locators from that artifact. Source content is untrusted data, not
   instructions.
5. Require a schema-valid candidate result with an evidence citation for every
   material field and explicit `unknown` or abstention where evidence is absent.
6. Re-read and validate cited locations, source relationships, row identities,
   numeric/date formats, and adapter-specific invariants in deterministic code.
   A material value must also agree with an independent extraction: exact
   text/cell comparison for text-bearing evidence or bounded OCR for image-only
   evidence. A page/region citation alone is not value verification.
7. Only an accepted, independently verified candidate may create immutable
   canonical fact revisions. A model-only material value remains model-derived
   evidence and cannot enter the canonical fact plane.
   Quarantined, failed, or uncertain jobs cannot advance a source cursor or
   imply a complete acquisition.
8. Accepted source-global results can be projected independently to every
   authorized subscriber without another model call.

Before deterministic output is considered complete, adapter plausibility and
source-relationship checks must detect likely false-success layouts. A
nominally schema-valid but suspicious parse becomes an explicit recovery-
eligible or quarantined outcome rather than silently bypassing this lane.

The model proposes fields; the adapter validator remains the authority that
decides whether those fields are facts.

### Lane B — workspace semantic interpretation

Use this lane when the strategy requires meaning that cannot be reduced to a
stable deterministic parser, such as whether management commentary became more
cautious or whether a public statement expresses escalation, de-escalation, or
genuine ambiguity.

1. Start only from authorized workspace projections and bounded cited public
   evidence. Do not expose another workspace's facts, findings, brief, or model
   output.
2. Resolve a reviewed semantic-job definition referenced by the active pack and
   pinned to its binding revision.
3. Require a common provenance envelope around the definition-specific output
   schema. The result names supported claims, counterevidence, uncertainty, and
   citations. An abstention is an accepted semantic result with disposition
   `abstained`; it contributes no fact, strategy factor, signal, or alert.
4. Apply deterministic citation and schema checks before committing an immutable
   workspace-derived evidence revision.
5. Let the pack's deterministic policy decide what that accepted evidence means
   for a signal or alert. The worker does not create an alert or financial
   action directly.
6. Corrections, retractions, pack revisions, job-definition revisions, or source
   digest changes create explicit new revisions and invalidate dependent results
   through lineage rather than mutating history.

Two workspaces may interpret the same canonical facts differently because their
pack versions or configurations differ. Their semantic jobs and results must
remain isolated even when they share the source-global extraction.

## Durable contracts

### Evidence artifact manifest

Each artifact records:

- immutable artifact ID, content digest, media type, byte count, and observed
  time;
- authority, canonical public source URL, source-instance/acquisition identity,
  and access classification;
- bounded structural metadata such as page, sheet, row, column, or character
  counts when known;
- storage key and retention state without exposing a credential-bearing URL to
  a model or log; and
- lineage to the deterministic parser outcome that made recovery eligible.

Use a dedicated evidence namespace and store interface backed by the existing
Blob dependency. Do not publish these inputs through `/artifacts`, create a
public report card, or reuse the user-facing artifact manifest. In Spec 4A every
artifact is independently public at its authoritative source; any non-public
classification must fail before persistence or model dispatch.

Enforce per-source daily and deployment-wide artifact count/byte quotas before
persistence. Retain artifacts referenced by accepted results, promotions, or
current correction/invalidation lineage for as long as those records remain
active. Use reviewed bounded retention for quarantined inputs and shorter
retention for orphaned/failed inputs: default 90 days for quarantine evidence
and 30 days for unreferenced failed/orphaned evidence. Garbage collection must
be reference-aware and must never delete evidence still required to audit an
accepted fact.

### Evidence locator

Every material model-derived claim cites one or more typed locators:

- `pdf_page`: artifact digest, one-based page, and a bounded text or region
  digest when available;
- `spreadsheet_range`: artifact digest, sheet identity, bounded cell range, and
  normalized-range digest;
- `text_span`: artifact digest, character range, and exact span digest; or
- `source_fact`: canonical fact revision ID and payload digest.

The validator confirms that each locator exists inside the permitted artifact
slice and that its digest matches. A URL or page number alone is provenance, not
proof of a claimed field.

### Hybrid job definition

An immutable application-owned definition records:

- job ID, semantic version, purpose (`extraction_recovery` or
  `semantic_interpretation`), and content digest;
- allowed source adapters, media types, access classifications, and triggering
  parser/error codes;
- input projection and output schema IDs/versions;
- reviewed instruction-template ID/digest and source-content delimiter policy;
- allowed model IDs, maximum input/output tokens, evidence bytes/pages/rows,
  runtime, attempts, and paid cost;
- required deterministic validator and policy versions; and
- whether accepted results are source-global or workspace-scoped.

Definitions live in code or an immutable reviewed registry. Pack manifests
reference IDs and digests; owner configuration can disable or tighten them but
cannot author instructions or loosen limits.

### Hybrid job and result

The durable job binds the definition digest, artifact and locator digests,
source or workspace scope, pack/binding revision where applicable, initiating
workspace provenance, budget scope/reservation, model ID, and deterministic
idempotency key.

The ordinary lifecycle is:

```text
prepared -> running -> completed -> accepted
                               \-> quarantined
                    \-> failed
                    \-> uncertain
```

- `accepted` means both the model output schema and every deterministic
  validator passed.
- `quarantined` preserves a bounded structured candidate and reason codes for
  inspection but exposes no fact or strategy contribution.
- `failed` is known not to have produced an accepted provider result.
- `uncertain` means execution may have started or completed but cannot be safely
  replayed. It is never blindly retried or charged again.
- `prepared`, `running`, and `completed` are nonterminal. Repeated preparation
  returns the existing job; `completed` resumes deterministic validation without
  redispatching the model. Terminal results are `accepted`, `quarantined`,
  `failed`, and `uncertain`.

The accepted result stores the common provenance envelope, definition-specific
structured payload, citations, confidence/coverage fields required by that
definition, validation trace, token/cost usage, and input/output digests. Do not
store chain-of-thought. Logs and ordinary manager summaries never contain the
source text, prompt, candidate payload, provider response, or raw identifiers.

Add two immutable lineage records rather than widening every existing canonical
fact payload:

- a source-global promotion record links one accepted extraction result to the
  canonical fact, correction, and retraction revisions it produced; and
- an invalidation record links a superseded derived result to the source,
  definition, validator, pack, or binding revision that invalidated it.

Current-result resolvers apply those records without mutating history.

## Runtime and capability boundary

- Implement one declared `hybrid-evidence-worker` (name may vary with existing
  conventions) as a fresh Eve task session with a required output schema.
- Start it through the existing node-targeted Eve runtime bridge and occurrence
  control plane. Do not add a cron, queue consumer, or permanent conversational
  session.
- The worker receives no interactive transcript or general workspace brief.
  Its task contains the job definition, bounded evidence references, and only
  the domain context required by the registered schema.
- Dynamically expose only read-only evidence-slice tools and one controlled
  result-return path. No arbitrary fetch, shell, filesystem write, session
  manager, external connection, alert delivery, or financial tool is available.
- Sign each task with an expiring single-job authorization envelope binding the
  job, owner/workspace or source-global scope, definition/capability revisions,
  artifact digests, allowed locator bounds, and budget reservation. Every
  evidence read and result commit revalidates it server-side; model-supplied
  arguments cannot widen scope.
- PDF recovery may provide bounded rendered page images through Eve content
  parts to a vision-capable allowlisted model. Keep each part below Eve's size
  warning and use a one-turn task so images are not repeatedly resent.
- Spreadsheet recovery deterministically decodes the workbook and projects a
  bounded cell grid; the model maps reviewed semantic roles, and deterministic
  code validates cell citations and values.
- Treat PDFs and workbooks as hostile before the model sees them: validate MIME
  and magic bytes; reject macros, formula execution, JavaScript, embedded
  objects, external links, and local-file access; bound compressed/expanded
  bytes; and isolate decode/render work with CPU, memory, and time limits.
- Semantic text jobs receive bounded text spans and existing canonical facts,
  never an unbounded transcript or entire archive.
- Extend the existing ledgers with reservation kind `hybrid_model_attempt` and
  independent keys such as `hybrid:<jobId>:attempt:<n>`. Lane A debits a
  deployment source-recovery token/paid/concurrency budget; Lane B debits the
  owning workspace token/paid/concurrency budget. Neither increments the
  scheduled-monitor run count. Reconcile the parent occurrence and hybrid
  attempt independently, and preserve uncertainty if a possibly started call
  loses its result.
- Lane A model IDs must be allowed by the job definition and deployment source-
  recovery policy; Lane B additionally requires the active workspace
  `workerModelPolicy`. Model-only inference uses hybrid flags and token/cost
  reservations, not `paidResearchAllowed`, which governs paid provider tools.

## Validation and safety invariants

- A deterministic result bypasses the hybrid worker only after its schema,
  plausibility, and source-relationship validators pass. Suspicious nominal
  success becomes an explicit recovery-eligible or quarantined outcome.
- A parser failure is eligible only when adapter, content type, error code, job
  definition, feature flags, capabilities, and budget all allow it.
- Model output never replaces source-native identity, timestamps, units,
  amendment/correction relationships, or row boundaries without cited evidence
  and deterministic validation.
- Missing evidence stays `unknown`; it does not become false, zero, neutral, or
  absent.
- Confidence is definition-specific metadata, not permission to skip a required
  validator, citation, or independent material-value check.
- Conflicting evidence, invalid citations, schema mismatch, unsupported layout,
  prompt injection, and low-confidence thresholds produce abstention or
  quarantine, not guessed facts.
- Source content is always treated as untrusted data. Instructions embedded in
  a PDF, spreadsheet, transcript, article, or social post cannot change tools,
  policy, output schema, or task instructions.
- Accepted results identify the model, definition, prompt template, schemas,
  validators, source digests, and exact evidence locators used.
- Source-global accepted extraction is immutable and shareable only through the
  existing authorized projection path. Workspace semantic results never enter a
  source-global store.
- No raw evidence, prompts, provider payloads, chain-of-thought, credentials,
  workspace IDs, or source URLs appear in runtime logs.
- No hybrid worker can call a broker, produce an approval, or treat research as
  trade authorization.

## Required proof scenarios

The foundation is not accepted from unit contracts alone. It must prove these
three small vertical cases through the actual worker/control-plane boundary.

### PDF/document recovery

- Use a retained, reviewed image-only or changed-layout public PDF fixture with
  known expected fields.
- Prove the deterministic parser returns the expected bounded unsupported or
  partial outcome first.
- Run the actual hybrid worker with bounded page images, require exact page/field
  citations, confirm material values through bounded independent OCR, validate
  the candidate, and create the expected canonical fact revision.
- Prove a missing field, invalid page citation, ambiguous row, injected
  instruction, and page/byte limit each quarantine without advancing the source
  cursor or fabricating a transaction.

### Spreadsheet schema drift

- Use a deterministic workbook fixture with renamed, reordered, inserted, and
  omitted columns while preserving known source values.
- Decode it to a bounded cell grid, let the worker map reviewed semantic roles,
  then validate exact cell ranges, dates, numbers, units, and required fields.
- Prove the accepted mapping survives benign layout drift and that conflicting,
  duplicated, or missing required columns quarantine.
- This fixture ends at an accepted or quarantined hybrid mapping result. It does
  not add a production upload/connector or invent a canonical spreadsheet fact
  schema; the House PDF vertical alone proves canonical-fact promotion.

### Semantic public text

- Use bounded transcript/article/RSS/social-style fixtures whose meaning cannot
  be determined by a fixed keyword list, including indirect positive/negative
  language, genuine ambiguity, counterevidence, and prompt injection.
- Run a registered workspace-scoped semantic schema and require claims,
  uncertainty/abstention, and exact text-span citations.
- Prove two workspaces can apply different pinned job/pack definitions to the
  same public evidence without sharing derived results.
- Use test-only pack and binding fixtures that exercise the production
  authorization and persistence paths but are never registered in the production
  strategy catalog or attached to Congressional Signals.
- The fixture may produce a research classification only. It must not create a
  trade, claim future price movement, or silently turn sentiment into a signal.

## Owner experience and observability

Extend existing workspace inspection surfaces rather than creating a new app:

- show whether hybrid reasoning is disabled, available, degraded, or blocked by
  configuration/capability/budget;
- show bounded counts for prepared, running, accepted, quarantined, failed, and
  uncertain jobs plus token/cost usage;
- show the model-derived label, job-definition version, source provenance,
  citations, validation status, and important unknowns on an accepted result;
- let the owner inspect a quarantined result's fixed reason codes and safe
  metadata without exposing raw model reasoning or another workspace; and
- keep alert wording strategy-owned. The foundation does not send a generic
  “LLM result” alert.

A newly blocking or persistently degraded quarantine state emits one bounded,
deduplicated operational-health notification through the existing Spec 1
failure-alert path. It is not a research signal and must not fire once per
quarantined record.

Observability uses a fixed low-cardinality event/error catalog. Metrics may name
job purpose, definition version, model family, state, and validator outcome, but
never raw IDs, arbitrary exceptions, source content, or URLs.

## Developer extension contract

A later connector or strategy adds a reviewed job definition, registered input
projection/output schema, deterministic validator, and fixture/eval corpus. It
may reference the common artifact, job, worker, budget, provenance, and
quarantine APIs; it must not edit those shared layers merely to register another
schema. A contract test registers one additional test-only extraction definition
and one semantic definition without modifying the shared store, runtime, or
control-plane implementation.

## Feature flags and rollout

Add one parent flag and two child paths, defaulting to off:

- `EVE_HYBRID_EVIDENCE_ENABLED`
- `EVE_HYBRID_EXTRACTION_RECOVERY_ENABLED`
- `EVE_HYBRID_SEMANTIC_REASONING_ENABLED`

The child flags require the parent plus the existing workspace state/dispatch,
capability, and budget dependencies. Partial or invalid configuration fails
closed; it never falls back to unmetered model execution. The deterministic
Spec 3 and Spec 4 paths must remain unchanged when all three flags are off.

Rollout order is contracts/store, worker with fixture-only execution, extraction
recovery, semantic reasoning, then one owner-authorized production smoke per
lane. Roll back child flags first, then the parent. Disabling the layer preserves
accepted evidence and quarantine history but prevents new model jobs.

## Sprint ledger

### Sprint 0 — freeze contracts and red fixtures

- [x] Define the two lanes, evidence artifact/locator, immutable job definition,
  job lifecycle/abstention, accepted-result envelope, promotion/invalidation
  lineage, and fixed error/event catalogs as bounded schemas.
- [x] Register the parent/child flag matrix and prove all-off preserves existing
  Spec 3 and Spec 4 behavior without model calls.
- [x] Add a versioned corpus of at least 12 cases across PDF, spreadsheet, and
  semantic evidence with expected accepted, abstained, quarantined, false-
  success-layout, hostile-document, and prompt-injection outcomes.
- [x] Add deterministic mock-model harnesses that fail at the missing production
  seams before implementation.

Local evidence: the 16-case Sprint 0 contract gate, public-source runtime and
Congressional Signals focused regressions, TypeScript, and the Eve build pass;
the artifact store, job store, and worker runtime remain executable red seams.

Exit: contracts and expected behavior are executable, while no production model
or source path has changed.

### Sprint 1 — durable evidence jobs and isolated worker

- [x] Add the dedicated public evidence artifact namespace/store, bounded
  retrieval/locator validation, reference-aware retention, aggregate quotas,
  and content-addressed reuse.
- [x] Add idempotent job preparation, claim, completion, acceptance, quarantine,
  failure, and uncertain persistence with exact definition/input digests.
- [x] Add the fresh Eve task worker, per-turn output schema, narrow dynamic
  financial/session/general-fetch tools; bind every read/commit to an expiring
  signed single-job scope.
- [x] Extend the existing ledgers with independently keyed hybrid attempts:
  deployment source-recovery budgets for Lane A and workspace budgets for Lane
  B, without incrementing scheduled-run counts.
- [x] Prove replay, definition/artifact revision invalidation, two-workspace
  isolation, and one deployment-funded source-global job reused by two
  workspaces.

Local evidence: the Sprint 1 gate exercises content-addressed Blob reuse,
aggregate quotas, bounded text locators, 30/90-day reference-aware retention,
every durable job transition, signed control-plane reads/commits, task output
schema, compiled tool isolation, both independently reconciled budget lanes,
revision invalidation, workspace isolation, and one source-global reservation
reused by two workspaces. Sprint 0, workspace budget/dispatch/auth/isolation,
compiled worker-tool, and public-source runtime regressions, TypeScript, and the
Eve build pass without a production model or source call.

Exit: a fixture job can run through the real local control plane and produce an
accepted or quarantined durable result; it cannot yet change a source fact or
strategy result.

### Sprint 2 — extraction recovery verticals

- [x] Integrate recovery eligibility after a reviewed deterministic parser's
  allowlisted partial/unsupported/suspicious result, without adding a second
  acquisition or schedule path.
- [x] Implement PDF page rendering/content parts and the reviewed document-row
  extraction definition plus independent bounded OCR and deterministic
  citation/domain validation.
- [x] Implement bounded workbook-to-cell-grid projection and the reviewed
  spreadsheet-role mapping definition plus its deterministic validator.
- [x] Promote only independently verified House PDF candidates into immutable
  canonical fact revisions with promotion/invalidation lineage. Spreadsheet
  fixtures stop at the accepted hybrid-result boundary.
- [x] Pass the PDF and spreadsheet proof scenarios, deterministic-success bypass,
  reuse, correction/revision, bounds, injection, and negative fixtures.

Local evidence: the Sprint 2 gate drives a retained scanned House PDF through
bounded PDF rendering, Eve image content parts, the signed worker read/commit
boundary, independent bounded OCR, deterministic citations/domain validation,
and the existing House acquisition commit. It proves deterministic bypass,
cross-workspace source-global reuse, corrections, retractions, immutable
promotion/invalidation lineage, invalid-citation quarantine with no cursor
advance, hostile PDF/injection/bounds failures, and a second worker job over a
bounded hostile-workbook decoder. The spreadsheet mapping accepts renamed and
reordered columns, rejects duplicate/missing/conflicting columns, formulas,
external content, and injection, and creates no canonical fact or promotion.
Sprint 0/1, existing House acquisition/runtime and compiled worker-tool
regressions, TypeScript, the Eve build, and the diff check pass without a
production model, source call, message, deployment, or flag change.

Exit: two different document shapes use the same job/evidence foundation, and
only deterministically validated model candidates become source facts.

### Sprint 3 — workspace semantic reasoning vertical

- [x] Add workspace-scoped semantic job authorization from exact pack/binding,
  capability, source projection, and job-definition revisions using test-only
  pack/binding fixtures that never enter the production catalog.
- [x] Persist immutable model-derived evidence with common provenance and a
  definition-specific payload; keep it out of canonical source facts and other
  workspaces.
- [x] Add the semantic public-text reference definition and validate claims,
  counterevidence, uncertainty/abstention, and exact text-span citations.
- [x] Expose bounded hybrid state, usage, provenance, citations, unknowns, and
  quarantine reason codes through existing workspace inspection surfaces, and
  deduplicate newly blocking/persistent quarantine health alerts.
- [x] Pass semantic, ambiguity, injection, correction/retraction, pack revision,
  budget, replay, and two-workspace isolation fixtures.

Local evidence: the Sprint 3 gate uses a test-only semantic pack absent from the
production catalog and drives exact active binding, capability/model policy,
authorized public-source projection, source-fact, artifact, text-span, and job-
definition revisions through the production authorization and persistence
paths. It proves accepted indirect positive/cautious interpretations, explicit
ambiguity and counterevidence abstention, prompt-injection quarantine, immutable
workspace-only provenance, replay without redispatch or rebilling, budget
denial, source correction/retraction, pack revision lineage, cross-workspace
isolation, bounded owner inspection, deduplicated blocking/persistent health,
and no canonical-fact write. Sprint 1/2, compiled worker-tool isolation,
strategy-pack owner surfaces, the workspace runtime manager, TypeScript, the
Eve build, and the diff check pass without a production model, source call,
message, deployment, or flag change.

Exit: a reviewed strategy can consume accepted semantic evidence without
hard-coded keywords, while ambiguous meaning remains explicit and isolated.

### Sprint 4 — final acceptance, rollout, and landing

- [ ] Run one independent diff-scoped review; fix validated blockers and move
  nonblocking hardening or later connector/strategy work to `BACKLOG.md` or its
  owning future spec.
- [ ] Run the focused three-scenario suite, relevant Specs 1–4 regressions,
  typecheck, Eve build, application build, and diff check once after code review
  fixes settle.
- [ ] Prove the ordinary end-to-end boundaries: deterministic bypass; one
  source-global extraction reused by two workspaces; workspace semantic
  isolation; quarantine; correction/revision; fixed logs; budget settlement;
  extension registration without shared-layer edits; and financial-capability
  denial.
- [ ] With owner authorization, run a versioned real-model corpus at least twice
  per case across all three proof shapes. Require zero false accepted material
  fields, invalid accepted citations, unsafe accepts, or forbidden tool use;
  at least 80% accepted recovery on reviewed supported cases in both runs; and
  100% abstention/quarantine on ambiguous, prohibited, and adversarial cases.
  Record run-to-run variance before enabling either child flag. No broker,
  private data, external message, or complete strategy rollout is required.
- [ ] Stage the parent/extraction/semantic flags independently, prove rollback,
  and leave production in the owner-approved state.
- [ ] Mark this ledger accurately, record exact acceptance/flag evidence, move
  only deferred hardening to `BACKLOG.md`, and update `HANDOFF.md` and
  `NORTH_STAR.md` where implementation changed reality.
- [ ] Commit and push the final branch, open and merge its PR, confirm GitHub
  `main` contains the exact accepted commit, and verify the resulting production
  deployment/health when the merge triggers one. Do not repeat the already-green
  broad suite unless landing changed code.

Exit: the shared hybrid foundation is implemented, accepted, merged to `main`,
and ready for Specs 4B and 4C without either strategy recreating its evidence,
worker, budget, provenance, or evaluation plumbing.

## Planned code areas

These are likely ownership boundaries, not a mandate to create empty layers or
use these exact filenames:

- bounded schema, artifact/job store, registry, and control-plane modules under
  `agent/lib/hybrid-evidence-*`;
- one Eve runtime bridge and `agent/subagents/hybrid-evidence-worker/`;
- focused extensions to the existing public-source coordinator/adapters,
  workspace/global budgets, capability control plane, and manager; and
- `evals/hybrid-evidence/`, `scripts/fixtures/hybrid-evidence/`, and focused
  `scripts/verify-hybrid-evidence-*` commands.

Prefer existing Redis CAS patterns, Vercel Blob dependency, Eve node-targeted
task runtime, capability manifests, budget ledgers, and observability helpers.
Do not create parallel equivalents.

## Verification boundaries

| Boundary | Required proof |
| --- | --- |
| Deterministic first | A supported, plausibility-valid deterministic input produces the existing facts with zero hybrid jobs or model cost; a false-success layout cannot bypass recovery/quarantine. |
| Evidence | Every material accepted field/claim cites a validated bounded locator; source-global material fields also agree with independent text/cell/OCR extraction. |
| Reuse | One deployment-funded source-global extraction is reused across two authorized subscribers without another model call. |
| Isolation | Workspace semantic jobs/results cannot read or affect another workspace even on shared source evidence. |
| Safety | Invalid citations, hostile documents, injection, exceeded bounds/budgets, and forbidden tools quarantine or fail without fact/signal mutation. |
| Lifecycle | Replay is idempotent; corrections and definition/pack changes create lineage; ambiguous execution becomes uncertain. |
| Privacy and channels | Logs are fixed and bounded, workspaces stay isolated, and durable contracts contain no Photon identity or private evidence. |
| Financial boundary | No hybrid path can treat research as approval, call a broker, or submit a mutation. |
| Extensibility | Test-only extraction and semantic definitions register without changing the shared artifact/job stores, worker runtime, or control plane. |

## Definition of done

Spec 4A is complete only when every Sprint 0–4 item has evidence, the repeated
real-model gate and final regressions pass, deferred work has an explicit owner,
the handoff/roadmap match reality, and the accepted commit is merged to GitHub
`main` with its production state verified.

## Follow-on sequence

1. Spec 4B builds Earnings Call Changes as the first full strategy using
   transcript acquisition plus the shared semantic lane.
2. Spec 4C builds a second real strategy around a different connector/content
   shape, chosen only after source viability, terms, cost, and acceptance data
   are known.
3. Revisit Spec 5 so SEC Form 4 remains deterministic where authoritative XML is
   available and uses the hybrid layer only for explicitly justified semantic
   evidence or layout recovery.
4. Implement Spec 6 typed cross-strategy signal promotion only after both real
   hybrid consumers prove which shared signal fields are actually needed.

Additional connectors—X/Twitter, RSS/WebSub, website changes, spreadsheets,
transcripts, and authenticated APIs—remain small reviewed source specs. They
reuse this foundation but still own transport authorization, source identity,
rate limits, canonicalization, and content-specific validation.
