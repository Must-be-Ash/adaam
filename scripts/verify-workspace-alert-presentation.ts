import assert from "node:assert/strict";

import { renderWorkspaceAlertPresentation } from "../agent/lib/workspace-alert-presentation";
import type { WorkspaceAlert } from "../agent/lib/workspace-alert-store";

const alert = {
  alertId: `alert_${"a".repeat(64)}`,
  createdAt: "2026-08-14T17:00:00.000Z",
  findingId: `finding_${"b".repeat(64)}`,
  ownerId: "owner_fixture",
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceRefs: ["sec-latest-s1-filings"],
  state: "ready",
  title: "New SEC S-1 registration",
  whyMatched: "Fixture Corp filed a newly observed registration statement.",
  workspaceId: "123e4567-e89b-42d3-a456-426614174000",
  workspaceName: "IPO Filings",
} satisfies WorkspaceAlert;

const presentation = renderWorkspaceAlertPresentation(alert);
assert.equal(presentation.heading, "Workspace alert · IPO Filings");
assert.match(presentation.fallbackText, /^Workspace alert · IPO Filings/u);
assert.match(presentation.fallbackText, /Sources: sec-latest-s1-filings/u);
assert.deepEqual(presentation.actions, [
  { action: "discuss", label: "Discuss in workspace" },
  { action: "manage", label: "Manage sessions" },
]);
assert.equal(JSON.stringify(presentation).includes(alert.ownerId), false);
assert.equal(JSON.stringify(presentation).includes(alert.workspaceId), false);

const sanitized = renderWorkspaceAlertPresentation({
  ...alert,
  workspaceName: "IPO\nFilings",
  whyMatched: "Line one\nLine two",
});
assert.equal(sanitized.heading, "Workspace alert · IPO Filings");
assert.ok(Buffer.byteLength(sanitized.fallbackText, "utf8") <= 4_000);

console.info("Workspace alert presentation verification passed.");
