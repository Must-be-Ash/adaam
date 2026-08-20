function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPhotonContentlessOutboundControlEcho(message: {
  attachments?: readonly unknown[];
  raw?: unknown;
  text: string;
}): boolean {
  if (
    message.text.length > 0 ||
    (message.attachments?.length ?? 0) > 0 ||
    !isRecord(message.raw) ||
    message.raw.direction !== "inbound"
  ) {
    return false;
  }
  const content = message.raw.content;
  if (
    !isRecord(content) ||
    (content.type !== "reply" && content.type !== "read") ||
    "content" in content
  ) {
    return false;
  }
  const target = content.target;
  return isRecord(target) && target.direction === "outbound";
}
