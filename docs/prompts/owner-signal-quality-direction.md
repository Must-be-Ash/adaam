# Owner direction — what a signal alert must be

Recorded 2026-08-23 from the owner, in their own words, with the current state
of each item. This is the product target for commentary alerts. Read it before
changing anything about how an alert is composed.

## The ask, verbatim

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

> "'First run, covering the last 6 hours' this is useless information for the
> user and they do not need to see this. it's redundant"

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
> left behind and all of that should have been taken care of from migration. if
> there are issue, gaps and bugs you need to address them all."

> "backlog is only for wishlist items or things that can be deferred and don't
> need to be dealt with, such as hardcore hardening. I don't want anything that
> should be addressed to be backlogged going forward."

## Rules that follow

1. An alert is a trading edge, not a pipeline report. Headline plus two or
   three sentences. Nothing about runs, windows, cadence, counts, or how the
   system reached the answer.
2. Provenance is never user-facing. No finding ids, fact-revision ids,
   interpretation ids, digests, character spans, revision numbers, internal
   source identifiers, or API endpoints in the message. All of it stays on the
   durable record and in the agent-facing turn context.
3. Confidence is a metric, not prose. It rides the signal label because it will
   later gate autonomous execution (above ~80% may place an order).
4. Research is strategy-declared. A statement that is a STARTING POINT gets a
   research lane; a statement that IS the conclusion does not.
5. Research seeks the bigger picture, never validation. Confirming the speaker
   said it, or that a quoted figure is real, is already settled by the signed
   citation and adds nothing to a decision.
6. No pack-ID behaviour branches in shared plumbing. Pack ids stay valid as
   provenance, registry keys and binding identity only.

## Addressed

- **Executive format** (`6fbb28b`). Title is the signal:
  `SPX · bearish · medium confidence · weeks · uncorroborated`. Body is the
  finding plus at most one caveat. Removed: "First run, covering the last 6
  hours", "N statements qualified", "one summary alert was emitted to avoid
  spam", the classification enums restating direction, and the full uncertainty
  and counterevidence lists. Further signals in a window are a `+N more` count
  on the title.
- **Provenance out of the message** (`6fbb28b`, `bd6a1f1`). Finding ids,
  fact-revision ids, interpretation ids, spans, digests and revision numbers
  dropped from the card; the raw ISO instant made readable; the internal source
  identifier dropped. A fact's `source` (where data was polled from) and a
  finding's `provenance` (what it cites) were conflated, which put
  `https://api.x.com/2/users/<id>/tweets` under "Sources:" - now separated, so
  the card cites the statement.
- **Research lane is declaration-driven** (`dff0526`). The literal
  `packId !== "inverse-cramer"` gate is gone, with a source guard that fails if
  it returns. Audited all five pack ids across generic modules: the rest are
  strategy workers checking their own binding, which the roadmap permits.
- **Tracker research contract** (`d25c700`). `public-commentary-tracker@1.4.0`
  declares `public-commentary-frontier-research@1.0.0`, instructed to spend its
  bounded pass on surrounding context and explicitly NOT on verifying the
  statement. Cramer and a Trump-on-Iran strategy declare no lane, which is now
  a cheap deliberate choice rather than a hardcoded denial.
- **Failure attribution** (`0ceeafa`, `828f1fc`, and the pause fix). Occurrence
  failures, recovery failures and acquisition failures carry `packId`;
  `lastErrorCode` survives an auto-pause instead of being overwritten;
  `completion_missing` names how many tools the child called, which it reached
  last, and whether that tool errored.
- **Cross-strategy guard**. `npm run verify:strategies` runs all 38
  per-strategy suites in ~90s. Held at 37/38 through every change above, the
  one failure being a pre-existing sec-ipo DNS gate.

## NOT addressed

1. **The owner has never received an executive brief or an artifact.** This is
   the headline gap. The research lane resolves in Production - proven by the
   $3.50 reservation, which is only taken when the lane is active - but no run
   has produced a brief, so no artifact publishes and the card never shows
   `Readable report: <url>`.
2. **Root cause found: `citation_invalid`** (2026-08-23 20:05, pack 1.4.0).
   The durable semantic store holds it directly:

       "definitionId": "public-commentary-frontier-research",
       "quarantineCodes": ["citation_invalid"]

   So the child now DOES complete - it produced a brief with citations - and
   the citations failed validation. `hybrid_quarantine_blocking` was the
   downstream health notification, not the cause.

   The mechanism is exact-citation matching in `hybrid-evidence-semantic.ts`.
   With `requireExactCitations: true`, the model's citations must equal the
   validator's `assertionCitations` set exactly - same locators, no duplicates,
   none missing. `publicCommentaryResearchValidationContract` returns one
   assertion citation per evidence item, so the child must echo each evidence
   locator precisely; it did not.

   NEXT STEP: the fix is in the contract INSTRUCTION - tell the child it must
   cite every statement in the signed bundle, echoing each locator exactly.
   The instruction is digest-covered, so that means
   `public-commentary-frontier-research@1.0.1` plus tracker pack `1.4.1`.
   Confirm against the child's actual citations first rather than assuming the
   count is what mismatched; the store holds the quarantined job records.

   Do NOT weaken the exact-citation rule to make this pass. It exists so every
   assertion in a brief is grounded in signed evidence.
3. **The headline is still the model's rationale, not a written headline.** The
   classifier returns `rationale`, `confidence`, `horizon`, `marketView`,
   `uncertainty[]`, `counterevidence[]` - there is no `headline` field. Getting
   a true headline needs a new classification contract version.
4. **The direction disclosure is verbose.** "This direction is produced by the
   Configured public-commentary impact hypothesis policy." is registered policy
   text; shortening it is a policy change, not a presentation change.
5. **`Market` as a fallback target** when the classifier names no tradable
   asset. Honest, but weak as a headline.
6. **Only the strongest signal in a window is sent.** A `+N more` count says so,
   but the others are not delivered anywhere. Their natural home is the artifact
   that does not yet exist.
7. **Tracker Live runs pack 1.3.1** (restored 2026-08-23 20:12), the proven version without a
   research lane, so the owner's monitor keeps working. 1.4.0 is committed and
   deployed but bound to nothing live.

## Do not regress

- The cited link must survive truncation (`verify:public-commentary-signals:sprint-3`).
- `uncorroborated` on the title is a disclosure, not decoration: nothing outside
  the single cited post supports the read.
- Counters carry no identity; attribution belongs in the bounded `console.error`.
- Run `verify:strategies` before and after any shared-module change.
