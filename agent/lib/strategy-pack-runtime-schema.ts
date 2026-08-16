import { z } from "zod";

const revisionSchema = z.number().int().positive();
const packIdSchema = z.string().min(2).max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const resourceIdSchema = z.string().min(2).max(80)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const semverSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);

export const strategyPackWorkerSnapshotSchema = z.object({
  bindingRevision: revisionSchema,
  capabilityManifestRevision: revisionSchema,
  packContentDigest: digestSchema,
  packId: packIdSchema,
  packVersion: semverSchema,
  resourceId: resourceIdSchema,
  workspaceGeneration: revisionSchema,
}).strict();

export type StrategyPackWorkerSnapshot = Readonly<
  z.infer<typeof strategyPackWorkerSnapshotSchema>
>;
