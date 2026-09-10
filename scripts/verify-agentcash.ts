import assert from "node:assert/strict";
import { base58 } from "@scure/base";

import { GET as getLaunchSkill } from "../app/skill/route";
import {
  agentcashMaximumPaymentUsd,
  agentcashPaymentApproval,
  agentcashInteractivePaymentApproval,
  agentcashApprovalThresholdUsd,
  agentcashInteractiveCapabilityIds,
  agentcashPrincipalAllowed,
  agentcashPrincipalId,
  agentcashWalletStatus,
  requireAgentcashAccess,
} from "../agent/lib/agentcash-access";
import { agentcashChildEnvironment } from "../agent/lib/agentcash-cli";
import { createAgentcashPublicLookup } from "../agent/lib/agentcash-public-network";
import { isAgentcashPublicUrl } from "../agent/lib/agentcash-url";
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

const launchSkillResponse = getLaunchSkill();
assert.equal(
  launchSkillResponse.headers.get("content-type"),
  "text/markdown; charset=utf-8",
);
const launchSkillSource = await launchSkillResponse.text();
assert.match(
  launchSkillSource,
  /Show my AgentCash accounts and funding addresses\./u,
  "launch onboarding asks Eve to return the deployment funding addresses",
);
assert.match(
  launchSkillSource,
  /agentcash_list_accounts/u,
  "launch onboarding names the read-only account tool",
);
assert.match(
  launchSkillSource,
  /Send USDC only on the exact network\s+shown for that address/u,
  "launch onboarding prevents cross-network USDC deposits",
);
assert.match(
  launchSkillSource,
  /Check my AgentCash balance\./u,
  "launch onboarding verifies the balance after funding",
);
assert.match(
  launchSkillSource,
  /Do not declare\s+AgentCash setup complete until/u,
  "launch onboarding has an AgentCash-specific completion gate",
);
assert.doesNotMatch(
  launchSkillSource,
  /Masterkey/iu,
  "launch onboarding contains no legacy Masterkey setup guidance",
);

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
for (const [maxAmount, expected] of [[0.01, "not-applicable"], [0.99, "not-applicable"], [1, "user-approval"], [2, "user-approval"]] as const) {
  assert.equal(agentcashPaymentApproval({ session: userSession, toolInput: {
    url: "https://stableenrich.dev/api/search", maxAmount,
  }} as never, configuredEnvironment), expected, `Approval policy for $${maxAmount}`);
}
assert.deepEqual(
  agentcashPaymentApproval(
    { session: userSession } as never,
    { ...configuredEnvironment, AGENTCASH_ALLOWED_PRINCIPALS: "" },
  ),
  { reason: "This user is not authorized for AgentCash.", type: "denied" },
);

assert.equal(isAgentcashUrlAllowed("https://new-provider.example/api", {}), true,
  "New public HTTPS providers must work without a hardcoded allowlist");

const parsedFetch = agentcashFetchSchema.parse({
  maxAmount: 0.25,
  method: "POST",
  paymentProtocol: "x402",
  url: "https://stableenrich.dev/api/exa/search",
});
const dripstackUrl = "https://dripstack.com/api/v2/stock-picks";
assert.equal(
  isAgentcashUrlAllowed(dripstackUrl, {}),
  true,
  "DripStack stock picks must be an approved AgentCash provider",
);
assert.equal(
  agentcashFetchSchema.parse({ maxAmount: 1, url: dripstackUrl }).url,
  dripstackUrl,
);
for (const toolName of ["discover_api_endpoints", "check_endpoint_schema"]) {
  assert.equal(
    safeAgentcashReadInput(toolName, { url: dripstackUrl }).url,
    dripstackUrl,
  );
}
assert.equal(isAgentcashUrlAllowed("https://dripstack.com.evil.test/api", {}), false);
assert.equal(isAgentcashUrlAllowed("http://dripstack.com/api", {}), false);
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
      url: "https://127.0.0.1/private",
    }),
  /public HTTPS destination/u,
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

for (const url of ["https://10.0.0.1", "https://[::ffff:127.0.0.1]", "https://127.1", "https://localhost.", "https://service.internal", "https://example.com:8443", "https://example.com/#secret"]) {
  assert.equal(isAgentcashPublicUrl(url), false, url);
}
const runLookup = (addresses: Array<{ address: string; family: number }>, all = false) =>
  new Promise<unknown>((resolve, reject) => {
    createAgentcashPublicLookup(async () => addresses)("provider.example", { all }, (error, address) =>
      error ? reject(error) : resolve(address));
  });
assert.equal(await runLookup([{ address: "8.8.8.8", family: 4 }]), "8.8.8.8");
assert.deepEqual(await runLookup([{ address: "2606:4700:4700::1111", family: 6 }], true),
  [{ address: "2606:4700:4700::1111", family: 6 }]);
