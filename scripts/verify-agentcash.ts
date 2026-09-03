import assert from "node:assert/strict";
import { base58 } from "@scure/base";

import {
  agentcashMaximumPaymentUsd,
  agentcashPaymentApproval,
  agentcashInteractiveCapabilityIds,
  agentcashPrincipalAllowed,
  agentcashPrincipalId,
  agentcashWalletStatus,
  requireAgentcashAccess,
} from "../agent/lib/agentcash-access";
import { agentcashChildEnvironment } from "../agent/lib/agentcash-cli";
import { guardAgentcashProviderFetch } from "../agent/lib/agentcash-fetch-guard";
import {
  isAgentcashSolanaPrivateKey,
  normalizeAgentcashSolanaPrivateKey,
} from "../agent/lib/agentcash-wallet";
import {
  executeAgentcashPayment,
  type AgentcashOperationStoreClient,
} from "../agent/lib/agentcash-operation-store";
import {
  agentcashFetchSchema,
  agentcashNoPaymentCeilingUsd,
  assertAgentcashFreeSiwxEndpoint,
  enforceAgentcashFetch,
  isAgentcashUrlAllowed,
  safeAgentcashReadInput,
} from "../agent/lib/agentcash-policy";
import { inspectAgentcashEndpointSchema } from "../agent/lib/agentcash-endpoint-schema";
import { legacyAgentcashRequestHash } from "../agent/lib/agentcash-request";

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
const solanaSeedBytes = new Uint8Array(32).fill(7);
const solanaSeed = base58.encode(solanaSeedBytes);
const normalizedSolanaKey = normalizeAgentcashSolanaPrivateKey(solanaSeed);
assert.equal(typeof normalizedSolanaKey, "string");
const configuredEnvironment = {
  AGENTCASH_ALLOWED_PRINCIPALS: principalId,
  AGENTCASH_MAX_PAYMENT_USD: "2.50",
  X402_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  X402_SOLANA_PRIVATE_KEY: normalizedSolanaKey!,
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
assert.equal(base58.decode(normalizedSolanaKey!).length, 64);
assert.deepEqual(
  base58.decode(normalizedSolanaKey!).slice(0, 32),
  solanaSeedBytes,
);
assert.equal(isAgentcashSolanaPrivateKey(solanaSeed), true);
assert.equal(isAgentcashSolanaPrivateKey(normalizedSolanaKey), true);
assert.equal(
  isAgentcashSolanaPrivateKey(base58.encode(new Uint8Array(64).fill(8))),
  false,
);
assert.deepEqual(
  agentcashWalletStatus({
    X402_PRIVATE_KEY: configuredEnvironment.X402_PRIVATE_KEY,
    X402_SOLANA_PRIVATE_KEY: solanaSeed,
  }),
  { evm: true, solana: true },
);
assert.equal(
  agentcashChildEnvironment({
    X402_PRIVATE_KEY: configuredEnvironment.X402_PRIVATE_KEY,
    X402_SOLANA_PRIVATE_KEY: solanaSeed,
  }).X402_SOLANA_PRIVATE_KEY,
  normalizedSolanaKey,
);
assert.equal(
  agentcashChildEnvironment({
    AGENTCASH_ALLOWED_ORIGINS: "https://partner.example",
  }).EVE_AGENTCASH_ALLOWED_ORIGINS?.split(",").includes(
    "https://partner.example",
  ),
  true,
);
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
assert.throws(
  () =>
    requireAgentcashAccess(
      { session: userSession } as never,
      { ...configuredEnvironment, X402_SOLANA_PRIVATE_KEY: undefined },
    ),
  /requires operator-controlled EVM and Solana wallets/u,
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
      maxAmount: 1,
      url: "https://example.com/private",
    }),
  /approved AgentCash provider/u,
);
assert.equal(
  isAgentcashUrlAllowed("https://partner.example/api", {
    AGENTCASH_ALLOWED_ORIGINS: "https://partner.example",
  }),
  true,
);
assert.equal(
  isAgentcashUrlAllowed("https://partner.example.evil.test/api", {
    AGENTCASH_ALLOWED_ORIGINS: "https://partner.example",
  }),
  false,
);

const guardedFetchCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const guardedFetch = guardAgentcashProviderFetch(
  async (input, init) => {
    guardedFetchCalls.push({ input, init });
    return new Response(null, { status: 302 });
  },
  "https://stablestudio.dev,https://partner.example",
);
await guardedFetch("https://stablestudio.dev/api/images");
assert.equal(guardedFetchCalls.at(-1)?.init?.redirect, "manual");
await guardedFetch(
  new Request("https://partner.example/api", { redirect: "follow" }),
  { signal: AbortSignal.timeout(1_000) },
);
const guardedRequest = guardedFetchCalls.at(-1)?.input;
assert.equal(guardedRequest instanceof Request, true);
assert.equal((guardedRequest as Request).redirect, "manual");
assert.equal(guardedFetchCalls.at(-1)?.init, undefined);
await guardedFetch("https://api.agentcash.dev/internal", { redirect: "follow" });
assert.equal(guardedFetchCalls.at(-1)?.init?.redirect, "follow");
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

