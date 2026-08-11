import type { JsonObject, JsonValue } from "./mcp-tool-result";

const BALANCE_REQUESTS = new Set([
  "balance",
  "balances",
  "check balance",
  "check balances",
  "check my balance",
  "check my balances",
  "check my coinbase balance",
  "check my coinbase balances",
  "get my balance",
  "get my balances",
  "get my coinbase balance",
  "get my coinbase balances",
  "my balance",
  "my balances",
  "show my balance",
  "show my balances",
  "show my coinbase balance",
  "show my coinbase balances",
  "what is my balance",
  "what is my coinbase balance",
  "what's my balance",
  "what's my coinbase balance",
]);

function normalizedRequest(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currency(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^[A-Z0-9.-]{1,20}$/u.test(value)
    ? value
    : null;
}

function amount(value: JsonValue | undefined): string | null {
  return typeof value === "string" &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) &&
    value.length <= 50
    ? value
    : null;
}

function isZero(value: string): boolean {
  return /^0(?:\.0+)?$/u.test(value);
}

export function isCoinbaseBalanceRequest(text: string): boolean {
  const normalized = normalizedRequest(text);
  if (BALANCE_REQUESTS.has(normalized)) return true;
  if (
    normalized.length > 160 ||
    !/\bbalances?\b/u.test(normalized) ||
    /\b(?:balance sheet|rebalance|buy|sell|trade|order|transfer|convert|risk|return)\b/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return /\b(?:my|coinbase|account|wallet|portfolio)\b/u.test(normalized);
}

export function formatCoinbaseBalance(result: JsonValue): string {
  if (!isObject(result) || !Array.isArray(result.accounts)) {
    throw new Error("Coinbase returned an invalid balance response.");
  }

  const lines: string[] = [];
  for (const candidate of result.accounts) {
    if (!isObject(candidate)) continue;
    const available = isObject(candidate.available_balance)
      ? candidate.available_balance
      : undefined;
    const hold = isObject(candidate.hold) ? candidate.hold : undefined;
    const symbol =
      currency(candidate.currency) ?? currency(available?.currency);
    const availableAmount = amount(available?.value);
    if (!symbol || !availableAmount) continue;

    const holdAmount = amount(hold?.value);
    lines.push(
      `${symbol}: ${availableAmount} available${
        holdAmount && !isZero(holdAmount) ? ` · ${holdAmount} on hold` : ""
      }`,
    );
  }

  if (lines.length === 0) {
    return "Coinbase returned no non-zero balances.";
  }

  const paginationNotice =
    result.has_next === true
      ? "\n\nMore Coinbase accounts exist than fit in this response."
      : "";
  return `Coinbase balances\n${lines.join("\n")}${paginationNotice}`;
}
