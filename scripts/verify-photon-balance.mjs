import assert from "node:assert/strict";

import {
  formatCoinbaseBalance,
  isCoinbaseBalanceRequest,
} from "../agent/lib/photon-balance.ts";

for (const request of [
  "balance",
  "Check my balance",
  "check my Coinbase balance.",
  "What's my coinbase balance?",
]) {
  assert.equal(isCoinbaseBalanceRequest(request), true, request);
}

for (const request of [
  "analyze the balance sheet",
  "balance risk and return",
  "buy BTC with my balance",
]) {
  assert.equal(isCoinbaseBalanceRequest(request), false, request);
}

assert.equal(
  formatCoinbaseBalance({
    accounts: [
      {
        available_balance: { currency: "BTC", value: "0.25" },
        currency: "BTC",
        hold: { currency: "BTC", value: "0.01" },
      },
      {
        available_balance: { currency: "USD", value: "125.40" },
        currency: "USD",
        hold: { currency: "USD", value: "0" },
      },
    ],
    has_next: false,
  }),
  "Coinbase balances\nBTC: 0.25 available · 0.01 on hold\nUSD: 125.40 available",
);

assert.equal(
  formatCoinbaseBalance({ accounts: [], has_next: false }),
  "Coinbase returned no non-zero balances.",
);

assert.throws(
  () => formatCoinbaseBalance({ error: "unavailable" }),
  /invalid balance response/u,
);

console.log("Photon direct balance verification passed.");
