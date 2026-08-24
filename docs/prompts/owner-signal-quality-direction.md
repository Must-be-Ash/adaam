# Owner objective — what a signal alert must be

## The objective

**Every background monitor delivers a trading edge: the signal it found, and
what that signal means, in a form the owner can act on in seconds.**

An alert is a headline plus two or three sentences. It says what was found and
what it indicates — "this suggests the price goes down, because…" — and nothing
about how the system arrived there. Certainty travels with it as a metric,
because it will later decide whether an agent may place a trade on its own.
Where a statement is only a starting point, the agent researches around it to
work out what it could mean; where the statement is already the answer, it does
not research at all.

## The ask, in the owner's words

> "what i am looking for is an executive order. meaning straight to the point
> what's the signal it found and what it means. super TLDR. like a headline
> plus two three sentences max description and/or explanation"

> "i am guessing we never added research cause it should say how certain it is,
> that's a meteric we want but not user facing like the provenance and IDs. the
> certainty score will be later used when we allow agents to trade on their own
> so we can say if you're more certain than 80% about your prediction (eg 'this
> means gold can go up') then go ahead and place an order (buy/sell or
> short/long). What i want is the signal itself, what it means"

> "the agent treats the incoming tweets as starting points. researches and tell
> me what each mean or indicate using the original signal and suplemnetry
> information it discovered if it decided to do more research. the research
> should be to get a bigger picture not to vaidate facts and claims but to get
> a better idea of what it's talking about and what the signal could mean"

> "i dont want '2 statements qualified' i want the signals (aka headline) and
> what they mean or indicate (aka this indicates price is going to go down
> because...)"

> "the whole point of these signals is to get an edge as a trader. to have
> information so that we can make better and more informed desisions. the need
> for research also should depend on the strategy. for example, one news
> regarding gold comes in, we do further research regarding the other factors
> that might matter before the agent say this is a buy or sell signal. but if
> we are running Inverse Cramer for example or 'did trump say something that
> indicates peace or war with Iran' those are things we are taking as the
> signal itself and dont want any research. if Cramer says he's bulish, we are
> bearish. If trump says we are going stop the war with Iran or make a deal,
> that means we are bearish on Oil and the price is going down. that's it."

> "if research lane is a shared pipeline it should not have hardcoded things
> left behind and all of that should have been taken care of from migration."

> "backlog is only for wishlist items or things that can be deferred and don't
> need to be dealt with, such as hardcore hardening. I don't want anything that
> should be addressed to be backlogged going forward."

## Owner direction, 2026-08-24 morning

The owner received a real Tracker alert overnight and it is "almost working."
The remaining gaps are shape and language, stated concretely against that alert.

The alert as delivered:

    Workspace alert · Tracker Live

    Market · bullish · medium confidence · weeks · uncorroborated

    The statement discusses potential increased purchases of long-term US
    government bonds by the Treasury, which would generally support bond prices
    and implies a bullish read for long-duration Treasuries. Caveat: The post
    says Treasury is 'considering' the action, so the policy step is not
    confirmed. Cited statement: https://x.com/KobeissiLetter/status/2091859386176090296
    This direction is produced by the Configured public-commentary impact
    hypothesis policy.

    Observed Aug 24, 2026, 12:05 PM UTC

    Sources: https://api.x.com/2/users/3316376038/tweets

What must change, in the owner's words:

1. **Metadata out of the text.** "Market · bullish · medium confidence · weeks ·
   uncorroborated" should be in the artifact only, not the message body.
2. **No internal timestamp.** "Observed Aug 24, 2026, 12:05 PM UTC" is not
   user-facing at all.
3. **No API/machine source in the message.** "Sources:
   https://api.x.com/2/users/3316376038/tweets" must go — it is a polling
   endpoint, not a human page, and the post already named its source in-text.
   The only source the owner wants shown is the human x.com post.
4. **Lead with the attribution.** It opened "The statement discusses potential …"
   when the tweet said "per CNBC". It should open "Per CNBC, …".
5. **Supplementary picture in the artifact.** The owner wants to open an artifact
   and see the context that helps a decision — e.g. that the $950B General
   Account is a much larger pool than what was tapped in 2021/2022 post-COVID,
   and how it compares — not a paraphrase of the tweet.

The correct shape the owner wrote out:

