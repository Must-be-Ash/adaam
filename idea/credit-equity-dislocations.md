Credit-Equity Dislocations — Strategy Document


HOW THE SAME COMPANY CAN HAVE TWO DIFFERENT PRICES

Yes. The same company is valued simultaneously in two completely separate markets, by two completely separate groups of investors, using two completely different frameworks.

The stock market prices the company's EQUITY — what's left over after all debts are paid. Equity investors are optimists by nature. They buy growth narratives, momentum, and future potential. They panic fast and sell on headlines.

The bond market prices the company's DEBT — the loans the company has taken out. Bond investors are pessimists by nature. They don't care about upside. They only care about one question: "Will this company pay me back?" They analyze cash flow, collateral, and covenants. They panic slow and sell on fundamentals.

These two markets often agree. When a company is healthy, the stock trades at a reasonable valuation and the bonds trade near par (100 cents on the dollar). When a company is distressed, the stock crashes and the bonds trade at a discount.

But sometimes they disagree. The stock crashes (equity investors panic) while the bonds barely move (bond investors see no credit risk). Or the bonds sell off (credit analysts see real trouble) while the stock holds up (equity investors are in denial).

When they disagree, one of them is wrong. And the bond market is right more often, because bond investors have contractual protections (covenants, collateral, seniority in bankruptcy) and do deeper fundamental analysis. They're paid to be paranoid.


THE ANOMALY

Scenario A — Bonds say "fine," stock says "dying":
* A company's stock drops 50% on a bad earnings report or sector panic.
* But its bonds are still trading at 95-100 cents on the dollar with tight credit spreads.
* The bond market is telling you: "This company can pay its debts, it has adequate cash flow, we see no bankruptcy risk."
* The stock market is telling you: "This company is in trouble."
* Someone is wrong. Historically, the bond market is right ~65-70% of the time in these disagreements.
* This is a potential buying opportunity in the equity.

Scenario B — Bonds say "trouble," stock says "fine":
* A company's stock is holding steady or even rising.
* But its bonds are dropping, credit spreads are widening, CDS prices are rising.
* The bond market is telling you: "This company may not be able to pay its debts."
* The stock market hasn't noticed yet — or is in denial.
* This is a potential short signal or an exit signal if you hold the stock.
* Enron's bonds started deteriorating months before the stock collapsed. Same with Lehman.


WHY THIS IS UNDEREXPLOITED

Most equity investors don't look at bond markets. Most bond investors don't trade equities. The two communities read different research, use different platforms, and attend different conferences. The data exists to compare them, but very few participants actually do the cross-referencing systematically.

Institutional quant funds increasingly monitor this, but primarily in large-cap liquid names. In the small/mid-cap space where this system operates, the dislocation signal is largely unmonitored.


HISTORICAL PERFORMANCE

* Friewald, Wagner & Zechner (2014): Credit market information predicts equity returns. Stocks whose credit spreads tighten (bonds say "improving") outperform by ~5-8% annually.
* Collin-Dufresne, Goldstein & Martin (2001): Changes in credit spreads contain information not fully reflected in stock prices for weeks to months.
* The signal is strongest during periods of market stress (2008, 2011, 2020, 2023) when emotional divergence between the two markets is greatest.


EDGE

1. Cross-market analysis is rare — equity-only investors are the majority and they ignore bond signals entirely.
2. In small/mid-cap companies, the dislocation can persist for weeks or months because there are fewer arbitrageurs.
3. The AI agent can monitor both markets simultaneously across thousands of companies, which no human analyst does.
4. Combined with the other screens (insider buying, valuation metrics, news), a bond-equity dislocation adds a completely independent data stream to the confidence model.


APPROACH

Step 1: Build the paired universe
* For each company in the screening universe, determine if it has publicly traded bonds or loans.
* Not every company has traded debt. Focus on companies that do — this naturally filters toward mid-caps and larger small-caps (companies big enough to issue bonds).

Step 2: Monitor credit signals
* Credit spread: The yield on the company's bond minus the yield on a risk-free Treasury bond of similar maturity. Wider spread = more perceived risk.
* Credit spread change: Track the 30-day and 90-day change. A widening spread while equity holds = Scenario B warning. A tightening spread while equity is depressed = Scenario A opportunity.
* Bond price: If the company's bonds trade at 90+ cents on the dollar, the credit market sees them as safe. Below 70 = distressed.
* CDS spread (if available): Credit default swap prices are pure bets on default probability. Rising CDS = rising default risk.

Step 3: Detect dislocations
* Calculate the "disagreement score": compare the percentile rank of credit spread change vs. equity price change over the same period.
* Flag when they diverge by more than 2 standard deviations from their historical relationship.
* Classify as Scenario A (equity underpriced) or Scenario B (equity overpriced).

Step 4: Cross-reference with valuation screen
* For Scenario A candidates: Does the company also pass the moody.md cheapness screen? If bonds say "safe" AND the stock is cheap on fundamentals, confidence is high.
* For Scenario B candidates: Is the company on any existing watchlist? If bonds say "trouble" and you hold the stock, that's an exit signal.

Step 5: Assign to confidence model
* Bond market agreement boosts P_real (if bonds are healthy, earnings and cash flow are likely real — bond investors verified it).
* Bond market agreement boosts P_catalyst (credit improvement often precedes equity re-rating by 2-6 months).
* Bond market disagreement reduces P_real (if bonds are deteriorating, the earnings may not be sustainable).


DATA SOURCES & APIs

Bond pricing & credit spreads:
* FINRA TRACE (free, delayed): All corporate bond transactions in the US are reported here. This is the primary source.
  Access via FINRA's Bond Center or TRACE data feeds.
* FRED (free): ICE BofA corporate bond indices, high-yield spreads, investment-grade spreads (useful for sector-level context).
* Refinitiv / Bloomberg Terminal (paid, enterprise): Real-time bond pricing, CDS data, credit analytics. Expensive but comprehensive.
* Moody's / S&P credit ratings (paid): Rating changes, outlook changes, watchlist placements.
* BondCliQ (paid): Pre-trade bond market data.

Free/accessible starting point:
* FINRA TRACE for individual bond prices (delayed but sufficient for this strategy since you're not speed-trading)
* FRED for market-wide credit spread context
* SEC EDGAR for the company's debt schedule (10-K footnotes list all outstanding bonds, maturities, and interest rates)

Equity data (same as moody.md):
* Polygon.io, Alpha Vantage, IEX Cloud


WHAT TO WATCH OUT FOR

* Not every company has traded debt. This strategy only works for the subset that does. It's a filter, not a universal screen.
* Bond markets can be illiquid for small issuers. A bond that hasn't traded in weeks doesn't give you a real-time signal. Check trade frequency.
* Credit ratings lag reality. By the time Moody's downgrades, the bond market has usually already moved. Use market-based signals (spreads, prices) not rating agency opinions.
* Convertible bonds complicate the picture. A company with convertible debt has a stock-bond relationship that's mechanically linked. Exclude convertibles from the dislocation analysis.
