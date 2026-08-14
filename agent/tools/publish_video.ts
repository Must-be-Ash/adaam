import { defineTool } from "eve/tools";

import { publishVideoInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishRemoteArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish an existing public video as a durable, playable video artifact at a shareable Eve URL. Use a credential-free, query-free public HTTPS source URL. Do not wrap the video URL in a report.",
  inputSchema: publishVideoInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: (input, ctx) => publishRemoteArtifact("video", input, ctx),
  toModelOutput: artifactPublicationModelOutput,
});
