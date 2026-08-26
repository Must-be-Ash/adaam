import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpToolResultError } from "#mcp-tool-result";

import {
  coinbaseCliSha256,
  coinbaseCliSource,
  coinbaseCliVersion,
} from "./coinbase-cli-source.generated";

function materializeCoinbaseCli(): string {
  const directory = join(tmpdir(), "eve-coinbase-runtime");
  const version = coinbaseCliVersion.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const path = join(
    directory,
    `coinbase-cli-${version}-${coinbaseCliSha256.slice(0, 16)}.mjs`,
  );
  const expectedBytes = Buffer.byteLength(coinbaseCliSource);

  const validExistingFile = (): boolean => {
    try {
      const contents = readFileSync(path);
      return (
        contents.byteLength === expectedBytes &&
        createHash("sha256").update(contents).digest("hex") ===
          coinbaseCliSha256
      );
    } catch {
      return false;
    }
  };

  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (validExistingFile()) return path;

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, coinbaseCliSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The successful rename already removed the temporary path.
    }
  }

  if (!validExistingFile()) {
    throw new Error("The embedded Coinbase CLI could not be materialized safely.");
  }
  return path;
}

export const COINBASE_CLI_PATH = materializeCoinbaseCli();
export const COINBASE_CLI_VERSION = coinbaseCliVersion;

interface CoinbaseCredentials {
  keyId: string;
  keySecret: string;
  source: "coinbase" | "compatible-alias";
}

interface CoinbaseExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals;
  stderr?: string;
  stdout?: string;
}

function firstConfigured(
  names: readonly string[],
): { name: string; value: string } | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}

export function coinbaseCredentials(): CoinbaseCredentials {
  const keyId = firstConfigured([
    "COINBASE_KEY_ID",
    "CDP_API_KEY_ID",
    "CDP_API_KEY_NAME",
  ]);
  const keySecret = firstConfigured([
    "COINBASE_KEY_SECRET",
    "CDP_SECRET_KEY",
    "CDP_API_KEY_SECRET",
    "CDP_API_KEY_PRIVATE_KEY",
  ]);

  if (!keyId || !keySecret) {
    throw new Error(
      "Coinbase credentials are not configured. Set COINBASE_KEY_ID and COINBASE_KEY_SECRET in the deployment's encrypted environment.",
    );
  }

  return {
    keyId: keyId.value,
    keySecret: keySecret.value,
    source:
      keyId.name === "COINBASE_KEY_ID" &&
      keySecret.name === "COINBASE_KEY_SECRET"
        ? "coinbase"
        : "compatible-alias",
  };
}

export function coinbaseCredentialsConfigured(): boolean {
  try {
    coinbaseCredentials();
    return true;
  } catch {
    return false;
  }
}

export function coinbaseChildEnvironment(): Record<string, string> {
  const credentials = coinbaseCredentials();
  const homeDirectory = join(tmpdir(), "eve-coinbase-home");
  const configDirectory = join(tmpdir(), "eve-coinbase-config");
  mkdirSync(homeDirectory, { mode: 0o700, recursive: true });
  mkdirSync(configDirectory, { mode: 0o700, recursive: true });
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    COINBASE_CONFIG_DIR: configDirectory,
    COINBASE_ENV: "live",
    COINBASE_KEY_ID: credentials.keyId,
    COINBASE_KEY_SECRET: credentials.keySecret,
    COINBASE_NO_HISTORY: "1",
    COINBASE_NO_UPDATE_CHECK: "1",
    HOME: homeDirectory,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
  };

  for (const name of [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ] as const) {
    if (process.env[name]) environment[name] = process.env[name];
  }

  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const COINBASE_REJECTION_DETAIL_LIMIT = 400;

function scrubCoinbaseSecrets(value: string): string {
  let scrubbed = value;
  for (const name of [
    "COINBASE_KEY_SECRET",
    "COINBASE_KEY_ID",
    "CDP_SECRET_KEY",
    "CDP_API_KEY_SECRET",
    "CDP_API_KEY_PRIVATE_KEY",
    "CDP_API_KEY_ID",
    "CDP_API_KEY_NAME",
  ] as const) {
    const secret = process.env[name]?.trim();
    if (secret && secret.length >= 8) {
      scrubbed = scrubbed.replaceAll(secret, "[credential omitted]");
    }
  }
  return scrubbed;
}

