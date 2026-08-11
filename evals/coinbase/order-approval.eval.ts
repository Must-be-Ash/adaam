import { defineEval } from "eve/evals";

import { coinbaseEvalFixtureEnabled } from "../../agent/lib/coinbase-eval-fixture";

function isOneDollarBitcoinBuy(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    input.productId === "BTC-USD" &&
    input.side === "BUY" &&
    input.type === "market" &&
    (input.quoteSize === "1" || input.quoteSize === "1.00")
  );
}

export default defineEval({
  description:
    "Previews a natural-language Coinbase order, parks for approval, and resumes only after approval.",
  tags: ["approval", "coinbase", "routing"],
  async test(t) {
    if (!coinbaseEvalFixtureEnabled()) {
      throw new Error(
        "Run this eval through npm run eval:coinbase with the local safe fixture.",
      );
    }

    const parked = await t.send("Buy me $1 of BTC on Coinbase.");
    parked.calledTool("coinbase_preview_order", {
      count: 1,
      input: isOneDollarBitcoinBuy,
    });
    parked.calledTool("coinbase_create_order", {
      count: 1,
      input: isOneDollarBitcoinBuy,
      status: "pending",
    });
    const request = t.requireInputRequest({
      input: isOneDollarBitcoinBuy,
      optionIds: ["approve", "deny"],
      toolName: "coinbase_create_order",
    });

    await t.respond([
      {
        optionId: "approve",
        requestId: request.requestId,
      },
    ]);

    t.succeeded();
    t.calledTool("coinbase_create_order", {
      count: 1,
      input: isOneDollarBitcoinBuy,
      status: "completed",
    });
    t.messageIncludes("local-eval-order");
    t.noFailedActions();
  },
});
