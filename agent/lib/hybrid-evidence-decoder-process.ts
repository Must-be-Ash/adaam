import { spawn } from "node:child_process";

const MAX_DECODER_STDOUT_BYTES = 32 * 1_024 * 1_024;
const MAX_DECODER_STDERR_BYTES = 16 * 1_024;
const DECODER_MEMORY_MIB = 192;

export class HybridEvidenceDecoderProcessError extends Error {
  constructor(readonly code: "evidence_bounds_exceeded" | "hostile_document") {
    super(code);
    this.name = "HybridEvidenceDecoderProcessError";
  }
}

function boundedAppend(chunks: Buffer[], chunk: Buffer, maximumBytes: number): boolean {
  const size = chunks.reduce((total, value) => total + value.byteLength, 0) + chunk.byteLength;
  if (size > maximumBytes) return false;
  chunks.push(chunk);
  return true;
}

/**
 * Executes hostile document decoding outside the application process. Node's
 * permission boundary denies network, child-process, worker, and filesystem
 * writes; the only granted capabilities are reading the deployed package and
 * loading the reviewed native canvas addon. The parent owns all IPC bounds and
 * sends SIGKILL on the wall deadline, so synchronous/native decoder work cannot
 * continue after the caller has timed out.
 */
export async function runHybridEvidenceDecoderProcess<T>(input: {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly timeoutMs: number;
}): Promise<T> {
  const child = spawn(process.execPath, [
    "--permission",
    "--allow-addons",
    `--allow-fs-read=${process.cwd()}`,
    `--max-old-space-size=${DECODER_MEMORY_MIB}`,
    "--input-type=module",
    "--eval",
    input.source,
  ], {
    cwd: process.cwd(),
    env: {
      LANG: "C",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "",
      TZ: "UTC",
    } as NodeJS.ProcessEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let exceeded = false;
  let timedOut = false;
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, input.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    if (!boundedAppend(stdout, chunk, MAX_DECODER_STDOUT_BYTES)) {
      exceeded = true;
      kill();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (!boundedAppend(stderr, chunk, MAX_DECODER_STDERR_BYTES)) {
      exceeded = true;
      kill();
    }
  });
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify(input.payload));
  try {
    const { code } = await completion;
    if (timedOut || exceeded) {
      throw new HybridEvidenceDecoderProcessError("evidence_bounds_exceeded");
    }
    const output = Buffer.concat(stdout).toString("utf8");
    if (code !== 0) {
      const failure = Buffer.concat(stderr).toString("utf8");
      if (/evidence_bounds_exceeded/u.test(failure)) {
        throw new HybridEvidenceDecoderProcessError("evidence_bounds_exceeded");
      }
      throw new HybridEvidenceDecoderProcessError("hostile_document");
    }
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new HybridEvidenceDecoderProcessError("hostile_document");
    }
  } finally {
    clearTimeout(timer);
    kill();
  }
}

export const HYBRID_EVIDENCE_DECODER_PROCESS_LIMITS = Object.freeze({
  maximumOutputBytes: MAX_DECODER_STDOUT_BYTES,
  memoryMiB: DECODER_MEMORY_MIB,
});
