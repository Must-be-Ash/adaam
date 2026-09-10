---
description: Use AgentCash to discover, inspect, and call x402- or MPP-protected APIs with the deployment wallet and threshold-based native approval for paid requests.
---

# AgentCash x402 access

AgentCash is Eve's paid-API gateway. It handles SIWX, x402, and MPP payment
proofs using a deployment wallet that is available only to allowlisted users.

## Workflow

1. If the task clearly maps to a known origin, skip search and call
   `agentcash_discover_api_endpoints` directly:
   - people/company, web search, scraping, Maps, email verification, or news:
     `https://stableenrich.dev`
   - social platform data: `https://stablesocial.dev`
   - image or video generation: `https://stablestudio.dev`
   - file/site hosting: `https://stableupload.dev`
   - email: `https://stableemail.dev`
   - phone calls/numbers: `https://stablephone.dev`
   - jobs: `https://stablejobs.dev`
   - travel: `https://stabletravel.dev`
   - browser automation: `https://stablebrowser.dev`
2. Only when no known origin fits, call `agentcash_search`.
3. Discover the origin and read its endpoint guidance. Public HTTPS providers
   are supported without operator registration. Discovery can follow safe
   public redirects.
4. Call `agentcash_check_endpoint_schema` for the exact endpoint and method.
   It reads only the provider's published OpenAPI document and never probes the
   operation. Use its returned canonical URL for the paid request, including
   after a provider-domain redirect. Never forward a payment proof or body to
   a redirect target or automatically retry an uncertain payment. If the provider does not publish that schema, do not guess the
   request shape or treat a dynamic price as exact.
5. Call `agentcash_get_balance` before an expensive request. If funds are
   insufficient, call `agentcash_list_accounts` and give the user the returned
   deposit link; never expose private keys.
6. Show the endpoint, purpose, quoted or maximum cost, protocol/network when
   known, and a request summary. Then call `agentcash_fetch` with the smallest
   safe `maxAmount`, matching the quoted price when known. By default, a cap
   strictly below $1 runs without an approval prompt; $1 and above requires one
   native approval. `agentcash_access_status` exposes the deployment's actual
   `approvalThresholdUsd` and maximum payment ceiling. Never choose an inflated
   cap, split a purchase to evade approval, or ask conversational permission
   for a call already permitted by this policy. For a free quote use a plain
   unauthenticated web read, not a paid request. After approval, continue the
   exact approved call; do not issue a second paid call for the same request.
   The deployment ceiling is authoritative.
7. When a successful paid request returns an async `pollUrl`, call
   `agentcash_fetch_free` for status checks. It verifies that the exact GET
   route is SIWX-only and free before fetching, so polling cannot create
   another payment approval. Never resubmit a pending generation. Keep the
   same payment network across the workflow.

A non-2xx response does not prove that a request was free. If a paid call fails
ambiguously or reports an existing uncertain receipt, do not repay or retry;
inspect provider or wallet history first.

Never pass authorization, cookie, API-key, private-key, or wallet-secret
headers. AgentCash owns authentication and payment.

On iMessage, the channel sends “on it!” when the first AgentCash workflow tool
is requested. Do not send a duplicate acknowledgement. Continue to return the
result or a clear blocker when the task finishes.

## Reporting failed or expired attempts

Distinguish a payment attempt from an approval that expired or was denied before execution. Do not describe a denied or invalid approval response as a second payment attempt. Identify older attempts as historical when resuming after an approval delay. An unchanged wallet balance alone does not prove that no payment settled or that there is no double-charge risk; report the observed balance and whether a settlement receipt or transaction was verified. A facilitator payload rejection does not by itself establish which integration is at fault.
