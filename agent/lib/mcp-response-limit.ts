export class McpResponseTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`MCP response exceeded ${maximumBytes} bytes.`);
    this.name = "McpResponseTooLargeError";
  }
}

export function createBoundedFetch(
  maximumBytes: number,
  fetchImplementation: typeof fetch = globalThis.fetch,
  onLimitExceeded?: (error: McpResponseTooLargeError) => void,
): typeof fetch {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("The MCP response limit must be a positive integer.");
  }

  return async (input, init) => {
    const response = await fetchImplementation(input, init);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      const error = new McpResponseTooLargeError(maximumBytes);
      onLimitExceeded?.(error);
      throw error;
    }
    if (!response.body) return response;

    let receivedBytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > maximumBytes) {
            const error = new McpResponseTooLargeError(maximumBytes);
            onLimitExceeded?.(error);
            controller.error(error);
            return;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}
