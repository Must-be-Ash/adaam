I am trying to create a application where we have a platform that provides the foundation needed for multiple different strategies to be built on top of it. we ultimately want to be channel agnostic but right now we're just focussing on making the interaction work via iMessage. The goal is to basically have a platform where there is shared plumbing for different purposes, such as:
- doing web search
- getting data from social media channels
- pulling in RSS feeds
- finding and extracting data from public resources
- scraping or calling web pagesand basically having the foundation for different agents to be able to monitor for different events. Then I want to be able to set different durable agents in parallel. So that each agent would have its own task and purpose. each of these agents would have their own strategies, and based on those, we want to give them access to plumbing and tools for their own needs. So even though The plumbing is shared. They should be able to utilize that to their own needs and advantage. For example, a background strategy agent that is supposed to copy trade Nancy Pelosi might use the same pipeline as the one trying to track another United States Representative But it would be looking for different information and extracting different data and running a different strategy. Or, for example, if we have a social listening tool that is being used to monitor X, that should be able to be used for one strategy, which, for example, could be Inverse Cramer Where we are looking at what Jim Cramer is he saying something about a market, a stock, or an asset, and if he's talking positively about them or negatively about them so we short what he's bullish on and long what he's bearish on but the same pipeline should be used for other purposes, such as tracking Donald Trump's account and seeing if he's saying something negative about Iran or things that are indicating there is an escalation, then we'll go long oil. Or if things sound positive and indicate that there might be peace, we go short oil.
Eve’s North Star is an open-source platform for running many specialized, isolated investment agents under one personal Eve.
Eve is the shared platform: connections, data fetching, provenance, tools, scheduling, budgets, monitoring, findings, alerts, and guarded Coinbase access.
Strategy packs are applications: each defines its own thesis, sources, watchlists, instructions, interpretation rules, schedules, outputs, and evaluations.
Strategies reuse plumbing differently: multiple strategies can use the same X, SEC, earnings, or future YouTube/RSS connection without duplicating the integration.
Each strategy has its own durable workspace: its task, configuration, findings, monitors, and alerts survive chat resets.
Isolation is absolute: no strategy sees another strategy’s instructions, conversations, findings, tools, or private state.
Models research and recommend; the owner decides: strategy conclusions never automatically authorize real Coinbase actions but we might add that in future
The repository is forked and self-hosted: each person deploys their own Eve with their own credentials, strategies, data, and capital.

Here is my goal and what the end state of the working app should look like:
I have one active chat session, which is the workspace that I've set to active, and I will talk to that session and he would respond to me or do the things I've asked it to. meanwhile there could be background agents running in parallel that I've set them in place and they would be each running their own, given task and monitoring for signals (for example IPO filling agent and another agent being inverse cramer and so on) and once they found a signal, they could reach out to me and text so I see what they found without that message reaching me cross polluting the active workspace's agent.

For example, say I've said the active session to main. meanwhile 'inverse cramer' agent finds a signal. it should be able to text me even thou the active session is set to 'main' without the message from 'inverse cramer' agent becoming part of the 'main' agent's context and it thinking it's being asked for something. so multiple agents should be able to run in parallel, doing their own thing in the background. Each of them should be able to text me when they find signals. the texts coming my way should not interfere with the context window of either of them and i get the 'discuss' mini app interface prompting me to change my workspace session if i want to talk about the signal with the agent that sent me a report

durable monitors should be able to use tools, paid tools, web search and the same resources available via interactive Eve should they need to look for more information without my explicit approval. the budget set for these durable monitors with i referred to his background agent should cover this as well so when i set a budget that means what i wanna spend on these background agents in total not just inference. And the reason I've been calling them background agents is that I want them to have agency. yes I don't want them to run 24/7 and just waste compute so we are using 'sleep' and waking them up when there is an event or signal but then they should get to work to help me makes sense of signals and help me understand what they indicate if there is any materiality to it. So let's say, for example the pre-deterministic code fails, the LLM (cheap ones that we have for parsing like Haiku or Flash) should step in to extract the data our parser failed to get, and then the frontier model should stay in to see if there is any material signal, and based on his reasoning, determine if this is something that should be researched further or just report it as a signal he wants to flag. If it decides this is something that it should look further into it could then utilize tools to provide supplementary information that helps the human make sense of the signal or understand what it indicates by putting different pieces together or just for its own sake to understand how to make sense of that signal so it can communicate it with a person or perhaps he's trying to see if there is anything else to it and it says that's the only thing so it just says the signal.

