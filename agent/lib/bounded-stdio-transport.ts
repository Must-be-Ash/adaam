import { spawn, type ChildProcess } from "node:child_process";

import {
  validateJSONRPCMessage,
  type JSONRPCMessage,
  type MCPTransport,
} from "@ai-sdk/mcp";

import { McpResponseTooLargeError } from "#mcp-response-limit";

/**
 * A stdio MCP transport that mirrors `@ai-sdk/mcp`'s
 * `Experimental_StdioMCPTransport` but caps the size of a single unparsed
 * JSON-RPC frame before it is buffered and parsed.
 *
 * The upstream transport accumulates stdout into a `Buffer` until it sees a
 * newline, with no upper bound. A pathological or oversized stdio response
 * therefore grows memory without limit and is fully parsed before any
 * post-parse context ceiling applies. This transport aborts the child and
 * surfaces a `McpResponseTooLargeError` as soon as the pending frame exceeds
 * `maximumBytes`, giving stdio the same pre-parse protection the bounded HTTP
 * fetch already provides.
 *
 * Spawn semantics (environment inheritance, stdio wiring, `shell: false`,
 * abort-driven teardown) are kept identical to the upstream transport so the
 * only behavioral change is the added byte bound.
 */
export interface BoundedStdioConfig {
  args?: string[];
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  maximumBytes: number;
  onLimitExceeded?: (error: McpResponseTooLargeError) => void;
  stderr?: "ignore" | "inherit" | "pipe";
}

const DEFAULT_INHERITED_ENV_VARS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/** Faithful copy of `@ai-sdk/mcp`'s internal `getEnvironment`. */
function childEnvironment(
  customEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = customEnv ? { ...customEnv } : {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined || value.startsWith("()")) continue;
    env[key] = value;
  }
  return env;
}

class BoundedReadBuffer {
  private buffer?: Buffer;
  private readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    this.maximumBytes = maximumBytes;
  }

  append(chunk: Buffer): void {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
  }

  /** True when the next complete or pending frame exceeds the byte cap. */
  nextFrameExceedsLimit(): boolean {
    if (!this.buffer) return false;
    const newlineIndex = this.buffer.indexOf(10);
    const frameBytes =
      newlineIndex === -1 ? this.buffer.byteLength : newlineIndex;
    return frameBytes > this.maximumBytes;
  }

  readLine(): string | null {
    if (!this.buffer) return null;
    const index = this.buffer.indexOf(10);
    if (index === -1) return null;
    const line = this.buffer.toString("utf8", 0, index);
    this.buffer = this.buffer.subarray(index + 1);
    return line;
  }

  clear(): void {
    this.buffer = undefined;
  }
}

export class BoundedStdioMCPTransport implements MCPTransport {
  private abortController = new AbortController();
  private process?: ChildProcess;
  private readBuffer: BoundedReadBuffer;
  private readonly config: BoundedStdioConfig;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(config: BoundedStdioConfig) {
    this.config = config;
    if (
      !Number.isSafeInteger(config.maximumBytes) ||
      config.maximumBytes <= 0
    ) {
      throw new Error("The stdio response limit must be a positive integer.");
    }
    this.readBuffer = new BoundedReadBuffer(config.maximumBytes);
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error("BoundedStdioMCPTransport already started.");
    }
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(this.config.command, this.config.args ?? [], {
          cwd: this.config.cwd,
          // This project augments ProcessEnv to require NODE_ENV; the runtime
          // map is a valid child environment, so satisfy the type at the call.
          env: childEnvironment(this.config.env) as NodeJS.ProcessEnv,
          shell: false,
          signal: this.abortController.signal,
          stdio: ["pipe", "pipe", this.config.stderr ?? "inherit"],
          windowsHide:
            process.platform === "win32" && "type" in process,
        });
        this.process = child;

        child.on("error", (error) => {
          if (error.name === "AbortError") {
            this.onclose?.();
            return;
          }
          reject(error);
          this.onerror?.(error);
        });
        child.on("spawn", () => resolve());
        child.on("close", () => {
          this.process = undefined;
          this.onclose?.();
        });
        child.stdin?.on("error", (error) => this.onerror?.(error));
        child.stdout?.on("data", (chunk: Buffer) => {
          this.readBuffer.append(chunk);
          this.processReadBuffer();
        });
        child.stdout?.on("error", (error) => this.onerror?.(error));
      } catch (error) {
        reject(error as Error);
        this.onerror?.(error as Error);
      }
    });
  }

  private processReadBuffer(): void {
    while (true) {
      if (this.readBuffer.nextFrameExceedsLimit()) {
        const error = new McpResponseTooLargeError(
          this.config.maximumBytes,
        );
        this.readBuffer.clear();
        this.config.onLimitExceeded?.(error);
        this.onerror?.(error);
        this.abortController.abort(error);
        return;
      }
      const line = this.readBuffer.readLine();
      if (line === null) break;
      if (line.trim().length === 0) continue;
      try {
        this.onmessage?.(validateJSONRPCMessage(JSON.parse(line)));
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const stdin = this.process?.stdin;
      if (!stdin) throw new Error("BoundedStdioMCPTransport not connected.");
      const json = `${JSON.stringify(message)}\n`;
      if (stdin.write(json)) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    this.abortController.abort();
    this.process = undefined;
    this.readBuffer.clear();
  }
}
