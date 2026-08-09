import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  listPublicFeeds,
  PUBLIC_FEED_CATEGORIES,
} from "../lib/public-feeds";

export default defineTool({
  description:
    "List curated official public feeds, APIs, URL templates, and issuer-IR discovery guidance for event research and monitoring. Call this before creating an event trigger unless the user supplied exact official source URLs.",
  inputSchema: z.object({
    category: z.enum(PUBLIC_FEED_CATEGORIES).optional(),
    query: z.string().trim().min(1).max(120).optional(),
    includeTemplates: z.boolean().default(true),
  }),
  execute(input) {
    return {
      sources: listPublicFeeds(input).map((source) => ({
        ...source,
        monitorableById: source.url !== undefined,
      })),
      guidance:
        "Fixed feeds can be passed to create_event_trigger by id. URL templates and issuer IR sources must first be resolved to an exact official HTTPS URL and then passed in sourceUrls.",
    };
  },
});
