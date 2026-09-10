import { agentcashPublicDispatcher } from "./agentcash-public-network";
import { isAgentcashPublicUrl } from "#agentcash-url";
import { isAgentcashUrlAllowed } from "./agentcash-policy";

type Fetch = typeof globalThis.fetch;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SDK_METADATA_HEADERS = new Set(["x-wallet-address", "x-solana-wallet-address", "x-session-id", "x-client-id"]);
const PUBLIC_READ_HEADERS = new Set(["accept", "accept-encoding", "accept-language", "user-agent"]);

/** Follow public, anonymous reads only. Never redirect payment proofs or bodies. */
export function guardAgentcashProviderFetch(nativeFetch: Fetch): Fetch {
  return async (input, init) => {
    const initial = new Request(input, init);
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