A durable monitor wakes only for a scheduled/source event.
Deterministic extraction runs first. If retrieved content is valid but the parser cannot understand it, a cheap model performs bounded extraction. Or if the information doesn’t need a parser and a model is needed to understand if there is any materiality we don’t use a parser. So for example, in the case Jim Cramer or Trump tracker we need a model to understand if a tweet has any material signal in it not a deterministic extraction because we need semantic understanding, and there is no chance on earth we can pre-configure and hardcodet every possible ticker or form of sentences pretend.
Candidate facts go to a frontier model for materiality judgment.
The frontier model may autonomously use web search, paid research tools, document retrieval, and artifact publishing when additional context is useful.
Model inference and paid-tool costs share the workspace’s total budget envelope, with reservations reconciled to actual spend.
Results are concise executive briefs: material facts, interpretation, implications, uncertainty, and direct sources. Longer multi-source analysis becomes a readable artifact.
This will be implemented as shared monitor plumbing, then adopted incrementally by IPO, commentary, Congressional, and other strategy packs so each rollout has regression proof.

it sleeps, wakes on schedule or is waken by events/signals (like webhooks bringing in new information or data), evaluates a signal, decides whether further investigation is worthwhile, researches within budget, and texts you a useful explanation.

Here's my desired final form:
Eve provides reusable plumbing; strategy packs behave like isolated applications built on that platform; and each application remembers its durable task without retaining old chat history or leaking context between strategies.

I want Eve to become a reliable platform for many isolated investment-strategy applications.
The ultimate architecture
Shared platform plumbing handles reusable capabilities:
Fetching and authenticating data sources
X/Twitter, SEC, earnings, and future connections
Normalization, provenance, and canonical facts
Scheduling, monitoring, budgets, findings, and alerts
Reusable parsing and interpretation capabilities
Workspace lifecycle and isolation
Strategy packs define how that plumbing is used:
Who or what to monitor
Sources and tools required
Thesis, instructions, topics, and watchlists
Strategy-specific interpretation and decision rules
Assets affected and expected direction
Schedules, thresholds, output schemas, and evaluations
Evidence, counterevidence, and abstention requirements
Strategies must remain meaningfully different and optimized for their specific task. We should not have hardcoded strategy identities from in shared infrastructure, but maintain strategy-specific behavior.
For example, Inverse Cramer and Trump/Iran Oil can use the same X plumbing while monitoring different people, interpreting different language, and producing different asset conclusions.
A strategy using existing plumbing should be addable primarily through its pack. If a strategy genuinely needs new plumbing, such as YouTube transcripts, that reusable connection is added once as shared infrastructure and then referenced by any strategy that needs it.
Durability and continuity
Each strategy workspace must retain its own ongoing task and operational state:
Installed strategy and configuration
Goal, thesis, and watchlist
Open questions
Monitored sources
Enabled or paused monitors
Schedules and checkpoints
Findings and alerts
When you explicitly tell Eve to change something, such as “add NVDA to the watchlist” or “start monitoring this supported source,” Eve must persist that change during the same turn before claiming it will remember.
Start fresh clears only:
Old chat messages
Temporary conversational context
Temporary model reasoning
It must not clear the strategy’s mission or operational state. The new chat generation receives a bounded summary of that workspace’s durable state so it can continue the task without receiving the old transcript.
Every workspace remains strictly isolated. One strategy must never see another strategy’s instructions, watchlist, findings, alerts, configuration, or chat history.

/Users/ashnouruzi/dev/adaam/specs/mermaid-diagram.svg
Agents should be able to run in parallel and be durable and in the background so I could set multiple agents strategies and they could all be running without interfering with each other or polluting each other's context window. Each agent should have access to the part of the plumbing it needs and be able to use it in the way it needs to. And each agent should have access to the tools and resources it requires for it to do its job. The agent should be running regardless of the workspace session I'm on. So for example, I could set up Inverse Cramer strategy agent and Nancy Pelosi copy trading agent, and they both should be continuously running even when I switch my workspace to another session like IPO tracking strategy. And when I have, for example, IPO tracking set as the active workspace, I am communicating with that agent and interacting with that agent and the message. I'm sending to that agent in that workspace session should not pollute the context window of the other background agents (ie. Nancy Pelosi copy trading agent and Inverse Cramer strategy agent) but those background agent (Nancy Pelosi and Inverse Cramer) should be able to message me when they find material events and those messages should not pollute the context window of the active session agent (eg IPO tracking agent) or prompt the currently active session agent.
- Deterministic parser handles known structure
- Cheap model recovers or extracts difficult content when needed and we use these for fall backs when deterministic parse are not suited or fail
- Frontier model interprets meaning, patterns, implications, and forecasts
- Frontier model reasons and goes to do further research (using tools and web search) if needed and helps the user make sense of signals or understand what they indicate and what are actionable items
- The model presents the information in a presentable manner and without being redundant or verbose but more like executive summary that communicate the important details instead of a bloated report, that is too long to read

