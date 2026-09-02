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
import { McpResponseTooLargeError } from "#mcp-response-limit";

import {
  agentcashCliSha256,
  agentcashCliSource,
  agentcashCliVersion,
} from "./agentcash-cli-source.generated";
import {
  isAgentcashEvmPrivateKey,
  isAgentcashSolanaPrivateKey,
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

export function agentcashChildEnvironment(): Record<string, string> {
  const homeDirectory = join(tmpdir(), "eve-agentcash-home");
  mkdirSync(homeDirectory, { mode: 0o700, recursive: true });
  const environment: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: homeDirectory,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpdir(),
    X402_PRIVATE_KEY: isAgentcashEvmPrivateKey(process.env.X402_PRIVATE_KEY)
      ? process.env.X402_PRIVATE_KEY
      : undefined,
    X402_SOLANA_PRIVATE_KEY: isAgentcashSolanaPrivateKey(
      process.env.X402_SOLANA_PRIVATE_KEY,
    )
      ? process.env.X402_SOLANA_PRIVATE_KEY
      : undefined,
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
