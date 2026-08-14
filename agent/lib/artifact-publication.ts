import type {
  ApprovalContext,
  ApprovalStatus,
  ToolContext,
  ToolModelOutput,
} from "eve/tools";
import { z } from "zod";

import {
  artifactIdForCall,
  publishChartArtifact as publishStoredChartArtifact,
  publishRemoteMediaArtifact,
  publishReportArtifact,
  publishTextFileArtifact,
} from "./artifact-store";
import {
  artifactKindSchema,
  type ArtifactKind,
  type PublishChartInput,
  type PublishFileInput,
  type PublishRemoteMediaInput,
  type PublishReportInput,
  type ResearchReport,
} from "#artifact-schema";
import {
  runArtifactFinalValidation,
  validateChartBlocks,
  validateReportForPublication,
} from "./artifact-validation";

const PUBLICATION_DENIAL_REASON =
  "Only an authenticated user session can publish a public artifact.";

const publishedArtifactOutputSchema = z.object({
  artifactId: z.string(),
  artifactMarker: z.string(),
  kind: artifactKindSchema,
  publicUrl: z.string().url(),
  status: z.literal("published"),
});

const rejectedArtifactOutputSchema = z.object({
  missingRequirements: z.array(z.string().min(1).max(180)).min(1).max(20),
  reason: z.string().min(1).max(1_000),
  retryAllowed: z.literal(false),
  status: z.literal("not_published"),
});

export const artifactPublicationOutputSchema = z.discriminatedUnion("status", [
  publishedArtifactOutputSchema,
  rejectedArtifactOutputSchema,
]);

export type ArtifactPublicationOutput = z.infer<
  typeof artifactPublicationOutputSchema
>;

type RemoteArtifactKind = Exclude<
  ArtifactKind,
  "report" | "chart" | "file"
>;

export function artifactPublicationApproval(
  ctx: ApprovalContext<unknown>,
): ApprovalStatus {
  return ctx.session.auth.current?.principalType === "user"
    ? "not-applicable"
    : { reason: PUBLICATION_DENIAL_REASON, type: "denied" };
}

function assertAuthenticatedUser(ctx: ToolContext): void {
  if (ctx.session.auth.current?.principalType !== "user") {
    throw new Error(PUBLICATION_DENIAL_REASON);
  }
}

function publishedOutput(published: {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly publicUrl: string;
}): ArtifactPublicationOutput {
  return {
    artifactId: published.artifactId,
    artifactMarker: `ARTIFACT_URL: ${published.publicUrl}`,
    kind: published.kind,
    publicUrl: published.publicUrl,
    status: "published",
  };
}

export function artifactPublicationModelOutput(
  output: ArtifactPublicationOutput,
): ToolModelOutput {
  if (output.status === "not_published") {
    return {
      type: "json",
      value: {
        missingRequirements: output.missingRequirements,
        reason: output.reason,
        retryAllowed: output.retryAllowed,
        status: output.status,
      },
    };
  }

  return {
    type: "json",
    value: {
      artifactMarker: output.artifactMarker,
      kind: output.kind,
      status: output.status,
    },
  };
}

export async function publishStructuredReport(
  input: PublishReportInput,
  ctx: ToolContext,
): Promise<ArtifactPublicationOutput> {
  assertAuthenticatedUser(ctx);
  const rejection = runArtifactFinalValidation(
    ctx,
    validateReportForPublication(input.report, input.requirements),
  );
  if (rejection) return rejection;

  return publishedOutput(
    await publishReportArtifact({
      artifactId: artifactIdForCall(ctx.callId),
      report: input.report,
      signal: ctx.abortSignal,
    }),
  );
}

export async function publishChartArtifact(
  input: PublishChartInput,
  ctx: ToolContext,
): Promise<ArtifactPublicationOutput> {
  assertAuthenticatedUser(ctx);
  const rejection = runArtifactFinalValidation(
    ctx,
    validateChartBlocks(input.charts),
  );
  if (rejection) return rejection;

  const {
    charts,
    publicDataOnly: _publicDataOnly,
    ...reportMetadata
  } = input;
  const report: ResearchReport = {
    ...reportMetadata,
    blocks: charts,
  };

  return publishedOutput(
    await publishStoredChartArtifact({
      artifactId: artifactIdForCall(ctx.callId),
      report,
      signal: ctx.abortSignal,
    }),
  );
}

export async function publishRemoteArtifact(
  kind: RemoteArtifactKind,
  input: PublishRemoteMediaInput,
  ctx: ToolContext,
): Promise<ArtifactPublicationOutput> {
  assertAuthenticatedUser(ctx);
  const rejection = runArtifactFinalValidation(ctx, []);
  if (rejection) return rejection;

  return publishedOutput(
    await publishRemoteMediaArtifact({
      artifactId: artifactIdForCall(ctx.callId),
      contentType: input.contentType,
      description: input.description ?? input.title,
      fileName: input.fileName,
      kind,
      signal: ctx.abortSignal,
      sourceUrl: input.sourceUrl,
      title: input.title,
    }),
  );
}

export async function publishFileArtifact(
  input: PublishFileInput,
  ctx: ToolContext,
): Promise<ArtifactPublicationOutput> {
  assertAuthenticatedUser(ctx);
  const rejection = runArtifactFinalValidation(ctx, []);
  if (rejection) return rejection;

  const artifactId = artifactIdForCall(ctx.callId);
  if (input.text !== undefined) {
    return publishedOutput(
      await publishTextFileArtifact({
        artifactId,
        contentType: input.contentType,
        description: input.description ?? input.title,
        fileName: input.fileName,
        signal: ctx.abortSignal,
        text: input.text,
        title: input.title,
      }),
    );
  }

  return publishedOutput(
    await publishRemoteMediaArtifact({
      artifactId,
      contentType: input.contentType,
      description: input.description ?? input.title,
      fileName: input.fileName,
      kind: "file",
      signal: ctx.abortSignal,
      sourceUrl: input.sourceUrl!,
      title: input.title,
    }),
  );
}
