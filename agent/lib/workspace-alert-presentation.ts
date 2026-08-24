import { z } from "zod";

import { artifactIdFromReference } from "./artifact-reference";
import type { WorkspaceAlert } from "./workspace-alert-store";
import { artifactPageUrl } from "./public-app-url";

const actionSchema = z.object({
  action: z.enum(["discuss", "manage"]),
  label: z.enum(["Discuss in workspace", "Manage sessions"]),
}).strict();
const presentationSchema = z.object({
  actions: z.array(actionSchema).length(2),
  fallbackText: z.string().min(1).max(4_000),
  heading: z.string().min(1).max(120),
  schemaVersion: z.literal(1),
}).strict();

export type WorkspaceAlertPresentation = z.infer<typeof presentationSchema>;

function singleLine(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/*
 * `audience: "owner"` drops the internal source identifier and shows only the
 * link a person can open. A line like
 * "x-public-commentary-user.3316376038.KobeissiLetter: https://api.x.com/2/users/.../tweets"
 * tells the owner nothing and points at an API endpoint they cannot read; the
 * identifier stays in the durable alert record and in the agent-facing turn
 * context, which is where provenance actually belongs.
 */
/* A raw ISO timestamp is machine provenance; the owner gets a readable one. */
function readableInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return singleLine(value, 100);
  return `${parsed.toLocaleString("en-US", {
    day: "numeric", hour: "numeric", minute: "2-digit",
    month: "short", timeZone: "UTC", year: "numeric",
  })} UTC`;
}

function sourceEvidence(alert: WorkspaceAlert, audience: "agent" | "owner" = "agent"): string {
  const sources = alert.sourceLinks ?? alert.sourceRefs.map((sourceId) => ({ sourceId }));
  const lines = sources.map((source) => {
    if (!("canonicalUrl" in source)) return singleLine(source.sourceId, 160);
    const role = "role" in source ? source.role : undefined;
    const prefix = role
      ? `${role === "supplementary" ? "Supplementary context" : "Official source"} · `
      : "";
    if (audience === "owner") return `${prefix}${source.canonicalUrl}`;
    return `${prefix}${singleLine(source.sourceId, 160)}: ${source.canonicalUrl}`;
  });
  const retained: string[] = [];
  let length = 0;
  for (const line of lines) {
    const added = line.length + (retained.length === 0 ? 0 : 2);
    if (length + added > 1_600) break;
    retained.push(line);
    length += added;
  }
  const omitted = lines.length - retained.length;
  return [
    ...retained,
    ...(omitted > 0 ? [`${omitted} additional source${omitted === 1 ? "" : "s"} in the readable report`] : []),
  ].join(", ");
}

function artifactEvidenceLines(alert: WorkspaceAlert, audience: "agent" | "owner" = "agent"): string[] {
  const readableReports: string[] = [];
  const exactReferences: string[] = [];
  for (const reference of alert.artifactRefs ?? []) {
    const artifactId = artifactIdFromReference(reference);
    if (artifactId) {
      try {
        readableReports.push(`Readable report: ${artifactPageUrl(artifactId)}`);
        continue;
      } catch {
        // Preserve the exact durable reference when a public application URL
        // is not configured in a non-production presentation environment.
      }
    }
    exactReferences.push(singleLine(reference, 160));
  }
  return [
    ...readableReports,
    ...(audience === "agent" && exactReferences.length
      ? [`Exact finding/evidence references: ${exactReferences.join(", ")}`]
      : []),
  ];
}

/*
 * The owner's card shows a readable report when one exists. Falling back to a
 * list of 64-character digests told them nothing they could act on - the
 * references remain on the durable alert record and in the turn context.
 */

export function renderWorkspaceAlertPresentation(
  alert: WorkspaceAlert,
): WorkspaceAlertPresentation {
  const workspaceName = singleLine(alert.workspaceName, 80);
  const heading = `Workspace alert · ${workspaceName}`;
  const title = singleLine(alert.title, 240);
  const whyMatched = singleLine(alert.whyMatched, 1_000);
  const sources = sourceEvidence(alert, "owner");
  const artifactRefs = artifactEvidenceLines(alert, "owner");
  const eventTime = alert.eventTime
    ? `Observed ${readableInstant(alert.eventTime)}`
    : null;
  return presentationSchema.parse({
    actions: [
      { action: "discuss", label: "Discuss in workspace" },
      { action: "manage", label: "Manage sessions" },
    ],
    fallbackText: [
      heading,
      title,
      whyMatched,
      ...(eventTime ? [eventTime] : []),
      ...artifactRefs,
      `Sources: ${sources}`,
      "Open the alert card to Discuss in workspace or Manage sessions.",
    ].join("\n\n"),
    heading,
    schemaVersion: 1,
  });
}

export function workspaceAlertTurnContext(alert: WorkspaceAlert): string {
  const title = singleLine(alert.title, 240);
  const whyMatched = singleLine(alert.whyMatched, 1_000);
  const sources = sourceEvidence(alert);
  const artifactRefs = artifactEvidenceLines(alert);
  return [
    "The owner explicitly chose to discuss this durable alert in the current workspace.",
    `Alert reference: ${alert.alertId}`,
    `Title: ${title}`,
    `Why it matched: ${whyMatched}`,
    ...(alert.eventTime ? [`Observed: ${singleLine(alert.eventTime, 100)}`] : []),
    `Source references: ${sources}`,
    ...artifactRefs,
    "Treat this as bounded context for the current turn only. Do not infer or load another workspace's history.",
  ].join("\n");
}
