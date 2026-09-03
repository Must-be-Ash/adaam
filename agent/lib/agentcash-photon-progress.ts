export interface AgentcashPhotonProgress {
  readonly id: "price-cap-rejected" | "provider-working";
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

function textContent(output: Record<string, unknown>): unknown[] {
  if (!Array.isArray(output.content) || output.content.length > 20) return [];
  return output.content.flatMap((entry) => {
    const item = record(entry);
    if (
      item?.type !== "text" ||
      typeof item.text !== "string" ||
      item.text.length > 10_000
    ) {
      return [];
    }
    try {
      return [JSON.parse(item.text) as unknown];
    } catch {
      return [];
    }
  });
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

  const payloads = textContent(result).map(record).filter(Boolean);
  const pending = payloads.some(
    (payload) =>
      payload?.success === true &&
      payload.status === "pending" &&
      typeof payload.jobId === "string" &&
      typeof payload.pollUrl === "string" &&
      (() => {
        try {
          return new URL(payload.pollUrl).protocol === "https:";
        } catch {
          return false;
        }
      })(),
  );
  const paymentSucceeded = payloads.some(
    (payload) => record(payload?.payment)?.success === true,
  );
  if (pending && paymentSucceeded) {
    return {
      id: "provider-working",
      message: "on it!",
    };
  }
  return null;
}
