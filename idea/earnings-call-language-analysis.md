Earnings Call Language Analysis — Strategy Document


WHAT THIS IS

Every public company holds a quarterly earnings call — a live phone/webcast where the CEO and CFO present results and then answer questions from analysts. These calls are transcribed and publicly available.

The numbers from the quarter are already in the 10-Q filing. What the earnings call adds is the unscripted, real-time language of the people running the company. How they talk — the words they choose, the questions they dodge, the confidence or hesitation in their phrasing — contains predictive information that the financial statements don't capture.

An AI agent can read every small-cap earnings call transcript, every quarter, across the entire universe. No human can. That's the edge.


WHY LANGUAGE IS PREDICTIVE

Research backs this up:

* Loughran & McDonald (2011): Developed a financial sentiment dictionary. Found that increased use of negative/uncertain words in 10-K filings predicts lower future returns.
* Li (2010): Forward-looking statements in MD&A predict future earnings. More specific forward-looking language = more reliable earnings.
* Mayew & Venkatachalam (2012): Managerial vocal cues (tone, hesitation) during earnings calls predict future financial performance — even after controlling for the actual words.
* Earnings call NLP studies (2016-2023): Multiple papers show that changes in linguistic patterns between consecutive calls predict earnings surprises 1-2 quarters ahead.

The key insight: it's not the absolute tone that matters — it's the CHANGE. A CEO who always sounds cautious isn't signaling anything. A CEO who was specific and confident last quarter but is now vague and hedging is telling you something.


WHAT THE AGENT LISTENS FOR

Deterioration signals (negative — things are getting worse):

1. Hedging language increase
* Increased use of: "approximately," "roughly," "around," "we believe," "we expect," "we hope," "potentially," "may," "might"
* Compare the density of hedging words this quarter vs. trailing 4-quarter average
* A spike in hedging density while reporting "good" numbers = management is worried about next quarter

2. Specificity decline
* Last quarter: "We signed 14 new enterprise contracts with an average deal size of $2.3M"
* This quarter: "We continue to see strong interest from enterprise customers"
* The shift from specific metrics to vague qualitative language often precedes earnings declines

3. Question evasion
* Analyst asks: "Can you give us the churn rate this quarter?"
* CEO answers: "We're really pleased with customer retention and continue to invest in customer success..."
* That's a non-answer. The agent should track the ratio of direct answers (includes a specific number or direct yes/no) vs. deflections (restates the question, pivots to a different topic, gives a qualitative non-answer)
* Rising deflection ratio = management is hiding something

4. Blame shifting
* Increased attribution of problems to external factors: "macro headwinds," "supply chain challenges," "industry-wide pressure," "foreign exchange impact"
* Some external blame is legitimate. But a pattern of increasing external blame while peers in the same industry are performing fine = the problem is internal

5. Forward guidance changes
* Narrowing guidance range (e.g., from "$4.00-4.20 EPS" to "$4.00-4.05") = management is less confident
* Withdrawing guidance entirely = serious concern
* Shifting from specific annual guidance to "directional commentary" = they don't want to commit to numbers they might miss

Improvement signals (positive — things are getting better):

1. Increasing specificity
* More concrete metrics, named customers, specific contract values, precise timelines
* Especially powerful when a company that was previously vague starts getting specific — it means they now have good things to report

2. Proactive disclosure
* Management volunteers information that wasn't asked for: "I want to highlight that our backlog has grown 30% since last quarter"
* When executives go out of their way to share data, it's usually because the data is good

3. Confident forward language
* "We are confident," "we expect to deliver," "our pipeline is strong and visible"
* Compare to prior quarters — a shift from cautious to confident is the signal, not the absolute level

4. Direct answers to hard questions
* When a CEO directly addresses a bear case: "I know some of you are concerned about customer concentration. Let me give you the numbers..."
* Willingness to engage with tough questions = confidence in the answers

5. Insider buying within 2 weeks of earnings call
* If the CEO gives a confident earnings call AND buys stock within 2 weeks, the language and the action are aligned
* This cross-reference with the insider buying cluster strategy is very high-signal


HOW THE AGENT PROCESSES THIS

