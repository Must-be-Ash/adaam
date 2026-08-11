import { createHash } from "node:crypto";

import type { InputRequest } from "eve/client";

export const PHOTON_APPROVAL_CALLBACK_ID = "eve-photon-approval-v1";
export const PHOTON_APPROVAL_DECISION_FIELD = "decision";

const MAX_POLL_TITLE_LENGTH = 140;
const APPROVAL_WINDOW_MS = 10 * 60_000;
const ORDER_APPROVAL_WINDOW_MS = 5 * 60_000;

const PHOTON_SUPPORTED_COINBASE_APPROVALS = new Set([
  "coinbase_create_order",
]);

export type PhotonApprovalDecision = "approve" | "deny";

export interface PhotonApprovalPrompt {
  approvalCode: string;
  expiresAtMs: number;
  pollTitle: string;
  requestId: string;
  toolName: string;
}

export interface PhotonPollVote {
  approvalCode: string;
  decision: PhotonApprovalDecision | null;
  pollTitle: string;
  selected: boolean;
}

const APPROVAL_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

function approvalCode(requestId: string): string {
  return createHash("sha256")
    .update("eve-photon-approval\u0000")
    .update(requestId)
    .digest("base64url")
    .slice(0, 22);
}

export function approvalCodeFromPollTitle(
  pollTitle: string,
): string | null {
  const separator = pollTitle.lastIndexOf(" · ");
  if (separator < 0) return null;
  const code = pollTitle.slice(separator + " · ".length);
  return APPROVAL_CODE_PATTERN.test(code) ? code : null;
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
    .replace(/^coinbase_/u, "")
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
    case "delete_event_trigger": {
      const id = boundedString(
        input.id,
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
      );
      if (!id) {
        throw new Error(
          "The event-trigger deletion cannot be rendered as an exact approval.",
        );
      }
      return `Delete event trigger ${id}?`;
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
  return toolName.startsWith("coinbase_")
    ? PHOTON_SUPPORTED_COINBASE_APPROVALS.has(toolName)
    : toolName === "delete_event_trigger";
}

export function createPhotonApprovalPrompt(
  request: InputRequest,
  nowMs = Date.now(),
): PhotonApprovalPrompt {
  if (request.kind !== "tool-approval") {
    throw new Error("Photon approval prompts require a tool-approval request.");
  }

  const suffix = approvalCode(request.requestId);
  const availableSummaryLength =
    MAX_POLL_TITLE_LENGTH - suffix.length - " · ".length;
  const summary = approvalSummary(request);
  if (summary.length > availableSummaryLength) {
    throw new Error(
      "The approval details are too long for an exact iMessage prompt.",
    );
  }

  return {
    approvalCode: suffix,
    expiresAtMs:
      request.action.toolName === "coinbase_create_order"
        ? orderPreviewExpiry(request.action.input, nowMs)
        : nowMs + APPROVAL_WINDOW_MS,
    pollTitle: `${summary} · ${suffix}`,
    requestId: request.requestId,
    toolName: request.action.toolName,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function parsePhotonPollVote(raw: unknown): PhotonPollVote | null {
  const message = objectValue(raw);
  const content = objectValue(message?.content);
  if (content?.type !== "poll_option") return null;

  const poll = objectValue(content.poll);
  const option = objectValue(content.option);
  const pollTitle =
    typeof poll?.title === "string" ? poll.title.trim() : undefined;
  const optionTitle =
    typeof option?.title === "string" ? option.title.trim().toLowerCase() : "";
  if (!pollTitle) return null;
  const code = approvalCodeFromPollTitle(pollTitle);
  if (!code) return null;

  return {
    approvalCode: code,
    decision:
      optionTitle === "approve"
        ? "approve"
        : optionTitle === "deny"
          ? "deny"
          : null,
    pollTitle,
    selected: content.selected === true,
  };
}

export function parsePhotonTextDecision(
  text: string,
): { approvalCode: string; decision: PhotonApprovalDecision } | null {
  const match = text.match(
    /^\s*(APPROVE|DENY)\s+([A-Za-z0-9_-]{22})\s*[.!]?\s*$/iu,
  );
  if (!match?.[1] || !match[2]) return null;
  return {
    approvalCode: match[2],
    decision: match[1].toLowerCase() as PhotonApprovalDecision,
  };
}

export function isUnscopedApprovalAlias(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const numericOption = Number(normalized);
  return (
    normalized === "approve" ||
    (normalized.length > 0 &&
      Number.isInteger(numericOption) &&
      numericOption > 0)
  );
}
