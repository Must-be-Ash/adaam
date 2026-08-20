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

function sourceEvidence(alert: WorkspaceAlert): string {
  return (alert.sourceLinks ?? alert.sourceRefs.map((sourceId) => ({ sourceId })))
    .map((source) => "canonicalUrl" in source
      ? `${singleLine(source.sourceId, 160)}: ${source.canonicalUrl}`
      : singleLine(source.sourceId, 160))
    .join(", ");
}

function artifactEvidenceLines(alert: WorkspaceAlert): string[] {
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
    ...(exactReferences.length
      ? [`Exact finding/evidence references: ${exactReferences.join(", ")}`]
      : []),
  ];
}

export function renderWorkspaceAlertPresentation(
  alert: WorkspaceAlert,
): WorkspaceAlertPresentation {
  const workspaceName = singleLine(alert.workspaceName, 80);
  const heading = `Workspace alert · ${workspaceName}`;
  const title = singleLine(alert.title, 240);
  const whyMatched = singleLine(alert.whyMatched, 1_000);
  const sources = sourceEvidence(alert);
  const artifactRefs = artifactEvidenceLines(alert);
  const eventTime = alert.eventTime
    ? `Observed: ${singleLine(alert.eventTime, 100)}`
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
