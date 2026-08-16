import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { workspaceHtml } from "../agent/channels/photon-workspace-app.ts";

const projectRequire = createRequire(import.meta.url);
let playwright;
try {
  playwright = projectRequire("playwright");
} catch {
  const runtimeRequire = createRequire(resolve(dirname(process.execPath), "..", "package.json"));
  playwright = runtimeRequire("playwright");
}
const { chromium } = playwright;
const managerToken = "A".repeat(43);
const identity = {
  actionId: "browser-action",
  expectedRegistryRevision: 4,
  issuedAt: "2026-08-15T17:00:00.000Z",
  nonce: "browser_nonce_123456789",
  routingScopeDigest: "a".repeat(64),
  signature: "b".repeat(64),
  sourceWorkspaceGeneration: 1,
  sourceWorkspaceId: "123e4567-e89b-42d3-a456-426614174000",
  transport: "spectrum",
};
const pack = {
  availability: "available",
  capabilities: { hardDenied: ["shell"], required: ["tool.alpha.fetch"] },
  configuration: [
    { default: "UTC", description: "Owner timezone", key: "timezone", kind: "iana_timezone", label: "Timezone", required: true },
    { default: ["09:00"], description: "Daily cadence", key: "dailyTimes", kind: "daily_local_times", label: "Daily times", required: true },
  ],
  contentDigest: "c".repeat(64),
  description: "Detect reviewed public events.",
  displayName: "Alpha Pack",
  evaluations: { suiteId: "eval.alpha/v1" },
  id: "alpha-pack",
  instructionsIncluded: false,
  maturity: "reference",
  monitors: [{ activationDefault: "paused", displayName: "Detect alpha", resourceId: "detect-alpha", sourceIds: ["source.alpha"] }],
  sources: [{ accessClassification: "public", allowedOrigins: ["https://alpha.example.gov"], canonicalUrl: "https://alpha.example.gov/events", contractDigest: "d".repeat(64), contractVersion: "1.0.0", sourceId: "source.alpha" }],
  version: "1.0.0",
};
const monitor = {
  configurationRevision: 1,
  lastCompletedAt: null,
  lastErrorCode: null,
  lastRunAt: null,
  lifecycleState: "enabled",
  monitorId: "223e4567-e89b-42d3-a456-426614174000",
  name: "Detect alpha",
  nextOccurrenceAt: "2026-08-16T16:00:00.000Z",
  schedule: { kind: "daily_local", times: ["09:00"], timezone: "UTC" },
  sources: [{ canonicalUrl: "https://alpha.example.gov/events", sourceId: "source.alpha" }],
};
const activeBinding = {
  bindingRevision: 1,
  capabilities: [{ id: "tool.alpha.fetch", status: "available" }],
  configuration: { dailyTimes: ["09:00"], timezone: "UTC" },
  health: { checkedAt: "2026-08-15T17:00:00.000Z", status: "healthy" },
  managedMonitors: [{ ...monitor, resourceId: "detect-alpha", sourceIds: ["source.alpha"] }],
  pack,
  reasonCode: null,
  sources: [{ canonicalUrl: "https://alpha.example.gov/events", sourceId: "source.alpha", status: "available" }],
  state: "active",
};
const stateFor = (strategyPack = activeBinding, overrides = {}) => ({
  activeWorkspaceId: identity.sourceWorkspaceId,
  packMutationIdentity: identity,
  revision: identity.expectedRegistryRevision,
  strategyPackCatalog: [pack],
  workspaces: [{
    budget: null,
    budgetUsage: null,
    generation: identity.sourceWorkspaceGeneration,
    id: identity.sourceWorkspaceId,
    monitors: strategyPack.state === "unbound" ? [] : [monitor],
    name: "Alpha Research",
    status: "active",
    strategyPack,
  }],
  ...overrides,
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { height: 900, width: 390 } });
  let authoritativeState = stateFor();
  let stateFailure = false;
  let actionMode = "success";
  let lastAction = null;
  let actionRelease = null;
  await page.route("http://manager.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().resourceType() === "document") {
      await route.fulfill({ contentType: "text/html", body: workspaceHtml("browser-nonce", "http://manager.test") });
      return;
    }
    const body = route.request().postDataJSON?.() ?? {};
    if (url.pathname.endsWith("/state")) {
      if (stateFailure) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "Catalog state unavailable." }), status: 503 });
      } else {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(authoritativeState) });
      }
      return;
    }
    if (url.pathname.endsWith("/pack-action")) {
      lastAction = body;
      if (actionRelease) await actionRelease;
      if (actionMode === "conflict") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "The session state changed. Refresh and try again." }), status: 409 });
        return;
      }
      if (actionMode === "failure") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ error: "Bounded mutation failure." }), status: 503 });
        return;
      }
      const outcome = body.action === "strategy-pack-remove" ? "removed" : "configured";
      const nextBinding = outcome === "removed"
        ? { reasonCode: null, state: "unbound" }
        : { ...activeBinding, bindingRevision: 2, configuration: body.configuration };
      authoritativeState = stateFor(nextBinding, {
        packMutation: { receipt: { bindingRevision: 2, mutationId: "e".repeat(64), outcome }, replayed: false },
        revision: authoritativeState.revision + 1,
        workspaces: [{
          ...authoritativeState.workspaces[0],
          generation: authoritativeState.workspaces[0].generation + 1,
          monitors: outcome === "removed" ? [] : [{ ...monitor, lifecycleState: "paused", nextOccurrenceAt: null }],
          strategyPack: nextBinding,
        }],
      });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(authoritativeState) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });

  await page.goto(`http://manager.test/#${managerToken}`);
  await page.getByText("Active session: Alpha Research").waitFor();
  assert.equal(await page.locator("#status").getAttribute("aria-live"), "polite");
  assert.equal(await page.getByRole("button", { name: "Configure" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Remove pack" }).count(), 1);
  const order = await page.locator(".runtime-row").evaluateAll((rows) => rows.map((row) => row.textContent));
  assert.ok(order[0].includes("Strategy pack"));
  assert.ok(order[1].includes("Detect alpha"));
  assert.ok(order.at(-1).includes("Pack summary"));
  const touchTargets = await page.locator("button").evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height));
  assert.ok(touchTargets.every((height) => height >= 44));
  await page.getByText("Pack summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("details.pack-details").getAttribute("open"), "");

  const dialogMessages = [];
  page.on("dialog", async (dialog) => {
    dialogMessages.push(dialog.message());
    if (dialog.type() === "prompt") {
      await dialog.accept(dialog.message().includes("time zone") ? "America/Vancouver" : "08:30, 16:00");
    } else {
      await dialog.accept();
    }
  });
  let releaseAction;
  actionRelease = new Promise((resolvePromise) => { releaseAction = resolvePromise; });
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByText(/Applying strategy-pack configuration/u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Rename" }).isDisabled(), true);
  releaseAction();
  await page.getByText(/Strategy-pack configured/u).waitFor();
  assert.equal(lastAction.action, "strategy-pack-configure");
  assert.equal(lastAction.confirmedConsequences, true);
  assert.deepEqual(lastAction.configuration.dailyTimes, ["08:30", "16:00"]);
  assert.ok(dialogMessages.some((message) => message.includes("future messages will start a fresh conversation generation")));
  assert.ok(dialogMessages.some((message) => message.includes("durable research will remain")));

  actionRelease = null;
  actionMode = "conflict";
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByText("Active session: Alpha Research").waitFor();
  assert.equal(await page.locator("#status").getAttribute("class"), "");

  actionMode = "failure";
  await page.getByRole("button", { name: "Configure" }).click();
  await page.getByText("Bounded mutation failure.").waitFor();
  assert.match(await page.locator("#status").getAttribute("class"), /error/u);

  actionMode = "success";
  authoritativeState = stateFor({
    ...activeBinding,
    health: { checkedAt: "2026-08-15T17:00:00.000Z", status: "unavailable" },
    reasonCode: "strategy_pack_exact_version_unavailable",
    state: "unavailable",
  });
  await page.reload();
  await page.getByText(/Unavailable · strategy_pack_exact_version_unavailable/u).waitFor();
  assert.equal(await page.getByRole("button", { name: "Configure" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Remove pack" }).count(), 1);
  dialogMessages.length = 0;
  await page.getByRole("button", { name: "Remove pack" }).click();
  await page.getByText(/Strategy-pack removed/u).waitFor();
  assert.equal(lastAction.action, "strategy-pack-remove");
  assert.ok(dialogMessages.some((message) => message.includes("findings, alerts, checkpoints, and audit history will remain")));
  assert.equal(await page.getByText("None installed").count(), 1);

  authoritativeState = stateFor({ reasonCode: null, state: "unbound" }, { strategyPackCatalog: [] });
  await page.reload();
  await page.getByText("No reviewed strategy packs are currently available.").waitFor();
  stateFailure = true;
  await page.reload();
  await page.getByText("Catalog state unavailable.").waitFor();
  assert.match(await page.locator("#status").getAttribute("class"), /error/u);

  console.info("Strategy-pack Spectrum browser verification passed.");
} finally {
  await browser.close();
}
