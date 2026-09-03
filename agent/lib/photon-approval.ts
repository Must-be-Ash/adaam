import type { InputRequest } from "eve/client";

import {
  agentcashBodyApprovalDescriptor,
  agentcashRequestHash,
} from "#agentcash-request";
import { isAgentcashUrlAllowed } from "#agentcash-policy";

const MAX_APPROVAL_TEXT_LENGTH = 500;
const APPROVAL_WINDOW_MS = 10 * 60_000;
const ORDER_APPROVAL_WINDOW_MS = 5 * 60_000;

const PHOTON_SUPPORTED_COINBASE_APPROVALS = new Set([
  "coinbase_create_order",
]);
const PHOTON_SUPPORTED_AGENTCASH_APPROVALS = new Set(["agentcash_fetch"]);

export type PhotonApprovalDecision = "approve" | "deny";

export interface PhotonApprovalPrompt {
  approvalText: string;
  expiresAtMs: number;
  requestId: string;
  toolName: string;
}

function boundedString(
  value: unknown,
  pattern: RegExp,
  maxLength = 40,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !pattern.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function decimal(value: unknown): string | undefined {
  return boundedString(value, /^(?:0|[1-9]\d*)(?:\.\d+)?$/u, 40);
}

function product(value: unknown): string | undefined {
  return boundedString(
    value,
    /^[A-Z0-9]{1,20}-[A-Z0-9]{1,20}$/u,
    41,
  );
}

function orderApprovalSummary(input: Record<string, unknown>): string | null {
  const productId = product(input.productId);
  const [baseCurrency, quoteCurrency] = productId?.split("-") ?? [];
  const side = input.side === "BUY" || input.side === "SELL" ? input.side : null;
  const orderType =
    input.type === "market" ||
    input.type === "limit" ||
    input.type === "stop_limit"
      ? input.type
      : null;
  const quoteSize = decimal(input.quoteSize);
  const baseSize = decimal(input.baseSize);
  const limitPrice = decimal(input.limitPrice);
  const stopPrice = decimal(input.stopPrice);
  const stopDirection =
    input.stopDirection === "up" || input.stopDirection === "down"
      ? input.stopDirection
      : null;

  if (!productId || !side || !orderType) {
    return null;
  }

  if (
    orderType === "market" &&
    side === "BUY" &&
    quoteSize &&
    quoteCurrency &&
    baseCurrency
  ) {
    return `Buy ${quoteSize} ${quoteCurrency} of ${baseCurrency}?`;
  }
  if (orderType === "market" && side === "SELL" && baseSize && baseCurrency) {
    return `Sell ${baseSize} ${baseCurrency}?`;
  }
  if (
    (orderType === "limit" || orderType === "stop_limit") &&
    baseSize &&
    baseCurrency &&
    quoteCurrency &&
    limitPrice
  ) {
    const stop =
      orderType === "stop_limit" && stopPrice && stopDirection
        ? ` after ${stopDirection} stop ${stopPrice}`
        : "";
    if (orderType === "stop_limit" && !stop) return null;
    return `${side === "BUY" ? "Buy" : "Sell"} ${baseSize} ${baseCurrency} at ${limitPrice} ${quoteCurrency}${stop}?`;
  }
  return null;
}

function readableToolName(toolName: string): string {
  return toolName
    .replace(/^(?:agentcash|coinbase)_/u, "")
    .replaceAll("_", " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function approvalSummary(request: InputRequest): string {
  const { input, toolName } = request.action;
  switch (toolName) {
    case "coinbase_create_order": {
      const summary = orderApprovalSummary(input);
      if (!summary) {
        throw new Error(
          "The Coinbase order cannot be rendered as an exact approval.",
        );
      }
      return summary;
    }
    case "agentcash_fetch": {
      const url = typeof input.url === "string" ? input.url : "";
      const method =
        typeof input.method === "string" &&
        /^(?:DELETE|GET|PATCH|POST|PUT)$/u.test(input.method)
          ? input.method
          : "GET";
      const maxAmount =
        typeof input.maxAmount === "number" &&
        Number.isFinite(input.maxAmount) &&
        input.maxAmount > 0 &&
        input.maxAmount <= 100
          ? input.maxAmount
          : null;
      let endpoint: string;
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.username ||
          parsed.password ||
          parsed.hash ||
          !isAgentcashUrlAllowed(url)
        ) {
          throw new Error("unsafe AgentCash endpoint");
        }
        endpoint = parsed.toString();
      } catch {
        throw new Error(
          "The AgentCash request cannot be rendered as an exact approval.",
        );
      }
      if (!maxAmount || endpoint.length > 240) {
        throw new Error(
          "The AgentCash request cannot be rendered as an exact approval.",
        );
      }
      const requestHash = agentcashRequestHash(input);
      const body = agentcashBodyApprovalDescriptor(input.body);
      return `Approve AgentCash ${method} ${endpoint} for up to $${maxAmount.toFixed(2)}? Request SHA-256 ${requestHash}. ${body}`;
    }
    default: {
      const readableName = readableToolName(toolName);
      return readableName
        ? `Approve ${readableName}?`
        : "Approve this action?";
    }
  }
}

function orderPreviewExpiry(
  input: Record<string, unknown>,
  nowMs: number,
): number {
  const defaultExpiry = nowMs + ORDER_APPROVAL_WINDOW_MS;
  if (typeof input.previewToken !== "string") return defaultExpiry;
  const [encoded] = input.previewToken.split(".");
  if (!encoded) return defaultExpiry;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof Reflect.get(payload, "expiresAtMs") === "number"
    ) {
      return Math.min(defaultExpiry, Reflect.get(payload, "expiresAtMs"));
    }
  } catch {
    return defaultExpiry;
  }
  return defaultExpiry;
}

export function isPhotonApprovalSupported(request: InputRequest): boolean {
  if (request.kind !== "tool-approval") return false;
  const toolName = request.action.toolName;
  return (
    (toolName.startsWith("coinbase_") &&
      PHOTON_SUPPORTED_COINBASE_APPROVALS.has(toolName)) ||
    (toolName.startsWith("agentcash_") &&
      PHOTON_SUPPORTED_AGENTCASH_APPROVALS.has(toolName))
  );
}

export function createPhotonApprovalPrompt(
  request: InputRequest,
  nowMs = Date.now(),
): PhotonApprovalPrompt {
  if (request.kind !== "tool-approval") {
    throw new Error("Photon approval prompts require a tool-approval request.");
  }

  const summary = approvalSummary(request);
  if (summary.length > MAX_APPROVAL_TEXT_LENGTH) {
    throw new Error(
      "The approval details are too long for an exact iMessage prompt.",
    );
  }

  return {
    approvalText: summary,
    expiresAtMs:
      request.action.toolName === "coinbase_create_order"
        ? orderPreviewExpiry(request.action.input, nowMs)
        : nowMs + APPROVAL_WINDOW_MS,
    requestId: request.requestId,
    toolName: request.action.toolName,
  };
}

export function parsePhotonTextDecision(
  text: string,
): PhotonApprovalDecision | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .trim();
  if (
    normalized === "yes" ||
    normalized === "approve"
  ) {
    return "approve";
  }
  if (
    normalized === "no" ||
    normalized === "deny" ||
    normalized === "cancel"
  ) {
    return "deny";
  }
  return null;
}

export function isPhotonApprovalAlias(text: string): boolean {
  if (parsePhotonTextDecision(text)) return true;
  const normalized = text.trim().toLowerCase();
  const numericOption = Number(normalized);
  return (
    normalized.length > 0 &&
    Number.isInteger(numericOption) &&
    numericOption > 0
  );
}
