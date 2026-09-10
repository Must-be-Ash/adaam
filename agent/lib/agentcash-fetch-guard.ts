import { agentcashPublicDispatcher } from "./agentcash-public-network";
import { isAgentcashPublicUrl } from "#agentcash-url";
import { isAgentcashUrlAllowed } from "./agentcash-policy";

type Fetch = typeof globalThis.fetch;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SDK_METADATA_HEADERS = new Set(["x-wallet-address", "x-solana-wallet-address", "x-session-id", "x-client-id"]);
const PUBLIC_READ_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "user-agent"]);

// CDP rejects otherwise valid v2 payloads when resource.description exceeds
// 500 characters (x402-foundation/x402#2832). EIP-3009 signs authorization,
// not this descriptive metadata. Preserve all payment terms and proof bytes.
function normalizePaymentDescription(headers: Headers): void {
  const encoded = headers.get("payment-signature");
  if (!encoded || encoded.length > 120_000) return;
  try {
    const payment = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (payment?.x402Version !== 2 || payment.accepted?.scheme !== "exact" ||
        payment.accepted?.network !== "eip155:8453" ||
        !payment.payload?.authorization || typeof payment.payload.signature !== "string" ||
        typeof payment.resource?.description !== "string") return;
    const characters = Array.from(payment.resource.description);
    if (characters.length <= 500) return;
    payment.resource.description = characters.slice(0, 500).join("");
    headers.set("payment-signature", Buffer.from(JSON.stringify(payment)).toString("base64"));
  } catch {
    // Leave unsupported or malformed payloads for the SDK/provider to reject.
  }
}

/** Follow public, anonymous reads only. Never redirect payment proofs or bodies. */
export function guardAgentcashProviderFetch(nativeFetch: Fetch): Fetch {
  return async (input, init) => {
    const initial = new Request(input, init);
    normalizePaymentDescription(initial.headers);
    if (!isAgentcashPublicUrl(initial.url)) {
      throw new Error("AgentCash requires a public HTTPS destination.");
    }
    let request = initial;
    const anonymousRead = ["GET", "HEAD"].includes(request.method) &&
      [...request.headers.keys()].every((name) => PUBLIC_READ_HEADERS.has(name) || SDK_METADATA_HEADERS.has(name));
    for (let hop = 0; hop <= 3; hop += 1) {
      if (!isAgentcashPublicUrl(request.url)) {
        throw new Error("AgentCash redirect requires a public HTTPS destination.");
      }
      const response = await nativeFetch(new Request(request, { redirect: "manual" }), {
        dispatcher: agentcashPublicDispatcher,
      } as RequestInit);
      if (!REDIRECTS.has(response.status)) {
        // A redirecting paid URL must be inspected and approved at its canonical
        // URL first. Do not let the SDK pay against the original URL's challenge.
        if (hop > 0 && response.status === 402) {
          await response.body?.cancel();
          throw new Error(`AgentCash endpoint moved to ${request.url}. Inspect and approve that exact URL before payment; no payment was made.`);
        }
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 3) throw new Error("AgentCash redirect is missing a destination or exceeds three hops.");
      const target = new URL(location, request.url);
      if (!isAgentcashUrlAllowed(target.href)) throw new Error("AgentCash redirect requires a public HTTPS destination permitted by deployment policy.");
      if (!anonymousRead) {
        throw new Error("AgentCash cannot redirect authenticated requests or request bodies. Inspect and approve the canonical endpoint first; do not automatically retry a paid request.");
      }
      const headers = new Headers(initial.headers);
      for (const name of SDK_METADATA_HEADERS) headers.delete(name);
      request = new Request(target, {
        method: initial.method,
        headers,
        signal: initial.signal,
      });
    }
    throw new Error("AgentCash redirect limit exceeded.");
  };
}
