import { defineTool } from "eve/tools";

import { publishAudioInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishRemoteArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish an existing public audio file as a durable, playable audio artifact at a shareable Eve URL. Use a credential-free, query-free public HTTPS source URL. Do not wrap the audio URL in a report.",
  inputSchema: publishAudioInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: (input, ctx) => publishRemoteArtifact("audio", input, ctx),
  toModelOutput: artifactPublicationModelOutput,
});
