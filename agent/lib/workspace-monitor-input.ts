import { z } from "zod";

export const WORKSPACE_MONITOR_SOURCE_LIMIT = 8;
export const WORKSPACE_MONITOR_SOURCE_LIMIT_CODE = "monitor_source_limit_exceeded";

const idSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_./:@-]{1,159}$/u);

export const workspaceMonitorSourceSchema = z.object({
  accessClassification: z.enum(["public", "owner_private"]),
  canonicalUrl: z.string().url().max(2_048),
  origin: z.string().url().max(500),
  sourceId: idSchema,
}).strict().superRefine((source, context) => {
  const canonical = new URL(source.canonicalUrl);
  if (
    canonical.protocol !== "https:" ||
    canonical.username !== "" ||
    canonical.password !== "" ||
    canonical.hash !== "" ||
    canonical.toString() !== source.canonicalUrl ||
    canonical.origin !== source.origin ||
    new URL(source.origin).origin !== source.origin
  ) {
    context.addIssue({ code: "custom", message: "monitor_source_invalid" });
  }
});

export const workspaceMonitorSourcesSchema = z
  .array(workspaceMonitorSourceSchema)
  .min(1)
  .max(WORKSPACE_MONITOR_SOURCE_LIMIT, {
    message: WORKSPACE_MONITOR_SOURCE_LIMIT_CODE,
  })
  .superRefine((sources, context) => {
    const ids = sources.map((source) => source.sourceId);
    const urls = sources.map((source) => source.canonicalUrl);
    if (new Set(ids).size !== ids.length || new Set(urls).size !== urls.length) {
      context.addIssue({ code: "custom", message: "monitor_source_duplicate" });
    }
  });

// All mutation surfaces intentionally share one schema object.
export const workspaceMonitorCreateSourcesSchema = workspaceMonitorSourcesSchema;
export const workspaceMonitorUpdateSourcesSchema = workspaceMonitorSourcesSchema;
export const workspaceMonitorManagerSourcesSchema = workspaceMonitorSourcesSchema;

export type WorkspaceMonitorSourceInput = z.infer<typeof workspaceMonitorSourceSchema>;
