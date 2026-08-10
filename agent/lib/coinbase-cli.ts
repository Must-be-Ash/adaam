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

  return new Error("The Coinbase request failed without a safe diagnostic.");
}
