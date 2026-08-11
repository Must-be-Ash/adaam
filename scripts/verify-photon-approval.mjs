import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  coinbaseToolIsPrivateRead,
  coinbaseToolRequiresApproval,
} from "../agent/lib/coinbase-access.ts";
import {
  createPhotonApprovalPrompt,
  isPhotonApprovalAlias,
  isPhotonApprovalSupported,
  parsePhotonTextDecision,
} from "../agent/lib/photon-approval.ts";
import {
  claimCurrentPhotonApprovalDecision,
  claimPhotonApprovalDecision,
  getPhotonApprovalView,
} from "../agent/lib/photon-approval-store.ts";
import { photonApprovalAppUrl } from "../agent/lib/photon-mini-app.ts";

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
assert.equal(orderPrompt.approvalText, "Buy 25 USD of BTC?");
assert.equal(orderPrompt.approvalText.includes(previewToken), false);
assert.equal(orderPrompt.expiresAtMs, 301_000);
assert.deepEqual(Object.keys(orderPrompt).sort(), [
  "approvalText",
  "expiresAtMs",
  "requestId",
  "toolName",
]);

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
assert.equal(limitPrompt.approvalText, "Buy 0.25 BTC at 50000 USD?");

assert.equal(
  isPhotonApprovalSupported(approvalRequest("coinbase_balance")),
  false,
);
assert.equal(
  isPhotonApprovalSupported(approvalRequest("coinbase_create_order")),
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

for (const toolName of [
  "coinbase_balance",
  "coinbase_convert_get",
  "coinbase_convert_quote",
  "coinbase_fees",
  "coinbase_orders_fills",
  "coinbase_orders_get",
  "coinbase_orders_list",
  "coinbase_portfolios_get",
  "coinbase_portfolios_list",
]) {
  assert.equal(coinbaseToolIsPrivateRead(toolName), true, toolName);
  assert.equal(coinbaseToolRequiresApproval(toolName), false, toolName);
}
for (const toolName of [
  "coinbase_convert_execute",
  "coinbase_create_order",
  "coinbase_orders_cancel",
  "coinbase_orders_edit",
  "coinbase_portfolios_create",
  "coinbase_portfolios_delete",
  "coinbase_portfolios_edit",
  "coinbase_transfer",
]) {
  assert.equal(coinbaseToolRequiresApproval(toolName), true, toolName);
}
assert.equal(coinbaseToolIsPrivateRead("coinbase_products_get"), false);
assert.equal(coinbaseToolRequiresApproval("coinbase_products_get"), false);

const genericPrompt = createPhotonApprovalPrompt(
  approvalRequest("delete_event_trigger", {
    id: "123e4567-e89b-42d3-a456-426614174000",
  }),
);
assert.match(
  genericPrompt.approvalText,
  /^Delete event trigger 123e4567-e89b-42d3-a456-426614174000\?/u,
);

for (const text of ["YES", "yes.", "APPROVE", "approve!"]) {
  assert.equal(parsePhotonTextDecision(text), "approve", text);
}
for (const text of ["NO", "no.", "DENY", "deny!", "cancel"]) {
  assert.equal(parsePhotonTextDecision(text), "deny", text);
}
for (const text of [
  "",
  "1",
  "yes please",
  "APPROVE old-code",
  "approved",
  "continue",
  "denied",
  "Yes buy it",
]) {
  assert.equal(parsePhotonTextDecision(text), null, text);
}
for (const text of ["YES", "APPROVE", "NO", "DENY", "1", "01", "+1"]) {
  assert.equal(isPhotonApprovalAlias(text), true, text);
}
for (const text of ["", "0", "-1", "continue", "yes please"]) {
  assert.equal(isPhotonApprovalAlias(text), false, text);
}

const principalId = "imessage:test-owner";
const threadId = "imessage:test-thread";
const approvalToken = "T".repeat(43);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const activeKey = `eve:photon:v2:active-approval:${"a".repeat(64)}`;
const recordKey = `eve:photon:v2:approval:${hash(
  `approval-token\u0000${approvalToken}`,
)}`;
const activeRecord = {
  activeKey,
  approvalToken,
  approvalText: "Buy 25 USD of BTC?",
  createdAtMs: 1_000,
  expiresAtMs: Date.now() + 60_000,
  principalHash: hash(`principal\u0000${principalId}`),
  principalId,
  requestId: "request_coinbase_create_order",
  schemaVersion: 1,
  sessionId: "wrun_test",
  state: "active",
  threadId,
  toolName: "coinbase_create_order",
};
const deliveringRecord = {
  ...activeRecord,
  decision: "approve",
  decisionAtMs: Date.now(),
  expiredDecision: false,
  state: "delivering",
};

function approvalStore({
  active = recordKey,
  evalValue = JSON.stringify({
    expired: false,
    record: deliveringRecord,
    status: "deliver",
  }),
  record = JSON.stringify(activeRecord),
} = {}) {
  return {
    eval: async () => evalValue,
    get: async (key) => {
      if (key.startsWith("eve:photon:v2:active-approval:")) return active;
      return key === recordKey ? record : null;
    },
  };
}

assert.deepEqual(
  await claimCurrentPhotonApprovalDecision(
    { decision: "approve", principalId, threadId },
    approvalStore(),
  ),
  {
    delivery: {
      decision: "approve",
      expired: false,
      principalId,
      recordKey,
      requestId: "request_coinbase_create_order",
      sessionId: "wrun_test",
      threadId,
      toolName: "coinbase_create_order",
    },
    status: "deliver",
  },
);
assert.deepEqual(
  await claimPhotonApprovalDecision(
    { approvalToken, decision: "approve" },
    approvalStore(),
  ),
  {
    delivery: {
      decision: "approve",
      expired: false,
      principalId,
      recordKey,
      requestId: "request_coinbase_create_order",
      sessionId: "wrun_test",
      threadId,
      toolName: "coinbase_create_order",
    },
    status: "deliver",
  },
);
assert.deepEqual(
  await claimPhotonApprovalDecision(
    { approvalToken: "invalid", decision: "approve" },
    approvalStore(),
  ),
  { status: "invalid" },
);
assert.deepEqual(
  await claimCurrentPhotonApprovalDecision(
    { decision: "approve", principalId, threadId },
    approvalStore({ active: null }),
  ),
  { status: "missing" },
);
assert.deepEqual(
  await claimCurrentPhotonApprovalDecision(
    { decision: "approve", principalId, threadId },
    approvalStore({ evalValue: JSON.stringify({ status: "forbidden" }) }),
  ),
  { status: "forbidden" },
);
assert.deepEqual(
  await getPhotonApprovalView(approvalToken, approvalStore()),
  {
    approvalText: "Buy 25 USD of BTC?",
    expiresAtMs: activeRecord.expiresAtMs,
    status: "active",
  },
);
assert.deepEqual(
  await getPhotonApprovalView(
    approvalToken,
    approvalStore({
      active: null,
      record: JSON.stringify({
        ...deliveringRecord,
        deliveredAtMs: Date.now(),
        state: "delivered",
      }),
    }),
  ),
  {
    approvalText: "Buy 25 USD of BTC?",
    decision: "approve",
    expiresAtMs: activeRecord.expiresAtMs,
    status: "delivered",
  },
);
assert.deepEqual(
  await getPhotonApprovalView(
    approvalToken,
    approvalStore({
      active: null,
      record: JSON.stringify({
        ...deliveringRecord,
        failureAtMs: Date.now(),
        state: "unavailable",
      }),
    }),
  ),
  {
    approvalText: "Buy 25 USD of BTC?",
    expiresAtMs: activeRecord.expiresAtMs,
    status: "unavailable",
  },
);

const previousBaseUrl = process.env.PHOTON_MINI_APP_BASE_URL;
process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example";
const appUrl = new URL(photonApprovalAppUrl(approvalToken));
assert.equal(appUrl.origin, "https://eve.example");
assert.equal(appUrl.pathname, "/eve/v1/photon-approval");
assert.equal(appUrl.search, "");
assert.equal(appUrl.hash, `#${approvalToken}`);
if (previousBaseUrl === undefined) {
  delete process.env.PHOTON_MINI_APP_BASE_URL;
} else {
  process.env.PHOTON_MINI_APP_BASE_URL = previousBaseUrl;
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
const longPrompt = createPhotonApprovalPrompt(
  approvalRequest("coinbase_create_order", {
    baseSize: "9".repeat(40),
    limitPrice: "8".repeat(40),
    previewToken,
    productId: "ABCDEFGHIJKLMNOPQRST-QRSTUVWXYZABCDEFGHIJ",
    side: "SELL",
    type: "limit",
  }),
);
assert.equal(longPrompt.approvalText.includes("9".repeat(40)), true);
assert.equal(longPrompt.approvalText.includes("8".repeat(40)), true);
assert.match(longPrompt.approvalText, /\?$/u);

console.log("Photon mini-app approval verification passed.");
