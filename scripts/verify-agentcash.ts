import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  agentcashMaximumPaymentUsd,
  agentcashPaymentApproval,
  agentcashInteractiveCapabilityIds,
  agentcashPrincipalAllowed,
  agentcashPrincipalId,
  agentcashWalletStatus,
  requireAgentcashAccess,
} from "../agent/lib/agentcash-access";
import {
  executeAgentcashPayment,
  type AgentcashOperationStoreClient,
} from "../agent/lib/agentcash-operation-store";
import {
  agentcashFetchSchema,
  agentcashNoPaymentCeilingUsd,
  assertAgentcashFreeSiwxEndpoint,
  enforceAgentcashFetch,
  safeAgentcashReadInput,
} from "../agent/lib/agentcash-policy";
import agentcashAccessStatusTool from "../agent/tools/agentcash_access_status";
import sleepTool from "../agent/tools/sleep";

assert.equal(
  typeof sleepTool.execute,
  "function",
  "Async AgentCash polling needs Eve's durable sleep tool.",
);

const agentcashSkill = await readFile(
  new URL("../agent/skills/agentcash.md", import.meta.url),
  "utf8",
);
assert.match(
  agentcashSkill,
  /durable `sleep` tool/u,
  "AgentCash polling guidance must use durable sleep instead of sandbox sleep.",
);
assert.match(
  agentcashSkill,
  /Never use (?:the )?`bash` tool to wait/u,
  "AgentCash polling guidance must forbid sandbox waits that can cancel the turn.",
);

const principalId = "imessage:fixture-owner";
const userSession = {
  auth: {
    current: {
      authenticator: "photon-imessage-webhook",
      attributes: {},
      principalId,
      principalType: "user" as const,
    },
  },
};
const runtimeSession = {
  auth: {
    current: {
      authenticator: "app",
      attributes: {},
      principalId: "eve:app",
      principalType: "runtime" as const,
    },
  },
};
const configuredEnvironment = {
  AGENTCASH_ALLOWED_PRINCIPALS: principalId,
  AGENTCASH_MAX_PAYMENT_USD: "2.50",
  X402_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  X402_SOLANA_PRIVATE_KEY:
    "2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2",
};

assert.equal(agentcashPrincipalId(userSession), principalId);
assert.equal(agentcashPrincipalId(runtimeSession), undefined);
assert.equal(
  agentcashPrincipalAllowed(userSession, configuredEnvironment),
  true,
);
assert.equal(
  agentcashPrincipalAllowed(userSession, {
    ...configuredEnvironment,
    AGENTCASH_ALLOWED_PRINCIPALS: "imessage:someone-else",
  }),
  false,
);
assert.deepEqual(agentcashWalletStatus(configuredEnvironment), {
  evm: true,
  solana: true,
});
assert.deepEqual(
  agentcashWalletStatus({ X402_PRIVATE_KEY: "not-a-private-key" }),
  { evm: false, solana: false },
);
assert.equal(agentcashMaximumPaymentUsd(configuredEnvironment), 2.5);
assert.deepEqual(agentcashInteractiveCapabilityIds(false), ["agentcash_x402"]);
assert.deepEqual(agentcashInteractiveCapabilityIds(true), [
  "agentcash_x402",
  "interactive.approval",
]);
assert.equal(agentcashMaximumPaymentUsd({}), 5);
assert.throws(
  () => agentcashMaximumPaymentUsd({ AGENTCASH_MAX_PAYMENT_USD: "0" }),
  /greater than 0 and no more than 100/u,
);
assert.equal(
  requireAgentcashAccess(
    { session: userSession } as never,
    configuredEnvironment,
  ),
  principalId,
);
assert.throws(
  () =>
    requireAgentcashAccess(
      { session: runtimeSession } as never,
      configuredEnvironment,
    ),
  /authenticated user/u,
);
assert.equal(
  requireAgentcashAccess(
    { session: userSession } as never,
    { ...configuredEnvironment, X402_SOLANA_PRIVATE_KEY: undefined },
  ),
  principalId,
  "A valid EVM wallet should enable AgentCash without a Solana wallet.",
);
assert.equal(
  requireAgentcashAccess(
    { session: userSession } as never,
    { ...configuredEnvironment, X402_PRIVATE_KEY: undefined },
  ),
  principalId,
  "A valid Solana wallet should enable AgentCash without an EVM wallet.",
);
assert.throws(
  () =>
    requireAgentcashAccess(
      { session: userSession } as never,
      {
        ...configuredEnvironment,
        X402_PRIVATE_KEY: undefined,
        X402_SOLANA_PRIVATE_KEY: undefined,
      },
    ),
  /requires at least one operator-controlled wallet/u,
);
assert.equal(
  agentcashPaymentApproval(
    { session: userSession } as never,
    configuredEnvironment,
  ),
  "user-approval",
);
assert.deepEqual(
  agentcashPaymentApproval(
    { session: userSession } as never,
    { ...configuredEnvironment, AGENTCASH_ALLOWED_PRINCIPALS: "" },
  ),
  { reason: "This user is not authorized for AgentCash.", type: "denied" },
);

const previousEvmPrivateKey = process.env.X402_PRIVATE_KEY;
const previousSolanaPrivateKey = process.env.X402_SOLANA_PRIVATE_KEY;
process.env.X402_PRIVATE_KEY = configuredEnvironment.X402_PRIVATE_KEY;
delete process.env.X402_SOLANA_PRIVATE_KEY;
try {
  const status = await agentcashAccessStatusTool.execute(
    {},
    { session: userSession } as never,
  );
  assert.equal(
    status.walletConfigured,
    true,
    "AgentCash status should report an EVM-only wallet as configured.",
  );
} finally {
  if (previousEvmPrivateKey === undefined) {
    delete process.env.X402_PRIVATE_KEY;
  } else {
    process.env.X402_PRIVATE_KEY = previousEvmPrivateKey;
  }
  if (previousSolanaPrivateKey === undefined) {
    delete process.env.X402_SOLANA_PRIVATE_KEY;
  } else {
    process.env.X402_SOLANA_PRIVATE_KEY = previousSolanaPrivateKey;
  }
}

