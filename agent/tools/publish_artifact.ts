import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  artifactIdForCall,
  publishRemoteMediaArtifact,
  publishReportArtifact,
  publishTextFileArtifact,
} from "../lib/artifact-store";
import {
  artifactKindSchema,
  publishArtifactInputSchema,
} from "../lib/artifact-schema";

const PUBLICATION_DENIAL_REASON =
  "Only an authenticated user session can publish a public artifact.";

const outputSchema = z.object({
  artifactId: z.string(),
  artifactMarker: z.string(),
  kind: artifactKindSchema,
  publicUrl: z.string().url(),
  status: z.literal("published"),
});

export default defineTool({
  description:
    "Publish a durable, shareable public artifact at an Eve URL. Infer this tool when a user asks for an openable or shareable report/link; they do not need to name the tool, say public, or choose a host. Use kind=report with structured blocks and plain prose fields—never paste a Markdown document into one text block. Image, audio, video, and PDF artifacts ingest a credential-free public HTTPS source URL. File artifacts ingest either a public HTTPS source or small plain-text/CSV/JSON content. Never publish portfolio, account, personal, credential-bearing, or other private data. After success, keep the chat concise and copy artifactMarker as the final standalone line.",
  inputSchema: publishArtifactInputSchema,
  outputSchema,
  approval: ({ session }) =>
    session.auth.current?.principalType === "user"
      ? "not-applicable"
      : { reason: PUBLICATION_DENIAL_REASON, type: "denied" },
  async execute(input, ctx) {
    if (ctx.session.auth.current?.principalType !== "user") {
      throw new Error(PUBLICATION_DENIAL_REASON);
    }

    const artifactId = artifactIdForCall(ctx.callId);
    let published;
    if (input.kind === "report") {
      published = await publishReportArtifact({
        artifactId,
        report: input.report,
        signal: ctx.abortSignal,
      });
    } else if (input.kind === "file" && input.text) {
      if (input.sourceUrl) {
        throw new Error(
          "A file artifact requires exactly one sourceUrl or text value.",
        );
      }
      published = await publishTextFileArtifact({
        artifactId,
        contentType: input.contentType,
        description: input.description ?? input.title,
        fileName: input.fileName,
        signal: ctx.abortSignal,
        text: input.text,
        title: input.title,
      });
    } else {
      const sourceUrl = input.sourceUrl;
      if (!sourceUrl) {
        throw new Error(
          "A file artifact requires exactly one sourceUrl or text value.",
        );
      }
      published = await publishRemoteMediaArtifact({
        artifactId,
        contentType: input.contentType,
        description: input.description ?? input.title,
        fileName: input.fileName,
        kind: input.kind,
        signal: ctx.abortSignal,
        sourceUrl,
        title: input.title,
      });
    }
    const artifactMarker = `ARTIFACT_URL: ${published.publicUrl}`;

    return {
      artifactId: published.artifactId,
      artifactMarker,
      kind: published.kind,
      publicUrl: published.publicUrl,
      status: "published" as const,
    };
  },
  toModelOutput(output) {
    return {
      type: "json",
      value: {
        artifactMarker: output.artifactMarker,
        kind: output.kind,
        status: output.status,
      },
    };
  },
});