for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "::2"]) {
  await assert.rejects(runLookup([{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }]), /public network/u);
}
await assert.rejects(runLookup([]), /public network/u);

const guardedRequests: Request[] = [];
let redirectTarget = "https://canonical.example/api";
let finalStatus = 200;
let loop = false;
const guardedFetch = guardAgentcashProviderFetch(async (input) => {
  const request = input as Request;
  guardedRequests.push(request);
  if (request.url.startsWith("https://old.example/") || loop) {
    return new Response(null, { status: 308, headers: { location: redirectTarget } });
  }
  const response = new Response(null, { status: finalStatus });
  Object.defineProperty(response, "url", { value: request.url });
  return response;
});
assert.equal((await guardedFetch("https://old.example/api")).url, redirectTarget);
assert.equal(guardedRequests.length, 2);
await guardedFetch("https://old.example/api", { headers: {
  "X-Wallet-Address": "public-evm", "X-Solana-Wallet-Address": "public-solana",
  "X-Session-ID": "session", "X-Client-ID": "agentcash", Accept: "application/json",
} });
assert.deepEqual([...guardedRequests.at(-1)!.headers.keys()], ["accept"],
  "SDK metadata is stripped on anonymous redirects");
const previousOrigins = process.env.AGENTCASH_ALLOWED_ORIGINS;
try {
  process.env.AGENTCASH_ALLOWED_ORIGINS = "https://old.example";
  await assert.rejects(guardedFetch("https://old.example/api"), /deployment policy/u);
} finally {
  if (previousOrigins === undefined) delete process.env.AGENTCASH_ALLOWED_ORIGINS;
  else process.env.AGENTCASH_ALLOWED_ORIGINS = previousOrigins;
}
assert.equal(agentcashChildEnvironment({ AGENTCASH_ALLOWED_ORIGINS: "https://old.example" }).AGENTCASH_ALLOWED_ORIGINS,
  "https://old.example", "The child CLI enforces the same optional redirect restriction");

