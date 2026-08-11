import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { coinbaseEvalFixtureEnabled } from "../../agent/lib/coinbase-eval-fixture";

const requests = [
  "Check my Coinbase balance.",
  "Show me my Coinbase balance.",
  "What assets are currently in my Coinbase account?",
];

export default requests.map((request) =>
  defineEval({
    description: `Routes natural Coinbase portfolio language: ${request}`,
    tags: ["coinbase", "routing"],
    async test(t) {
      if (!coinbaseEvalFixtureEnabled()) {
        throw new Error(
          "Run this eval through npm run eval:coinbase with the local safe fixture.",
        );
      }

      await t.send(request);
      t.succeeded();
      t.calledTool("coinbase_balance", {
        count: 1,
        input: { limit: 200, show_zero: false },
      });
      t.messageIncludes(/BTC/i);
      t.messageIncludes("0.0125");
      t.messageIncludes("25.00");
      t.check(
        t.reply,
        satisfies(
          (reply) =>
            typeof reply === "string" &&
            !/\b(?:could not|error|failed|unable)\b/iu.test(reply),
          "reports the fixture balances without a failure message",
        ),
      );
      t.noFailedActions();
    },
  }),
);
