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

import { agentcashAllowedOrigins } from "#agentcash-policy";
import { McpResponseTooLargeError } from "#mcp-response-limit";
import { McpToolResultError } from "#mcp-tool-result";

import {
  agentcashCliSha256,
  agentcashCliSource,
  agentcashCliVersion,
} from "./agentcash-cli-source.generated";
import {
  isAgentcashEvmPrivateKey,
  normalizeAgentcashSolanaPrivateKey,
} from "./agentcash-wallet";

function materializeAgentcashCli(): string {
  const directory = join(tmpdir(), "eve-agentcash-runtime");
  const version = agentcashCliVersion.replace(/[^a-zA-Z0-9._-]/gu, "_");
  const path = join(
    directory,
    `agentcash-${version}-${agentcashCliSha256.slice(0, 16)}.mjs`,
  );
  const expectedBytes = Buffer.byteLength(agentcashCliSource);
  const valid = (): boolean => {
    try {
      const contents = readFileSync(path);
      return (
        contents.byteLength === expectedBytes &&
        createHash("sha256").update(contents).digest("hex") ===
          agentcashCliSha256
      );
    } catch {
      return false;
    }
  };
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (valid()) return path;
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, agentcashCliSource, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A successful rename already removed the temporary file.
    }
  }
  if (!valid()) {
    throw new Error("The embedded AgentCash CLI could not be verified.");
  }
  return path;
}

export const AGENTCASH_CLI_PATH = materializeAgentcashCli();
export const AGENTCASH_CLI_VERSION = agentcashCliVersion;

export function agentcashChildEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const homeDirectory = join(tmpdir(), "eve-agentcash-home");
  mkdirSync(homeDirectory, { mode: 0o700, recursive: true });
  const solanaPrivateKey = normalizeAgentcashSolanaPrivateKey(
    sourceEnvironment.X402_SOLANA_PRIVATE_KEY,
  );
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    EVE_AGENTCASH_ALLOWED_ORIGINS:
      agentcashAllowedOrigins(sourceEnvironment).join(","),
    HOME: homeDirectory,
    LANG: sourceEnvironment.LANG ?? "C.UTF-8",
    NODE_ENV: sourceEnvironment.NODE_ENV ?? "production",
    PATH: sourceEnvironment.PATH ?? "",
    TMPDIR: tmpdir(),
    X402_PRIVATE_KEY: isAgentcashEvmPrivateKey(sourceEnvironment.X402_PRIVATE_KEY)
      ? sourceEnvironment.X402_PRIVATE_KEY
      : undefined,
    X402_SOLANA_PRIVATE_KEY: solanaPrivateKey,
  };
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function safeAgentcashFailure(error: unknown): Error {
  if (error instanceof McpToolResultError) return error;
  const failure =
    error instanceof Error ? error : new Error("Unknown AgentCash failure.");
  if (
    failure instanceof McpResponseTooLargeError ||
    /response exceeded \d+ bytes/iu.test(failure.message)
  ) {
    return new Error(
      "AgentCash returned more than 8 MiB inline, so Eve aborted before retaining it. A paid call may have completed; inspect wallet or provider history before retrying and request a narrower result.",
    );
  }
  if (
    failure.name === "AbortError" ||
    /timed?\s*out|timeout/iu.test(failure.message)
  ) {
    return new Error(
      "The AgentCash request timed out. A paid call may have completed; inspect wallet or provider history before retrying it.",
    );
  }
  return new Error("The AgentCash request failed without a safe diagnostic.");
}
