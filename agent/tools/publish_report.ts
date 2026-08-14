import { defineTool } from "eve/tools";

import { publishReportInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishStructuredReport,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish a durable public research report at a shareable Eve URL. Use this for a compound report or dossier with prose plus requested metrics, tables, charts, and source records. Put every explicitly requested or skill-required element in requirements so the one-shot final guard can reject an incomplete report. Use structured blocks and plain prose fields, never pasted HTML or a full Markdown document. Do not use this tool when the primary deliverable is only a chart, image, PDF, audio, video, or downloadable file.",
  inputSchema: publishReportInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: publishStructuredReport,
  toModelOutput: artifactPublicationModelOutput,
});
