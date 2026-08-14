Post-Bankruptcy Equities — Strategy Document


WHAT HAPPENS IN BANKRUPTCY

When a company files Chapter 11 bankruptcy:
1. The old stock usually goes to zero (or near zero). Old shareholders get wiped out.
2. The company restructures — it renegotiates or eliminates its debts.
3. A "new" company emerges from bankruptcy with a clean balance sheet.
4. New shares are issued. These new shares typically go to the old creditors (banks, bondholders, hedge funds) as compensation for the debt that was wiped out.

The company that comes out the other side is often fundamentally healthy — it has the same assets, the same customers, the same operations, but without the debt burden that was killing it.


WHY THIS IS AN ANOMALY

The new shareholders (former creditors) don't want to hold equity. They're debt investors — banks, credit funds, distressed debt hedge funds. Their mandate is to own bonds and loans, not stocks. When they receive equity as part of the restructuring, they sell it. Not because the company is bad, but because it doesn't fit what they do.

This creates the exact same dynamic as spin-offs and index removals: forced selling by shareholders who are exiting for non-fundamental reasons.

On top of that:
* Zero analyst coverage. The "new" company just emerged. No Wall Street analyst has initiated coverage. No research reports exist. It's invisible.
* No index inclusion. The company isn't in any index yet. No index fund owns it. No passive money flows in.
* Stigma. Investors see "bankruptcy" and assume the company is damaged goods. Many funds have policies that prohibit holding companies that went through bankruptcy, regardless of current fundamentals.
* Illiquidity. The new shares trade thinly because the shareholder base is small (just the former creditors) and shrinking (as they sell).

The result: a company with no debt, real assets, real cash flow, and a stock price depressed by forced selling, stigma, and neglect.


HISTORICAL PERFORMANCE

* Eberhart, Altman & Aggarwal (1999): Post-bankruptcy equities generated average excess returns of ~25% in the 200 trading days after emergence from Chapter 11.
* Gilson (1995): Companies emerging from restructuring showed significant operating improvements in the 2-3 years following emergence.
* More recent data (2010-2023): The pattern persists but is more variable. Average outperformance is harder to pin down because the universe is small (maybe 20-50 Chapter 11 emergences per year) and outcomes are bimodal — the winners win big, the losers re-enter bankruptcy.

Is it "up only" post-bankruptcy?
No. Roughly 15-20% of companies that emerge from Chapter 11 end up filing again within 5 years ("Chapter 22"). The failures tend to be companies that restructured their balance sheet but didn't fix the underlying business problem. The key is distinguishing operational problems (bad) from capital structure problems (fixable). A good company that took on too much debt is a great post-bankruptcy buy. A bad company that happened to also have too much debt is a trap.

This is exactly where the kill criteria and confidence layer from moody.md apply:
* P_real: Are the post-restructuring earnings real and sustainable?
* P_assets: Is the clean balance sheet genuine? What assets remain?
* P_mgmt: Did the board change? Is new management competent? (Bankruptcy often forces management changes.)
* P_catalyst: When will coverage initiate? When will former creditors finish selling? When might the company enter an index?


EDGE

1. Extreme neglect — no analyst coverage, no index inclusion, no institutional ownership, no media attention.
2. Forced selling by creditors creates mechanical price depression.
3. Stigma creates an emotional discount that has nothing to do with fundamentals.
4. Clean balance sheet (debt was eliminated or dramatically reduced) makes financial analysis simpler and more reliable.
5. Small universe — 20-50 companies per year. Feasible for deep analysis on each one.
6. The AI agent can read the restructuring plan, the disclosure statement, and the emergence 10-K to assess the "new" company's fundamentals before anyone else does.


APPROACH

Step 1: Track Chapter 11 emergences
* Monitor bankruptcy court dockets for companies that receive a confirmed plan of reorganization.
* Track the "effective date" — when the new company begins trading under its new ticker.
* Build a universe of all companies that emerged from Chapter 11 in the trailing 24 months.

