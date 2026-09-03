type Fetch = typeof globalThis.fetch;

function allowedOrigins(serializedOrigins: string | undefined): Set<string> {
  return new Set(
    (serializedOrigins ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/** Prevent provider requests from automatically forwarding request data across redirects. */
export function guardAgentcashProviderFetch(
  nativeFetch: Fetch,
  serializedOrigins: string | undefined,
): Fetch {
  const providers = allowedOrigins(serializedOrigins);
  return async (input, init) => {
    let origin: string | undefined;
    try {
      origin = new URL(
        typeof input === "string" || input instanceof URL
          ? input
          : input.url,
      ).origin;
    } catch {
      return nativeFetch(input, init);
    }
    if (!providers.has(origin)) return nativeFetch(input, init);

    if (input instanceof Request) {
      const request = new Request(input, { ...init, redirect: "manual" });
      return nativeFetch(request);
    }
    return nativeFetch(input, { ...init, redirect: "manual" });
  };
}
