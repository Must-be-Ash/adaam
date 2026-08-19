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
const mainId = "123e4567-e89b-42d3-a456-426614174000";
const researchId = "223e4567-e89b-42d3-a456-426614174000";
const archivedId = "323e4567-e89b-42d3-a456-426614174000";
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
      crypto.randomUUID = () => "423e4567-e89b-42d3-a456-426614174000";
    }
  });
  page.on("dialog", async (dialog) => dialog.accept());
  let state = {
    activeWorkspaceId: mainId,
    packMutationIdentity: null,
    revision: 1,
    strategyPackCatalog: [],
    workspaces: [
      workspace(mainId, "Main"),
      workspace(researchId, "Research"),
      workspace(archivedId, "Archived notes", "archived"),
    ],
  };

  await page.route("http://manager.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.resourceType() === "document") {
      await route.fulfill({ body: managerHtml, contentType: "text/html" });
      return;
    }
    if (url.pathname.endsWith("/state")) {
      await route.fulfill({ body: JSON.stringify(state), contentType: "application/json" });
      return;
    }
    if (url.pathname.endsWith("/action")) {
      const action = request.postDataJSON();
      state = {
        ...state,
        revision: state.revision + 1,
        workspaces: state.workspaces.map((candidate) =>
          candidate.id === action.workspaceId
            ? { ...candidate, status: action.action === "archive" ? "archived" : "active" }
            : candidate,
        ),
      };
      await route.fulfill({ body: JSON.stringify(state), contentType: "application/json" });
      return;
    }
    await route.fulfill({ body: "{}", contentType: "application/json" });
  });

  await page.goto(`http://manager.test/#${managerToken}`);
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Active session: Main",
  );

  const showArchived = page.getByRole("checkbox", { name: "Show archived" });
  assert.equal(await showArchived.isChecked(), false, "archived sessions are hidden by default");
  await page.getByText("Main", { exact: true }).waitFor();
  await page.getByText("Research", { exact: true }).waitFor();
  assert.equal(await page.getByText("Archived notes", { exact: true }).count(), 0);

  await showArchived.check();
  const archivedCard = page.locator("article.workspace", { hasText: "Archived notes" });
  await archivedCard.waitFor();
  await archivedCard.getByRole("button", { name: "Restore session" }).waitFor();

  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "Active session: Main",
  );
  assert.equal(await showArchived.isChecked(), false, "manager reload resets archived visibility");
  assert.equal(await page.getByText("Archived notes", { exact: true }).count(), 0);

  const archiveResponse = page.waitForResponse((response) =>
    response.url().endsWith("/action"),
  );
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await archiveResponse;
  await page.getByText("Research", { exact: true }).waitFor({ state: "detached" });

  await showArchived.check();
  const researchCard = page.locator("article.workspace", { hasText: "Research" });
  const restoreResponse = page.waitForResponse((response) =>
    response.url().endsWith("/action"),
  );
  await researchCard.getByRole("button", { name: "Restore session" }).click();
  await restoreResponse;
  await showArchived.uncheck();
  await page.getByText("Research", { exact: true }).waitFor();

  console.info("Photon archived-session manager browser verification passed.");
} finally {
  await browser.close();
}