Step 2: Pull the "fresh start" financials
* The emerging company files a "fresh start" 10-K with the SEC that shows the reorganized balance sheet.
* Pull this filing and extract: new total assets, new total liabilities (should be dramatically lower), cash on hand, revenue, operating income, FCF.
* Compare pre-bankruptcy metrics to post-bankruptcy metrics. Focus on operating performance (revenue, margins, OCF) — if these were stable through bankruptcy, the business itself is fine and only the capital structure was broken.

Step 3: Assess why the company went bankrupt
* This is the critical filter. Categorize:
  * Capital structure problem (too much debt, overleveraged acquisition, refinancing failure): GOOD candidate. The business was fine, the balance sheet was the problem, and that's now fixed.
  * Operational problem (declining revenue, obsolete product, lost customers, secular decline): BAD candidate. Bankruptcy fixed the debt but not the business. Likely to re-enter distress.
  * Litigation-driven (asbestos, opioid, patent): MIXED. If the litigation is fully resolved in the restructuring, the company emerges clean. If residual liability remains, proceed with caution.

Step 4: Monitor creditor selling
* Former creditors who received equity will file Form 4s and 13F/13Gs as they sell.
* Track the selling pressure. Heavy selling in the first 6-12 months is normal and expected.
* The opportunity window typically opens after the bulk of creditor selling is done (6-18 months post-emergence) but before analyst coverage begins and the stock re-rates.

Step 5: Apply valuation screen + confidence model
* Run the emerged company through the moody.md quantitative screen (P/B, EV/EBIT, FCF yield).
* These companies often screen absurdly cheap because the denominator (clean balance sheet) is strong and the price (depressed by forced selling) is low.
* Apply kill criteria: Is revenue declining? Is the industry in secular decline? Has the company been through bankruptcy before?
* Run the confidence layer with emphasis on P_catalyst (when will neglect end?) and P_real (are post-restructuring earnings sustainable?).


DATA SOURCES & APIs

Bankruptcy court filings:
* PACER (Public Access to Court Electronic Records): The primary source for all federal bankruptcy filings. Paid per page but inexpensive. Access at pacer.uscourts.gov.
* BankruptcyData.com (paid): Aggregated, structured data on Chapter 11 filings, plans, and emergence dates.
* BloombergLaw / Westlaw (enterprise, paid): Comprehensive legal databases with bankruptcy dockets.

SEC filings for emerged companies:
* SEC EDGAR (free): Fresh-start 10-K filings, subsequent 10-Qs, Form 4 insider transactions, 13F/13G institutional holdings.
* New ticker tracking: Monitor SEC for new CIK registrations associated with bankruptcy emergence.

Market data:
* Same as moody.md — Polygon.io, Alpha Vantage, IEX Cloud.
* Note: emerged companies often trade on OTC markets initially before uplisting to NYSE/Nasdaq. OTC data may require OTC Markets Group API.

Creditor/shareholder tracking:
* SEC EDGAR Form 4 (insider sales by new board/management)
* SEC EDGAR 13F filings (quarterly institutional holdings — track when distressed debt funds are reducing positions)
* 13D/13G filings (large shareholder disclosures)


WHAT TO WATCH OUT FOR

* "Chapter 22" risk: ~15-20% of emerged companies re-file. The kill criteria must filter for operational viability, not just balance sheet cleanliness.
* The new equity might be illiquid and hard to trade. Position sizing must account for the inability to exit quickly.
* Restructuring plans sometimes leave residual liabilities (pension obligations, environmental cleanup, ongoing litigation). Read the plan carefully — not all debt gets eliminated.
* New management post-bankruptcy is not always better. Sometimes the same management that drove the company into bankruptcy stays on. Check whether the board and C-suite changed.
* Tax implications: Emerged companies often have massive Net Operating Loss (NOL) carryforwards, which can shelter future income from taxes. This is a hidden asset that makes them more valuable than they appear, but NOLs can be limited by ownership change rules (Section 382). The agent should check for 382 limitations in the emergence filings.