> "Per CNBC, the US Treasury is considering tapping its $950B General Account to
> fund bigger long-term bond buybacks, according to the Kobeissi Letter this
> means the price of long-term US Treasuries could be going up. I would keep my
> eye on the 10-year and 30-year yields (and TLT) in the coming days and be
> ready to long/buy long-duration Treasuries."
>
> sources: https://x.com/KobeissiLetter/status/2091859386176090296

The template is illustrative, not literal: "[source] just reported [headline];
per [supplementary source] this means the price of [asset] could go [up/down];
watch [stats/sources] and be ready to [long/short]."

Note on current state (2026-08-24): this delivered alert is the NON-research
path — direction/confidence/horizon are jammed into the title because there is
no artifact and nowhere else for them to go, and the body is the impact model's
raw rationale. The owner's desired shape (natural attribution + supplementary
artifact + a real headline title) is what the RESEARCH path is meant to produce.
So the alert-shape fix and getting research to deliver a report are the same
piece of work, not two.

## Where it stands, 2026-08-23 evening

This is the most recent alert the owner actually received:

    Workspace alert · Tracker Live

    Market · bullish · medium confidence · days · uncorroborated · +3 more

    The post reports a higher Philadelphia Fed manufacturing index and says US
    manufacturing activity is rapidly expanding, implying a positive directional
    read on the named macro theme of US manufacturing activity. Caveat: The
    statement is based on a regional survey, so broader market implications are
    indirect. Cited statement: https://x.com/KobeissiLetter/status/2091659126418141541
    This direction is produced by the Configured public-commentary impact
    hypothesis policy.

    Observed Aug 24, 2026, 2:19 AM UTC

    Sources: https://api.x.com/2/users/3316376038/tweets

### Closer to the objective than it was