// Coinbase reports API rejections as human-readable `HTTP <status>: <message>`
// text rather than the enum codes matched above, so the only actionable reason a
// call failed (a size minimum, an unsupported product, a closed market) lives in
// that message. Echo it, but only from a normalized MCP tool result: that text
// has already been redacted and bounded by mcp-tool-result. Transport, spawn and
// exec failures can carry child stderr or environment fragments holding
// COINBASE_KEY_SECRET, so they stay opaque.
function coinbaseRejectionDetail(failure: Error): string | undefined {
  if (!(failure instanceof McpToolResultError)) return undefined;
  const detail = scrubCoinbaseSecrets(failure.message).trim();
  if (!detail) return undefined;
  return detail.length > COINBASE_REJECTION_DETAIL_LIMIT
    ? `${detail.slice(0, COINBASE_REJECTION_DETAIL_LIMIT)}…`
    : detail;
}

export function safeCoinbaseFailure(error: unknown): Error {
  const failure =
    error instanceof Error
      ? (error as CoinbaseExecError)
      : (new Error("Unknown Coinbase failure.") as CoinbaseExecError);
  const diagnostic = `${failure.message}\n${failure.stderr ?? ""}\n${failure.stdout ?? ""}`;

  if (
    failure.killed ||
    failure.code === "ETIMEDOUT" ||
    /timed?\s*out|timeout/iu.test(diagnostic)
  ) {
    return new Error(
      "The Coinbase request timed out. Its completion state is unknown; do not retry a write without checking its resulting order or transfer state.",
    );
  }
  if (/401|invalid api key|authentication/iu.test(diagnostic)) {
    return new Error(
      "Coinbase authentication failed. Check COINBASE_KEY_ID and COINBASE_KEY_SECRET.",
    );
  }
  if (/403|missing required scopes|permission|forbidden/iu.test(diagnostic)) {
    return new Error(
      "Coinbase denied this operation. Check the API key's portfolio scope and View, Trade, or Transfer permissions.",
    );
  }
  if (/insufficient fund/iu.test(diagnostic)) {
    return new Error(
      "Coinbase rejected the operation because the scoped portfolio has insufficient available funds.",
    );
  }
  if (/MISSING_FIELDS|INVALID_VALUE|INVALID_FORMAT/iu.test(diagnostic)) {
    return new Error(
      "Coinbase rejected the validated request. Re-check the product, order type, amount, and current product limits.",
    );
  }
  if (/smaller page limit|safe list context budget|narrower query/iu.test(diagnostic)) {
    return new Error(
      "Coinbase returned more records than Eve can safely retain. Retry the same read with a smaller limit or narrower filters; do not advance the cursor from the rejected page.",
    );
  }
  if (/MCP response exceeded \d+ bytes/iu.test(diagnostic)) {
    return new Error(
      "Coinbase returned more data than Eve can safely read in one response. Retry the same read with a smaller limit or narrower filters.",
    );
  }

  const rejection = coinbaseRejectionDetail(failure);
  const status = Number(/\bHTTP\s+(\d{3})\b/u.exec(diagnostic)?.[1] ?? Number.NaN);

  if (status === 429) {
    return new Error(
      `Coinbase rate-limited this request${rejection ? `: ${rejection}` : "."} It was rejected rather than executed; wait before retrying the same call.`,
    );
  }
  // A 5xx can drop the response to an already-accepted write, so its completion
  // state is unknown and must not be reported as a clean rejection.
  if (status >= 500) {
    return new Error(
      `Coinbase's service failed to complete this request${rejection ? `: ${rejection}` : "."} Its completion state is unknown; do not retry a write without checking its resulting order or transfer state.`,
    );
  }
  if (rejection) {
    return new Error(
      `Coinbase rejected this request: ${rejection} It was not submitted, so correct the request before retrying.`,
    );
  }

  return new Error("The Coinbase request failed without a safe diagnostic.");
}
