import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
  claimPhotonApprovalEvent,
  completePhotonApprovalDecision,
  getCurrentPhotonApprovalActivity,
  getPhotonApprovalDelivery,
  getPhotonApprovalView,
  markPhotonApprovalExecution,
  releasePhotonApprovalProcessing,
} from "../agent/lib/photon-approval-store.ts";
import {
  photonApprovalAppUrl,
  photonArtifactPresentation,
} from "../agent/lib/photon-mini-app.ts";

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

const agentcashPrompt = createPhotonApprovalPrompt(
  approvalRequest("agentcash_fetch", {
    maxAmount: 0.25,
    method: "POST",
    url: "https://stableenrich.dev/api/exa/search",
  }),
  1_000,
);
assert.equal(
  agentcashPrompt.approvalText,
  "Approve AgentCash POST to stableenrich.dev/api/exa/search for up to $0.25?",
);
assert.equal(agentcashPrompt.expiresAtMs, 601_000);
assert.equal(
  createPhotonApprovalPrompt(
    approvalRequest("agentcash_fetch", {
      maxAmount: 0.1,
      url: "https://example.com/search?q=sensitive",
    }),
  ).approvalText,
  "Approve AgentCash GET to example.com/search with query parameters for up to $0.10?",
);
for (const input of [
  { maxAmount: 0.1, url: "http://example.com/search" },
  { maxAmount: 0.1, url: "https://user:secret@example.com/search" },
  { maxAmount: 0.1, url: "https://example.com/search#secret" },
  { maxAmount: 0, url: "https://example.com/search" },
  { maxAmount: 101, url: "https://example.com/search" },
]) {
  assert.throws(
    () =>
      createPhotonApprovalPrompt(
        approvalRequest("agentcash_fetch", input),
      ),
    /cannot be rendered as an exact approval/u,
  );
}

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
  isPhotonApprovalSupported(approvalRequest("agentcash_fetch")),
  true,
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

