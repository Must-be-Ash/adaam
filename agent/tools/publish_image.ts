import { defineTool } from "eve/tools";

import { publishImageInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishRemoteArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish an existing public image as a durable, directly viewable image artifact at a shareable Eve URL. Use this after an image-generation or image-retrieval tool returns a credential-free, query-free public HTTPS image URL. Do not wrap an image URL in a report or cite it as a report source.",
  inputSchema: publishImageInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: (input, ctx) => publishRemoteArtifact("image", input, ctx),
  toModelOutput: artifactPublicationModelOutput,
});
