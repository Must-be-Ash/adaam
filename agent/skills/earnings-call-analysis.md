---
description: Analyze earnings-call transcripts and compare management language across quarters using sourced evidence, deterministic metrics, fundamentals, and insider filings.
---

# Earnings-call language analysis

Use this procedure for a single-call review, quarter-over-quarter comparison, company
history, peer comparison, or language-based screen.

## 1. Establish comparable evidence

1. Identify the company, ticker, fiscal quarter, call date, and transcript source.
2. Prefer at least the current and immediately preceding calls. For a baseline, use the
   trailing four comparable quarters; use eight to twelve when available.
3. Separate prepared remarks from Q&A. If boundaries or speakers are uncertain, state
   that before drawing conclusions.
4. Compare like with like: Q&A to Q&A and prepared remarks to prepared remarks. Do not
   treat a shorter call or a changed transcript format as a language shift.
5. When a user supplies a URL or attachment, inspect that source first. Use FMP to fill
   missing quarters, not to silently replace the user's source.

## 2. Quantify language

Run `calculate_language_metrics` on comparable sections. Report raw coverage and
normalized rates, not just directional labels.

Evaluate:

- Hedging: may, might, could, approximately, roughly, we believe, we hope, and similar
  qualification.
- Specificity: numbers, percentages, currency amounts, ranges, dates, timelines, named
  products/customers, and measurable commitments.
- Confidence: explicit commitment and visibility language, interpreted in context.
- External attribution: macro, FX, supply-chain, regulatory, weather, and industry
  explanations. Check whether peers experienced the same issue before calling it blame.
- Sentiment and uncertainty changes. Boilerplate repetition is weak evidence.

Deterministic phrase counts are descriptive. They do not by themselves establish intent,
evasion, or future performance.

## 3. Review Q&A qualitatively

For each material analyst question:

1. State the question's requested information.
2. Classify the answer as direct, partial, deflected, or unanswered.
3. Quote the shortest passage that supports the classification.
4. Note whether management supplied the requested number, yes/no position, timeframe,
   or causal explanation.
5. Compare recurring questions across quarters. A new refusal to disclose a previously
   reported metric is stronger evidence than a consistently undisclosed metric.

Calculate an evasion ratio only when question boundaries and classifications are
reliable. Include the numerator, denominator, and classification criteria.

## 4. Evaluate guidance

Extract every material forward-looking statement and classify it as:

- specific: measurable range, amount, milestone, or date;
- directional: up/down, improving/softening, or qualitative trajectory;
- vague: optimism or caution without a measurable commitment;
- withdrawn or declined.

Compare range width, horizon, assumptions, and wording with prior guidance. Verify
whether prior guidance was met before treating confidence language as credible.

## 5. Cross-check public evidence

- Use FMP transcript dates to establish comparable quarters, then retrieve only the
  transcript periods needed for the analysis. Use the company profile to map the ticker
  to identifiers such as CIK.
- Use SEC submissions and company facts to verify reported results and locate 10-Q,
  10-K, 8-K, and Form 4 filings.
- Use FMP insider-trade searches and statistics to screen for activity, but verify every
  material conclusion against the linked SEC Form 4 filing. Distinguish open-market
  purchases (transaction code P) from grants, option exercises, tax withholding, gifts,
  automatic-plan transactions, and dispositions. Report transaction date, filing date,
  code, shares, price, insider role, and source.
- Call activity an insider-buy cluster only when at least two distinct corporate insiders
  report open-market purchases in the same issuer within a stated window, normally 30
  days. Show the window, number of distinct insiders, aggregate shares and disclosed
  value, and any excluded non-purchase transactions.
- Treat insider buying as confirming evidence only when it occurs after the call within
  the requested window and is economically meaningful in context.
- For Senate or House activity, use the FMP congressional-disclosure operations and
  identify the chamber, member, transaction date, disclosure date, owner, asset, action,
  and disclosed value range. These are STOCK Act disclosures, not corporate-insider
  filings; values are often ranges and reports can lag the transaction. Do not describe
  them as exact or real-time holdings.
- Use FMP profile/transcript data and SEC filings as separate sources. Call out conflicts
  rather than choosing one silently.

## 6. Synthesize, with counterevidence

Use this response order:

1. **Conclusion and confidence** — improving, stable/mixed, or deteriorating, with a
   low/medium/high evidence-confidence label.
2. **Strongest changes** — the three to five most material shifts with quotes and metric
   deltas.
3. **Q&A and guidance** — directness, evasions, guidance specificity, and prior accuracy.
4. **Fundamental and insider cross-check** — what corroborates or contradicts the
   language signal.
5. **Counterevidence and alternative explanations** — seasonality, leadership changes,
   one-time events, call length, provider quality, or sector-wide conditions.
6. **Coverage and sources** — quarters analyzed, missing history, and source URLs.

Do not manufacture a precise probability. If a broader confidence model is supplied,
show how each evidence item changes it and keep the adjustment within the model's stated
rules.
