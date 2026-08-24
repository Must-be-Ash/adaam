import assert from "node:assert/strict";

import {
  renderWorkspaceAlertPresentation,
  workspaceAlertTurnContext,
} from "../agent/lib/workspace-alert-presentation";
import type { WorkspaceAlert } from "../agent/lib/workspace-alert-store";

const alert = {
  alertId: `alert_${"a".repeat(64)}`,
  createdAt: "2026-08-14T17:00:00.000Z",
  eventTime: "2026-08-14T16:58:00.000Z",
  findingId: `finding_${"b".repeat(64)}`,
  ownerId: "owner_fixture",
  recordType: "workspace_alert",
  schemaVersion: 1,
  sourceLinks: [{
    canonicalUrl: "https://www.sec.gov/Archives/fixture.htm",
    sourceId: "sec-latest-s1-filings",
  }],
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
/*
 * The owner's card carries the link, not the internal source identifier - a
 * line like "x-public-commentary-user.3316376038.KobeissiLetter: https://api.x.com/..."
 * named an endpoint they cannot read. The identifier stays in the turn context.
 */
assert.equal(
  presentation.fallbackText.includes("sec-latest-s1-filings"),
  false,
  "the owner card must not carry the internal source identifier",
);
// A raw ISO timestamp is machine provenance; the owner card carries a
// readable instant. The exact value stays on the alert record.
assert.match(presentation.fallbackText, /Observed Aug 14, 2026, 4:58 PM UTC/u);
assert.match(presentation.fallbackText, /https:\/\/www\.sec\.gov\/Archives\/fixture\.htm/u);
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

const turnContext = workspaceAlertTurnContext(alert);
assert.match(turnContext, new RegExp(alert.alertId, "u"));
assert.match(turnContext, /New SEC S-1 registration/u);
/*
 * Provenance the owner card no longer shows must still reach the agent: the
 * internal source identifier and the exact ISO instant belong here, where a
 * Discuss turn can use them.
 */
assert.match(turnContext, /sec-latest-s1-filings/u);
assert.match(turnContext, /Observed: 2026-08-14T16:58:00.000Z/u);
assert.equal(turnContext.includes(alert.ownerId), false);
assert.equal(turnContext.includes(alert.workspaceId), false);

console.info("Workspace alert presentation verification passed.");
