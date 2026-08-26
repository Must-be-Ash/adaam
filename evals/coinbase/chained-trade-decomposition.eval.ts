import { defineEval } from "eve/evals";

import { coinbaseEvalFixtureEnabled } from "../../agent/lib/coinbase-eval-fixture";

// The fixture portfolio holds 0.0125 BTC available, so "50%" is 0.00625.
function isHalfBitcoinSell(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    input.productId === "BTC-USD" &&
    input.side === "SELL" &&
    input.type === "market" &&
    typeof input.baseSize === "string" &&
    Number(input.baseSize) === 0.00625 &&
    input.quoteSize === undefined
  );
}

export default defineEval({
  description:
    "Splits a chained sell-then-buy request into two tasks: executes only the sell, then hands the follow-on buy back to the user instead of sizing it against unsettled proceeds.",
  tags: ["approval", "coinbase", "decomposition", "routing"],
  async test(t) {
    if (!coinbaseEvalFixtureEnabled()) {
      throw new Error(
        "Run this eval through npm run eval:coinbase with the local safe fixture.",
      );
    }

    const parked = await t.send("Sell 50% of my BTC and buy SOL with it.");

    // Only the sell may reach Coinbase. A second preview here is the production
    // defect: the SOL buy was sized against funds the sell had not yet realized,
    // and its approval collided with the sell's still-active one.
    parked.calledTool("coinbase_preview_order", {
      count: 1,
      input: isHalfBitcoinSell,
    });
    parked.calledTool("coinbase_create_order", {
      count: 1,
      input: isHalfBitcoinSell,
      status: "pending",
    });

    const request = t.requireInputRequest({
      input: isHalfBitcoinSell,
      optionIds: ["approve", "cancel"],
      toolName: "coinbase_create_order",
    });
    await t.respond([{ optionId: "approve", requestId: request.requestId }]);

    t.succeeded();
    t.noFailedActions();

    // Across the whole session exactly one order was previewed and one placed:
    // the SOL leg was never previewed, sized, or submitted on its own authority.
    t.calledTool("coinbase_preview_order", { count: 1 });
    t.calledTool("coinbase_create_order", {
      count: 1,
      input: isHalfBitcoinSell,
      status: "completed",
    });

    // The sell is reported, and the SOL leg comes back to the user as a decision
    // rather than an action already taken. Match the intent, not one phrasing.
    t.messageIncludes("local-eval-order");
    t.messageIncludes(/SOL/u);
    t.messageIncludes(
      /\b(?:want|would you like|shall I|should I|let me know|confirm|go ahead|proceed)\b/iu,
    );
  },
});
