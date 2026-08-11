import assert from "node:assert/strict";

import {
  createPhotonApprovalPrompt,
  isPhotonApprovalSupported,
  isUnscopedApprovalAlias,
  parsePhotonPollVote,
  parsePhotonTextDecision,
} from "../agent/lib/photon-approval.ts";

function approvalRequest(toolName, input = {}) {
  return {
    action: {
      callId: "call_approval_test",
      input,
      kind: "tool-call",
      toolName,
    },
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    prompt: `Approve tool call: ${toolName}`,
    requestId: `request_${toolName}`,
  };
}

const previewToken = "secret-preview-token-that-must-not-be-rendered";
const orderPrompt = createPhotonApprovalPrompt(
  approvalRequest("coinbase_create_order", {
    previewToken,
    productId: "BTC-USD",
    quoteSize: "25",
    side: "BUY",
    type: "market",
  }),
  1_000,
);
assert.match(orderPrompt.pollTitle, /^Buy 25 USD of BTC\?/u);
assert.equal(orderPrompt.pollTitle.includes(previewToken), false);
assert.equal(orderPrompt.expiresAtMs, 301_000);
assert.ok(orderPrompt.pollTitle.length <= 140);
assert.match(orderPrompt.pollTitle, / · [A-Za-z0-9_-]{22}$/u);
assert.match(orderPrompt.approvalCode, /^[A-Za-z0-9_-]{22}$/u);

const limitPrompt = createPhotonApprovalPrompt(
  approvalRequest("coinbase_create_order", {
    baseSize: "0.25",
    limitPrice: "50000",
    previewToken,
    productId: "BTC-USD",
    side: "BUY",
    type: "limit",
  }),
);
assert.match(limitPrompt.pollTitle, /^Buy 0\.25 BTC at 50000 USD\?/u);

const balancePrompt = createPhotonApprovalPrompt(
  approvalRequest("coinbase_balance"),
);
assert.match(balancePrompt.pollTitle, /^Show your Coinbase balances\?/u);
assert.equal(
  isPhotonApprovalSupported(approvalRequest("coinbase_balance")),
  true,
);
assert.equal(
  isPhotonApprovalSupported(approvalRequest("coinbase_transfer")),
  false,
);
assert.equal(
  isPhotonApprovalSupported(
    approvalRequest("masterkey-x402__run_service"),
  ),
  false,
);

const genericPrompt = createPhotonApprovalPrompt(
  approvalRequest("delete_event_trigger", {
    id: "123e4567-e89b-42d3-a456-426614174000",
  }),
);
assert.match(
  genericPrompt.pollTitle,
  /^Delete event trigger 123e4567-e89b-42d3-a456-426614174000\?/u,
);

const approvedVote = parsePhotonPollVote({
  content: {
    option: { title: "Approve" },
    poll: { title: orderPrompt.pollTitle },
    selected: true,
    type: "poll_option",
  },
});
assert.deepEqual(approvedVote, {
  approvalCode: orderPrompt.approvalCode,
  decision: "approve",
  pollTitle: orderPrompt.pollTitle,
  selected: true,
});

assert.deepEqual(
  parsePhotonPollVote({
    content: {
      option: { title: "Deny" },
      poll: { title: orderPrompt.pollTitle },
      selected: true,
      type: "poll_option",
    },
  }),
  {
    approvalCode: orderPrompt.approvalCode,
    decision: "deny",
    pollTitle: orderPrompt.pollTitle,
    selected: true,
  },
);

assert.deepEqual(
  parsePhotonPollVote({
    content: {
      option: { title: "Maybe" },
      poll: { title: orderPrompt.pollTitle },
      selected: false,
      type: "poll_option",
    },
  }),
  {
    approvalCode: orderPrompt.approvalCode,
    decision: null,
    pollTitle: orderPrompt.pollTitle,
    selected: false,
  },
);
assert.equal(parsePhotonPollVote({ content: { type: "text" } }), null);
assert.equal(parsePhotonPollVote(null), null);
assert.deepEqual(
  parsePhotonTextDecision(`APPROVE ${orderPrompt.approvalCode}`),
  {
    approvalCode: orderPrompt.approvalCode,
    decision: "approve",
  },
);
assert.deepEqual(
  parsePhotonTextDecision(`deny ${orderPrompt.approvalCode}.`),
  {
    approvalCode: orderPrompt.approvalCode,
    decision: "deny",
  },
);
assert.equal(parsePhotonTextDecision("APPROVE"), null);
assert.equal(parsePhotonTextDecision("APPROVE wrong-code"), null);
for (const alias of ["approve", "1", "01", "+1", "1.0", "1e0", "0x1"]) {
  assert.equal(isUnscopedApprovalAlias(alias), true, alias);
}
for (const safeText of ["deny", "continue", "yes", "0", "-1", "hello"]) {
  assert.equal(isUnscopedApprovalAlias(safeText), false, safeText);
}

assert.throws(
  () =>
    createPhotonApprovalPrompt({
      ...approvalRequest("coinbase_balance"),
      kind: "question",
    }),
  /tool-approval request/u,
);
assert.throws(
  () =>
    createPhotonApprovalPrompt(
      approvalRequest("coinbase_create_order", {
        previewToken,
        productId: "BTC-USD",
        side: "BUY",
        type: "limit",
      }),
    ),
  /cannot be rendered as an exact approval/u,
);
assert.throws(
  () =>
    createPhotonApprovalPrompt(
      approvalRequest("coinbase_create_order", {
        baseSize: "9".repeat(40),
        limitPrice: "8".repeat(40),
        previewToken,
        productId: "ABCDEFGHIJKLMNOPQRST-QRSTUVWXYZABCDEFGHIJ",
        side: "SELL",
        type: "limit",
      }),
    ),
  /too long for an exact iMessage prompt/u,
);

console.log("Photon approval verification passed.");