assert.ok(guardedRequests.every((request) => request.redirect === "manual"));
for (const target of ["http://canonical.example/api", "https://127.0.0.1/api",
  "https://169.254.169.254/api", "https://[::1]/api", "https://user:secret@canonical.example/api"]) {
  redirectTarget = target;
  const before = guardedRequests.length;
  await assert.rejects(guardedFetch("https://old.example/api"), /public HTTPS/u);
  assert.equal(guardedRequests.length, before + 1, "Unsafe redirect destination is never contacted");
}
redirectTarget = "https://canonical.example/api";
for (const headers of [{ "payment-signature": "proof" }, { "x-payment": "proof" },
  { Authorization: "Payment proof" }, { Cookie: "secret" }, { "x-custom-secret": "secret" }]) {
  const before = guardedRequests.length;
  await assert.rejects(guardedFetch("https://old.example/api", { headers }), /cannot redirect/u);
  assert.equal(guardedRequests.length, before + 1, "Signed and secret-bearing reads never follow redirects");
}
await assert.rejects(guardedFetch("https://old.example/api", { method: "POST", body: "private data" }), /cannot redirect/u);
finalStatus = 402;
await assert.rejects(guardedFetch("https://old.example/api"), /Inspect and approve.*no payment was made/u);
finalStatus = 200;
loop = true;
await assert.rejects(guardedFetch("https://old.example/api"), /three hops/u);
loop = false;
await assert.rejects(guardedFetch("https://localhost/api"), /public HTTPS/u);

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
let inspectionMode: "oversized" | "recursive" | "redirect" | "cdn" | "success" =
  "success";
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (url.protocol === "data:") return originalFetch(input, init);
  inspectionMethods.push(input instanceof Request ? input.method : init?.method ?? "GET");
  inspectionRedirectModes.push(input instanceof Request ? input.redirect : init?.redirect);
  if (url.pathname === "/openapi.json") {
    if ((inspectionMode === "redirect" || inspectionMode === "cdn") && url.hostname !== "canonical.example") {
      return new Response(null, {
        headers: { location: "https://canonical.example/openapi.json" },
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
    const response = new Response(
      JSON.stringify({
        info: { title: "Fixture API", version: "1.0.0" },
        ...(inspectionMode === "redirect" ? { servers: [{ url: "https://canonical.example" }] } : {}),
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
    Object.defineProperty(response, "url", { value: url.href });
    return response;
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
  const redirectedInspection = await inspectAgentcashEndpointSchema({
    method: "POST", url: "https://stablestudio.dev/api/images",
  });
  assert.equal(redirectedInspection.url, "https://canonical.example/api/images");
  assert.equal(redirectedInspection.results[0]?.method, "POST");
  inspectionMode = "cdn";
  const cdnInspection = await inspectAgentcashEndpointSchema({
    method: "POST", url: "https://stablestudio.dev/api/images",
  });
  assert.equal(cdnInspection.url, "https://stablestudio.dev/api/images",
    "Schema hosting redirects alone do not relocate the API");
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

const rejectedPaymentStore = new MemoryOperationStore();
const rejectedPaymentInput = {
  ...paymentInput,
  store: rejectedPaymentStore,
  attemptScope: "session:turn",
  callId: "first-payment",
  operation: async () => ({ content: [{ type: "text", text: JSON.stringify({
    cause: "http", statusCode: 402, message: "Payment Required", type: "fetch", surface: "fetch",
  }) }] }),
};
await assert.rejects(executeAgentcashPayment(rejectedPaymentInput), /Do not retry/u);
await assert.rejects(executeAgentcashPayment({
  ...rejectedPaymentInput, callId: "protocol-fallback",
  toolInput: { ...parsedFetch, paymentProtocol: "mpp", paymentNetwork: "base" },
}), /already attempted/u);

const caseStore = new MemoryOperationStore();
await assert.rejects(executeAgentcashPayment({
  ...rejectedPaymentInput, store: caseStore, callId: "header-case-first",
  toolInput: { maxAmount: 0.25, url: "https://stableenrich.dev/api/search", headers: { Accept: "application/json" } },
}), /Do not retry/u);
const equivalentApproval = await agentcashInteractivePaymentApproval({
  session: { ...userSession, id: "session", turn: { id: "turn", sequence: 1 } },
  toolInput: { maxAmount: 0.25, method: "GET", url: "https://stableenrich.dev/api/search", headers: { accept: "application/json" } },
} as never, configuredEnvironment, caseStore);
assert.equal(typeof equivalentApproval === "object" && equivalentApproval?.type, "denied",
  "Schema defaults and header casing cannot bypass the retry guard");

const retryApproval = await agentcashInteractivePaymentApproval({
  session: { ...userSession, id: "session", turn: { id: "turn", sequence: 1 } },
  toolInput: { ...parsedFetch, paymentProtocol: "mpp", paymentNetwork: "base" },
} as never, configuredEnvironment, rejectedPaymentStore);
assert.equal(typeof retryApproval === "object" && retryApproval?.type, "denied",
  "Failed purchase retries are denied before another approval card");
await executeAgentcashPayment({
  ...paymentInput, store: rejectedPaymentStore, attemptScope: "session:new-turn",
  callId: "owner-retry-new-turn",
});
assert.equal(agentcashApprovalThresholdUsd({}), 1);
assert.equal(agentcashApprovalThresholdUsd({ AGENTCASH_APPROVAL_THRESHOLD_USD: "5" }), 5);
assert.throws(() => agentcashApprovalThresholdUsd({ AGENTCASH_APPROVAL_THRESHOLD_USD: "NaN" }), /THRESHOLD/u);
for (const environment of [
  { ...configuredEnvironment, AGENTCASH_ALLOWED_PRINCIPALS: "" },
  { ...configuredEnvironment, X402_PRIVATE_KEY: "" },
  { ...configuredEnvironment, AGENTCASH_APPROVAL_THRESHOLD_USD: "NaN" },
]) {
  const result = agentcashPaymentApproval({session: userSession, toolInput: {maxAmount: 0.01}} as never, environment);
  assert.equal(typeof result === "object" && result?.type, "denied");
}
assert.equal(agentcashPaymentApproval({session: userSession, toolInput: {maxAmount: 4}} as never,
  {...configuredEnvironment, AGENTCASH_APPROVAL_THRESHOLD_USD: "5"})?.type, "denied",
  "Auto-approval never bypasses the deployment maximum");

const concurrentStore = new MemoryOperationStore();
let releasePayment!: (value: unknown) => void;
let enteredPayment!: () => void;
const entered = new Promise<void>((resolve) => { enteredPayment = resolve; });
const pending = new Promise<unknown>((resolve) => { releasePayment = resolve; });
let concurrentCalls = 0;
const concurrentInput = {
  ...paymentInput, store: concurrentStore, attemptScope: "concurrent:turn",
  operation: async () => { concurrentCalls += 1; enteredPayment(); return pending; },
};
const firstAttempt = executeAgentcashPayment({ ...concurrentInput, callId: "parallel-first" });
await entered;
await assert.rejects(executeAgentcashPayment({ ...concurrentInput, callId: "parallel-second" }), /already attempted/u);
releasePayment({ paid: true });
await firstAttempt;
assert.equal(concurrentCalls, 1);
const capStore = new MemoryOperationStore();
const capInput = { ...paymentInput, store: capStore, attemptScope: "cap:turn", callId: "cap-first" };
await executeAgentcashPayment({ ...capInput, operation: async () => ({
  type: "before_payment", surface: "fetch", cause: "amount_exceeds_max_amount",
}) });
await executeAgentcashPayment({ ...capInput, callId: "cap-approved", toolInput: { ...parsedFetch, maxAmount: 1 } });

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