assert.equal(
  isPhotonApprovalSupported(approvalRequest("delete_event_trigger", {
    id: "123e4567-e89b-42d3-a456-426614174000",
  })),
  false,
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
const activeKey = `eve:photon:v3:active-approval:${hash(
  `thread\u0000${threadId}\u0000${hash(`principal\u0000${principalId}`)}`,
)}`;
const recordKey = `eve:photon:v3:approval:${hash(
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
const deliveredRecord = {
  ...deliveringRecord,
  deliveredAtMs: Date.now(),
  state: "delivered",
};

let approvalEventKey;
assert.equal(
  await claimPhotonApprovalEvent(
    {
      eventId: "event-retry",
      principalId,
      threadId,
    },
    {
      set: async (key) => {
        approvalEventKey = key;
        return "OK";
      },
    },
  ),
  true,
);
assert.match(approvalEventKey, /^eve:photon:v2:approval-event:/u);

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
      if (key.startsWith("eve:photon:v3:active-approval:")) return active;
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
  await getPhotonApprovalDelivery(
    { decision: "approve", recordKey },
    approvalStore({
      record: JSON.stringify(deliveringRecord),
    }),
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
  await getPhotonApprovalDelivery(
    { decision: "approve", recordKey },
    approvalStore({
      active: null,
      record: JSON.stringify(deliveredRecord),
    }),
  ),
  { status: "delivered" },
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
  await claimCurrentPhotonApprovalDecision(
    { decision: "approve", principalId, threadId },
    approvalStore({
      evalValue: JSON.stringify({
        decision: "approve",
        status: "processing",
      }),
    }),
  ),
  { decision: "approve", status: "processing" },
);
let staleDecisionArgs;
let staleDecisionScript;
const staleDecisionStore = approvalStore();
staleDecisionStore.eval = async (script, _keys, args) => {
  staleDecisionArgs = args;
  staleDecisionScript = script;
  return JSON.stringify({ status: "stale" });
};
assert.deepEqual(
  await claimCurrentPhotonApprovalDecision(
    {
      decision: "approve",
      decisionSentAtMs: 500,
      principalId,
      threadId,
    },
    staleDecisionStore,
  ),
  { status: "stale" },
);
assert.equal(staleDecisionArgs[4], 500);
assert.equal(staleDecisionArgs[5], 0);
assert.match(staleDecisionScript, /record\.activatedAtMs or record\.createdAtMs/u);

assert.equal(
  await getCurrentPhotonApprovalActivity(
    { principalId, threadId },
    approvalStore(),
  ),
  "pending",
);
assert.equal(
  await getCurrentPhotonApprovalActivity(
    { principalId, threadId },
    approvalStore({ record: JSON.stringify(deliveredRecord) }),
  ),
  "processing",
);
assert.equal(
  await getCurrentPhotonApprovalActivity(
    { principalId, threadId },
    approvalStore({
      record: JSON.stringify({
        ...deliveredRecord,
        decision: "deny",
      }),
    }),
  ),
  null,
);

let completionCall;
await completePhotonApprovalDecision(
  { decision: "approve", recordKey },
  {
    eval: async (script, keys, args) => {
      completionCall = { args, keys, script };
      return 1;
    },
    get: async (key) =>
      key === recordKey ? JSON.stringify(deliveringRecord) : null,
  },
);
assert.deepEqual(completionCall.keys.slice(0, 2), [recordKey, activeKey]);
assert.match(
  completionCall.keys[2],
  /^eve:photon:v3:processing-approval:[a-f0-9]{64}$/u,
);
assert.equal(completionCall.args[0], "approve");
assert.equal(completionCall.args[3], 24 * 60 * 60);
assert.match(
  completionCall.script,
  /record\.decision == "approve"[\s\S]*redis\.call\("SET", KEYS\[2\]/u,
);

let releaseCall;
const processingKey = completionCall.keys[2];
assert.equal(
  await releasePhotonApprovalProcessing("wrun_test", {
    eval: async (script, keys, args) => {
      releaseCall = { args, keys, script };
      return 1;
    },
    get: async (key) => {
      if (key === processingKey) return recordKey;
      if (key === recordKey) {
        return JSON.stringify({
          ...deliveredRecord,
          executionAtMs: Date.now(),
          executionState: "succeeded",
        });
      }
      return null;
    },
  }),
  "released",
);
assert.equal(releaseCall.keys[0], processingKey);
assert.equal(releaseCall.keys[1], recordKey);
assert.deepEqual(releaseCall.args, ["wrun_test"]);
assert.match(releaseCall.script, /record\.executionState ~= "succeeded"/u);

let executionCall;
assert.equal(
  await markPhotonApprovalExecution(
    { sessionId: "wrun_test", state: "uncertain" },
    {
      eval: async (script, keys, args) => {
        executionCall = { args, keys, script };
        return 1;
      },
      get: async (key) => (key === processingKey ? recordKey : null),
    },
  ),
  true,
);
assert.deepEqual(executionCall.keys, [processingKey, recordKey]);
assert.equal(executionCall.args[0], "wrun_test");
assert.equal(executionCall.args[1], "uncertain");
assert.match(executionCall.script, /record\.executionState = ARGV\[2\]/u);

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
      record: JSON.stringify(deliveredRecord),
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

assert.deepEqual(
  photonArtifactPresentation(
    "Research complete.\n\nARTIFACT_URL: https://hype-report.miniup.app/",
  ),
  {
    message:
      "Research complete.\n\nOpen the artifact:\nhttps://hype-report.miniup.app/",
    url: "https://hype-report.miniup.app/",
  },
);
assert.deepEqual(
  photonArtifactPresentation(
    "The public report is available at (https://hype-report.miniup.app/).",
  ),
  {
    message:
      "The public report is available at (https://hype-report.miniup.app/).",
    url: "https://hype-report.miniup.app/",
  },
);
assert.equal(
  photonArtifactPresentation("Source: https://example.com/research"),
  null,
);
assert.equal(
  photonArtifactPresentation(
    "ARTIFACT_URL: https://hype-report.miniup.app/?token=secret",
  ),
  null,
);
assert.equal(
  photonArtifactPresentation(
    "ARTIFACT_URL: https://miniup.app.attacker.example/report",
  ),
  null,
);

const deploymentUrlVariables = [
  "PHOTON_MINI_APP_BASE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
];
const previousDeploymentUrls = Object.fromEntries(
  deploymentUrlVariables.map((name) => [name, process.env[name]]),
);
try {
  process.env.PHOTON_MINI_APP_BASE_URL = "https://eve.example";
  const appUrl = new URL(photonApprovalAppUrl(approvalToken));
  assert.equal(appUrl.origin, "https://eve.example");
  assert.equal(appUrl.pathname, "/eve/v1/photon-approval");
  assert.equal(appUrl.search, "");
  assert.equal(appUrl.hash, `#${approvalToken}`);
  const artifactId = "a".repeat(32);
  assert.deepEqual(
    photonArtifactPresentation(
      `Published.\n\nARTIFACT_URL: https://eve.example/artifacts/${artifactId}`,
    ),
    {
      message: `Published.\n\nOpen the artifact:\nhttps://eve.example/artifacts/${artifactId}`,
      url: `https://eve.example/artifacts/${artifactId}`,
    },
  );
  assert.equal(
    photonArtifactPresentation(
      `ARTIFACT_URL: https://attacker.example/artifacts/${artifactId}`,
    ),
    null,
  );
  assert.equal(
    photonArtifactPresentation(
      `ARTIFACT_URL: https://eve.example/artifacts/${artifactId}?token=secret`,
    ),
    null,
  );

  delete process.env.PHOTON_MINI_APP_BASE_URL;
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "eve-production.example";
  process.env.VERCEL_URL = "eve-protected-preview.example";
  assert.equal(
    new URL(photonApprovalAppUrl(approvalToken)).origin,
    "https://eve-production.example",
  );
} finally {
  for (const name of deploymentUrlVariables) {
    const previous = previousDeploymentUrls[name];
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
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

const photonChannelSource = await readFile(
  new URL("../agent/channels/photon.ts", import.meta.url),
  "utf8",
);
const completedTurnStart = photonChannelSource.indexOf('async "turn.completed"');
const completedTurnEnd = photonChannelSource.indexOf('async "turn.cancelled"');
assert.ok(completedTurnStart >= 0, "Photon completed-turn handler exists");
assert.ok(completedTurnEnd > completedTurnStart, "Photon completed-turn handler is bounded");
const completedTurnHandler = photonChannelSource.slice(
  completedTurnStart,
  completedTurnEnd,
);
assert.ok(
  completedTurnHandler.indexOf("const approvalWasActive") <
    completedTurnHandler.indexOf("releaseApprovedOrderGuard"),
  "approval activity must be captured before releasing the approved-order guard",
);

console.log("Photon mini-app approval verification passed.");
