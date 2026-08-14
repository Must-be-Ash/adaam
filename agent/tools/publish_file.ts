import { defineTool } from "eve/tools";

import { publishFileInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishFileArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish a durable downloadable public file at a shareable Eve URL. Use this for public CSV, JSON, plain text, or another downloadable file that is not better represented by publish_image, publish_audio, publish_video, or publish_pdf. Provide exactly one credential-free, query-free public HTTPS source URL or one small text value.",
  inputSchema: publishFileInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: publishFileArtifact,
  toModelOutput: artifactPublicationModelOutput,
});