const originalFetch = globalThis.fetch;
const inspectionMethods: string[] = [];
const inspectionRedirectModes: Array<RequestRedirect | undefined> = [];
let inspectionMode: "oversized" | "recursive" | "redirect" | "success" =
  "success";
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.protocol === "data:") return originalFetch(input, init);
  inspectionMethods.push(init?.method ?? "GET");
  inspectionRedirectModes.push(init?.redirect);
  if (url.pathname === "/openapi.json") {
    if (inspectionMode === "redirect") {
      return new Response(null, {
        headers: { location: "https://example.com/openapi.json" },
        status: 302,
      });
    }
    if (inspectionMode === "oversized") {
      return new Response(
        JSON.stringify({ padding: "x".repeat(1_100_000) }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    if (inspectionMode === "recursive") {
      return new Response(
        JSON.stringify({
          components: {
            schemas: {
              Recursive: { $ref: "#/components/schemas/Recursive" },
            },
          },
          info: { title: "Recursive API", version: "1.0.0" },
          openapi: "3.1.0",
          paths: {
            "/api/images": {
              post: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/Recursive" },
                    },
                  },
                },
                responses: { "200": { description: "Generated image" } },
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        info: { title: "Fixture API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: {
          "/api/images": {
            post: {
              responses: { "200": { description: "Generated image" } },
              summary: "Generate an image",
            },
          },
        },
      }),
      { headers: { "content-type": "application/json" }, status: 200 },
    );
  }
  return new Response("not found", { status: 404 });
};
try {
  const inspection = await inspectAgentcashEndpointSchema({
    method: "POST",
    url: "https://stablestudio.dev/api/images",
  });
  assert.equal(inspection.url, "https://stablestudio.dev/api/images");
  assert.deepEqual(
    inspection.results.map((result) => result.method),
    ["POST"],
  );
  assert.equal(inspectionMethods.length > 0, true);
  assert.deepEqual(new Set(inspectionMethods), new Set(["GET"]));
  assert.deepEqual(new Set(inspectionRedirectModes), new Set(["manual"]));
  inspectionMode = "redirect";
  await assert.rejects(
    inspectAgentcashEndpointSchema({
      method: "POST",
      url: "https://stablestudio.dev/api/images",
    }),
    /could not be loaded safely/u,
  );
  inspectionMode = "oversized";
  await assert.rejects(
    inspectAgentcashEndpointSchema({
      method: "POST",
      url: "https://stablestudio.dev/api/images",
    }),
    /could not be loaded safely/u,
  );
  inspectionMode = "recursive";
  await assert.rejects(
    inspectAgentcashEndpointSchema({
      method: "POST",
      url: "https://stablestudio.dev/api/images",
    }),
    /could not be loaded safely/u,
  );
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(agentcashNoPaymentCeilingUsd > 0, true);
assert.equal(agentcashNoPaymentCeilingUsd < 0.000001, true);
assert.doesNotThrow(() =>
  assertAgentcashFreeSiwxEndpoint(
    {
      results: [
        { authMode: "siwx", method: "GET", requiresPayment: false },
      ],
      url: "https://stablejobs.dev/jobs/123",
    },
    "https://stablejobs.dev/jobs/123",
  ),
);
assert.throws(
  () =>
    assertAgentcashFreeSiwxEndpoint(
      {
      results: [
        { authMode: "siwx", method: "GET", requiresPayment: false },
      ],
      url: "https://stablejobs.dev/jobs/other",
    },
    "https://stablejobs.dev/jobs/123",
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
      url: "https://stablejobs.dev/jobs/123",
    },
    "https://stablejobs.dev/jobs/123",
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

const legacyStore = new MemoryOperationStore();
let legacyCalls = 0;
const legacyToolInput = {
  maxAmount: 0.25,
  method: "GET",
  timeout: 30_000,
  url: "https://stablestudio.dev",
};
const legacyPayment = {
  ...paymentInput,
  callId: "call_legacy_hash",
  operation: async () => {
    legacyCalls += 1;
    return { paid: "legacy" };
  },
  store: legacyStore,
  toolInput: legacyToolInput,
};
assert.deepEqual(await executeAgentcashPayment(legacyPayment), {
  paid: "legacy",
});
const [legacyKey, legacyValue] = [...legacyStore.values.entries()][0] ?? [];
assert.ok(legacyKey && legacyValue);
legacyStore.values.set(
  legacyKey,
  JSON.stringify({
    ...JSON.parse(legacyValue),
    inputHash: legacyAgentcashRequestHash(legacyToolInput),
  }),
);
assert.deepEqual(await executeAgentcashPayment(legacyPayment), {
  paid: "legacy",
});
assert.equal(legacyCalls, 1);

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
