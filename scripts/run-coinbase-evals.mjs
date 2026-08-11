import { spawn } from "node:child_process";

if (process.env.VERCEL_ENV || process.env.VERCEL_URL) {
  console.error(
    "Coinbase evals are local-only and cannot run with Vercel deployment markers.",
  );
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [
    "node_modules/eve/bin/eve.js",
    "eval",
    "coinbase",
    "--strict",
    "--max-concurrency",
    "1",
  ],
  {
    env: {
      ...process.env,
      COINBASE_EVAL_FIXTURE: "1",
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error("Unable to start Coinbase evals.", error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Coinbase evals stopped by signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
