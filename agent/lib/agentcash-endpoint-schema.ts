import {
  getL3ForOpenAPI,
  getOpenAPI,
  isOpenApiParseFailure,
  type HttpMethod,
} from "@agentcash/discovery";

import { safeAgentcashReadInput } from "./agentcash-policy";

const INSPECTABLE_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
] as const satisfies readonly HttpMethod[];
const MAX_OPENAPI_BYTES = 1_048_576;
const MAX_OPENAPI_DEPTH = 32;
const MAX_OPENAPI_NODES = 50_000;
const MAX_SCHEMA_RESULT_BYTES = 120_000;

interface EndpointSchemaInput {
  headers?: Record<string, string>;
  method?: (typeof INSPECTABLE_METHODS)[number];
  signal?: AbortSignal;
  url: string;
}

function assertBoundedOpenApi(value: unknown): void {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_OPENAPI_NODES || current.depth > MAX_OPENAPI_DEPTH) {
      throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
}

async function boundedOpenApiDocument(
  origin: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(`${origin}/openapi.json`, {
      headers: { Accept: "application/json", ...headers },
      method: "GET",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/u.test(contentType)) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENAPI_BYTES) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_OPENAPI_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
    }
    chunks.push(value);
  }
  const serialized = Buffer.concat(chunks, bytes).toString("utf8");
  let document: unknown;
  try {
    document = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  assertBoundedOpenApi(document);
  return document;
}

export async function inspectAgentcashEndpointSchema(
  input: EndpointSchemaInput,
) {
  safeAgentcashReadInput("check_endpoint_schema", {
    ...(input.headers ? { headers: input.headers } : {}),
    url: input.url,
  });
  const endpoint = new URL(input.url);
  const document = await boundedOpenApiDocument(
    endpoint.origin,
    input.headers,
    input.signal,
  );
  if (!document) return { results: [], url: input.url };
  const encodedDocument = Buffer.from(JSON.stringify(document)).toString(
    "base64",
  );
  const openApiResult = await getOpenAPI(
    endpoint.origin,
    undefined,
    input.signal,
    `data:application/json;base64,${encodedDocument}`,
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
  const result = { results, url: input.url };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_SCHEMA_RESULT_BYTES
  ) {
    throw new Error("The endpoint's OpenAPI schema could not be loaded safely.");
  }
  return result;
}
