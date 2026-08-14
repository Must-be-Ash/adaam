import { defineTool } from "eve/tools";

import { publishPdfInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishRemoteArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish an existing public PDF as a durable, directly openable PDF artifact at a shareable Eve URL. Use a credential-free, query-free public HTTPS PDF source URL. This tool does not convert a structured report into a PDF and must not be replaced with a report that merely cites the PDF.",
  inputSchema: publishPdfInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: (input, ctx) => publishRemoteArtifact("pdf", input, ctx),
  toModelOutput: artifactPublicationModelOutput,
});