## What a signal must become — the ultimate use case (added 2026-08-23)

The whole app exists to be an assistant for traders: to find and identify
signals, understand what they mean or indicate, and turn that into something
actionable. It should be that simple to receive information, make sense of it,
and act.

The flow: an event or signal wakes an agent — detected either by the worker's
deterministic parser or by the LLM's semantic understanding that something is
material. From there the agent either (a) reasons about the signal and messages
me over iMessage explaining what it means or indicates, or (b) decides the
signal is only a starting point and it is worth researching to build the fuller
picture, then researches within budget and reports back better intelligence.

Whether research is needed depends on the strategy, and the strategy pack should
already know its own answer:

- Some strategies are the signal itself and need no research. Inverse Cramer:
  Cramer is bullish → we are bearish, done. Trump/Iran oil: Trump signals peace
  → bearish on oil, done. The pack knows the ask is clear and does not research.
- Some strategies need research to know what the signal even means. An IPO
  filing on its own does not tell me what to do; the agent should research the
  filing's disclosures and supplementary sources to work out the implication.
  Every pack has the research lane available; the agent decides per signal
  whether to use it, based on the prompt and ask we gave it.

The report is about the implication, not the raw event. The final output reads
like: "[source] just reported [headline]; according to [supplementary source]
this means the price of [asset] could go up. I would keep an eye on
[stats/sources] in the coming days and be ready to [buy/sell or long/short]."
It does not have to match that template exactly — it communicates the goal.

For an IPO the report may not even restate the filing. It might say: "from
[company]'s IPO registration I found their biggest capex is [commodity]; I
looked up [supplementary sources] and they point to [commodity] outperforming
this coming quarter, so keep an eye on [commodity] and be prepared to long it."

Older non-research pack versions were iterations on the way here; they are not
kept alive. All packages have access to research, and the app is research-only
going forward. See `docs/prompts/owner-signal-quality-direction.md` for the
alert-shape notes that go with this.

### How the alert must be formatted (added 2026-08-24)

The iMessage text is only the signal and what it means, written the way a person
would say it. Everything else — the machinery — moves into the artifact or off
the message entirely.

- Lead with the attributed source, not a description of the post. If the post
  says "per CNBC", the alert opens "Per CNBC, …" — never "The statement
  discusses potential …".
- Keep OUT of the user-facing text: the direction/confidence/horizon/
  corroboration labels (e.g. "Market · bullish · medium confidence · weeks ·
  uncorroborated"), the observed timestamp ("Observed Aug 24, 2026, 12:05 PM
  UTC"), and any machine/API source such as https://api.x.com/2/users/…/tweets.
- Those metadata labels (direction, confidence, horizon, corroboration) belong
  in the artifact. Confidence in particular is the score that will later gate
  autonomous trading, so it is a metric, not message text.
- The only source shown to me is one I can open — the human page (e.g. the x.com
  post), not the polling endpoint. If the post already names its source
  ("per CNBC"), that attribution is enough on its own.
- The artifact carries the supplementary picture I need to decide — for the
  Treasury post, that the $950B General Account is far larger than what was
  tapped in prior years, and how it compares — not a restatement of the post.

Worked example. Tweet (Kobeissi Letter): "BREAKING: The US Treasury is
considering using its $950 billion General Account to help fund its increased
purchases of long-term government bonds, per CNBC." The alert should read:

"Per CNBC, the US Treasury is considering tapping its $950B General Account to
fund bigger long-term bond buybacks; per the Kobeissi Letter this means the
price of long-term US Treasuries could go up. I'd watch the 10-year and 30-year
yields (and TLT) in the coming days and be ready to go long long-duration
Treasuries."

— with the artifact holding the supplementary context and the metadata, and one
human source link (the x.com post). Nothing else in the text.
