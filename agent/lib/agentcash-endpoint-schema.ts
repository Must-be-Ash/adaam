import {
  getL3ForOpenAPI,
  getOpenAPI,
  isOpenApiParseFailure,
  type HttpMethod,
} from "@agentcash/discovery";

const INSPECTABLE_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
] as const satisfies readonly HttpMethod[];

interface EndpointSchemaInput {
  headers?: Record<string, string>;
  method?: (typeof INSPECTABLE_METHODS)[number];
  signal?: AbortSignal;
  url: string;
}

export async function inspectAgentcashEndpointSchema(
  input: EndpointSchemaInput,
) {
  const endpoint = new URL(input.url);
  const openApiResult = await getOpenAPI(
    endpoint.origin,
    input.headers,
    input.signal,
  );
  if (openApiResult.isErr()) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded.");
  }
  const openApi = openApiResult.value;
  if (!openApi || isOpenApiParseFailure(openApi)) {
    return { results: [], url: input.url };
  }

  const methods = input.method ? [input.method] : INSPECTABLE_METHODS;
  const results = methods.flatMap((method) => {
    const advisory = getL3ForOpenAPI(openApi, endpoint.pathname, method);
    if (!advisory) return [];
    return [
      {
        ...advisory,
        method,
        requiresPayment:
          advisory.authMode === "paid" ||
          advisory.authMode === "apiKey+paid",
      },
    ];
  });
  return { results, url: input.url };
}
