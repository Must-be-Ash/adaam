import { z } from "zod";

const httpsUrlSchema = z
  .url()
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" && !parsed.username && !parsed.password
    );
  }, {
    message: "AgentCash endpoints must use HTTPS and cannot contain credentials.",
  });

const safeHeadersSchema = z
  .record(z.string(), z.string())
  .default({})
  .superRefine((headers, ctx) => {
    const credentialHeader = Object.keys(headers).find((name) =>
      /^(?:api-key|authentication|authorization|cookie|proxy-authorization|set-cookie|x-access-token|x-amz-security-token|x-api-key|x-auth-token)$/iu.test(
        name,
      ),
    );
    if (credentialHeader) {
      ctx.addIssue({
        code: "custom",
        message:
          "AgentCash requests cannot include credential headers; AgentCash provides wallet authentication and payment itself.",
      });
    }
  });

export const agentcashFetchSchema = z.object({
  body: z
    .union([z.string().max(250_000), z.record(z.string(), z.unknown())])
    .optional(),
  headers: safeHeadersSchema.optional(),
  maxAmount: z.number().positive().max(100),
  method: z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]).default("GET"),
  paymentNetwork: z.enum(["base", "solana", "tempo"]).optional(),
  paymentProtocol: z.enum(["mpp", "x402"]).optional(),
  timeout: z.number().int().positive().max(120_000).default(30_000),
  url: httpsUrlSchema,
});

export const agentcashFreeFetchSchema = agentcashFetchSchema.pick({
  headers: true,
  paymentNetwork: true,
  timeout: true,
  url: true,
});

const endpointInspectionSchema = z.object({
  results: z
    .array(
      z.object({
        authMode: z.string(),
        method: z.string(),
        requiresPayment: z.boolean(),
      }),
    )
    .min(1),
  url: httpsUrlSchema,
});

export const agentcashNoPaymentCeilingUsd = Number.MIN_VALUE;

export function enforceAgentcashFetch(
  input: z.infer<typeof agentcashFetchSchema>,
  deploymentMaximumUsd: number,
) {
  if (input.maxAmount > deploymentMaximumUsd) {
    throw new Error(
      `The requested AgentCash ceiling exceeds the $${deploymentMaximumUsd.toFixed(2)} deployment limit.`,
    );
  }
  return input;
}

export function assertAgentcashFreeSiwxEndpoint(
  inspection: unknown,
  expectedUrl: string,
): void {
  const parsed = endpointInspectionSchema.safeParse(inspection);
  const isExactFreeGet =
    parsed.success &&
    parsed.data.url === expectedUrl &&
    parsed.data.results.every(
      (result) =>
        result.method === "GET" &&
        result.authMode.toLowerCase() === "siwx" &&
        !result.requiresPayment,
    );
  if (!isExactFreeGet) {
    throw new Error(
      "AgentCash GET request is not confirmed as a free SIWX endpoint. Use agentcash_fetch with native payment approval instead.",
    );
  }
}

export function safeAgentcashReadInput(
  toolName: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if ("url" in input) httpsUrlSchema.parse(input.url);
  if ("headers" in input && input.headers !== undefined) {
    safeHeadersSchema.parse(input.headers);
  }
  if (
    toolName === "search" &&
    typeof input.limit === "number" &&
    (input.limit < 1 || input.limit > 20)
  ) {
    throw new Error("AgentCash search limits must be between 1 and 20.");
  }
  return input;
}
