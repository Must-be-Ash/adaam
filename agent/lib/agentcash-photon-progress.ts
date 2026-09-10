export interface AgentcashPhotonProgress {
  readonly id: "price-cap-rejected" | "started";
  readonly message: string;
}

const PRICE_CAP_MESSAGE =
  /^Endpoint requested \$([0-9]+(?:\.[0-9]+)?) which exceeds the maximum allowed amount of \$([0-9]+(?:\.[0-9]+)?)\./u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usd(value: string): string | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && amount <= 100
    ? amount.toFixed(2)
    : null;
}

export function agentcashPhotonAcknowledgement(
  actions: readonly { kind: string; toolName?: string }[],
): AgentcashPhotonProgress | null {
  return actions.some((action) => action.kind === "tool-call" && [
    "agentcash_search",
    "agentcash_discover_api_endpoints",
    "agentcash_check_endpoint_schema",
    "agentcash_fetch",
    "agentcash_fetch_free",
  ].includes(action.toolName ?? ""))
    ? { id: "started", message: "on it!" }
    : null;
}

export function agentcashPhotonProgressEventId(
  sessionId: string,
  turnId: string,
  id: string,
): string {
  return `agentcash-progress:v3:${sessionId}:${turnId}:${id}`;
}

export function agentcashPhotonProgress(
  output: unknown,
): AgentcashPhotonProgress | null {
  const result = record(output);
  if (!result) return null;

  if (
    result.cause === "amount_exceeds_max_amount" &&
    result.surface === "fetch" &&
    result.type === "before_payment" &&
    typeof result.message === "string"
  ) {
    const match = result.message.match(PRICE_CAP_MESSAGE);
    const requested = match?.[1] ? usd(match[1]) : null;
    const approved = match?.[2] ? usd(match[2]) : null;
    if (!requested || !approved) return null;
    return {
      id: "price-cap-rejected",
      message: `The provider now requires $${requested}, above the $${approved} cap you approved. No payment was made. I’ll ask you to approve a new cap before retrying.`,
    };
  }

  return null;
}