Step 1: Ingest transcripts
* Pull earnings call transcripts for every company in the screening universe, every quarter.
* Separate the transcript into two sections: prepared remarks (scripted) and Q&A (unscripted). The Q&A section is more informative because management can't fully script it.

Step 2: Compute linguistic metrics (per call)
* Hedging word density: count of hedging words / total words
* Specificity score: count of specific numbers, percentages, dollar amounts, named entities / total sentences
* Evasion ratio: count of analyst questions receiving non-answers / total analyst questions
* Sentiment shift: compare overall sentiment (positive vs. negative word ratio) to the prior quarter's call
* Forward guidance confidence: classify forward-looking statements as specific, vague, or withdrawn

Step 3: Compute quarter-over-quarter change
* For each metric, calculate the delta from the prior quarter's call
* Flag companies where 3+ metrics deteriorated simultaneously
* Flag companies where 3+ metrics improved simultaneously

Step 4: Cross-reference with fundamentals
* A company where language is deteriorating BUT current-quarter financials look fine = potential leading indicator of future earnings decline (short signal or avoid signal)
* A company where language is improving BUT the stock is depressed from prior bad quarters = potential recovery signal (buy signal)
* Language improving + insider buying + cheap on valuation screen = highest-confidence opportunity

Step 5: Feed into the confidence model
* Language analysis feeds primarily into P_real (are current earnings sustainable?) and P_catalyst (is the trajectory improving or deteriorating?)
* A company with deteriorating language gets P_real reduced by 10-20 points
* A company with improving language + specific forward guidance gets P_catalyst increased by 10-15 points


DATA SOURCES & APIs

Earnings call transcripts:
* Seeking Alpha (free with limits): Transcripts for most US public companies. Can be scraped or accessed via unofficial APIs.
* The Motley Fool Transcripts (free): Another source for earnings call transcripts.
* Financial Modeling Prep (FMP) API (paid, affordable): Structured earnings call transcript data via API.
* Refinitiv / Bloomberg (enterprise, paid): Full transcript archives with structured data.
* Earnings Call Edge / CallMiner (paid, specialized): NLP-ready transcript data.

For building the NLP layer:
* The agent (LLM) itself IS the NLP layer. You don't need a separate sentiment model. Feed the transcript sections directly to the AI agent with specific prompts:
  - "Compare the specificity of forward-looking statements in this Q&A vs. the prior quarter's Q&A"
  - "Identify every analyst question that received a non-answer or deflection"
  - "List every hedging word or phrase and calculate density per 1000 words"
  - "Rate management's confidence on a 1-10 scale with specific evidence for the rating"

SEC filings (for cross-reference):
* SEC EDGAR (free): 10-Q for the same quarter's actual numbers, to compare what management said vs. what the numbers show

Insider transaction data (for cross-reference):
* SEC EDGAR Form 4 (free): Check if insiders bought/sold within 2 weeks of the earnings call


EDGE

1. Scale: No human reads 2,000+ small-cap earnings call transcripts per quarter. The AI agent can.
2. Memory: The agent can compare this quarter's call to the prior 8-12 calls for the same company and detect gradual linguistic shifts that would be invisible to someone reading a single transcript.
3. Cross-company patterns: The agent can detect when an entire sector's management teams are simultaneously hedging language — that's an industry-level warning signal.
4. Speed: Transcripts are available within 24 hours of the call. The agent can process and flag within hours. Most small-cap investors won't read the transcript for weeks, if ever.
5. Independence from numbers: This signal is completely independent of the quantitative screen. It adds a non-correlated data stream that measures trajectory and intent, not just current-state valuation.


WHAT TO WATCH OUT FOR

* Charismatic CEOs can sound confident even when things are bad. The agent should weight actions (insider buying, guidance specificity, actual results vs. prior guidance) more than tone.
* Boilerplate language is noise. Many companies use identical prepared remarks templates. The signal is in the Q&A section and in the changes between calls, not the absolute phrasing.
* Transcript quality varies. Some providers miss words, combine speakers, or omit Q&A sections. Cross-reference transcript sources when possible.
* This strategy requires multiple quarters of data before it generates reliable signals. You can't evaluate a single call in isolation — you need the trajectory. Budget 2-3 quarters of data collection before the system starts producing actionable signals.
