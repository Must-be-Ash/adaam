import { defineTool } from "eve/tools";
import { z } from "zod";

import { requireAgentcashToolAccess } from "../lib/agentcash-access";
import { inspectAgentcashEndpointSchema } from "../lib/agentcash-endpoint-schema";
import { safeAgentcashReadInput } from "../lib/agentcash-policy";

const inputSchema = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  method: z
    .enum(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"])
    .optional(),
  url: z.url(),
});

export default defineTool({
  description:
    "Inspect one HTTPS endpoint's published OpenAPI schema, authentication mode, and payment requirements before using it. This performs only safe schema-document reads and never probes the endpoint or makes a payment.",
  inputSchema,
  async execute(input, ctx) {
    await requireAgentcashToolAccess(ctx);
    const safeInput = safeAgentcashReadInput("check_endpoint_schema", input);
    return inspectAgentcashEndpointSchema({
      ...(typeof safeInput.method === "string"
        ? { method: safeInput.method as typeof input.method }
        : {}),
      ...(safeInput.headers && typeof safeInput.headers === "object"
        ? { headers: safeInput.headers as Record<string, string> }
        : {}),
      signal: ctx.abortSignal,
      url: String(safeInput.url),
    });
  },
});