The shape is right: a scannable signal line carrying direction, certainty and
horizon, then the finding and one caveat, then the link. The identifier dumps
are gone — no finding ids, fact-revision ids, digests, character spans or
revision numbers. It no longer narrates its own run ("first run, covering the
last 6 hours", "2 statements qualified").

### Still short of it

1. **No research and no report.** This is the main gap. The alert is a reading
   of one post, not a bigger picture. Nothing is attached that the owner can
   open and keep. Every other item below is smaller than this one.

2. **"Market" instead of a named asset.** When the model does not identify a
   tradable instrument, the signal line says "Market", which is honest but weak
   as a headline.

3. **"+3 more" are never delivered.** Three other signals in that window exist
   and the owner cannot see them anywhere. The count is at least honest about
   it, but the information is lost to them.

4. **"Sources: https://api.x.com/2/users/…/tweets"** is still there. It is the
   polling endpoint, not something a person can open. See "What I broke" below —
   I tried to fix this and it caused an outage, so it stands unfixed.

5. **The closing sentence is boilerplate.** "This direction is produced by the
   Configured public-commentary impact hypothesis policy." is required
   disclosure text, and it reads like machinery at the end of every alert.

6. **The headline is the model's own reasoning sentence**, not a written
   headline, because nothing currently asks it for one.

7. **Certainty is coarse** — low / medium / high. Usable as a label, but a rule
   like "act above 80%" needs something finer, and that does not exist yet.

## What I did that broke things

Recorded plainly, because it is the most useful thing here.

**I took the live tracker down for roughly fifteen minutes.** Trying to fix the
"Sources:" line above, I changed what a finding records as its source so it
would point at the post instead of the API endpoint. Every check passed — all
38 strategy suites, the build, the deploy — and it still broke production: the
system refuses a finding whose source does not match the source the monitor
declared, and a post lives on a different host from the API it was polled from.
Every result was rejected while that was live. Nothing caught it because the
check compares against a real running monitor, which no test reproduces. I only
found it because the owner asked why the monitor was paused. It is reverted, and
I left a note in the code where the next person will try the same thing.

**I told the owner the fleet was healthy twice without re-checking**, and the
second time it was not.

**I rebuilt the tracker workspace many times** while testing. Each rebuild makes
the next catch-up run larger, and at least one later failure looked like the
consequence of that rather than a real defect.

**I asserted causes I had not confirmed**, more than once, and had to retract
them: a shared network-layer theory that later evidence contradicted, and a
budget-leak claim that measurement disproved. Treat confident-sounding reasoning
in this area with suspicion, including mine.

## What I think is wrong with research — but am not sure

The research capability exists and is switched on for the tracker, and it does
start: a run reserves the research budget, which only happens when the lane is
active. It has never produced a report.

Something in how the model's answer is checked against its evidence rejects the
result. The stored record for those attempts is marked `citation_invalid`.

**I think** the model is not pointing at its evidence in exactly the form the
checker demands — the checker appears to want the answer's references to match
the supplied evidence precisely, and I think the model's did not. **I am not
sure.** I never looked at what the model actually produced; I only read the
checking code and formed a theory. Verify against the stored attempt records
before acting on it.

**It could instead be** that the instruction I wrote is unclear about what to
reference, or that the checking rule I copied from another strategy does not
suit a strategy that can look at more than one post at a time, or something
else I have not considered.

One thing I would keep whatever the cause turns out to be: the rule that every
claim in a report must point at real evidence exists so a report cannot invent
things. The tempting shortcut is to relax it until the result passes. That would
make the report untrustworthy, which defeats the point of having one.

## Current state

The three background monitors — Inverse Cramer, IPO, and the Tracker — are all
running and healthy, and the Tracker completed a clean run at 8:25 PM after the
revert. The Tracker runs the older configuration without research, because the
newer one with research produces no alert at all, and a working alert beats a
richer broken one.

## Session update — changes, learnings, and what I think still blocks us (2026-08-24, afternoon)

My own working note after a long debugging session. Where I name a cause or a
blocker, treat it as my current belief, not a settled fact; I mark the ones I
have not confirmed. I am recording what I changed, what I learned, and what I
think still stands between us and the outcome — not recommending fixes.

### What I changed (all deployed to Production)

- **Research citation visibility.** The research / executive-brief lane could
  never emit a report with a real model. The model has to echo the exact signed
  `text_span` locators in its citations, but the evidence-bundle read only ever
  showed it content and digests — never the full locator — so it could not
  reproduce the required `spanDigest`, and `requireExactCitations` rejected every
  candidate as `citation_invalid`. The research verifiers passed only because
  their stub model echoes an in-scope locator object the real model never sees.
  I changed `typedPrompt` in the hybrid-evidence worker to hand research jobs
  their citable locators to copy verbatim.

- **Owner-facing alert cleanup.** I dropped the "Observed …" timestamp and
  suppressed machine/API source endpoints (e.g. `https://api.x.com/…/tweets`)
  from the owner-facing message; both still reach the durable record and the
  Discuss turn context. Presentation only, no provenance/fence change.

- **A failed occurrence now records its own cause.** Before, a failing
  occurrence stored only an opaque terminal code and the real error rolled off
  Vercel's ~50-row log buffer within minutes, so a failing monitor was
  undiagnosable without buying another occurrence. The commentary worker now
  writes a durable, read-only-queryable record with the exact error, message,
  stack, and the stage it reached. This is what surfaced the budget cause.

- **Per-run budget floor.** With that durable record I could see occurrences
  throwing `budget_exhausted`. I raised the default budget ceilings and floored
  the derived per-run envelope.

- **Worker reasoning.** I changed the scheduled worker agent from `"high"` to
  `"low"` and then to `"none"`, trying to stop an intermittent empty response.
  Production is currently on `"none"`. It did not fix the empty response. This is
  only the *worker's* orchestration reasoning; the analysis reasoning
  (materiality, the research decision, the brief) runs on the frontier model in
  the child jobs and was never touched.

### What I learned

- **The worker does no reasoning, for any strategy.** All five strategies'
  monitor instructions are the same shape: "call `evaluate_<strategy>` exactly
  once; the capability owns everything." The worker LLM's whole job is to emit
  one tool call; acquisition is deterministic and the reasoning runs in nested
  child jobs on the frontier model.

- **eve does not require an LLM for an occurrence.** eve schedules support a
  deterministic `run` handler ("the handler is in full control"), not only the
  agent/markdown form. Running each occurrence as an LLM agent is how the app was
  wired, not an eve constraint (per the installed 0.33 docs).

- **The research verifiers prove nothing about real-model behaviour** — their
  stubs echo an in-scope locator, which hid the citation bug for a long time.

- **The budget envelope is not funding the fan-out the way it was designed to.**
  Each semantic child reserves its definition maximum (24k input) against the
  occurrence's per-run envelope and is meant to reconcile down to actual on
  completion; the boundary tests only require the envelope to fund the
  *concurrent* fan-out on that assumption. On the production path the child
  session reports no usage, so it reconciles at the maximum and the reservation
  never shrinks.

- **We are 11 eve versions behind:** installed 0.33.0, latest 0.44.3.

### What I think still blocks the desired outcome

- **I do not think the research lane has been proven end-to-end yet.** I fixed
  the citation blocker, but no Production occurrence has completed far enough to
  actually publish a brief + artifact, so I have not seen whether the brief
  publishes, whether the language reads the way you want ("Per CNBC …"), or
  whether the artifact carries the supplementary picture. Everything downstream
  of the worker is still unproven for me.

- **I think the worker intermittently returns an empty model completion, and I
  have not found why.** It fails roughly one occurrence in two, at the worker's
  first model turn, before any tool call. I could not reproduce it in isolated
  gateway probes (25+ calls, never empty), and it happened regardless of the
  reasoning setting, including `"none"`. So I think it is something in the eve
  worker-session layer (streaming/concurrency), not the raw model, the reasoning,
  or the budget. **I have not verified this.**

- **I think the eve version gap may be relevant to that empty response, but I
  have not verified it.** The 0.44 changelog adds model-call retries that our
  0.33 lacks — "Retry model calls when undici terminates a response stream after
  a headers or body timeout" and "Retry transient provider overload errors
  delivered inside model streams … at most three fresh model-call attempts." Our
  0.33 fails the run after a single reissue. The empty response could be one of
  those transients a newer eve would retry; I do not know.

- **I think the budget reconciliation is still wrong underneath the floor.** The
  floor raises the ceiling on statements-per-occurrence but does not change that
  a completed child reconciles at its maximum rather than actual usage, so a busy
  enough window can still exhaust the envelope. I think the gap is that the child
  session's actual usage never returns to the reconciliation, but I have not
  confirmed that end to end.

- **I think using an LLM for a deterministic single-tool call is itself a
  fragility.** It adds a failure mode (the empty completion) to a step that needs
  no intelligence. I am noting this as an observation of the current shape, not a
  recommendation.

### Current Production / test state

- Deployed: the citation fix, the alert cleanup, the durable failure record, the
  budget floor, and worker `reasoning: "none"`.
- I created disposable test workspaces "Kobeissi Research Test 3–6" during this
  session; 3 and 4 are archived, 5 and 6 are `paused_failure`/enabled and should
  be cleaned up. The three live monitors were not reconfigured.

### Owner direction on the above (2026-08-24)

These are the owner's decisions on the two blockers above, recorded here so they
are not lost:

- **If the worker does not need reasoning, drop it.** The worker only calls one
  tool and does no analysis, so there is no reason to keep reasoning on it.
- **If it will not break things, update to the latest eve version.** The newer
  eve's model-call retries may address the empty-response blocker, so upgrade to
  the latest — provided the upgrade does not break the build, the strategy
  battery, or the live monitors.

---

# SESSION PROGRESS TRACKER (live — keep this current so work is resumable)

Started 2026-08-24. This is the running status of the signal-quality work. If a
session is lost, resume from "Current position" below. The plan has six phases;
each is locally verifiable before anything is armed in Production.

## The plan (owner-approved)

1. **Deterministic worker dispatch** — replace the Gemini worker LLM (which only
   emitted one tool call and caused the ~50% empty-response failures) with a
   direct evaluator call. Root-cause fix for "research never completes."
2. **Prove the research/brief lane end-to-end** with an isolated real-model
   script (no bought Production occurrences). Confirm the citation fix holds and
   a brief actually publishes.
3. **Alert language/shape** — lead with attribution ("Per CNBC …"), keep
   direction/confidence/horizon/corroboration + timestamp + API source OUT of the
   text and IN the artifact; multi-signal = newspaper model (strongest is the
   headline, all signals live in the artifact); clean fallback alert if the
   brief model call fails.
4. **Budget reconciliation** real fix (child actual usage back through the drain,
   so reservations shrink to actual instead of reconciling at max).
5. **Research-only** — retire the legacy non-research alert path, point the live
   monitors at the research packs (Tracker → `public-commentary-tracker@1.4.0`),
   archive old non-research packs (kept, not deleted).
6. **Live E2E** — owner arms a recreated monitor, one occurrence, confirm the
   alert shape over real iMessage.

Plus a standalone phase (owner wants it for general eve improvements, not just
the empty-response): **upgrade eve 0.33 → 0.44.3**, done carefully in a worktree
with the full battery, sequenced AFTER phase 2 so there is a known-good research
baseline to bisect against.

## Product decisions captured (owner, 2026-08-24)

- **Multi-signal delivery:** newspaper model — the strongest signal is the
  iMessage headline; ALL signals (incl. the "+N more") live in the artifact so
  nothing is lost.
- **On brief-model failure:** send a clean basic attribution-led alert built from
  the tweet itself (metadata still in a minimal artifact), never the old
  metadata-in-title shape; never silence.
- **Delete the LLM worker fully** (not leave dormant).
- **Isolation/Discuss/interactive chat must stay intact** — verified untouched.

## Status by phase

- **Phase 1 — DONE and fully verified (2026-08-24). Not yet committed/deployed.**
  - New `agent/lib/workspace-evaluator-dispatch.ts`: scheduler invokes each
    strategy's evaluator directly, keyed off the signed envelope, selected by the
    monitor's declared evaluator capability (no pack-ID branching).
  - `agent/schedules/event-triggers.ts` rewired off the LLM session; all
    delivery/recovery/failure-code/budget semantics preserved and proven.
  - Deleted `agent/subagents/workspace-worker/` (whole LLM agent),
    `agent/lib/eve-workspace-worker-runtime.ts`, and the dead prompt-building in
    `workspace-worker-runner.ts`. The `hybrid-evidence-worker` child (frontier
    reasoning) and the `@adaam/eve-workspace-runtime-bridge` STAY (child jobs use
    them).
  - Reworked 10 test suites from model-event to deterministic-outcome
    assertions, incl. the 1600-line compiled E2E (now also guards that the
    subagent stays deleted). Removed the obsolete
    `verify-workspace-worker-compiled-tools.ts` and its gate.
  - **Gates all green:** `verify:strategies` (38 suites), typecheck, eve build
    (`build:agent`), Next.js build. Interactive chat / Discuss / isolation
    verified untouched (interactive path imports nothing that changed).
  - Budget note: worker tokens are now 0; child frontier spend still reconciles
    independently via `finishWorkspaceMonitorDispatchBudget`.

- **Phase 2 — DONE and proven (2026-08-24).** New reusable acceptance:
  `scripts/accept-public-commentary-research-real-model.ts`
  (`npm run accept:public-commentary-research:real-model -- --model=<id>`). It
  reconstructs the production research-lane prompt + the signed `citableLocators`,
  completes via a real tool call (the mechanism production uses), and validates
  against the REAL `publicCommentaryResearchValidationContract`
  (`requireExactCitations`). Proven across `openai/gpt-5.4`,
  `anthropic/claude-sonnet-5`, and `anthropic/claude-opus-4.8`:
  - `citationExact: true` on all — the real model copies the signed locator
    verbatim. **The citation blocker (commit 7b86e41) is confirmed fixed with a
    real model, not just stubs.**
  - `contractError: null` on all — the executive brief passes the real contract.
  - Language is exactly the target shape on all: attribution-led title/body
    ("Per CNBC, …"), metadata in the structured fields (→ artifact) not the text,
    human x.com source only. This is the first real-model proof that this lane
    produces the owner's desired shape.
  - **Scope of the proof (honest):** this is the `report_now` path (brief from
    primary evidence, the common case that was failing on citations), completed
    via a single tool call. It does NOT yet exercise the `research_needed` Exa
    search+fetch tool loop, nor the full production wiring (semantic job →
    research job through the compiled hybrid-evidence worker) end to end — those
    need a compiled-worker real-model run or one live occurrence. The two things
    that were actually BLOCKING (exact citations, attribution-led language) are
    proven.
- **Phase 3 — IN PROGRESS (2026-08-24).** The language is solved and proven.
  - **Root finding:** with the *actual* shipped instruction, gpt-5.4 produced a
    non-attribution-led, analytical title ("Treasury cash-balance use is framed
    as…") and no actionable closer — i.e. the exact shape the owner complained
    about. The earlier "clean" real-model runs looked good only because the proof
    script's own hardcoded prompt was doing the work. So the instruction genuinely
    needed tuning; the proof script now injects the REAL definition instruction so
    instruction changes are validated end-to-end.
  - **Done:** tuned research language shipped as a frozen new contract version
    `public-commentary-frontier-research@1.0.1` (1.0.0 kept frozen and intact;
    version-scoped `INSTRUCTIONS` map in `public-commentary-research.ts`). Proven
    across gpt-5.4 and claude-sonnet-5: attribution-led title/interpretation
    ("Per CNBC / Per the Kobeissi Letter, … this means the price of X could go up
    because …"), an actionable "watch the 10y/30y and TLT; be ready to go long"
    implication, metadata kept out of the prose, human source only. Battery green
    (1.0.0 digest frozen, pack 1.4.0 intact).
  - **Remaining in Phase 3:**
    1. ~~Create tracker pack `1.5.0` declaring `frontier-research@1.0.1`.~~ DONE
       (2026-08-24). `strategy-packs/public-commentary-tracker/1.5.0/` declares
       the `1.0.1` research contract (digest `29f5dd18…`, computed for the
       production frontier model `openai/gpt-5.4`, matching how 1.4.0 pinned
       1.0.0). Catalog regenerated (33 entries); the three hard-coded catalog
       expectation lists updated (`verify-strategy-packs.mjs`,
       `verify-strategy-pack-configuration-kinds.ts`,
       `verify-strategy-pack-owner-surfaces.ts`). Battery green. A monitor on
       `public-commentary-tracker@1.5.0` now uses the tuned language.
    2. ~~Inverse Cramer parity.~~ DONE (2026-08-24). Tuned language shipped as a
       frozen new contract version `inverse-cramer-frontier-research@1.0.2`
       (1.0.0/1.0.1 kept frozen; they share the original text, 1.0.1 was a limits
       fix). Preserves the registered inverse-direction policy. New pack
       `inverse-cramer@1.4.9` declares it (digest `f705d8c8…` for gpt-5.4).
       Real-model validated on a Cramer-bullish case: "Per Jim Cramer, he is
       bullish on NVDA …; the registered inverse policy points bearish, so the
       price could go down … Watch NVDA … be ready to watch for short setups."
       Battery green; all hard-coded catalog lists updated.
    3. Clean fallback when the brief job throws: today the occurrence fails with
       no alert, or falls through to the legacy metadata-in-title shape. Produce
       an attribution-led basic alert from the primary evidence instead.
    4. Review the brief→alert body mapping (`publicCommentaryAlertPresentationForBrief`):
       whyMatched = interpretation + implications[0] + uncertainty[0]; confirm no
       metadata leaks and the actionable implication leads.
  - Note: multi-signal is ALREADY the newspaper model architecturally — the
    research path runs ONE brief over up to 8 statements as `materialFacts`
    (→ artifact), with one headline title. 1.0.1 instructs leading the headline
    with the most material one.
- **Phases 4–6 — not started.**
- **eve upgrade — not started** (after phase 2; owner wants it for general eve
  improvements, do it carefully in a worktree).

## Current position (resume here)

Phases 1 and 2 are complete, committed as `4a900e1`, and **merged to `main`**
(fast-forward, pushed). They are **NOT deployed to Production** — owner chose to
hold the deploy (2026-08-24); git-push auto-deploy did not fire for this project,
so a live deploy would be a manual `vercel --prod` and is deferred until there is
a reason to ship. Phase 3 continues locally on branch
`feat/alert-shape-and-multisignal`.

Phase 3 language is DONE for both live commentary strategies (tracker pack 1.5.0
/ research 1.0.1, inverse-cramer pack 1.4.9 / research 1.0.2), committed on
`feat/alert-shape-and-multisignal` (`77eb913`, `bb214ac`, `147acdb`), battery
green, NOT merged to main yet. The ONLY remaining Phase 3 item is the clean
failure fallback (item 3 below). After that: Phase 4 (budget), Phase 5
(research-only + point live monitors at 1.5.0/1.4.9 + archive old packs), Phase 6
(live E2E), and the eve upgrade.

Fallback design (for whoever implements it): on a brief-job throw inside
`runInverseCramerExecutiveResearch`, build a minimal deterministic
`WorkspaceExecutiveBrief` from the signed subjects (speaker/account + statement +
registered direction + confidence + the human source), run it through the same
`materializeInverseCramerExecutiveOutput` path so it still yields a clean
attribution-by-account alert + a minimal artifact holding the metadata - never
the legacy metadata-in-title shape, never silence. Rethrow only if the fallback
materialization itself fails. Cover it with a worker test.

Next action: **Phase 3 — alert language/shape.** The real-model proof
shows the research lane already emits the target shape, so Phase 3 is about the
wiring around it: the brief→alert mapping keeps metadata/timestamp/API-source out
of the iMessage text (mostly already true on the research path), the newspaper
multi-signal model (strongest = headline, all signals in the artifact), and a
clean attribution-led fallback when the brief model call fails. Verify the
non-research legacy path is fully retired by Phase 5 so the bad
metadata-in-title shape can never be produced.

Reference: [[deterministic-worker-dispatch]] and [[research-lane-citation-visibility]]
in auto-memory capture the architecture and the citation root cause.
