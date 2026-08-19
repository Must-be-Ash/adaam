import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { workspaceHtml } from "../agent/channels/photon-workspace-app.ts";

const projectRequire = createRequire(import.meta.url);
let playwright;
try {
  playwright = projectRequire("playwright");
} catch {
  const runtimeRequire = createRequire(
    resolve(dirname(process.execPath), "..", "package.json"),
  );
  playwright = runtimeRequire("playwright");
}

const { chromium } = playwright;
const managerToken = "A".repeat(43);
const managerHtml = workspaceHtml("browser-nonce", "http://manager.test");
const managerScript = managerHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/u)?.[1];
assert.ok(managerScript, "manager HTML includes its inline application script");
assert.doesNotThrow(
  () => new Function(managerScript),
  "generated manager JavaScript must remain syntactically valid",
);
const mainId = "123e4567-e89b-42d3-a456-426614174000";
const demoId = "223e4567-e89b-42d3-a456-426614174000";
const workspace = (id, name, status = "active") => ({
  budget: null,
  budgetUsage: null,
  generation: 1,
  id,
  monitors: [],
  name,
  status,
  strategyPack: { reasonCode: null, state: "unbound" },
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { height: 900, width: 390 } });
  await page.addInitScript(() => {
    if (!crypto.randomUUID) {
      crypto.randomUUID = () => "323e4567-e89b-42d3-a456-426614174000";
    }
  });
  const waitForStatus = (message) =>
    page.waitForFunction(
      (expected) => document.querySelector("#status")?.textContent === expected,
      message,
    );
  let actionMode = "success";
  let authoritativeState = {
    activeWorkspaceId: mainId,
    packMutationIdentity: null,
    revision: 1,
    strategyPackCatalog: [],
    workspaces: [workspace(mainId, "Main")],
  };
  let lastAction = null;

  await page.route("http://manager.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() === "document") {
      await route.fulfill({
        body: managerHtml,
        contentType: "text/html",
      });
      return;
    }
    if (url.pathname.endsWith("/state")) {
      await route.fulfill({
        body: JSON.stringify(authoritativeState),
        contentType: "application/json",
      });
      return;
    }
    if (url.pathname.endsWith("/action")) {
      lastAction = request.postDataJSON();
      if (actionMode === "bad-request") {
        await route.fulfill({
          body: JSON.stringify({ error: "Choose a different session name." }),
          contentType: "application/json",
          status: 400,
        });
        return;
      }
      if (actionMode === "conflict") {
        authoritativeState = {
          activeWorkspaceId: mainId,
          packMutationIdentity: null,
          revision: authoritativeState.revision + 1,
          strategyPackCatalog: [],
          workspaces: [
            workspace(mainId, "Main refreshed"),
            workspace(demoId, "demo"),
          ],
        };
        await route.fulfill({
          body: JSON.stringify({
            error: "The session state changed. Refresh and try again.",
          }),
          contentType: "application/json",
          status: 409,
        });
        return;
      }
      authoritativeState = {
        activeWorkspaceId: demoId,
        packMutationIdentity: null,
        revision: authoritativeState.revision + 1,
        strategyPackCatalog: [],
        workspaces: [workspace(mainId, "Main"), workspace(demoId, "demo")],
      };
      await route.fulfill({
        body: JSON.stringify(authoritativeState),
        contentType: "application/json",
      });
      return;
    }
    await route.fulfill({ body: "{}", contentType: "application/json" });
  });

  await page.goto(`http://manager.test/#${managerToken}`);
  await waitForStatus("Active session: Main");

  const nameInput = page.getByLabel("New session");
  await nameInput.fill("demo");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await waitForStatus("Active session: demo");
  assert.equal(lastAction.action, "create");
  assert.equal(lastAction.name, "demo");
  assert.equal(await nameInput.inputValue(), "", "successful creation clears the field");

  actionMode = "bad-request";
  await nameInput.fill("demo");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await waitForStatus("Choose a different session name.");
  assert.equal(await nameInput.inputValue(), "demo", "HTTP 400 preserves the submitted name");
  assert.equal(await nameInput.evaluate((input) => document.activeElement === input), true);
  assert.match(await page.locator("#status").getAttribute("class"), /error/u);

  actionMode = "conflict";
  await nameInput.fill("demo");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.locator(".name", { hasText: "Main refreshed" }).waitFor();
  await waitForStatus("The session state changed. Refresh and try again.");
  assert.equal(await nameInput.inputValue(), "demo", "HTTP 409 preserves the submitted name");
  assert.equal(await nameInput.evaluate((input) => document.activeElement === input), true);
  assert.match(await page.locator("#status").getAttribute("class"), /error/u);

  console.info("Photon session create browser verification passed.");
} finally {
  await browser.close();
}
