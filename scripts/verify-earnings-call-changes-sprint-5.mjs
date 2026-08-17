import { spawnSync } from "node:child_process";

const gates = [
  "verify:earnings-call-changes:sprint-0",
  "verify:earnings-call-changes:sprint-1",
  "verify:earnings-call-changes:sprint-2",
  "verify:earnings-call-changes:sprint-3",
  "verify:earnings-call-changes:sprint-4",
  "verify:earnings-call-changes:source-lifecycle",
  "verify:earnings-call-changes:worker-recovery-corrections",
  "verify:earnings-call-changes:production-wiring",
  "verify:strategy-packs",
  "verify:strategy-pack-mutations",
  "verify:strategy-pack-runtime",
  "verify:strategy-pack-configuration-kinds",
  "verify:strategy-pack-owner-surfaces",
  "verify:strategy-pack-spectrum-browser",
  "verify:public-source-adapters:contracts",
  "verify:public-source-adapters:house",
  "verify:public-source-adapters:sec",
  "verify:public-source-adapters:runtime",
  "verify:hybrid-evidence:sprint-0",
  "verify:hybrid-evidence:sprint-1",
  "verify:hybrid-evidence:sprint-2",
  "verify:hybrid-evidence:sprint-3",
  "verify:workspace-runtime:worker-auth",
  "verify:workspace-runtime:worker-isolation",
  "verify:workspace-runtime:isolation",
  "verify:workspace-runtime:capabilities",
  "verify:workspace-runtime:drift",
  "verify:workspace-runtime:budget",
  "verify:workspace-runtime:dispatch-budget",
  "verify:workspace-runtime:findings",
  "verify:workspace-runtime:alerts",
  "verify:workspace-runtime:alert-presentation",
  "verify:workspace-runtime:alert-context",
  "verify:workspace-runtime:alert-replies",
  "verify:workspace-runtime:alert-delivery",
  "verify:workspace-runtime:alert-subscriptions",
  "verify:workspace-runtime:alert-app",
  "verify:workspace-runtime:monitors",
  "verify:workspace-runtime:recovery-schedule",
  "verify:workspace-runtime:worker-tools",
  "verify:workspace-runtime:manager",
  "verify:interactive-tool-capabilities",
  "verify:approvals",
  "typecheck",
  "build:agent",
  "build",
];

for (const gate of gates) {
  const result = spawnSync("npm", ["run", gate], {
    env: process.env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Earnings Call Changes Sprint 5 regression passed (${gates.length} gates).`);
