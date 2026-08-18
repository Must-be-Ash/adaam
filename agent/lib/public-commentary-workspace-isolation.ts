import { z } from "zod";

import { digestPublicCommentaryValue } from "./public-commentary-schema";

const identifierSchema = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u);

export const publicCommentaryWorkspaceProjectionSchema = z.object({
  budgetScopeId: identifierSchema,
  chatContextId: identifierSchema,
  configurationGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  envelopeId: identifierSchema,
  factRevisionId: identifierSchema,
  findingStoreScopeId: identifierSchema,
  modelJobId: identifierSchema,
  rawContentIncluded: z.literal(false),
  recordType: z.literal("public_commentary_workspace_projection"),
  schemaVersion: z.literal(1),
  sourceEventId: identifierSchema,
  sourceInstanceId: identifierSchema,
  workspaceId: z.string().uuid(),
}).strict();

export function projectPublicCommentarySourceEvent(input: {
  readonly configurationGeneration: number;
  readonly envelopeId: string;
  readonly factRevisionId: string;
  readonly sourceEventId: string;
  readonly sourceInstanceId: string;
  readonly workspaceId: string;
}) {
  const scopeDigest = digestPublicCommentaryValue([
    input.workspaceId,
    input.configurationGeneration,
    input.factRevisionId,
  ]);
  return publicCommentaryWorkspaceProjectionSchema.parse({
    budgetScopeId: `commentary-budget.${scopeDigest}`,
    chatContextId: `commentary-chat.${scopeDigest}`,
    configurationGeneration: input.configurationGeneration,
    envelopeId: input.envelopeId,
    factRevisionId: input.factRevisionId,
    findingStoreScopeId: `commentary-findings.${scopeDigest}`,
    modelJobId: `commentary-model-job.${scopeDigest}`,
    rawContentIncluded: false,
    recordType: "public_commentary_workspace_projection",
    schemaVersion: 1,
    sourceEventId: input.sourceEventId,
    sourceInstanceId: input.sourceInstanceId,
    workspaceId: input.workspaceId,
  });
}