const parsedFetch = agentcashFetchSchema.parse({
  maxAmount: 0.25,
  method: "POST",
  paymentProtocol: "x402",
  url: "https://stableenrich.dev/api/exa/search",
});
assert.deepEqual(enforceAgentcashFetch(parsedFetch, 0.5), parsedFetch);
assert.throws(() => enforceAgentcashFetch(parsedFetch, 0.1), /deployment limit/u);
assert.throws(
  () =>
    agentcashFetchSchema.parse({
      maxAmount: 1,
      url: "http://stableenrich.dev/api/exa/search",
    }),
  /HTTPS/u,
);
assert.throws(
  () =>
    agentcashFetchSchema.parse({
      headers: { Authorization: "Bearer secret" },
      maxAmount: 1,
      url: "https://stableenrich.dev/api/exa/search",
    }),
  /credential headers/u,
);
assert.throws(
  () =>
    agentcashFetchSchema.parse({
      maxAmount: 1,
      url: "https://user:secret@stableenrich.dev/api/exa/search",
    }),
  /cannot contain credentials/u,
);
assert.throws(
  () =>
    agentcashFetchSchema.parse({
      headers: { "X-Access-Token": "secret" },
      maxAmount: 1,
      url: "https://stableenrich.dev/api/exa/search",
    }),
  /credential headers/u,
);
assert.throws(
  () => safeAgentcashReadInput("search", { limit: 21, query: "filings" }),
  /between 1 and 20/u,
);
assert.equal(agentcashNoPaymentCeilingUsd > 0, true);
assert.equal(agentcashNoPaymentCeilingUsd < 0.000001, true);
assert.doesNotThrow(() =>
  assertAgentcashFreeSiwxEndpoint(
    {
      results: [
        { authMode: "siwx", method: "GET", requiresPayment: false },
      ],
      url: "https://example.com/jobs/123",
    },
    "https://example.com/jobs/123",
  ),
);
assert.throws(
  () =>
    assertAgentcashFreeSiwxEndpoint(
      {
        results: [
          { authMode: "siwx", method: "GET", requiresPayment: false },
        ],
        url: "https://example.com/jobs/other",
      },
      "https://example.com/jobs/123",
    ),
  /not confirmed as a free SIWX endpoint/u,
);
assert.throws(
  () =>
    assertAgentcashFreeSiwxEndpoint(
      {
        results: [
          { authMode: "x402", method: "GET", requiresPayment: true },
        ],
        url: "https://example.com/jobs/123",
      },
      "https://example.com/jobs/123",
    ),
  /not confirmed as a free SIWX endpoint/u,
);

class MemoryOperationStore implements AgentcashOperationStoreClient {
  readonly values = new Map<string, string>();

  async compareAndSet(key: string, expected: string | null, next: string) {
    if ((this.values.get(key) ?? null) !== expected) return false;
    this.values.set(key, next);
    return true;
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }
}

const store = new MemoryOperationStore();
let calls = 0;
const paymentInput = {
  callId: "call_fixture",
  operation: async () => {
    calls += 1;
    return { paid: true };
  },
  principalId,
  store,
  toolInput: parsedFetch,
};
assert.deepEqual(await executeAgentcashPayment(paymentInput), { paid: true });
assert.deepEqual(await executeAgentcashPayment(paymentInput), { paid: true });
assert.equal(calls, 1);

const multibyteStore = new MemoryOperationStore();
const multibyteResult = { text: "界".repeat(100_000) };
const multibytePayment = {
  ...paymentInput,
  callId: "call_multibyte",
  operation: async () => multibyteResult,
  store: multibyteStore,
};
assert.deepEqual(
  await executeAgentcashPayment(multibytePayment),
  multibyteResult,
);
assert.deepEqual(
  await executeAgentcashPayment(multibytePayment),
  multibyteResult,
);

class SettleFailureStore extends MemoryOperationStore {
  override async compareAndSet(
    key: string,
    expected: string | null,
    next: string,
  ) {
    if (expected !== null) return false;
    return super.compareAndSet(key, expected, next);
  }
}

const settleFailureStore = new SettleFailureStore();
assert.deepEqual(
  await executeAgentcashPayment({
    ...paymentInput,
    callId: "call_settle_failure",
    store: settleFailureStore,
  }),
  { paid: true },
);
await assert.rejects(
  executeAgentcashPayment({
    ...paymentInput,
    callId: "call_settle_failure",
    store: settleFailureStore,
  }),
  /completion is uncertain/u,
);
await assert.rejects(
  executeAgentcashPayment({
    ...paymentInput,
    toolInput: { ...parsedFetch, maxAmount: 0.3 },
  }),
  /conflicts with a different request/u,
);

const uncertainStore = new MemoryOperationStore();
await assert.rejects(
  executeAgentcashPayment({
    ...paymentInput,
    callId: "call_uncertain",
    operation: async () => {
      throw new Error("transport interrupted");
    },
    store: uncertainStore,
  }),
  /transport interrupted/u,
);
await assert.rejects(
  executeAgentcashPayment({
    ...paymentInput,
    callId: "call_uncertain",
    store: uncertainStore,
  }),
  /completion is uncertain/u,
);

console.log("AgentCash access, payment policy, and replay checks passed.");
