import { defineTool } from "eve/tools";

import { publishChartInputSchema } from "#artifact-schema";
import {
  artifactPublicationApproval,
  artifactPublicationModelOutput,
  artifactPublicationOutputSchema,
  publishChartArtifact,
} from "../lib/artifact-publication";

export default defineTool({
  description:
    "Publish a chart-first public artifact at a shareable Eve URL. Use this when the requested primary deliverable is a graph, candlestick chart, volume chart, allocation chart, or order-book depth chart. The charts field must contain the real numeric points, bars, slices, OHLC candles, or bid/ask levels gathered for the request; prose, labels, a source URL, or a table cannot substitute for chart data. If the data is unavailable, do not fabricate it and do not call this tool. Use publish_report instead only when the user asked for a compound report containing charts and other sections.",
  inputSchema: publishChartInputSchema,
  outputSchema: artifactPublicationOutputSchema,
  approval: artifactPublicationApproval,
  execute: publishChartArtifact,
  toModelOutput: artifactPublicationModelOutput,
});
