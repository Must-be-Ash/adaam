import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runbook = await readFile(
  new URL("../docs/workspace-schedule-test.md", import.meta.url),
  "utf8",
);
for (const required of [
  "verify-workspace-monitor-schedule.ts",
  "verify-workspace-runtime-redis.ts",
  "local-redis-rest-proxy.mjs",
  "/eve/v1/dev/schedules/event-triggers",
  "/eve/v1/internal/event-trigger-runner",
  "does not run cron automatically",
  "returns\n404 deliberately",
  "Never substitute production Redis",
]) assert.ok(runbook.includes(required), `Missing schedule runbook contract: ${required}`);

const channel = await readFile(
  new URL("../agent/channels/event-trigger-runner.ts", import.meta.url),
  "utf8",
);
assert.match(channel, /POST\("\/eve\/v1\/internal\/event-trigger-runner"[\s\S]*status: 404/u);
const schedule = await readFile(
  new URL("../agent/schedules/event-triggers.ts", import.meta.url),
  "utf8",
);
assert.match(schedule, /cron: "\* \* \* \* \*"/u);
assert.match(schedule, /claimDueWorkspaceMonitors/u);

console.info("Workspace local schedule runbook verification passed.");
