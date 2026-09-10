// Only allowlisted scalars leave payment results. Never retain response bodies,
// arbitrary messages, wallet addresses, headers, or payment signatures in logs.
export function agentcashPaymentDiagnostic(result: unknown) {
  const diagnostic: {
    category: "unclassified_failure" | "http_failure" | "facilitator_payload_rejected";
    statusCode?: number;
    protocol?: string;
    network?: string;
    settlementSuccess?: boolean;
    upstreamCorrelationId?: string;
  } = { category: "unclassified_failure" };
  let remaining = 150;
  function visit(value: unknown, depth: number): void {
    if (--remaining < 0 || depth > 8 || !value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (Number.isInteger(record.statusCode) && Number(record.statusCode) >= 100 && Number(record.statusCode) <= 599) {
      diagnostic.statusCode = Number(record.statusCode);
      if (diagnostic.category === "unclassified_failure") diagnostic.category = "http_failure";
    }
    if (["x402", "mpp"].includes(String(record.protocol))) diagnostic.protocol = String(record.protocol);
    if (["base", "solana", "tempo", "polygon", "ethereum"].includes(String(record.network))) diagnostic.network = String(record.network);
    if (record.payment && typeof record.payment === "object" && typeof Reflect.get(record.payment, "success") === "boolean") {
      diagnostic.settlementSuccess = Reflect.get(record.payment, "success");
    }
    for (const [key, item] of Object.entries(record).slice(0, 50)) {
      if (key === "text" && typeof item === "string" && item.length <= 120_000) {
        try { visit(JSON.parse(item), depth + 1); } catch { /* Non-JSON content is not diagnostic data. */ }
      } else if (key.toLowerCase() === "payment-required" && typeof item === "string" && item.length <= 32_000) {
        try {
          const challenge = JSON.parse(Buffer.from(item, "base64").toString("utf8"));
          const error = typeof challenge.error === "string" ? challenge.error : "";
          if (/Facilitator verify failed/u.test(error) && /paymentPayload.*invalid/u.test(error)) {
            diagnostic.category = "facilitator_payload_rejected";
          }
          const correlation = error.match(/"correlationId"\s*:\s*"([a-zA-Z0-9-]{1,80})"/u);
          if (correlation) diagnostic.upstreamCorrelationId = correlation[1];
        } catch { /* Malformed provider metadata must not obscure the failure. */ }
      } else if (item && typeof item === "object") visit(item, depth + 1);
    }
  }
  visit(result, 0);
  return diagnostic;
}
