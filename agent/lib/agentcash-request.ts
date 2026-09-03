import { createHash } from "node:crypto";

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        )
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  throw new Error("The AgentCash request contains a non-JSON value.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalRequest(input: Record<string, unknown>): string {
  const normalized = {
    ...input,
    ...(typeof input.url === "string"
      ? { url: new URL(input.url).toString() }
      : {}),
  };
  return JSON.stringify(canonicalValue(normalized));
}

export function agentcashRequestHash(
  input: Record<string, unknown>,
): string {
  return sha256(canonicalRequest(input));
}

export function agentcashBodyApprovalDescriptor(body: unknown): string {
  if (body === undefined) return "No body.";
  const serialized =
    typeof body === "string"
      ? body
      : JSON.stringify(canonicalValue(body));
  return `Body SHA-256 ${sha256(serialized)} (${Buffer.byteLength(serialized, "utf8")} bytes).`;
}
