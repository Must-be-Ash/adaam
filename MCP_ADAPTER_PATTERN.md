# Mandatory MCP adapter pattern

Every MCP added to this template must pass through an application-owned adapter. Do not
expose a remote or local MCP tool's raw `CallToolResult` directly to Eve model history.
Raw results can duplicate `content` and `structuredContent`, persist binary data, expose
credentials, and replay oversized payloads on every later model step.

## Required layers

1. **Curated tool surface**
   - Allow only the tools the agent needs.
   - Hide native operations that bypass product safety workflows.
   - Apply runtime, tenant, channel, and approval policies in the adapter.
   - Do not register a raw declarative MCP connection merely to obtain OAuth. Resolve
     the authorization provider inside the guarded tools so catalog discovery cannot
     bypass transport bounds.

2. **Provider normalization policy**
   - Create `agent/lib/<provider>-mcp-policy.ts`.
   - Preserve the provider's critical identifiers, decimal strings, timestamps, cursors,
     status fields, and result collections.
   - Set explicit array, result, string, and total-output bounds.
   - Provider values are clamped to the shared immutable hard ceilings.
   - Reject a cursor-based page rather than returning its next cursor after omitting
     records; the caller must retry the same page with a smaller limit.
   - Keep provider-specific rules out of the shared normalizer.

3. **Shared result normalization**
   - Call `normalizeMcpToolResult` from `agent/lib/mcp-tool-result.ts`.
   - Prefer one structured result over duplicate text envelopes.
   - Strip auxiliary inline binary media while preserving useful structured or text
     data and setting `inlineArtifactsOmitted: true`.
   - Reject inline-only binary media and credential-bearing output URLs. A paid
     provider may already have completed, so the resulting error must direct the
     caller to recover the existing job instead of paying to retry.
   - Always prioritize durable artifact URL fields, including when a
     provider-specific policy omits them, and fail explicitly if a supplied URL
     cannot survive the final context budget.
   - Redact credentials in success values, errors, URLs, and nested objects.
   - Name fields dropped by the object-key cap and use an explicit marker when
     nested data exceeds the depth limit.
   - Enforce the final serialized-size ceiling before returning from `execute`.

4. **Transport controls**
   - HTTP MCPs must use `createBoundedFetch` from
     `agent/lib/mcp-response-limit.ts`, propagate limit failures to the active call's
     `AbortSignal`, and use explicit initialization/tool timeouts.
   - Stdio MCPs must use a pinned trusted binary, an isolated minimal environment,
     disabled command history, ignored or sanitized stderr, explicit timeouts, and the
     shared result normalizer.
   - Stdio responses must pass through `BoundedStdioMCPTransport` (or an
     equivalently tested transport) so every newline-delimited frame is byte-bounded
     before `JSON.parse`, whether the oversized frame is complete or still pending.

5. **Write safety**
   - Require explicit approval for financial, account, data, or external mutations.
   - Supply application-owned replay protection for paid and non-idempotent calls.
   - Treat timeouts as uncertain outcomes; reconcile state instead of retrying.
   - Resolve opaque IDs to their resource and enforce policy before mutating by ID.

6. **Regression gates**
   - Test duplicate envelopes, inline binary data, hard output limits, nested secrets,
     signed URLs, long legitimate text, provider-critical fields, pagination, and
     transport timeout/size behavior.
   - Run the context regression suite during `prebuild`.
   - Require typecheck, build, and a provider-specific safety review before deployment.

## Adapter skeleton

```ts
const result = await client.callTool({
  name,
  arguments: input,
  options: { signal: ctx.abortSignal, timeout: TOOL_TIMEOUT_MS },
});

return normalizeMcpToolResult(
  result,
  providerMcpNormalizationPolicy(name),
);
```

The adapter may return less data to the model than the provider returned, but it must
never silently alter identifiers, monetary values, currencies, timestamps, or mutation
status. If safe normalization would make a paid artifact unusable, fail explicitly
instead of reporting a broken or credential-bearing URL.

## Current implementations

- Masterkey uses guarded HTTP MCP wrappers, a provider policy, bounded streaming
  responses, replay-stable paid-call IDs, and denial of paid calls from runtime
  sessions. User-initiated research calls do not receive a redundant Eve-side
  approval. It does not register a raw discoverable MCP connection.
- Coinbase uses a credential-isolated stdio MCP bridge, a Coinbase policy that preserves
  financial fields and pagination cursors, rejects partial pages, byte-bounds each
  JSON-RPC frame before parsing, applies shared result normalization, and retains
  approval gates, replay protection, and spot-product preflight checks.

Any exception to this pattern requires an explicit security review and a regression test
demonstrating why raw MCP output is safe.
